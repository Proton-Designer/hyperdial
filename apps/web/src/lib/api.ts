import { supabase } from './supabase';
import { normalizePhoneStrict } from './phone-normalize';
import { timezoneForAreaCode } from './area-code-tz';

const getFunctionsUrl = () => {
  const url = import.meta.env.VITE_SUPABASE_URL;
  if (!url) return '';
  return `${url}/functions/v1`;
};

export function isParallelDialerEnabled(): boolean {
  const env = (import.meta as ImportMeta & { env?: Record<string, string> }).env;
  return env?.VITE_PARALLEL_DIALER_ENABLED !== 'false';
}

/**
 * The signed-in user's current org (TASK-P1-01/P1-02). There is no org-switcher UI
 * yet (Stage 1 is one org per user in practice), so this always resolves to
 * `profiles.active_org_id`. Not cached: org membership can change from another tab
 * (an invite accepted, a role changed), and this is one cheap indexed read.
 */
async function getActiveOrgId(): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { data, error } = await supabase
    .from('profiles')
    .select('active_org_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.active_org_id) throw new Error('No active org selected');
  return data.active_org_id as string;
}

/** Headers for calling Supabase Edge Functions from the browser (includes apikey so gateway accepts the request). */
async function getEdgeFunctionHeaders(): Promise<HeadersInit> {
  const anonKey = (import.meta as ImportMeta & { env?: Record<string, string> }).env
    ?.VITE_SUPABASE_ANON_KEY;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(anonKey ? { apikey: anonKey } : {}),
  };
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (session?.access_token) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }
  try {
    headers['X-Org-Id'] = await getActiveOrgId();
  } catch {
    // No org context yet (e.g. mid-signup, before the trigger/backfill has run for
    // this session) -- let the function's own requireOrgRole fall back to
    // profiles.active_org_id server-side, or reject with its own error.
  }
  return headers;
}

export async function listPhoneNumbers() {
  const res = await fetch(`${getFunctionsUrl()}/telnyx-list-numbers`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to list numbers');
  return data.numbers as {
    id: string;
    telnyx_phone_number_id: string;
    phone_number: string;
    created_at: string;
    /** TASK-N1 -- see PhoneNumbersContext's own UserPhoneNumber type for field docs. */
    assigned_user_id: string | null;
    status: 'active' | 'resting' | 'retired';
    resting_until: string | null;
    daily_cap: number;
    dials_today: number;
  }[];
}

// --- TASK-N1: caller-ID number pool (CID-1, CID-2, ADM-5) ---

export interface NumberPoolSettings {
  default_daily_cap: number;
  rest_days: number;
}

/** Same "member read, owner/admin write, direct client upsert against RLS" shape as
 *  getRecordingEnabled/setRecordingEnabled below -- no Edge Function needed. */
export async function getNumberPoolSettings(): Promise<NumberPoolSettings> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_number_pool_settings')
    .select('default_daily_cap, rest_days')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as NumberPoolSettings | null) ?? { default_daily_cap: 100, rest_days: 2 };
}

export async function updateNumberPoolSettings(settings: NumberPoolSettings): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.from('org_number_pool_settings').upsert({
    org_id: orgId,
    default_daily_cap: settings.default_daily_cap,
    rest_days: settings.rest_days,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** ADM-5: owner/admin only -- `user_phone_numbers`' own RLS (owner/admin write) is what actually
 *  enforces this; an agent's own call fails with an RLS error, not a client-side check. Pass
 *  `null` to return a number to the team pool. */
export async function assignPhoneNumber(numberId: string, userId: string | null): Promise<void> {
  const { error } = await supabase
    .from('user_phone_numbers')
    .update({ assigned_user_id: userId })
    .eq('id', numberId);
  if (error) throw new Error(error.message);
}

/** ADM-5/CID-2: owner/admin only, same RLS-enforced shape as assignPhoneNumber. */
export async function setPhoneNumberStatus(
  numberId: string,
  status: 'active' | 'retired'
): Promise<void> {
  // Clears resting_until too -- a manual "make active"/"retire" always overrides whatever the
  // pool-picker's own lazy reactivation was tracking; 'resting' itself is set only by
  // private.pick_and_reserve_dial_number (the migration), never directly from the UI.
  const { error } = await supabase
    .from('user_phone_numbers')
    .update({ status, resting_until: null })
    .eq('id', numberId);
  if (error) throw new Error(error.message);
}

// --- TASK-I1: inbound callback routing (INB-1..4, CID-6) ---

export interface InboundSettings {
  shared_destination_number: string | null;
  voicemail_greeting_text: string;
}

/** TASK-I1 review fix (eng1 review-eng1.md finding #6): resolves the caller's contact record for
 *  IncomingCallBanner. Deliberately wider than contacts' own RLS -- see
 *  `20260925070102_lookup_contact_by_phone.sql`'s own comment for why a plain
 *  `.from('contacts')` query would silently under-match for an agent. */
export interface CallerContactMatch {
  id: string;
  business_name: string | null;
  first_name: string | null;
  last_name: string | null;
  phone_number: string;
}

export async function lookupContactByPhone(phoneE164: string): Promise<CallerContactMatch | null> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('lookup_contact_by_phone', {
    p_org_id: orgId,
    p_phone_e164: phoneE164,
  });
  if (error) throw new Error(error.message);
  const row = (data as CallerContactMatch[] | null)?.[0];
  return row ?? null;
}

/** Same "member read, owner/admin write, direct client upsert against RLS" shape as
 *  getNumberPoolSettings/updateNumberPoolSettings -- no Edge Function needed. */
export async function getInboundSettings(): Promise<InboundSettings> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_inbound_settings')
    .select('shared_destination_number, voicemail_greeting_text')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (
    (data as InboundSettings | null) ?? {
      shared_destination_number: null,
      voicemail_greeting_text: "You've reached {org_name}. Please leave a message.",
    }
  );
}

export async function updateInboundSettings(settings: InboundSettings): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.from('org_inbound_settings').upsert({
    org_id: orgId,
    shared_destination_number: settings.shared_destination_number,
    voicemail_greeting_text: settings.voicemail_greeting_text,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** Each intern's own optional cell fallback (INB-3) -- self-service, not owner/admin gated
 *  (org_members' own new "member can update own heartbeat and forward number" RLS policy,
 *  20260925070100_inbound_routing.sql). Pass `null` to clear it. */
export async function getMyForwardNumber(): Promise<string | null> {
  const orgId = await getActiveOrgId();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { data, error } = await supabase
    .from('org_members')
    .select('forward_phone_number')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.forward_phone_number as string | null) ?? null;
}

export async function setMyForwardNumber(forwardPhoneNumber: string | null): Promise<void> {
  const orgId = await getActiveOrgId();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { error } = await supabase
    .from('org_members')
    .update({ forward_phone_number: forwardPhoneNumber })
    .eq('org_id', orgId)
    .eq('user_id', user.id);
  if (error) throw new Error(error.message);
}

/** INB-3's "was seen in the app in the last 2 min" online signal -- there is no server-visible
 *  WebRTC-registration status anywhere in this schema, so this cheap heartbeat is the only one.
 *  Fire-and-forget from the caller (Dialer.tsx, on an interval well under the 2-minute window);
 *  a failed heartbeat just means the next one (or none, if the tab closed) determines presence
 *  -- never worth surfacing as an error to the agent. */
export async function updateMyPresenceHeartbeat(): Promise<void> {
  const orgId = await getActiveOrgId();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return;
  await supabase
    .from('org_members')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('user_id', user.id);
}

// --- TASK-SP: monthly spend cap + low-balance alert (SEC-2 + the balance part of SEC-7) ---

export interface SpendSettings {
  /** Null = no cap, dialing/purchasing is never blocked on spend regardless of amount. */
  monthly_spend_cap_usd: number | null;
  low_balance_alert_usd: number;
  min_balance_to_dial_usd: number;
  /** Estimate-only knobs -- MTD spend has no cheap, reliable Telnyx API (see
   *  20260925080200_spend_cap_balance_alert.sql's own header), so it's computed from our own
   *  call minutes x this rate + number count x this price. Tune these for a closer estimate. */
  estimated_per_minute_rate_usd: number;
  estimated_monthly_number_price_usd: number;
}

/** Same "member read, owner/admin write, direct client upsert against RLS" shape as
 *  getNumberPoolSettings/updateNumberPoolSettings -- no Edge Function needed for the settings
 *  themselves (only the live balance/MTD READ needs one, see getSpendStatus below). */
export async function getSpendSettings(): Promise<SpendSettings> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_spend_settings')
    .select(
      'monthly_spend_cap_usd, low_balance_alert_usd, min_balance_to_dial_usd, estimated_per_minute_rate_usd, estimated_monthly_number_price_usd'
    )
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (
    (data as SpendSettings | null) ?? {
      monthly_spend_cap_usd: null,
      low_balance_alert_usd: 20,
      min_balance_to_dial_usd: 5,
      estimated_per_minute_rate_usd: 0.015,
      estimated_monthly_number_price_usd: 1.15,
    }
  );
}

export async function updateSpendSettings(settings: SpendSettings): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.from('org_spend_settings').upsert({
    org_id: orgId,
    ...settings,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

export type SpendStatus =
  | {
      available: true;
      balanceUsd: number;
      availableCreditUsd: number;
      mtdSpendEstimateUsd: number;
      isEstimate: true;
      monthlySpendCapUsd: number | null;
      lowBalanceAlertUsd: number;
      minBalanceToDialUsd: number;
    }
  | { available: false; reason: string };

/** Owner/admin only. Calls Telnyx live (the client can't read the org's key itself) -- see
 *  telnyx-spend-status/index.ts. `available: false` is a normal, displayable state (Telnyx not
 *  connected yet, or a transient API error), not a thrown error. */
export async function getSpendStatus(): Promise<SpendStatus> {
  const res = await fetch(`${getFunctionsUrl()}/telnyx-spend-status`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load spend status');
  return data as SpendStatus;
}

export async function searchPhoneNumbers(areaCode: string, countryCode = 'US') {
  const params = new URLSearchParams({ area_code: areaCode, country_code: countryCode });
  const res = await fetch(`${getFunctionsUrl()}/telnyx-search-numbers?${params}`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to search numbers');
  return data.numbers as { phone_number: string; monthly_cost?: string }[];
}

export async function purchasePhoneNumber(phoneNumber: string) {
  const res = await fetch(`${getFunctionsUrl()}/telnyx-purchase-number`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ phone_number: phoneNumber }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to purchase number');
  return data as { success: boolean; phone_number: string };
}

// --- Org Telnyx connection (TASK-P1-06) ---

export interface TelnyxConnectionStatus {
  status: 'disconnected' | 'pending_verification' | 'connected' | 'error';
  api_key_last4: string | null;
  verified_at: string | null;
}

/** Reads the safe `org_telephony_status` view -- the base table has no client policies at all. */
export async function getTelnyxConnectionStatus(): Promise<TelnyxConnectionStatus | null> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_telephony_status')
    .select('status, api_key_last4, verified_at')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as TelnyxConnectionStatus | null;
}

export async function connectTelnyx(
  apiKey: string,
  webhookPublicKey: string
): Promise<{ status: string; callControlApplicationId: string }> {
  const orgId = await getActiveOrgId();
  const res = await fetch(`${getFunctionsUrl()}/telnyx-connect`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ orgId, apiKey, webhookPublicKey }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to connect Telnyx');
  return data;
}

export async function disconnectTelnyx(): Promise<void> {
  const orgId = await getActiveOrgId();
  const res = await fetch(`${getFunctionsUrl()}/telnyx-disconnect`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ orgId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to disconnect Telnyx');
}

export interface DashboardStats {
  callsToday: number;
  connectRate: number;
  talkTimeFormatted: string;
  talkTimeSeconds: number;
  /** TASK-M1: a connected leg with duration_seconds >= 30 (.brain/domains/analytics.md). */
  conversationsToday: number;
  /** Rounded to 1 decimal; includes any still-running session, clipped to today so far. */
  dialingHoursToday: number;
  /** null (render "—") when dialingHoursToday < 0.1 -- avoids a nonsense spike on a trivial
   *  denominator right after Go Ready. */
  conversationsPerHour: number | null;
  /** TASK-F-P1: today's own legs whose disposition has is_win=true (personal, not org-wide). */
  winsToday: number;
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const res = await fetch(`${getFunctionsUrl()}/dashboard-stats`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load dashboard stats');
  return data as DashboardStats;
}

export interface TeamPerformancePoint {
  day: string;
  date: string;
  calls: number;
  connections: number;
}

export async function getTeamPerformanceChart(
  range: '7d' | '30d' | 'custom',
  customStart?: string,
  customEnd?: string
): Promise<TeamPerformancePoint[]> {
  const params = new URLSearchParams({ range });
  if (range === 'custom' && customStart) params.set('custom_start', customStart);
  if (range === 'custom' && customEnd) params.set('custom_end', customEnd);
  const res = await fetch(`${getFunctionsUrl()}/team-performance?${params}`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load team performance');
  return (data.data ?? []) as TeamPerformancePoint[];
}

// --- Analytics (TASK-P4-P1, design §8 Phase 4) ---

export interface AnalyticsTotals {
  totalCalls: number;
  totalCallsChangePct: number | null;
  connectRate: number;
  connectRateChangePct: number | null;
  talkTimeSeconds: number;
  talkTimeFormatted: string;
  talkTimeChangePct: number | null;
  /** Connected calls / total agent-hours dialed (CLAUDE.md's north-star metric). Null when there
   *  is no ended dial session in range to compute a denominator from yet. */
  conversationsPerAgentHour: number | null;
  conversationsPerAgentHourChangePct: number | null;
}

export interface AnalyticsCallVolumePoint {
  day: string;
  date: string;
  calls: number;
  connections: number;
  voicemails: number;
}

export interface AnalyticsDispositionSlice {
  name: string;
  value: number;
}

export interface AnalyticsAgentRow {
  agentId: string;
  name: string;
  calls: number;
  connections: number;
  rate: number;
}

export interface AnalyticsSummary {
  totals: AnalyticsTotals;
  callVolumeData: AnalyticsCallVolumePoint[];
  dispositionBreakdown: AnalyticsDispositionSlice[];
  /** Every agent in the org for owner/admin; a single self-row for an agent (design §2). */
  agentPerformance: AnalyticsAgentRow[];
}

export async function getAnalyticsSummary(
  range: '7d' | '30d' | 'custom',
  customStart?: string,
  customEnd?: string
): Promise<AnalyticsSummary> {
  const params = new URLSearchParams({ range });
  if (range === 'custom' && customStart) params.set('custom_start', customStart);
  if (range === 'custom' && customEnd) params.set('custom_end', customEnd);
  const res = await fetch(`${getFunctionsUrl()}/analytics-summary?${params}`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load analytics summary');
  return data as AnalyticsSummary;
}

// --- Team view (TASK-M2, ADM-6/ADM-7) ---
//
// Both RPCs are called directly (no edge function in between -- `supabase.rpc(...)`, same
// direct-client shape as `listContactDispositionHistory`/`contact_disposition_history`), and
// both are owner/admin-only, checked by the RPC itself via `auth.uid()` -- an agent caller gets
// back an empty array, not an error, and a p_org the caller doesn't manage never returns a row.
// See 20260925080100_team_view.sql's own header for why this repo's usual "edge function does
// the role check, a service-role client trusts it" pattern isn't used here.

export type TeamMemberRole = 'owner' | 'admin' | 'agent';

export interface TeamDailyStatsRow {
  agent_id: string;
  name: string;
  role: TeamMemberRole;
  dials: number;
  connects: number;
  connect_rate: number;
  conversations: number;
  /** Null when dialing_hours < 0.1 for this agent in range -- same floor as dashboard-stats'
   *  conversationsPerHour, avoids a nonsense spike right after Go Ready. */
  conversations_per_hr: number | null;
  wins: number;
  callbacks_set: number;
  talk_time_seconds: number;
  dialing_hours: number;
}

/** `start`/`end` are the caller's own resolved window (Team.tsx computes Today/Yesterday in
 *  America/Chicago, matching dialing_hours_today's boundary; 7d/Custom are plain UTC instants) --
 *  the RPC clips dialing hours to whatever window it's handed, it has no "today" special case. */
export async function getTeamDailyStats(start: Date, end: Date): Promise<TeamDailyStatsRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('team_daily_stats', {
    p_org: orgId,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as TeamDailyStatsRow[];
}

export type TeamLiveStatus = 'offline' | 'ready' | 'dialing' | 'on_call' | 'wrap_up' | 'paused';

export interface TeamLiveBoardRow {
  agent_id: string;
  name: string;
  role: TeamMemberRole;
  status: TeamLiveStatus;
  /** Only meaningful (and non-null) while status is 'dialing'. */
  lines: number | null;
  /** Only meaningful (and non-null) while status is 'on_call'. */
  contact_name: string | null;
  /** When the current session last changed state -- null while offline. */
  state_since: string | null;
  /** When the current session started -- null while offline. */
  session_started_at: string | null;
  calls_today: number;
  conversations_today: number;
}

/** Poll every 5s (ADM-7) -- a single RPC round trip per poll, not N queries. */
export async function getTeamLiveBoard(): Promise<TeamLiveBoardRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('team_live_board', { p_org: orgId });
  if (error) throw new Error(error.message);
  return (data ?? []) as TeamLiveBoardRow[];
}

export interface UserPreferences {
  team_performance_range?: '7d' | '30d' | 'custom';
  custom_start?: string;
  custom_end?: string;
}

export async function getUserPreferences(): Promise<UserPreferences | null> {
  const { data, error } = await supabase
    .from('user_preferences')
    .select('team_performance_range, custom_start, custom_end')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as UserPreferences | null;
}

export async function saveUserPreferences(userId: string, prefs: UserPreferences): Promise<void> {
  const { error } = await supabase.from('user_preferences').upsert(
    {
      user_id: userId,
      team_performance_range: prefs.team_performance_range ?? null,
      custom_start: prefs.custom_start ?? null,
      custom_end: prefs.custom_end ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) throw new Error(error.message);
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  created_at: string;
  read_at: string | null;
}

export async function listNotifications(): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, title, body, created_at, read_at')
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as AppNotification[];
}

export async function getUnreadNotificationCount(): Promise<number> {
  const { count, error } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .is('read_at', null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function markNotificationRead(id: string): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function markAllNotificationsRead(): Promise<void> {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .is('read_at', null);
  if (error) throw new Error(error.message);
}

// --- Org / team / invites (TASK-P1-03) ---

export interface OrgMember {
  user_id: string;
  role: 'owner' | 'admin' | 'agent';
  status: 'active' | 'disabled';
  created_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export async function listOrgMembers(): Promise<OrgMember[]> {
  const res = await fetch(`${getFunctionsUrl()}/org-members`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to list team members');
  return (data.members ?? []) as OrgMember[];
}

async function orgMembersAction(body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${getFunctionsUrl()}/org-members`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update member');
}

export const changeMemberRole = (userId: string, role: 'admin' | 'agent') =>
  orgMembersAction({ action: 'change_role', user_id: userId, role });
export const disableMember = (userId: string) =>
  orgMembersAction({ action: 'disable', user_id: userId });
export const enableMember = (userId: string) =>
  orgMembersAction({ action: 'enable', user_id: userId });
export const removeMember = (userId: string) =>
  orgMembersAction({ action: 'remove', user_id: userId });

export interface CreatedInvite {
  inviteId: string;
  token: string;
  expiresAt: string;
}

export async function createOrgInvite(
  email: string,
  role: 'admin' | 'agent'
): Promise<CreatedInvite> {
  const res = await fetch(`${getFunctionsUrl()}/org-invite-create`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ email, role }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to create invite');
  return data as CreatedInvite;
}

export interface InvitePreview {
  valid: boolean;
  email: string | null;
  role: 'owner' | 'admin' | 'agent' | null;
  orgName: string | null;
  reason: 'expired' | 'accepted' | null;
}

export async function previewOrgInvite(token: string): Promise<InvitePreview> {
  const res = await fetch(
    `${getFunctionsUrl()}/org-invite-accept?token=${encodeURIComponent(token)}`,
    { method: 'GET', headers: await getEdgeFunctionHeaders() }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to look up invite');
  return data as InvitePreview;
}

export async function acceptOrgInvite(token: string): Promise<{ orgId: string; role: string }> {
  const res = await fetch(`${getFunctionsUrl()}/org-invite-accept`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ token }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to accept invite');
  return data as { orgId: string; role: string };
}

export interface Profile {
  user_id: string;
  first_name: string | null;
  last_name: string | null;
  active_org_id: string | null;
}

export async function getMyProfile(): Promise<Profile | null> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { data, error } = await supabase
    .from('profiles')
    .select('user_id, first_name, last_name, active_org_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as Profile | null;
}

export async function updateMyProfile(input: {
  first_name: string;
  last_name: string;
}): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { error } = await supabase
    .from('profiles')
    .update({
      first_name: input.first_name.trim() || null,
      last_name: input.last_name.trim() || null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', user.id);
  if (error) throw new Error(error.message);
}

/** Campaign ids the signed-in agent is assigned to. Owner/admin have no assignment concept --
 * they see every org campaign, so this is only meaningful for role === 'agent'. */
export async function listMyCampaignAssignments(): Promise<string[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('campaign_agents')
    .select('campaign_id')
    .eq('user_id', user.id);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { campaign_id: string }[]).map((r) => r.campaign_id);
}

export async function ensureWeekSummary(): Promise<void> {
  const url = `${getFunctionsUrl()}/ensure-week-summary`;
  const res = await fetch(url, { method: 'POST', headers: await getEdgeFunctionHeaders() });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to ensure week summary');
  }
}

// --- Contacts (CSV import + single add) ---
export const CONTACT_CANONICAL_FIELDS = [
  'Business Name',
  'Business Link',
  'Business Type',
  'Rating',
  'Review Count',
  'Open Hours',
  'Phone Number',
  'Website',
  'Notes',
  'First Name',
  'Last Name',
  'Owner Contact',
  'Address',
] as const;

export interface Contact {
  id: string;
  user_id: string;
  org_id: string;
  business_name: string | null;
  business_link: string | null;
  business_type: string | null;
  rating: number | null;
  review_count: number | null;
  open_hours: string | null;
  phone_number: string | null;
  /** The phone number as originally typed/imported, before E.164 normalization (TASK-P2-P1). */
  phone_raw: string | null;
  website: string | null;
  notes: string | null;
  first_name: string | null;
  last_name: string | null;
  owner_contact: string | null;
  address: string | null;
  category: string | null;
  contact_status: string | null;
  /** IANA zone, e.g. "America/Chicago". Derived from the area code at import time, editable. */
  timezone: string | null;
  /** Org-wide do-not-call flag (design §2) -- the one field every role, including agent, may set. */
  dnc: boolean;
  /** LeadConnector contact id, set once a contact has been pulled from or linked to GHL
   *  (TASK-P3-P2). Null for a CSV-imported or manually-added contact never synced with GHL. */
  ghl_contact_id: string | null;
  /** Raw snapshot of the contact's GHL tags as of its last import (TASK-G7). Null until the
   *  contact has been imported from/linked to GHL at least once. */
  ghl_tags: string[] | null;
  created_at: string;
  updated_at: string;
}

export interface ParseCsvColumn {
  original_header: string;
  mapped_field: string | null;
  status: 'mapped' | 'incomplete';
  preview_data: string[];
}

export interface ParseCsvResponse {
  columns: ParseCsvColumn[];
  total_rows: number;
  preview_rows: Record<string, string>[];
  /** Rows whose mapped "Phone Number" column value fails strict E.164 validation (design §7). */
  invalid_phone_count: number;
}

export async function parseContactsCsv(csvText: string): Promise<ParseCsvResponse> {
  const res = await fetch(`${getFunctionsUrl()}/contacts-parse-csv`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ csv_text: csvText }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to parse CSV');
  return data as ParseCsvResponse;
}

export interface ImportContactsResult {
  imported: number;
  skipped: number;
  invalid: number;
  duplicates: number;
  /** Only meaningful when campaignId was passed -- contacts (new or already-existing) that were
   *  not queued onto it because they're DNC (TASK-L3). */
  skippedDnc: number;
  /** Same, for contacts already active in a different campaign (QUE-8: one active campaign per
   *  contact at a time). */
  skippedActiveCampaign: number;
}

export async function importContacts(
  csvText: string,
  columnMappings: { original_header: string; mapped_field: string | null }[],
  category: string = 'Cold',
  campaignId?: string
): Promise<ImportContactsResult> {
  const body: Record<string, unknown> = {
    csv_text: csvText,
    column_mappings: columnMappings,
    category,
  };
  if (campaignId) body.campaign_id = campaignId;
  const res = await fetch(`${getFunctionsUrl()}/contacts-import`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to import contacts');
  return data as ImportContactsResult;
}

export async function listContacts(): Promise<Contact[]> {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Contact[];
}

export interface CreateContactInput {
  business_name?: string;
  business_link?: string;
  business_type?: string;
  rating?: number;
  review_count?: number;
  open_hours?: string;
  phone_number?: string;
  website?: string;
  notes?: string;
  first_name?: string;
  last_name?: string;
  owner_contact?: string;
  address?: string;
  category?: string;
  contact_status?: string;
  timezone?: string;
}

/**
 * A phone_number present but not a valid E.164 number throws, same rejection contacts-import
 * applies to a CSV row (design §7). phone_raw preserves what was typed; timezone is derived
 * from the phone's NANP area code unless the caller already supplied one.
 */
function normalizeContactPhoneFields(
  phoneNumber: string | undefined,
  explicitTimezone: string | undefined
): { phone_number: string | null; phone_raw: string | null; timezone?: string } {
  const raw = (phoneNumber ?? '').trim();
  if (!raw) return { phone_number: null, phone_raw: null };
  const normalized = normalizePhoneStrict(raw);
  if (!normalized) throw new Error(`"${raw}" is not a valid phone number`);
  const result: { phone_number: string | null; phone_raw: string | null; timezone?: string } = {
    phone_number: normalized.e164,
    phone_raw: raw,
  };
  if (!explicitTimezone) {
    const tz = timezoneForAreaCode(normalized.areaCode);
    if (tz) result.timezone = tz;
  }
  return result;
}

export async function createContact(input: CreateContactInput): Promise<Contact> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const orgId = await getActiveOrgId();
  const phoneFields = normalizeContactPhoneFields(input.phone_number, input.timezone);
  const { data, error } = await supabase
    .from('contacts')
    .insert({
      user_id: user.id,
      org_id: orgId,
      business_name: input.business_name ?? null,
      business_link: input.business_link ?? null,
      business_type: input.business_type ?? null,
      rating: input.rating ?? null,
      review_count: input.review_count ?? null,
      open_hours: input.open_hours ?? null,
      ...phoneFields,
      website: input.website ?? null,
      notes: input.notes ?? null,
      first_name: input.first_name ?? null,
      last_name: input.last_name ?? null,
      owner_contact: input.owner_contact ?? null,
      address: input.address ?? null,
      category: input.category ?? 'Cold',
      contact_status: input.contact_status ?? 'No Contact',
      timezone: input.timezone ?? phoneFields.timezone ?? null,
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Contact;
}

/**
 * Real contact editing (design §7). A direct client `.update()`, same pattern as
 * createContact/deleteContact -- RLS plus the contacts_agent_update_scope trigger
 * (20260924001300) are the actual authority: an owner/admin may change any field here, an
 * assigned agent's request is rejected unless it touches only `dnc`. Passing `phone_number`
 * re-normalizes it exactly like createContact; pass `timezone` explicitly to override the
 * area-code-derived value instead of re-deriving it.
 */
export type UpdateContactInput = Partial<CreateContactInput> & { dnc?: boolean };

export async function updateContact(id: string, input: UpdateContactInput): Promise<Contact> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of [
    'business_name',
    'business_link',
    'business_type',
    'rating',
    'review_count',
    'open_hours',
    'website',
    'notes',
    'first_name',
    'last_name',
    'owner_contact',
    'address',
    'category',
    'contact_status',
    'timezone',
  ] as const) {
    if (key in input) patch[key] = input[key] ?? null;
  }
  if (typeof input.dnc === 'boolean') patch.dnc = input.dnc;
  if ('phone_number' in input) {
    const phoneFields = normalizeContactPhoneFields(input.phone_number, input.timezone);
    Object.assign(patch, phoneFields);
    if (phoneFields.timezone) patch.timezone = phoneFields.timezone;
  }
  const { data, error } = await supabase
    .from('contacts')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Contact;
}

export async function deleteContact(id: string): Promise<void> {
  // Deletion is owner/admin-only org-wide (design §2), not limited to contacts the
  // caller personally created -- RLS (`private.has_org_role`) is the actual
  // authority here, not a client-side user_id filter.
  const { error } = await supabase.from('contacts').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteContacts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await supabase.from('contacts').delete().in('id', ids);
  if (error) throw new Error(error.message);
}

// --- Campaigns ---
export interface Campaign {
  id: string;
  user_id: string;
  org_id: string;
  name: string;
  status: 'active' | 'paused' | 'completed';
  total_calls_made: number;
  connect_rate: number;
  last_called_at: string | null;
  /** Simultaneous outbound lines (design §7, TASK-P2-E1/P2-P2). */
  lines: number;
  amd_mode: 'off' | 'detect' | 'detect_words' | 'premium';
  /** TASK-F-T3 (VMD-4). Default 'first_attempt'. */
  voicemail_drop_mode: 'first_attempt' | 'every_attempt' | 'never';
  /** Must belong to this campaign's own org -- enforced by a DB trigger (20260924000700). */
  caller_id_number_id: string | null;
  max_attempts: number;
  retry_interval_minutes: number;
  /** "HH:MM:SS", contact-local (design §7). */
  calling_window_start: string;
  calling_window_end: string;
  abandon_message_enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface CampaignWithStats extends Campaign {
  total_contacts: number;
  queued: number;
  completed: number;
  passthrough: number;
}

export interface CampaignLead {
  id: string;
  campaign_id: string;
  contact_id: string;
  status: 'queued' | 'passthrough' | 'completed';
  added_at: string;
  contact: Contact;
}

export async function listCampaigns(): Promise<CampaignWithStats[]> {
  const { data, error } = await supabase
    .from('campaigns_with_stats')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  const campaigns = (data ?? []) as CampaignWithStats[];

  // Design §2: an agent only works assigned campaigns. campaigns' own RLS is org-wide (not
  // assignment-scoped -- every member can see every org campaign row, see TASK-P1-01's RLS
  // rewrite), so this is cosmetic UI narrowing, not the real access boundary: the leads/contacts
  // *inside* an unassigned campaign are already properly denied by contacts/campaign_leads RLS
  // regardless of what this function returns. See this task's log and mem.known-issues.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return campaigns;
  let orgId: string;
  try {
    orgId = await getActiveOrgId();
  } catch {
    return campaigns;
  }
  const { data: membership } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();
  if ((membership?.role as string | undefined) !== 'agent') return campaigns;

  const assignedIds = new Set(await listMyCampaignAssignments());
  return campaigns.filter((c) => assignedIds.has(c.id));
}

export async function createCampaign(name: string): Promise<Campaign> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('campaigns')
    .insert({
      user_id: user.id,
      org_id: orgId,
      name: name.trim(),
      status: 'active',
      updated_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Campaign;
}

export async function getCampaign(id: string): Promise<CampaignWithStats | null> {
  const { data, error } = await supabase
    .from('campaigns_with_stats')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as CampaignWithStats | null;
}

export async function updateCampaignStatus(
  id: string,
  status: 'active' | 'paused' | 'completed'
): Promise<void> {
  const { error } = await supabase
    .from('campaigns')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export interface CampaignSettingsInput {
  lines?: number;
  amd_mode?: 'off' | 'detect' | 'detect_words' | 'premium';
  /** TASK-F-T3 (VMD-4). */
  voicemail_drop_mode?: 'first_attempt' | 'every_attempt' | 'never';
  caller_id_number_id?: string | null;
  max_attempts?: number;
  retry_interval_minutes?: number;
  calling_window_start?: string;
  calling_window_end?: string;
  abandon_message_enabled?: boolean;
}

/**
 * Admin+ only -- RLS (`owner or admin can update campaigns`) is the actual authority, this is
 * just the client call. `caller_id_number_id` must belong to the campaign's own org or the DB
 * trigger `campaigns_check_caller_id_org` (20260924000700) rejects the update.
 */
export async function updateCampaignSettings(
  id: string,
  input: CampaignSettingsInput
): Promise<Campaign> {
  const { data, error } = await supabase
    .from('campaigns')
    .update({ ...input, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data as Campaign;
}

/**
 * Soft delete (design §7 / TASK-P2-P2): sets `deleted_at` rather than issuing a DELETE. A real
 * DELETE would cascade through dial_sessions/call_legs and destroy call history, and the RLS
 * delete policy on campaigns was removed for exactly this reason (20260924001500) -- a hard
 * DELETE from the client now matches zero rows under any role. Hidden from
 * `campaigns_with_stats`/listCampaigns immediately; there is no restore UI.
 */
export async function deleteCampaign(id: string): Promise<void> {
  const { error } = await supabase
    .from('campaigns')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/** Org members assigned to dial a campaign (design §7). RLS-enforced (TASK-P1-01): only
 * owner/admin may insert/delete; any org member may view. */
export async function listCampaignAgentIds(campaignId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('campaign_agents')
    .select('user_id')
    .eq('campaign_id', campaignId);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { user_id: string }[]).map((r) => r.user_id);
}

/** Replaces the full assignment set for a campaign with `userIds` (add the new ones, remove the
 * rest) -- the multi-select UI always submits the complete desired set, not a delta. */
export async function setCampaignAgents(campaignId: string, userIds: string[]): Promise<void> {
  const orgId = await getActiveOrgId();
  const current = new Set(await listCampaignAgentIds(campaignId));
  const desired = new Set(userIds);
  const toAdd = userIds.filter((id) => !current.has(id));
  const toRemove = [...current].filter((id) => !desired.has(id));

  if (toAdd.length > 0) {
    const { error } = await supabase
      .from('campaign_agents')
      .insert(toAdd.map((user_id) => ({ campaign_id: campaignId, user_id, org_id: orgId })));
    if (error) throw new Error(error.message);
  }
  if (toRemove.length > 0) {
    const { error } = await supabase
      .from('campaign_agents')
      .delete()
      .eq('campaign_id', campaignId)
      .in('user_id', toRemove);
    if (error) throw new Error(error.message);
  }
}

export async function listCampaignLeads(campaignId: string): Promise<CampaignLead[]> {
  const { data: leadsData, error: leadsError } = await supabase
    .from('campaign_leads')
    .select('id, campaign_id, contact_id, status, added_at')
    .eq('campaign_id', campaignId)
    .order('added_at', { ascending: false });
  if (leadsError) throw new Error(leadsError.message);
  const leads = (leadsData ?? []) as {
    id: string;
    campaign_id: string;
    contact_id: string;
    status: string;
    added_at: string;
  }[];
  if (leads.length === 0) return [];
  const contactIds = [...new Set(leads.map((l) => l.contact_id))];
  const { data: contactsData, error: contactsError } = await supabase
    .from('contacts')
    .select('*')
    .in('id', contactIds);
  if (contactsError) throw new Error(contactsError.message);
  const contactsMap = new Map(((contactsData ?? []) as Contact[]).map((c) => [c.id, c]));
  return leads
    .map((l) => ({
      id: l.id,
      campaign_id: l.campaign_id,
      contact_id: l.contact_id,
      status: l.status as 'queued' | 'passthrough' | 'completed',
      added_at: l.added_at,
      contact: contactsMap.get(l.contact_id)!,
    }))
    .filter((cl) => cl.contact);
}

/** PostgREST's `.in(col, values)` compiles every value into the request URL -- batches a large
 * id list (TASK-L3 review fix-forward) instead of risking a URL length limit. Mirrors
 * `_shared/campaign-queue.ts`'s `chunk` (that one lives in the Deno functions tree, not
 * importable from the browser bundle, so this is a second, tiny copy, not a shared import). */
function chunk<T>(items: readonly T[], size = 200): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface AddLeadsToCampaignResult {
  added: number;
  skippedDnc: number;
  skippedActiveElsewhere: number;
}

/**
 * TASK-L3 review fix-forward (MAJOR item 3): this used to be a single unconditional upsert, which
 * a single already-active-elsewhere contact would fail entirely (a 23505 against
 * `idx_campaign_leads_one_active_per_contact`, added by this same task) -- rejecting the WHOLE
 * batch, including every contact that was perfectly fine to add. Now pre-filters DNC and
 * active-elsewhere contacts first (same policy CSV/GHL import already enforce via
 * `planCampaignQueue`, reimplemented here rather than shared since that planner lives in the Deno
 * functions tree) and reports what it skipped instead of throwing.
 */
export async function addLeadsToCampaign(
  campaignId: string,
  contactIds: string[]
): Promise<AddLeadsToCampaignResult> {
  if (contactIds.length === 0) return { added: 0, skippedDnc: 0, skippedActiveElsewhere: 0 };
  const orgId = await getActiveOrgId();

  const dncIds = new Set<string>();
  for (const batch of chunk(contactIds)) {
    const { data, error } = await supabase
      .from('contacts')
      .select('id, dnc')
      .in('id', batch)
      .eq('dnc', true);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { id: string }[]) dncIds.add(row.id);
  }

  const candidateIds = contactIds.filter((id) => !dncIds.has(id));
  const activeElsewhereIds = new Set<string>();
  // TASK-L8 review nit: this same query already returns a candidate's row in THIS campaign too
  // (its `status` is one of the active ones checked below) -- track those separately so
  // re-adding a contact already a lead here doesn't get counted as newly `added` below, even
  // though the upsert itself is a harmless no-op for it (ON CONFLICT DO NOTHING).
  const alreadyPresentIds = new Set<string>();
  for (const batch of chunk(candidateIds)) {
    if (batch.length === 0) continue;
    const { data, error } = await supabase
      .from('campaign_leads')
      .select('contact_id, campaign_id')
      .in('contact_id', batch)
      .in('status', ['queued', 'in_flight', 'callback']);
    if (error) throw new Error(error.message);
    for (const row of (data ?? []) as { contact_id: string; campaign_id: string }[]) {
      if (row.campaign_id !== campaignId) activeElsewhereIds.add(row.contact_id);
      else alreadyPresentIds.add(row.contact_id);
    }
  }

  const toAdd = candidateIds.filter(
    (id) => !activeElsewhereIds.has(id) && !alreadyPresentIds.has(id)
  );
  if (toAdd.length > 0) {
    for (const batch of chunk(toAdd)) {
      const rows = batch.map((contact_id) => ({
        campaign_id: campaignId,
        contact_id,
        org_id: orgId,
      }));
      const { error } = await supabase.from('campaign_leads').upsert(rows, {
        onConflict: 'campaign_id,contact_id',
        ignoreDuplicates: true,
      });
      if (error) throw new Error(error.message);
    }
  }

  return {
    added: toAdd.length,
    skippedDnc: dncIds.size,
    skippedActiveElsewhere: activeElsewhereIds.size,
  };
}

export async function removeLeadFromCampaign(campaignId: string, contactId: string): Promise<void> {
  const { error } = await supabase
    .from('campaign_leads')
    .delete()
    .eq('campaign_id', campaignId)
    .eq('contact_id', contactId);
  if (error) throw new Error(error.message);
}

export async function removeLeadsFromCampaign(
  campaignId: string,
  contactIds: string[]
): Promise<void> {
  if (contactIds.length === 0) return;
  const { error } = await supabase
    .from('campaign_leads')
    .delete()
    .eq('campaign_id', campaignId)
    .in('contact_id', contactIds);
  if (error) throw new Error(error.message);
}

export async function getWebrtcCredentials(): Promise<{ token: string }> {
  const res = await fetch(`${getFunctionsUrl()}/telnyx-webrtc-credentials`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = (await res.json()) as { token?: string; error?: string };
  if (!res.ok) throw new Error(data.error || 'Failed to get credentials');
  const token = data.token && typeof data.token === 'string' ? data.token.trim() : '';
  if (!token)
    throw new Error(data.error || 'No WebRTC token received. Check Telnyx credential connection.');
  return { token };
}

// --- Parallel dialer session (TASK-P2-E2: org-scoped dial_sessions/call_legs engine) ---
// Rewritten from the legacy Redis/dialer_sessions contract. Behavior changes: no more
// fromNumber/agentCallControlId/agentCallbackNumber on start (the caller ID now comes from
// the campaign's own caller_id_number_id, TASK-P2-P1) and no calls_made/calls_connected/
// calls_voicemail/calls_no_answer summary counters (there is no equivalent rollup query yet
// -- a future task can add one; for now the UI should derive progress from the `legs` array
// getDialerSession returns, same as the realtime DIALER_* events it already listens to).

export type DialSessionState =
  | 'ready_pending'
  | 'ready'
  | 'dialing'
  | 'connecting'
  | 'on_call'
  | 'wrap_up'
  | 'paused'
  | 'paused_agent_lost'
  | 'stopped'
  | 'completed';

export type CallLegState =
  | 'initiated'
  | 'ringing'
  | 'answered'
  | 'amd_pending'
  | 'claimed'
  | 'dropped'
  | 'abandoned'
  | 'machine'
  | 'voicemail_dropping'
  | 'ended';

export type CallLegOutcome =
  | 'no_answer'
  | 'busy'
  | 'machine'
  | 'dropped'
  | 'abandoned'
  | 'failed'
  | 'connected'
  | 'voicemail_left';

export interface DialSessionRecord {
  id: string;
  org_id: string;
  campaign_id: string;
  agent_id: string;
  state: DialSessionState;
  lines: number;
  amd_mode: 'off' | 'detect' | 'detect_words' | 'premium';
  agent_leg_id: string | null;
  active_leg_id: string | null;
  conference_id: string | null;
  started_at: string;
  ended_at: string | null;
  updated_at: string;
  /** TASK-N1: only meaningful while `state === 'paused'` -- see dialer-engine.ts's own
   *  `pause_reason` field comment for why a stale value from a past pause must be ignored once
   *  the session has moved on. Today's only real value is 'no_numbers_available'. */
  pause_reason: string | null;
}

export interface CallLegRecord {
  id: string;
  kind: 'contact' | 'agent';
  state: CallLegState;
  outcome: CallLegOutcome | null;
  contact_id: string | null;
  lead_id: string | null;
  call_control_id: string;
  amd_result: string | null;
  hangup_cause: string | null;
  answered_at: string | null;
  claimed_at: string | null;
  ended_at: string | null;
  created_at: string;
  /** TASK-L2b: null until a wrap-up disposition is submitted for this leg -- the signal the
   *  dialer UI uses to find "the leg still waiting on a disposition" during `wrap_up` (a leg's
   *  own `active_leg_id` reference on the session is already cleared by then). */
  dispositioned_at: string | null;
  contact: {
    business_name: string | null;
    first_name: string | null;
    last_name: string | null;
    phone_number: string | null;
  } | null;
}

/** TASK-I1: the session's CURRENT bridged inbound call, if any (`dialer-session-get`'s own
 *  `bridging_session`-and-not-yet-ended scoping) -- lets the Dialer flag the contact card
 *  "Inbound call" per the task's own explicit ask. Null the rest of the time, including after
 *  the inbound call ends (even though `inbound_calls.dial_session_id` itself is never cleared). */
export interface InboundCallInfo {
  id: string;
  from_e164: string;
  contact_id: string | null;
  answered_at: string | null;
  contact: {
    business_name: string | null;
    first_name: string | null;
    last_name: string | null;
    phone_number: string | null;
  } | null;
}

/** Thrown when startDialerSession returns 409 because an active session already exists for the campaign. */
export class ActiveSessionExistsError extends Error {
  constructor(
    message: string,
    public readonly existingSessionId: string
  ) {
    super(message);
    this.name = 'ActiveSessionExistsError';
  }
}

/** TASK-L1r4 round 5 (review-notes-r4.md, MAJOR): thrown when reconnectDialerSession returns
 *  409 RECONNECT_ALREADY_IN_FLIGHT -- the caller's own auto-reconnect budget already fired once
 *  for this drop and a reconnect for it is still in flight server-side. Callers should treat
 *  this one specifically as expected/silent, not an error to show the intern. */
export class ReconnectAlreadyInFlightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconnectAlreadyInFlightError';
  }
}

/** BUG-11: the server refused to stop the session because a contact leg is `claimed` (a live
 *  human bridged to the agent) and the request didn't pass `force: true`. `ParallelDialerUI`'s
 *  own confirm dialog is what normally prevents this from ever being thrown in practice --
 *  seeing it means the session went live in the moment between the UI's last poll and the
 *  click, not a real gap in the confirm flow. */
export class LiveCallInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiveCallInProgressError';
  }
}

export async function startDialerSession(args: {
  campaignId: string;
  /** Overrides the campaign's own default `lines` (1-7) for this session only. */
  lines?: 1 | 2 | 3 | 4 | 5 | 6 | 7;
  /** Overrides the campaign's own default `amd_mode` for this session only. */
  amdMode?: 'off' | 'detect' | 'detect_words' | 'premium';
}): Promise<{ sessionId: string }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-start`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify(args),
  });
  const data = (await res.json()) as {
    error?: string;
    code?: string;
    existingSessionId?: string;
    sessionId?: string;
  };
  if (!res.ok) {
    if (res.status === 409 && data.code === 'ACTIVE_SESSION_EXISTS' && data.existingSessionId) {
      throw new ActiveSessionExistsError(
        data.error || 'An active dialer session already exists for this campaign.',
        data.existingSessionId
      );
    }
    throw new Error(data.error || `Failed to start dialer session (${res.status})`);
  }
  return data as { sessionId: string };
}

/** `force` (BUG-11): pass true only once the confirm dialog has been shown and accepted (or
 *  there was no live human to confirm) -- see `LiveCallInProgressError`'s own comment. */
export async function stopDialerSession(
  sessionId: string,
  opts?: { force?: boolean }
): Promise<{ status: 'stopped' }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-stop`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ sessionId, force: opts?.force === true }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 409 && data.code === 'LIVE_CALL_IN_PROGRESS') {
      throw new LiveCallInProgressError(data.error || 'A prospect is on the line.');
    }
    throw new Error(data.error || 'Failed to stop dialer session');
  }
  return data as { status: 'stopped' };
}

export async function pauseDialerSession(sessionId: string): Promise<{ status: 'paused' }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-pause`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ sessionId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to pause dialer session');
  return data as { status: 'paused' };
}

/** TASK-L1: re-dials a fresh agent leg into the session's existing conference after an
 *  agent-leg-lost (`paused_agent_lost`) -- the "Reconnect" button. */
export async function reconnectDialerSession(
  sessionId: string
): Promise<{ status: 'reconnecting' }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-reconnect`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ sessionId }),
  });
  const data = (await res.json()) as { error?: string; code?: string; status?: string };
  if (!res.ok) {
    if (data.code === 'RECONNECT_ALREADY_IN_FLIGHT') {
      throw new ReconnectAlreadyInFlightError(
        data.error || 'A reconnect is already in progress for this session.'
      );
    }
    throw new Error(data.error || 'Failed to reconnect dialer session');
  }
  return data as { status: 'reconnecting' };
}

/** TASK-L2b: resumes a manually `paused` session back to `dialing`. */
export async function resumeDialerSession(sessionId: string): Promise<{ status: 'dialing' }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-resume`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ sessionId }),
  });
  const data = (await res.json()) as { error?: string; status?: string };
  if (!res.ok) throw new Error(data.error || 'Failed to resume dialer session');
  return data as { status: 'dialing' };
}

/** End the current live (claimed/on_call) contact leg in a session; the resulting webhook
 *  drives the normal ended -> wrap_up flow. */
export async function hangupLiveCall(sessionId: string): Promise<void> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-hangup-live`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ sessionId }),
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) throw new Error(data.error || 'Failed to end live call');
}

export async function getDialerSession(sessionId: string): Promise<{
  session: DialSessionRecord;
  legs: CallLegRecord[];
  inboundCall: InboundCallInfo | null;
}> {
  const res = await fetch(
    `${getFunctionsUrl()}/dialer-session-get?sessionId=${encodeURIComponent(sessionId)}`,
    {
      method: 'GET',
      headers: await getEdgeFunctionHeaders(),
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load dialer session');
  return data as {
    session: DialSessionRecord;
    legs: CallLegRecord[];
    inboundCall: InboundCallInfo | null;
  };
}

/** Returns the current user's active parallel dialer session (if any) in the active org. Use
 *  this to restore the parallel dialer UI when opening the Dialer tab. */
export async function getActiveDialerSession(): Promise<{
  sessionId: string;
  campaignId: string;
  state: DialSessionState;
} | null> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-active`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = (await res.json()) as {
    session?: { sessionId: string; campaignId: string; state: DialSessionState } | null;
    error?: string;
  };
  if (!res.ok) throw new Error(data.error || 'Failed to get active dialer session');
  return data.session ?? null;
}

// --- GHL integration (TASK-P3-P1) ---

export interface GhlIntegrationStatus {
  status: 'disconnected' | 'pending_verification' | 'connected' | 'error';
  location_id: string | null;
  connected_at: string | null;
  /** TASK-G7 (GHL-7): the org's configured blocked-tag lists. Defaults to
   *  ['do not call','dnc','do-not-call'] / ['paused','pause'] until an owner/admin edits them. */
  ghl_dnc_tags: string[];
  ghl_paused_tags: string[];
}

/** Reads the safe `org_integrations_status` view -- never the base table, which has no client policies at all. */
export async function getGhlIntegrationStatus(): Promise<GhlIntegrationStatus | null> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_integrations_status')
    .select('status, location_id, connected_at, ghl_dnc_tags, ghl_paused_tags')
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as GhlIntegrationStatus | null;
}

/** Owner/admin only (TASK-G7). Replaces both lists wholesale -- there's no partial-update
 *  endpoint, matching how the Settings editor always submits both lists together. */
export async function updateGhlBlockedTags(
  dncTags: string[],
  pausedTags: string[]
): Promise<{ dncTags: string[]; pausedTags: string[] }> {
  const res = await fetch(`${getFunctionsUrl()}/ghl-update-blocked-tags`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ dncTags, pausedTags }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update blocked tags');
  return data;
}

export async function connectGhl(
  token: string,
  locationId: string
): Promise<{ locationId: string; locationName: string }> {
  const orgId = await getActiveOrgId();
  const res = await fetch(`${getFunctionsUrl()}/ghl-connect`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ orgId, token, locationId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to connect GHL');
  return { locationId: data.locationId, locationName: data.locationName };
}

export async function disconnectGhl(): Promise<void> {
  const orgId = await getActiveOrgId();
  const res = await fetch(`${getFunctionsUrl()}/ghl-disconnect`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ orgId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to disconnect GHL');
}

// --- GHL pull import (TASK-P3-P2) ---

export interface ImportFromGhlInput {
  /** "tag": pages every contact in the connected location and keeps only those whose GHL
   *  tags include `value` (case-insensitive) -- GHL has no server-side tag filter. "search":
   *  passes `value` straight through as GHL's own free-text `query` param. */
  mode: 'tag' | 'search';
  value: string;
  /** When set, every created/updated contact is also queued onto this campaign. */
  campaignId?: string;
}

export interface ImportFromGhlResult {
  created: number;
  updated: number;
  skipped: number;
  invalid: number;
  /** Only meaningful when campaignId was passed -- contacts (new or updated) not queued onto it
   *  because GHL marked them dnd or tagged them with one of the org's configured DNC tags
   *  (TASK-G7, GHL-7). */
  skippedDnc: number;
  /** Same, for contacts tagged with one of the org's configured paused tags. */
  skippedPaused: number;
  /** Same, for contacts already active in a different campaign (QUE-8). */
  skippedActiveCampaign: number;
  /** TASK-G7: total contacts this run marked DNC from a GHL tag/dnd flag, regardless of whether
   *  campaignId was passed -- unlike skippedDnc, which only covers the optional queue step. */
  dncTagged: number;
  /** Same, for the org's configured paused tags. */
  pausedTagged: number;
  /** TASK-G7: contacts that were paused as of their last import and no longer carry a paused tag
   *  this run. Re-queueing them onto a campaign is never automatic -- this is a count only, for
   *  a manager to act on. */
  unpaused: number;
  /** true when the org has more matching GHL contacts than this run fetched (a 2,000-contact
   *  per-run cap -- see ghl-import.ts) -- re-running the same import continues from where the
   *  last one left off, since matched contacts are skipped as already up to date. */
  truncated: boolean;
}

/** "Import from GHL" and "Re-sync" (design §7) are the same call -- re-running it with the
 *  same { mode, value } is idempotent (dedupe on ghl_contact_id, then normalized phone), so
 *  "Re-sync" just means the UI remembers and replays the last import's params. */
export async function importFromGhl(input: ImportFromGhlInput): Promise<ImportFromGhlResult> {
  const res = await fetch(`${getFunctionsUrl()}/ghl-import`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ mode: input.mode, value: input.value, campaignId: input.campaignId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to import from GHL');
  return data as ImportFromGhlResult;
}

// --- GHL push outbox worker (TASK-P3-P3) ---

export interface CrmSyncJob {
  id: string;
  org_id: string;
  provider: string;
  kind: 'disposition' | 'contact_upsert';
  contact_id: string | null;
  status: 'queued' | 'running' | 'done' | 'failed' | 'dead';
  attempts: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** Last 20 sync jobs for the active org, newest-updated first. Reads `crm_sync_jobs_recent`
 *  (a security_invoker view over `crm_sync_jobs` -- RLS still applies per caller, owner/admin
 *  only, same as the base table's own policy). */
export async function listCrmSyncJobs(): Promise<CrmSyncJob[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('crm_sync_jobs_recent')
    .select('*')
    .eq('org_id', orgId)
    .order('updated_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as CrmSyncJob[];
}

// --- Dispositions (TASK-P3-E1, design §5) ---

export type DispositionLeadEffect = 'completed' | 'callback' | 'exhausted' | 'dnc' | 'queued';

export interface Disposition {
  id: string;
  org_id: string;
  key: string;
  label: string;
  lead_effect: DispositionLeadEffect;
  ghl_tag: string | null;
  creates_task: boolean;
  sort: number;
  active: boolean;
  /** TASK-F-P1 (Wins): default true only for the seeded 'yes_build_profile'; org-editable at
   *  creation time (see CreateDispositionInput) -- feeds the Dashboard's "Wins today" StatCard. */
  is_win: boolean;
  /** TASK-F-P1 (DSP-4): field names WrapUpModal must collect before this disposition can be
   *  submitted. Only 'license_number' and 'zips' are actually wired up today. Set once at
   *  creation, matching `key`/`lead_effect`'s own "not editable after creation" precedent below --
   *  changing it later would retroactively reinterpret already-submitted dispositions. */
  required_fields: string[] | null;
}

/** Every org's dispositions (including inactive ones -- the Settings editor lists both; the
 *  wrap-up form filters to active=true itself). RLS scopes this to the caller's own org
 *  regardless of the explicit .eq below (belt and suspenders, same as listCrmSyncJobs). */
export async function listDispositions(): Promise<Disposition[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('dispositions')
    .select(
      'id, org_id, key, label, lead_effect, ghl_tag, creates_task, sort, active, is_win, required_fields'
    )
    .eq('org_id', orgId)
    .order('sort', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as Disposition[];
}

export interface CreateDispositionInput {
  key: string;
  label: string;
  lead_effect: DispositionLeadEffect;
  ghl_tag?: string | null;
  creates_task?: boolean;
  sort?: number;
  is_win?: boolean;
  required_fields?: string[] | null;
}

/** admin+ only (RLS-enforced) -- a straight insert through the `dispositions` table, no edge
 *  function needed. "A simple list edit is fine" per the task spec. */
export async function createDisposition(input: CreateDispositionInput): Promise<Disposition> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('dispositions')
    .insert({
      org_id: orgId,
      key: input.key,
      label: input.label,
      lead_effect: input.lead_effect,
      ghl_tag: input.ghl_tag ?? null,
      creates_task: input.creates_task ?? false,
      sort: input.sort ?? 0,
      is_win: input.is_win ?? false,
      required_fields: input.required_fields ?? null,
    })
    .select(
      'id, org_id, key, label, lead_effect, ghl_tag, creates_task, sort, active, is_win, required_fields'
    )
    .single();
  if (error) throw new Error(error.message);
  return data as Disposition;
}

export interface UpdateDispositionInput {
  label?: string;
  ghl_tag?: string | null;
  creates_task?: boolean;
  sort?: number;
  active?: boolean;
  is_win?: boolean;
}

/** `key` and `lead_effect` are intentionally not editable here -- crm_sync_jobs payloads and any
 *  already-submitted call_legs rows reference a disposition by id, but the GHL worker tags by
 *  `ghl_tag` and the wrap-up form groups by `lead_effect`; changing either on an existing row
 *  after it's been used would retroactively reinterpret past dispositions. Deactivate + create a
 *  new one instead. */
export async function updateDisposition(id: string, patch: UpdateDispositionInput): Promise<void> {
  const { error } = await supabase.from('dispositions').update(patch).eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteDisposition(id: string): Promise<void> {
  const { error } = await supabase.from('dispositions').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

export interface SubmitDispositionInput {
  legId: string;
  dispositionKey: string;
  notes?: string;
  /** ISO 8601. Required by the backend only when the chosen disposition's lead_effect is
   *  'callback'; ignored otherwise. */
  callbackAt?: string;
  /** TASK-F-P1 (DSP-4): required by the backend only when the chosen disposition's
   *  `required_fields` names them; ignored otherwise. */
  licenseNumber?: string;
  zips?: string[];
}

export interface SubmitDispositionResult {
  sessionId: string;
  alreadySubmitted: boolean;
  /** How many new legs the post-submit refill dialed (0 is normal -- most refills find nothing
   *  newly due, or the session already left 'dialing' again before this ran). */
  dialed: number;
}

/** Called by WrapUpModal once the agent submits the mandatory wrap-up form. */
export async function submitDisposition(
  input: SubmitDispositionInput
): Promise<SubmitDispositionResult> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-disposition`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({
      legId: input.legId,
      dispositionKey: input.dispositionKey,
      notes: input.notes,
      callbackAt: input.callbackAt,
      licenseNumber: input.licenseNumber,
      zips: input.zips,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to submit disposition');
  return data as SubmitDispositionResult;
}

export interface ContactDispositionHistoryEntry {
  leg_id: string;
  dispositioned_at: string;
  agent_name: string;
  disposition_label: string | null;
  notes: string | null;
  has_recording: boolean;
}

/** TASK-F-P1 (DSP-9): the last 3 dispositions for a contact, across every agent who's called
 *  them, not just the caller's own sessions -- call_legs' own RLS ("agent can view own
 *  call_legs") wouldn't allow that directly, so this goes through the
 *  `contact_disposition_history` SECURITY DEFINER function instead (org-membership-checked
 *  itself), same "front door read" shape as team-performance. */
export async function listContactDispositionHistory(
  contactId: string
): Promise<ContactDispositionHistoryEntry[]> {
  const { data, error } = await supabase.rpc('contact_disposition_history', {
    p_contact_id: contactId,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ContactDispositionHistoryEntry[];
}

// --- Org-wide DNC list (TASK-F-T1, QUE-7/DSP-6) ---

export interface DncNumber {
  id: string;
  org_id: string;
  e164: string;
  source: 'disposition' | 'sms_stop' | 'manual' | 'import';
  added_by: string | null;
  note: string | null;
  created_at: string;
}

/** Owner/admin only (RLS-enforced) -- a straight table read, no edge function, same "a simple
 *  list edit is fine" pattern as listDispositions. */
export async function listDncNumbers(): Promise<DncNumber[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('dnc_numbers')
    .select('id, org_id, e164, source, added_by, note, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as DncNumber[];
}

/** `e164` must already be normalized client-side (phone-normalize.ts's normalizePhoneStrict) --
 *  this function does not re-normalize, matching createDisposition's own "no server-side
 *  normalization" shape. */
export async function addDncNumber(e164: string, note?: string): Promise<DncNumber> {
  const orgId = await getActiveOrgId();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const { data, error } = await supabase
    .from('dnc_numbers')
    .insert({
      org_id: orgId,
      e164,
      source: 'manual',
      added_by: user?.id ?? null,
      note: note ?? null,
    })
    .select('id, org_id, e164, source, added_by, note, created_at')
    .single();
  if (error) throw new Error(error.message);
  return data as DncNumber;
}

export async function removeDncNumber(id: string): Promise<void> {
  const { error } = await supabase.from('dnc_numbers').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// --- Campaign retry rules (TASK-F-T1, QUE-2/QUE-3/QUE-5) ---

export type RetryRuleAction = 'retry' | 'out' | 'exact_time';

export interface CampaignRetryRule {
  id: string;
  campaign_id: string;
  disposition_key: string;
  action: RetryRuleAction;
  delay_minutes: number | null;
  rotate_block: boolean;
}

/** Org members can read (RLS), campaign settings only shows this to owner/admin in practice.
 *  Every campaign gets its seeded default rows via a DB trigger on insert, so this list is never
 *  empty for a real campaign. */
export async function listCampaignRetryRules(campaignId: string): Promise<CampaignRetryRule[]> {
  const { data, error } = await supabase
    .from('campaign_retry_rules')
    .select('id, campaign_id, disposition_key, action, delay_minutes, rotate_block')
    .eq('campaign_id', campaignId);
  if (error) throw new Error(error.message);
  return (data ?? []) as CampaignRetryRule[];
}

export interface UpsertCampaignRetryRuleInput {
  disposition_key: string;
  action: RetryRuleAction;
  delay_minutes: number | null;
  rotate_block: boolean;
}

/** Admin+ only (RLS-enforced). Bulk-upserts on the table's own unique (campaign_id,
 *  disposition_key) constraint -- every row already exists (seeded on campaign creation), so
 *  this is always an update in practice, never a real insert, but upsert keeps the editor's own
 *  save button simple (no per-row dirty tracking needed). */
export async function upsertCampaignRetryRules(
  campaignId: string,
  rules: UpsertCampaignRetryRuleInput[]
): Promise<void> {
  const { error } = await supabase.from('campaign_retry_rules').upsert(
    rules.map((r) => ({ campaign_id: campaignId, ...r })),
    { onConflict: 'campaign_id,disposition_key' }
  );
  if (error) throw new Error(error.message);
}

// --- Call recording (TASK-F-T2, REC-4/REC-6) ---

/** Owner/admin only (RLS-enforced) -- a straight table read/write, no edge function, same
 *  "a simple settings toggle is fine" pattern as listCampaignRetryRules. Defaults to `true`
 *  when the org has no row yet (matches the column's own default and org_recording_settings'
 *  seed trigger -- see the migration). */
export async function getRecordingEnabled(): Promise<boolean> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_recording_settings')
    .select('recording_enabled')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.recording_enabled ?? true;
}

export async function setRecordingEnabled(enabled: boolean): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase
    .from('org_recording_settings')
    .upsert({ org_id: orgId, recording_enabled: enabled, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

export interface RecordingUrlResult {
  url: string;
  expiresInSeconds: number;
}

/** A fresh 10-minute signed URL for one call leg's recording, or throws (404: not recorded /
 *  still processing / not this caller's to see -- WrapUpModal treats all of those the same:
 *  "not available yet", keep the play button hidden, no error surfaced). */
export async function getRecordingUrl(callLegId: string): Promise<RecordingUrlResult> {
  const res = await fetch(`${getFunctionsUrl()}/recording-url`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ callLegId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Recording not available');
  return data as RecordingUrlResult;
}

// --- Voicemail drop (TASK-F-T3, VMD-1) ---

export interface VoicemailDropInfo {
  hasFile: boolean;
  url: string | null;
  expiresInSeconds: number | null;
}

async function fetchVoicemailDrop(scope: 'self' | 'org'): Promise<VoicemailDropInfo> {
  const res = await fetch(`${getFunctionsUrl()}/voicemail-upload?scope=${scope}`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  if (res.status === 404) return { hasFile: false, url: null, expiresInSeconds: null };
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load voicemail drop');
  return { hasFile: true, url: data.url, expiresInSeconds: data.expiresInSeconds };
}

/** The signed-in member's own voicemail-drop file, or `hasFile: false` if they haven't set one. */
export function getMyVoicemailDrop(): Promise<VoicemailDropInfo> {
  return fetchVoicemailDrop('self');
}

/** The org's default voicemail-drop file (owner/admin-set), readable by any member. */
export function getOrgDefaultVoicemailDrop(): Promise<VoicemailDropInfo> {
  return fetchVoicemailDrop('org');
}

async function uploadVoicemailDrop(scope: 'self' | 'org', file: File): Promise<VoicemailDropInfo> {
  const headers = (await getEdgeFunctionHeaders()) as Record<string, string>;
  const res = await fetch(`${getFunctionsUrl()}/voicemail-upload?scope=${scope}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': file.type },
    body: file,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Upload failed');
  return { hasFile: true, url: data.url, expiresInSeconds: data.expiresInSeconds };
}

/** Uploads (mp3/wav, <=5MB) the signed-in member's own voicemail-drop file. */
export function uploadMyVoicemailDrop(file: File): Promise<VoicemailDropInfo> {
  return uploadVoicemailDrop('self', file);
}

/** Owner/admin only server-side -- uploads the org's default voicemail-drop file. */
export function uploadOrgDefaultVoicemailDrop(file: File): Promise<VoicemailDropInfo> {
  return uploadVoicemailDrop('org', file);
}

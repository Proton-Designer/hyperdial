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

// --- TASK-T9 (Mission 4): caller-ID health (CID-4) + local-presence fallback ---

export interface NumberHealthStat {
  number_id: string;
  org_id: string;
  phone_number: string;
  status: 'active' | 'resting' | 'retired';
  flagged_at: string | null;
  flagged_reason: string | null;
  dials_7d: number;
  connected_7d: number;
  human_answer_rate_7d: number | null;
  avg_talk_seconds_7d: number | null;
  dials_30d: number;
  connected_30d: number;
  human_answer_rate_30d: number | null;
  avg_talk_seconds_30d: number | null;
}

/** Org-scoped read of the `number_health_stats` view (security_invoker=on) -- RLS on the
 *  underlying `user_phone_numbers`/`call_legs` tables ("org members can view...") already scopes
 *  this correctly for a direct authenticated-client query, same pattern as
 *  getNumberPoolSettings above. */
export async function getNumberHealthStats(): Promise<NumberHealthStat[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('number_health_stats')
    .select('*')
    .eq('org_id', orgId)
    .order('phone_number', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as NumberHealthStat[];
}

export interface NumberHealthCheckResult {
  numberId: string;
  phoneNumber: string;
  sampleDials: number;
  humanAnswerRate: number;
  poolMedianRate: number;
}

/** On-demand half of CID-4's "weekly (and on demand)" check -- owner/admin only
 *  (number-health-check's own requireOrgRole gate); runs check_number_health for THIS org
 *  regardless of health_alerts_enabled (an explicit, user-initiated check is not "new automatic
 *  behaviour" -- see the migration's own comment on check_number_health). */
export async function runNumberHealthCheck(): Promise<NumberHealthCheckResult[]> {
  const res = await fetch(`${getFunctionsUrl()}/number-health-check`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to run number health check');
  return (data.flagged ?? []) as NumberHealthCheckResult[];
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

// --- MISSION-5 TASK-M5-B3: distribution guards ---

export interface DistributionSettings {
  callback_fallback_enabled: boolean;
  callback_fallback_minutes: number;
  daily_dial_cap_enabled: boolean;
  daily_dial_cap_default: number;
}

/** Same "member read, owner/admin write, direct client upsert against RLS" shape as
 *  getSpendSettings/updateSpendSettings above -- every org already has a seeded row (the
 *  orgs-insert trigger), this fallback is defensive only. */
export async function getDistributionSettings(): Promise<DistributionSettings> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_distribution_settings')
    .select(
      'callback_fallback_enabled, callback_fallback_minutes, daily_dial_cap_enabled, daily_dial_cap_default'
    )
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (
    (data as DistributionSettings | null) ?? {
      callback_fallback_enabled: false,
      callback_fallback_minutes: 30,
      daily_dial_cap_enabled: false,
      daily_dial_cap_default: 300,
    }
  );
}

export async function updateDistributionSettings(settings: DistributionSettings): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.from('org_distribution_settings').upsert({
    org_id: orgId,
    ...settings,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** Per-agent override -- absence means "use the org default." Owner/admin only (RLS); any
 *  member may read the whole org's list. No dedicated UI table for this yet (TASK-M5-B3's own
 *  scope note) -- exposed here so a future Settings screen (or this one, extended) doesn't need
 *  a new RPC. */
export interface AgentDialCap {
  agent_id: string;
  daily_cap: number;
}

export async function listAgentDialCaps(): Promise<AgentDialCap[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_agent_dial_caps')
    .select('agent_id, daily_cap')
    .eq('org_id', orgId);
  if (error) throw new Error(error.message);
  return (data ?? []) as AgentDialCap[];
}

export async function setAgentDialCap(agentId: string, dailyCap: number): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.from('org_agent_dial_caps').upsert({
    org_id: orgId,
    agent_id: agentId,
    daily_cap: dailyCap,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

export async function clearAgentDialCap(agentId: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase
    .from('org_agent_dial_caps')
    .delete()
    .eq('org_id', orgId)
    .eq('agent_id', agentId);
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

// --- TASK-BF1: add funds + auto-recharge (owner AND admin) ---

export type AutoRechargePreference = 'credit_paypal' | 'ach';

export interface AutoRechargePrefs {
  id: string | null;
  enabled: boolean;
  thresholdAmountUsd: number;
  rechargeAmountUsd: number;
  invoiceEnabled: boolean;
  preference: AutoRechargePreference;
}

export type BillingInfo =
  | {
      available: true;
      balanceUsd: number;
      availableCreditUsd: number;
      autoRecharge: AutoRechargePrefs;
    }
  | { available: false; reason: string };

/** Owner/admin only. Live balance + auto-recharge prefs -- both need the org's own decrypted
 *  Telnyx key, hence an Edge Function (same reason getSpendStatus needs one). `available: false`
 *  is a normal, displayable state (Telnyx not connected, or a transient API error), not a thrown
 *  error -- same convention as getSpendStatus. */
export async function getBillingInfo(): Promise<BillingInfo> {
  const res = await fetch(`${getFunctionsUrl()}/telnyx-billing`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ action: 'get' }),
  });
  const data = await res.json();
  if (!res.ok) return { available: false, reason: data.error || 'Failed to load billing info' };
  return { available: true, ...data };
}

export class BillingActionError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'BillingActionError';
    this.code = code;
  }
}

export async function updateAutoRecharge(
  prefs: Omit<AutoRechargePrefs, 'id'>
): Promise<AutoRechargePrefs> {
  const res = await fetch(`${getFunctionsUrl()}/telnyx-billing`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ action: 'update_auto_recharge', ...prefs }),
  });
  const data = await res.json();
  if (!res.ok)
    throw new BillingActionError(data.error || 'Failed to update auto-recharge', data.code);
  return data.autoRecharge as AutoRechargePrefs;
}

export interface AddFundsResult {
  transactionId: string | null;
  balanceUsd: number | null;
  availableCreditUsd: number | null;
}

/** `idempotencyKey`: generate ONE `crypto.randomUUID()` when the confirm dialog opens and reuse
 *  it for every attempt of that same charge (including a retry after a network error) -- the
 *  server refuses a second charge under the same key (org-scoped unique constraint,
 *  org_billing_events). Never generate a new key for a "try again" click on the SAME charge. */
export async function addFunds(amountUsd: number, idempotencyKey: string): Promise<AddFundsResult> {
  const res = await fetch(`${getFunctionsUrl()}/telnyx-billing`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ action: 'add_funds', amountUsd, idempotencyKey }),
  });
  const data = await res.json();
  if (!res.ok) throw new BillingActionError(data.error || 'Failed to add funds', data.code);
  return data as AddFundsResult;
}

export interface BillingEvent {
  id: string;
  user_id: string | null;
  kind: 'add_funds' | 'auto_recharge_update';
  amount_usd: number | null;
  // 'unknown' (TASK-BF1 fix): Telnyx's own outcome for this charge couldn't be confirmed
  // (network error/timeout/5xx) -- may or may not have actually charged the card.
  status: 'pending' | 'succeeded' | 'failed' | 'unknown';
  telnyx_transaction_id: string | null;
  error: string | null;
  created_at: string;
}

/** Direct RLS read (owner/admin SELECT-only policy, org_billing_events) -- no Edge Function
 *  needed, same "member/admin read... no edge function" shape as getSpendSettings, since this
 *  needs no live Telnyx call. */
export async function listRecentBillingEvents(): Promise<BillingEvent[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_billing_events')
    .select('id, user_id, kind, amount_usd, status, telnyx_transaction_id, error, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) throw new Error(error.message);
  return (data as BillingEvent[]) ?? [];
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
  /** MISSION-5 TASK-M5-B1: the session's dial_sessions.pause_reason, only non-null while
   *  status === 'paused'. */
  pause_reason: string | null;
}

/** Poll every 5s (ADM-7) -- a single RPC round trip per poll, not N queries. */
export async function getTeamLiveBoard(): Promise<TeamLiveBoardRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('team_live_board', { p_org: orgId });
  if (error) throw new Error(error.message);
  return (data ?? []) as TeamLiveBoardRow[];
}

/** MISSION-5 TASK-M5-B1: per agent/day seconds by state and pause reason -- consumed by
 *  TASK-M5-A4's attendance tab. Owner/admin only (server-enforced inside the RPC, not just
 *  client-gated); `agentId` narrows an owner/admin's own query, it is not a self-view for an
 *  agent (see the RPC's own header comment). `tz` defaults to 'America/Chicago' until A4 adds a
 *  real org timezone to pass instead. */
export interface AgentTimeInStateRow {
  agent_id: string;
  day: string;
  state: string;
  reason: string | null;
  seconds: number;
}

export async function getAgentTimeInState(
  from: Date,
  to: Date,
  agentId?: string,
  tz?: string
): Promise<AgentTimeInStateRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('agent_time_in_state', {
    p_org: orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_agent: agentId ?? null,
    p_tz: tz ?? 'America/Chicago',
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as AgentTimeInStateRow[];
}

/** MISSION-5 TASK-M5-B1: org-level pause reason list (Dialer's pause-reason picker). Every org
 *  gets a seeded row on creation/migration (org_pause_reason_settings' own trigger + backfill),
 *  but this still falls back to the same hardcoded default list client-side, defensively, rather
 *  than ever showing an empty picker. */
export const DEFAULT_PAUSE_REASONS = ['Break', 'Lunch', 'Training', 'Meeting', 'Admin', 'Other'];

export async function getOrgPauseReasons(): Promise<string[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_pause_reason_settings')
    .select('reasons')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const reasons = (data?.reasons ?? []) as string[];
  return reasons.length > 0 ? reasons : DEFAULT_PAUSE_REASONS;
}

/** Owner/admin only -- enforced by org_pause_reason_settings' own RLS UPDATE policy, not just
 *  this function trusting the caller. */
export async function updateOrgPauseReasons(reasons: string[]): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.from('org_pause_reason_settings').upsert({
    org_id: orgId,
    reasons,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

// --- MISSION-4 TASK-T11 (ADM-8 + NEW): dialer analytics -- funnel, best-time-to-call heatmap,
// connect rate by caller-ID number and by hour. Same "front door read" RPC shape as
// getTeamDailyStats/getTeamLiveBoard above -- a non-owner/admin (or a p_campaign_id/p_org the
// caller doesn't manage) gets an empty array back, never a thrown error, since the role check
// lives inside each SQL function itself. ---

export interface FunnelSummary {
  dials: number;
  human_answers: number;
  conversations: number;
  wins: number;
}

/** `campaignId` null = every campaign in the org (or, for an agent, every campaign THEY dialed). */
export async function getFunnelSummary(
  campaignId: string | null,
  start: Date,
  end: Date
): Promise<FunnelSummary> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('funnel_summary', {
    p_org: orgId,
    p_campaign_id: campaignId,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as FunnelSummary | undefined;
  return row ?? { dials: 0, human_answers: 0, conversations: 0, wins: 0 };
}

// --- MISSION-4 TASK-T8 (compliance): drop-rate tracking. Same "front door read" RPC/scoping
// shape as getFunnelSummary above (a new, additive function -- funnel_summary itself is
// untouched, see the migration's own header for why). ---

export interface DropRateSummary {
  dials: number;
  human_answers: number;
  dropped: number;
  /** 0-100, one decimal place. `0` when human_answers is 0 (nothing to divide), never NaN. */
  drop_rate_pct: number;
}

/** "Drop rate" = a human answered but was hung up before connecting (dropped/abandoned) as a
 *  fraction of every human answer (connected + dropped + abandoned) -- REQ-1's own wording. The
 *  UI's own 3% guideline warning is a pure display concern (Analytics.tsx), not computed here. */
export async function getCampaignDropRateSummary(
  campaignId: string | null,
  start: Date,
  end: Date
): Promise<DropRateSummary> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('campaign_drop_rate_summary', {
    p_org: orgId,
    p_campaign_id: campaignId,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error) throw new Error(error.message);
  const row = (data ?? [])[0] as DropRateSummary | undefined;
  return row ?? { dials: 0, human_answers: 0, dropped: 0, drop_rate_pct: 0 };
}

export interface AnswerRateHeatmapCell {
  /** 0=Sunday..6=Saturday (Postgres extract(dow)), in the CONTACT's own local time. */
  weekday: number;
  /** 0-23, in the CONTACT's own local time. */
  hour: number;
  dials: number;
  human_answers: number;
}

export async function getAnswerRateHeatmap(
  campaignId: string | null,
  start: Date,
  end: Date
): Promise<AnswerRateHeatmapCell[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('answer_rate_heatmap', {
    p_org: orgId,
    p_campaign_id: campaignId,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as AnswerRateHeatmapCell[];
}

export interface ConnectRateByNumberRow {
  /** Null = legs dialed via the legacy campaigns.caller_id_number_id path (pre-number-pool),
   *  never dropped from the result -- render this row's label as "Campaign default". */
  from_number_id: string | null;
  phone_number: string | null;
  dials: number;
  human_answers: number;
}

/** Owner/admin only -- number health is an org-wide concern, not a personal metric (the RPC
 *  itself refuses an agent entirely, same reasoning as team_daily_stats). */
export async function getConnectRateByNumber(
  start: Date,
  end: Date
): Promise<ConnectRateByNumberRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('connect_rate_by_number', {
    p_org: orgId,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ConnectRateByNumberRow[];
}

export interface ConnectRateByHourRow {
  /** 0-23, SERVER (UTC) time -- matches this app's own established UTC-bucketing convention for
   *  every other chart (.brain/domains/analytics.md), deliberately NOT contact-local like the
   *  heatmap above. */
  hour: number;
  dials: number;
  human_answers: number;
}

/** Owner/admin only, same reasoning as getConnectRateByNumber. */
export async function getConnectRateByHour(
  start: Date,
  end: Date
): Promise<ConnectRateByHourRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('connect_rate_by_hour', {
    p_org: orgId,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as ConnectRateByHourRow[];
}

export type CoachingMode = 'listen' | 'whisper' | 'barge';

export class CoachingActionError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'CoachingActionError';
    this.code = code;
  }
}

/** TASK-T3: dials the CALLING manager's own WebRTC credential (useTelnyxCall.ts auto-answers it
 *  -- see its own header comment) into `targetUserId`'s live conference as a Telnyx supervisor.
 *  Owner/admin only, enforced server-side; `targetUserId` must currently be `on_call` or this
 *  409s with `TARGET_NOT_ON_CALL` (Team.tsx's live board already shows who qualifies). */
export async function startCoaching(
  targetUserId: string,
  mode: CoachingMode
): Promise<{ coachingId: string; mode: CoachingMode }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-coaching`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ action: 'start', targetUserId, mode }),
  });
  const data = await res.json();
  if (!res.ok) throw new CoachingActionError(data.error || 'Failed to start coaching', data.code);
  return data as { coachingId: string; mode: CoachingMode };
}

/** Switches an ALREADY-CONNECTED coaching leg's mode (e.g. Listen -> Whisper) without leaving and
 *  rejoining the target conference -- see coaching-core.ts's own header for the Telnyx command
 *  this maps to. `coachingId` is the id `startCoaching` returned. */
export async function switchCoachingMode(
  coachingId: string,
  mode: CoachingMode
): Promise<{ coachingId: string; mode: CoachingMode }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-coaching`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ action: 'switch_mode', coachingId, mode }),
  });
  const data = await res.json();
  if (!res.ok)
    throw new CoachingActionError(data.error || 'Failed to switch coaching mode', data.code);
  return data as { coachingId: string; mode: CoachingMode };
}

// ---------------------------------------------------------------------------
// TASK-T4: warm/cold transfer + hold (AUD-6 + NEW).
// ---------------------------------------------------------------------------

export class TransferActionError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'TransferActionError';
    this.code = code;
  }
}

async function callDialerTransfer(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-transfer`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new TransferActionError(data.error || 'Transfer action failed', data.code);
  return data;
}

/** Puts the PROSPECT (never the intern's own leg) on hold, in place, in the session's own
 *  conference -- Telnyx's hold is per-participant, so the intern hears nothing different.
 *  Idempotent: calling this while already held just returns the existing `heldAt`. */
export async function holdCall(sessionId: string): Promise<{ heldAt: string }> {
  const data = await callDialerTransfer({ action: 'hold', sessionId });
  return data as { heldAt: string };
}

export async function resumeCall(sessionId: string): Promise<{ heldAt: null }> {
  const data = await callDialerTransfer({ action: 'resume', sessionId });
  return data as { heldAt: null };
}

/** Dials the transfer target (an org member's WebRTC, or a plain E.164 number). Cold: the
 *  prospect moves to the target the instant it answers, no further action needed. Warm: the
 *  prospect is held while the INTERN talks to the target first -- `completeTransfer`/
 *  `cancelTransfer` are the only two ways a warm transfer resolves once `getDialerSession`'s own
 *  `activeTransfer.status` reads 'connected'. 409s with `TRANSFER_IN_PROGRESS` if the session
 *  already has one in flight. */
export async function startTransfer(args: {
  sessionId: string;
  type: 'cold' | 'warm';
  targetKind: 'member' | 'external';
  targetUserId?: string;
  targetNumber?: string;
}): Promise<{ transferId: string; status: 'dialing' }> {
  const data = await callDialerTransfer({ action: 'start', ...args });
  return data as { transferId: string; status: 'dialing' };
}

/** Warm transfer only, while `activeTransfer.status === 'connected'`: moves the prospect to the
 *  target and the intern back to their own main conference (empty, ready for the next contact).
 *  Ends the intern's own session for this contact (-> wrap_up). */
export async function completeTransfer(transferId: string): Promise<{ status: 'completed' }> {
  const data = await callDialerTransfer({ action: 'complete', transferId });
  return data as { status: 'completed' };
}

/** Warm transfer only: hangs up the target and returns the intern+prospect to exactly where they
 *  were -- the session stays on_call, unaffected. */
export async function cancelTransfer(transferId: string): Promise<{ status: 'cancelled' }> {
  const data = await callDialerTransfer({ action: 'cancel', transferId });
  return data as { status: 'cancelled' };
}

// --- TASK-T4 review fix-forward (BLOCKER 2): org_transfer_settings ---
// Same "straight client-side table read/write, RLS-enforced, no edge function" shape as
// getRecordingEnabled/setRecordingEnabled -- owner/admin write, every org member can read (an
// agent needs this to know whether TransferModal should show the external option at all; the
// server-side dialer-transfer/transfer-core.ts check is the one that actually matters, this is
// UX only). Defaults to false when the org has no row yet, matching the column's own default.

export async function getAllowExternalTransfers(): Promise<boolean> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_transfer_settings')
    .select('allow_external_transfers')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.allow_external_transfers ?? false;
}

export async function setAllowExternalTransfers(enabled: boolean): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.from('org_transfer_settings').upsert({
    org_id: orgId,
    allow_external_transfers: enabled,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

export interface UserPreferences {
  team_performance_range?: '7d' | '30d' | 'custom';
  custom_start?: string;
  custom_end?: string;
  /** MISSION-4 TASK-T7: wrap-up auto-resume delay in seconds. `0` = manual (pause, no timer,
   *  wait for the agent to click Resume/press Space); 5/10/15 = pause with a visible countdown
   *  that auto-resumes when it lapses. `undefined`/no row = the OLD behaviour: submit_disposition
   *  never pauses at all -- see the migration's own header comment for why NULL must stay
   *  distinct from 0. */
  auto_resume_seconds?: 0 | 5 | 10 | 15;
}

export async function getUserPreferences(): Promise<UserPreferences | null> {
  const { data, error } = await supabase
    .from('user_preferences')
    .select('team_performance_range, custom_start, custom_end, auto_resume_seconds')
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as UserPreferences | null;
}

export async function saveUserPreferences(userId: string, prefs: UserPreferences): Promise<void> {
  // MISSION-4 TASK-T7: this table now backs two independent features (Dashboard's date-range
  // prefs, this task's auto-resume delay) that each only ever pass THEIR OWN key(s). A blind
  // `field ?? null` on every column would silently null out whichever feature's field the OTHER
  // caller didn't mention. Only include a column when the caller's own object actually has that
  // key (`in`, not just a truthy check -- Dashboard intentionally passes `custom_start: undefined`
  // to CLEAR it, which must still take effect) so an upsert from one feature never touches the
  // other's already-saved value.
  const payload: Record<string, unknown> = {
    user_id: userId,
    updated_at: new Date().toISOString(),
  };
  if ('team_performance_range' in prefs) {
    payload.team_performance_range = prefs.team_performance_range ?? null;
  }
  if ('custom_start' in prefs) payload.custom_start = prefs.custom_start ?? null;
  if ('custom_end' in prefs) payload.custom_end = prefs.custom_end ?? null;
  if ('auto_resume_seconds' in prefs)
    payload.auto_resume_seconds = prefs.auto_resume_seconds ?? null;

  const { error } = await supabase
    .from('user_preferences')
    .upsert(payload, { onConflict: 'user_id' });
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
  status: 'active' | 'disabled' | 'removed';
  created_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  /** MISSION-4 TASK-T1 (GHL-8): this member's GHL user id, owner/admin-set. Null until mapped.
   *  Informational only -- the dialer's own queueing/assignment logic never reads it. */
  ghl_user_id: string | null;
  /** MISSION-5 TASK-M5-A3: set when status is 'removed'. */
  removed_at: string | null;
  /** MISSION-5 TASK-M5-A3: `restore` 403s past this instant (72h after removed_at); null unless
   *  status is 'removed'. */
  restorable_until: string | null;
}

/** MISSION-5 TASK-M5-A3: a 'removed' member is excluded by default ("hidden from the roster by
 *  default") -- pass `includeRemoved` for the Settings UI's own "Show removed" toggle, the only
 *  place that needs to see them (to offer Restore within the 72h window). */
export async function listOrgMembers(includeRemoved = false): Promise<OrgMember[]> {
  const url = new URL(`${getFunctionsUrl()}/org-members`);
  if (includeRemoved) url.searchParams.set('include_removed', 'true');
  const res = await fetch(url.toString(), {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to list team members');
  return (data.members ?? []) as OrgMember[];
}

async function orgMembersAction(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${getFunctionsUrl()}/org-members`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to update member');
  return data;
}

export const changeMemberRole = (userId: string, role: 'admin' | 'agent') =>
  orgMembersAction({ action: 'change_role', user_id: userId, role });
/** MISSION-5 TASK-M5-A3: halts new-batch dialing immediately (a live call is allowed to finish)
 *  and releases this member's assigned numbers back to the pool -- both server-side, part of the
 *  same request. */
export const disableMember = (userId: string) =>
  orgMembersAction({ action: 'disable', user_id: userId });
export const enableMember = (userId: string) =>
  orgMembersAction({ action: 'enable', user_id: userId });
/** MISSION-5 TASK-M5-A3: soft-remove (restorable for 72h via `restoreMember`) -- same
 *  session-halt + number-release cascade as `disableMember`. Does NOT release queued leads/
 *  callbacks; call `releaseQueuedLeads` separately (the offboarding wizard's own explicit step --
 *  callback reassignment isn't built yet, see `getOffboardPreview`'s own doc comment). */
export const removeMember = (userId: string) =>
  orgMembersAction({ action: 'remove', user_id: userId });
/** MISSION-5 TASK-M5-A3: 403s once `restorable_until` has passed. */
export const restoreMember = (userId: string) =>
  orgMembersAction({ action: 'restore', user_id: userId });
/** MISSION-4 TASK-T1 (GHL-8). Pass an empty string/null to clear the mapping. */
export const updateMemberGhlUserId = (userId: string, ghlUserId: string | null) =>
  orgMembersAction({ action: 'set_ghl_user_id', user_id: userId, ghl_user_id: ghlUserId });

// --- MISSION-5 TASK-M5-A3: offboarding wizard ---

export interface OffboardHeldLeads {
  campaign_id: string;
  campaign_name: string;
  queued_leads: number;
  callbacks: number;
}

export interface OffboardPreview {
  held_leads: OffboardHeldLeads[];
  numbers: { id: string; phone_number: string }[];
  campaigns: string[];
}

/** MISSION-5 TASK-M5-A3: "show what they held" -- read-only, safe to call before the admin has
 *  decided whether to disable or remove. `held_leads[].callbacks` has no reassignment action
 *  yet (B3's reassign RPC isn't built) -- the wizard shows the count but no button for it. */
export async function getOffboardPreview(userId: string): Promise<OffboardPreview> {
  const data = await orgMembersAction({ action: 'offboard_preview', user_id: userId });
  return data as unknown as OffboardPreview;
}

/** MISSION-5 TASK-M5-A3: releases this member's own QUEUED leads (not callbacks -- see
 *  `getOffboardPreview`'s doc comment) back to the pool, across every campaign they hold any in.
 *  A distinct step from disable/remove, callable independently (e.g. redistributing a still-
 *  active member's slice) -- returns how many leads were actually released. */
export async function releaseQueuedLeads(userId: string): Promise<number> {
  const data = await orgMembersAction({ action: 'release_queued_leads', user_id: userId });
  return (data.released as number) ?? 0;
}

// --- MISSION-5 TASK-A1: audit log ---

export interface AuditLogEntry {
  id: string;
  actorUserId: string | null;
  actorName: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogFilters {
  actor?: string;
  action?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}

export async function listAuditLog(
  filters: AuditLogFilters = {}
): Promise<{ entries: AuditLogEntry[]; total: number }> {
  const params = new URLSearchParams();
  if (filters.actor) params.set('actor', filters.actor);
  if (filters.action) params.set('action', filters.action);
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  params.set('limit', String(filters.limit ?? 50));
  params.set('offset', String(filters.offset ?? 0));

  const res = await fetch(`${getFunctionsUrl()}/org-audit-log?${params.toString()}`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to load activity');
  return data as { entries: AuditLogEntry[]; total: number };
}

/** The two client-only actions worth an audit row today -- both already gated behind an
 *  owner/admin-only route (Team, Analytics), so no separate role check happens client-side here;
 *  `org-audit-log`'s own `requireOrgRole` is the real enforcement. Best-effort: a rejected promise
 *  here is swallowed by the caller (the export itself already happened locally), never blocks the
 *  download the user just triggered. */
export async function logAuditEvent(
  name: 'export.team_csv' | 'export.analytics_csv',
  details?: Record<string, unknown>
): Promise<void> {
  const res = await fetch(`${getFunctionsUrl()}/org-audit-log`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ name, details }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.error('logAuditEvent failed:', data.error || res.statusText);
  }
}

// --- MISSION-5 TASK-A2: invites v2 (bulk create, pending list, resend/revoke) ---

export interface BulkInviteResult {
  email: string;
  status: 'sent' | 'already_member' | 'already_invited' | 'invalid';
  inviteId?: string;
  /** Only present for status 'sent' -- build the shareable link client-side (same shape as the
   *  pre-A2 single-invite flow), since this app has no email-sending infra of its own. */
  token?: string;
  expiresAt?: string;
}

export async function createOrgInvites(
  emails: string[],
  role: 'admin' | 'agent',
  campaignIds: string[] = []
): Promise<BulkInviteResult[]> {
  const res = await fetch(`${getFunctionsUrl()}/org-invite-create`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ action: 'create', emails, role, campaignIds }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to create invites');
  return (data.results ?? []) as BulkInviteResult[];
}

export interface OrgInvite {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'agent';
  invitedByName: string | null;
  campaignIds: string[];
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  createdAt: string;
  expiresAt: string;
}

export async function listOrgInvites(): Promise<OrgInvite[]> {
  const res = await fetch(`${getFunctionsUrl()}/org-invite-create`, {
    method: 'GET',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to list invites');
  return (data.invites ?? []) as OrgInvite[];
}

export async function resendOrgInvite(inviteId: string): Promise<BulkInviteResult> {
  const res = await fetch(`${getFunctionsUrl()}/org-invite-create`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ action: 'resend', inviteId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to resend invite');
  return { email: '', status: 'sent', ...data } as BulkInviteResult;
}

export async function revokeOrgInvite(inviteId: string): Promise<void> {
  const res = await fetch(`${getFunctionsUrl()}/org-invite-create`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ action: 'revoke', inviteId }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to revoke invite');
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
  /** TASK-T1 (GHL-3): the contact's pipeline stage NAME, resolved at pull time. Null unless it
   *  was ever pulled by a stage-mode mapping (a tag-only pull never has a stage to resolve). */
  ghl_pipeline_stage: string | null;
  /** TASK-T1 (GHL-6): mapped custom-field values with no dedicated column (license_number,
   *  service_zips, tier, list_source, ...) -- see api.ts's own GhlFieldMapping docs. */
  ghl_custom_fields: Record<string, unknown> | null;
  /** TASK-T1 (GHL-8): the org member this contact's GHL `assignedTo` resolved to (via that
   *  member's own `ghl_user_id`, Team page). Informational only -- the dialer's own queueing
   *  never reads this column. */
  assigned_user_id: string | null;
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
  /** MISSION-4 TASK-T5 (CRD-4, NO AI): owner/admin-edited in Campaign settings, shown collapsible
   *  on the connected-call card. Both null until an admin sets them -- no default script/pitch is
   *  invented for a campaign that hasn't configured one. */
  script_text: string | null;
  objection_sheet_text: string | null;
  /** MISSION-4 TASK-S2 (part 1): opt-in (default false) allowing `lines` up to 10 instead of 7.
   *  The DB's own `campaigns_lines_check` makes "lines > 7 with this false" impossible -- see
   *  20260926070005's header. A periodic drop-rate check auto-reduces `lines` back to 7 AND
   *  flips this back to false if the campaign's T8 drop rate goes over 3%; a human must
   *  re-enable it after reviewing why. */
  high_lines_guard_enabled: boolean;
  /** When the guard last auto-reduced this campaign back to 7 lines, if ever. Purely
   *  observational history -- never cleared automatically. */
  high_lines_guard_last_triggered_at: string | null;
  /** The drop rate (0-100) observed at the moment the guard last tripped. Paired with
   *  high_lines_guard_last_triggered_at. */
  high_lines_guard_last_drop_rate_pct: number | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignWithStats extends Campaign {
  total_contacts: number;
  queued: number;
  completed: number;
  passthrough: number;
}

export type CampaignLeadPriority = 'low' | 'normal' | 'high';

export interface CampaignLead {
  id: string;
  campaign_id: string;
  contact_id: string;
  status: 'queued' | 'passthrough' | 'completed' | 'removed';
  priority: CampaignLeadPriority;
  assigned_agent_id: string | null;
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
  /** 1-7 always allowed; 8-10 only when high_lines_guard_enabled is also true (in this same
   *  update, or already set) -- the DB's campaigns_lines_check rejects the update otherwise. */
  lines?: number;
  amd_mode?: 'off' | 'detect' | 'detect_words' | 'premium';
  /** MISSION-4 TASK-S2 (part 1). See Campaign.high_lines_guard_enabled. */
  high_lines_guard_enabled?: boolean;
  /** TASK-F-T3 (VMD-4). */
  voicemail_drop_mode?: 'first_attempt' | 'every_attempt' | 'never';
  caller_id_number_id?: string | null;
  max_attempts?: number;
  retry_interval_minutes?: number;
  calling_window_start?: string;
  calling_window_end?: string;
  abandon_message_enabled?: boolean;
  /** MISSION-4 TASK-T5 (CRD-4). */
  script_text?: string | null;
  objection_sheet_text?: string | null;
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
    .select('id, campaign_id, contact_id, status, priority, assigned_agent_id, added_at')
    .eq('campaign_id', campaignId)
    .order('added_at', { ascending: false });
  if (leadsError) throw new Error(leadsError.message);
  const leads = (leadsData ?? []) as {
    id: string;
    campaign_id: string;
    contact_id: string;
    status: string;
    priority: string;
    assigned_agent_id: string | null;
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
      status: l.status as 'queued' | 'passthrough' | 'completed' | 'removed',
      priority: l.priority as CampaignLeadPriority,
      assigned_agent_id: l.assigned_agent_id,
      added_at: l.added_at,
      contact: contactsMap.get(l.contact_id)!,
    }))
    .filter((cl) => cl.contact);
}

/** TASK-T6 (ADM-4): bulk-assigns (or, with `agentId: null`, unassigns) the target lead set
 *  computed by `filter` -- eager materialization onto `campaign_leads.assigned_agent_id`, not an
 *  abstract rule evaluated later at claim time. Re-running with a different agent/filter
 *  reassigns mid-day; each call is independent and idempotent. Owner/admin only (checked inside
 *  the function). Returns how many leads were actually touched. */
export type AssignLeadsFilter =
  | { mode: 'all' }
  | { mode: 'range'; start: number; end: number }
  | { mode: 'percentage'; percentage: number }
  | { mode: 'tag'; tag: string }
  /** MISSION-5 TASK-M5-B3: everything currently on `from_agent_id` (queued OR callback --
   *  the only mode that also touches callbacks) moves to `agentId` (or the pool, `agentId:
   *  null`). Safe under a concurrent claim: the RPC re-checks each row's own `status` at
   *  UPDATE time, not just at candidate-selection time. */
  | { mode: 'by_current_agent'; from_agent_id: string };

export async function assignCampaignLeads(
  campaignId: string,
  agentId: string | null,
  filter: AssignLeadsFilter
): Promise<number> {
  const { data, error } = await supabase.rpc('assign_campaign_leads', {
    p_campaign_id: campaignId,
    p_agent_id: agentId,
    p_filter: filter,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

/** TASK-T6: a plain column update through the EXISTING owner/admin-only RLS policy on
 *  campaign_leads (20260924000300) -- no new RPC, same "a simple settings toggle is fine" shape
 *  as campaign retry rules/recording settings. */
export async function setCampaignLeadPriority(
  leadId: string,
  priority: CampaignLeadPriority
): Promise<void> {
  const { error } = await supabase
    .from('campaign_leads')
    .update({ priority, updated_at: new Date().toISOString() })
    .eq('id', leadId);
  if (error) throw new Error(error.message);
}

/** TASK-T6: "Skip lead (not dialed now; it keeps its place/attempt)" -- pushes `next_attempt_at`
 *  forward so claim_next_leads passes over it for a while, WITHOUT touching `attempts` or
 *  `position` (that's what "keeps its place/attempt" means literally: neither column is
 *  written). Same owner/admin-only RLS policy, no new RPC. */
const SKIP_LEAD_DELAY_MINUTES = 15;

export async function skipCampaignLead(leadId: string): Promise<void> {
  const nextAttemptAt = new Date(Date.now() + SKIP_LEAD_DELAY_MINUTES * 60_000).toISOString();
  const { error } = await supabase
    .from('campaign_leads')
    .update({ next_attempt_at: nextAttemptAt, updated_at: new Date().toISOString() })
    .eq('id', leadId);
  if (error) throw new Error(error.message);
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

/** TASK-T6 review fix-forward: used to be a hard `.delete()` -- contradicted this task's own
 *  "Remove from campaign (terminal status)" ask and silently destroyed the lead's own attempts/
 *  history (`call_legs.lead_id` is `on delete set null`, so the leg survives but its link to the
 *  lead does not). Now a plain status flip, same "the row stays, only its status is terminal"
 *  shape every OTHER terminal outcome (completed/exhausted/dnc/passthrough) already uses. Note:
 *  re-adding a removed contact to the SAME campaign via `addLeadsToCampaign` will NOT revive this
 *  row (its own upsert is `ignoreDuplicates: true` / `ON CONFLICT DO NOTHING`) -- pre-existing
 *  behavior, identical to re-adding an already-completed/exhausted/dnc contact today; out of this
 *  task's own scope to change. */
export async function removeLeadFromCampaign(campaignId: string, contactId: string): Promise<void> {
  const { error } = await supabase
    .from('campaign_leads')
    .update({ status: 'removed', updated_at: new Date().toISOString() })
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
    .update({ status: 'removed', updated_at: new Date().toISOString() })
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
   *  the session has moved on. Known values: 'no_numbers_available', (MISSION-4 TASK-T7)
   *  'post_wrapup' -- set by submit_disposition when the agent has an auto-resume preference
   *  configured (see the migration's own header comment) -- (MISSION-5 TASK-M5-B3)
   *  'daily_dial_cap_reached', and (TASK-M5-B1) whatever an org's own
   *  `org_pause_reason_settings.reasons` list holds, from a manual pause via the Dialer's own
   *  picker. */
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
  /** TASK-T4 (AUD-6 + warm/cold transfer): set while this leg is held (silent) in whichever
   *  Telnyx conference it currently sits in. Drives the UI's "On hold mm:ss" timer. */
  held_at: string | null;
  /** TASK-T4: set once this leg's call was cold/warm transferred away -- an org member's user
   *  id, or an E.164 number, depending on `transfer_type`'s own target kind. */
  transferred_to: string | null;
  transfer_type: 'cold' | 'warm' | null;
  /** MISSION-4 TASK-T8: null until `maybeStartRecording` first starts recording this leg (or
   *  recording is disabled for the org). Drives the live "Pause/Resume recording" button --
   *  only 'recording'/'paused' are actionable states for it. */
  recording_status:
    'recording' | 'paused' | 'saved' | 'download_failed' | 'recording_failed' | 'deleted' | null;
  /** TASK-T5 (CRD-1): widened for the connected-call card's business-details panel.
   *  license_number/service_zips/tier live inside `ghl_custom_fields`, keyed by our own
   *  target-key names (not a GHL field id) -- read directly, e.g.
   *  `contact.ghl_custom_fields?.license_number`. */
  contact: {
    id: string;
    business_name: string | null;
    first_name: string | null;
    last_name: string | null;
    phone_number: string | null;
    rating: number | null;
    review_count: number | null;
    website: string | null;
    owner_contact: string | null;
    ghl_custom_fields: Record<string, string> | null;
  } | null;
}

/** TASK-T5 (CRD-3): one past attempt at this contact, oldest-safe subset of `call_legs` --
 *  `getDialerSession`'s own `history` map is keyed by `contact_id`, capped at the 3 most recent
 *  per contact (same convention `contact_disposition_history`, DSP-9, already established). */
export interface ContactHistoryEntry {
  legId: string;
  createdAt: string;
  outcome: CallLegOutcome | null;
  dispositionLabel: string | null;
  durationSeconds: number | null;
  notes: string | null;
  isVoicemail: boolean;
  hasRecording: boolean;
  callbackAt: string | null;
}

/** TASK-T5 (CRD-4, card-side): the connected call's own campaign script/objection sheet
 *  (T5a's `campaigns.script_text`/`objection_sheet_text`). Null fields render as "not set". */
export interface CampaignScriptInfo {
  scriptText: string | null;
  objectionSheetText: string | null;
}

/** TASK-T4: mirrors `call_transfers` -- at most one can ever be active per session
 *  (call_transfers_one_active_per_session), so `getDialerSession`'s own `activeTransfer` field is
 *  a single row or null, never an array. */
export interface ActiveTransfer {
  id: string;
  type: 'cold' | 'warm';
  target_kind: 'member' | 'external';
  target_user_id: string | null;
  target_number: string | null;
  status: 'dialing' | 'connected';
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

/** TASK-SP2: a low balance never blocks Go Ready anymore -- when the org's balance is below its
 *  own `low_balance_alert_usd` threshold, the session still starts and this non-blocking warning
 *  rides along in the same 200 response instead. */
export interface SpendWarning {
  code: 'LOW_BALANCE';
  message: string;
}

export async function startDialerSession(args: {
  campaignId: string;
  /** Overrides the campaign's own default `lines` (1-7, or 1-10 with the campaign's high-lines
   *  drop-rate guard enabled -- MISSION-4 TASK-S2) for this session only. */
  lines?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  /** Overrides the campaign's own default `amd_mode` for this session only. */
  amdMode?: 'off' | 'detect' | 'detect_words' | 'premium';
}): Promise<{ sessionId: string; warning?: SpendWarning }> {
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
    warning?: SpendWarning;
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
  return data as { sessionId: string; warning?: SpendWarning };
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

/** MISSION-5 TASK-M5-B1: `reason` is optional so every existing caller keeps working unchanged --
 *  the endpoint itself defaults to 'Other' server-side when omitted. */
export async function pauseDialerSession(
  sessionId: string,
  reason?: string
): Promise<{ status: 'paused' }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-pause`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ sessionId, reason }),
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

/** MISSION-4 TASK-T8: pauses/resumes the currently-recording winner leg's own recording during a
 *  live call -- the intern-facing "Pause/Resume recording" button. */
async function setSessionRecordingPaused(sessionId: string, paused: boolean): Promise<void> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-recording`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ sessionId, action: paused ? 'pause' : 'resume' }),
  });
  const data = (await res.json()) as { error?: string };
  if (!res.ok) {
    throw new Error(data.error || `Failed to ${paused ? 'pause' : 'resume'} recording`);
  }
}

export async function pauseSessionRecording(sessionId: string): Promise<void> {
  await setSessionRecordingPaused(sessionId, true);
}

export async function resumeSessionRecording(sessionId: string): Promise<void> {
  await setSessionRecordingPaused(sessionId, false);
}

export async function getDialerSession(sessionId: string): Promise<{
  session: DialSessionRecord;
  legs: CallLegRecord[];
  inboundCall: InboundCallInfo | null;
  /** TASK-T3: 'whisper'/'barge' only (never 'listen', enforced server-side, not just here) --
   *  a manager currently coaching this session as a Telnyx supervisor the intern can HEAR (a
   *  plain 'listen' is deliberately silent -- see coaching-core.ts's own header). Drives
   *  DialerStateBanner's "Manager listening" indicator. */
  coachingMode: 'whisper' | 'barge' | null;
  /** TASK-T4: the session's own in-flight warm/cold transfer, if any -- drives the Transfer
   *  control panel (Complete/Cancel for a 'connected' warm transfer; a "Dialing…" state for
   *  either kind still ringing). Null once a transfer resolves (completed/cancelled/failed). */
  activeTransfer: ActiveTransfer | null;
  /** TASK-T5 (CRD-3 + CRD-5): the WHOLE current batch's contact history, pre-loaded in one
   *  batched query -- keyed by `contact_id`, capped at 3 most-recent attempts each. */
  history: Record<string, ContactHistoryEntry[]>;
  /** TASK-T5 (CRD-4): the connected call's own campaign script/objection sheet, if the campaign
   *  has one set. Null campaign lookup (should never happen) degrades to null, not an error. */
  campaignScript: CampaignScriptInfo | null;
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
    coachingMode: 'whisper' | 'barge' | null;
    activeTransfer: ActiveTransfer | null;
    history: Record<string, ContactHistoryEntry[]>;
    campaignScript: CampaignScriptInfo | null;
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
  /** TASK-T1 (GHL-5): the 5-minute scheduled pull, disabled by default. */
  ghl_pull_enabled: boolean;
  ghl_last_pull_at: string | null;
  ghl_last_pull_status: 'ok' | 'error' | null;
  ghl_last_pull_counts: { created: number; updated: number; mappings: unknown[] } | null;
  /** TASK-T1 (GHL-6): target key -> GHL custom-field-definition id, e.g.
   *  `{business_name: "abc123", license_number: "def456"}`. `{}` until configured. */
  ghl_field_mapping: Record<string, string>;
}

/** Reads the safe `org_integrations_status` view -- never the base table, which has no client policies at all. */
export async function getGhlIntegrationStatus(): Promise<GhlIntegrationStatus | null> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_integrations_status')
    .select(
      'status, location_id, connected_at, ghl_dnc_tags, ghl_paused_tags, ghl_pull_enabled, ghl_last_pull_at, ghl_last_pull_status, ghl_last_pull_counts, ghl_field_mapping'
    )
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

// --- GHL pull settings + field mapping (MISSION-4 TASK-T1, GHL-5/6) ---

/** Owner/admin only. `pullEnabled` toggles the 5-minute scheduled pull; `fieldMapping` replaces
 *  it wholesale (target key -> GHL custom-field-definition id), same "always submit the whole
 *  thing" convention as updateGhlBlockedTags. */
export async function updateGhlPullSettings(
  pullEnabled: boolean,
  fieldMapping: Record<string, string>
): Promise<{ pullEnabled: boolean; fieldMapping: Record<string, string> }> {
  const res = await fetch(`${getFunctionsUrl()}/ghl-update-pull-settings`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ pullEnabled, fieldMapping }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update GHL pull settings');
  return data;
}

export interface GhlFieldSuggestions {
  fields: { id: string; name: string }[];
  suggestedMapping: Record<string, string>;
  currentMapping: Record<string, string>;
}

/** Owner/admin only. Fetches the connected location's real GHL custom field definitions and a
 *  suggested mapping for any target key the org hasn't already configured (name-matched --
 *  "business name", "website", etc). Read-only; call updateGhlPullSettings to save. */
export async function getGhlFieldSuggestions(): Promise<GhlFieldSuggestions> {
  const res = await fetch(`${getFunctionsUrl()}/ghl-field-suggestions`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to fetch GHL field suggestions');
  return data as GhlFieldSuggestions;
}

// --- GHL tag/stage -> campaign mappings (MISSION-4 TASK-T1, GHL-4) ---

export interface GhlCampaignMapping {
  id: string;
  match_type: 'tag' | 'stage';
  tag: string | null;
  pipeline_id: string | null;
  pipeline_stage_id: string | null;
  campaign_id: string;
  created_at: string;
}

/** Direct RLS read (org member) -- org_ghl_campaign_mappings has real client policies, same
 *  shape as campaigns/campaign_retry_rules, unlike org_integrations. */
export async function listGhlCampaignMappings(): Promise<GhlCampaignMapping[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_ghl_campaign_mappings')
    .select('id, match_type, tag, pipeline_id, pipeline_stage_id, campaign_id, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as GhlCampaignMapping[];
}

export async function createGhlTagCampaignMapping(
  tag: string,
  campaignId: string
): Promise<GhlCampaignMapping> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_ghl_campaign_mappings')
    .insert({ org_id: orgId, match_type: 'tag', tag, campaign_id: campaignId })
    .select('id, match_type, tag, pipeline_id, pipeline_stage_id, campaign_id, created_at')
    .single();
  if (error) throw new Error(error.message);
  return data as GhlCampaignMapping;
}

export async function createGhlStageCampaignMapping(
  pipelineId: string,
  pipelineStageId: string,
  campaignId: string
): Promise<GhlCampaignMapping> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_ghl_campaign_mappings')
    .insert({
      org_id: orgId,
      match_type: 'stage',
      pipeline_id: pipelineId,
      pipeline_stage_id: pipelineStageId,
      campaign_id: campaignId,
    })
    .select('id, match_type, tag, pipeline_id, pipeline_stage_id, campaign_id, created_at')
    .single();
  if (error) throw new Error(error.message);
  return data as GhlCampaignMapping;
}

export async function deleteGhlCampaignMapping(id: string): Promise<void> {
  const { error } = await supabase.from('org_ghl_campaign_mappings').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

// --- GHL pipelines (MISSION-4 TASK-T1, GHL-4) -- for the stage-mapping picker ---

export interface GhlPipelineStageOption {
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
}

/** Owner/admin only. Lists every pipeline/stage in the connected location, flattened for a
 *  single-level <select> (Settings -> Integrations -> GHL, "Add stage mapping"). */
export async function listGhlPipelineStages(): Promise<GhlPipelineStageOption[]> {
  const res = await fetch(`${getFunctionsUrl()}/ghl-list-pipelines`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to fetch GHL pipelines');
  return (data.stages ?? []) as GhlPipelineStageOption[];
}

// --- GHL sync now (MISSION-4 TASK-T1, GHL-5) ---

export interface GhlSyncNowResult {
  created: number;
  updated: number;
  mappings: { mappingId: string; created: number; updated: number; error?: string }[];
}

/** Owner/admin only. Runs every configured tag/stage -> campaign mapping right now, regardless
 *  of whether the 5-minute auto-pull is enabled -- the Campaigns page's "Sync now" button. */
export async function syncGhlNow(): Promise<GhlSyncNowResult> {
  const res = await fetch(`${getFunctionsUrl()}/ghl-sync-now`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to sync with GHL');
  return data as GhlSyncNowResult;
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
  /** MISSION-4 TASK-T2 (GHL-12): "the pipeline stage moves with the outcome ... unmapped = no
   *  move" -- both null (the default) means this disposition never moves anything. Set as a
   *  pair (either both null or both set) by the Settings editor. */
  ghl_pipeline_id: string | null;
  ghl_pipeline_stage_id: string | null;
}

/** Every org's dispositions (including inactive ones -- the Settings editor lists both; the
 *  wrap-up form filters to active=true itself). RLS scopes this to the caller's own org
 *  regardless of the explicit .eq below (belt and suspenders, same as listCrmSyncJobs). */
export async function listDispositions(): Promise<Disposition[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('dispositions')
    .select(
      'id, org_id, key, label, lead_effect, ghl_tag, creates_task, sort, active, is_win, required_fields, ghl_pipeline_id, ghl_pipeline_stage_id'
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
      'id, org_id, key, label, lead_effect, ghl_tag, creates_task, sort, active, is_win, required_fields, ghl_pipeline_id, ghl_pipeline_stage_id'
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
  /** MISSION-4 TASK-T2 (GHL-12) -- always set together (both null clears the mapping). */
  ghl_pipeline_id?: string | null;
  ghl_pipeline_stage_id?: string | null;
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

// --- MISSION-4 TASK-T8 (compliance): recording consent notice. Same owner/admin-RLS-enforced,
// plain-table read/write shape as getRecordingEnabled/setRecordingEnabled above. ---

export type AnnounceRecordingMode = 'never' | 'all' | 'all_party_consent_states';

export interface RecordingConsentSettings {
  announceRecordingMode: AnnounceRecordingMode;
  allPartyConsentStates: string[];
}

const DEFAULT_ALL_PARTY_CONSENT_STATES = [
  'CA',
  'CT',
  'FL',
  'IL',
  'MD',
  'MA',
  'MT',
  'NH',
  'PA',
  'WA',
  'NV',
  'OR',
  'DE',
  'MI',
];

export async function getRecordingConsentSettings(): Promise<RecordingConsentSettings> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_recording_settings')
    .select('announce_recording_mode, all_party_consent_states')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    announceRecordingMode:
      (data?.announce_recording_mode as AnnounceRecordingMode | undefined) ?? 'never',
    allPartyConsentStates: data?.all_party_consent_states ?? DEFAULT_ALL_PARTY_CONSENT_STATES,
  };
}

export async function setRecordingConsentSettings(
  settings: RecordingConsentSettings
): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.from('org_recording_settings').upsert({
    org_id: orgId,
    announce_recording_mode: settings.announceRecordingMode,
    all_party_consent_states: settings.allPartyConsentStates,
    updated_at: new Date().toISOString(),
  });
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

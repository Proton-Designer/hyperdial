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

/** MISSION-5 TASK-M5-B4: the signed-in user's own id -- Settings.tsx's notification-preferences
 *  card defaults its member picker to "myself" rather than forcing an owner/admin to find their
 *  own row in the list first. */
export async function getCurrentUserId(): Promise<string> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  return user.id;
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
  /** MISSION-5 TASK-M5-A4: today's own legs whose disposition.lead_effect = 'callback'. */
  callbacksToday: number;
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

export type TeamMemberRole = 'owner' | 'admin' | 'agent' | 'manager';

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
  /** MISSION-5 TASK-M5-E13: sum over this agent's dial_sessions of `lines * clipped_session_hours`
   *  -- dial_sessions.lines is fixed for a session's whole life (verified, see
   *  audit/M5-E13/notes.md), so this is an exact sum, not an approximation. */
  line_hours: number;
  /** Null when line_hours < 0.1 for this agent in range -- same floor as conversations_per_hr. */
  conversations_per_line_hour: number | null;
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
  /** MISSION-5 TASK-M5-A4: the current session's campaign (null while offline) -- backs the
   *  live board's "filter by campaign". */
  campaign_id: string | null;
  campaign_name: string | null;
  /** MISSION-5 TASK-M5-A5: this agent's roster pod (null if unassigned) -- backs the live
   *  board's "filter by pod". */
  pod_id: string | null;
  pod_name: string | null;
  /** MISSION-5 TASK-M5-B2: this agent's CURRENT session id (null while offline) -- lets the
   *  live board call the existing sessionId-keyed remote-control endpoints
   *  (pauseDialerSession/stopDialerSession/hangupLiveCall) against a REMOTE target, all three of
   *  which already permit owner/admin to act on any org session. */
  session_id: string | null;
  /** MISSION-5 TASK-M5-B2: the agent's own "raise hand" button -- non-null means still raised.
   *  Auto-clears server-side the moment the call ends or a manager starts coaching this agent. */
  raised_hand_at: string | null;
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

/** MISSION-5 TASK-M5-A4 follow-up: "first activity" (a literal clock time) per agent/day --
 *  `agent_time_in_state` aggregates away individual event start times, so this is a sibling RPC,
 *  same `p_agent` narrowing and `p_tz` default. Gate: owner/admin/pod-scoped-manager/agent-self-
 *  view, mirroring `agent_time_in_state`'s own current (post-A5) widened gate, not the original
 *  owner/admin-only one (see `a7f3b65`). Backs the Attendance tab's "First activity" column. */
export interface AgentFirstActivityRow {
  agent_id: string;
  day: string;
  first_started_at: string;
}

export async function getAgentFirstActivity(
  from: Date,
  to: Date,
  agentId?: string,
  tz?: string
): Promise<AgentFirstActivityRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('agent_first_activity', {
    p_org: orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_agent: agentId ?? null,
    p_tz: tz ?? 'America/Chicago',
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as AgentFirstActivityRow[];
}

/** MISSION-5 TASK-M5-A4: the org's real IANA timezone (default 'America/Chicago'), replacing
 *  every hardcoded America/Chicago 'today' boundary this codebase had (Team.tsx, team_live_board,
 *  dialing_hours_today, agent_daily_dial_status once wired). Same "org_<feature>_settings" shape
 *  as getOrgPauseReasons/updateOrgPauseReasons above -- select: any member; insert/update:
 *  owner/admin (RLS), no dedicated RPC needed. */
export async function getOrgTimezone(): Promise<string> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_timezone_settings')
    .select('timezone')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data?.timezone as string | undefined) ?? 'America/Chicago';
}

/** Owner/admin only -- enforced by org_timezone_settings' own RLS UPDATE policy. */
export async function updateOrgTimezone(timezone: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.from('org_timezone_settings').upsert({
    org_id: orgId,
    timezone,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** MISSION-5 TASK-M5-B4: the 4 supervisor-alert conditions this org has opted into, plus their
 *  editable thresholds. Same "org_<feature>_settings" select/upsert shape as getOrgTimezone/
 *  updateOrgTimezone above -- select: any member; insert/update: owner/admin (RLS). */
export type SupervisorAlertType = 'wrap_up_stuck' | 'paused_stuck' | 'call_stuck' | 'zero_connects';

export interface SupervisorAlertSettings {
  wrapUpAlertEnabled: boolean;
  wrapUpAlertMinutes: number;
  pausedAlertEnabled: boolean;
  pausedAlertMinutes: number;
  callAlertEnabled: boolean;
  callAlertMinutes: number;
  zeroConnectsAlertEnabled: boolean;
  zeroConnectsWindowMinutes: number;
}

const DEFAULT_SUPERVISOR_ALERT_SETTINGS: SupervisorAlertSettings = {
  wrapUpAlertEnabled: false,
  wrapUpAlertMinutes: 10,
  pausedAlertEnabled: false,
  pausedAlertMinutes: 15,
  callAlertEnabled: false,
  callAlertMinutes: 30,
  zeroConnectsAlertEnabled: false,
  zeroConnectsWindowMinutes: 30,
};

export async function getSupervisorAlertSettings(): Promise<SupervisorAlertSettings> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_supervisor_alert_settings')
    .select(
      'wrap_up_alert_enabled, wrap_up_alert_minutes, paused_alert_enabled, paused_alert_minutes, call_alert_enabled, call_alert_minutes, zero_connects_alert_enabled, zero_connects_window_minutes'
    )
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return DEFAULT_SUPERVISOR_ALERT_SETTINGS;
  return {
    wrapUpAlertEnabled: data.wrap_up_alert_enabled,
    wrapUpAlertMinutes: data.wrap_up_alert_minutes,
    pausedAlertEnabled: data.paused_alert_enabled,
    pausedAlertMinutes: data.paused_alert_minutes,
    callAlertEnabled: data.call_alert_enabled,
    callAlertMinutes: data.call_alert_minutes,
    zeroConnectsAlertEnabled: data.zero_connects_alert_enabled,
    zeroConnectsWindowMinutes: data.zero_connects_window_minutes,
  };
}

/** Owner/admin only -- enforced by org_supervisor_alert_settings' own RLS UPDATE policy. Partial:
 *  callers only ever send the fields the settings card actually changed. */
export async function updateSupervisorAlertSettings(
  patch: Partial<SupervisorAlertSettings>
): Promise<void> {
  const orgId = await getActiveOrgId();
  const row: Record<string, unknown> = { org_id: orgId, updated_at: new Date().toISOString() };
  if (patch.wrapUpAlertEnabled !== undefined) row.wrap_up_alert_enabled = patch.wrapUpAlertEnabled;
  if (patch.wrapUpAlertMinutes !== undefined) row.wrap_up_alert_minutes = patch.wrapUpAlertMinutes;
  if (patch.pausedAlertEnabled !== undefined) row.paused_alert_enabled = patch.pausedAlertEnabled;
  if (patch.pausedAlertMinutes !== undefined) row.paused_alert_minutes = patch.pausedAlertMinutes;
  if (patch.callAlertEnabled !== undefined) row.call_alert_enabled = patch.callAlertEnabled;
  if (patch.callAlertMinutes !== undefined) row.call_alert_minutes = patch.callAlertMinutes;
  if (patch.zeroConnectsAlertEnabled !== undefined)
    row.zero_connects_alert_enabled = patch.zeroConnectsAlertEnabled;
  if (patch.zeroConnectsWindowMinutes !== undefined)
    row.zero_connects_window_minutes = patch.zeroConnectsWindowMinutes;
  const { error } = await supabase.from('org_supervisor_alert_settings').upsert(row);
  if (error) throw new Error(error.message);
}

/** MISSION-5 TASK-M5-G5: the same per-(org, user, type) opt-out row B4 built for the 4 supervisor
 *  alerts also covers 'mention' (a contact-note @mention) -- the migration widened
 *  user_notification_preferences' own CHECK constraint rather than adding a second table. Kept as
 *  a separate type from `SupervisorAlertType` (not a union alias applied there) since
 *  `filterByNotificationPreference`'s TS-side callers (pod-scope.ts) are specifically about the 4
 *  supervisor conditions and never need to know 'mention' exists. */
export type NotificationPrefType = SupervisorAlertType | 'mention';

/** MISSION-5 TASK-M5-B4 (+ G5's 'mention'): per-user opt-out for the alert types above (in-app
 *  only). Absence of a row means on -- "defaults = everything on for owner/admin" (and, by the
 *  same absence-means-on rule, for a manager and an agent too, since 'mention' now needs the same
 *  default for every role, not just owner/admin). Self OR owner/admin (RLS). */
const NOTIFICATION_PREF_TYPES: NotificationPrefType[] = [
  'wrap_up_stuck',
  'paused_stuck',
  'call_stuck',
  'zero_connects',
  'mention',
];

export async function getUserNotificationPreferences(
  userId: string
): Promise<Record<NotificationPrefType, boolean>> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('user_notification_preferences')
    .select('alert_type, enabled')
    .eq('org_id', orgId)
    .eq('user_id', userId);
  if (error) throw new Error(error.message);
  const overrides = new Map(
    (data ?? []).map((r: { alert_type: string; enabled: boolean }) => [r.alert_type, r.enabled])
  );
  const result = {} as Record<NotificationPrefType, boolean>;
  for (const type of NOTIFICATION_PREF_TYPES) {
    result[type] = overrides.get(type) ?? true;
  }
  return result;
}

export async function setUserNotificationPreference(
  userId: string,
  alertType: NotificationPrefType,
  enabled: boolean
): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.from('user_notification_preferences').upsert({
    org_id: orgId,
    user_id: userId,
    alert_type: alertType,
    enabled,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new Error(error.message);
}

/** MISSION-5 TASK-M5-A6: the org-timezone "today" boundary, shared by every surface that needs
 *  it (Dashboard.tsx's My stats, Dialer.tsx's goal header) -- lifted out rather than duplicated a
 *  third time; Team.tsx keeps its own long-standing local copy of this same technique (A4) since
 *  it also needs Yesterday/7d/Custom, not just Today. A zone AHEAD of UTC (e.g. Asia/Tokyo) has
 *  its own local midnight on the PREVIOUS UTC calendar day, so this searches +/-16h in 15-min
 *  steps around UTC midnight rather than only forward from it (covers every real IANA offset,
 *  including the :30/:45 ones). */
function localMidnightUtc(tz: string, y: number, month: number, day: number): Date {
  const base = Date.UTC(y, month - 1, day, 0, 0, 0);
  const STEP_MS = 15 * 60 * 1000;
  for (let k = -64; k <= 64; k++) {
    const guess = new Date(base + k * STEP_MS);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(guess);
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    if (
      get('hour') === '00' &&
      get('minute') === '00' &&
      Number(get('year')) === y &&
      Number(get('month')) === month &&
      Number(get('day')) === day
    ) {
      return guess;
    }
  }
  return new Date(base); // unreachable for a real IANA zone (a +/-16h search always finds one)
}

/** [start of today, start of tomorrow) in `tz`. */
export function getTodayRange(tz: string): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get('year');
  const m = get('month');
  const day = get('day');
  const start = localMidnightUtc(tz, y, m, day);
  const tomorrow = new Date(Date.UTC(y, m - 1, day + 1));
  const end = localMidnightUtc(
    tz,
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate()
  );
  return { start, end };
}

/** MISSION-5 TASK-M5-A4: "My stats" self-view (Dashboard.tsx) -- the caller's OWN numbers for
 *  [start, end) plus a team_median_conversations_per_hr computed server-side across every active
 *  member for the SAME window. Callable by any org member for themselves; there is no agentId
 *  parameter (auth.uid() inside the RPC is the only identity used) -- no other agent's individual
 *  numbers or identity are ever returned by this RPC. */
export interface AgentSelfStats {
  dials: number;
  connects: number;
  connect_rate: number;
  conversations: number;
  conversations_per_hr: number | null;
  wins: number;
  callbacks_set: number;
  talk_time_seconds: number;
  dialing_hours: number;
  team_median_conversations_per_hr: number | null;
}

export async function getAgentSelfStats(start: Date, end: Date): Promise<AgentSelfStats | null> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('agent_self_stats', {
    p_org: orgId,
    p_start: start.toISOString(),
    p_end: end.toISOString(),
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as AgentSelfStats[];
  return rows[0] ?? null;
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

/** MISSION-5 TASK-M5-N1 (deferred backlog item): converts an ALREADY-active coaching attempt
 *  (`coachingId` from `startCoaching`) into a takeover -- the agent's own leg leaves the
 *  conference and hangs up, this supervisor becomes the only agent-side party with the prospect.
 *  Owner/admin, or a manager for an agent in their own pod scope; 403s with `TAKEOVER_DISABLED`
 *  if the org hasn't turned this on (`getCallTakeoverSettings`/`updateCallTakeoverSettings`
 *  below). `roleUpdateFailed: true` in the response means the agent leg was still detached
 *  correctly but promoting this supervisor's own conference role to `barge` failed -- the caller
 *  should suggest switching mode manually via `switchCoachingMode`. */
export async function takeoverCall(
  coachingId: string
): Promise<{ ok: true; roleUpdateFailed: boolean }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-coaching`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ action: 'takeover', coachingId }),
  });
  const data = await res.json();
  if (!res.ok)
    throw new CoachingActionError(data.error || 'Failed to take over the call', data.code);
  return data as { ok: true; roleUpdateFailed: boolean };
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
  /** MISSION-5 TASK-M5-B2: a click-through target -- e.g. the raise-hand notification's
   *  `{targetUserId, targetSessionId, action}`. Null for every notification type that predates
   *  this column and still doesn't set it. */
  data: Record<string, unknown> | null;
}

export async function listNotifications(): Promise<AppNotification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, title, body, created_at, read_at, data')
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
  role: 'owner' | 'admin' | 'agent' | 'manager';
  status: 'active' | 'disabled' | 'removed';
  created_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  /** MISSION-4 TASK-T1 (GHL-8): this member's GHL user id, owner/admin-set. Null until mapped.
   *  Informational only -- the dialer's own queueing/assignment logic never reads it. */
  ghl_user_id: string | null;
  /** MISSION-5 TASK-M5-A5: the single pod this member (agent or manager) belongs to on the
   *  roster -- distinct from a manager's own SCOPE (`getManagerPods`/`setManagerPods`). Null if
   *  unassigned. A manager caller only ever sees rows in their own managed pods (plus their own),
   *  server-filtered -- see org-members/index.ts's GET handler. */
  pod_id: string | null;
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

export const changeMemberRole = (userId: string, role: 'admin' | 'agent' | 'manager') =>
  orgMembersAction({ action: 'change_role', user_id: userId, role });
/** MISSION-5 TASK-M5-A3: halts new-batch dialing immediately (a live call is allowed to finish)
 *  and releases this member's assigned numbers back to the pool -- both server-side, part of the
 *  same request. */
export const disableMember = (userId: string) =>
  orgMembersAction({ action: 'disable', user_id: userId });
export const enableMember = (userId: string) =>
  orgMembersAction({ action: 'enable', user_id: userId });
/** MISSION-5 TASK-M5-A3: soft-remove (restorable for 72h via `restoreMember`) -- same
 *  session-halt + number-release cascade as `disableMember`. Does NOT release queued leads or
 *  reassign callbacks itself; the offboarding wizard calls `releaseQueuedLeads`/
 *  `assignCampaignLeads` (`by_current_agent` mode, MISSION-5 TASK-M5-B3) as separate, explicit
 *  steps. */
export const removeMember = (userId: string) =>
  orgMembersAction({ action: 'remove', user_id: userId });
/** MISSION-5 TASK-M5-A3: 403s once `restorable_until` has passed. */
export const restoreMember = (userId: string) =>
  orgMembersAction({ action: 'restore', user_id: userId });
/** MISSION-4 TASK-T1 (GHL-8). Pass an empty string/null to clear the mapping. */
export const updateMemberGhlUserId = (userId: string, ghlUserId: string | null) =>
  orgMembersAction({ action: 'set_ghl_user_id', user_id: userId, ghl_user_id: ghlUserId });

// --- MISSION-5 TASK-M5-A5: pods (Settings -> Team's pod management + a manager's scope) ---

export interface OrgPod {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
}

/** Any org member may list pods (org_pods' own RLS: `private.is_org_member`) -- the pod picker
 *  needs this for every role, not just owner/admin. */
export async function listOrgPods(): Promise<OrgPod[]> {
  const { data, error } = await supabase.from('org_pods').select('*').order('name');
  if (error) throw new Error(error.message);
  return (data ?? []) as OrgPod[];
}

export async function createOrgPod(name: string): Promise<OrgPod> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_pods')
    .insert({ org_id: orgId, name })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return data as OrgPod;
}

export async function renameOrgPod(podId: string, name: string): Promise<void> {
  const { error } = await supabase.from('org_pods').update({ name }).eq('id', podId);
  if (error) throw new Error(error.message);
}

/** A pod with members still assigned to it (org_members.pod_id) or in a manager's scope
 *  (org_manager_pods) is left dangling by design -- both are `on delete set null`/cascade at the
 *  DB level, never blocked here; the Settings UI warns before calling this if it knows the pod
 *  isn't empty. */
export async function deleteOrgPod(podId: string): Promise<void> {
  const { error } = await supabase.from('org_pods').delete().eq('id', podId);
  if (error) throw new Error(error.message);
}

/** Which single pod this member (agent or manager) belongs to on the roster -- owner/admin only
 *  (server-enforced in org-members/index.ts, this whole POST endpoint is owner/admin-gated).
 *  Pass null to clear. */
export const setMemberPod = (userId: string, podId: string | null) =>
  orgMembersAction({ action: 'set_pod', user_id: userId, pod_id: podId });

/** A manager's own scope: which pod(s) they may supervise (org_manager_pods, many-to-many --
 *  see the A5 migration header for why this is separate from `setMemberPod` above). Replaces the
 *  FULL set every call; only valid for a member whose role is already 'manager'. */
export const setManagerPods = (userId: string, podIds: string[]) =>
  orgMembersAction({ action: 'set_manager_pods', user_id: userId, pod_ids: podIds });

/** A manager's own pod scope, keyed by pod_id -- used both by Settings -> Team (to show/edit a
 *  manager's assigned pods) and by Team.tsx (so a manager's own client can label "your pods" on
 *  the live board/daily table without re-deriving it from the roster). Owner/admin can read
 *  every manager's scope; a manager can only read their own (org_manager_pods' own RLS). */
export async function getManagerPods(managerUserId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('org_manager_pods')
    .select('pod_id')
    .eq('manager_user_id', managerUserId);
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { pod_id: string }) => r.pod_id);
}

// --- MISSION-5 TASK-M5-A6: daily goals (org/pod/agent, most-specific-wins) ---

export type GoalMetric = 'dials' | 'conversations' | 'wins' | 'talk_minutes';
export type GoalScope = 'org' | 'pod' | 'agent';

export interface GoalTargets {
  dials_goal: number | null;
  conversations_goal: number | null;
  wins_goal: number | null;
  talk_minutes_goal: number | null;
}

/** The caller's OWN resolved daily targets (agent-level goal wins, else the caller's pod-level
 *  goal, else the org-level goal, independently per metric) -- backs Dashboard.tsx's My stats and
 *  Dialer.tsx's header progress bars. Any org member may call this for themselves; there is no
 *  agentId parameter, same self-view trust model as `getAgentSelfStats`. */
export async function getMyGoalTargets(): Promise<GoalTargets> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('my_goal_targets', { p_org: orgId });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as GoalTargets[];
  return (
    rows[0] ?? {
      dials_goal: null,
      conversations_goal: null,
      wins_goal: null,
      talk_minutes_goal: null,
    }
  );
}

export interface TeamGoalTargetsRow extends GoalTargets {
  agent_id: string;
}

/** Same resolution as `getMyGoalTargets`, per active pod-scoped agent -- owner/admin/manager
 *  only (server-enforced; a manager's rows are already filtered to their own supervised pods by
 *  the RPC, same pattern as `getTeamDailyStats`). Join with `getTeamDailyStats`'s actuals by
 *  `agent_id` client-side to render attainment on the Team page. */
export async function getTeamGoalTargets(): Promise<TeamGoalTargetsRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('team_goal_targets', { p_org: orgId });
  if (error) throw new Error(error.message);
  return (data ?? []) as TeamGoalTargetsRow[];
}

/** Sets (upserts) the standing daily target for one metric at one scope. Owner/admin may set any
 *  scope; a manager may only set 'pod' (their own supervised pod) or 'agent' (an agent inside
 *  their own supervised pods) -- never 'org'. Pass only the id the scope needs (podId for 'pod',
 *  agentUserId for 'agent', neither for 'org'); the RPC rejects any other combination. Returns the
 *  goal's id. */
export async function setOrgGoal(
  scope: GoalScope,
  metric: GoalMetric,
  target: number,
  podId?: string,
  agentUserId?: string
): Promise<string> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('set_org_goal', {
    p_org: orgId,
    p_scope: scope,
    p_pod_id: podId ?? null,
    p_agent_user_id: agentUserId ?? null,
    p_metric: metric,
    p_target: target,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Same owner/admin-any, manager-own-scope-only permission split as `setOrgGoal`, checked
 *  server-side against the goal's OWN scope/pod/agent (the RPC looks the row up itself). */
export async function deleteOrgGoal(goalId: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('delete_org_goal', { p_org: orgId, p_goal_id: goalId });
  if (error) throw new Error(error.message);
}

// --- MISSION-5 TASK-M5-A6: team broadcasts ---

export interface OrgBroadcast {
  id: string;
  message: string;
  pod_id: string | null;
  created_at: string;
  expires_at: string | null;
  created_by: string;
}

/** Every broadcast the caller can currently see (their own pod, or org-wide, not expired, not
 *  already dismissed by them) -- pre-filtered server-side so Dialer.tsx never has to reconstruct
 *  that visibility logic itself. Polled the same way `getTeamLiveBoard` is. `created_by` lets a
 *  manager-facing management list (TeamGoalsAndBroadcastPanel) tell "my own pod_id-null
 *  broadcast" (deletable) from "someone else's" (delete_org_broadcast rejects it) without a
 *  round-trip. */
export async function getActiveBroadcasts(): Promise<OrgBroadcast[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('active_org_broadcasts', { p_org: orgId });
  if (error) throw new Error(error.message);
  return (data ?? []) as OrgBroadcast[];
}

/** Owner/admin/manager only; a manager posting to a specific pod may only target a pod they
 *  supervise (server-enforced) -- 'everyone' (podId omitted) is open to all three roles. Returns
 *  the new broadcast's id. */
export async function createBroadcast(
  message: string,
  podId?: string,
  expiresAt?: Date
): Promise<string> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('create_org_broadcast', {
    p_org: orgId,
    p_pod_id: podId ?? null,
    p_message: message,
    p_expires_at: expiresAt ? expiresAt.toISOString() : null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

/** Only the poster or an owner/admin may remove a broadcast early (server-enforced). */
export async function deleteBroadcast(broadcastId: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('delete_org_broadcast', {
    p_org: orgId,
    p_broadcast_id: broadcastId,
  });
  if (error) throw new Error(error.message);
}

/** Plain client insert, not an RPC -- `org_broadcast_dismissals`' own RLS only lets a caller
 *  touch their OWN dismissal rows, so there is no privileged check to enforce server-side. */
export async function dismissBroadcast(broadcastId: string): Promise<void> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { error } = await supabase
    .from('org_broadcast_dismissals')
    .insert({ broadcast_id: broadcastId, user_id: user.id });
  if (error) throw new Error(error.message);
}

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
 *  decided whether to disable or remove. `held_leads[].callbacks` is reassigned via
 *  `assignCampaignLeads(campaignId, null, { mode: 'by_current_agent', from_agent_id: userId })`
 *  per campaign (MISSION-5 TASK-M5-B3's own new filter mode), wired into the offboarding wizard's
 *  "Reassign callbacks to the pool" button. */
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

/** The client-only actions worth an audit row today -- all already gated behind an
 *  owner/admin-only route (Team, Analytics), so no separate role check happens client-side here;
 *  `org-audit-log`'s own `requireOrgRole` is the real enforcement. Best-effort: a rejected promise
 *  here is swallowed by the caller (the export itself already happened locally), never blocks the
 *  download the user just triggered. */
export async function logAuditEvent(
  name: 'export.team_csv' | 'export.analytics_csv' | 'export.attendance_csv',
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
  role: 'admin' | 'agent' | 'manager',
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
  role: 'owner' | 'admin' | 'agent' | 'manager';
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
  role: 'owner' | 'admin' | 'agent' | 'manager' | null;
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

/** MISSION-5 TASK-M5-G5: one entry in a contact's notes thread. `canEdit`/`canDelete` are
 *  computed server-side (author within the 15-minute window, or owner/admin for delete) so the UI
 *  never has to re-derive the same "who may act on this row" logic the RPC already enforces. */
export interface ContactNote {
  id: string;
  authorUserId: string;
  authorName: string;
  /** True when the author's own org_members row is no longer 'active' (TASK-M5-A3) -- the note
   *  itself is untouched, only how the UI labels it ("(removed)"). */
  authorRemoved: boolean;
  body: string;
  mentionedUserIds: string[];
  createdAt: string;
  editedAt: string | null;
  canEdit: boolean;
  canDelete: boolean;
}

interface ContactNoteRow {
  id: string;
  author_user_id: string;
  author_name: string;
  author_removed: boolean;
  body: string;
  mentioned_user_ids: string[];
  created_at: string;
  edited_at: string | null;
  can_edit: boolean;
  can_delete: boolean;
}

function fromContactNoteRow(r: ContactNoteRow): ContactNote {
  return {
    id: r.id,
    authorUserId: r.author_user_id,
    authorName: r.author_name,
    authorRemoved: r.author_removed,
    body: r.body,
    mentionedUserIds: r.mentioned_user_ids ?? [],
    createdAt: r.created_at,
    editedAt: r.edited_at,
    canEdit: r.can_edit,
    canDelete: r.can_delete,
  };
}

/** Oldest first (a thread reads top-to-bottom). RLS mirrors contacts' own read policy (owner,
 *  admin, or an assigned agent) -- anyone who can read the contact can read its notes. */
export async function listContactNotes(contactId: string): Promise<ContactNote[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('list_contact_notes', {
    p_org: orgId,
    p_contact: contactId,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ContactNoteRow[]).map(fromContactNoteRow);
}

/** `mentionedUserIds`: every org member typed after an `@` in this note's text. The server
 *  silently drops any id that isn't an ACTIVE member of this contact's org (a stale suggestion is
 *  not an error) and sends one 'mention' in-app notification per surviving id, skipping the author
 *  themselves and anyone who has turned the 'mention' notification preference off. */
export async function addContactNote(
  contactId: string,
  body: string,
  mentionedUserIds: string[] = []
): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('add_contact_note', {
    p_org: orgId,
    p_contact: contactId,
    p_body: body,
    p_mentioned_user_ids: mentionedUserIds,
  });
  if (error) throw new Error(error.message);
}

/** Author only, and only within 15 minutes of posting (server-enforced -- the 400 the RPC raises
 *  past that window is surfaced as-is via the thrown Error's message). */
export async function editContactNote(noteId: string, body: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('edit_contact_note', {
    p_org: orgId,
    p_note_id: noteId,
    p_body: body,
  });
  if (error) throw new Error(error.message);
}

/** Author within 15 minutes, or owner/admin at any time (server-enforced). Soft-delete --
 *  the row stays but is filtered out of list_contact_notes from this point on. */
export async function deleteContactNote(noteId: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('delete_contact_note', {
    p_org: orgId,
    p_note_id: noteId,
  });
  if (error) throw new Error(error.message);
}

/** MISSION-5 TASK-M5-G5: one contact_change_history row -- every TRACKED field (owner/assigned
 *  agent, status, DNC, phone, name, tags) that changed together in ONE update, batched into a
 *  single `changes` map keyed by field name -- never one row per field. `source` distinguishes a
 *  real end-user edit ('user') from a bulk importer's service-role write ('import', `changedBy`
 *  null -- shown as "Imported"). */
export interface ContactChangeHistoryEntry {
  id: string;
  changedBy: string | null;
  changedByName: string | null;
  changedByRemoved: boolean;
  source: 'user' | 'import';
  changes: Record<string, { old: unknown; new: unknown }>;
  createdAt: string;
}

interface ContactChangeHistoryRow {
  id: string;
  changed_by: string | null;
  changed_by_name: string | null;
  changed_by_removed: boolean;
  source: 'user' | 'import';
  changes: Record<string, { old: unknown; new: unknown }>;
  created_at: string;
}

/** Newest first. RLS mirrors contacts' own read policy, same as listContactNotes above. */
export async function listContactChangeHistory(
  contactId: string
): Promise<ContactChangeHistoryEntry[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('list_contact_change_history', {
    p_org: orgId,
    p_contact: contactId,
  });
  if (error) throw new Error(error.message);
  return ((data ?? []) as ContactChangeHistoryRow[]).map((r) => ({
    id: r.id,
    changedBy: r.changed_by,
    changedByName: r.changed_by_name,
    changedByRemoved: r.changed_by_removed,
    source: r.source,
    changes: r.changes,
    createdAt: r.created_at,
  }));
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
  /** TASK-M5-N4: 'manual' (default, today's behaviour) or 'round_robin' (every lead that enters
   *  this campaign unassigned is auto-assigned via a rotating cursor, after territory rules get
   *  first shot). Set only via setCampaignDistributionMode -- owner/admin, or a manager whose
   *  campaign roster is fully inside their own pods. */
  distribution_mode: 'manual' | 'round_robin';
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

/** TASK-M5-D2 (follow-up on D1/EC-5): a preview of `assignCampaignLeads`'s own blast radius, for
 *  the "N of these leads are currently assigned to other agents and will be reassigned" warning.
 *  D1's original version counted client-side over a plain `.select()` -- PostgREST's default
 *  1000-row cap meant a bigger campaign undercounted AND got wrong range/percentage ranks, and
 *  tag mode sent every contact id in one `.in()` (URL length). Now calls `count_reassign_impact`,
 *  which shares the EXACT candidate-set logic `assign_campaign_leads` itself uses (a private
 *  helper both call), so the two can never drift. Name/signature kept identical so
 *  AssignLeadsModal doesn't change; still fails open (the caller's own try/catch falls through to
 *  submitting without a warning on any error -- this function itself just throws normally, same
 *  as every other RPC wrapper here). */
export async function countLeadsAssignedToOthers(
  campaignId: string,
  filter: AssignLeadsFilter,
  targetAgentId: string | null
): Promise<number> {
  const { data, error } = await supabase.rpc('count_reassign_impact', {
    p_campaign_id: campaignId,
    p_agent_id: targetAgentId,
    p_filter: filter,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

// --- MISSION-5 TASK-M5-C4: territory rules (route leads by state/area code to an agent or pod) ---

export interface TerritoryRule {
  id: string;
  org_id: string;
  priority: number;
  match_state: string | null;
  match_area_code: string | null;
  target_type: 'agent' | 'pod';
  target_agent_id: string | null;
  target_pod_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** SELECT-only RLS (owner/admin/manager) -- every write goes through the RPCs below. */
export async function listTerritoryRules(): Promise<TerritoryRule[]> {
  const { data, error } = await supabase
    .from('org_territory_rules')
    .select('*')
    .order('priority', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as TerritoryRule[];
}

export interface TerritoryRuleInput {
  matchState: string | null;
  matchAreaCode: string | null;
  targetType: 'agent' | 'pod';
  targetAgentId: string | null;
  targetPodId: string | null;
}

export async function createTerritoryRule(input: TerritoryRuleInput): Promise<string> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('create_territory_rule', {
    p_org: orgId,
    p_match_state: input.matchState,
    p_match_area_code: input.matchAreaCode,
    p_target_type: input.targetType,
    p_target_agent_id: input.targetAgentId,
    p_target_pod_id: input.targetPodId,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function updateTerritoryRule(
  ruleId: string,
  input: TerritoryRuleInput
): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('update_territory_rule', {
    p_org: orgId,
    p_rule_id: ruleId,
    p_match_state: input.matchState,
    p_match_area_code: input.matchAreaCode,
    p_target_type: input.targetType,
    p_target_agent_id: input.targetAgentId,
    p_target_pod_id: input.targetPodId,
  });
  if (error) throw new Error(error.message);
}

export async function deleteTerritoryRule(ruleId: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('delete_territory_rule', {
    p_org: orgId,
    p_rule_id: ruleId,
  });
  if (error) throw new Error(error.message);
}

/** Owner/admin only server-side -- pass the FULL current rule id list, in the new order. */
export async function reorderTerritoryRules(ruleIds: string[]): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('reorder_territory_rules', {
    p_org: orgId,
    p_rule_ids: ruleIds,
  });
  if (error) throw new Error(error.message);
}

/** 'pod' (review fix, audit/M5-C4/review-eng2.md SHOULD): a pod-targeted rule's leads roll up
 *  into ONE "-> pod Y" row (target_id is the pod id) instead of fragmenting into one row per pod
 *  member -- preview_territory_rules' own SQL only sets this when the pod actually resolved to a
 *  real agent; an empty/offboarded pod's leads are 'unmatched', same as no rule matching at all. */
export interface TerritoryPreviewRow {
  target_type: 'agent' | 'pod' | 'unmatched';
  target_id: string | null;
  target_name: string;
  lead_count: number;
}

export async function previewTerritoryRules(
  campaignId: string,
  reassign = false
): Promise<TerritoryPreviewRow[]> {
  const { data, error } = await supabase.rpc('preview_territory_rules', {
    p_campaign_id: campaignId,
    p_reassign: reassign,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as TerritoryPreviewRow[];
}

/** TASK-M5-T3: exact count of currently-assigned leads that would actually move if territory
 *  rules were applied with reassign checked -- mirrors apply_territory_rules' own two-layer scope
 *  gate exactly (server-side, count_territory_reassign_impact), for ANY distribution mode, not
 *  just round_robin (the existing mode-level warning below is round-robin-specific; this is a
 *  precise count regardless of mode). Fails open like countLeadsAssignedToOthers (D2) -- the
 *  caller's own try/catch just skips showing the number on any error, never blocks applying. */
export async function countTerritoryReassignImpact(
  campaignId: string,
  reassign = false
): Promise<number> {
  const { data, error } = await supabase.rpc('count_territory_reassign_impact', {
    p_campaign_id: campaignId,
    p_reassign: reassign,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

export interface TerritoryApplyResult {
  assigned: number;
  unmatched: number;
  by_agent: { agent_id: string; assigned: number; error?: string }[];
}

export async function applyTerritoryRules(
  campaignId: string,
  reassign = false
): Promise<TerritoryApplyResult> {
  const { data, error } = await supabase.rpc('apply_territory_rules', {
    p_campaign_id: campaignId,
    p_reassign: reassign,
  });
  if (error) throw new Error(error.message);
  return data as TerritoryApplyResult;
}

/** TASK-M5-N4: owner/admin, or a manager whose campaign roster is fully inside their own pods
 *  (server-checked -- private.is_campaign_in_callers_pod_scope). 'manual' stops future
 *  auto-assignment but never touches leads already assigned. */
export async function setCampaignDistributionMode(
  campaignId: string,
  mode: 'manual' | 'round_robin'
): Promise<void> {
  const { error } = await supabase.rpc('set_campaign_distribution_mode', {
    p_campaign_id: campaignId,
    p_mode: mode,
  });
  if (error) throw new Error(error.message);
}

/** TASK-M5-N4: "Rebalance now" -- round-robins every currently-unassigned queued lead in the
 *  campaign (never an already-assigned one). Requires the campaign to already be in
 *  round_robin mode. Returns the number of leads it assigned. */
export async function rebalanceCampaignDistribution(campaignId: string): Promise<number> {
  const { data, error } = await supabase.rpc('rebalance_campaign_distribution', {
    p_campaign_id: campaignId,
  });
  if (error) throw new Error(error.message);
  return (data ?? 0) as number;
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
   *  picker, and (MISSION-5 TASK-M5-B2) 'Paused by manager' / 'remote_end_by_manager'. */
  pause_reason: string | null;
  /** MISSION-5 TASK-M5-B2: the agent's own "raise hand" -- non-null means still raised. */
  raised_hand_at: string | null;
  /** MISSION-5 TASK-M5-N1 (deferred backlog item): set once a supervisor takes this call over --
   *  permanent for this session (never cleared back to null), so it stays a correct audit
   *  breadcrumb even after the agent moves on. Only meaningful for display purposes while
   *  `pause_reason === 'call_taken_over_by_manager'`; `getDialerSession`'s own
   *  `takenOverByManagerName` resolves this id to a display name server-side. */
  taken_over_by_manager_id: string | null;
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
 *  there was no live human to confirm) -- see `LiveCallInProgressError`'s own comment.
 *  MISSION-5 TASK-M5-B2: `defer` is the manager's own "end session, let the live call finish"
 *  action -- when a live call IS in progress, the server writes a deferred-stop request instead
 *  of refusing (202 `{status:'deferred'}`); the session actually stops once the in-progress
 *  call's disposition is saved. `force` and `defer` are mutually meaningful opposites of the
 *  SAME conflict (force interrupts it now, defer waits) -- pass at most one. */
export async function stopDialerSession(
  sessionId: string,
  opts?: { force?: boolean; defer?: boolean }
): Promise<{ status: 'stopped' | 'deferred' }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-stop`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({
      sessionId,
      force: opts?.force === true,
      defer: opts?.defer === true,
    }),
  });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 409 && data.code === 'LIVE_CALL_IN_PROGRESS') {
      throw new LiveCallInProgressError(data.error || 'A prospect is on the line.');
    }
    throw new Error(data.error || 'Failed to stop dialer session');
  }
  return data as { status: 'stopped' | 'deferred' };
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

/** MISSION-5 TASK-M5-B2: the agent's own "raise hand" button (Dialer.tsx, hotkey R). `raised`
 *  defaults to true; pass false for the agent's own explicit "never mind" clear -- the server
 *  also auto-clears this the moment the call ends or a manager starts coaching this agent, so
 *  most clears never come through here at all. */
export async function setRaisedHand(
  sessionId: string,
  raised = true
): Promise<{ raisedHand: boolean }> {
  const res = await fetch(`${getFunctionsUrl()}/dialer-session-raise-hand`, {
    method: 'POST',
    headers: await getEdgeFunctionHeaders(),
    body: JSON.stringify({ sessionId, raised }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to update raised-hand status');
  return data as { raisedHand: boolean };
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
  /** MISSION-5 TASK-M5-N1: resolved from `session.taken_over_by_manager_id` server-side --
   *  null whenever that id is null, or (should never happen) the manager's own profile row is
   *  gone. Drives DialerStateBanner's "Your call was taken over by <name>" state. */
  takenOverByManagerName: string | null;
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
    takenOverByManagerName: string | null;
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

// --- MISSION-5 TASK-M5-E7: disposition quality checks (flag, never block) -- backend is
// `20260927231644_disposition_quality_checks.sql`. Org-wide master switch + per-disposition rule
// toggles, evaluated by a DB trigger on call_legs; a manager's own view is pod-scoped exactly like
// the B5 call review library (recording_flags/comments) it reuses can_view_call_leg from. ---

/** The org-wide master switch (`org_quality_check_settings`), OFF by default. A plain RLS-gated
 *  table read/write (owner/admin only), same pattern as org_spend_settings -- no RPC needed. */
export async function getOrgQualityChecksEnabled(): Promise<boolean> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_quality_check_settings')
    .select('enabled')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.enabled ?? false;
}

export async function setOrgQualityChecksEnabled(enabled: boolean): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase
    .from('org_quality_check_settings')
    .update({ enabled, updated_at: new Date().toISOString() })
    .eq('org_id', orgId);
  if (error) throw new Error(error.message);
}

export type QualityRuleType = 'min_talk_seconds' | 'required_field' | 'rate_outlier';

export interface DispositionQualityRule {
  id: string;
  disposition_id: string;
  rule_type: QualityRuleType;
  enabled: boolean;
  config: Record<string, unknown>;
}

/** A plain RLS-gated read (org members) -- disposition_quality_rules has no client write policy
 *  at all, so this is select-only; every write goes through setDispositionQualityRule below. */
export async function listDispositionQualityRules(): Promise<DispositionQualityRule[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('disposition_quality_rules')
    .select('id, disposition_id, rule_type, enabled, config')
    .eq('org_id', orgId);
  if (error) throw new Error(error.message);
  return (data ?? []) as DispositionQualityRule[];
}

/** Upsert (one row per org+disposition+rule_type) -- owner/admin only (RPC-enforced), validates
 *  config shape per rule_type server-side. `config` shape by rule_type:
 *  - min_talk_seconds: { min_seconds: number }
 *  - required_field:   { fields: ('notes' | 'callback_at')[] }
 *  - rate_outlier:      { multiplier: number, min_sample?: number } */
export async function setDispositionQualityRule(
  dispositionId: string,
  ruleType: QualityRuleType,
  enabled: boolean,
  config: Record<string, unknown>
): Promise<string> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('set_disposition_quality_rule', {
    p_org: orgId,
    p_disposition_id: dispositionId,
    p_rule_type: ruleType,
    p_enabled: enabled,
    p_config: config,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export type QualityFlagStatus = 'open' | 'reviewed_ok' | 'coached';

export interface DispositionQualityFlag {
  id: string;
  call_leg_id: string;
  agent_id: string;
  agent_name: string;
  campaign_id: string | null;
  campaign_name: string | null;
  rule_type: QualityRuleType;
  disposition_key: string;
  detail: Record<string, unknown>;
  status: QualityFlagStatus;
  dispositioned_by: string | null;
  dispositioned_by_name: string | null;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface DispositionQualityFlagFilters {
  /** Owner/admin/manager only -- scope-checked server-side, same convention as
   *  RecordingSearchFilters.agentId. */
  agentId?: string;
  status?: QualityFlagStatus;
  callLegId?: string;
  limit?: number;
  offset?: number;
}

export async function listDispositionQualityFlags(
  filters: DispositionQualityFlagFilters = {}
): Promise<DispositionQualityFlag[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('list_disposition_quality_flags', {
    p_org: orgId,
    p_agent_id: filters.agentId ?? null,
    p_status: filters.status ?? null,
    p_call_leg_id: filters.callLegId ?? null,
    p_limit: filters.limit ?? 50,
    p_offset: filters.offset ?? 0,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as DispositionQualityFlag[];
}

/** Owner/admin/manager (pod-scoped to the flag's own agent) -- logs an audit row server-side. */
export async function setQualityFlagStatus(
  flagId: string,
  status: QualityFlagStatus
): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('set_quality_flag_status', {
    p_org: orgId,
    p_flag_id: flagId,
    p_status: status,
  });
  if (error) throw new Error(error.message);
}

/** One row per agent with at least one OPEN flag -- the cockpit/Team-page badge count. Agents
 *  with zero open flags are simply absent, not a zero row. */
export async function getQualityFlagOpenCounts(): Promise<Record<string, number>> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('get_quality_flag_open_counts', { p_org: orgId });
  if (error) throw new Error(error.message);
  const counts: Record<string, number> = {};
  for (const row of (data ?? []) as { agent_id: string; open_count: number }[]) {
    counts[row.agent_id] = row.open_count;
  }
  return counts;
}

export interface DispositionRateOutlier {
  disposition_id: string;
  disposition_key: string;
  disposition_label: string;
  agent_id: string;
  agent_name: string;
  agent_count: number;
  agent_total: number;
  agent_share: number;
  team_share: number;
  threshold_multiplier: number;
}

/** Rule (c), evaluated live -- never stored as a flag (see the migration's own header for why).
 *  Owner/admin/manager only; a manager's rows are pod-scoped server-side. */
export async function getDispositionRateOutliers(): Promise<DispositionRateOutlier[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('get_disposition_rate_outliers', { p_org: orgId });
  if (error) throw new Error(error.message);
  return (data ?? []) as DispositionRateOutlier[];
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
  /** MISSION-5 TASK-M5-B2 (EC-17): appends monitoring wording to the consent notice, for orgs
   *  using live coaching (listen/whisper/barge) in an all-party-consent state -- "may be
   *  recorded" alone does not disclose a supervisor silently listening in. Not legal advice. */
  mentionMonitoring: boolean;
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
    .select('announce_recording_mode, all_party_consent_states, mention_monitoring')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    announceRecordingMode:
      (data?.announce_recording_mode as AnnounceRecordingMode | undefined) ?? 'never',
    allPartyConsentStates: data?.all_party_consent_states ?? DEFAULT_ALL_PARTY_CONSENT_STATES,
    mentionMonitoring: data?.mention_monitoring ?? false,
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
    mention_monitoring: settings.mentionMonitoring,
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

// --- MISSION-5 TASK-M5-B5: call review library (recordings browser, flags, comments,
// scorecards) -- backend is `20260927171355_call_review_library.sql`. Owner/admin see every
// call, a manager's rows are pod-scoped, an agent sees/comments on only their own. ---

export interface RecordingSearchRow {
  call_leg_id: string;
  agent_id: string;
  agent_name: string;
  campaign_id: string | null;
  campaign_name: string | null;
  disposition_key: string | null;
  disposition_label: string | null;
  duration_seconds: number | null;
  ended_at: string | null;
  is_flagged: boolean;
  flag_reason: string | null;
  comment_count: number;
  has_scorecard: boolean;
}

export interface RecordingSearchFilters {
  /** Owner/admin/manager only -- scope-checked server-side against the caller's own managed
   *  pods (`recordings_search`'s own `p_agent_id` check); an agent may only ever pass their own
   *  id (or omit it, same result). */
  agentId?: string;
  campaignId?: string;
  dispositionKey?: string;
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  start?: Date;
  end?: Date;
  flaggedOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** The Recordings page's one-RPC-per-load list/filter query -- every filter is optional and
 *  server-side (never client-filtered), same trust model as `getTeamDailyStats`. */
export async function searchRecordings(
  filters: RecordingSearchFilters = {}
): Promise<RecordingSearchRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('recordings_search', {
    p_org: orgId,
    p_agent_id: filters.agentId ?? null,
    p_campaign_id: filters.campaignId ?? null,
    p_disposition_key: filters.dispositionKey ?? null,
    p_min_duration_seconds: filters.minDurationSeconds ?? null,
    p_max_duration_seconds: filters.maxDurationSeconds ?? null,
    p_start: filters.start ? filters.start.toISOString() : null,
    p_end: filters.end ? filters.end.toISOString() : null,
    p_flagged_only: filters.flaggedOnly ?? false,
    p_limit: filters.limit ?? 50,
    p_offset: filters.offset ?? 0,
  });
  if (error) throw new Error(error.message);
  return (data ?? []) as RecordingSearchRow[];
}

export interface RecordingFlag {
  reason: string;
  flaggedBy: string | null;
  createdAt: string;
}

/** null = not flagged. Visibility is `recording_flags`' own RLS (anyone who can view the leg). */
export async function getRecordingFlag(callLegId: string): Promise<RecordingFlag | null> {
  const { data, error } = await supabase
    .from('recording_flags')
    .select('reason, flagged_by, created_at')
    .eq('call_leg_id', callLegId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return { reason: data.reason, flaggedBy: data.flagged_by, createdAt: data.created_at };
}

/** Upsert -- re-flagging overwrites the reason/flagger. Anyone who can view the leg may flag it
 *  (including an agent flagging their own call), enforced by `recording_flags`' own RLS. */
export async function flagRecording(callLegId: string, reason: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase
    .from('recording_flags')
    .upsert({ call_leg_id: callLegId, org_id: orgId, reason }, { onConflict: 'call_leg_id' });
  if (error) throw new Error(error.message);
}

export async function unflagRecording(callLegId: string): Promise<void> {
  const { error } = await supabase.from('recording_flags').delete().eq('call_leg_id', callLegId);
  if (error) throw new Error(error.message);
}

export interface RecordingComment {
  id: string;
  callLegId: string;
  authorUserId: string | null;
  atSecond: number | null;
  text: string;
  createdAt: string;
}

/** Oldest first (a thread reads top-to-bottom). Visibility is `recording_comments`' own RLS. */
export async function listRecordingComments(callLegId: string): Promise<RecordingComment[]> {
  const { data, error } = await supabase
    .from('recording_comments')
    .select('id, call_leg_id, author_user_id, at_second, text, created_at')
    .eq('call_leg_id', callLegId)
    .order('created_at', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    callLegId: r.call_leg_id,
    authorUserId: r.author_user_id,
    atSecond: r.at_second,
    text: r.text,
    createdAt: r.created_at,
  }));
}

/** Append-only -- there is no edit/delete (matches `org_audit_log`'s own permanent-note
 *  convention). `atSecond` anchors the comment to a point in the recording's timeline. */
export async function addRecordingComment(
  callLegId: string,
  text: string,
  atSecond?: number
): Promise<void> {
  const orgId = await getActiveOrgId();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error('Not signed in');
  const { error } = await supabase.from('recording_comments').insert({
    call_leg_id: callLegId,
    org_id: orgId,
    author_user_id: user.id,
    at_second: atSecond ?? null,
    text,
  });
  if (error) throw new Error(error.message);
}

export type ScorecardCriterionKind = 'scale_1_5' | 'yes_no';

export interface ScorecardRubricCriterion {
  id: string;
  label: string;
  kind: ScorecardCriterionKind;
  sort: number;
}

export interface ScorecardRubric {
  id: string;
  name: string;
  criteria: ScorecardRubricCriterion[];
}

/** Every active rubric this org's owner/admin has defined, each with its active criteria in
 *  display order -- `scorecard_rubrics`/`scorecard_rubric_criteria` are plain tables (RLS: any
 *  org member reads, owner/admin manage), no RPC needed for this read. */
export async function listScorecardRubrics(): Promise<ScorecardRubric[]> {
  const { data: rubrics, error } = await supabase
    .from('scorecard_rubrics')
    .select('id, name')
    .eq('active', true)
    .order('name', { ascending: true });
  if (error) throw new Error(error.message);
  const rows = rubrics ?? [];
  if (rows.length === 0) return [];
  const { data: criteria, error: criteriaError } = await supabase
    .from('scorecard_rubric_criteria')
    .select('id, rubric_id, label, kind, sort')
    .in(
      'rubric_id',
      rows.map((r) => r.id)
    )
    .eq('active', true)
    .order('sort', { ascending: true });
  if (criteriaError) throw new Error(criteriaError.message);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    criteria: (criteria ?? [])
      .filter((c) => c.rubric_id === r.id)
      .map((c) => ({
        id: c.id,
        label: c.label,
        kind: c.kind as ScorecardCriterionKind,
        sort: c.sort,
      })),
  }));
}

export interface ScorecardScoreInput {
  criterionId: string;
  /** Exactly one of these must be set, matching the criterion's own `kind`. */
  scoreValue?: number;
  scoreBool?: boolean;
}

/** Owner/admin/manager only (never agent) -- a distinct, narrower gate than viewing/flagging/
 *  commenting. Re-scoring replaces the full score set. Returns the scorecard's id. */
export async function setCallScorecard(
  callLegId: string,
  rubricId: string,
  scores: ScorecardScoreInput[]
): Promise<string> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('set_call_scorecard', {
    p_org: orgId,
    p_call_leg_id: callLegId,
    p_rubric_id: rubricId,
    p_scores: scores.map((s) => ({
      criterion_id: s.criterionId,
      score_value: s.scoreValue ?? null,
      score_bool: s.scoreBool ?? null,
    })),
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export interface CallScorecardScore {
  criterionId: string;
  label: string;
  kind: ScorecardCriterionKind;
  scoreValue: number | null;
  scoreBool: boolean | null;
}

export interface CallScorecardView {
  rubricId: string;
  rubricName: string;
  scoredBy: string | null;
  updatedAt: string;
  scores: CallScorecardScore[];
}

/** null = this call has never been scored. Reads via `call_scorecards`/`call_scorecard_scores`'
 *  own RLS (anyone who can view the leg) -- embeds through the real FKs to
 *  scorecard_rubrics/scorecard_rubric_criteria rather than a second round trip. */
export async function getCallScorecard(callLegId: string): Promise<CallScorecardView | null> {
  const { data: cs, error } = await supabase
    .from('call_scorecards')
    .select('id, rubric_id, scored_by, updated_at, scorecard_rubrics(name)')
    .eq('call_leg_id', callLegId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!cs) return null;
  const { data: scores, error: scoresError } = await supabase
    .from('call_scorecard_scores')
    .select('criterion_id, score_value, score_bool, scorecard_rubric_criteria(label, kind, sort)')
    .eq('scorecard_id', cs.id)
    .order('criterion_id', { ascending: true });
  if (scoresError) throw new Error(scoresError.message);
  type ScoreRow = {
    criterion_id: string;
    score_value: number | null;
    score_bool: boolean | null;
    scorecard_rubric_criteria: { label: string; kind: string; sort: number } | null;
  };
  const rubricName = (cs.scorecard_rubrics as unknown as { name: string } | null)?.name ?? 'Rubric';
  return {
    rubricId: cs.rubric_id,
    rubricName,
    scoredBy: cs.scored_by,
    updatedAt: cs.updated_at,
    scores: ((scores ?? []) as unknown as ScoreRow[])
      .slice()
      .sort(
        (a, b) =>
          (a.scorecard_rubric_criteria?.sort ?? 0) - (b.scorecard_rubric_criteria?.sort ?? 0)
      )
      .map((s) => ({
        criterionId: s.criterion_id,
        label: s.scorecard_rubric_criteria?.label ?? 'Criterion',
        kind: (s.scorecard_rubric_criteria?.kind as ScorecardCriterionKind) ?? 'scale_1_5',
        scoreValue: s.score_value,
        scoreBool: s.score_bool,
      })),
  };
}

export interface ScorecardTrendPoint {
  callLegId: string;
  scoredAt: string;
  scorePct: number;
}

/** The signed-in agent's own scorecard trend, oldest to newest -- backs Dashboard.tsx's My
 *  stats card. No agentId parameter, same self-view trust model as `getAgentSelfStats`. */
export async function getMyScorecardTrend(): Promise<ScorecardTrendPoint[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('my_scorecard_trend', { p_org: orgId });
  if (error) throw new Error(error.message);
  return ((data ?? []) as { call_leg_id: string; scored_at: string; score_pct: number }[]).map(
    (r) => ({ callLegId: r.call_leg_id, scoredAt: r.scored_at, scorePct: r.score_pct })
  );
}

// --- MISSION-5 TASK-M5-A6 follow-up: list existing goals for management (edit/delete). ---

export interface OrgGoal {
  id: string;
  scope: GoalScope;
  podId: string | null;
  agentUserId: string | null;
  metric: GoalMetric;
  targetValue: number;
  updatedAt: string;
}

/** Every standing goal row this caller can see -- `org_goals` is a plain table, RLS already
 *  scopes it correctly (owner/admin: all; manager: org-wide + their own pod/agent rows; agent:
 *  their own agent-level row), so no RPC is needed for this read, same reasoning as
 *  `listScorecardRubrics`. Backs the Team page's "current goals" management list (edit via
 *  `setOrgGoal`, same scope/pod/agent + a new target; delete via `deleteOrgGoal`). */
export async function listOrgGoals(): Promise<OrgGoal[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_goals')
    .select('id, scope, pod_id, agent_user_id, metric, target_value, updated_at')
    .eq('org_id', orgId)
    .order('scope', { ascending: true })
    .order('metric', { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => ({
    id: r.id,
    scope: r.scope as GoalScope,
    podId: r.pod_id,
    agentUserId: r.agent_user_id,
    metric: r.metric as GoalMetric,
    targetValue: r.target_value,
    updatedAt: r.updated_at,
  }));
}

// --- Deferred backlog item TM-B2: onboarding checklist per agent, derived from existing data. ---

export interface AgentOnboardingChecklistRow {
  agentId: string;
  agentName: string;
  preflightPassed: boolean;
  numberAssigned: boolean;
  campaignAssigned: boolean;
  firstCallMade: boolean;
}

/** Owner/admin see every active agent; a manager sees only their own pod-scoped agents (server-
 *  enforced, `agent_onboarding_checklist`'s own gate). A current-state snapshot, not a time-window
 *  query -- no from/to params, unlike agent_time_in_state/agent_first_activity. */
export async function getAgentOnboardingChecklist(): Promise<AgentOnboardingChecklistRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('agent_onboarding_checklist', { p_org: orgId });
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as {
      agent_id: string;
      agent_name: string;
      preflight_passed: boolean;
      number_assigned: boolean;
      campaign_assigned: boolean;
      first_call_made: boolean;
    }[]
  ).map((r) => ({
    agentId: r.agent_id,
    agentName: r.agent_name,
    preflightPassed: r.preflight_passed,
    numberAssigned: r.number_assigned,
    campaignAssigned: r.campaign_assigned,
    firstCallMade: r.first_call_made,
  }));
}

// --- Deferred backlog item TASK-M5-F3: agent working-hours schedules ---

export interface AgentScheduleShift {
  weekday: number; // 0=Sunday..6=Saturday (Postgres extract(dow) convention, matches the RPC)
  start: string; // 'HH:MM' local wall-clock time in effectiveTimezone
  end: string; // 'HH:MM'; end <= start means the shift wraps past midnight
}

export interface AgentScheduleRow extends AgentScheduleShift {
  agentUserId: string;
  effectiveTimezone: string;
}

/** Every shift row the caller can see -- owner/admin: every active member; manager: pod-scoped +
 *  their own; an agent-role caller with no wider role: only their own (read-only -- there is no
 *  agent-callable write path, see setAgentScheduleDay). Omit agentId to fetch the whole team the
 *  caller is scoped to in one round trip (backs AgentSchedulesPanel's editor). */
export async function listAgentSchedules(agentId?: string): Promise<AgentScheduleRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('list_agent_schedules', {
    p_org: orgId,
    p_agent: agentId ?? null,
  });
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as {
      agent_user_id: string;
      weekday: number;
      start_time: string;
      end_time: string;
      effective_timezone: string;
    }[]
  ).map((r) => ({
    agentUserId: r.agent_user_id,
    weekday: r.weekday,
    start: r.start_time.slice(0, 5),
    end: r.end_time.slice(0, 5),
    effectiveTimezone: r.effective_timezone,
  }));
}

/** Replaces one weekday's ENTIRE shift list atomically (delete + insert) -- the same call backs
 *  "copy day to other days" (call once per target weekday with the source day's shifts) and
 *  "apply to selected agents" (call once per selected agent), no separate bulk RPC. Owner/admin
 *  edit anyone active; a manager only their own pod-scoped agents; an agent can never call this
 *  (server rejects, even for their own id). */
export async function setAgentScheduleDay(
  agentId: string,
  weekday: number,
  shifts: { start: string; end: string }[]
): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('set_agent_schedule_day', {
    p_org: orgId,
    p_agent: agentId,
    p_weekday: weekday,
    p_shifts: shifts,
  });
  if (error) throw new Error(error.message);
}

/** Sets (or, with `timezone: null`, clears back to the org default) an agent's own IANA timezone
 *  override -- same owner/admin-any/manager-pod-scoped/agent-never gate as setAgentScheduleDay,
 *  kept as its own RPC so this never has to touch an unrelated weekday's shifts. Server validates
 *  the zone name by actually using it (an invalid name raises), not a hand-rolled check. */
export async function setAgentTimezone(agentId: string, timezone: string | null): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('set_agent_timezone', {
    p_org: orgId,
    p_agent: agentId,
    p_timezone: timezone,
  });
  if (error) throw new Error(error.message);
}

export interface AgentScheduleLiveStatusRow {
  agentId: string;
  hasSchedule: boolean;
  dialingOutsideSchedule: boolean;
}

/** Real-time, point-in-time only -- for every agent currently in an active dial_session (pod-
 *  scoped to the caller), is "now" inside any of today's shifts? Owner/admin/manager only (empty
 *  for anyone else). Backs the cockpit's "Dialing outside schedule" badge; the client merges this
 *  by agentId onto team_live_board's own rows rather than a widen-in-place (that function is
 *  B2's, in flux this session -- see the migration's own header). Poll it the same way
 *  getTeamLiveBoard is. */
export async function getAgentScheduleLiveStatus(): Promise<AgentScheduleLiveStatusRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('agent_schedule_live_status', { p_org: orgId });
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as { agent_id: string; has_schedule: boolean; dialing_outside_schedule: boolean }[]
  ).map((r) => ({
    agentId: r.agent_id,
    hasSchedule: r.has_schedule,
    dialingOutsideSchedule: r.dialing_outside_schedule,
  }));
}

export interface AgentScheduleAttendanceSignalRow {
  agentId: string;
  day: string;
  scheduledNotSignedIn: boolean;
  dialedOutsideSchedule: boolean;
}

/** One row per (agent, local day) that had >=1 shift scheduled -- a day with NO schedule at all
 *  emits NO row (never a false "not scheduled" warning; merge this onto the Attendance tab's rows
 *  by agentId+day the same way firstActivityRows already is in groupAttendance). Same
 *  p_from/p_to/p_agent/p_tz shape and CURRENT role gate as getAgentFirstActivity. Informational
 *  only -- see the migration header for exactly what each boolean means and its documented
 *  approximation. */
export async function getAgentScheduleAttendanceSignal(
  from: Date,
  to: Date,
  agentId?: string,
  tz?: string
): Promise<AgentScheduleAttendanceSignalRow[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('agent_schedule_attendance_signal', {
    p_org: orgId,
    p_from: from.toISOString(),
    p_to: to.toISOString(),
    p_agent: agentId ?? null,
    p_tz: tz ?? 'America/Chicago',
  });
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as {
      agent_id: string;
      day: string;
      scheduled_not_signed_in: boolean;
      dialed_outside_schedule: boolean;
    }[]
  ).map((r) => ({
    agentId: r.agent_id,
    day: r.day,
    scheduledNotSignedIn: r.scheduled_not_signed_in,
    dialedOutsideSchedule: r.dialed_outside_schedule,
  }));
}

// --- MISSION-5 TASK-M5-N1: org-level call-takeover setting, OFF by default per org. ---

export async function getCallTakeoverSettings(): Promise<{ enabled: boolean }> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_call_takeover_settings')
    .select('enabled')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return { enabled: data?.enabled ?? false };
}

/** Owner/admin only -- enforced by org_call_takeover_settings' own RLS UPDATE policy. */
export async function updateCallTakeoverSettings(enabled: boolean): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase
    .from('org_call_takeover_settings')
    .upsert({ org_id: orgId, enabled, updated_at: new Date().toISOString() });
  if (error) throw new Error(error.message);
}

// --- Deferred backlog item TASK-M5-G3: campaign script/objection-sheet version history + restore ---

export type CampaignScriptField = 'script_text' | 'objection_sheet_text';

export interface CampaignScriptVersion {
  id: string;
  version: number;
  oldText: string | null;
  newText: string;
  editedBy: string | null;
  editedByName: string;
  editedAt: string;
}

/** Every version of this campaign's script or objection sheet, newest first. RLS mirrors
 *  "org members can view campaigns" -- anyone who can read the campaign can read its history, the
 *  RPC just also joins in a display name so the client doesn't need a second round trip. */
export async function listCampaignScriptVersions(
  campaignId: string,
  field: CampaignScriptField
): Promise<CampaignScriptVersion[]> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('list_campaign_script_versions', {
    p_org: orgId,
    p_campaign: campaignId,
    p_field: field,
  });
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as {
      id: string;
      version: number;
      old_text: string | null;
      new_text: string;
      edited_by: string | null;
      edited_by_name: string;
      edited_at: string;
    }[]
  ).map((r) => ({
    id: r.id,
    version: r.version,
    oldText: r.old_text,
    newText: r.new_text,
    editedBy: r.edited_by,
    editedByName: r.edited_by_name,
    editedAt: r.edited_at,
  }));
}

/** Restores one field to a prior version's text -- a plain UPDATE on campaigns under the hood, so
 *  it produces its own new version row (same trigger every other edit goes through) plus one
 *  explicit audit-log row. Same gate as editing the campaign at all (owner/admin), enforced
 *  server-side -- not by this function's caller. */
export async function restoreCampaignScriptVersion(versionId: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('restore_campaign_script_version', {
    p_org: orgId,
    p_version_id: versionId,
  });
  if (error) throw new Error(error.message);
}

// --- MISSION-5 TASK-M5-G6: shared team callback inbox for missed inbound calls, with claim. ---

export type InboxItemStatus = 'open' | 'claimed' | 'done' | 'dismissed';

export interface InboxItem {
  id: string;
  orgId: string;
  fromE164: string;
  contactId: string | null;
  toNumberId: string | null;
  targetAgentId: string | null;
  status: InboxItemStatus;
  claimedBy: string | null;
  claimedAt: string | null;
  doneAt: string | null;
  dismissedAt: string | null;
  note: string | null;
  repeatCount: number;
  receivedAt: string;
  lastReceivedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SharedInboxSettings {
  sharedInboxEnabled: boolean;
  claimStaleMinutes: number;
}

function mapInboxItemRow(r: {
  id: string;
  org_id: string;
  from_e164: string;
  contact_id: string | null;
  to_number_id: string | null;
  target_agent_id: string | null;
  status: InboxItemStatus;
  claimed_by: string | null;
  claimed_at: string | null;
  done_at: string | null;
  dismissed_at: string | null;
  note: string | null;
  repeat_count: number;
  received_at: string;
  last_received_at: string;
  created_at: string;
  updated_at: string;
}): InboxItem {
  return {
    id: r.id,
    orgId: r.org_id,
    fromE164: r.from_e164,
    contactId: r.contact_id,
    toNumberId: r.to_number_id,
    targetAgentId: r.target_agent_id,
    status: r.status,
    claimedBy: r.claimed_by,
    claimedAt: r.claimed_at,
    doneAt: r.done_at,
    dismissedAt: r.dismissed_at,
    note: r.note,
    repeatCount: r.repeat_count,
    receivedAt: r.received_at,
    lastReceivedAt: r.last_received_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Calls the stale-claim sweep once, then reads back whatever this caller's own RLS
 *  (`private.can_view_inbox_item`) scopes them to -- owner/admin all, manager pod-scoped,
 *  agent their own targets plus org-wide open items when `shared_inbox_enabled` is on. */
export async function listInboxItems(): Promise<InboxItem[]> {
  await reopenStaleInboxClaims();
  const { data, error } = await supabase
    .from('inbox_items')
    .select('*')
    .order('last_received_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapInboxItemRow);
}

/** Reopens any claim past `claim_stale_minutes` for this org -- "reopened on read, no cron"
 *  (requirement #3). Called by `listInboxItems` itself; exported separately for a manual refresh
 *  action that wants the sweep without a full re-fetch. */
export async function reopenStaleInboxClaims(): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('reopen_stale_inbox_claims', { p_org: orgId });
  if (error) throw new Error(error.message);
}

/** Atomic claim -- loses the race cleanly: surfaces the RPC's own "Already claimed by X" /
 *  "This item is already done" message via error.message rather than a generic failure. */
export async function claimInboxItem(itemId: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('claim_inbox_item', { p_org: orgId, p_item_id: itemId });
  if (error) throw new Error(error.message);
}

/** The claimer or a manager+ (requirement #3), enforced server-side. */
export async function unclaimInboxItem(itemId: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('unclaim_inbox_item', { p_org: orgId, p_item_id: itemId });
  if (error) throw new Error(error.message);
}

/** The claimer or a manager+, optional note. */
export async function markInboxItemDone(itemId: string, note?: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('mark_inbox_item_done', {
    p_org: orgId,
    p_item_id: itemId,
    p_note: note ?? null,
  });
  if (error) throw new Error(error.message);
}

/** Manager+ only -- excludes even the item's own target agent (requirement #3). */
export async function dismissInboxItem(itemId: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('dismiss_inbox_item', { p_org: orgId, p_item_id: itemId });
  if (error) throw new Error(error.message);
}

/** Any org member can read (RLS: "org members can view shared inbox settings"). */
export async function getSharedInboxSettings(): Promise<SharedInboxSettings> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase
    .from('org_shared_inbox_settings')
    .select('shared_inbox_enabled, claim_stale_minutes')
    .eq('org_id', orgId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return {
    sharedInboxEnabled: data?.shared_inbox_enabled ?? false,
    claimStaleMinutes: data?.claim_stale_minutes ?? 30,
  };
}

/** Owner/admin only -- enforced inside `set_shared_inbox_settings` itself (not RLS), since it
 *  also validates `claim_stale_minutes > 0`. */
export async function setSharedInboxSettings(settings: SharedInboxSettings): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('set_shared_inbox_settings', {
    p_org: orgId,
    p_shared_inbox_enabled: settings.sharedInboxEnabled,
    p_claim_stale_minutes: settings.claimStaleMinutes,
  });
  if (error) throw new Error(error.message);
}

// --- MISSION-5 TASK-M5-E2: power hour / call blitz with a live sprint board. ---

export type PowerHourScope = 'org' | 'pod';
export type PowerHourMetric = 'conversations' | 'connects' | 'appointments';

export interface PowerHour {
  id: string;
  orgId: string;
  name: string;
  createdBy: string | null;
  startsAt: string;
  endsAt: string;
  scope: PowerHourScope;
  podId: string | null;
  metric: PowerHourMetric;
  target: number | null;
  cancelledAt: string | null;
  createdAt: string;
}

export type PowerHourStatus = 'upcoming' | 'live' | 'ended' | 'cancelled';

/** Status is derived client-side from starts_at/ends_at/cancelled_at vs "now" -- see
 *  audit/M5-E2/notes.md's own "Status" section for why this isn't a stored/generated column. */
export function powerHourStatus(p: PowerHour, now: Date = new Date()): PowerHourStatus {
  if (p.cancelledAt) return 'cancelled';
  const t = now.getTime();
  if (t < new Date(p.startsAt).getTime()) return 'upcoming';
  if (t < new Date(p.endsAt).getTime()) return 'live';
  return 'ended';
}

function mapPowerHourRow(r: {
  id: string;
  org_id: string;
  name: string;
  created_by: string | null;
  starts_at: string;
  ends_at: string;
  scope: PowerHourScope;
  pod_id: string | null;
  metric: PowerHourMetric;
  target: number | null;
  cancelled_at: string | null;
  created_at: string;
}): PowerHour {
  return {
    id: r.id,
    orgId: r.org_id,
    name: r.name,
    createdBy: r.created_by,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    scope: r.scope,
    podId: r.pod_id,
    metric: r.metric,
    target: r.target,
    cancelledAt: r.cancelled_at,
    createdAt: r.created_at,
  };
}

/** RLS-scoped read (`power_hours`' own SELECT policy -- see the migration's header): any org
 *  member sees org-wide rows; a pod-scoped row is visible to that pod's own members or a manager
 *  covering it. No resolver RPC needed (unlike active_org_broadcasts) since the table's own
 *  policy is already this permissive by design -- participants must be able to discover a
 *  pod-scoped power hour they're IN. */
export async function listPowerHours(): Promise<PowerHour[]> {
  const { data, error } = await supabase
    .from('power_hours')
    .select('*')
    .order('starts_at', { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapPowerHourRow);
}

export async function createPowerHour(input: {
  name: string;
  startsAt: Date;
  endsAt: Date;
  scope: PowerHourScope;
  podId?: string;
  metric: PowerHourMetric;
  target?: number;
}): Promise<string> {
  const orgId = await getActiveOrgId();
  const { data, error } = await supabase.rpc('create_power_hour', {
    p_org: orgId,
    p_name: input.name,
    p_starts_at: input.startsAt.toISOString(),
    p_ends_at: input.endsAt.toISOString(),
    p_scope: input.scope,
    p_pod_id: input.scope === 'pod' ? (input.podId ?? null) : null,
    p_metric: input.metric,
    p_target: input.target ?? null,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function cancelPowerHour(id: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('cancel_power_hour', { p_org: orgId, p_id: id });
  if (error) throw new Error(error.message);
}

export interface PowerHourBoardRow {
  agentId: string;
  name: string;
  metricCount: number;
  dials: number;
  talkMinutes: number;
  dialingHours: number;
  metricPerHour: number | null;
  boardRank: number;
}

export async function getPowerHourBoard(id: string): Promise<PowerHourBoardRow[]> {
  const { data, error } = await supabase.rpc('power_hour_board', { p_id: id });
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as Array<{
      agent_id: string;
      name: string;
      metric_count: number;
      dials: number;
      talk_minutes: number;
      dialing_hours: number;
      metric_per_hour: number | null;
      board_rank: number;
    }>
  ).map((r) => ({
    agentId: r.agent_id,
    name: r.name,
    metricCount: r.metric_count,
    dials: r.dials,
    talkMinutes: r.talk_minutes,
    dialingHours: r.dialing_hours,
    metricPerHour: r.metric_per_hour,
    boardRank: r.board_rank,
  }));
}

// --- MISSION-5 TASK-M5-O1 Part B (R3's next-5 #1): guarded-trigger failure visibility. ---

export type TriggerFailureSource =
  'disposition_quality_checks' | 'round_robin_distribution' | 'shared_inbox';

export interface TriggerFailure {
  id: string;
  source: TriggerFailureSource;
  rowId: string | null;
  error: string;
  acknowledgedAt: string | null;
  createdAt: string;
}

/** Owner/admin only (RLS: `trigger_failures`' own SELECT policy) -- reads directly, no RPC
 *  needed, same "SELECT-only RLS, no client writes" shape as `power_hours`/`org_pods`. */
export async function listTriggerFailures(days = 7): Promise<TriggerFailure[]> {
  const { data, error } = await supabase
    .from('trigger_failures')
    .select('id, source, row_id, error, acknowledged_at, created_at')
    .gte('created_at', new Date(Date.now() - days * 86400000).toISOString())
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (
    (data ?? []) as Array<{
      id: string;
      source: TriggerFailureSource;
      row_id: string | null;
      error: string;
      acknowledged_at: string | null;
      created_at: string;
    }>
  ).map((r) => ({
    id: r.id,
    source: r.source,
    rowId: r.row_id,
    error: r.error,
    acknowledgedAt: r.acknowledged_at,
    createdAt: r.created_at,
  }));
}

export async function acknowledgeTriggerFailure(id: string): Promise<void> {
  const orgId = await getActiveOrgId();
  const { error } = await supabase.rpc('acknowledge_trigger_failure', { p_org: orgId, p_id: id });
  if (error) throw new Error(error.message);
}

// --- Shifts subsystem (TASK-F01): contract = docs/design/shifts.md §3. Hand-synced with the
// shifts-*/shift-*/admin-* Edge Functions -- a response-shape change produces NO TypeScript
// error, so change both sides in the same commit. ---

export type ShiftActivity = 'dialing' | 'follow_up' | 'social';
export type ShiftStatus = 'scheduled' | 'cancelled' | 'completed' | 'missed' | 'excused';

export interface ShiftSettings {
  enabled: boolean;
  timezone: string;
  minWeeklyHours: number;
  lockWeekday: number;
  /** HH:MM */
  lockTime: string;
  changeNoticeHours: number;
  graceMinutes: number;
  conversationMinSeconds: number;
  idleFlagMinutes: number;
  adherenceFlagPct: number;
  openSessionTailMinutes: number;
  powerCoverageAlert: number;
  powerWeekPct: number;
  ghlCalendarId: string | null;
  ghlOwnerUserId: string | null;
}

export interface ShiftOpenHours {
  isoWeekday: number;
  /** HH:MM */
  openFrom: string;
  openUntil: string;
}

export interface ShiftPowerWindow {
  id: string;
  label: string;
  isoWeekdays: number[];
  startTime: string;
  endTime: string;
  active: boolean;
}

export interface Shift {
  id: string;
  userId: string;
  weekStart: string;
  activity: ShiftActivity;
  startsAt: string;
  endsAt: string;
  hours: number;
  powerMinutes: number;
  status: ShiftStatus;
  source: 'pick' | 'request' | 'admin';
  ghlSyncStatus: 'pending' | 'synced' | 'error';
  hasPendingRequest: boolean;
}

export interface ShiftRosterEntry {
  userId: string;
  /** "Sara K." for agents, full name for manager-level callers. */
  name: string;
  activity: ShiftActivity;
  startsAt: string;
  endsAt: string;
  isMe: boolean;
}

export interface ShiftWeekCommitment {
  weekStart: string;
  submittedAt: string | null;
  scheduledHours: number;
  powerHours: number;
  powerDialPct: number | null;
  powerWeek: boolean;
  lightWeek: boolean;
  minHoursOverride: number | null;
}

export interface ShiftKpi {
  shiftId: string;
  userId: string;
  final: boolean;
  computedAt: string;
  scheduledMinutes: number;
  activeDialMinutes: number;
  powerActiveMinutes: number;
  adherencePct: number;
  firstDialAt: string | null;
  lastCallEndAt: string | null;
  lateStartMinutes: number;
  earlyEndMinutes: number;
  longestIdleMinutes: number;
  dials: number;
  connects: number;
  conversations: number;
  voicemails: number;
  noAnswers: number;
  talkMinutes: number;
  dialsPerActiveHour: number | null;
  connectRatePct: number | null;
  dispositions: Record<string, number>;
  flags: string[];
}

export type ShiftRequestType = 'move' | 'drop' | 'add' | 'light_week';
export type ShiftRequestStatus = 'pending' | 'approved' | 'denied' | 'withdrawn';

export interface ShiftRequest {
  id: string;
  userId: string;
  userName: string;
  weekStart: string;
  type: ShiftRequestType;
  fromShift: Shift | null;
  toStartsAt: string | null;
  toEndsAt: string | null;
  toActivity: ShiftActivity | null;
  requestedMinHours: number | null;
  reason: string;
  isLate: boolean;
  status: ShiftRequestStatus;
  reviewerName: string | null;
  reviewerNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  hoursBefore: number;
  /** The intern's week hours if approved. */
  hoursAfter: number;
}

export interface ShiftWeekInfo {
  weekStart: string;
  timezone: string;
  deadlineAt: string;
  deadlinePassed: boolean;
  isCurrentWeek: boolean;
  isNextWeek: boolean;
  /** Effective minimum, after any light-week override. */
  minHours: number;
}

export interface ShiftsWeekResponse {
  role: string;
  week: ShiftWeekInfo;
  settings: ShiftSettings;
  openHours: ShiftOpenHours[];
  powerWindows: ShiftPowerWindow[];
  roster: ShiftRosterEntry[];
  myShifts: Shift[];
  commitment: ShiftWeekCommitment | null;
  kpis: ShiftKpi[];
  /** Last 60 days, newest first. */
  myRequests: ShiftRequest[];
  powerWeekHistory: { weekStart: string; sentence: string }[];
  /** In progress or starting within 15 minutes -- drives the Dialer banner. */
  liveShift: Shift | null;
}

export interface ShiftBlockInput {
  /** Local date YYYY-MM-DD in settings.timezone. */
  date: string;
  /** HH:MM local. */
  start: string;
  end: string;
  activity: ShiftActivity;
}

export interface CreateShiftRequestInput {
  type: ShiftRequestType;
  fromShiftId?: string;
  date?: string;
  start?: string;
  end?: string;
  toActivity?: ShiftActivity;
  requestedMinHours?: number;
  reason: string;
}

export interface AdminShiftMember {
  userId: string;
  name: string;
  email: string;
  role: string;
  participates: boolean;
  ghlContactId: string | null;
  podId: string | null;
  podName: string | null;
}

export interface AdminShiftRollupRow {
  userId: string;
  name: string;
  hoursScheduled: number;
  hoursDialing: number;
  powerDialPct: number | null;
  dials: number;
  conversations: number;
  missedShifts: number;
  powerWeek: boolean;
}

export interface AdminShiftSyncRow {
  id: number;
  kind: string;
  event: string | null;
  userName: string | null;
  lastError: string | null;
  attempts: number;
  createdAt: string;
}

export interface AdminShiftsOverview {
  week: ShiftWeekInfo;
  settings: ShiftSettings;
  openHours: ShiftOpenHours[];
  powerWindows: ShiftPowerWindow[];
  members: AdminShiftMember[];
  shifts: (Shift & { userName: string })[];
  commitments: (ShiftWeekCommitment & { userId: string })[];
  /** Pending (any week) oldest first + this week's decided. */
  requests: ShiftRequest[];
  kpis: ShiftKpi[];
  rollup: AdminShiftRollupRow[];
  powerWeekCallouts: { userId: string; sentence: string }[];
  syncHealth: { errorCount: number; lastError: string | null; rows: AdminShiftSyncRow[] };
}

export interface AdminShiftUpdateInput {
  action: 'create' | 'move' | 'cancel' | 'excuse';
  shiftId?: string;
  userId?: string;
  date?: string;
  start?: string;
  end?: string;
  activity?: ShiftActivity;
}

/** A non-2xx shifts response: `{ error: <code>, message: <sentence>, ...detail }`. `code` is one
 *  of the §3 codes (shifts_disabled, deadline_passed, bad_block, overlap, under_minimum, ...);
 *  `details` carries the rest of the body (`index`, `hours`, `minimum`, `hoursAfter`, ...). */
export class ShiftsApiError extends Error {
  code: string;
  status: number;
  details: Record<string, unknown>;
  constructor(code: string, message: string, status: number, details: Record<string, unknown>) {
    super(message);
    this.name = 'ShiftsApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function callShiftsFunction<T>(
  fn: string,
  opts: { method?: 'GET' | 'POST'; query?: Record<string, string | undefined>; body?: unknown } = {}
): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const qs = Object.entries(opts.query ?? {})
    .filter((e): e is [string, string] => e[1] !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const res = await fetch(`${getFunctionsUrl()}/${fn}${qs ? `?${qs}` : ''}`, {
    method,
    headers: await getEdgeFunctionHeaders(),
    body: method === 'POST' ? JSON.stringify(opts.body ?? {}) : undefined,
  });
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    // Non-JSON body (gateway error page) -- fall through to the generic error below.
  }
  if (!res.ok) {
    const { error, message, ...details } = data;
    throw new ShiftsApiError(
      typeof error === 'string' ? error : `http_${res.status}`,
      typeof message === 'string' ? message : 'Something went wrong. Try again.',
      res.status,
      details
    );
  }
  return data as T;
}

/** `week` = the Monday (YYYY-MM-DD); omitted = the current week. */
export function getShiftsWeek(week?: string): Promise<ShiftsWeekResponse> {
  return callShiftsFunction('shifts-week-get', { query: { week } });
}

export function submitShiftsWeek(
  weekStart: string,
  blocks: ShiftBlockInput[]
): Promise<{ shifts: Shift[]; commitment: ShiftWeekCommitment }> {
  return callShiftsFunction('shifts-submit-week', { body: { weekStart, blocks } });
}

export function createShiftRequest(
  input: CreateShiftRequestInput
): Promise<{ request: ShiftRequest }> {
  return callShiftsFunction('shift-requests-create', { body: input });
}

export function withdrawShiftRequest(requestId: string): Promise<{ request: ShiftRequest }> {
  return callShiftsFunction('shift-requests-withdraw', { body: { requestId } });
}

/** Client calls never finalize: live numbers for one in-progress/own shift. */
export function computeShiftKpi(shiftId: string): Promise<{ kpis: ShiftKpi[] }> {
  return callShiftsFunction('shift-kpi-compute', { body: { shiftId } });
}

export function getAdminShiftsOverview(week?: string): Promise<AdminShiftsOverview> {
  return callShiftsFunction('admin-shifts-overview', { query: { week } });
}

export function reviewShiftRequest(input: {
  requestId: string;
  decision: 'approve' | 'deny';
  note?: string;
  allowUnderMinimum?: boolean;
}): Promise<{ request: ShiftRequest }> {
  return callShiftsFunction('admin-shift-requests-review', { body: input });
}

export function adminUpdateShift(input: AdminShiftUpdateInput): Promise<{ shift: Shift }> {
  return callShiftsFunction('admin-shift-update', { body: input });
}

export function upsertPowerWindow(
  input: Omit<ShiftPowerWindow, 'id'> & { id?: string }
): Promise<{ powerWindow: ShiftPowerWindow }> {
  return callShiftsFunction('admin-power-windows-upsert', { body: input });
}

/** Full replace: a weekday missing from `rows` becomes closed. */
export function upsertOpenHours(rows: ShiftOpenHours[]): Promise<{ openHours: ShiftOpenHours[] }> {
  return callShiftsFunction('admin-open-hours-upsert', { body: { rows } });
}

/** `enabled` is owner/admin only (server-enforced). */
export function updateShiftSettings(
  patch: Partial<ShiftSettings>
): Promise<{ settings: ShiftSettings }> {
  return callShiftsFunction('admin-shift-settings-update', { body: patch });
}

export function upsertShiftMember(input: {
  userId: string;
  ghlContactId?: string | null;
  participates?: boolean;
}): Promise<{ member: AdminShiftMember }> {
  return callShiftsFunction('admin-profiles-upsert', { body: input });
}

export function findGhlContact(
  email: string
): Promise<{ contacts: { id: string; name: string; email: string }[] }> {
  return callShiftsFunction('admin-ghl-find-contact', { body: { email } });
}

/** Omit `outboxId` to reset every errored row for the org. */
export function retryShiftGhl(outboxId?: number): Promise<{ reset: number }> {
  return callShiftsFunction('admin-ghl-retry', {
    body: outboxId === undefined ? {} : { outboxId },
  });
}

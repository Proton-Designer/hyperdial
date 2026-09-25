/**
 * TASK-SP: the real-time gate `dialer-session-start` and `telnyx-purchase-number` both call
 * before letting an action through, plus the read used by Settings -> Telephony's balance/MTD
 * display and the hourly alert cron (spend-alert-check). One module so the "fetch balance +
 * estimate MTD spend" I/O lives in exactly one place -- see spend-estimate.ts for the pure math
 * and why MTD spend is an estimate, not a live Telnyx number.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { getConnectedOrgTelnyxContext } from './telnyx-org-context.ts';
import {
  estimateMonthToDateSpendUsd,
  isBelowMinBalance,
  isOverSpendCap,
} from './spend-estimate.ts';

export interface OrgSpendSettings {
  monthly_spend_cap_usd: number | null;
  low_balance_alert_usd: number;
  min_balance_to_dial_usd: number;
  estimated_per_minute_rate_usd: number;
  estimated_monthly_number_price_usd: number;
  last_low_balance_alert_at: string | null;
}

/** Matches `org_spend_settings`' own column defaults -- used when a row doesn't exist yet (the
 *  seed trigger backfills one for every org, but defense in depth costs nothing here). */
export const DEFAULT_ORG_SPEND_SETTINGS: OrgSpendSettings = {
  monthly_spend_cap_usd: null,
  low_balance_alert_usd: 20,
  min_balance_to_dial_usd: 5,
  estimated_per_minute_rate_usd: 0.015,
  estimated_monthly_number_price_usd: 1.15,
  last_low_balance_alert_at: null,
};

export async function getOrgSpendSettings(
  supabase: SupabaseClient,
  orgId: string
): Promise<OrgSpendSettings> {
  const { data } = await supabase
    .from('org_spend_settings')
    .select(
      'monthly_spend_cap_usd, low_balance_alert_usd, min_balance_to_dial_usd, estimated_per_minute_rate_usd, estimated_monthly_number_price_usd, last_low_balance_alert_at'
    )
    .eq('org_id', orgId)
    .maybeSingle();
  return data ? { ...DEFAULT_ORG_SPEND_SETTINGS, ...data } : DEFAULT_ORG_SPEND_SETTINGS;
}

function monthStartUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
}

/** Sum of `duration_seconds` across every call_leg (both kind='contact' and 'agent' -- see
 *  spend-estimate.ts's own doc comment) created this UTC calendar month -- no per-org timezone
 *  column exists (same fact `dialing_hours_today`/team_view's own comments already document). */
export async function getMonthToDateBilledSeconds(
  supabase: SupabaseClient,
  orgId: string
): Promise<number> {
  const { data } = await supabase
    .from('call_legs')
    .select('duration_seconds')
    .eq('org_id', orgId)
    .not('duration_seconds', 'is', null)
    .gte('created_at', monthStartUtc().toISOString());
  return (data ?? []).reduce(
    (sum: number, r: { duration_seconds: number | null }) => sum + (r.duration_seconds ?? 0),
    0
  );
}

/** Every number currently on the org's account, any status -- Telnyx bills the monthly fee per
 *  number provisioned, not per number actively in rotation. */
export async function getOrgNumberCount(supabase: SupabaseClient, orgId: string): Promise<number> {
  const { count } = await supabase
    .from('user_phone_numbers')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId);
  return count ?? 0;
}

export type SpendSnapshot =
  | {
      ok: true;
      balanceUsd: number;
      availableCreditUsd: number;
      mtdSpendEstimateUsd: number;
      settings: OrgSpendSettings;
    }
  | { ok: false; reason: string };

/** The one place that actually calls Telnyx (`GET /balance`, verified stable/non-BETA -- see
 *  spend-estimate.ts) and combines it with our own MTD estimate. Never throws -- a Telnyx error,
 *  a missing/not-yet-connected key, or a DB error all come back as `{ok: false, reason}`, which
 *  every caller (the gate, the status display, the alert cron) is expected to handle by NOT
 *  blocking/alerting, not by surfacing a hard failure. */
export async function getOrgSpendSnapshot(
  supabase: SupabaseClient,
  orgId: string
): Promise<SpendSnapshot> {
  const settings = await getOrgSpendSettings(supabase, orgId);

  const { client, error } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (error || !client) {
    return { ok: false, reason: 'Telnyx is not connected for this org.' };
  }

  let balance;
  try {
    balance = await client.getBalance();
  } catch (err) {
    return {
      ok: false,
      reason: `Failed to reach the Telnyx balance API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const [billedSeconds, numberCount] = await Promise.all([
    getMonthToDateBilledSeconds(supabase, orgId),
    getOrgNumberCount(supabase, orgId),
  ]);
  const mtdSpendEstimateUsd = estimateMonthToDateSpendUsd({
    billedSecondsThisMonth: billedSeconds,
    numberCount,
    perMinuteRateUsd: settings.estimated_per_minute_rate_usd,
    monthlyNumberPriceUsd: settings.estimated_monthly_number_price_usd,
  });

  return {
    ok: true,
    balanceUsd: balance.balanceUsd,
    availableCreditUsd: balance.availableCreditUsd,
    mtdSpendEstimateUsd,
    settings,
  };
}

export interface SpendGateResult {
  blocked: boolean;
  code?: 'LOW_BALANCE' | 'SPEND_CAP_REACHED';
  message?: string;
}

/**
 * Fail OPEN: when the snapshot can't be fetched at all (Telnyx not connected, the key is
 * missing/invalid, or the balance API itself errors), dialing/purchasing is ALLOWED, with a
 * logged warning only -- design decision (task's own suggested default): a Telnyx API blip
 * blocking an entire team from dialing is worse than the residual risk, which the hourly
 * low-balance alert (spend-alert-check) and this same live check on every NEW Go Ready/purchase
 * already bound -- a real zero-balance org fails closed again the very next time this actually
 * succeeds in reaching Telnyx. Only a CONFIRMED low balance or CONFIRMED over-cap spend blocks.
 */
export async function checkSpendGate(
  supabase: SupabaseClient,
  orgId: string
): Promise<SpendGateResult> {
  const snapshot = await getOrgSpendSnapshot(supabase, orgId);
  if (!snapshot.ok) {
    console.warn(`[spend-gate] fail-open for org ${orgId}: ${snapshot.reason}`);
    return { blocked: false };
  }

  if (isBelowMinBalance(snapshot.availableCreditUsd, snapshot.settings.min_balance_to_dial_usd)) {
    return {
      blocked: true,
      code: 'LOW_BALANCE',
      message: `Your Telnyx balance ($${snapshot.availableCreditUsd.toFixed(2)}) is below the minimum required to dial ($${snapshot.settings.min_balance_to_dial_usd.toFixed(2)}). Add funds in your Telnyx account, or ask an owner/admin to lower the minimum in Settings.`,
    };
  }

  if (isOverSpendCap(snapshot.mtdSpendEstimateUsd, snapshot.settings.monthly_spend_cap_usd)) {
    return {
      blocked: true,
      code: 'SPEND_CAP_REACHED',
      message: `This org has reached its monthly spend cap ($${snapshot.settings.monthly_spend_cap_usd!.toFixed(2)}; estimated spend so far this month: $${snapshot.mtdSpendEstimateUsd.toFixed(2)}). Ask an owner/admin to raise the cap in Settings.`,
    };
  }

  return { blocked: false };
}

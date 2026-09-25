/**
 * TASK-SP (SEC-2 + the balance part of SEC-7): pure math for the monthly spend cap and
 * low-balance alert. Kept separate from I/O (spend-gate.ts) the same way analytics-core.ts
 * keeps the conversation/conversations-per-hour math pure and independently deno-tested --
 * `dialer-session-start`/`telnyx-purchase-number`/`spend-alert-check` have no test files of
 * their own (no Edge Function `index.ts` in this repo does), so the logic that matters lives
 * here instead.
 *
 * Telnyx's month-to-date spend has no cheap, reliable, non-BETA API (verified against
 * spec3.json, 2026-09-25 -- see decisions.md's TASK-SP entry for the full citation): `GET
 * /usage_reports` is explicitly tagged BETA with an undocumented `product` enum (only
 * discoverable live via `/usage_reports/options`) and unclear no-dimension aggregation
 * behavior; `/legacy/reporting/usage_reports/voice` is an async submit-then-poll report job,
 * not a synchronous per-org hourly-cron-safe call; `/detail_records` would mean paginating
 * every individual call record for the month just to sum a cost field. The task's own spec
 * explicitly allows falling back to an estimate when no reliable MTD API exists -- that's the
 * call made here, using our OWN call_legs data instead of asking Telnyx at all for the MTD
 * number (only the real-time balance, from the stable, non-BETA `GET /balance`, actually calls
 * Telnyx).
 */

export interface SpendEstimateInput {
  /** Sum of `call_legs.duration_seconds` (both kind='contact' and 'agent' -- a parallel-dial
   *  bridge places two real, separately-billed Telnyx calls per connected contact) for the org,
   *  month-to-date. `duration_seconds` is only ever written for a leg that actually ran (never
   *  for a losing/abandoned/machine leg, per analytics.md), so this is already exactly "billed
   *  call time," not raw dial-attempt time. */
  billedSecondsThisMonth: number;
  /** Every row currently in `user_phone_numbers` for the org, any status -- the monthly number
   *  fee is billed by Telnyx per number PROVISIONED, not per number actively dialing. */
  numberCount: number;
  perMinuteRateUsd: number;
  monthlyNumberPriceUsd: number;
}

/** Rounded to cents -- an "estimated" figure with more precision than that would be false
 *  confidence, not accuracy. */
export function estimateMonthToDateSpendUsd(input: SpendEstimateInput): number {
  const billedMinutes = input.billedSecondsThisMonth / 60;
  const callCost = billedMinutes * input.perMinuteRateUsd;
  const numberCost = input.numberCount * input.monthlyNumberPriceUsd;
  return Math.round((callCost + numberCost) * 100) / 100;
}

export function isBelowMinBalance(
  availableCreditUsd: number,
  minBalanceToDialUsd: number
): boolean {
  return availableCreditUsd < minBalanceToDialUsd;
}

/** `null` cap means "no cap" -- never blocks regardless of spend. */
export function isOverSpendCap(mtdSpendUsd: number, monthlySpendCapUsd: number | null): boolean {
  if (monthlySpendCapUsd === null) return false;
  return mtdSpendUsd >= monthlySpendCapUsd;
}

/** At most once per 12h per org (task's own dedupe rule). `lastAlertAt: null` means never
 *  alerted -- always due. */
export function isAlertDue(lastAlertAt: Date | null, now: Date): boolean {
  if (lastAlertAt === null) return true;
  const hoursSince = (now.getTime() - lastAlertAt.getTime()) / (1000 * 60 * 60);
  return hoursSince >= 12;
}

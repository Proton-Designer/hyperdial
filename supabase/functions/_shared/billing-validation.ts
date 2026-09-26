/**
 * TASK-BF1: pure validation, rate-limit math, and Telnyx error mapping for add funds +
 * auto-recharge. Kept separate from I/O (`telnyx-billing/index.ts`) the same way
 * spend-estimate.ts keeps the spend-cap math pure and independently deno-tested -- this is the
 * logic that matters for a real-money feature, so it lives here where it's cheap to exhaustively
 * test without a network call.
 *
 * The $5-$1,000 add-funds bounds and the $10-$5,000 auto-recharge bounds are this task's own
 * suggested defaults (Telnyx's spec places no min/max on these decimal-string fields at all --
 * verified against spec3.json's StoredPaymentTransactionRequest/AutoRechargePrefRequest schemas,
 * 2026-09-25), not a Telnyx-documented limit. The 1-per-60s / $2,000-per-24h rate limits are this
 * task's own explicit requirement, enforced by the edge function querying org_billing_events --
 * the pure math for "is this org currently rate-limited" lives here.
 */

export const MIN_ADD_FUNDS_USD = 5;
export const MAX_ADD_FUNDS_USD = 1000;
export const ADD_FUNDS_MIN_INTERVAL_SECONDS = 60;
export const ADD_FUNDS_DAILY_CAP_USD = 2000;

export const MIN_AUTO_RECHARGE_RECHARGE_USD = 10;
export const MAX_AUTO_RECHARGE_RECHARGE_USD = 5000;

export const AUTO_RECHARGE_PREFERENCES = ['credit_paypal', 'ach'] as const;
export type AutoRechargePreference = (typeof AUTO_RECHARGE_PREFERENCES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidIdempotencyKey(key: unknown): key is string {
  return typeof key === 'string' && UUID_RE.test(key);
}

export type AddFundsValidation = { ok: true; amountUsd: number } | { ok: false; error: string };

/** Rejects non-numbers, more than 2 decimal places, and anything outside
 *  [MIN_ADD_FUNDS_USD, MAX_ADD_FUNDS_USD]. Works in integer cents to avoid float-precision false
 *  rejects (e.g. 10.1 * 100 !== 1010 exactly in IEEE754). */
export function validateAddFundsAmount(amount: unknown): AddFundsValidation {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return { ok: false, error: 'Amount must be a number.' };
  }
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) {
    return { ok: false, error: 'Amount can have at most 2 decimal places.' };
  }
  const rounded = cents / 100;
  if (rounded < MIN_ADD_FUNDS_USD) {
    return { ok: false, error: `Amount must be at least $${MIN_ADD_FUNDS_USD.toFixed(2)}.` };
  }
  if (rounded > MAX_ADD_FUNDS_USD) {
    return {
      ok: false,
      error: `Amount cannot exceed $${MAX_ADD_FUNDS_USD.toFixed(2)} per charge.`,
    };
  }
  return { ok: true, amountUsd: rounded };
}

export interface AutoRechargePrefsInput {
  enabled: unknown;
  thresholdAmountUsd: unknown;
  rechargeAmountUsd: unknown;
  invoiceEnabled: unknown;
  preference: unknown;
}

export interface ValidAutoRechargePrefs {
  enabled: boolean;
  thresholdAmountUsd: number;
  rechargeAmountUsd: number;
  invoiceEnabled: boolean;
  preference: AutoRechargePreference;
}

export type AutoRechargePrefsValidation =
  { ok: true; value: ValidAutoRechargePrefs } | { ok: false; error: string };

export function validateAutoRechargePrefs(
  input: AutoRechargePrefsInput
): AutoRechargePrefsValidation {
  if (typeof input.enabled !== 'boolean') {
    return { ok: false, error: 'enabled must be a boolean.' };
  }
  if (
    typeof input.thresholdAmountUsd !== 'number' ||
    !Number.isFinite(input.thresholdAmountUsd) ||
    input.thresholdAmountUsd < 0
  ) {
    return { ok: false, error: 'Threshold amount must be a number >= 0.' };
  }
  if (
    typeof input.rechargeAmountUsd !== 'number' ||
    !Number.isFinite(input.rechargeAmountUsd) ||
    input.rechargeAmountUsd < MIN_AUTO_RECHARGE_RECHARGE_USD ||
    input.rechargeAmountUsd > MAX_AUTO_RECHARGE_RECHARGE_USD
  ) {
    return {
      ok: false,
      error: `Recharge amount must be between $${MIN_AUTO_RECHARGE_RECHARGE_USD.toFixed(2)} and $${MAX_AUTO_RECHARGE_RECHARGE_USD.toFixed(2)}.`,
    };
  }
  if (typeof input.invoiceEnabled !== 'boolean') {
    return { ok: false, error: 'invoiceEnabled must be a boolean.' };
  }
  if (!AUTO_RECHARGE_PREFERENCES.includes(input.preference as AutoRechargePreference)) {
    return {
      ok: false,
      error: `preference must be one of: ${AUTO_RECHARGE_PREFERENCES.join(', ')}.`,
    };
  }
  return {
    ok: true,
    value: {
      enabled: input.enabled,
      thresholdAmountUsd: input.thresholdAmountUsd,
      rechargeAmountUsd: input.rechargeAmountUsd,
      invoiceEnabled: input.invoiceEnabled,
      preference: input.preference as AutoRechargePreference,
    },
  };
}

/** At most 1 SUCCESSFUL add_funds per org per ADD_FUNDS_MIN_INTERVAL_SECONDS -- `lastSucceededAt:
 *  null` means never succeeded, never rate-limited. */
export function isAddFundsRateLimited(lastSucceededAt: Date | null, now: Date): boolean {
  if (lastSucceededAt === null) return false;
  const secondsSince = (now.getTime() - lastSucceededAt.getTime()) / 1000;
  return secondsSince < ADD_FUNDS_MIN_INTERVAL_SECONDS;
}

/** At most ADD_FUNDS_DAILY_CAP_USD of SUCCESSFUL add_funds per org per rolling 24h --
 *  `succeededLast24hUsd` is the caller's own sum of the last 24h of succeeded rows, this new
 *  charge would add on top of. */
export function wouldExceedDailyAddFundsCap(
  amountUsd: number,
  succeededLast24hUsd: number
): boolean {
  return succeededLast24hUsd + amountUsd > ADD_FUNDS_DAILY_CAP_USD;
}

const HTTP_STATUS_RE = /\((\d{3})\)/;

export type AddFundsFailureKind = 'definitive' | 'ambiguous';

/** TASK-BF1 fix (lead + eng2 review, MEDIUM): classifies a thrown telnyx-client add-funds error
 *  for retry semantics. `telnyxRequest`'s own error message always embeds the HTTP status in
 *  parens for a real (non-2xx) Telnyx response (`Telnyx API POST ... failed (422): ...`) -- a 4xx
 *  means Telnyx received and definitively rejected the request (bad key, declined card, no
 *  payment method, invalid amount): no charge was attempted, so it's safe to free the
 *  idempotency key and let the caller retry with a fresh one. A 5xx, OR no status at all (the
 *  `fetch` call itself never got a response -- a network error or timeout), means Telnyx may or
 *  may not have actually processed the charge -- the key must NOT be freed, so a same-key retry
 *  stays blocked by the unique index until a human checks the real balance. */
export function classifyAddFundsFailure(err: unknown): AddFundsFailureKind {
  const raw = err instanceof Error ? err.message : String(err);
  const match = raw.match(HTTP_STATUS_RE);
  if (!match) return 'ambiguous';
  const status = Number(match[1]);
  return status >= 400 && status < 500 ? 'definitive' : 'ambiguous';
}

export interface MappedBillingError {
  code:
    'FORBIDDEN_KEY' | 'NO_PAYMENT_METHOD' | 'CARD_DECLINED' | 'VALIDATION_ERROR' | 'TELNYX_ERROR';
  message: string;
}

/** Best-effort mapping of a thrown `_shared/telnyx-client.ts` error (its `.message` embeds the
 *  HTTP status and the raw JSON-stringified Telnyx error body, see `telnyxRequest`) to a clear,
 *  user-facing message. Telnyx's spec (ErrorResponse) documents the SHAPE of these errors
 *  (`{errors: [{code, title, detail, ...}]}`) but not their exact wording for a declined
 *  card/missing payment method/forbidden key -- this is keyword matching on status + detail
 *  text, not a verified enum, and intentionally falls back to surfacing the raw detail rather
 *  than a wrong specific category. Never retries -- mapping an error is not the same as
 *  recovering from it. */
export function mapTelnyxBillingError(err: unknown): MappedBillingError {
  const raw = err instanceof Error ? err.message : String(err);
  if (raw.includes('(401)') || raw.includes('(403)')) {
    return {
      code: 'FORBIDDEN_KEY',
      message:
        "Your Telnyx API key doesn't have permission to charge the stored payment method. Check its scopes in the Telnyx portal.",
    };
  }
  if (raw.includes('(422)')) {
    if (/no.{0,20}(stored )?payment method|payment.{0,10}not.{0,10}found/i.test(raw)) {
      return {
        code: 'NO_PAYMENT_METHOD',
        message:
          'No payment method is saved on this Telnyx account yet. Add a card in the Telnyx portal first.',
      };
    }
    if (/declin/i.test(raw)) {
      return {
        code: 'CARD_DECLINED',
        message: 'The saved payment method was declined. Check it in the Telnyx portal.',
      };
    }
    return { code: 'VALIDATION_ERROR', message: `Telnyx rejected the request: ${raw}` };
  }
  return { code: 'TELNYX_ERROR', message: `Failed to reach Telnyx: ${raw}` };
}

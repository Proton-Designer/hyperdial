import { assertEquals } from 'jsr:@std/assert@1';
import {
  classifyAddFundsFailure,
  isAddFundsRateLimited,
  isValidIdempotencyKey,
  mapTelnyxBillingError,
  validateAddFundsAmount,
  validateAutoRechargePrefs,
  wouldExceedDailyAddFundsCap,
} from './billing-validation.ts';

// ---------------------------------------------------------------------------
// validateAddFundsAmount
// ---------------------------------------------------------------------------

Deno.test('validateAddFundsAmount: accepts an amount within bounds', () => {
  const result = validateAddFundsAmount(25);
  assertEquals(result, { ok: true, amountUsd: 25 });
});

Deno.test('validateAddFundsAmount: accepts the exact min and max bounds', () => {
  assertEquals(validateAddFundsAmount(5), { ok: true, amountUsd: 5 });
  assertEquals(validateAddFundsAmount(200), { ok: true, amountUsd: 200 });
});

Deno.test('validateAddFundsAmount: rejects below the minimum', () => {
  const result = validateAddFundsAmount(4.99);
  assertEquals(result.ok, false);
});

Deno.test('validateAddFundsAmount: rejects above the maximum', () => {
  const result = validateAddFundsAmount(200.01);
  assertEquals(result.ok, false);
});

Deno.test(
  'validateAddFundsAmount: TASK-BF2 -- rejects the OLD $1,000 max, now well above the $200 limit',
  () => {
    const result = validateAddFundsAmount(1000);
    assertEquals(result.ok, false);
  }
);

Deno.test('validateAddFundsAmount: rejects more than 2 decimal places', () => {
  const result = validateAddFundsAmount(25.005);
  assertEquals(result.ok, false);
});

Deno.test('validateAddFundsAmount: accepts exactly 2 decimal places', () => {
  assertEquals(validateAddFundsAmount(25.5), { ok: true, amountUsd: 25.5 });
});

Deno.test('validateAddFundsAmount: rejects non-numeric input', () => {
  assertEquals(validateAddFundsAmount('25').ok, false);
  assertEquals(validateAddFundsAmount(null).ok, false);
  assertEquals(validateAddFundsAmount(undefined).ok, false);
  assertEquals(validateAddFundsAmount(NaN).ok, false);
  assertEquals(validateAddFundsAmount(Infinity).ok, false);
});

// ---------------------------------------------------------------------------
// validateAutoRechargePrefs
// ---------------------------------------------------------------------------

const VALID_PREFS = {
  enabled: true,
  thresholdAmountUsd: 20,
  rechargeAmountUsd: 100,
  invoiceEnabled: false,
  preference: 'credit_paypal',
};

Deno.test('validateAutoRechargePrefs: accepts a valid input', () => {
  const result = validateAutoRechargePrefs(VALID_PREFS);
  assertEquals(result.ok, true);
});

Deno.test('validateAutoRechargePrefs: rejects a negative threshold', () => {
  const result = validateAutoRechargePrefs({ ...VALID_PREFS, thresholdAmountUsd: -1 });
  assertEquals(result.ok, false);
});

Deno.test('validateAutoRechargePrefs: accepts a zero threshold (>= 0)', () => {
  const result = validateAutoRechargePrefs({ ...VALID_PREFS, thresholdAmountUsd: 0 });
  assertEquals(result.ok, true);
});

Deno.test('validateAutoRechargePrefs: rejects a recharge amount below the $10 floor', () => {
  const result = validateAutoRechargePrefs({ ...VALID_PREFS, rechargeAmountUsd: 9.99 });
  assertEquals(result.ok, false);
});

Deno.test('validateAutoRechargePrefs: rejects a recharge amount above the $5,000 ceiling', () => {
  const result = validateAutoRechargePrefs({ ...VALID_PREFS, rechargeAmountUsd: 5000.01 });
  assertEquals(result.ok, false);
});

Deno.test('validateAutoRechargePrefs: rejects a preference outside the enum', () => {
  const result = validateAutoRechargePrefs({ ...VALID_PREFS, preference: 'bitcoin' });
  assertEquals(result.ok, false);
});

Deno.test('validateAutoRechargePrefs: accepts ach as well as credit_paypal', () => {
  const result = validateAutoRechargePrefs({ ...VALID_PREFS, preference: 'ach' });
  assertEquals(result.ok, true);
});

Deno.test('validateAutoRechargePrefs: rejects non-boolean enabled/invoiceEnabled', () => {
  assertEquals(validateAutoRechargePrefs({ ...VALID_PREFS, enabled: 'yes' }).ok, false);
  assertEquals(validateAutoRechargePrefs({ ...VALID_PREFS, invoiceEnabled: 1 }).ok, false);
});

// ---------------------------------------------------------------------------
// isValidIdempotencyKey
// ---------------------------------------------------------------------------

Deno.test('isValidIdempotencyKey: accepts a real UUID', () => {
  assertEquals(isValidIdempotencyKey('98200000-0000-4000-8000-0000000000a1'), true);
});

Deno.test('isValidIdempotencyKey: rejects a non-UUID string and non-strings', () => {
  assertEquals(isValidIdempotencyKey('not-a-uuid'), false);
  assertEquals(isValidIdempotencyKey(''), false);
  assertEquals(isValidIdempotencyKey(null), false);
  assertEquals(isValidIdempotencyKey(12345), false);
});

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

Deno.test('isAddFundsRateLimited: never succeeded before -> not rate-limited', () => {
  assertEquals(isAddFundsRateLimited(null, new Date()), false);
});

Deno.test('isAddFundsRateLimited: a success 30s ago is still within the 60s window', () => {
  const now = new Date('2026-09-25T12:01:00Z');
  const last = new Date('2026-09-25T12:00:30Z');
  assertEquals(isAddFundsRateLimited(last, now), true);
});

Deno.test('isAddFundsRateLimited: a success 61s ago has cleared the window', () => {
  const now = new Date('2026-09-25T12:01:01Z');
  const last = new Date('2026-09-25T12:00:00Z');
  assertEquals(isAddFundsRateLimited(last, now), false);
});

Deno.test('wouldExceedDailyAddFundsCap: under the $2,000/24h cap is allowed', () => {
  assertEquals(wouldExceedDailyAddFundsCap(100, 1000), false);
});

Deno.test('wouldExceedDailyAddFundsCap: exactly at the cap is allowed (not exceeding)', () => {
  assertEquals(wouldExceedDailyAddFundsCap(1000, 1000), false);
});

Deno.test('wouldExceedDailyAddFundsCap: over the cap is refused', () => {
  assertEquals(wouldExceedDailyAddFundsCap(1000.01, 1000), true);
});

// ---------------------------------------------------------------------------
// mapTelnyxBillingError
// ---------------------------------------------------------------------------

Deno.test('mapTelnyxBillingError: 403 -> FORBIDDEN_KEY', () => {
  const result = mapTelnyxBillingError(new Error('Telnyx API POST /payment/x failed (403): {}'));
  assertEquals(result.code, 'FORBIDDEN_KEY');
});

Deno.test('mapTelnyxBillingError: 401 -> FORBIDDEN_KEY', () => {
  const result = mapTelnyxBillingError(new Error('Telnyx API POST /payment/x failed (401): {}'));
  assertEquals(result.code, 'FORBIDDEN_KEY');
});

Deno.test('mapTelnyxBillingError: 422 with "declined" in the body -> CARD_DECLINED', () => {
  const result = mapTelnyxBillingError(
    new Error('Telnyx API POST /payment/x failed (422): {"errors":[{"detail":"card declined"}]}')
  );
  assertEquals(result.code, 'CARD_DECLINED');
});

Deno.test(
  'mapTelnyxBillingError: 422 with "payment method" in the body -> NO_PAYMENT_METHOD',
  () => {
    const result = mapTelnyxBillingError(
      new Error(
        'Telnyx API POST /payment/x failed (422): {"errors":[{"detail":"no stored payment method on file"}]}'
      )
    );
    assertEquals(result.code, 'NO_PAYMENT_METHOD');
  }
);

Deno.test(
  'mapTelnyxBillingError: an unrecognized 422 falls back to VALIDATION_ERROR with the raw detail',
  () => {
    const result = mapTelnyxBillingError(
      new Error('Telnyx API POST /payment/x failed (422): {"errors":[{"detail":"something else"}]}')
    );
    assertEquals(result.code, 'VALIDATION_ERROR');
  }
);

Deno.test(
  'mapTelnyxBillingError: anything else -> TELNYX_ERROR, never fabricated as a specific category',
  () => {
    const result = mapTelnyxBillingError(new Error('fetch failed: network error'));
    assertEquals(result.code, 'TELNYX_ERROR');
  }
);

// ---------------------------------------------------------------------------
// classifyAddFundsFailure -- TASK-BF1 fix (lead + eng2 review, MEDIUM)
// ---------------------------------------------------------------------------

Deno.test('classifyAddFundsFailure: 400 is definitive', () => {
  assertEquals(
    classifyAddFundsFailure(new Error('Telnyx API POST /payment/x failed (400): {}')),
    'definitive'
  );
});

Deno.test('classifyAddFundsFailure: 401/403 (forbidden key) is definitive', () => {
  assertEquals(
    classifyAddFundsFailure(new Error('Telnyx API POST /payment/x failed (401): {}')),
    'definitive'
  );
  assertEquals(
    classifyAddFundsFailure(new Error('Telnyx API POST /payment/x failed (403): {}')),
    'definitive'
  );
});

Deno.test(
  'classifyAddFundsFailure: 422 (declined / no payment method / invalid) is definitive',
  () => {
    assertEquals(
      classifyAddFundsFailure(new Error('Telnyx API POST /payment/x failed (422): {}')),
      'definitive'
    );
  }
);

Deno.test('classifyAddFundsFailure: 499 is still definitive (upper edge of the 4xx range)', () => {
  assertEquals(
    classifyAddFundsFailure(new Error('Telnyx API POST /payment/x failed (499): {}')),
    'definitive'
  );
});

Deno.test('classifyAddFundsFailure: 500/502/503 are ambiguous, not definitive', () => {
  assertEquals(
    classifyAddFundsFailure(new Error('Telnyx API POST /payment/x failed (500): {}')),
    'ambiguous'
  );
  assertEquals(
    classifyAddFundsFailure(new Error('Telnyx API POST /payment/x failed (502): {}')),
    'ambiguous'
  );
  assertEquals(
    classifyAddFundsFailure(new Error('Telnyx API POST /payment/x failed (503): {}')),
    'ambiguous'
  );
});

Deno.test(
  'classifyAddFundsFailure: a network error/timeout with no status code at all is ambiguous',
  () => {
    assertEquals(
      classifyAddFundsFailure(new Error('TypeError: error sending request (connection reset)')),
      'ambiguous'
    );
    assertEquals(classifyAddFundsFailure(new Error('The operation timed out')), 'ambiguous');
  }
);

Deno.test('classifyAddFundsFailure: a non-Error thrown value falls back to String()', () => {
  assertEquals(classifyAddFundsFailure('some string'), 'ambiguous');
});

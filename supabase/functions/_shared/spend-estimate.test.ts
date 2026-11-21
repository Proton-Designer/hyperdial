import { assertEquals } from 'jsr:@std/assert@1';
import {
  estimateMonthToDateSpendUsd,
  isBelowMinBalance,
  isOverSpendCap,
  isAlertDue,
} from './spend-estimate.ts';

Deno.test('estimateMonthToDateSpendUsd: call minutes x rate + numbers x price', () => {
  const result = estimateMonthToDateSpendUsd({
    billedSecondsThisMonth: 6000, // 100 minutes
    numberCount: 3,
    perMinuteRateUsd: 0.015,
    monthlyNumberPriceUsd: 1.15,
  });
  // 100 * 0.015 = 1.5, 3 * 1.15 = 3.45, total 4.95
  assertEquals(result, 4.95);
});

Deno.test('estimateMonthToDateSpendUsd: zero calls and zero numbers is zero, not an error', () => {
  const result = estimateMonthToDateSpendUsd({
    billedSecondsThisMonth: 0,
    numberCount: 0,
    perMinuteRateUsd: 0.015,
    monthlyNumberPriceUsd: 1.15,
  });
  assertEquals(result, 0);
});

Deno.test('estimateMonthToDateSpendUsd: rounds to the nearest cent', () => {
  const result = estimateMonthToDateSpendUsd({
    billedSecondsThisMonth: 37, // 0.6166... minutes
    numberCount: 0,
    perMinuteRateUsd: 0.017,
    monthlyNumberPriceUsd: 1,
  });
  // 0.61666... * 0.017 = 0.010483... -> rounds to 0.01
  assertEquals(result, 0.01);
});

Deno.test('isBelowMinBalance: strictly less than, not less-than-or-equal', () => {
  assertEquals(isBelowMinBalance(4.99, 5), true);
  assertEquals(isBelowMinBalance(5, 5), false);
  assertEquals(isBelowMinBalance(5.01, 5), false);
});

Deno.test('isOverSpendCap: null cap never blocks', () => {
  assertEquals(isOverSpendCap(1_000_000, null), false);
});

Deno.test('isOverSpendCap: greater-than-or-equal (hitting the cap exactly blocks)', () => {
  assertEquals(isOverSpendCap(99.99, 100), false);
  assertEquals(isOverSpendCap(100, 100), true);
  assertEquals(isOverSpendCap(100.01, 100), true);
});

Deno.test('isAlertDue: never alerted before is always due', () => {
  assertEquals(isAlertDue(null, new Date('2026-09-25T12:00:00Z')), true);
});

Deno.test('isAlertDue: under 12h since the last alert is not due', () => {
  const lastAlert = new Date('2026-09-25T00:00:00Z');
  const now = new Date('2026-09-25T11:59:00Z');
  assertEquals(isAlertDue(lastAlert, now), false);
});

Deno.test('isAlertDue: exactly 12h and beyond is due', () => {
  const lastAlert = new Date('2026-09-25T00:00:00Z');
  assertEquals(isAlertDue(lastAlert, new Date('2026-09-25T12:00:00Z')), true);
  assertEquals(isAlertDue(lastAlert, new Date('2026-09-25T13:00:00Z')), true);
});

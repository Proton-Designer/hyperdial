import { assertEquals, assert } from 'jsr:@std/assert@1';
import {
  TIME_BLOCKS,
  timeBlockFor,
  nextBlock,
  rotatedRetrySchedule,
  resolveRetryDecision,
  type TimeBlock,
} from './queue-retry-rules.ts';

// ---------------------------------------------------------------------------
// timeBlockFor
// ---------------------------------------------------------------------------

// UTC dates chosen so America/Chicago (UTC-5 in September, DST) lands exactly on each boundary
// hour. 2026-09-15 is a fixed, non-DST-transition date for the "boundary hours" set.
Deno.test('timeBlockFor: boundary hours in America/Chicago', () => {
  const tz = 'America/Chicago';
  // 10:00 local = 15:00 UTC -> morning (still < 11)
  assertEquals(timeBlockFor(new Date('2026-09-15T15:00:00Z'), tz), 'morning');
  // 11:00 local = 16:00 UTC -> lunch
  assertEquals(timeBlockFor(new Date('2026-09-15T16:00:00Z'), tz), 'lunch');
  // 13:00 local = 18:00 UTC -> lunch
  assertEquals(timeBlockFor(new Date('2026-09-15T18:00:00Z'), tz), 'lunch');
  // 14:00 local = 19:00 UTC -> afternoon
  assertEquals(timeBlockFor(new Date('2026-09-15T19:00:00Z'), tz), 'afternoon');
  // 15:00 local = 20:00 UTC -> afternoon
  assertEquals(timeBlockFor(new Date('2026-09-15T20:00:00Z'), tz), 'afternoon');
  // 16:00 local = 21:00 UTC -> drive
  assertEquals(timeBlockFor(new Date('2026-09-15T21:00:00Z'), tz), 'drive');
  // 18:00 local = 23:00 UTC -> drive
  assertEquals(timeBlockFor(new Date('2026-09-15T23:00:00Z'), tz), 'drive');
  // 19:00 local = 00:00 UTC (next day) -> evening
  assertEquals(timeBlockFor(new Date('2026-09-16T00:00:00Z'), tz), 'evening');
  // 20:00 local = 01:00 UTC (next day) -> evening
  assertEquals(timeBlockFor(new Date('2026-09-16T01:00:00Z'), tz), 'evening');
});

// A non-US, non-hour-aligned-with-Chicago timezone proves the function isn't hardcoded to one
// offset. Asia/Kolkata is UTC+5:30.
Deno.test('timeBlockFor: not hardcoded to a US offset (Asia/Kolkata)', () => {
  const tz = 'Asia/Kolkata';
  // 09:30 local = 04:00 UTC -> morning
  assertEquals(timeBlockFor(new Date('2026-09-15T04:00:00Z'), tz), 'morning');
  // 12:30 local = 07:00 UTC -> lunch
  assertEquals(timeBlockFor(new Date('2026-09-15T07:00:00Z'), tz), 'lunch');
  // 20:30 local = 15:00 UTC -> evening
  assertEquals(timeBlockFor(new Date('2026-09-15T15:00:00Z'), tz), 'evening');
});

// ---------------------------------------------------------------------------
// nextBlock
// ---------------------------------------------------------------------------

Deno.test('nextBlock: full cycle, in order', () => {
  assertEquals(nextBlock('morning'), 'lunch');
  assertEquals(nextBlock('lunch'), 'afternoon');
  assertEquals(nextBlock('afternoon'), 'drive');
  assertEquals(nextBlock('drive'), 'evening');
});

Deno.test('nextBlock: wraps evening back to morning', () => {
  assertEquals(nextBlock('evening'), 'morning');
});

Deno.test('nextBlock: null input rotates to morning', () => {
  assertEquals(nextBlock(null), 'morning');
});

Deno.test(
  'nextBlock: every block in TIME_BLOCKS is reachable and none repeats within one cycle',
  () => {
    const seen = new Set<TimeBlock>();
    let current: TimeBlock | null = null;
    for (let i = 0; i < TIME_BLOCKS.length; i++) {
      current = nextBlock(current);
      assert(!seen.has(current), `block ${current} repeated before a full cycle completed`);
      seen.add(current);
    }
    assertEquals(seen.size, TIME_BLOCKS.length);
  }
);

// ---------------------------------------------------------------------------
// rotatedRetrySchedule
// ---------------------------------------------------------------------------

Deno.test('rotatedRetrySchedule: rotates to the block after lastBlock', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const result = rotatedRetrySchedule('morning', 'America/Chicago', 4, now);
  assertEquals(result.nextBlock, 'lunch');
});

Deno.test(
  "rotatedRetrySchedule: lands delayDays out, at the rotated block's start hour, local time",
  () => {
    const now = new Date('2026-09-15T12:00:00Z'); // 2026-09-15 in America/Chicago (non-DST-transition week)
    const tz = 'America/Chicago';
    const result = rotatedRetrySchedule('morning', tz, 4, now);
    assertEquals(result.nextBlock, 'lunch');
    // lunch starts at hour 11, 4 days out from 2026-09-15 -> 2026-09-19, 11:00 local.
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: 'numeric',
      hour12: false,
    }).formatToParts(result.nextAttemptAt);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    assertEquals(get('year'), '2026');
    assertEquals(get('month'), '09');
    assertEquals(get('day'), '19');
    assertEquals(Number(get('hour')) % 24, 11);
  }
);

// Positive control for the DST correction: America/Chicago falls back on 2026-11-01. A delay
// that crosses this boundary must still land on the correct LOCAL hour, not an hour shifted by
// the UTC-offset change -- proving the two-pass correction actually does something, not just
// that the function returns some date.
Deno.test(
  'rotatedRetrySchedule: DST-safe across a fall-back transition (America/Chicago, 2026-11-01)',
  () => {
    const tz = 'America/Chicago';
    const now = new Date('2026-10-29T12:00:00Z'); // several days before the Nov 1 fall-back
    const result = rotatedRetrySchedule('drive', tz, 4, now); // -> evening, hour 19, target ~2026-11-02
    assertEquals(result.nextBlock, 'evening');
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    }).formatToParts(result.nextAttemptAt);
    const hour = Number(parts.find((p) => p.type === 'hour')?.value) % 24;
    assertEquals(
      hour,
      19,
      'the corrected local hour must still be exactly the block start hour across a DST transition'
    );
  }
);

Deno.test('rotatedRetrySchedule: delayDays is floored to at least 1', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const zeroResult = rotatedRetrySchedule('morning', 'America/Chicago', 0, now);
  const oneResult = rotatedRetrySchedule('morning', 'America/Chicago', 1, now);
  assertEquals(zeroResult.nextAttemptAt.getTime(), oneResult.nextAttemptAt.getTime());
});

// ---------------------------------------------------------------------------
// resolveRetryDecision
// ---------------------------------------------------------------------------

Deno.test('resolveRetryDecision: an "out" rule exhausts regardless of attempts', () => {
  const result = resolveRetryDecision({
    rule: { action: 'out', delayMinutes: null, rotateBlock: false },
    currentAttempts: 0,
    incrementedAttempts: 1,
    maxAttempts: 3,
    lastBlock: 'morning',
    tz: 'America/Chicago',
    fallbackRetryMinutes: 120,
  });
  assertEquals(result.status, 'exhausted');
  assertEquals(result.nextAttemptAt, null);
});

// The important ordering guarantee: max_attempts overrides a 'retry' rule. Positive control: the
// SAME rule, at a lower attempts count, DOES schedule a retry -- proving the max_attempts branch
// is what fired, not that the rule was simply ignored.
Deno.test(
  'resolveRetryDecision: max_attempts overrides a retry rule (with positive control)',
  () => {
    const rule = { action: 'retry' as const, delayMinutes: 5760, rotateBlock: true };
    const below = resolveRetryDecision({
      rule,
      currentAttempts: 1,
      incrementedAttempts: 2,
      maxAttempts: 3,
      lastBlock: 'morning',
      tz: 'America/Chicago',
      fallbackRetryMinutes: 120,
    });
    assertEquals(
      below.status,
      'queued',
      'positive control: below max_attempts, the retry rule should schedule a retry'
    );
    assert(below.nextAttemptAt !== null);

    const atMax = resolveRetryDecision({
      rule,
      currentAttempts: 2,
      incrementedAttempts: 3,
      maxAttempts: 3,
      lastBlock: 'morning',
      tz: 'America/Chicago',
      fallbackRetryMinutes: 120,
    });
    assertEquals(atMax.status, 'exhausted');
    assertEquals(atMax.nextAttemptAt, null);
  }
);

Deno.test('resolveRetryDecision: retry + rotate_block rotates to the next block', () => {
  const result = resolveRetryDecision({
    rule: { action: 'retry', delayMinutes: 5760, rotateBlock: true },
    currentAttempts: 0,
    incrementedAttempts: 1,
    maxAttempts: 3,
    lastBlock: 'morning',
    tz: 'America/Chicago',
    fallbackRetryMinutes: 120,
    now: new Date('2026-09-15T12:00:00Z'),
  });
  assertEquals(result.status, 'queued');
  assert(result.nextAttemptAt !== null);
  // 4 days (5760 min) out, block rotates morning -> lunch, so the hour must be 11 local.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(result.nextAttemptAt as Date);
  assertEquals(Number(parts.find((p) => p.type === 'hour')?.value) % 24, 11);
});

Deno.test(
  'resolveRetryDecision: retry without rotate_block is a flat delay, not a block-aligned time',
  () => {
    const now = new Date('2026-09-15T12:00:00Z');
    const result = resolveRetryDecision({
      rule: { action: 'retry', delayMinutes: 1440, rotateBlock: false },
      currentAttempts: 0,
      incrementedAttempts: 1,
      maxAttempts: 3,
      lastBlock: 'morning',
      tz: 'America/Chicago',
      fallbackRetryMinutes: 120,
      now,
    });
    assertEquals(result.status, 'queued');
    assert(result.nextAttemptAt !== null);
    assertEquals((result.nextAttemptAt as Date).getTime(), now.getTime() + 24 * 60 * 60 * 1000);
  }
);

Deno.test('resolveRetryDecision: no rule at all falls back to the flat retry interval', () => {
  const now = new Date('2026-09-15T12:00:00Z');
  const result = resolveRetryDecision({
    rule: null,
    currentAttempts: 0,
    incrementedAttempts: 1,
    maxAttempts: 3,
    lastBlock: 'morning',
    tz: 'America/Chicago',
    fallbackRetryMinutes: 90,
    now,
  });
  assertEquals(result.status, 'queued');
  assertEquals((result.nextAttemptAt as Date).getTime(), now.getTime() + 90 * 60 * 1000);
});

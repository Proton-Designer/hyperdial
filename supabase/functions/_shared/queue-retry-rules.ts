// TASK-F-T1 (QUE-2/QUE-5): a pure TS twin of private.time_block_for / private.rotated_retry_schedule
// (supabase/migrations/20260925030000_queue_v2_retry_dnc.sql). NOT called by any runtime code --
// every retry decision this build makes happens atomically inside one SQL function call
// (claim_next_leads / apply_leg_outcome / submit_disposition), so there's no "TS decides, SQL
// enacts" split here the way dialer-core.ts's legTransition precedes transition_leg. This file
// exists purely so the block-rotation algorithm is deno-testable (local Docker is retired, so the
// SQL side can only be verified via the live dry-run). Keep both in sync if the block boundaries
// or rotation order ever change.

export const TIME_BLOCKS = ['morning', 'lunch', 'afternoon', 'drive', 'evening'] as const;

export type TimeBlock = (typeof TIME_BLOCKS)[number];

const BLOCK_START_HOUR: Record<TimeBlock, number> = {
  morning: 8,
  lunch: 11,
  afternoon: 14,
  drive: 16,
  evening: 19,
};

function localHour(date: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
  // "24" shows up for midnight under hour12:false in some ICU implementations.
  return Number(hourPart) % 24;
}

function localYMD(date: Date, tz: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

// Mirrors private.time_block_for's cascading hour check exactly.
export function timeBlockFor(date: Date, tz: string): TimeBlock {
  const hour = localHour(date, tz);
  if (hour < 11) return 'morning';
  if (hour < 14) return 'lunch';
  if (hour < 16) return 'afternoon';
  if (hour < 19) return 'drive';
  return 'evening';
}

// Cyclic rotation, matching private.rotated_retry_schedule's array-position + modulo arithmetic.
// null/unrecognized is treated as "before morning" so it rotates TO morning (index 0 -> +1 mod 5).
export function nextBlock(current: TimeBlock | null): TimeBlock {
  // null/unrecognized -> -1, so -1+1=0 ("morning") -- mirrors the SQL's
  // coalesce(array_position(...), 0) landing on v_order[1] ("morning") for a null last_block.
  const idx = current ? TIME_BLOCKS.indexOf(current) : -1;
  return TIME_BLOCKS[(idx + 1) % TIME_BLOCKS.length];
}

// Mirrors private.rotated_retry_schedule: the start of the next-day's (or delayDays-out) slot in
// the block immediately after lastBlock. DST-safe via a two-pass correction: build a naive UTC
// guess from the target local Y/M/D + block-start hour, re-read what LOCAL hour that guess
// actually lands on in tz, then shift by the difference -- cheap substitute for a real tz library
// this repo doesn't depend on.
export function rotatedRetrySchedule(
  lastBlock: TimeBlock | null,
  tz: string,
  delayDays: number,
  now: Date = new Date()
): { nextAttemptAt: Date; nextBlock: TimeBlock } {
  const block = nextBlock(lastBlock);
  const targetHour = BLOCK_START_HOUR[block];
  const days = Math.max(1, delayDays);

  const target = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const { year, month, day } = localYMD(target, tz);

  // First-pass naive guess: treat the target Y/M/D + targetHour as if it were UTC.
  const guess = new Date(Date.UTC(year, month - 1, day, targetHour, 0, 0));
  const observedHour = localHour(guess, tz);
  const diffHours = targetHour - observedHour;
  const corrected = new Date(guess.getTime() + diffHours * 60 * 60 * 1000);

  return { nextAttemptAt: corrected, nextBlock: block };
}

export interface RetryRule {
  action: 'retry' | 'out' | 'exact_time';
  delayMinutes: number | null;
  rotateBlock: boolean;
}

export interface ResolveRetryDecisionArgs {
  rule: RetryRule | null;
  currentAttempts: number;
  incrementedAttempts: number;
  maxAttempts: number;
  lastBlock: TimeBlock | null;
  tz: string;
  fallbackRetryMinutes: number;
  now?: Date;
}

export interface RetryDecision {
  status: 'exhausted' | 'queued';
  nextAttemptAt: Date | null;
}

// Mirrors both SQL functions' identical branch precedence: out -> max_attempts (the hard
// ceiling, checked BEFORE any retry rule) -> retry (rotated or flat) -> the pre-existing flat
// fallback interval.
export function resolveRetryDecision(args: ResolveRetryDecisionArgs): RetryDecision {
  const {
    rule,
    incrementedAttempts,
    maxAttempts,
    lastBlock,
    tz,
    fallbackRetryMinutes,
    now = new Date(),
  } = args;

  if (rule && rule.action === 'out') {
    return { status: 'exhausted', nextAttemptAt: null };
  }

  if (incrementedAttempts >= maxAttempts) {
    return { status: 'exhausted', nextAttemptAt: null };
  }

  if (rule && rule.action === 'retry') {
    const delayDays = Math.max(1, Math.floor((rule.delayMinutes ?? 0) / 1440));
    if (rule.rotateBlock) {
      const { nextAttemptAt } = rotatedRetrySchedule(lastBlock, tz, delayDays, now);
      return { status: 'queued', nextAttemptAt };
    }
    return {
      status: 'queued',
      nextAttemptAt: new Date(now.getTime() + delayDays * 24 * 60 * 60 * 1000),
    };
  }

  return {
    status: 'queued',
    nextAttemptAt: new Date(now.getTime() + fallbackRetryMinutes * 60 * 1000),
  };
}

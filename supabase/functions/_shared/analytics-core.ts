/**
 * TASK-M1: pure "Conversations / hr" math, pulled out of dashboard-stats/index.ts so it's
 * unit-testable the same way this codebase already tests every other piece of pure business
 * logic (dialer-core.ts) -- Edge Function `index.ts` files have no test files of their own in
 * this repo; the math that matters lives in `_shared` instead.
 *
 * Definitions (.brain/domains/analytics.md):
 * - Conversation: a connected leg (outcome 'connected') with duration_seconds >= 30.
 * - Conversations / hr = conversations / dialing hours, rounded to 1 decimal, or null (render
 *   "-") when dialing hours < 0.1 -- avoids a nonsense spike on a trivial denominator right
 *   after Go Ready.
 */

export const CONVERSATION_MIN_SECONDS = 30;

/** The minimum dialing-hours denominator before conversations/hr is considered meaningful. */
export const DIALING_HOURS_FLOOR = 0.1;

export function isConversation(leg: {
  is_connected: boolean;
  duration_seconds: number | null;
}): boolean {
  return leg.is_connected && (leg.duration_seconds ?? 0) >= CONVERSATION_MIN_SECONDS;
}

export function computeConversationsPerHour(
  conversationsToday: number,
  dialingHoursToday: number
): number | null {
  if (dialingHoursToday < DIALING_HOURS_FLOOR) return null;
  return Math.round((conversationsToday / dialingHoursToday) * 10) / 10;
}

/**
 * MISSION-5 TASK-M5-A4: the org's real local-"today" boundary, replacing dashboard-stats' own
 * previous hardcoded UTC-midnight boundary (never matched any real org's actual day, let alone
 * dialing_hours_today's separate America/Chicago boundary it was already inconsistent with) --
 * same `Intl.DateTimeFormat` round-trip technique Team.tsx already used for its own (formerly
 * hardcoded-Chicago) day math, generalized to any IANA zone so it stays correct across a DST
 * transition without hardcoding a UTC offset.
 */
export function localDayBoundsUtc(tz: string, now: Date = new Date()): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const y = get('year');
  const m = get('month');
  const day = get('day');

  const midnightUtc = (year: number, month: number, dayOfMonth: number): Date => {
    // A zone AHEAD of UTC (e.g. Asia/Tokyo, UTC+9) has its own local midnight on the PREVIOUS
    // UTC calendar day, not the same one -- searching only non-negative hour offsets on the same
    // day (an earlier version of this function did that) never finds it and silently falls
    // through to the "unreachable" fallback for every zone ahead of UTC. Search +/-16h in 15-min
    // steps instead (covers every real IANA offset, including the :30/:45 ones) around UTC
    // midnight of the target day, not just forward from it.
    const base = Date.UTC(year, month - 1, dayOfMonth, 0, 0, 0);
    const STEP_MS = 15 * 60 * 1000;
    for (let k = -64; k <= 64; k++) {
      const guess = new Date(base + k * STEP_MS);
      const guessParts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(guess);
      const g = (t: string) => guessParts.find((p) => p.type === t)?.value;
      if (
        g('hour') === '00' &&
        g('minute') === '00' &&
        Number(g('year')) === year &&
        Number(g('month')) === month &&
        Number(g('day')) === dayOfMonth
      ) {
        return guess;
      }
    }
    // Unreachable for any real IANA zone (a +/-16h search always finds a real offset) -- a safe
    // fallback rather than a thrown error if some exotic zone string ever slips through.
    return new Date(base);
  };

  const start = midnightUtc(y, m, day);
  const tomorrow = new Date(Date.UTC(y, m - 1, day + 1));
  const end = midnightUtc(
    tomorrow.getUTCFullYear(),
    tomorrow.getUTCMonth() + 1,
    tomorrow.getUTCDate()
  );
  return { start, end };
}

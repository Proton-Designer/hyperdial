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

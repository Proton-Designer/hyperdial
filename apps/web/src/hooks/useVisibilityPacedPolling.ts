import { useEffect, useRef } from 'react';

/** How much slower than the base interval each consecutive error streak step gets -- e.g. for a
 *  5s base this is 5s/30s/60s, matching TASK-M5-L1's own spec; every other poller in this app
 *  scales the same three steps off its own base interval instead of using these numbers literally. */
const BACKOFF_MULTIPLIERS = [1, 6, 12];

/**
 * MISSION-5 TASK-M5-L1 (EC-9, edge-cases-v2.md PARTIAL): shared scheduling for every
 * "poll a server endpoint on an interval" component in this app -- Team.tsx's live board, the
 * shared inbox, the power-hour panel/board/banner, goal/broadcast headers, the coaching banner's
 * raise-hand poll. Two things every one of them was missing: (1) they kept fetching every tick
 * even with the tab backgrounded (30-50 open manager tabs is 30-50x the actual viewing audience),
 * and (2) a real outage meant hammering the same broken endpoint at full speed forever.
 *
 * This hook owns ONLY the scheduling -- it never touches a caller's own fetch/error-state logic.
 * `hasError` is read from whatever error state the caller already tracks (or `false`, for the
 * several pollers that deliberately swallow their own errors silently -- see notes.md for which).
 */
export function useVisibilityPacedPolling(
  poll: () => void,
  baseIntervalMs: number,
  hasError: boolean,
  enabled = true
): void {
  const pollRef = useRef(poll);
  pollRef.current = poll;

  // Lead review NIT: `hasError` typically STAYS true across many consecutive failed polls, so
  // gating the streak advance on an effect with `[hasError]` deps only ever fired once (on the
  // false->true transition) and then froze at that one step forever, no matter how many more
  // ticks kept failing. Fixed by reading a plain ref (updated every render, same pattern as
  // `pollRef`) fresh inside `schedule()` itself -- the streak now advances once per SCHEDULING
  // DECISION (i.e. once per actual tick), not once per boolean transition.
  const hasErrorRef = useRef(hasError);
  hasErrorRef.current = hasError;
  const errorStreakRef = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Mount counts as a fetch: every caller loads on mount itself.
    let lastPollAt = Date.now();

    const schedule = () => {
      if (document.visibilityState === 'hidden') return;
      errorStreakRef.current = hasErrorRef.current
        ? Math.min(errorStreakRef.current + 1, BACKOFF_MULTIPLIERS.length - 1)
        : 0;
      const delay = baseIntervalMs * BACKOFF_MULTIPLIERS[errorStreakRef.current];
      timer = setTimeout(tick, delay);
    };

    const tick = () => {
      lastPollAt = Date.now();
      pollRef.current();
      schedule();
    };

    const handleVisibility = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (document.visibilityState === 'visible') {
        // Only refetch on return if a tick actually came due while hidden -- flicking to another
        // tab and straight back used to refire every poller on the page at once.
        const dueIn = baseIntervalMs - (Date.now() - lastPollAt);
        if (dueIn <= 0) tick();
        else timer = setTimeout(tick, dueIn);
      }
    };

    schedule();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [baseIntervalMs, enabled]);
}

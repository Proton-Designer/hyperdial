import { useEffect } from 'react';

/**
 * TASK-MOB1-B: keeps a phone's screen on while `active` (a dialing session). A locked screen suspends the page,
 * and with it the WebRTC phone line. The browser drops the lock when the tab is hidden, so it is taken again
 * when the tab becomes visible. Silently does nothing where the Screen Wake Lock API does not exist.
 */
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    let inFlight = false;
    const acquire = async () => {
      if (cancelled || inFlight || document.visibilityState !== 'visible' || sentinel) return;
      inFlight = true;
      try {
        const s = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
        s.addEventListener('release', () => {
          if (sentinel === s) sentinel = null;
        });
      } catch {
        // Denied (battery saver, unsupported context): the session still works, the screen may just dim.
      } finally {
        inFlight = false;
      }
    };
    void acquire();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
    };
  }, [active]);
}

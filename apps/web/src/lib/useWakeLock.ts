import { useEffect, useState } from 'react';

/**
 * TASK-MOB1-B / MOB5: keeps a phone's screen on while `active` (a dialing session). A locked screen suspends the
 * page, and with it the WebRTC phone line. Returns whether a lock is currently held.
 *
 * Found on real iOS Safari: `wakeLock.request()` is refused (NotAllowedError) unless it runs inside a user
 * gesture, and the browser also drops the lock whenever the tab is hidden. So a refused or lost lock is retried on
 * the next tap (any tap: agents tap constantly) instead of being given up on. Silently does nothing where the
 * Screen Wake Lock API does not exist.
 */
export function useScreenWakeLock(active: boolean): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;
    let inFlight = false;
    let gestureArmed = false;

    const onGesture = () => {
      gestureArmed = false;
      void acquire();
    };
    const armGesture = () => {
      if (gestureArmed || cancelled) return;
      gestureArmed = true;
      document.addEventListener('pointerup', onGesture, { once: true, capture: true });
    };
    async function acquire() {
      if (cancelled || inFlight || document.visibilityState !== 'visible' || sentinel) return;
      inFlight = true;
      try {
        const s = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void s.release().catch(() => undefined);
          return;
        }
        sentinel = s;
        setHeld(true);
        s.addEventListener('release', () => {
          if (sentinel === s) {
            sentinel = null;
            setHeld(false);
          }
          // Dropped by the browser (tab hidden, battery saver): take it again on the next tap or when visible.
          armGesture();
        });
      } catch {
        // Refused (not inside a tap yet, battery saver): try again on the next tap. The session works either way.
        armGesture();
      } finally {
        inFlight = false;
      }
    }

    void acquire();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('pointerup', onGesture, { capture: true });
      void sentinel?.release().catch(() => undefined);
      sentinel = null;
      setHeld(false);
    };
  }, [active]);
  return held;
}

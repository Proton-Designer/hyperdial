import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement
  );
}

/**
 * Traps Tab/Shift+Tab focus inside `ref`'s subtree while `open` is true, moves focus into it on
 * open (the first focusable element, or the container itself if none), and restores focus to
 * whatever triggered it when `open` goes back to false -- closes B1-004 (TASK-B1: popovers and
 * modals never moved focus in, never trapped it, never restored it). Apply to every top-nav
 * popover and every modal's outer container.
 *
 * Does not itself close anything on Escape -- callers that want Escape-to-close keep their own
 * handler (e.g. WrapUpModal deliberately has none, by design; TopNavigation already has one).
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, open: boolean): void {
  const triggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    triggerRef.current = document.activeElement as HTMLElement | null;

    const container = ref.current;
    if (container) {
      const focusable = getFocusable(container);
      (focusable[0] ?? container).focus({ preventScroll: true });
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const node = ref.current;
      if (!node) return;
      const focusable = getFocusable(node);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (e.shiftKey) {
        if (active === first || !node.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !node.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      // Restore focus to whatever triggered this open, if it's still attached to the DOM.
      const trigger = triggerRef.current;
      if (trigger && document.body.contains(trigger)) {
        trigger.focus({ preventScroll: true });
      }
    };
  }, [open, ref]);
}

/** Any element that consumes typed characters itself -- a global hotkey handler must never fire
 *  while the user is typing into one of these. Mirrors `WrapUpModal.tsx`'s own private copy
 *  (TASK-L2a fix pass); not yet worth a cross-file refactor for two call sites, so this is a
 *  fresh copy for TASK-T7's own global Dialer hotkeys, not an import from that file. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLInputElement ||
    el instanceof HTMLSelectElement
  ) {
    return true;
  }
  return el instanceof HTMLElement && el.isContentEditable;
}

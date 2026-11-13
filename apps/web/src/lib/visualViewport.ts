/**
 * TASK-MOB5 (found on real iOS Safari): when the on-screen keyboard opens, iOS shrinks only the VISUAL viewport and
 * scrolls it; `position: fixed` boxes stay sized to the layout viewport, so a full-screen modal's footer (the primary
 * button) ends up behind the keyboard and its header scrolls off the top. This keeps two CSS variables in step with
 * the visual viewport so fixed modals can follow it: `--vv-h` (its height) and `--vv-top` (its offset from the top).
 * Used by the `hd-vv` class (styles/touch.css) and the ui Dialog. Does nothing without `window.visualViewport`.
 */
export function installVisualViewportVars(): void {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (!vv) return;
  const root = document.documentElement;
  const update = () => {
    root.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
    root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
  };
  update();
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
}

import { useState, useEffect } from 'react';

export type Breakpoint = 'mobile' | 'tablet' | 'desktop';

/** FE-A shell breakpoints: mobile <768 (bottom tab bar, no sidebar), tablet 768-1023 (sidebar,
 *  collapsed by default), desktop >=1024 (sidebar, expanded by default). A live resize listener
 *  (unlike MainApp's older one-shot mount-time check for the initial `sidebarCollapsed` default)
 *  -- the shell needs to actually react to a resize/rotate, not just pick a starting value. */
function resolveBreakpoint(width: number): Breakpoint {
  if (width < 768) return 'mobile';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

export function useBreakpoint(): Breakpoint {
  const [breakpoint, setBreakpoint] = useState<Breakpoint>(() =>
    typeof window === 'undefined' ? 'desktop' : resolveBreakpoint(window.innerWidth)
  );

  useEffect(() => {
    const onResize = () => setBreakpoint(resolveBreakpoint(window.innerWidth));
    window.addEventListener('resize', onResize);
    onResize();
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return breakpoint;
}

import type { ReactNode } from 'react';
import { motion, useReducedMotion } from 'motion/react';

/**
 * Subtle fade + 4px rise, 160ms, for a tab's content on activation. Reduced-motion safe (skips
 * the transform, per `prefers-reduced-motion`). NOT applied to the Dialer -- it stays always
 * mounted and CSS-hidden (TASK-L1r4), never remounted, so it never runs through this wrapper;
 * every OTHER tab already fully mounts/unmounts on tab switch today, so wrapping just adds the
 * enter animation without changing when mount/unmount happens.
 */
export function PageTransition({ children }: { children: ReactNode }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.div
      className="h-full"
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
    >
      {children}
    </motion.div>
  );
}

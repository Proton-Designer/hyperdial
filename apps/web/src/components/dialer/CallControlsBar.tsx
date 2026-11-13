import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useKeyboardInset } from '@/lib/visualViewport';

/**
 * TASK-MOB6: on a phone the live-call panel's Hang up sat about 1.4 screens down. This bar is pinned above the bottom
 * tab bar (or to the bottom edge in landscape, where there is no tab bar), shows who you are talking to and the timer,
 * and carries the same handlers as the panel. It is hidden everywhere except the `phone` variant (styles/globals.css),
 * so desktop and tablets are unchanged. With the on-screen keyboard open it rides on top of the keyboard.
 * Rendered through a portal: the call panels sit inside transformed (animated) parents, which would break `fixed`.
 */
export function CallControlsBar({
  name,
  timer,
  children,
}: {
  name: string;
  timer: string;
  children: ReactNode;
}) {
  const tabBarShown = useBreakpoint() === 'mobile';
  const keyboard = useKeyboardInset();
  const bottom =
    keyboard > 0
      ? `${keyboard}px`
      : tabBarShown
        ? 'calc(56px + env(safe-area-inset-bottom, 0px))'
        : 'env(safe-area-inset-bottom, 0px)';
  return createPortal(
    <div
      role="region"
      aria-label="Call controls"
      className="phone:block fixed inset-x-0 z-40 hidden border-t border-border-subtle bg-surface-1/95 py-2 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] backdrop-blur-xl"
      style={{ bottom }}
    >
      <div className="mx-auto flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 [@media(max-height:500px)]:flex-nowrap">
        <div className="flex min-w-0 basis-full items-baseline justify-between gap-2 [@media(max-height:500px)]:basis-28 [@media(max-height:500px)]:flex-col [@media(max-height:500px)]:items-start [@media(max-height:500px)]:gap-0">
          <span className="min-w-0 truncate text-sm font-medium text-text-primary">{name}</span>
          <span className="shrink-0 text-sm font-semibold tabular-nums text-success">{timer}</span>
        </div>
        <div className="flex min-w-0 flex-1 items-stretch gap-2">{children}</div>
      </div>
    </div>,
    document.body
  );
}

/** Keeps the end of the page clear of the bar (the bar floats over the scroll area). Phone only. */
export function CallControlsSpacer() {
  return <div aria-hidden className="phone:block hidden h-28 [@media(max-height:500px)]:h-20" />;
}

/** One big, thumb-sized button for the bar. `grow` makes it the dominant one (Hang up). */
export function BarAction({
  icon,
  label,
  onClick,
  tone = 'secondary',
  grow,
  pressed,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: 'secondary' | 'danger' | 'primary';
  grow?: boolean;
  pressed?: boolean;
}) {
  return (
    <Button
      type="button"
      variant={tone === 'danger' ? 'danger' : tone === 'primary' ? 'primary' : 'fe-secondary'}
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(
        'h-14 min-w-0 flex-col gap-0.5 px-1 text-xs [@media(max-height:500px)]:h-11 [@media(max-height:500px)]:flex-row [@media(max-height:500px)]:gap-1',
        grow ? 'flex-[2] text-sm font-semibold' : 'flex-1'
      )}
    >
      <span className={cn('flex', !grow && '[@media(max-height:500px)]:hidden')}>{icon}</span>
      <span className="truncate">{label}</span>
    </Button>
  );
}

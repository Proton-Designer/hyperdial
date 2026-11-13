import type { ReactNode } from 'react';
import { Disc } from 'lucide-react';
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
  recording,
  children,
}: {
  name: string;
  timer: string;
  /** Pause/resume recording (phones had it in the panel; keep it reachable). Omit when there is nothing to toggle. */
  recording?: { paused: boolean; onToggle: () => void };
  children: ReactNode;
}) {
  const tabBarShown = useBreakpoint() === 'mobile';
  const keyboard = useKeyboardInset();
  const bottom =
    keyboard > 0
      ? `${keyboard}px`
      : tabBarShown
        ? 'calc(56px + env(safe-area-inset-bottom, 0px))'
        : '0px';
  // No tab bar (landscape): the bar sits on the bottom edge and pads itself above the home bar / curved corner, so
  // page content never shows below it. With the tab bar the shell already paints the inset.
  const paddingBottom =
    keyboard === 0 && !tabBarShown ? 'calc(0.5rem + env(safe-area-inset-bottom, 0px))' : '0.5rem';
  return createPortal(
    <div
      role="region"
      aria-label="Call controls"
      className="phone:block fixed inset-x-0 z-40 hidden border-t border-border-subtle bg-surface-1/95 pt-2 pr-[max(0.75rem,env(safe-area-inset-right))] pl-[max(0.75rem,env(safe-area-inset-left))] backdrop-blur-xl"
      style={{ bottom, paddingBottom }}
    >
      <div className="mx-auto flex max-w-xl [@media(max-height:500px)]:max-w-none flex-wrap items-center gap-x-3 gap-y-2 [@media(max-height:500px)]:flex-nowrap">
        <div className="flex min-w-0 basis-full items-baseline justify-between gap-2 [@media(max-height:500px)]:basis-28 [@media(max-height:500px)]:flex-col [@media(max-height:500px)]:items-start [@media(max-height:500px)]:gap-0">
          <span className="min-w-0 truncate text-sm font-medium text-text-primary">{name}</span>
          <span className="flex shrink-0 items-center gap-2">
            {recording && (
              <button
                type="button"
                onClick={recording.onToggle}
                aria-label={recording.paused ? 'Resume recording' : 'Pause recording'}
                className="inline-flex h-11 items-center gap-1 rounded-app-md border border-border-subtle bg-surface-2 px-3 text-xs font-medium text-text-primary [@media(max-height:500px)]:hidden"
              >
                <Disc className="h-4 w-4" />
                {recording.paused ? 'Resume rec' : 'Pause rec'}
              </button>
            )}
            <span className="text-sm font-semibold tabular-nums text-success">{timer}</span>
          </span>
        </div>
        <div className="flex min-w-0 flex-1 items-stretch gap-2">
          {recording && (
            <BarAction
              icon={<Disc className="w-4 h-4" />}
              label={recording.paused ? 'Resume rec' : 'Pause rec'}
              onClick={recording.onToggle}
              className="hidden [@media(max-height:500px)]:flex"
            />
          )}
          {children}
        </div>
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
  className,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: 'secondary' | 'danger' | 'primary';
  grow?: boolean;
  pressed?: boolean;
  className?: string;
}) {
  return (
    <Button
      type="button"
      variant={tone === 'danger' ? 'danger' : tone === 'primary' ? 'primary' : 'fe-secondary'}
      onClick={onClick}
      aria-pressed={pressed}
      className={cn(
        'h-14 min-w-0 flex-col gap-0.5 px-1 text-xs [@media(max-height:500px)]:h-11 [@media(max-height:500px)]:flex-row [@media(max-height:500px)]:gap-1',
        grow ? 'flex-[2] text-sm font-semibold' : 'flex-1',
        className
      )}
    >
      <span className={cn('flex', !grow && '[@media(max-height:500px)]:hidden')}>{icon}</span>
      <span className="truncate">{label}</span>
    </Button>
  );
}

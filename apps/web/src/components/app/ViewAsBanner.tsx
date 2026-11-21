import { useState } from 'react';
import { Eye, Loader2 } from 'lucide-react';
import { exitViewAs, getViewAsMeta, isViewOnly, VIEW_AS_BANNER_HEIGHT } from '@/lib/viewAs';
import { Button } from '@/components/ui/button';

/** TASK-H21: always-visible, not dismissable. Renders nothing outside a view-as tab. */
export function ViewAsBanner() {
  const [exiting, setExiting] = useState(false);
  const [exitFailed, setExitFailed] = useState(false);
  if (!isViewOnly) return null;
  const name = getViewAsMeta()?.targetName ?? 'this intern';
  return (
    <div
      role="status"
      className="fixed top-0 left-0 right-0 flex items-center justify-between gap-3 bg-warning-soft border-b border-warning/40 px-3 sm:px-4"
      // above every modal (the wrap-up window sits at 10000): Exit must always be reachable
      style={{ height: VIEW_AS_BANNER_HEIGHT, zIndex: 2147483000 }}
    >
      <div className="flex min-w-0 items-center gap-2 text-body text-text-primary">
        <Eye className="w-4 h-4 shrink-0 text-warning" aria-hidden />
        <span className="truncate">
          Viewing as <strong>{name}</strong> — view only
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {exitFailed && (
          <span className="hidden sm:inline text-meta text-danger">
            Could not confirm the exit.
          </span>
        )}
        <Button
          variant="fe-ghost"
          className="h-8 shrink-0 px-3"
          disabled={exiting}
          onClick={() => {
            setExiting(true);
            void exitViewAs().then((r) => {
              if (r === 'failed') {
                setExitFailed(true);
                setExiting(false);
              }
            });
          }}
        >
          {exiting ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : exitFailed ? (
            'Try again'
          ) : (
            'Exit'
          )}
        </Button>
        {exitFailed && (
          <Button
            variant="fe-ghost"
            className="h-8 shrink-0 px-3"
            disabled={exiting}
            title="Leave this view now. The server closes it by itself within 2 hours."
            onClick={() => void exitViewAs({ force: true })}
          >
            Leave anyway
          </Button>
        )}
      </div>
    </div>
  );
}

/** Shown after Exit when the browser would not close the tab. */
export function ViewAsEnded() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-surface-0 p-8">
      <div className="max-w-md text-center rounded-app-lg border border-border-subtle bg-surface-1 p-8">
        <p className="text-text-primary font-semibold text-lg mb-2">View ended</p>
        <p className="text-text-secondary text-body mb-4">
          You have left the intern&rsquo;s view. You can close this tab.
        </p>
        <a className="text-accent-to underline" href="/">
          Back to HyperDial
        </a>
      </div>
    </div>
  );
}

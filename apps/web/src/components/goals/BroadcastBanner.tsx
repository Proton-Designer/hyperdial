import { useEffect, useState, useCallback } from 'react';
import { Megaphone, X } from 'lucide-react';
import { getActiveBroadcasts, dismissBroadcast, type OrgBroadcast } from '@/lib/api';
import { useVisibilityPacedPolling } from '@/hooks/useVisibilityPacedPolling';

const POLL_MS = 60000;

/** MISSION-5 TASK-M5-A6: owner/admin/manager broadcast banner (Dialer.tsx). Polls every 60s
 *  (a broadcast is not time-critical like the live board's 5s poll) and dismisses OPTIMISTICALLY
 *  -- the row is removed from local state immediately, the actual insert into
 *  org_broadcast_dismissals happens in the background; a failed dismiss just means the banner
 *  reappears on the next poll, not a blocking error the agent has to deal with. */
export function BroadcastBanner() {
  const [broadcasts, setBroadcasts] = useState<OrgBroadcast[]>([]);
  // Invisible -- feeds only the poll backoff below; refresh() stays silent-on-failure otherwise.
  const [pollFailed, setPollFailed] = useState(false);

  const refresh = useCallback(() => {
    getActiveBroadcasts()
      .then((rows) => {
        setBroadcasts(rows);
        setPollFailed(false);
      })
      .catch(() => setPollFailed(true)); // silent -- a passive banner isn't worth surfacing a fetch error
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  // TASK-M5-L1 (EC-9): paused while the tab is hidden, refreshed immediately on becoming
  // visible, backs off 60s->360s->720s on an error streak.
  useVisibilityPacedPolling(refresh, POLL_MS, pollFailed);

  const handleDismiss = (id: string) => {
    setBroadcasts((prev) => prev.filter((b) => b.id !== id));
    dismissBroadcast(id).catch(() => {});
  };

  if (broadcasts.length === 0) return null;

  return (
    <div className="max-w-2xl mx-auto mb-6 space-y-2">
      {broadcasts.map((b) => (
        <div
          key={b.id}
          className="flex items-start gap-3 rounded-app-lg border border-accent-to/30 bg-accent-to/10 p-4"
        >
          <Megaphone className="w-4 h-4 flex-shrink-0 mt-0.5 text-accent-to" />
          <p className="flex-1 text-body text-text-primary whitespace-pre-wrap">{b.message}</p>
          <button
            type="button"
            onClick={() => handleDismiss(b.id)}
            aria-label="Dismiss"
            className="flex-shrink-0 text-text-secondary hover:text-text-primary"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

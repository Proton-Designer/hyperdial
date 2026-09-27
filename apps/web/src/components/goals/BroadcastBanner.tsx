import { useEffect, useState, useCallback } from 'react';
import { Megaphone, X } from 'lucide-react';
import { getActiveBroadcasts, dismissBroadcast, type OrgBroadcast } from '@/lib/api';

const POLL_MS = 60000;

/** MISSION-5 TASK-M5-A6: owner/admin/manager broadcast banner (Dialer.tsx). Polls every 60s
 *  (a broadcast is not time-critical like the live board's 5s poll) and dismisses OPTIMISTICALLY
 *  -- the row is removed from local state immediately, the actual insert into
 *  org_broadcast_dismissals happens in the background; a failed dismiss just means the banner
 *  reappears on the next poll, not a blocking error the agent has to deal with. */
export function BroadcastBanner() {
  const [broadcasts, setBroadcasts] = useState<OrgBroadcast[]>([]);

  const refresh = useCallback(() => {
    getActiveBroadcasts()
      .then(setBroadcasts)
      .catch(() => {}); // silent -- a passive banner isn't worth surfacing a fetch error
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

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

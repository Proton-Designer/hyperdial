import { useCallback, useEffect, useState } from 'react';
import { Zap } from 'lucide-react';
import { listPowerHours, powerHourStatus, type PowerHour } from '@/lib/api';
import { PowerHourBoard } from './PowerHourBoard';

const POLL_MS = 20000;

/**
 * MISSION-5 TASK-M5-E2: the Dialer page's compact live board -- visible only while a power hour
 * in this caller's scope (org-wide, or their own pod -- `listPowerHours`' own RLS already does
 * the scoping) is actually live. Renders nothing otherwise, same "silent, passive, poll-driven"
 * shape as BroadcastBanner. Top 3 only (PowerHourBoard's `compact` mode); "see full board" isn't
 * a separate view here -- the Team page's PowerHourPanel already is that, one tab over.
 */
export function PowerHourLiveBanner() {
  const [live, setLive] = useState<PowerHour | null>(null);

  const refresh = useCallback(() => {
    listPowerHours()
      .then((rows) => {
        const current = rows.find((p) => powerHourStatus(p) === 'live');
        setLive(current ?? null);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const interval = setInterval(refresh, POLL_MS);
    return () => clearInterval(interval);
  }, [refresh]);

  if (!live) return null;

  return (
    <div className="max-w-2xl mx-auto mb-6 rounded-app-lg border border-accent-to/30 bg-accent-to/10 p-4">
      <div className="flex items-center gap-2 mb-2">
        <Zap className="w-4 h-4 flex-shrink-0 text-accent-to" />
        <span className="text-body font-medium text-text-primary">{live.name}</span>
        <span className="text-meta text-text-secondary">is live</span>
      </div>
      <PowerHourBoard powerHour={live} compact />
    </div>
  );
}

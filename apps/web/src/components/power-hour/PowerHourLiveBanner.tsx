import { useCallback, useEffect, useState } from 'react';
import { Zap } from 'lucide-react';
import { listPowerHours, powerHourStatus, type PowerHour } from '@/lib/api';
import { PowerHourBoard } from './PowerHourBoard';
import { useVisibilityPacedPolling } from '@/hooks/useVisibilityPacedPolling';

const POLL_MS = 20000;

/**
 * MISSION-5 TASK-M5-E2: the Dialer page's compact live board -- visible only while at least one
 * power hour in this caller's scope (org-wide, or their own pod -- `listPowerHours`' own RLS
 * already does the scoping) is actually live. Renders nothing otherwise, same "silent, passive,
 * poll-driven" shape as BroadcastBanner. Top 3 per board (PowerHourBoard's `compact` mode); "see
 * full board" isn't a separate view here -- the Team page's PowerHourPanel already is that, one
 * tab over.
 *
 * TASK-M5-O1 Part A (R3's own edge-case finding, audit/M5/edge-cases-v2.md): overlapping power
 * hours in the same scope are explicitly ALLOWED by design (audit/M5-E2/notes.md's edge case #3)
 * -- a manager can legitimately run an org-wide blitz and their own pod's at once. The original
 * version here only ever rendered `rows.find(...)`, the FIRST live match -- an agent in scope for
 * two simultaneous live power hours silently never saw the second one at all. Now renders every
 * live one the caller can see, not just one.
 */
export function PowerHourLiveBanner() {
  const [live, setLive] = useState<PowerHour[]>([]);
  // Invisible -- feeds only the poll backoff below, never rendered (this banner stays
  // deliberately silent/passive on a real fetch failure, same as before TASK-M5-L1).
  const [pollFailed, setPollFailed] = useState(false);

  const refresh = useCallback(() => {
    listPowerHours()
      .then((rows) => {
        setLive(rows.filter((p) => powerHourStatus(p) === 'live'));
        setPollFailed(false);
      })
      .catch(() => setPollFailed(true));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);
  // TASK-M5-L1 (EC-9): paused while the tab is hidden, refreshed immediately on becoming
  // visible, backs off 20s->120s->240s on an error streak.
  useVisibilityPacedPolling(refresh, POLL_MS, pollFailed);

  if (live.length === 0) return null;

  return (
    <div className="max-w-2xl mx-auto mb-6 space-y-3">
      {live.map((p) => (
        <div key={p.id} className="rounded-app-lg border border-accent-to/30 bg-accent-to/10 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-4 h-4 flex-shrink-0 text-accent-to" />
            <span className="text-body font-medium text-text-primary">{p.name}</span>
            <span className="text-meta text-text-secondary">is live</span>
          </div>
          <PowerHourBoard powerHour={p} compact />
        </div>
      ))}
    </div>
  );
}

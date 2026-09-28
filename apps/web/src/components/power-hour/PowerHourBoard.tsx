import { useCallback, useEffect, useState } from 'react';
import { getPowerHourBoard, type PowerHour, type PowerHourBoardRow } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';

const POLL_MS = 20000;

/**
 * MISSION-5 TASK-M5-E2: the ranked board for one power hour -- shared by PowerHourPanel (Team
 * page, full list) and the Dialer page's compact live banner (via `compact`). Polls only while
 * `live` is true (an ended power hour's "final results" view never needs another round trip).
 */
export function PowerHourBoard({
  powerHour,
  compact = false,
}: {
  powerHour: PowerHour;
  compact?: boolean;
}) {
  const [rows, setRows] = useState<PowerHourBoardRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isLive = !powerHour.cancelledAt && new Date(powerHour.endsAt).getTime() > Date.now();

  const load = useCallback(() => {
    getPowerHourBoard(powerHour.id)
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load board'));
  }, [powerHour.id]);

  useEffect(() => {
    load();
    if (!isLive) return;
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load, isLive]);

  if (error) return <p className="text-meta text-danger">{error}</p>;
  if (!rows) {
    return (
      <div className="space-y-1">
        <Skeleton className="h-6 w-full" />
        <Skeleton className="h-6 w-full" />
      </div>
    );
  }
  if (rows.length === 0) {
    return <p className="text-meta text-text-secondary">No participants in scope.</p>;
  }

  const teamTotal = rows.reduce((sum, r) => sum + r.metricCount, 0);
  const shown = compact ? rows.slice(0, 3) : rows;
  const timeLeftMs = new Date(powerHour.endsAt).getTime() - Date.now();
  const minutesLeft = Math.max(0, Math.ceil(timeLeftMs / 60000));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-meta text-text-secondary">
        <span>
          Team total: <span className="text-text-primary font-medium">{teamTotal}</span>
          {powerHour.target ? ` / ${powerHour.target}` : ''}
        </span>
        {isLive && <span>{minutesLeft}m left</span>}
      </div>
      <div className="space-y-1">
        {shown.map((r) => (
          <div
            key={r.agentId}
            className="flex items-center gap-2 rounded-app-sm bg-surface-2 px-2.5 py-1.5 text-sm"
          >
            <span className="w-5 flex-shrink-0 text-text-secondary tabular-nums">
              {r.boardRank}
            </span>
            <span className="flex-1 min-w-0 truncate text-text-primary">{r.name}</span>
            {!compact && (
              <span className="flex-shrink-0 text-text-secondary tabular-nums">
                {r.dials} dials · {r.talkMinutes}m talk
                {r.metricPerHour !== null ? ` · ${r.metricPerHour}/hr` : ''}
              </span>
            )}
            <span className="flex-shrink-0 font-medium text-text-primary tabular-nums">
              {r.metricCount}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

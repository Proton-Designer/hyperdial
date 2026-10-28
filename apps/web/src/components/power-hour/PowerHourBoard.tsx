import { useCallback, useEffect, useState } from 'react';
import { getPowerHourBoard, type PowerHour, type PowerHourBoardRow } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/contexts/AuthContext';
import { useVisibilityPacedPolling } from '@/hooks/useVisibilityPacedPolling';

const POLL_MS = 20000;

/**
 * MISSION-5 TASK-M5-E2: the ranked board for one power hour -- shared by PowerHourPanel (Team
 * page, full list) and the Dialer page's compact live banner (via `compact`). Polls only while
 * `live` is true (an ended power hour's "final results" view never needs another round trip).
 *
 * TASK-M5-O1 Part A addendum (eng2's E2 review SHOULD, audit/M5-E2/review-eng2.md): compact mode
 * used to be a bare `rows.slice(0, 3)` -- requirement 3 asks for "their rank, the top 3", not
 * just the top 3, so an agent outside it never saw their own standing at all. The caller's own
 * row is now appended (visually separated) whenever it exists and isn't already in the top 3.
 */
export function PowerHourBoard({
  powerHour,
  compact = false,
}: {
  powerHour: PowerHour;
  compact?: boolean;
}) {
  const { user } = useAuth();
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
  }, [load]);
  // TASK-M5-L1 (EC-9): paused while the tab is hidden, refreshed immediately on becoming
  // visible, backs off 20s->120s->240s on an error streak -- still only while isLive, same as
  // before.
  useVisibilityPacedPolling(load, POLL_MS, error !== null, isLive);

  // A failed refresh keeps the last board up (error shown with it), not swapped for the error.
  if (error && !rows) return <p className="text-meta text-danger">{error}</p>;
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
  const top3 = compact ? rows.slice(0, 3) : rows;
  const ownRow = compact ? rows.find((r) => r.agentId === user?.id) : undefined;
  const ownRowShown = ownRow && !top3.some((r) => r.agentId === ownRow.agentId) ? ownRow : null;
  const timeLeftMs = new Date(powerHour.endsAt).getTime() - Date.now();
  const minutesLeft = Math.max(0, Math.ceil(timeLeftMs / 60000));

  const renderRow = (r: PowerHourBoardRow) => (
    <div
      key={r.agentId}
      className="flex items-center gap-2 rounded-app-sm bg-surface-2 px-2.5 py-1.5 text-sm"
    >
      <span className="w-5 flex-shrink-0 text-text-secondary tabular-nums">{r.boardRank}</span>
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
  );

  return (
    <div className="space-y-1.5">
      {error && <p className="text-meta text-danger">Couldn't refresh: {error}</p>}
      <div className="flex items-center justify-between text-meta text-text-secondary">
        <span>
          Team total: <span className="text-text-primary font-medium">{teamTotal}</span>
          {powerHour.target ? ` / ${powerHour.target}` : ''}
        </span>
        {isLive && <span>{minutesLeft}m left</span>}
      </div>
      <div className="space-y-1">
        {top3.map(renderRow)}
        {ownRowShown && (
          <>
            <div className="text-center text-meta text-text-secondary leading-none">···</div>
            {renderRow(ownRowShown)}
          </>
        )}
      </div>
    </div>
  );
}

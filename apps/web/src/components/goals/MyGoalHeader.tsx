import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getAgentSelfStats,
  getMyGoalTargets,
  getOrgTimezone,
  getTodayRange,
  type GoalTargets,
} from '@/lib/api';
import { GoalProgressBars, hasAnyGoalTarget, type GoalActuals } from './GoalProgressBars';
import { useVisibilityPacedPolling } from '@/hooks/useVisibilityPacedPolling';

const REFRESH_MS = 60000;

/** MISSION-5 TASK-M5-A6: today's actual counts (agent_self_stats) + the caller's resolved daily
 *  goal targets (my_goal_targets), rendered as progress bars. Self-contained (fetches its own
 *  data, polls every 60s) so Dialer.tsx's header and Dashboard.tsx's My stats card can both drop
 *  it in with zero prop-drilling -- same bars, same data, two places. Renders nothing until
 *  loaded, and nothing at all if the org has no goals set anywhere (GoalProgressBars' own
 *  empty-targets check). */
export function MyGoalHeader({
  className,
  title,
  cardClassName,
}: {
  className?: string;
  /** When set, wraps the bars in a titled card -- and, per GoalProgressBars' own empty-targets
   *  behavior, renders NEITHER the title NOR the card at all once loaded if no goal is set
   *  anywhere (never an empty card with just a heading). Omit for a bare-bars usage (Dialer.tsx's
   *  header supplies its own compact wrapper). */
  title?: string;
  cardClassName?: string;
}) {
  const [actual, setActual] = useState<GoalActuals | null>(null);
  const [targets, setTargets] = useState<GoalTargets | null>(null);
  // Invisible -- feeds only the poll backoff below; load() stays silent-on-failure otherwise.
  const [loadFailed, setLoadFailed] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const tz = await getOrgTimezone();
      const { start, end } = getTodayRange(tz);
      const [stats, goalTargets] = await Promise.all([
        getAgentSelfStats(start, end),
        getMyGoalTargets(),
      ]);
      if (!mountedRef.current) return;
      setActual({
        dials: stats?.dials ?? 0,
        conversations: stats?.conversations ?? 0,
        wins: stats?.wins ?? 0,
        talkMinutes: Math.round((stats?.talk_time_seconds ?? 0) / 60),
      });
      setTargets(goalTargets);
      setLoadFailed(false);
    } catch {
      // silent -- a passive progress readout isn't worth an error state
      if (mountedRef.current) setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  // TASK-M5-L1 (EC-9): paused while the tab is hidden, refreshed immediately on becoming
  // visible, backs off 60s->360s->720s on an error streak.
  useVisibilityPacedPolling(() => void load(), REFRESH_MS, loadFailed);

  if (!actual || !targets || !hasAnyGoalTarget(targets)) return null;

  const bars = <GoalProgressBars actual={actual} targets={targets} className={className} />;
  if (!title) return bars;

  return (
    <div
      className={
        cardClassName ??
        'rounded-app-lg border border-border-subtle bg-surface-1 p-4 sm:p-6 shadow-app-sm'
      }
    >
      <h2 className="text-section-title text-text-primary mb-4">{title}</h2>
      {bars}
    </div>
  );
}

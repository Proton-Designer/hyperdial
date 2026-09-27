import { useEffect, useState } from 'react';
import {
  getAgentSelfStats,
  getMyGoalTargets,
  getOrgTimezone,
  getTodayRange,
  type GoalTargets,
} from '@/lib/api';
import { GoalProgressBars, hasAnyGoalTarget, type GoalActuals } from './GoalProgressBars';

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

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const tz = await getOrgTimezone();
        const { start, end } = getTodayRange(tz);
        const [stats, goalTargets] = await Promise.all([
          getAgentSelfStats(start, end),
          getMyGoalTargets(),
        ]);
        if (cancelled) return;
        setActual({
          dials: stats?.dials ?? 0,
          conversations: stats?.conversations ?? 0,
          wins: stats?.wins ?? 0,
          talkMinutes: Math.round((stats?.talk_time_seconds ?? 0) / 60),
        });
        setTargets(goalTargets);
      } catch {
        // silent -- a passive progress readout isn't worth an error state
      }
    };
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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

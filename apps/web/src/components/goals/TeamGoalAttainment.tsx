import { useEffect, useState } from 'react';
import { Progress } from '@/components/ui/progress';
import { getTeamGoalTargets, type TeamGoalTargetsRow, type TeamDailyStatsRow } from '@/lib/api';

const METRICS: {
  key: 'dials' | 'conversations' | 'wins';
  goalKey: keyof Omit<TeamGoalTargetsRow, 'agent_id'>;
  label: string;
}[] = [
  { key: 'dials', goalKey: 'dials_goal', label: 'Dials' },
  { key: 'conversations', goalKey: 'conversations_goal', label: 'Conversations' },
  { key: 'wins', goalKey: 'wins_goal', label: 'Wins' },
];

/** MISSION-5 TASK-M5-A6: goal attainment for the SAME window/rows Team.tsx's own daily-stats
 *  table already fetched (`daily`, `team_daily_stats`) -- this only adds the target side
 *  (`team_goal_targets`), joined by agent_id client-side, same separate-RPCs-joined-by-agent_id
 *  shape as team_live_board/team_daily_stats/agent_time_in_state. Talk minutes is intentionally
 *  left out of this compact per-agent table (four metrics fit the header row, not five) -- still
 *  fully settable/visible on the Dialer/My stats side, just not duplicated here. */
export function TeamGoalAttainment({ daily }: { daily: TeamDailyStatsRow[] | null }) {
  const [targets, setTargets] = useState<TeamGoalTargetsRow[] | null>(null);

  useEffect(() => {
    getTeamGoalTargets()
      .then(setTargets)
      .catch(() => setTargets([]));
  }, []);

  if (!daily || daily.length === 0 || !targets) return null;

  const byAgent = new Map(targets.map((t) => [t.agent_id, t]));
  const rows = daily
    .map((d) => ({ d, t: byAgent.get(d.agent_id) }))
    .filter(({ t }) => t && METRICS.some((m) => t[m.goalKey] != null));

  if (rows.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="text-section-title text-text-primary mb-4">Goal attainment</h2>
      <div className="rounded-app-lg border border-border-subtle bg-surface-1 divide-y divide-border-subtle">
        {rows.map(({ d, t }) => (
          <div key={d.agent_id} className="p-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="text-body text-text-primary font-medium">{d.name}</div>
            <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
              {METRICS.filter((m) => t![m.goalKey] != null).map((m) => {
                const target = t![m.goalKey] as number;
                const value = d[m.key];
                const pct = target > 0 ? Math.min(100, Math.round((value / target) * 100)) : 0;
                return (
                  <div key={m.key}>
                    <div className="flex items-center justify-between text-meta text-text-secondary mb-1">
                      <span>{m.label}</span>
                      <span>
                        {value} / {target}
                      </span>
                    </div>
                    <Progress value={pct} className="h-1.5" />
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

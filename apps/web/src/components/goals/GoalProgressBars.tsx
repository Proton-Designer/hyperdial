import { Progress } from '@/components/ui/progress';
import type { GoalTargets } from '@/lib/api';

/** MISSION-5 TASK-M5-A6: shared by Dialer.tsx's header and Dashboard.tsx's My stats -- a metric
 *  with no target set anywhere (org/pod/agent) is left out entirely rather than shown as "0/—",
 *  so an org that hasn't set any goals yet renders nothing here. */
export interface GoalActuals {
  dials: number;
  conversations: number;
  wins: number;
  talkMinutes: number;
}

const METRICS: { key: keyof GoalActuals; goalKey: keyof GoalTargets; label: string }[] = [
  { key: 'dials', goalKey: 'dials_goal', label: 'Dials' },
  { key: 'conversations', goalKey: 'conversations_goal', label: 'Conversations' },
  { key: 'wins', goalKey: 'wins_goal', label: 'Wins' },
  { key: 'talkMinutes', goalKey: 'talk_minutes_goal', label: 'Talk minutes' },
];

export function hasAnyGoalTarget(targets: GoalTargets): boolean {
  return METRICS.some((m) => targets[m.goalKey] != null);
}

export function GoalProgressBars({
  actual,
  targets,
  className,
}: {
  actual: GoalActuals;
  targets: GoalTargets;
  className?: string;
}) {
  const rows = METRICS.filter((m) => targets[m.goalKey] != null);
  if (rows.length === 0) return null;

  return (
    <div className={className}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {rows.map((m) => {
          const target = targets[m.goalKey] as number;
          const value = actual[m.key];
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
  );
}

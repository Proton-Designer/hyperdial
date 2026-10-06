import { useEffect, useMemo, useState } from 'react';
import { CalendarClock, Radio } from 'lucide-react';
import { useShiftsSnapshot } from '@/contexts/ShiftsContext';
import { cn } from '@/components/ui/utils';
import { clockPhase } from './clockModel';
import { ShiftClock } from './ShiftClock';
import { ACTIVITY_LABEL, fmtRange, fmtTime } from './shiftFormat';

const LEAD_MS = 15 * 60 * 1000;
const TICK_MS = 30 * 1000;

/** Dialer banner for Shifts: a shift in progress (or starting within 15 minutes), or a dialing
 *  session running with no shift in progress. Informational only: it never blocks anything.
 *
 *  Choice vs the Team page's "Dialing outside schedule" badge (agent_schedules): that badge is a
 *  manager-facing live status on Team.tsx, not shown to the agent, so the two never appear to the
 *  same person on the same screen. This banner is the intern's own, about Shifts KPIs only. */
export function ShiftDialerBanner({ sessionActive }: { sessionActive: boolean }) {
  const { enabled, myShifts, timezone, isIntern, patchShift, refresh } = useShiftsSnapshot();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  const { current, upcoming, endedCurrent, justEnded } = useMemo(() => {
    const scheduled = myShifts.filter((s) => s.status === 'scheduled');
    const inProgress = scheduled.filter(
      (s) => new Date(s.startsAt).getTime() <= now && new Date(s.endsAt).getTime() > now
    );
    // A shift the intern already ended gives way to one about to start; it only shows when nothing else does.
    const cur = inProgress.find((s) => !s.clockedOutAt) ?? null;
    const endedCur = inProgress.find((s) => s.clockedOutAt) ?? null;
    const next = scheduled
      .filter(
        (s) =>
          new Date(s.startsAt).getTime() > now && new Date(s.startsAt).getTime() <= now + LEAD_MS
      )
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];
    // The backend counts dialing within 15 minutes either side of a shift, so a session that runs
    // on just past the end is not "outside a shift" yet.
    const ended = myShifts.some(
      (s) =>
        ['scheduled', 'completed'].includes(s.status) &&
        new Date(s.endsAt).getTime() <= now &&
        new Date(s.endsAt).getTime() > now - LEAD_MS
    );
    return { current: cur, upcoming: next ?? null, endedCurrent: endedCur, justEnded: ended };
  }, [myShifts, now]);

  if (!enabled) return null;

  if (current || upcoming || endedCurrent) {
    const s = (current ?? upcoming ?? endedCurrent)!;
    const kind = ACTIVITY_LABEL[s.activity].toLowerCase();
    const range = fmtRange(s.startsAt, s.endsAt, timezone).replace('–', ' to ');
    const phase = clockPhase(s, now);
    // Once started (or ended) the clock line leads and the shift is the small print under it.
    const clockLeads = phase.kind === 'on' || phase.kind === 'ended';
    const clock = (
      <ShiftClock shift={s} tz={timezone} now={now} onUpdated={patchShift} onStale={refresh} />
    );
    return (
      <div
        role="status"
        className={cn(
          'mx-auto mb-4 flex max-w-2xl flex-wrap items-center gap-x-3 gap-y-2 rounded-app-lg border px-4 py-3',
          current ? 'border-success/30 bg-success-soft' : 'border-border-subtle bg-surface-1'
        )}
      >
        <Radio className={cn('h-4 w-4 shrink-0', current ? 'text-success' : 'text-text-muted')} />
        {clockLeads ? (
          <div className="min-w-0 flex-1 space-y-0.5">
            {clock}
            <p className="text-meta text-text-muted">
              {ACTIVITY_LABEL[s.activity]} shift {range}
            </p>
          </div>
        ) : (
          <>
            <p className="min-w-0 flex-1 text-body text-text-primary">
              {current ? (
                <>
                  Your {kind} shift {range} is live.
                </>
              ) : (
                <>
                  Your {kind} shift starts at {fmtTime(s.startsAt, timezone)}.
                </>
              )}
            </p>
            {clock}
          </>
        )}
      </div>
    );
  }

  // A running session with nothing scheduled: say so, calmly, once the person is actually dialing.
  if (sessionActive && !justEnded && (isIntern || myShifts.length > 0)) {
    return (
      <div
        role="status"
        className="mx-auto mb-4 flex max-w-2xl items-start gap-3 rounded-app-lg border border-warning/30 bg-warning-soft px-4 py-3"
      >
        <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
        <p className="text-body text-text-primary">
          You&apos;re dialing outside a scheduled shift. These calls won&apos;t count toward shift
          KPIs.
        </p>
      </div>
    );
  }
  return null;
}

import { useMemo } from 'react';
import { CalendarClock, CalendarPlus, Plus, Radio, Trophy, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { EmptyState } from '@/components/app/EmptyState';
import { cn } from '@/components/ui/utils';
import type {
  Shift,
  ShiftKpi,
  ShiftRequestType,
  ShiftRosterEntry,
  ShiftsWeekResponse,
} from '@/lib/api';
import { Pill, ShiftStatusPill } from './pills';
import {
  ACTIVITY_LABEL,
  fmtDateOnly,
  fmtDeadline,
  fmtHours,
  fmtMinutes,
  fmtRange,
  fmtWeekRange,
  flagLabel,
  localDateKey,
} from './shiftFormat';

interface MyShiftsProps {
  current: ShiftsWeekResponse;
  next: ShiftsWeekResponse | null;
  onRequestChange: (shift: Shift, week: ShiftsWeekResponse) => void;
  onRequestWeek: (week: ShiftsWeekResponse, type: ShiftRequestType) => void;
  onPickNextWeek: () => void;
}

export function MyShifts({
  current,
  next,
  onRequestChange,
  onRequestWeek,
  onPickNextWeek,
}: MyShiftsProps) {
  const nextUnsubmitted = next !== null && !next.commitment?.submittedAt;
  return (
    <div className="space-y-6">
      {next && nextUnsubmitted && <NextWeekBanner next={next} onPick={onPickNextWeek} />}
      <WeekSection
        title="This week"
        data={current}
        onRequestChange={onRequestChange}
        onRequestWeek={onRequestWeek}
      />
      {next && (
        <WeekSection
          title="Next week"
          data={next}
          onRequestChange={onRequestChange}
          onRequestWeek={onRequestWeek}
        />
      )}
      {current.powerWeekHistory.length > 0 && <PowerWeekHistory data={current} />}
    </div>
  );
}

function NextWeekBanner({ next, onPick }: { next: ShiftsWeekResponse; onPick: () => void }) {
  const { week } = next;
  const deadline = fmtDeadline(week.deadlineAt, week.timezone);
  const closed = week.deadlinePassed;
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col gap-3 rounded-app-lg border p-4 sm:flex-row sm:items-center sm:justify-between',
        closed ? 'border-border-subtle bg-surface-1' : 'border-warning/30 bg-warning-soft'
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <CalendarClock
          className={cn('mt-0.5 h-5 w-5 shrink-0', closed ? 'text-text-muted' : 'text-warning')}
        />
        <div className="min-w-0">
          <div className="text-body font-medium text-text-primary">
            {closed
              ? `Picking for ${fmtWeekRange(week.weekStart)} has closed`
              : `Pick next week's hours by ${deadline}`}
          </div>
          <p className="text-meta text-text-secondary">
            {closed
              ? 'You can still ask for changes. Use Request change on a shift, or Add time below.'
              : `You haven't submitted ${fmtWeekRange(week.weekStart)} yet. Any times in 30-minute steps, ${fmtHours(week.minHours)} minimum.`}
          </p>
        </div>
      </div>
      {!closed && (
        <Button variant="primary" size="sm" onClick={onPick} className="self-start sm:self-auto">
          <CalendarPlus /> Pick hours
        </Button>
      )}
    </div>
  );
}

function WeekSection({
  title,
  data,
  onRequestChange,
  onRequestWeek,
}: {
  title: string;
  data: ShiftsWeekResponse;
  onRequestChange: (shift: Shift, week: ShiftsWeekResponse) => void;
  onRequestWeek: (week: ShiftsWeekResponse, type: ShiftRequestType) => void;
}) {
  const { week, commitment } = data;
  const tz = week.timezone;
  const shifts = useMemo(
    () =>
      data.myShifts
        .filter((s) => s.status !== 'cancelled')
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt)),
    [data.myShifts]
  );
  const kpiByShift = useMemo(() => new Map(data.kpis.map((k) => [k.shiftId, k])), [data.kpis]);

  // Counted from the live shift rows so the counter matches the cards below it; the commitment
  // row only exists after a submit.
  // The server's counted hours (scheduled + completed + missed; not excused/cancelled) win once a
  // commitment row exists.
  const scheduledHours =
    commitment?.scheduledHours ??
    shifts
      .filter((s) => s.status === 'scheduled' || s.status === 'completed' || s.status === 'missed')
      .reduce((n, s) => n + s.hours, 0);
  const powerHours = shifts.reduce((n, s) => n + s.powerMinutes, 0) / 60;
  const under = scheduledHours < week.minHours;

  // Group by LOCAL day (settings.timezone), never the browser's.
  const byDay = useMemo(() => {
    const map = new Map<string, Shift[]>();
    for (const s of shifts) {
      const key = localDateKey(s.startsAt, tz);
      map.set(key, [...(map.get(key) ?? []), s]);
    }
    return [...map.entries()];
  }, [shifts, tz]);

  return (
    <section aria-labelledby={`wk-${week.weekStart}`} className="space-y-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id={`wk-${week.weekStart}`} className="text-section-title text-text-primary">
          {title}
        </h2>
        <span className="text-meta text-text-muted">{fmtWeekRange(week.weekStart)}</span>
        {commitment?.lightWeek && <Pill tone="accent">Light week</Pill>}
        {commitment?.powerWeek && (
          <Pill tone="success" icon={<Trophy />}>
            Power week
          </Pill>
        )}
        {(week.isCurrentWeek || week.deadlinePassed) && (
          <div className="ml-auto flex items-center gap-1">
            <Button variant="fe-ghost" size="sm" onClick={() => onRequestWeek(data, 'add')}>
              <Plus /> Add time
            </Button>
            <Button variant="fe-ghost" size="sm" onClick={() => onRequestWeek(data, 'light_week')}>
              Light week
            </Button>
          </div>
        )}
      </header>

      <HoursCounter
        scheduledHours={scheduledHours}
        powerHours={powerHours}
        minHours={week.minHours}
        under={under}
        submitted={commitment?.submittedAt != null}
        isNextWeek={week.isNextWeek}
      />

      {week.isCurrentWeek && commitment?.powerDialPct != null && commitment.powerDialPct > 0 && (
        <PowerProgress pct={commitment.powerDialPct} />
      )}

      {byDay.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title={week.isNextWeek ? 'No shifts picked yet' : 'No shifts this week'}
          body={
            week.isNextWeek && !week.deadlinePassed
              ? 'Pick your hours and they will show up here.'
              : 'Shifts you schedule or get added will show up here.'
          }
          className="p-8"
        />
      ) : (
        <div className="space-y-4">
          {byDay.map(([dayKey, dayShifts]) => (
            <div key={dayKey}>
              <h3 className="mb-1.5 px-1 text-meta font-medium uppercase tracking-wide text-text-muted">
                {fmtDateOnly(dayKey, { weekday: 'long', month: 'short', day: 'numeric' })}
              </h3>
              <ul className="space-y-2">
                {dayShifts.map((s) => (
                  <li key={s.id}>
                    <ShiftCard
                      shift={s}
                      tz={tz}
                      roster={data.roster}
                      kpi={kpiByShift.get(s.id)}
                      onRequestChange={() => onRequestChange(s, data)}
                    />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function HoursCounter({
  scheduledHours,
  powerHours,
  minHours,
  under,
  submitted,
  isNextWeek,
}: {
  scheduledHours: number;
  powerHours: number;
  minHours: number;
  under: boolean;
  submitted: boolean;
  isNextWeek: boolean;
}) {
  // No upper limit is shown: the bar fills to the minimum and stops there.
  const pct = minHours > 0 ? Math.min(100, (scheduledHours / minHours) * 100) : 100;
  // An unsubmitted next week isn't a failure yet; keep the number neutral until they submit.
  const alarm = under && !(isNextWeek && !submitted);
  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div>
          <div
            className={cn(
              'text-metric text-2xl font-semibold leading-none',
              alarm ? 'text-danger' : 'text-text-primary'
            )}
          >
            {fmtHours(scheduledHours)}
          </div>
          <div className="mt-1.5 text-meta text-text-secondary">
            {fmtHours(powerHours)} in power windows · {fmtHours(minHours)} minimum
          </div>
        </div>
        {alarm && (
          <Pill tone="danger">
            {fmtHours(Math.max(0, minHours - scheduledHours))} under the minimum
          </Pill>
        )}
        {!alarm && scheduledHours >= minHours && <Pill tone="success">Minimum met</Pill>}
      </div>
      <Progress
        value={pct}
        aria-label={`${fmtHours(scheduledHours)} of ${fmtHours(minHours)} minimum`}
        className={cn('mt-3 h-1.5 bg-white/5', alarm && '[&>div]:bg-danger')}
      />
    </div>
  );
}

function PowerProgress({ pct }: { pct: number }) {
  const v = Math.round(pct);
  return (
    <div className="flex items-center gap-3 rounded-app-lg border border-accent-to/20 bg-accent-to/5 px-4 py-3">
      <Zap className="h-4 w-4 shrink-0 text-accent-to" />
      <p className="text-body text-text-primary">
        <span className="text-metric font-semibold">{v}%</span> of your dialing this week is in
        power windows.
      </p>
    </div>
  );
}

function PowerWeekHistory({ data }: { data: ShiftsWeekResponse }) {
  return (
    <section aria-labelledby="power-weeks" className="space-y-2">
      <h2 id="power-weeks" className="text-section-title text-text-primary">
        Power weeks
      </h2>
      <ul className="space-y-2">
        {data.powerWeekHistory.map((p) => (
          <li
            key={p.weekStart}
            className="flex items-start gap-3 rounded-app-lg border border-success/20 bg-success-soft px-4 py-3"
          >
            <Trophy className="mt-0.5 h-4 w-4 shrink-0 text-success" />
            <div className="min-w-0">
              <div className="text-body text-text-primary">{p.sentence}</div>
              <div className="text-meta text-text-muted">Week of {fmtWeekRange(p.weekStart)}</div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function alsoOn(shift: Shift, roster: ShiftRosterEntry[]): string[] {
  const names = new Set<string>();
  for (const r of roster) {
    if (r.isMe || r.userId === shift.userId) continue;
    if (r.startsAt < shift.endsAt && r.endsAt > shift.startsAt) names.add(r.name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

function ShiftCard({
  shift,
  tz,
  roster,
  kpi,
  onRequestChange,
}: {
  shift: Shift;
  tz: string;
  roster: ShiftRosterEntry[];
  kpi: ShiftKpi | undefined;
  onRequestChange: () => void;
}) {
  const now = Date.now();
  const started = new Date(shift.startsAt).getTime() <= now;
  const ended = new Date(shift.endsAt).getTime() <= now;
  const live = started && !ended && shift.status === 'scheduled';
  const canRequest = !started && shift.status === 'scheduled';
  const others = useMemo(() => alsoOn(shift, roster), [shift, roster]);
  const shown = others.slice(0, 3);
  const extra = others.length - shown.length;

  return (
    <div
      className={cn(
        'rounded-app-lg border bg-surface-1 p-4 transition-colors',
        live ? 'border-accent-to/40' : 'border-border-subtle'
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="text-metric text-base font-semibold text-text-primary">
              {fmtRange(shift.startsAt, shift.endsAt, tz)}
            </span>
            <span className="text-meta text-text-secondary">
              {ACTIVITY_LABEL[shift.activity]} · {fmtHours(shift.hours)}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {live ? (
              <Pill tone="accent" icon={<Radio />}>
                Live now
              </Pill>
            ) : (
              <ShiftStatusPill status={shift.status} />
            )}
            {shift.powerMinutes > 0 && (
              <Pill tone="accent" icon={<Zap />}>
                Power window
              </Pill>
            )}
            {shift.hasPendingRequest && <Pill tone="warning">Change requested</Pill>}
          </div>
          {others.length > 0 && (
            <p className="text-meta text-text-muted">
              Also on: <span className="text-text-secondary">{shown.join(', ')}</span>
              {extra > 0 && ` +${extra} more`}
            </p>
          )}
        </div>
        {canRequest && !shift.hasPendingRequest && (
          <Button
            variant="fe-secondary"
            size="sm"
            onClick={onRequestChange}
            className="self-start"
            aria-label={`Request change for ${fmtRange(shift.startsAt, shift.endsAt, tz)} shift`}
          >
            Request change
          </Button>
        )}
      </div>
      {kpi && <KpiStrip kpi={kpi} />}
    </div>
  );
}

function KpiStrip({ kpi }: { kpi: ShiftKpi }) {
  const stats: [string, string][] = [
    ['Active', fmtMinutes(kpi.activeDialMinutes)],
    ['Dials', String(kpi.dials)],
    ['Connects', String(kpi.connects)],
    ['Conversations', String(kpi.conversations)],
  ];
  return (
    <div className="mt-3 border-t border-border-subtle pt-3">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-meta text-text-muted">{label}</dt>
            <dd className="text-metric text-body font-medium text-text-primary">{value}</dd>
          </div>
        ))}
      </dl>
      {kpi.flags.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {kpi.flags.map((f) => (
            <Pill key={f} tone="warning">
              {flagLabel(f)}
            </Pill>
          ))}
        </div>
      )}
      {!kpi.final && <p className="mt-2 text-meta text-text-muted">Numbers are still updating.</p>}
    </div>
  );
}

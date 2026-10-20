import { Fragment, useMemo, useState } from 'react';
import { BarChart3, ChevronRight, RefreshCw, Trophy, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/app/EmptyState';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/components/ui/utils';
import { computeShiftKpi, type AdminShiftsOverview, type ShiftKpi } from '@/lib/api';
import { Pill } from '../shifts/pills';
import { ClockSummary } from '../shifts/ShiftClock';
import { SurveyAnswers, SurveySummaryCard } from './SurveyPanels';
import {
  fmtDay,
  fmtHours,
  fmtRange,
  fmtTime,
  fmtMinutes,
  flagLabel,
  displayName,
} from '../shifts/shiftFormat';

interface Props {
  overview: AdminShiftsOverview;
  /** Live numbers were refreshed; the shell refetches. */
  onRefreshed: () => void;
}

const nf = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const pct = (n: number | null) => (n === null ? '–' : `${nf.format(n)}%`);
const dash = (n: number | null) => (n === null ? '–' : nf.format(n));

/** Weekly rollup (by name, never by rank), Power week callouts, and one row per finished dialing
 *  shift. Every number is the server's; nothing is recomputed here. */
export function ShiftKpiTable({ overview, onRefreshed }: Props) {
  const tz = overview.week.timezone;
  const [intern, setIntern] = useState('all');
  const [powerOnly, setPowerOnly] = useState(false);
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const shiftById = useMemo(
    () => new Map(overview.shifts.map((s) => [s.id, s])),
    [overview.shifts]
  );
  const rows = useMemo(() => {
    return overview.kpis
      .map((k) => ({ k, s: shiftById.get(k.shiftId) }))
      .filter((x): x is { k: ShiftKpi; s: NonNullable<typeof x.s> } => !!x.s)
      .filter(({ s }) => s.activity === 'dialing')
      .filter(
        ({ k, s }) =>
          (intern === 'all' || s.userId === intern) &&
          (!powerOnly || k.powerActiveMinutes > 0) &&
          (!flaggedOnly || k.flags.length > 0)
      )
      .sort((a, b) => b.s.startsAt.localeCompare(a.s.startsAt));
  }, [overview.kpis, shiftById, intern, powerOnly, flaggedOnly]);

  const rollup = useMemo(
    () => [...overview.rollup].sort((a, b) => a.name.localeCompare(b.name)),
    [overview.rollup]
  );
  const internsWithKpis = useMemo(() => {
    const ids = new Set(overview.kpis.map((k) => k.userId));
    return overview.members
      .filter((m) => ids.has(m.userId))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [overview.kpis, overview.members]);

  const now = Date.now();
  const live = overview.shifts.filter(
    (s) =>
      s.status === 'scheduled' &&
      s.activity === 'dialing' &&
      new Date(s.startsAt).getTime() <= now &&
      new Date(s.endsAt).getTime() > now
  );

  const refreshLive = async () => {
    setRefreshing(true);
    try {
      await Promise.all(live.map((s) => computeShiftKpi(s.id)));
      toast.success('Live numbers updated');
      onRefreshed();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not refresh live numbers.');
    } finally {
      setRefreshing(false);
    }
  };

  const hasAnything = rollup.length > 0 || overview.kpis.length > 0;

  return (
    <div className="space-y-6">
      {overview.powerWeekCallouts.length > 0 && (
        <section
          aria-label="Power week callouts"
          className="rounded-app-lg border border-success/25 bg-success-soft p-4"
        >
          <h2 className="mb-2 flex items-center gap-2 text-section-title text-text-primary">
            <Trophy className="h-4 w-4 text-success" /> Power weeks
          </h2>
          <ul className="space-y-1">
            {overview.powerWeekCallouts.map((c) => (
              <li key={c.userId} className="text-body text-text-primary">
                {c.sentence}
              </li>
            ))}
          </ul>
        </section>
      )}

      {live.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-app-lg border border-border-subtle bg-surface-1 px-4 py-3">
          <span className="relative flex h-2 w-2" aria-hidden>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-success" />
          </span>
          <p className="min-w-0 flex-1 text-body text-text-secondary">
            {live.length === 1 ? '1 shift is' : `${live.length} shifts are`} in progress. Numbers
            for those update as they go.
          </p>
          <Button
            variant="fe-secondary"
            size="sm"
            onClick={() => void refreshLive()}
            loading={refreshing}
          >
            {!refreshing && <RefreshCw />} Refresh live numbers
          </Button>
        </div>
      )}

      {!hasAnything ? (
        <EmptyState
          icon={BarChart3}
          title="No shift results yet"
          body="Results appear here once interns finish their dialing shifts this week."
        />
      ) : (
        <>
          <section aria-label="Weekly rollup" className="space-y-2">
            <h2 className="text-section-title text-text-primary">Weekly rollup</h2>
            <div className="overflow-x-auto rounded-app-lg border border-border-subtle bg-surface-1">
              <table className="w-full min-w-[640px] border-collapse text-body">
                <thead>
                  <tr className="border-b border-border-subtle text-meta text-text-muted">
                    <Th left sticky>
                      Intern
                    </Th>
                    <Th>Scheduled</Th>
                    <Th>Dialing</Th>
                    <Th>High leverage</Th>
                    <Th>Dials</Th>
                    <Th>Conversations</Th>
                    <Th>Sign-ups</Th>
                    <Th>Missed</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {rollup.map((r) => (
                    <tr key={r.userId}>
                      <td className="sticky left-0 z-10 bg-surface-1 px-3 py-2 text-text-primary">
                        <span className="font-medium" title={r.name}>
                          {displayName(r.name)}
                        </span>
                        {r.powerWeek && (
                          <Pill tone="success" icon={<Trophy />} className="ml-2">
                            Power week
                          </Pill>
                        )}
                      </td>
                      <Td>{fmtHours(r.hoursScheduled)}</Td>
                      <Td>{fmtHours(r.hoursDialing)}</Td>
                      <Td>{pct(r.powerDialPct)}</Td>
                      <Td>{nf.format(r.dials)}</Td>
                      <Td>{nf.format(r.conversations)}</Td>
                      <Td>{r.signUps === undefined ? '–' : nf.format(r.signUps)}</Td>
                      <Td className={r.missedShifts > 0 ? 'text-warning' : undefined}>
                        {r.missedShifts}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {overview.surveySummary && <SurveySummaryCard summary={overview.surveySummary} />}

          <section aria-label="Shift results" className="space-y-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <h2 className="mr-auto text-section-title text-text-primary">Shift results</h2>
              <Select value={intern} onValueChange={setIntern}>
                <SelectTrigger size="sm" className="w-44" aria-label="Filter by intern">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All interns</SelectItem>
                  {internsWithKpis.map((m) => (
                    <SelectItem key={m.userId} value={m.userId}>
                      {displayName(m.name)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex items-center gap-2 text-body text-text-secondary">
                <Checkbox checked={powerOnly} onCheckedChange={(v) => setPowerOnly(v === true)} />
                High leverage only
              </label>
              <label className="flex items-center gap-2 text-body text-text-secondary">
                <Checkbox
                  checked={flaggedOnly}
                  onCheckedChange={(v) => setFlaggedOnly(v === true)}
                />
                Flagged only
              </label>
            </div>
            {rows.length === 0 ? (
              <p className="rounded-app-lg border border-dashed border-border-subtle p-6 text-center text-body text-text-secondary">
                {overview.kpis.length === 0 || (intern === 'all' && !powerOnly && !flaggedOnly)
                  ? 'No finished shifts yet. Results appear here once a dialing shift has run.'
                  : 'No shifts match these filters.'}
              </p>
            ) : (
              <div className="overflow-x-auto rounded-app-lg border border-border-subtle bg-surface-1">
                <table className="w-full min-w-[1250px] border-collapse text-body">
                  <thead>
                    <tr className="border-b border-border-subtle text-meta text-text-muted">
                      <Th left sticky>
                        Intern
                      </Th>
                      <Th left>Date</Th>
                      <Th left>Time</Th>
                      <Th left>Clock-in</Th>
                      <Th>Sched min</Th>
                      <Th>Active min</Th>
                      <Th>
                        <span className="inline-flex items-center gap-1">
                          <Zap className="h-3 w-3 text-warning" /> High leverage min
                        </span>
                      </Th>
                      <Th>Adherence</Th>
                      <Th>Late start</Th>
                      <Th>Early end</Th>
                      <Th>Longest idle</Th>
                      <Th>Dials</Th>
                      <Th>Connects</Th>
                      <Th>Convos</Th>
                      <Th>Sign-ups</Th>
                      <Th>Conversion</Th>
                      <Th>Dials / hr</Th>
                      <Th>Connect rate</Th>
                      <Th left>Flags</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {rows.map(({ k, s }) => {
                      const isOpen = expanded.has(k.shiftId);
                      const clockedAt = k.clockedInAt ?? s.clockedInAt ?? null;
                      const late = k.clockInLateMinutes ?? s.clockInLateMinutes ?? 0;
                      return (
                        <Fragment key={k.shiftId}>
                          <tr className="hover:bg-white/[0.03]">
                            <td className="sticky left-0 z-10 whitespace-nowrap bg-surface-1 px-3 py-2 font-medium text-text-primary">
                              <button
                                type="button"
                                onClick={() => toggle(k.shiftId)}
                                aria-expanded={isOpen}
                                aria-controls={`kpi-detail-${k.shiftId}`}
                                aria-label={`${isOpen ? 'Hide' : 'Show'} survey answers for ${displayName(s.userName)}, ${fmtDay(s.startsAt, tz)}`}
                                className="mr-1.5 inline-flex h-5 w-5 items-center justify-center rounded text-text-muted align-middle hover:bg-white/5 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-to/60"
                              >
                                <ChevronRight
                                  className={cn(
                                    'h-4 w-4 transition-transform',
                                    isOpen && 'rotate-90'
                                  )}
                                />
                              </button>
                              {displayName(s.userName)}
                              {!k.final && (
                                <Pill tone="accent" className="ml-2">
                                  Live
                                </Pill>
                              )}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-text-secondary">
                              {fmtDay(s.startsAt, tz)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-text-secondary">
                              {fmtRange(s.startsAt, s.endsAt, tz)}
                            </td>
                            <td className="whitespace-nowrap px-3 py-2 text-text-secondary">
                              {clockedAt ? (
                                <span className="inline-flex items-center gap-1.5">
                                  {fmtTime(clockedAt, tz)}
                                  {late > 0 && (
                                    <Pill
                                      tone={
                                        k.flags.includes('late_clock_in') ? 'warning' : 'neutral'
                                      }
                                    >
                                      {late} min late
                                    </Pill>
                                  )}
                                </span>
                              ) : (
                                <span className="text-text-muted">–</span>
                              )}
                            </td>
                            <Td>{k.scheduledMinutes}</Td>
                            <Td>{k.activeDialMinutes}</Td>
                            <Td>{k.powerActiveMinutes}</Td>
                            <Td
                              className={
                                k.adherencePct < overview.settings.adherenceFlagPct
                                  ? 'text-warning'
                                  : undefined
                              }
                            >
                              {k.adherencePct}%
                            </Td>
                            <Td>{k.lateStartMinutes > 0 ? fmtMinutes(k.lateStartMinutes) : '–'}</Td>
                            <Td>{k.earlyEndMinutes > 0 ? fmtMinutes(k.earlyEndMinutes) : '–'}</Td>
                            <Td>{fmtMinutes(k.longestIdleMinutes)}</Td>
                            <Td>{k.dials}</Td>
                            <Td>{k.connects}</Td>
                            <Td>{k.conversations}</Td>
                            <Td>{k.signUps}</Td>
                            <Td>{pct(k.conversionRatePct)}</Td>
                            <Td>{dash(k.dialsPerActiveHour)}</Td>
                            <Td>{pct(k.connectRatePct)}</Td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {k.flags.length === 0 ? (
                                  <span className="text-text-muted">–</span>
                                ) : (
                                  k.flags.map((f) => (
                                    <Pill key={f} tone="warning">
                                      {flagLabel(f)}
                                    </Pill>
                                  ))
                                )}
                              </div>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr id={`kpi-detail-${k.shiftId}`} className="bg-white/[0.02]">
                              <td colSpan={17} className="px-4 py-3">
                                <div className="sticky left-0 w-[min(56rem,calc(100vw-5rem))] space-y-3">
                                  <ClockSummary shift={s} tz={tz} bare />
                                  <SurveyAnswers shift={s} tz={tz} />
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Th({
  children,
  left,
  sticky,
}: {
  children: React.ReactNode;
  left?: boolean;
  sticky?: boolean;
}) {
  return (
    <th
      scope="col"
      className={cn(
        'whitespace-nowrap px-3 py-2 font-medium',
        left ? 'text-left' : 'text-right',
        sticky && 'sticky left-0 z-10 bg-surface-1'
      )}
    >
      {children}
    </th>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td
      className={cn(
        'text-metric whitespace-nowrap px-3 py-2 text-right tabular-nums text-text-primary',
        className
      )}
    >
      {children}
    </td>
  );
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Check, RotateCcw, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/components/ui/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  ShiftsApiError,
  submitShiftsWeek,
  type ShiftActivity,
  type ShiftsWeekResponse,
} from '@/lib/api';
import { PickBlocks } from './PickBlocks';
import { PickDayView } from './PickDayView';
import { PickGrid } from './PickGrid';
import {
  ACTIVITY_FILL,
  ACTIVITY_ORDER,
  buildDays,
  buildHeadcount,
  minRangeLabel,
  picksFromShifts,
  removeBlock,
  serializePicks,
  setBlockActivity,
  toBlockInputs,
  toBlocks,
  totals,
  hhmmToMin,
  type PickBlock,
  type Picks,
} from './pickerModel';
import { ACTIVITY_LABEL, fmtDateOnly, fmtDeadline, fmtHours, fmtWeekRange } from './shiftFormat';

interface WeekPickerProps {
  /** Next week's data (the only week that can still be picked). */
  week: ShiftsWeekResponse;
  /** The server accepted a submit; the parent refetches (rosters included) and shows My Shifts. */
  onSubmitted: () => void;
  /** The server says the deadline passed while the picker was open. */
  onClosed: () => void;
}

function describeBlock(b: PickBlock | undefined): string {
  if (!b) return 'one of your picks';
  return `${fmtDateOnly(b.date, { weekday: 'short', month: 'short', day: 'numeric' })}, ${minRangeLabel(b.startMin, b.endMin)}`;
}

/** Pick Next Week: paint-to-select calendar on desktop, one-day-at-a-time chips on phones.
 *  The server (submit_week) stays authoritative for every rule; this only prevents obviously
 *  invalid input and explains server refusals in plain language. */
export function WeekPicker({ week, onSubmitted, onClosed }: WeekPickerProps) {
  const { week: info, settings, openHours, powerWindows } = week;
  const isMobile = useBreakpoint() === 'mobile';
  const days = useMemo(
    () => buildDays(info.weekStart, openHours, powerWindows),
    [info.weekStart, openHours, powerWindows]
  );
  const initial = useMemo(
    () => picksFromShifts(week.myShifts, info.timezone),
    [week.myShifts, info.timezone]
  );
  const baseline = useMemo(() => serializePicks(initial.picks), [initial]);
  const [picks, setPicks] = useState<Picks>(initial.picks);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headcount = useMemo(
    () => buildHeadcount(week.roster, info.timezone),
    [week.roster, info.timezone]
  );

  const dirty = serializePicks(picks) !== baseline;
  const { hours, powerHours } = totals(picks, days);
  const min = info.minHours;
  const missing = Math.max(0, min - hours);
  const blocks = useMemo(() => toBlocks(picks), [picks]);
  const submitted = week.commitment?.submittedAt != null;
  const canSubmit = !submitting && hours >= min && (dirty || !submitted);

  // Leaving the page with unsaved picks asks first. (Tab switches inside Shifts keep the draft.)
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const change = useCallback((next: Picks) => {
    setError(null);
    setPicks(next);
  }, []);

  const submit = async () => {
    const inputs = toBlockInputs(picks);
    setSubmitting(true);
    setError(null);
    try {
      await submitShiftsWeek(info.weekStart, inputs);
      toast.success(`Week submitted · ${fmtHours(hours)} picked`);
      onSubmitted();
    } catch (e) {
      const err = e instanceof ShiftsApiError ? e : null;
      const idx = typeof err?.details.index === 'number' ? (err.details.index as number) : -1;
      let msg = e instanceof Error ? e.message : 'Could not submit your week. Try again.';
      switch (err?.code) {
        case 'deadline_passed':
          msg = 'Picking for this week has closed. You can still ask for changes from My Shifts.';
          onClosed();
          break;
        case 'under_minimum':
          msg = `You picked ${fmtHours(Number(err.details.hours ?? hours))}, the minimum is ${fmtHours(
            Number(err.details.minimum ?? min)
          )}.`;
          break;
        case 'bad_block': {
          const what = idx >= 0 ? `The pick on ${describeBlock(blocks[idx])}` : 'One of your picks';
          const why = err.details.reason;
          msg =
            why === 'outside_open_hours'
              ? `${what} is outside open hours.`
              : why === 'bad_time_step'
                ? `${what} must start and end on the hour or half hour.`
                : `${what} isn't valid. Times must be inside open hours and start and end on the hour or half hour.`;
          break;
        }
        case 'overlap':
          msg =
            err.details.reason === 'conflicts_with_existing_shift' || idx < 0
              ? 'One of your picks overlaps a shift your manager set or approved. Remove that time and submit again.'
              : `The pick on ${describeBlock(blocks[idx])} overlaps another pick with a different activity.`;
          break;
      }
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  const hasLocked = Object.keys(initial.locked).length > 0;
  const windowLegend = powerWindows
    .filter((w) => w.active)
    .map((w) => `${w.label} ${minRangeLabel(hhmmToMin(w.startTime), hhmmToMin(w.endTime))}`);

  if (days.length === 0) {
    return (
      <p className="text-body text-text-secondary">
        No days are open for picking this week. Ask your manager to set the open hours.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-section-title text-text-primary">
          Pick your hours for {fmtWeekRange(info.weekStart)}
        </h2>
        <p className="text-meta text-text-secondary">
          Closes {fmtDeadline(info.deadlineAt, info.timezone)}.{' '}
          {isMobile
            ? 'Add times in 30-minute steps.'
            : 'Click or drag to paint time. Drag from a picked slot to erase.'}{' '}
          {fmtHours(min)} minimum, no maximum.
        </p>
      </div>

      <Legend windowLegend={windowLegend} hasLocked={hasLocked} />

      {isMobile ? (
        <PickDayView
          days={days}
          picks={picks}
          locked={initial.locked}
          headcount={headcount}
          onChange={change}
        />
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_300px]">
          <div className="overflow-hidden rounded-app-lg border border-border-subtle bg-surface-1">
            <PickGrid
              days={days}
              picks={picks}
              locked={initial.locked}
              headcount={headcount}
              onChange={change}
            />
          </div>
          <aside aria-label="Your picks" className="lg:sticky lg:top-4">
            <h3 className="mb-2 text-meta font-medium uppercase tracking-wide text-text-muted">
              Your picks
            </h3>
            {blocks.length === 0 ? (
              <p className="rounded-app-md border border-dashed border-border-subtle px-3 py-6 text-center text-body text-text-muted">
                Nothing picked yet. Paint time on the calendar to get started.
              </p>
            ) : (
              <PickBlocks
                blocks={blocks}
                days={days}
                headcount={headcount}
                onActivity={(b, a: ShiftActivity) => change(setBlockActivity(picks, b, a))}
                onRemove={(b) => change(removeBlock(picks, b))}
              />
            )}
          </aside>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-app-md border border-danger/30 bg-danger-soft px-3 py-2.5 text-body text-text-primary"
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-danger" />
          {error}
        </div>
      )}

      <div
        className="sticky z-20 -mx-4 mt-6 border-t border-border-strong bg-surface-1/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6"
        style={{ bottom: 'var(--app-bottom-inset, 0px)' }}
      >
        <div className="mx-auto flex max-w-4xl items-center gap-x-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2 text-body text-text-primary">
              <span
                className={cn(
                  'text-metric whitespace-nowrap text-lg font-semibold',
                  hours < min && 'text-danger'
                )}
              >
                {fmtHours(hours)} selected
              </span>
              <span className="inline-flex items-center gap-1 text-meta text-warning">
                <Zap className="h-3 w-3" /> {fmtHours(powerHours)} high leverage
              </span>
              <span className="text-meta text-text-muted">· {fmtHours(min)} minimum</span>
            </div>
            <Progress
              value={Math.min(100, (hours / min) * 100)}
              aria-label={`${fmtHours(hours)} of ${fmtHours(min)} minimum`}
              className={cn('mt-1.5 h-1 bg-white/5', hours < min && '[&>div]:bg-warning')}
            />
            <div className="mt-1 text-meta text-text-muted" aria-live="polite">
              {hours < min
                ? `${fmtHours(missing)} to go`
                : dirty
                  ? 'Unsaved changes'
                  : submitted
                    ? 'Submitted. Your picks are saved.'
                    : ''}
            </div>
          </div>
          {dirty && (
            <Button
              variant="fe-ghost"
              size="sm"
              onClick={() => change(initial.picks)}
              disabled={submitting}
              aria-label="Discard changes"
            >
              <RotateCcw /> <span className="hidden sm:inline">Discard</span>
            </Button>
          )}
          <Button
            variant="primary"
            onClick={() => void submit()}
            disabled={!canSubmit}
            loading={submitting}
          >
            {!submitting && <Check />}
            {submitted ? 'Resubmit week' : 'Submit week'}
          </Button>
        </div>
      </div>
      <span className="sr-only">
        {settings.timezone} time. Activities:{' '}
        {ACTIVITY_ORDER.map((a) => ACTIVITY_LABEL[a]).join(', ')}.
      </span>
    </div>
  );
}

function Legend({ windowLegend, hasLocked }: { windowLegend: string[]; hasLocked: boolean }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-meta text-text-secondary">
      {ACTIVITY_ORDER.map((a) => (
        <li key={a} className="inline-flex items-center gap-1.5">
          <span className={cn('h-2.5 w-2.5 rounded-sm', ACTIVITY_FILL[a])} aria-hidden />
          {ACTIVITY_LABEL[a]}
        </li>
      ))}
      {windowLegend.length > 0 && (
        <li className="inline-flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-sm border border-warning/40 bg-warning/20"
            aria-hidden
          />
          <span className="font-medium text-warning">High leverage</span>
          <span className="hidden text-text-muted sm:inline">{windowLegend.join(' · ')}</span>
        </li>
      )}
      <li className="hidden items-center gap-1.5 text-text-muted sm:inline-flex">
        <span className="font-medium text-text-secondary">3</span> others working that slot
      </li>
      {hasLocked && (
        <li className="inline-flex items-center gap-1.5 text-text-muted">
          <span
            className="h-2.5 w-2.5 rounded-sm bg-[repeating-linear-gradient(135deg,rgba(255,255,255,0.25)_0_2px,transparent_2px_4px)]"
            aria-hidden
          />
          Set by your manager
        </li>
      )}
    </ul>
  );
}

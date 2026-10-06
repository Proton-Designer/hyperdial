import { useRef, useState } from 'react';
import { CheckCircle2, Play, Square } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/utils';
import { ShiftsApiError, clockShift, type Shift, type ShiftSurveyInput } from '@/lib/api';
import { Pill } from './pills';
import { COUNTDOWN_MAX_MS, clockPhase, describeClockError, fmtUntil, lateText } from './clockModel';
import { EndShiftDialog } from './EndShiftDialog';
import { useNow } from './useNow';
import { fmtTime } from './shiftFormat';

/** Codes that mean "your copy of this shift is out of date": refetch rather than just warn. */
const STALE = new Set(['not_found', 'shift_over', 'already_ended', 'shift_not_scheduled']);

interface Props {
  shift: Shift;
  tz: string;
  /** The server's updated shift after Start / End. */
  onUpdated: (shift: Shift) => void;
  /** The server says our copy is stale; the owner should refetch. */
  onStale?: () => void;
  /** Share a parent's clock (one timer for a whole list); omitted = this component keeps its own. */
  now?: number;
}

/** Start shift / "On shift since" / End shift for one of the caller's own shifts (§4b). Renders
 *  nothing when there is nothing to do (a finished shift, a shift far in the future). */
export function ShiftClock({ shift, tz, onUpdated, onStale, now: nowProp }: Props) {
  const own = useNow(30_000, nowProp === undefined);
  const now = nowProp ?? own;
  const phase = clockPhase(shift, now);
  const [busy, setBusy] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const endRef = useRef<HTMLButtonElement>(null);

  const fail = (e: unknown) => {
    if (e instanceof ShiftsApiError && e.code === 'too_early') {
      const at = typeof e.details.opensAt === 'string' ? e.details.opensAt : null;
      toast.error(
        at ? `You can start at ${fmtTime(at, tz)}.` : 'It’s too early to start this shift.'
      );
      return;
    }
    toast.error(describeClockError(e));
    if (e instanceof ShiftsApiError && STALE.has(e.code)) onStale?.();
  };

  const start = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { shift: updated } = await clockShift(shift.id, 'start');
      onUpdated(updated);
      toast.success(
        updated.clockedInAt
          ? `Shift started at ${fmtTime(updated.clockedInAt, tz)}`
          : 'Shift started'
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const end = async (survey?: ShiftSurveyInput) => {
    try {
      const { shift: updated } = await clockShift(shift.id, 'end', survey);
      onUpdated(updated);
      toast.success('Shift ended');
    } catch (e) {
      if (e instanceof ShiftsApiError && STALE.has(e.code)) onStale?.();
      throw e;
    }
  };

  if (phase.kind === 'none') return null;

  if (phase.kind === 'waiting') {
    const ms = new Date(shift.startsAt).getTime() - now;
    if (ms > COUNTDOWN_MAX_MS) return null;
    return (
      <p className="text-meta text-text-muted" aria-live="polite">
        Starts in {fmtUntil(ms)}
      </p>
    );
  }

  if (phase.kind === 'ready') {
    return (
      <Button variant="primary" size="sm" onClick={() => void start()} loading={busy}>
        {!busy && <Play />} Start shift
      </Button>
    );
  }

  if (phase.kind === 'on') {
    return (
      <>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-body text-text-primary">
            On shift since {fmtTime(phase.since, tz)}
          </span>
          {phase.late > 0 && <Pill>{lateText(phase.late)}</Pill>}
          <Button ref={endRef} variant="fe-secondary" size="sm" onClick={() => setEndOpen(true)}>
            <Square /> End shift
          </Button>
        </div>
        <EndShiftDialog
          open={endOpen}
          onOpenChange={setEndOpen}
          shift={shift}
          tz={tz}
          onSubmit={end}
          returnFocusRef={endRef}
        />
      </>
    );
  }

  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-text-secondary">
      <CheckCircle2 className="h-4 w-4 text-success" />
      Ended at {fmtTime(phase.at, tz)}
      {phase.surveyed && <Pill tone="success">Survey sent</Pill>}
    </p>
  );
}

/** "Started 2:04 PM (4 min late) · Ended 3:58 PM · Survey sent" for a shift that has been clocked.
 *  `bare` drops the divider (for use inside a dialog or table). */
export function ClockSummary({
  shift,
  tz,
  bare = false,
}: {
  shift: Shift;
  tz: string;
  bare?: boolean;
}) {
  if (!shift.clockedInAt) return null;
  const late = shift.clockInLateMinutes ?? 0;
  return (
    <p
      className={cn(
        'flex flex-wrap items-center gap-x-2 gap-y-1 text-meta text-text-secondary',
        !bare && 'mt-3 border-t border-border-subtle pt-3'
      )}
    >
      <span>
        Started {fmtTime(shift.clockedInAt, tz)}
        {late > 0 && ` (${lateText(late)})`}
      </span>
      {shift.clockedOutAt && <span>· Ended {fmtTime(shift.clockedOutAt, tz)}</span>}
      {shift.survey && <Pill tone="success">Survey sent</Pill>}
    </p>
  );
}

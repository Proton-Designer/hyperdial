import { useMemo, useState, type ReactNode } from 'react';
import { AlertCircle, Clock, Send, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  ShiftsApiError,
  createShiftRequest,
  type Shift,
  type ShiftActivity,
  type ShiftRequestType,
  type ShiftsWeekResponse,
} from '@/lib/api';
import {
  ACTIVITY_ORDER,
  SLOT,
  buildDays,
  buildHeadcount,
  minLabel,
  minRangeLabel,
  minToHhmm,
  namesOnDuring,
  type PickDay,
} from './pickerModel';
import {
  ACTIVITY_LABEL,
  REQUEST_TYPE_LABEL,
  fmtDateOnly,
  fmtHours,
  fmtShiftWhen,
  fmtWeekRange,
  localDateKey,
  localMinutes,
  zonedInstant,
} from './shiftFormat';

const REASON_MIN = 20;

export interface RequestChangeModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The shift the intern clicked "Request change" on; null for a week-level request. */
  shift: Shift | null;
  week: ShiftsWeekResponse;
  /** Called after a request is created so the parent can refresh its data. */
  onSubmitted: () => void;
  /** Which type to start on (week-level entry points: "Add time", "Light week"). */
  initialType?: ShiftRequestType;
}

const TYPE_HELP: Record<ShiftRequestType, string> = {
  move: 'Change this shift to a different time.',
  drop: 'Remove this shift from your week.',
  add: 'Ask to work extra time.',
  light_week: 'Ask for a lower weekly minimum this week.',
};

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let m = from; m <= to; m += SLOT) out.push(m);
  return out;
}

/** Request a change to a shift or to the week: move, drop, add time or a light week. Everything
 *  here is advisory; the server applies the same rules and the manager decides. */
export function RequestChangeModal(props: RequestChangeModalProps) {
  const { open, onOpenChange, shift, week } = props;
  const isMobile = useBreakpoint() === 'mobile';
  const tz = week.week.timezone;
  const title = shift ? 'Request a change' : 'Request a change to your week';
  const description = shift
    ? fmtShiftWhen(shift.startsAt, shift.endsAt, tz)
    : `Week of ${fmtWeekRange(week.week.weekStart)}`;
  const form = (
    <RequestForm
      // A fresh form (and state) per open, shift and week.
      key={`${shift?.id ?? 'week'}|${week.week.weekStart}|${props.initialType ?? ''}`}
      {...props}
      onClose={() => onOpenChange(false)}
    />
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="bottom"
          className="max-h-[92dvh] gap-0 overflow-hidden rounded-t-app-lg border-border-subtle bg-surface-1 p-0 text-text-primary"
        >
          <SheetHeader className="border-b border-border-subtle px-4 py-3 text-left">
            <SheetTitle className="text-section-title text-text-primary">{title}</SheetTitle>
            <SheetDescription className="text-meta text-text-secondary">
              {description}
            </SheetDescription>
          </SheetHeader>
          {open && form}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden border-border-subtle bg-surface-1 p-0 text-text-primary sm:max-w-xl">
        <DialogHeader className="border-b border-border-subtle px-6 py-4 text-left">
          <DialogTitle className="text-section-title text-text-primary">{title}</DialogTitle>
          <DialogDescription className="text-meta text-text-secondary">
            {description}
          </DialogDescription>
        </DialogHeader>
        {open && form}
      </DialogContent>
    </Dialog>
  );
}

function RequestForm({
  shift,
  week,
  onSubmitted,
  initialType,
  onClose,
}: RequestChangeModalProps & { onClose: () => void }) {
  const { week: info, settings, openHours, powerWindows } = week;
  const tz = info.timezone;
  const days = useMemo(
    () => buildDays(info.weekStart, openHours, powerWindows),
    [info.weekStart, openHours, powerWindows]
  );
  const headcount = useMemo(() => buildHeadcount(week.roster, tz), [week.roster, tz]);
  const now = Date.now();

  const shiftBlocked = shift
    ? shift.status !== 'scheduled'
      ? 'This shift is no longer scheduled.'
      : shift.hasPendingRequest
        ? 'This shift already has a request waiting for review. Withdraw it first to send a new one.'
        : new Date(shift.startsAt).getTime() <= now
          ? 'This shift has already started, so it can no longer be changed.'
          : null
    : null;

  const types: ShiftRequestType[] = shift
    ? ['move', 'drop', 'add', 'light_week']
    : ['add', 'light_week'];
  const available = (t: ShiftRequestType) => !((t === 'move' || t === 'drop') && shiftBlocked);
  const firstType = (
    initialType && types.includes(initialType) ? initialType : types[0]
  ) as ShiftRequestType;
  const [type, setType] = useState<ShiftRequestType>(
    available(firstType) ? firstType : (types.find(available) ?? 'add')
  );

  // Time picker state. A move starts from the shift's own time; an add from the first open day.
  const startDate = shift ? localDateKey(shift.startsAt, tz) : null;
  const seedDay = days.find((d) => d.date === startDate) ?? days[0];
  const seedStart =
    shift && seedDay?.date === startDate
      ? localMinutes(shift.startsAt, tz)
      : (seedDay?.openFrom ?? 0);
  const seedEnd =
    shift && seedDay?.date === startDate
      ? seedStart +
        Math.round((new Date(shift.endsAt).getTime() - new Date(shift.startsAt).getTime()) / 60000)
      : Math.min(seedDay?.openUntil ?? 0, seedStart + 60);
  const [date, setDate] = useState(seedDay?.date ?? '');
  const [start, setStart] = useState(seedStart);
  const [end, setEnd] = useState(seedEnd);
  const [activity, setActivity] = useState<ShiftActivity>(shift?.activity ?? 'dialing');
  const [lightHours, setLightHours] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const day: PickDay | undefined = days.find((d) => d.date === date) ?? days[0];
  const reasonLen = reason.trim().length;
  const reasonOk = reasonLen >= REASON_MIN;
  const usesTime = type === 'move' || type === 'add';
  const notice = settings.changeNoticeHours;

  // ---- derived facts ------------------------------------------------------------------------
  const counted = week.myShifts.filter((s) =>
    ['scheduled', 'completed', 'missed'].includes(s.status)
  );
  const baseHours = week.commitment?.scheduledHours ?? counted.reduce((n, s) => n + s.hours, 0);
  const newHours = usesTime ? (end - start) / 60 : 0;
  const removed = type === 'move' || type === 'drop' ? (shift?.hours ?? 0) : 0;
  const after = baseHours - removed + (usesTime ? newHours : 0);
  const showUnderMin = (type === 'move' || type === 'drop') && after < info.minHours;

  const newStartMs = day && usesTime ? zonedInstant(day.date, start, tz) : null;
  const refStarts: number[] = [];
  if ((type === 'move' || type === 'drop') && shift)
    refStarts.push(new Date(shift.startsAt).getTime());
  if (usesTime && newStartMs !== null) refStarts.push(newStartMs);
  const soonest = refStarts.length ? Math.min(...refStarts) : null;
  const isLate = soonest !== null && soonest > now && soonest - now < notice * 3600000;

  const inPast = usesTime && newStartMs !== null && newStartMs <= now;
  const clash =
    usesTime && day && newStartMs !== null
      ? week.myShifts.some(
          (s) =>
            s.status === 'scheduled' &&
            s.id !== shift?.id &&
            new Date(s.startsAt).getTime() < zonedInstant(day.date, end, tz) &&
            new Date(s.endsAt).getTime() > newStartMs
        )
      : false;
  const timeBlock = !usesTime
    ? null
    : !day
      ? 'No days are open this week.'
      : end <= start
        ? 'Choose an end time after the start.'
        : inPast
          ? 'That time has already started. Choose a later time.'
          : clash
            ? 'You already have a shift at that time.'
            : null;

  const lightNum = Number(lightHours);
  const lightBlock =
    type !== 'light_week'
      ? null
      : lightHours.trim() === '' || !Number.isFinite(lightNum)
        ? 'Enter the hours you can do.'
        : lightNum <= 0
          ? 'Enter more than 0 hours.'
          : lightNum >= info.minHours
            ? `Choose fewer than the regular ${fmtHours(info.minHours)} minimum.`
            : null;

  const startOptions = day ? range(day.openFrom, day.openUntil - SLOT) : [];
  const endOptions = day ? range(start + SLOT, day.openUntil) : [];
  const others = day && usesTime ? namesOnDuring(headcount, day.date, start, end) : [];
  const power = useMemo(() => {
    if (!day || !usesTime) return 0;
    let n = 0;
    for (const w of day.windows) n += Math.max(0, Math.min(end, w.end) - Math.max(start, w.start));
    return n;
  }, [day, usesTime, start, end]);

  const blocked =
    type === 'move' || type === 'drop'
      ? (shiftBlocked ?? (type === 'move' ? timeBlock : null))
      : null;
  const fieldBlock = type === 'add' ? timeBlock : type === 'light_week' ? lightBlock : blocked;
  const canSubmit = !submitting && reasonOk && fieldBlock === null;

  const changeDate = (v: string) => {
    const d = days.find((x) => x.date === v);
    if (!d) return;
    setDate(v);
    const s = Math.min(Math.max(start, d.openFrom), d.openUntil - SLOT);
    setStart(s);
    setEnd(Math.min(d.openUntil, Math.max(s + SLOT, s + (end - start))));
    setError(null);
  };

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await createShiftRequest({
        type,
        ...(shift && (type === 'move' || type === 'drop') ? { fromShiftId: shift.id } : {}),
        ...(usesTime && day
          ? { date: day.date, start: minToHhmm(start), end: minToHhmm(end), toActivity: activity }
          : {}),
        ...(type === 'light_week' ? { requestedMinHours: lightNum, date: info.weekStart } : {}),
        reason: reason.trim(),
      });
      toast.success('Request sent to your manager');
      onSubmitted();
      onClose();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void submit();
      }}
    >
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4 sm:px-6">
        <fieldset>
          <legend className="mb-2 text-meta font-medium text-text-secondary">
            What do you need?
          </legend>
          <div
            className="grid grid-cols-2 gap-2 sm:grid-cols-4"
            role="group"
            aria-label="Request type"
          >
            {types.map((t) => {
              const on = type === t;
              const ok = available(t);
              return (
                <button
                  key={t}
                  type="button"
                  aria-pressed={on}
                  disabled={!ok}
                  onClick={() => {
                    setType(t);
                    setError(null);
                  }}
                  className={cn(
                    'rounded-app-md border px-3 py-2 text-left text-body font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-to/60 disabled:cursor-not-allowed disabled:opacity-40',
                    on
                      ? 'border-accent-to/50 bg-accent-from/25 text-text-primary'
                      : 'border-border-subtle bg-surface-2 text-text-secondary hover:border-border-strong'
                  )}
                >
                  {REQUEST_TYPE_LABEL[t]}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-meta text-text-muted">{TYPE_HELP[type]}</p>
        </fieldset>

        {shiftBlocked && (type === 'move' || type === 'drop' || !types.some(available)) && (
          <Notice tone="warning">{shiftBlocked}</Notice>
        )}
        {shiftBlocked && type !== 'move' && type !== 'drop' && (
          <Notice tone="warning">{shiftBlocked} Move and Drop are turned off for it.</Notice>
        )}

        {usesTime && day && (
          <section aria-label={type === 'move' ? 'New time' : 'Time to add'} className="space-y-3">
            <h3 className="text-meta font-medium text-text-secondary">
              {type === 'move' ? 'Move it to' : 'When can you work?'}
            </h3>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label="Day" className="col-span-2 sm:col-span-1">
                <Select value={day.date} onValueChange={changeDate}>
                  <SelectTrigger className="w-full" aria-label="Day">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {days.map((d) => (
                      <SelectItem key={d.date} value={d.date}>
                        {d.short} {fmtDateOnly(d.date)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="From">
                <Select
                  value={String(start)}
                  onValueChange={(v) => {
                    const s = Number(v);
                    setStart(s);
                    if (end <= s) setEnd(Math.min(day.openUntil, s + SLOT * 2));
                    setError(null);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Start time">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {startOptions.map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {minLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="To">
                <Select
                  value={String(end)}
                  onValueChange={(v) => {
                    setEnd(Number(v));
                    setError(null);
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="End time">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="max-h-64">
                    {endOptions.map((m) => (
                      <SelectItem key={m} value={String(m)}>
                        {minLabel(m)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Activity" className="col-span-2 sm:col-span-1">
                <Select value={activity} onValueChange={(v) => setActivity(v as ShiftActivity)}>
                  <SelectTrigger className="w-full" aria-label="Activity">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ACTIVITY_ORDER.map((a) => (
                      <SelectItem key={a} value={a}>
                        {ACTIVITY_LABEL[a]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            {day.windows.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 text-meta font-medium text-warning">
                  <Zap className="h-3.5 w-3.5" /> High leverage
                </span>
                {day.windows.map((w) => {
                  const a = Math.max(w.start, day.openFrom);
                  const b = Math.min(w.end, day.openUntil);
                  if (b <= a) return null;
                  const on = start === a && end === b;
                  return (
                    <button
                      key={w.label}
                      type="button"
                      aria-pressed={on}
                      onClick={() => {
                        setStart(a);
                        setEnd(b);
                        setError(null);
                      }}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-meta transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-to/60',
                        on
                          ? 'border-accent-to/50 bg-accent-from/25 text-text-primary'
                          : 'border-warning/30 bg-warning/[0.08] text-text-primary'
                      )}
                    >
                      {w.label} {minRangeLabel(a, b)}
                    </button>
                  );
                })}
              </div>
            )}

            <p className="flex flex-wrap items-center gap-x-2 text-meta text-text-muted">
              <Clock className="h-3.5 w-3.5" />
              <span className="text-metric text-text-secondary">
                {fmtHours(newHours)} · {minRangeLabel(start, end)}
              </span>
              {power > 0 && (
                <span className="inline-flex items-center gap-0.5 text-warning">
                  <Zap className="h-3 w-3" /> {fmtHours(power / 60)} high leverage
                </span>
              )}
              {others.length > 0 && (
                <span>
                  Also on then:{' '}
                  <span className="text-text-secondary">{others.slice(0, 3).join(', ')}</span>
                  {others.length > 3 && ` +${others.length - 3} more`}
                </span>
              )}
            </p>
          </section>
        )}

        {type === 'light_week' && (
          <section aria-label="Light week" className="space-y-2">
            <Field label="Hours you can do this week">
              <Input
                type="number"
                inputMode="decimal"
                min={0.5}
                max={Math.max(0, info.minHours - 0.5)}
                step={0.5}
                value={lightHours}
                onChange={(e) => {
                  setLightHours(e.target.value);
                  setError(null);
                }}
                aria-invalid={lightHours !== '' && lightBlock !== null}
                aria-describedby="light-help"
                placeholder={`Fewer than ${fmtHours(info.minHours)}`}
                className="max-w-[12rem]"
              />
            </Field>
            <p id="light-help" className="text-meta text-text-muted">
              The usual minimum is {fmtHours(info.minHours)}. If your manager approves, this week
              uses your number instead.
            </p>
            {lightHours !== '' && lightBlock && (
              <p className="text-meta text-danger">{lightBlock}</p>
            )}
          </section>
        )}

        {(type === 'move' || type === 'add') && timeBlock && !shiftBlocked && (
          <Notice tone="danger">{timeBlock}</Notice>
        )}

        {showUnderMin && (
          <Notice tone="warning">
            This leaves you at {fmtHours(Math.max(0, after))}, below the {fmtHours(info.minHours)}{' '}
            minimum. Your manager has to approve it.
          </Notice>
        )}
        {isLate && !shiftBlocked && (
          <Notice tone="warning">
            This is less than {notice} {notice === 1 ? 'hour' : 'hours'} before the shift, so it
            will be marked late.
          </Notice>
        )}

        <div>
          <label
            htmlFor="req-reason"
            className="mb-1.5 block text-meta font-medium text-text-secondary"
          >
            Reason
          </label>
          <Textarea
            id="req-reason"
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              setError(null);
            }}
            rows={3}
            maxLength={1000}
            placeholder="Tell your manager what changed so they can decide quickly."
            aria-describedby="req-reason-count"
            className="min-h-[88px]"
          />
          <p
            id="req-reason-count"
            aria-live="polite"
            className={cn('mt-1 text-meta', reasonOk ? 'text-success' : 'text-text-muted')}
          >
            {reasonOk
              ? `${reasonLen} characters`
              : `${reasonLen} / ${REASON_MIN} characters, ${REASON_MIN - reasonLen} more to go`}
          </p>
        </div>

        {error && <Notice tone="danger">{error}</Notice>}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-1 px-4 py-3 sm:px-6">
        <Button type="button" variant="fe-ghost" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={!canSubmit} loading={submitting}>
          {!submitting && <Send />} Send request
        </Button>
      </div>
    </form>
  );
}

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cn('block min-w-0', className)}>
      <span className="mb-1 block text-meta text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function Notice({ tone, children }: { tone: 'warning' | 'danger'; children: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2 rounded-app-md border px-3 py-2.5 text-body text-text-primary',
        tone === 'danger' ? 'border-danger/30 bg-danger-soft' : 'border-warning/30 bg-warning-soft'
      )}
    >
      <AlertCircle
        className={cn(
          'mt-0.5 h-4 w-4 shrink-0',
          tone === 'danger' ? 'text-danger' : 'text-warning'
        )}
      />
      <div>{children}</div>
    </div>
  );
}

/** Server refusals in plain language (codes: docs/design/shifts.md §3). */
function describeError(e: unknown): string {
  if (e instanceof ShiftsApiError) {
    switch (e.code) {
      case 'reason_too_short':
        return `Add a little more detail: the reason needs at least ${REASON_MIN} characters.`;
      case 'shift_started':
        return 'That shift has already started, so it can no longer be changed.';
      case 'request_pending':
        return 'This shift already has a request waiting for review. Withdraw it first to send a new one.';
      case 'bad_time_step':
        return 'Times must start and end on the hour or half hour.';
      case 'outside_open_hours':
        return 'That time is outside open hours. Choose a time inside the hours shown.';
      case 'bad_block':
        return e.details.reason === 'in_the_past'
          ? 'That time has already started. Choose a later time.'
          : 'That time isn’t valid. Choose a time inside open hours.';
      case 'bad_request':
        return e.details.reason === 'light_week_hours'
          ? 'A light week has to be more than 0 hours and under the usual minimum.'
          : e.details.reason === 'past_week'
            ? 'That week is already over.'
            : 'That request isn’t valid. Check the details and try again.';
      case 'overlap':
        return 'That time overlaps another of your shifts. Choose a different time.';
      case 'not_found':
        return 'That shift no longer exists. Close this and refresh your shifts.';
      case 'shifts_disabled':
        return 'Shifts is turned off for your team right now.';
      case 'forbidden':
      case 'unauthorized':
        return 'You don’t have access to request changes. Sign in again or ask your manager.';
    }
  }
  return e instanceof Error ? e.message : 'Could not send your request. Try again.';
}

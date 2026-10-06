import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Ban, Check, UserRoundX } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { cn } from '@/components/ui/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import {
  ShiftsApiError,
  adminUpdateShift,
  type AdminShiftsOverview,
  type ShiftActivity,
} from '@/lib/api';
import {
  ACTIVITY_ORDER,
  SLOT,
  buildDays,
  minLabel,
  minRangeLabel,
  minToHhmm,
} from '../shifts/pickerModel';
import { ShiftStatusPill } from '../shifts/pills';
import { ClockSummary } from '../shifts/ShiftClock';
import {
  ACTIVITY_LABEL,
  fmtDateOnly,
  fmtHours,
  fmtShiftWhen,
  localDateKey,
  localMinutes,
  displayName,
} from '../shifts/shiftFormat';
import type { TeamShift } from './coverageModel';

export type EditTarget =
  { kind: 'edit'; shift: TeamShift } | { kind: 'create'; date?: string; start?: number };

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: EditTarget | null;
  overview: AdminShiftsOverview;
  /** The server saved a change; the parent refetches. */
  onSaved: () => void;
}

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let m = from; m <= to; m += SLOT) out.push(m);
  return out;
}

/** Direct edit of one shift (move/resize, activity, cancel, excuse) or "Add shift for…". Saves as
 *  source = 'admin' and skips the request flow; the server enforces every rule. */
export function ShiftEditDialog(props: Props) {
  const { open, onOpenChange, overview } = props;
  // Keep the last target while the dialog animates closed, so the header doesn't change mid-exit.
  const lastTarget = useRef<EditTarget | null>(null);
  if (props.target) lastTarget.current = props.target;
  const target = props.target ?? lastTarget.current;
  const isMobile = useBreakpoint() === 'mobile';
  const tz = overview.week.timezone;
  // Focus goes back to whatever opened the dialog (a slot-panel row or the Add shift button); when that
  // control is gone after a save, to the grid's current cell, so keyboard users keep their place.
  const opener = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (open) opener.current = document.activeElement as HTMLElement | null;
  }, [open]);
  const restoreFocus = (e: Event) => {
    e.preventDefault();
    const el = opener.current;
    const fallback = document.querySelector<HTMLElement>('[data-slot-date][tabindex="0"]');
    (el && el.isConnected && el !== document.body ? el : fallback)?.focus();
  };
  const title = target?.kind === 'create' ? 'Add a shift' : 'Edit shift';
  const description =
    target?.kind === 'edit'
      ? `${displayName(target.shift.userName)} · ${fmtShiftWhen(target.shift.startsAt, target.shift.endsAt, tz)}`
      : `Week of ${fmtDateOnly(overview.week.weekStart)}`;
  const body =
    open && props.target ? (
      <EditForm
        key={
          props.target.kind === 'edit'
            ? props.target.shift.id
            : `new|${props.target.date ?? ''}|${props.target.start ?? ''}`
        }
        {...props}
        target={props.target}
        onClose={() => onOpenChange(false)}
      />
    ) : null;

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          onCloseAutoFocus={restoreFocus}
          side="bottom"
          className="max-h-[92dvh] gap-0 overflow-hidden rounded-t-app-lg border-border-subtle bg-surface-1 p-0 text-text-primary"
        >
          <SheetHeader className="border-b border-border-subtle px-4 py-3 text-left">
            <SheetTitle className="text-section-title text-text-primary">{title}</SheetTitle>
            <SheetDescription className="text-meta text-text-secondary">
              {description}
            </SheetDescription>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onCloseAutoFocus={restoreFocus}
        className="flex max-h-[90dvh] flex-col gap-0 overflow-hidden border-border-subtle bg-surface-1 p-0 text-text-primary sm:max-w-lg"
      >
        <DialogHeader className="border-b border-border-subtle px-6 py-4 text-left">
          <DialogTitle className="text-section-title text-text-primary">{title}</DialogTitle>
          <DialogDescription className="text-meta text-text-secondary">
            {description}
          </DialogDescription>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({
  target,
  overview,
  onSaved,
  onClose,
}: Props & { target: EditTarget; onClose: () => void }) {
  const tz = overview.week.timezone;
  const days = useMemo(
    () => buildDays(overview.week.weekStart, overview.openHours, overview.powerWindows),
    [overview.week.weekStart, overview.openHours, overview.powerWindows]
  );
  const shift = target.kind === 'edit' ? target.shift : null;
  const people = overview.members
    .filter((m) => m.participates)
    .sort((a, b) => a.name.localeCompare(b.name));

  const seedDate = shift
    ? localDateKey(shift.startsAt, tz)
    : (target.kind === 'create' && target.date) || days[0]?.date || '';
  const seedDay = days.find((d) => d.date === seedDate) ?? days[0];
  const seedStart = shift
    ? localMinutes(shift.startsAt, tz)
    : target.kind === 'create' && target.start !== undefined
      ? target.start
      : (seedDay?.openFrom ?? 0);
  const seedEnd = shift
    ? seedStart +
      Math.round((new Date(shift.endsAt).getTime() - new Date(shift.startsAt).getTime()) / 60000)
    : Math.min(seedDay?.openUntil ?? 0, seedStart + 60);

  const [userId, setUserId] = useState('');
  const [date, setDate] = useState(seedDay?.date ?? '');
  const [start, setStart] = useState(seedStart);
  const [end, setEnd] = useState(seedEnd);
  const [activity, setActivity] = useState<ShiftActivity>(shift?.activity ?? 'dialing');
  const [busy, setBusy] = useState<null | 'save' | 'cancel' | 'excuse'>(null);
  const [confirm, setConfirm] = useState<null | 'cancel' | 'excuse'>(null);
  const [error, setError] = useState<string | null>(null);

  const day = days.find((d) => d.date === date) ?? days[0];
  const editable = shift === null || shift.status === 'scheduled';
  const changed =
    shift === null ||
    date !== localDateKey(shift.startsAt, tz) ||
    start !== seedStart ||
    end !== seedEnd ||
    activity !== shift.activity;
  const canSave =
    !busy && editable && !!day && end > start && changed && (shift !== null || userId !== '');

  const startOptions = day ? range(day.openFrom, day.openUntil - SLOT) : [];
  const endOptions = day ? range(start + SLOT, day.openUntil) : [];

  const run = async (kind: 'save' | 'cancel' | 'excuse') => {
    if (!day && kind === 'save') return;
    setBusy(kind);
    setError(null);
    try {
      if (kind === 'save') {
        await adminUpdateShift(
          shift
            ? {
                action: 'move',
                shiftId: shift.id,
                date: day!.date,
                start: minToHhmm(start),
                end: minToHhmm(end),
                activity,
              }
            : {
                action: 'create',
                userId,
                date: day!.date,
                start: minToHhmm(start),
                end: minToHhmm(end),
                activity,
              }
        );
        toast.success(shift ? 'Shift updated' : 'Shift added');
      } else {
        await adminUpdateShift({
          action: kind === 'cancel' ? 'cancel' : 'excuse',
          shiftId: shift!.id,
        });
        toast.success(kind === 'cancel' ? 'Shift cancelled' : 'Shift marked excused');
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(describeAdminError(e));
      setConfirm(null);
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      className="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave) void run('save');
      }}
    >
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 sm:px-6">
        {shift && (
          <div className="flex flex-wrap items-center gap-2 text-meta text-text-secondary">
            <ShiftStatusPill status={shift.status} />
            <span>{fmtHours(shift.hours)}</span>
            {shift.source !== 'pick' && (
              <span className="text-text-muted">
                {shift.source === 'request' ? 'From an approved request' : 'Set by a manager'}
              </span>
            )}
          </div>
        )}
        {shift?.clockedInAt && <ClockSummary shift={shift} tz={tz} bare />}
        {!editable && (
          <Notice tone="warning">
            This shift is {shift!.status}, so it can no longer be changed.
          </Notice>
        )}

        {target.kind === 'create' && (
          <Field label="Intern">
            <Select value={userId} onValueChange={(v) => setUserId(v)}>
              <SelectTrigger className="w-full" aria-label="Intern">
                <SelectValue placeholder="Choose an intern" />
              </SelectTrigger>
              <SelectContent className="max-h-64">
                {people.map((m) => (
                  <SelectItem key={m.userId} value={m.userId}>
                    {displayName(m.name)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}

        {day ? (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Day" className="col-span-2">
              <Select
                value={day.date}
                disabled={!editable}
                onValueChange={(v) => {
                  const d = days.find((x) => x.date === v);
                  if (!d) return;
                  setDate(v);
                  const s = Math.min(Math.max(start, d.openFrom), d.openUntil - SLOT);
                  setStart(s);
                  setEnd(Math.min(d.openUntil, Math.max(s + SLOT, s + (end - start))));
                }}
              >
                <SelectTrigger className="w-full" aria-label="Day">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {days.map((d) => (
                    <SelectItem key={d.date} value={d.date}>
                      {d.long} {fmtDateOnly(d.date)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="From">
              <Select
                value={String(start)}
                disabled={!editable}
                onValueChange={(v) => {
                  const s = Number(v);
                  setStart(s);
                  if (end <= s) setEnd(Math.min(day.openUntil, s + SLOT * 2));
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
                disabled={!editable}
                onValueChange={(v) => setEnd(Number(v))}
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
            <Field label="Activity" className="col-span-2">
              <Select
                value={activity}
                disabled={!editable}
                onValueChange={(v) => setActivity(v as ShiftActivity)}
              >
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
            <p className="col-span-2 text-meta text-text-muted">
              {fmtHours((end - start) / 60)} · {minRangeLabel(start, end)}. Times follow open hours,
              in 30-minute steps.
            </p>
          </div>
        ) : (
          <Notice tone="warning">No days are open this week. Set open hours in Setup first.</Notice>
        )}

        {error && <Notice tone="danger">{error}</Notice>}

        {shift && editable && (
          <div className="rounded-app-md border border-border-subtle bg-surface-2 p-3">
            {confirm ? (
              <div className="space-y-2">
                <p className="text-body text-text-primary">
                  {confirm === 'cancel'
                    ? `Cancel ${displayName(shift.userName)}'s shift? It leaves their hours and the calendar.`
                    : `Mark this shift excused? It won't count against ${displayName(shift.userName)}.`}
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="fe-secondary"
                    size="sm"
                    onClick={() => setConfirm(null)}
                    disabled={busy !== null}
                  >
                    Keep shift
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    loading={busy === confirm}
                    onClick={() => void run(confirm)}
                  >
                    {confirm === 'cancel' ? 'Yes, cancel shift' : 'Yes, mark excused'}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <span className="mr-auto text-meta text-text-muted">Other changes</span>
                <Button
                  type="button"
                  variant="fe-secondary"
                  size="sm"
                  onClick={() => setConfirm('excuse')}
                >
                  <UserRoundX /> Mark excused
                </Button>
                <Button
                  type="button"
                  variant="fe-secondary"
                  size="sm"
                  onClick={() => setConfirm('cancel')}
                >
                  <Ban /> Cancel shift
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border-subtle bg-surface-1 px-4 py-3 sm:px-6">
        <Button type="button" variant="fe-ghost" onClick={onClose} disabled={busy !== null}>
          Close
        </Button>
        <Button type="submit" variant="primary" disabled={!canSave} loading={busy === 'save'}>
          {busy !== 'save' && <Check />} {shift ? 'Save changes' : 'Add shift'}
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

/** Plain-language server refusals for the admin shift editor (codes: docs/design/shifts.md §3). */
function describeAdminError(e: unknown): string {
  if (e instanceof ShiftsApiError) {
    switch (e.code) {
      case 'overlap':
        return 'That time overlaps another shift for this intern. Choose a different time.';
      case 'outside_open_hours':
        return 'That time is outside open hours. Choose a time inside the hours shown.';
      case 'bad_time_step':
        return 'Times must start and end on the hour or half hour.';
      case 'bad_block':
        return 'That time isn’t valid. Check the day and times.';
      case 'bad_request':
        if (e.details.reason === 'shift_not_scheduled')
          return 'That shift has already been changed. Close this and refresh.';
        if (e.details.reason === 'not_participating')
          return 'That person isn’t taking part in Shifts. Turn them on in Setup first.';
        return 'That change isn’t valid. Check the details and try again.';
      case 'not_found':
        return 'That shift no longer exists. Close this and refresh.';
      case 'forbidden':
      case 'unauthorized':
        return 'You don’t have permission to change shifts.';
      case 'shifts_disabled':
        return 'Shifts is turned off for this team.';
    }
  }
  return e instanceof Error ? e.message : 'Could not save the change. Try again.';
}

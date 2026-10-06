import { useMemo, useState } from 'react';
import { ArrowRight, Check, Clock, Inbox, X } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/app/EmptyState';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/components/ui/utils';
import { ShiftsApiError, reviewShiftRequest, type ShiftRequest } from '@/lib/api';
import { Pill, RequestStatusPill } from '../shifts/pills';
import {
  ACTIVITY_LABEL,
  REQUEST_TYPE_LABEL,
  fmtDateOnly,
  fmtHours,
  fmtInstant,
  fmtShiftWhen,
  fmtWeekRange,
  displayName,
  firstName,
} from '../shifts/shiftFormat';

interface Props {
  requests: ShiftRequest[];
  timezone: string;
  /** The org's regular weekly minimum, for the under-minimum check. */
  minimumHours: number;
  /** Requests by this user cannot be reviewed by the viewer (a manager's own requests). */
  ownRequestsLocked?: string;
  /** A decision saved; the shell refetches the week. */
  onDecided: () => void;
}

/** Pending requests (any week, oldest first) with approve/deny, then this week's decided ones. */
export function RequestQueue({
  requests,
  timezone,
  minimumHours,
  ownRequestsLocked,
  onDecided,
}: Props) {
  // Requests removed optimistically while their decision is in flight.
  const [hidden, setHidden] = useState<Record<string, ShiftRequest['status']>>({});
  // Cards stay mounted while their decision is in flight (just visually hidden), so a failure can
  // show its error and the server's acknowledgement request on the same card.
  const pending = useMemo(
    () =>
      requests
        .filter((r) => r.status === 'pending')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [requests]
  );
  const visibleCount = pending.filter((r) => !hidden[r.id]).length;
  const decided = useMemo(
    () =>
      [
        ...requests.filter((r) => r.status !== 'pending'),
        ...requests
          .filter((r) => r.status === 'pending' && hidden[r.id])
          .map((r) => ({ ...r, status: hidden[r.id] })),
      ].sort((a, b) => (b.reviewedAt ?? b.createdAt).localeCompare(a.reviewedAt ?? a.createdAt)),
    [requests, hidden]
  );

  const hide = (id: string, status: ShiftRequest['status']) =>
    setHidden((h) => ({ ...h, [id]: status }));
  const restore = (id: string) =>
    setHidden((h) => {
      const { [id]: _removed, ...rest } = h;
      return rest;
    });

  return (
    <div className="space-y-6">
      <section aria-label="Waiting for review" className="space-y-3">
        <h2 className="text-section-title text-text-primary">
          Waiting for review
          {visibleCount > 0 && (
            <span className="ml-2 text-meta font-normal text-text-muted">{visibleCount}</span>
          )}
        </h2>
        {visibleCount === 0 && (
          <EmptyState
            icon={Inbox}
            title="No requests waiting"
            body="When an intern asks to move, drop or add time, it shows up here."
            className="p-8"
          />
        )}
        {pending.length > 0 && (
          <ul className="space-y-3">
            {pending.map((r) => (
              <li key={r.id} hidden={!!hidden[r.id]}>
                <RequestCard
                  request={r}
                  timezone={timezone}
                  minimumHours={minimumHours}
                  locked={ownRequestsLocked === r.userId}
                  onOptimistic={hide}
                  onRestore={restore}
                  onDecided={onDecided}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      {decided.length > 0 && (
        <section aria-label="Decided this week" className="space-y-3">
          <h2 className="text-section-title text-text-primary">Decided this week</h2>
          <ul className="divide-y divide-border-subtle overflow-hidden rounded-app-lg border border-border-subtle bg-surface-1">
            {decided.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                <span className="text-body font-medium text-text-primary" title={r.userName}>
                  {displayName(r.userName)}
                </span>
                <span className="text-body text-text-secondary">{REQUEST_TYPE_LABEL[r.type]}</span>
                <RequestStatusPill status={r.status} />
                <span className="ml-auto text-meta text-text-muted">
                  {r.reviewerName ? `${r.reviewerName} · ` : ''}
                  {fmtInstant(r.reviewedAt ?? r.createdAt, timezone)}
                </span>
                {r.reviewerNote && (
                  <p className="basis-full text-meta text-text-secondary">“{r.reviewerNote}”</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function ChangeSummary({ r, tz }: { r: ShiftRequest; tz: string }) {
  const to =
    r.toStartsAt && r.toEndsAt ? (
      <span className="text-text-primary">
        {fmtShiftWhen(r.toStartsAt, r.toEndsAt, tz)}
        {r.toActivity ? ` · ${ACTIVITY_LABEL[r.toActivity]}` : ''}
      </span>
    ) : null;
  const from = r.fromShift ? (
    <span className="text-text-primary">
      {fmtShiftWhen(r.fromShift.startsAt, r.fromShift.endsAt, tz)}
    </span>
  ) : null;
  switch (r.type) {
    case 'move':
      return (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body text-text-secondary">
          {from} <ArrowRight className="h-3.5 w-3.5 text-text-muted" aria-label="to" /> {to}
        </p>
      );
    case 'drop':
      return (
        <p className="text-body text-text-secondary">Drop {from ?? 'a shift that was removed'}</p>
      );
    case 'add':
      return <p className="text-body text-text-secondary">Add {to}</p>;
    default:
      return (
        <p className="text-body text-text-secondary">
          Work{' '}
          <span className="text-text-primary">
            {r.requestedMinHours !== null ? fmtHours(r.requestedMinHours) : 'fewer hours'}
          </span>{' '}
          the week of {fmtWeekRange(r.weekStart)} instead of the usual minimum
        </p>
      );
  }
}

function RequestCard({
  request: r,
  timezone,
  minimumHours,
  locked,
  onOptimistic,
  onRestore,
  onDecided,
}: {
  request: ShiftRequest;
  timezone: string;
  minimumHours: number;
  locked?: boolean;
  onOptimistic: (id: string, status: ShiftRequest['status']) => void;
  onRestore: (id: string) => void;
  onDecided: () => void;
}) {
  const [open, setOpen] = useState<null | 'approve' | 'deny'>(null);
  const [note, setNote] = useState('');
  const [allowUnder, setAllowUnder] = useState(false);
  // The server can also demand the acknowledgement (409 under_minimum_needs_ack).
  const [serverNeedsAck, setServerNeedsAck] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hoursAfter = serverNeedsAck ?? r.hoursAfter;
  const wouldBeUnder = (r.type === 'move' || r.type === 'drop') && hoursAfter < minimumHours;
  const needsAck = wouldBeUnder || serverNeedsAck !== null;

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    setError(null);
    onOptimistic(r.id, decision === 'approve' ? 'approved' : 'denied');
    try {
      await reviewShiftRequest({
        requestId: r.id,
        decision,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(decision === 'approve' && allowUnder ? { allowUnderMinimum: true } : {}),
      });
      toast.success(decision === 'approve' ? 'Request approved' : 'Request denied');
      onDecided();
    } catch (e) {
      onRestore(r.id);
      if (e instanceof ShiftsApiError && e.code === 'under_minimum_needs_ack') {
        setServerNeedsAck(Number(e.details.hoursAfter ?? r.hoursAfter));
        setOpen('approve');
        setError(null);
      } else if (e instanceof ShiftsApiError && e.code === 'not_pending') {
        setError('This request was already decided or withdrawn. Refreshing the list.');
        onDecided();
      } else if (e instanceof ShiftsApiError && e.code === 'overlap') {
        setError('Approving this overlaps another of their shifts. Edit the schedule first.');
      } else if (
        e instanceof ShiftsApiError &&
        e.code === 'bad_request' &&
        e.details.reason === 'shift_not_scheduled'
      ) {
        setError('Their shift has changed since this request. Deny it, or ask them to resubmit.');
      } else {
        setError(e instanceof Error ? e.message : 'Could not save the decision. Try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  const approveBlocked = open === 'approve' && needsAck && !allowUnder;

  return (
    <article className="rounded-app-lg border border-border-subtle bg-surface-1 p-4">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3
          className="min-w-0 truncate text-body font-semibold text-text-primary"
          title={r.userName}
        >
          {displayName(r.userName)}
        </h3>
        <Pill tone="accent">{REQUEST_TYPE_LABEL[r.type]}</Pill>
        {r.isLate && (
          <Pill tone="warning" icon={<Clock />}>
            Late
          </Pill>
        )}
        <span className="ml-auto text-meta text-text-muted">
          {fmtInstant(r.createdAt, timezone)}
        </span>
      </header>

      <div className="mt-2 space-y-2">
        <ChangeSummary r={r} tz={timezone} />
        <blockquote className="border-l-2 border-border-strong pl-3 text-body text-text-secondary">
          {r.reason}
        </blockquote>
        <p className="text-meta text-text-muted">
          Week of {fmtDateOnly(r.weekStart)}
          {r.type !== 'light_week' && (
            <>
              {' · '}
              <span className="text-metric text-text-secondary">{fmtHours(r.hoursBefore)}</span>
              {' → '}
              <span
                className={cn(
                  'text-metric',
                  wouldBeUnder ? 'font-medium text-warning' : 'text-text-secondary'
                )}
              >
                {fmtHours(hoursAfter)}
              </span>
              {wouldBeUnder && ` (below the ${fmtHours(minimumHours)} minimum)`}
            </>
          )}
        </p>
      </div>

      {locked ? (
        <p className="mt-3 text-meta text-text-muted">
          This is your own request. Another manager or an admin decides it.
        </p>
      ) : open === null ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" size="sm" onClick={() => setOpen('approve')}>
            <Check /> Approve
          </Button>
          <Button variant="fe-secondary" size="sm" onClick={() => setOpen('deny')}>
            <X /> Deny
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-3 rounded-app-md border border-border-subtle bg-surface-2 p-3">
          <label className="block">
            <span className="mb-1 block text-meta font-medium text-text-secondary">
              Note to {firstName(r.userName)} (optional)
            </span>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              maxLength={500}
              placeholder={
                open === 'approve' ? 'Approved, thanks for the heads up.' : 'Tell them why.'
              }
              className="min-h-[64px]"
            />
          </label>
          {open === 'approve' && needsAck && (
            <label className="flex items-start gap-2 text-body text-text-primary">
              <Checkbox
                checked={allowUnder}
                onCheckedChange={(v) => setAllowUnder(v === true)}
                className="mt-0.5"
              />
              <span>
                Allow under {fmtHours(minimumHours)} this week
                <span className="block text-meta text-text-muted">
                  This leaves {firstName(r.userName)} at {fmtHours(hoursAfter)}. Their minimum for
                  the week drops to match.
                </span>
              </span>
            </label>
          )}
          {error && (
            <p role="alert" className="text-body text-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              variant={open === 'approve' ? 'primary' : 'danger'}
              size="sm"
              disabled={busy || approveBlocked}
              loading={busy}
              onClick={() => void decide(open)}
            >
              {open === 'approve' ? 'Confirm approval' : 'Confirm denial'}
            </Button>
            <Button
              variant="fe-ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setOpen(null);
                setError(null);
              }}
            >
              Back
            </Button>
          </div>
        </div>
      )}
      {open === null && error && (
        <p role="alert" className="mt-2 text-body text-danger">
          {error}
        </p>
      )}
    </article>
  );
}

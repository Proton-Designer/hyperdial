import { useState } from 'react';
import { ArrowRight, Inbox, MessageSquareText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { EmptyState } from '@/components/app/EmptyState';
import type { ShiftRequest } from '@/lib/api';
import { Pill, RequestStatusPill } from './pills';
import {
  ACTIVITY_LABEL,
  REQUEST_TYPE_LABEL,
  fmtHours,
  fmtShiftWhen,
  fmtWeekRange,
} from './shiftFormat';

interface RequestsListProps {
  requests: ShiftRequest[];
  timezone: string;
  /** Resolves when the server accepted the withdrawal; rejects (after the parent reverts its
   *  optimistic update and toasts) otherwise. */
  onWithdraw: (request: ShiftRequest) => Promise<void>;
}

export function RequestsList({ requests, timezone, onWithdraw }: RequestsListProps) {
  const [confirming, setConfirming] = useState<ShiftRequest | null>(null);

  if (requests.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No change requests"
        body="After the pick deadline, ask for a move, a drop, extra time or a lighter week from My Shifts."
      />
    );
  }

  return (
    <>
      <ul className="space-y-3">
        {requests.map((r) => (
          <li key={r.id}>
            <RequestCard request={r} tz={timezone} onWithdraw={() => setConfirming(r)} />
          </li>
        ))}
      </ul>
      <AlertDialog open={confirming !== null} onOpenChange={(o) => !o && setConfirming(null)}>
        <AlertDialogContent className="border-border-subtle bg-surface-1 text-text-primary">
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this request?</AlertDialogTitle>
            <AlertDialogDescription className="text-text-secondary">
              Your manager won't see it any more and your schedule stays as it is. You can send a
              new request later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep request</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const r = confirming;
                setConfirming(null);
                if (r) void onWithdraw(r).catch(() => undefined);
              }}
            >
              Withdraw request
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function RequestCard({
  request: r,
  tz,
  onWithdraw,
}: {
  request: ShiftRequest;
  tz: string;
  onWithdraw: () => void;
}) {
  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-body font-medium text-text-primary">
          {REQUEST_TYPE_LABEL[r.type]}
        </span>
        <RequestStatusPill status={r.status} />
        {r.isLate && <Pill tone="warning">Late</Pill>}
        <span className="ml-auto text-meta text-text-muted">
          Sent{' '}
          {new Intl.DateTimeFormat('en-US', {
            timeZone: tz,
            month: 'short',
            day: 'numeric',
          }).format(new Date(r.createdAt))}
        </span>
      </div>

      <div className="mt-2 text-body text-text-secondary">
        <RequestChange request={r} tz={tz} />
      </div>

      <p className="mt-3 flex items-start gap-2 text-body text-text-primary">
        <MessageSquareText className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
        <span className="min-w-0 break-words">{r.reason}</span>
      </p>

      {r.reviewerNote && (
        <div className="mt-3 rounded-app-md border border-border-subtle bg-surface-2 px-3 py-2">
          <div className="text-meta text-text-muted">
            {r.reviewerName ? `Note from ${r.reviewerName}` : 'Reviewer note'}
          </div>
          <p className="text-body text-text-primary">{r.reviewerNote}</p>
        </div>
      )}

      {r.status === 'pending' && (
        <div className="mt-3 flex justify-end">
          <Button variant="fe-ghost" size="sm" onClick={onWithdraw}>
            Withdraw
          </Button>
        </div>
      )}
    </div>
  );
}

function RequestChange({ request: r, tz }: { request: ShiftRequest; tz: string }) {
  if (r.type === 'light_week') {
    return (
      <>
        Week of {fmtWeekRange(r.weekStart)}: minimum of{' '}
        <span className="text-text-primary">{fmtHours(r.requestedMinHours ?? 0)}</span>
      </>
    );
  }
  const from = r.fromShift ? fmtShiftWhen(r.fromShift.startsAt, r.fromShift.endsAt, tz) : null;
  const to =
    r.toStartsAt && r.toEndsAt
      ? `${fmtShiftWhen(r.toStartsAt, r.toEndsAt, tz)}${r.toActivity ? ` (${ACTIVITY_LABEL[r.toActivity]})` : ''}`
      : null;
  if (from && to) {
    return (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        <span>{from}</span>
        <ArrowRight className="h-3.5 w-3.5 text-text-muted" aria-label="to" />
        <span className="text-text-primary">{to}</span>
      </span>
    );
  }
  return <>{from ?? to}</>;
}

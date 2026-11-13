import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Inbox, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  listProApplications,
  reviewProApplication,
  rotateMyProFormLink,
  type ProApplication,
  type ProApplicationsResult,
} from '@/lib/api';
import { isViewOnly } from '@/lib/viewAs';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CopyFormLink } from '@/components/dialer/CopyFormLink';

type Load =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: ProApplicationsResult };

const label = (a: ProApplication) => a.businessName.trim() || a.ownerName.trim() || a.mobile;
const when = (iso: string) => new Date(iso).toLocaleDateString();
const money = (n: number | null) =>
  n === null
    ? '—'
    : n.toLocaleString(undefined, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

function Pill({ tone, children }: { tone: 'warn' | 'info'; children: React.ReactNode }) {
  return (
    <span
      className={`px-1.5 py-0.5 rounded text-xs border ${
        tone === 'warn'
          ? 'bg-warning-soft text-warning border-warning/30'
          : 'bg-surface-2 text-text-secondary border-border-subtle'
      }`}
    >
      {children}
    </span>
  );
}

function Flags({ a }: { a: ProApplication }) {
  if (a.status !== 'pending') return null;
  return (
    <>
      {a.samePending && <Pill tone="warn">Same number pending</Pill>}
      {a.contactDnc && <Pill tone="warn">On Do Not Call</Pill>}
      {a.existingContact && !a.contactDnc && <Pill tone="info">Already a contact</Pill>}
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[130px_1fr] gap-2 text-body">
      <dt className="text-text-secondary">{k}</dt>
      <dd className="text-text-primary break-words min-w-0">{v}</dd>
    </div>
  );
}

function Detail({
  a,
  canReview,
  busy,
  onApprove,
  onReject,
  onClose,
}: {
  a: ProApplication;
  canReview: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onClose: () => void;
}) {
  const dash = (s: string) => s.trim() || '—';
  const pending = a.status === 'pending';
  // A Do Not Call number needs a deliberate second click before it is approved.
  const [dncAsked, setDncAsked] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="border-border-subtle bg-surface-1 text-text-primary max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{label(a)}</DialogTitle>
          <DialogDescription className="text-text-secondary">
            Sent {when(a.createdAt)} · referred by {a.referredByName ?? 'Unknown'}
            {a.status !== 'pending' ? ` · ${a.status}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-1">
          <Flags a={a} />
        </div>
        <dl className="space-y-2">
          <Row k="Owner name" v={dash(a.ownerName)} />
          <Row k="Business name" v={dash(a.businessName)} />
          <Row k="Mobile" v={dash(a.mobile)} />
          <Row k="Email" v={a.email ?? '—'} />
          <Row k="Services" v={a.services.join(', ') || '—'} />
          <Row k="Cities" v={a.cities.join(', ') || '—'} />
          <Row k="Frequencies" v={a.frequencies.join(', ') || '—'} />
          <Row k="Insured" v={a.insured === null ? '—' : a.insured ? 'Yes' : 'No'} />
          <Row k="Best time / way" v={a.bestContact ?? '—'} />
          <Row k="Starting price" v={money(a.startingPrice)} />
          <Row k="New clients" v={a.capacity ?? '—'} />
          <Row k="Years in business" v={a.yearsInBusiness ?? '—'} />
        </dl>
        {pending && a.samePending && (
          <p className="text-meta text-warning">
            Another pending application has this number. Approve one and reject the others.
          </p>
        )}
        {pending && a.contactDnc && (
          <p role={dncAsked ? 'alert' : undefined} className="text-meta text-warning">
            {dncAsked
              ? 'This number is on Do Not Call. Approve anyway?'
              : 'This number is on Do Not Call. Approving adds the close, but the contact stays Do Not Call.'}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button type="button" variant="fe-ghost" onClick={onClose} disabled={busy}>
            Close
          </Button>
          {pending && canReview && !isViewOnly && (
            <>
              <Button type="button" variant="danger-ghost" onClick={onReject} disabled={busy}>
                Reject
              </Button>
              <Button
                type="button"
                variant={a.contactDnc && dncAsked ? 'warning' : 'primary'}
                onClick={() => (a.contactDnc && !dncAsked ? setDncAsked(true) : onApprove())}
                disabled={busy}
              >
                {busy ? 'Working…' : a.contactDnc && dncAsked ? 'Approve anyway' : 'Approve'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function List({ items, onOpen }: { items: ProApplication[]; onOpen: (a: ProApplication) => void }) {
  return (
    <ul className="divide-y divide-border-subtle rounded-app-lg border border-border-subtle bg-surface-1">
      {items.map((a) => (
        <li key={a.id}>
          <button
            type="button"
            onClick={() => onOpen(a)}
            className="w-full text-left p-3 sm:p-4 hover:bg-white/5 focus:outline-none focus:bg-white/5 flex flex-wrap items-start justify-between gap-2"
          >
            <div className="min-w-0">
              <div className="text-text-primary font-medium truncate">{label(a)}</div>
              <div className="text-meta text-text-secondary break-all">
                {[a.ownerName, a.mobile].filter((x) => x && x !== label(a)).join(' · ')}
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                <Flags a={a} />
              </div>
            </div>
            <div className="text-meta text-text-muted text-right shrink-0">
              <div>{when(a.createdAt)}</div>
              <div>{a.referredByName ?? 'Unknown'}</div>
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * TASK-H29: applications sent through a pro form link, above the onboarded pros list. Pending ones are the work; owner/admin
 * approve (the pro then appears below, as if closed by whoever referred them) or reject. A manager sees only their pods'
 * referrals and cannot review. Rejected ones stay collapsed. `onApproved` refreshes the pros list.
 */
export function ProApplications({
  canReview,
  isManager,
  onApproved,
}: {
  canReview: boolean;
  isManager: boolean;
  onApproved: () => void;
}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' });
  const [open, setOpen] = useState<ProApplication | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReject, setConfirmReject] = useState<ProApplication | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [rejected, setRejected] = useState<Load>({ kind: 'loading' });

  const refresh = useCallback(() => {
    listProApplications('pending')
      .then((data) => setLoad({ kind: 'ready', data }))
      .catch((e) =>
        setLoad({
          kind: 'error',
          message: e instanceof Error ? e.message : 'Could not load applications',
        })
      );
  }, []);
  useEffect(refresh, [refresh]);

  const loadRejected = useCallback(() => {
    setRejected({ kind: 'loading' });
    listProApplications('rejected')
      .then((data) => setRejected({ kind: 'ready', data }))
      .catch((e) =>
        setRejected({
          kind: 'error',
          message: e instanceof Error ? e.message : 'Could not load rejected applications',
        })
      );
  }, []);
  useEffect(() => {
    if (showRejected) loadRejected();
  }, [showRejected, loadRejected]);

  const review = async (a: ProApplication, action: 'approve' | 'reject') => {
    setBusy(true);
    try {
      await reviewProApplication(a.id, action);
      toast.success(
        action === 'approve' ? `${label(a)} approved and added to Onboarded pros.` : 'Rejected.'
      );
      setOpen(null);
      refresh();
      if (showRejected) loadRejected();
      if (action === 'approve') onApproved();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not review the application';
      toast.error(msg);
      // Reviewed by someone else meanwhile: close the window and show the current list.
      if (/already reviewed/i.test(msg)) {
        setOpen(null);
        refresh();
      }
    } finally {
      setBusy(false);
    }
  };

  const rotate = async () => {
    setRotating(true);
    try {
      await rotateMyProFormLink();
      toast.success('Your old form link is turned off. Copy link gives you the new one.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create a new link');
    } finally {
      setRotating(false);
    }
  };

  const pendingCount = load.kind === 'ready' ? load.data.pendingCount : 0;

  return (
    <section aria-label="Applications" className="space-y-3 mb-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-section-title text-text-primary flex items-center gap-2">
          Applications
          {pendingCount > 0 && (
            <span
              className="px-2 py-0.5 rounded-full bg-accent-to/20 text-text-primary text-meta tabular-nums"
              aria-label={`${pendingCount} pending`}
            >
              {pendingCount} pending
            </span>
          )}
        </h2>
        {!isViewOnly && (
          <div className="flex flex-wrap items-start gap-2">
            <CopyFormLink label="Copy form link" />
            {canReview && (
              <Button
                type="button"
                variant="fe-ghost"
                size="sm"
                onClick={() => setConfirmRotate(true)}
                disabled={rotating}
              >
                <RefreshCw className="w-4 h-4" />
                New link
              </Button>
            )}
          </div>
        )}
      </div>

      {load.kind === 'loading' && <Skeleton className="h-20" />}
      {load.kind === 'error' && (
        <div
          role="alert"
          className="rounded-app-lg border border-danger/30 bg-danger-soft p-3 flex flex-wrap items-center justify-between gap-2"
        >
          <p className="text-body text-danger">{load.message}</p>
          <Button type="button" variant="fe-secondary" size="sm" onClick={refresh}>
            Try again
          </Button>
        </div>
      )}
      {load.kind === 'ready' && load.data.applications.length === 0 && (
        <div className="rounded-app-lg border border-dashed border-border-subtle p-4 flex items-start gap-3 text-body text-text-secondary">
          <Inbox className="w-5 h-5 shrink-0 mt-0.5" />
          <p>
            {isManager
              ? 'No pending applications from your pods. When a pro fills in a form an agent in your pods sent, it shows up here.'
              : 'No pending applications. Send a pro your form link (Copy form link) and their answers show up here for you to approve.'}
          </p>
        </div>
      )}
      {load.kind === 'ready' && load.data.applications.length > 0 && (
        <List items={load.data.applications} onOpen={setOpen} />
      )}
      {load.kind === 'ready' && load.data.total > load.data.applications.length && (
        <p className="text-meta text-warning">
          Showing the newest {load.data.applications.length} of {load.data.total} pending.
        </p>
      )}

      <div>
        <button
          type="button"
          onClick={() => setShowRejected((v) => !v)}
          aria-expanded={showRejected}
          className="inline-flex items-center gap-1 text-meta text-text-secondary hover:text-text-primary"
        >
          {showRejected ? (
            <ChevronDown className="w-4 h-4" />
          ) : (
            <ChevronRight className="w-4 h-4" />
          )}
          Rejected
          {showRejected && rejected.kind === 'ready' ? ` (${rejected.data.total})` : ''}
        </button>
        {showRejected && (
          <div className="mt-2">
            {rejected.kind === 'loading' && <Skeleton className="h-12" />}
            {rejected.kind === 'error' && (
              <p role="alert" className="text-meta text-danger">
                {rejected.message}
              </p>
            )}
            {rejected.kind === 'ready' && rejected.data.applications.length === 0 && (
              <p className="text-meta text-text-muted">Nothing rejected.</p>
            )}
            {rejected.kind === 'ready' && rejected.data.applications.length > 0 && (
              <List items={rejected.data.applications} onOpen={setOpen} />
            )}
          </div>
        )}
      </div>

      {open && (
        <Detail
          a={open}
          canReview={canReview}
          busy={busy}
          onApprove={() => void review(open, 'approve')}
          onReject={() => setConfirmReject(open)}
          onClose={() => setOpen(null)}
        />
      )}

      <AlertDialog open={confirmReject !== null} onOpenChange={(o) => !o && setConfirmReject(null)}>
        <AlertDialogContent className="border-border-subtle bg-surface-1 text-text-primary">
          <AlertDialogHeader>
            <AlertDialogTitle>Reject this application?</AlertDialogTitle>
            <AlertDialogDescription className="text-text-secondary">
              {confirmReject ? `${label(confirmReject)} will not be added to Onboarded pros. ` : ''}
              No contact or close is created. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const a = confirmReject;
                setConfirmReject(null);
                if (a) void review(a, 'reject');
              }}
            >
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmRotate} onOpenChange={setConfirmRotate}>
        <AlertDialogContent className="border-border-subtle bg-surface-1 text-text-primary">
          <AlertDialogHeader>
            <AlertDialogTitle>Create a new form link?</AlertDialogTitle>
            <AlertDialogDescription className="text-text-secondary">
              Your current link stops working at once: anyone who opens it sees an error. Use this
              if the link got shared where it shouldn't be. Applications already sent are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current link</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmRotate(false);
                void rotate();
              }}
            >
              Turn off and replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

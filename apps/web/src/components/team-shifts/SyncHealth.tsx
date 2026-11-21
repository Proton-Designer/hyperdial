import { useState } from 'react';
import { CheckCircle2, Plug, RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { retryShiftGhl, type AdminShiftsOverview } from '@/lib/api';
import { SetupCard, describeSetupError } from './setupUi';
import { displayName } from '../shifts/shiftFormat';

const KIND_LABEL: Record<string, string> = {
  appointment_upsert: 'Calendar appointment',
  appointment_cancel: 'Cancel appointment',
  appointment_status: 'Appointment status',
  contact_fields: 'Contact fields',
  contact_note: 'Contact note',
  contact_tags_add: 'Add tag',
  contact_tags_remove: 'Remove tag',
};

type RowKind = 'not_connected' | 'token' | 'error';
const classify = (lastError: string | null): RowKind =>
  /no connected GHL integration/i.test(lastError ?? '')
    ? 'not_connected'
    : /token rejected/i.test(lastError ?? '')
      ? 'token'
      : 'error';

/** GHL sync health. Rows waiting because GoHighLevel isn't connected, or its token was rejected,
 *  are one calm callout with a link (nothing is wrong with the rows). Real errors keep the list. */
export function SyncHealth({
  health,
  onRetried,
  onOpenIntegrations,
}: {
  health: AdminShiftsOverview['syncHealth'];
  onRetried: () => void;
  /** Owner/admin only; managers are told to ask. */
  onOpenIntegrations?: () => void;
}) {
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const retry = async (id?: number) => {
    setBusy(id ?? 'all');
    setError(null);
    try {
      const { reset } = await retryShiftGhl(id);
      toast.success(reset === 1 ? 'Queued 1 item to retry' : `Queued ${reset} items to retry`);
      onRetried();
    } catch (e) {
      setError(describeSetupError(e));
    } finally {
      setBusy(null);
    }
  };

  const realRows = health.rows.filter((r) => classify(r.lastError) === 'error');
  const tokenRows = health.rows.filter((r) => classify(r.lastError) === 'token');
  const realCount = realRows.length;
  const notConnected = health.ghlConnected === false;
  const rejected = tokenRows.length > 0;
  // Everything is held while GoHighLevel isn't connected; with a rejected token, the held rows are
  // the pending ones minus the real errors. Ordinary in-flight pending rows of a connected org are
  // normal and are never shown as a problem. Older servers (no pendingCount) fall back to the rows
  // that carry an error.
  const pendingAll = health.pendingCount ?? health.errorCount;
  const waiting = notConnected
    ? pendingAll
    : rejected
      ? Math.max(0, pendingAll - realCount)
      : health.pendingCount === undefined
        ? Math.max(0, health.errorCount - realCount)
        : 0;
  // Older servers cannot say whether GHL is connected; rows with the "not connected" error say it.
  const legacyNotConnected =
    health.ghlConnected === undefined &&
    health.rows.some((r) => classify(r.lastError) === 'not_connected');
  const showHeld = (notConnected || rejected || legacyNotConnected) && waiting > 0;
  const ok = health.errorCount === 0 && !showHeld;
  const hasReal = realCount > 0;
  return (
    <SetupCard
      title="GoHighLevel sync"
      description="Shift changes reach GoHighLevel in the background. Anything that fails shows up here."
      actions={
        hasReal || rejected ? (
          <Button
            variant="fe-secondary"
            size="sm"
            loading={busy === 'all'}
            disabled={busy !== null}
            onClick={() => void retry()}
          >
            {busy !== 'all' && <RefreshCw />} Retry all
          </Button>
        ) : undefined
      }
    >
      {ok ? (
        <p className="flex items-center gap-2 text-body text-text-secondary">
          <CheckCircle2 className="h-4 w-4 text-success" /> Everything is syncing. No errors.
        </p>
      ) : (
        <div className="space-y-3">
          {showHeld && (
            <div
              role="status"
              className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-app-md border border-border-subtle bg-surface-2 px-3 py-3"
            >
              <Plug className="h-4 w-4 shrink-0 text-text-muted" />
              <p className="min-w-0 flex-1 basis-64 text-body text-text-primary">
                {rejected
                  ? 'GoHighLevel rejected the connection. Reconnect it to resume syncing.'
                  : 'GoHighLevel isn’t connected. Connect it in Settings → Integrations to start syncing.'}
                <span className="block text-meta text-text-secondary">
                  {waiting} {waiting === 1 ? 'update is' : 'updates are'} waiting
                  {onOpenIntegrations ? '.' : '. Ask an owner or admin to connect it.'}
                </span>
              </p>
              {onOpenIntegrations && (
                <Button variant="fe-secondary" size="sm" onClick={onOpenIntegrations}>
                  {rejected ? 'Reconnect' : 'Open Integrations'}
                </Button>
              )}
            </div>
          )}
          {hasReal && (
            <p className="flex items-start gap-2 text-body text-text-primary">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
              <span>
                {realCount} {realCount === 1 ? 'item' : 'items'} couldn’t sync.
                <span className="block text-meta text-text-secondary">
                  Last error: {realRows[0].lastError}
                </span>
              </span>
            </p>
          )}
          {hasReal && (
            <ul className="divide-y divide-border-subtle rounded-app-md border border-border-subtle bg-surface-2">
              {realRows.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                  <div className="min-w-0 flex-1 basis-60">
                    <div className="text-body text-text-primary">
                      {KIND_LABEL[r.kind] ?? r.kind}
                      {r.userName ? ` · ${displayName(r.userName)}` : ''}
                      {r.event ? ` · ${r.event}` : ''}
                    </div>
                    <div className="text-meta text-danger">{r.lastError ?? 'Unknown error'}</div>
                    <div className="text-meta text-text-muted">
                      {r.attempts} {r.attempts === 1 ? 'attempt' : 'attempts'}
                    </div>
                  </div>
                  <Button
                    variant="fe-ghost"
                    size="sm"
                    loading={busy === r.id}
                    disabled={busy !== null}
                    onClick={() => void retry(r.id)}
                  >
                    Retry
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 text-body text-danger">
          {error}
        </p>
      )}
    </SetupCard>
  );
}

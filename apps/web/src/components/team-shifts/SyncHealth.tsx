import { useState } from 'react';
import { CheckCircle2, RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { retryShiftGhl, type AdminShiftsOverview } from '@/lib/api';
import { SetupCard, describeSetupError } from './setupUi';

const KIND_LABEL: Record<string, string> = {
  appointment_upsert: 'Calendar appointment',
  appointment_cancel: 'Cancel appointment',
  appointment_status: 'Appointment status',
  contact_fields: 'Contact fields',
  contact_note: 'Contact note',
  contact_tags_add: 'Add tag',
  contact_tags_remove: 'Remove tag',
};

/** GHL sync health: failed outbox rows with the last error, and Retry. */
export function SyncHealth({
  health,
  onRetried,
}: {
  health: AdminShiftsOverview['syncHealth'];
  onRetried: () => void;
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

  const ok = health.errorCount === 0;
  return (
    <SetupCard
      title="GoHighLevel sync"
      description="Shift changes reach GoHighLevel in the background. Anything that fails shows up here."
      actions={
        !ok ? (
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
          <p className="flex items-start gap-2 text-body text-text-primary">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              {health.errorCount} {health.errorCount === 1 ? 'item' : 'items'} couldn’t sync.
              {health.lastError && (
                <span className="block text-meta text-text-secondary">
                  Last error: {health.lastError}
                </span>
              )}
            </span>
          </p>
          <ul className="divide-y divide-border-subtle rounded-app-md border border-border-subtle bg-surface-2">
            {health.rows.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <div className="min-w-0 flex-1 basis-60">
                  <div className="text-body text-text-primary">
                    {KIND_LABEL[r.kind] ?? r.kind}
                    {r.userName ? ` · ${r.userName}` : ''}
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
          {health.rows.length < health.errorCount && (
            <p className="text-meta text-text-muted">
              Showing the latest {health.rows.length}. Retry all queues the rest.
            </p>
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

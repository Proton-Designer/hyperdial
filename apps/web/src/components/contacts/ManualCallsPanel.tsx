import { useEffect, useState } from 'react';
import { PhoneIncoming, PhoneOutgoing } from 'lucide-react';
import { listContactManualCalls, type ManualCallEntry } from '@/lib/api';

function length(s: number | null): string {
  if (s === null) return '—';
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

/** TASK-H27: "Previous calls" on the contact detail (History tab): calls made or taken outside a dial session, newest
 *  first. The server decides whose calls are visible (an agent sees only their own, a manager their pods', owner/admin all),
 *  so this never filters by user itself. */
export function ManualCallsPanel({ contactId }: { contactId: string }) {
  const [entries, setEntries] = useState<ManualCallEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setError(null);
    listContactManualCalls(contactId)
      .then((e) => !cancelled && setEntries(e))
      .catch(
        (e) => !cancelled && setError(e instanceof Error ? e.message : 'Failed to load calls')
      );
    return () => {
      cancelled = true;
    };
  }, [contactId]);

  return (
    <div className="mt-6">
      <h3 className="text-section-title text-text-primary mb-2 flex items-center gap-2">
        <PhoneOutgoing className="w-4 h-4" />
        Previous calls
      </h3>
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      {entries === null && !error && <p className="text-xs text-text-secondary">Loading...</p>}
      {entries !== null && entries.length === 0 && (
        <p className="text-xs text-text-secondary">No manual calls yet.</p>
      )}
      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {entries?.map((c) => {
          const Icon = c.direction === 'inbound' ? PhoneIncoming : PhoneOutgoing;
          return (
            <div key={c.id} className="text-xs border-b border-white/5 pb-2 last:border-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-white font-medium inline-flex items-center gap-1.5">
                  <Icon className="w-3.5 h-3.5 text-text-secondary" aria-hidden="true" />
                  {c.userName ?? 'Unknown'}
                </span>
                <span className="text-text-secondary">
                  {new Date(c.startedAt).toLocaleString()}
                </span>
              </div>
              <div className="text-text-secondary/80 mt-1">
                {c.direction === 'inbound' ? 'Inbound' : 'Outbound'} ·{' '}
                {c.answered ? length(c.durationSeconds) : 'Not answered'}
                {c.dispositionLabel ? ` · ${c.dispositionLabel}` : ''}
              </div>
              {c.notes && (
                <p className="text-text-secondary mt-1 whitespace-pre-wrap break-words">
                  {c.notes}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

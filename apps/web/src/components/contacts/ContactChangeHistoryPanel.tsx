import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { listContactChangeHistory, type ContactChangeHistoryEntry } from '@/lib/api';

const FIELD_LABELS: Record<string, string> = {
  assigned_user_id: 'Assigned agent',
  contact_status: 'Status',
  dnc: 'Do not call',
  phone_number: 'Phone number',
  name: 'Name',
  ghl_tags: 'Tags',
};

function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (field === 'dnc') return value ? 'On' : 'Off';
  if (field === 'name' && value && typeof value === 'object') {
    const v = value as { first_name?: string; last_name?: string; business_name?: string };
    return [v.first_name, v.last_name].filter(Boolean).join(' ') || v.business_name || '—';
  }
  if (Array.isArray(value)) return value.length ? value.join(', ') : '—';
  return String(value);
}

/** MISSION-5 TASK-M5-G5: read-only "History" tab on the contact detail (ContactDetailModal.tsx).
 *  One row per contact_change_history entry -- see that migration's own header for why each row
 *  already batches every tracked field a single edit/import changed, so this never renders more
 *  than one row per real edit. */
export function ContactChangeHistoryPanel({ contactId }: { contactId: string }) {
  const [entries, setEntries] = useState<ContactChangeHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listContactChangeHistory(contactId)
      .then(setEntries)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load history'));
  }, [contactId]);

  return (
    <div>
      <h3 className="text-section-title text-text-primary mb-2 flex items-center gap-2">
        <History className="w-4 h-4" />
        History
      </h3>
      {error && <p className="text-xs text-danger mb-2">{error}</p>}
      {entries === null && <p className="text-xs text-text-secondary">Loading...</p>}
      {entries !== null && entries.length === 0 && (
        <p className="text-xs text-text-secondary">No changes recorded yet.</p>
      )}
      <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
        {entries?.map((e) => (
          <div key={e.id} className="text-xs border-b border-white/5 pb-2 last:border-0">
            <div className="flex items-center justify-between gap-2">
              <span className="text-white font-medium">
                {e.source === 'import' ? 'Imported' : (e.changedByName ?? 'Unknown')}
                {e.changedByRemoved && ' (removed)'}
              </span>
              <span className="text-text-secondary">{new Date(e.createdAt).toLocaleString()}</span>
            </div>
            <ul className="text-text-secondary/80 mt-1 space-y-0.5">
              {Object.entries(e.changes).map(([field, diff]) => (
                <li key={field}>
                  {FIELD_LABELS[field] ?? field}: {formatValue(field, diff.old)} {'→'}{' '}
                  {formatValue(field, diff.new)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

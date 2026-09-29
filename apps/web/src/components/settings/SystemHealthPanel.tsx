import { useEffect, useState } from 'react';
import { useOrg } from '@/contexts/OrgContext';
import {
  listTriggerFailures,
  acknowledgeTriggerFailure,
  type TriggerFailure,
  type TriggerFailureSource,
} from '@/lib/api';

const SOURCE_LABELS: Record<TriggerFailureSource, string> = {
  disposition_quality_checks: 'Disposition quality checks',
  round_robin_distribution: 'Round-robin lead distribution',
  shared_inbox: 'Shared inbox',
};

/**
 * MISSION-5 TASK-M5-O1 Part B (R3's own next-5 #1, audit/M5/edge-cases-v2.md): three "never
 * block the write" trigger guards (disposition quality checks, round-robin distribution, the
 * shared inbox) used to swallow a real failure as a bare Postgres WARNING nobody could ever see.
 * This panel is that visibility -- owner/admin only, same gate + self-contained/renders-nothing
 * shape as NumberHealthPanel. Mounted in Settings.tsx's Activity tab (background-job reliability
 * is closer to "what happened in this org" than to any one feature's own settings surface).
 */
export function SystemHealthPanel() {
  const { role } = useOrg();
  const isAdmin = role === 'owner' || role === 'admin';
  const [failures, setFailures] = useState<TriggerFailure[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  const load = () => {
    setLoading(true);
    listTriggerFailures(7)
      .then((rows) => {
        setFailures(rows);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (isAdmin) load();
  }, [isAdmin]);

  if (!isAdmin) return null;

  const unacknowledged = failures.filter((f) => !f.acknowledgedAt);

  const handleAcknowledge = async (id: string) => {
    setAckBusy(id);
    try {
      await acknowledgeTriggerFailure(id);
      setFailures((rows) =>
        rows.map((r) => (r.id === id ? { ...r, acknowledgedAt: new Date().toISOString() } : r))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAckBusy(null);
    }
  };

  return (
    <div className="bg-surface-1 rounded-app-lg p-6 border border-border-subtle max-w-4xl mb-6">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-section-title text-text-primary">System health</h3>
        {failures.length > 0 && (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="text-sm px-3 py-1.5 rounded-app-md border border-border-subtle text-text-primary hover:bg-surface-2"
          >
            {expanded ? 'Hide' : 'Show'} details
          </button>
        )}
      </div>
      <p className="text-sm text-text-secondary mb-3">
        A handful of automated background steps (quality checks, round-robin lead distribution, the
        shared inbox) are designed to never block the real write they're attached to -- if one of
        them fails, the disposition/lead/missed-call still saves, but the background step itself
        silently skipped. Failures in the last 7 days show up here.
      </p>

      {loading ? (
        <p className="text-sm text-text-secondary">Loading…</p>
      ) : error ? (
        <div className="p-3 rounded-app-md bg-danger/10 border border-danger/30 text-danger text-sm">
          {error}
        </div>
      ) : failures.length === 0 ? (
        <p className="text-sm text-text-secondary">No background failures in the last 7 days.</p>
      ) : (
        <>
          <p className="text-sm text-text-primary mb-3">
            {unacknowledged.length} unacknowledged of {failures.length} background failure
            {failures.length === 1 ? '' : 's'} in the last 7 days.
          </p>
          {expanded && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-text-secondary border-b border-border-subtle">
                    <th className="py-2 pr-4">When</th>
                    <th className="py-2 pr-4">Source</th>
                    <th className="py-2 pr-4">Error</th>
                    <th className="py-2 pr-4"></th>
                  </tr>
                </thead>
                <tbody>
                  {failures.map((f) => (
                    <tr key={f.id} className="border-b border-border-subtle last:border-0">
                      <td className="py-2 pr-4 text-text-secondary whitespace-nowrap">
                        {new Date(f.createdAt).toLocaleString()}
                      </td>
                      <td className="py-2 pr-4 text-text-primary">{SOURCE_LABELS[f.source]}</td>
                      <td
                        className="py-2 pr-4 text-text-secondary font-mono text-xs max-w-xs truncate"
                        title={f.error}
                      >
                        {f.error}
                      </td>
                      <td className="py-2 pr-4">
                        {f.acknowledgedAt ? (
                          <span className="text-text-secondary">Acknowledged</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleAcknowledge(f.id)}
                            disabled={ackBusy === f.id}
                            className="text-sm px-2 py-1 rounded-app-sm border border-border-subtle text-text-primary hover:bg-surface-2 disabled:opacity-50"
                          >
                            {ackBusy === f.id ? 'Saving…' : 'Acknowledge'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

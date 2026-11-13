import { useEffect, useState } from 'react';
import { Check, X, UserPlus } from 'lucide-react';
import { getAgentOnboardingChecklist, type AgentOnboardingChecklistRow } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/app/EmptyState';

const CHECKLIST_COLUMNS: { key: keyof AgentOnboardingChecklistRow; label: string }[] = [
  { key: 'preflightPassed', label: 'Pre-flight' },
  { key: 'numberAssigned', label: 'Number assigned' },
  { key: 'campaignAssigned', label: 'Campaign assigned' },
  { key: 'firstCallMade', label: 'First call made' },
];

function CheckCell({ ok }: { ok: boolean }) {
  return ok ? (
    <Check className="w-4 h-4 text-success mx-auto" />
  ) : (
    <X className="w-4 h-4 text-text-muted mx-auto" />
  );
}

/**
 * Deferred backlog item TM-B2: onboarding checklist per agent, owner/admin/manager. Self-
 * contained (fetches its own data, no props), same pattern as TeamGoalsAndBroadcastPanel --
 * server enforces scope (owner/admin all, manager their own pods), this is a plain read/render.
 * Every column is DERIVED from existing data (see the RPC's own migration header for exactly
 * what each one reads) -- there is no separate onboarding-tracking table to fall out of sync.
 */
export function OnboardingChecklistPanel() {
  const [rows, setRows] = useState<AgentOnboardingChecklistRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAgentOnboardingChecklist()
      .then(setRows)
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load'));
  }, []);

  if (error) return <p className="text-meta text-danger mb-8">{error}</p>;

  if (!rows) return <Skeleton className="h-32 rounded-app-lg mb-8" />;

  if (rows.length === 0) {
    return (
      <EmptyState
        icon={UserPlus}
        title="No agents to onboard"
        body="New agents will show up here with their onboarding checklist."
        className="mb-8"
      />
    );
  }

  return (
    <div className="mb-8">
      <h2 className="text-section-title text-text-primary mb-4">Onboarding checklist</h2>
      <div className="hd-scroll-x rounded-app-lg border border-border-subtle">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-text-secondary">
              <th className="p-3 font-medium">Agent</th>
              {CHECKLIST_COLUMNS.map((col) => (
                <th key={col.key} className="p-3 font-medium text-center">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.agentId} className="border-b border-border-subtle last:border-0">
                <td className="p-3 text-white font-medium">{row.agentName}</td>
                {CHECKLIST_COLUMNS.map((col) => (
                  <td key={col.key} className="p-3">
                    <CheckCell ok={row[col.key] as boolean} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

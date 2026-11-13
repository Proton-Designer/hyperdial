import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type OrgMember, type AssignLeadsFilter, countLeadsAssignedToOthers } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/useFocusTrap';

interface AssignLeadsModalProps {
  campaignId: string;
  members: OrgMember[];
  onClose: () => void;
  onAssign: (agentId: string | null, filter: AssignLeadsFilter) => Promise<void>;
}

function memberName(m: OrgMember): string {
  return [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.email || m.user_id;
}

/** TASK-T6 (ADM-4): assigns (or, with "Unassign", clears) a slice of this campaign's currently
 *  QUEUED leads to one intern -- a whole campaign (one or more interns) is already handled by
 *  the "Assigned Agents" checkbox list above; this is the per-lead/slice half. Re-running with a
 *  different agent/filter reassigns/repartitions -- each call is independent, so "one or more
 *  interns" for a slice means running this once per intern with a non-overlapping filter. */
export function AssignLeadsModal({
  campaignId,
  members,
  onClose,
  onAssign,
}: AssignLeadsModalProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);
  // TASK-Q3F: useFocusTrap deliberately doesn't add an Escape handler (see its own doc comment),
  // and this modal never had one -- same pattern as PurchaseNumbersModal.tsx.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const [agentId, setAgentId] = useState('');
  const [mode, setMode] = useState<AssignLeadsFilter['mode']>('all');
  const [rangeStart, setRangeStart] = useState('1');
  const [rangeEnd, setRangeEnd] = useState('10');
  const [percentage, setPercentage] = useState('25');
  const [tag, setTag] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [unassigning, setUnassigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingReassign, setCheckingReassign] = useState(false);
  /** EC-5: once set, "Assign" shows a confirm step instead of submitting immediately. Cleared by
   *  every input change below so a stale count is never confirmed against a different selection. */
  const [reassignWarningCount, setReassignWarningCount] = useState<number | null>(null);

  const clearReassignWarning = () => setReassignWarningCount(null);

  const buildFilter = (): AssignLeadsFilter | null => {
    if (mode === 'all') return { mode: 'all' };
    if (mode === 'range') {
      const start = parseInt(rangeStart, 10);
      const end = parseInt(rangeEnd, 10);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
        setError('Enter a valid range (start ≤ end, both ≥ 1).');
        return null;
      }
      return { mode: 'range', start, end };
    }
    if (mode === 'percentage') {
      const pct = parseInt(percentage, 10);
      if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
        setError('Enter a percentage between 1 and 100.');
        return null;
      }
      return { mode: 'percentage', percentage: pct };
    }
    if (!tag.trim()) {
      setError('Enter a GHL tag to filter by.');
      return null;
    }
    return { mode: 'tag', tag: tag.trim() };
  };

  const doSubmit = async (unassign: boolean, filter: AssignLeadsFilter) => {
    setSubmitting(true);
    setUnassigning(unassign);
    try {
      await onAssign(unassign ? null : agentId, filter);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to assign leads');
    } finally {
      setSubmitting(false);
      setUnassigning(false);
    }
  };

  const handleUnassign = () => {
    setError(null);
    const filter = buildFilter();
    if (!filter) return;
    void doSubmit(true, filter);
  };

  /** EC-5 (edge-cases-v2.md): `assign_campaign_leads` treats an already-assigned queued lead in
   *  scope as a valid candidate just like an unassigned one -- silently re-owning it. First click
   *  previews the impact and, if it would reassign anyone else's leads, stops and shows the
   *  count instead of submitting; the confirm click (reassignWarningCount already set) submits. */
  const handleAssignClick = async () => {
    setError(null);
    if (!agentId) {
      setError('Pick a teammate to assign to.');
      return;
    }
    const filter = buildFilter();
    if (!filter) return;

    if (reassignWarningCount !== null) {
      void doSubmit(false, filter);
      return;
    }

    setCheckingReassign(true);
    try {
      const count = await countLeadsAssignedToOthers(campaignId, filter, agentId);
      if (count > 0) {
        setReassignWarningCount(count);
        return;
      }
    } catch {
      // Best-effort preview only -- never block the real assign on a failed count query.
    } finally {
      setCheckingReassign(false);
    }
    void doSubmit(false, filter);
  };

  return createPortal(
    <div
      ref={modalRef}
      className="hd-touch fixed inset-0 flex items-center justify-center p-4 outline-none"
      style={{ zIndex: 10002 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="assign-leads-title"
      tabIndex={-1}
    >
      <div className="absolute inset-0 bg-black/70" aria-hidden="true" onClick={onClose} />
      <div className="relative z-[1] w-full max-w-sm max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-app-lg border border-border-subtle bg-surface-1 shadow-app-md">
        <div className="border-b border-border-subtle p-4">
          <h2 id="assign-leads-title" className="text-page-title text-text-primary">
            Assign leads
          </h2>
        </div>
        <div className="p-4 space-y-4">
          {error && (
            <div className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3">
              {error}
            </div>
          )}
          <div>
            <p className="text-meta text-text-secondary mb-1.5">Assign to</p>
            <select
              value={agentId}
              onChange={(e) => {
                setAgentId(e.target.value);
                clearReassignWarning();
              }}
              className="w-full rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary focus:outline-none focus:border-accent-to"
            >
              <option value="">Choose a teammate…</option>
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {memberName(m)}
                </option>
              ))}
            </select>
            <p className="text-meta text-text-secondary mt-1">
              A teammate not yet on this campaign is added automatically.
            </p>
          </div>
          <div>
            <p className="text-meta text-text-secondary mb-1.5">Which leads</p>
            <div className="flex gap-2 mb-2 flex-wrap">
              {(['all', 'range', 'percentage', 'tag'] as const).map((m) => (
                <Button
                  key={m}
                  type="button"
                  size="sm"
                  variant={mode === m ? 'fe-secondary' : 'fe-ghost'}
                  onClick={() => {
                    setMode(m);
                    clearReassignWarning();
                  }}
                >
                  {m === 'all'
                    ? 'All queued'
                    : m === 'range'
                      ? 'Range'
                      : m === 'percentage'
                        ? 'Percentage'
                        : 'GHL tag'}
                </Button>
              ))}
            </div>
            {mode === 'range' && (
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  value={rangeStart}
                  onChange={(e) => {
                    setRangeStart(e.target.value);
                    clearReassignWarning();
                  }}
                  className="w-20 rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary focus:outline-none focus:border-accent-to"
                  aria-label="Range start"
                />
                <span className="text-text-secondary">to</span>
                <input
                  type="number"
                  min={1}
                  value={rangeEnd}
                  onChange={(e) => {
                    setRangeEnd(e.target.value);
                    clearReassignWarning();
                  }}
                  className="w-20 rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary focus:outline-none focus:border-accent-to"
                  aria-label="Range end"
                />
                <span className="text-meta text-text-secondary">by queue position</span>
              </div>
            )}
            {mode === 'percentage' && (
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={percentage}
                  onChange={(e) => {
                    setPercentage(e.target.value);
                    clearReassignWarning();
                  }}
                  className="w-20 rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary focus:outline-none focus:border-accent-to"
                  aria-label="Percentage"
                />
                <span className="text-text-secondary">% of queued leads</span>
              </div>
            )}
            {mode === 'tag' && (
              <input
                type="text"
                placeholder="e.g. hot"
                value={tag}
                onChange={(e) => {
                  setTag(e.target.value);
                  clearReassignWarning();
                }}
                className="w-full rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
              />
            )}
          </div>
          {reassignWarningCount !== null && reassignWarningCount > 0 && (
            <div className="rounded-app-md bg-warning-soft border border-warning/30 text-warning text-body p-3">
              {reassignWarningCount} of these leads {reassignWarningCount === 1 ? 'is' : 'are'}{' '}
              currently assigned to other agents and will be reassigned.
            </div>
          )}
        </div>
        <div className="border-t border-border-subtle p-4 flex flex-wrap justify-between gap-2">
          <Button type="button" variant="fe-ghost" onClick={handleUnassign} disabled={submitting}>
            {unassigning ? 'Unassigning…' : 'Unassign this slice'}
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="fe-ghost" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() => void handleAssignClick()}
              disabled={submitting || checkingReassign}
            >
              {checkingReassign
                ? 'Checking…'
                : submitting && !unassigning
                  ? 'Assigning…'
                  : reassignWarningCount !== null
                    ? `Yes, reassign ${reassignWarningCount} lead${reassignWarningCount === 1 ? '' : 's'}`
                    : 'Assign'}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

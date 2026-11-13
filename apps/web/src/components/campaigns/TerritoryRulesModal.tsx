import { useEffect, useRef, useState } from 'react';
import '@/styles/touch.css';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import {
  type OrgMember,
  type OrgPod,
  type TerritoryRule,
  type TerritoryRuleInput,
  type TerritoryPreviewRow,
  listOrgPods,
  listTerritoryRules,
  createTerritoryRule,
  updateTerritoryRule,
  deleteTerritoryRule,
  reorderTerritoryRules,
  previewTerritoryRules,
  applyTerritoryRules,
  countTerritoryReassignImpact,
} from '@/lib/api';
import { useOrg } from '@/contexts/OrgContext';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { ArrowUp, ArrowDown, Trash2, Pencil } from 'lucide-react';

interface TerritoryRulesModalProps {
  campaignId: string;
  members: OrgMember[];
  distributionMode: 'manual' | 'round_robin';
  onClose: () => void;
}

function memberName(m: OrgMember): string {
  return [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.email || m.user_id;
}

/** MISSION-5 TASK-M5-C4 (deferred backlog item): per-org territory rules (state/area code ->
 *  agent or pod, first match wins) + a per-campaign "Apply territory rules" action. Owner/admin
 *  manage every rule; a manager may only create/edit/delete rules whose target is inside their
 *  own pod scope (server-enforced -- this UI doesn't try to pre-filter, it just surfaces whatever
 *  error the RPC raises). Applying is preview-then-commit through the SAME `assign_campaign_leads`
 *  path a manual assignment uses (`_shared`/api.ts's own comment on `applyTerritoryRules`), so
 *  nothing here bypasses B3's own guards. */
export function TerritoryRulesModal({
  campaignId,
  members,
  distributionMode,
  onClose,
}: TerritoryRulesModalProps) {
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
  const { role } = useOrg();
  const isOwnerAdmin = role === 'owner' || role === 'admin';

  const [rules, setRules] = useState<TerritoryRule[]>([]);
  const [pods, setPods] = useState<OrgPod[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [matchState, setMatchState] = useState('');
  const [matchAreaCode, setMatchAreaCode] = useState('');
  const [targetType, setTargetType] = useState<'agent' | 'pod'>('agent');
  const [targetId, setTargetId] = useState('');
  const [saving, setSaving] = useState(false);

  const [reassign, setReassign] = useState(false);
  const [preview, setPreview] = useState<TerritoryPreviewRow[] | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [reassignImpact, setReassignImpact] = useState<number | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([listTerritoryRules(), listOrgPods()])
      .then(([r, p]) => {
        setRules(r);
        setPods(p);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Failed to load territory rules'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  /** TASK-M5-T3: fetch the exact reassign-impact count whenever the checkbox is on, for any
   *  distribution mode. Fails open (D2/EC-5 convention) -- a failed call just leaves the count
   *  unshown, never blocks applying. Cleared immediately when unchecked so a stale count never
   *  lingers under the checkbox. */
  useEffect(() => {
    if (!reassign) {
      setReassignImpact(null);
      return;
    }
    let cancelled = false;
    countTerritoryReassignImpact(campaignId, true)
      .then((n) => {
        if (!cancelled) setReassignImpact(n);
      })
      .catch(() => {
        if (!cancelled) setReassignImpact(null);
      });
    return () => {
      cancelled = true;
    };
  }, [reassign, campaignId]);

  const targetName = (rule: TerritoryRule): string => {
    if (rule.target_type === 'agent') {
      const m = members.find((mm) => mm.user_id === rule.target_agent_id);
      return m ? memberName(m) : 'Unknown teammate';
    }
    const p = pods.find((pp) => pp.id === rule.target_pod_id);
    return p ? `Pod: ${p.name}` : 'Unknown pod';
  };

  const matchLabel = (rule: TerritoryRule): string => {
    const parts: string[] = [];
    if (rule.match_state) parts.push(`state ${rule.match_state}`);
    if (rule.match_area_code) parts.push(`area code ${rule.match_area_code}`);
    return parts.join(' or ');
  };

  const resetForm = () => {
    setEditingId(null);
    setMatchState('');
    setMatchAreaCode('');
    setTargetType('agent');
    setTargetId('');
  };

  const handleEditStart = (rule: TerritoryRule) => {
    setError(null);
    setEditingId(rule.id);
    setMatchState(rule.match_state ?? '');
    setMatchAreaCode(rule.match_area_code ?? '');
    setTargetType(rule.target_type);
    setTargetId(
      rule.target_type === 'agent' ? (rule.target_agent_id ?? '') : (rule.target_pod_id ?? '')
    );
  };

  const handleSave = async () => {
    setError(null);
    const state = matchState.trim().toUpperCase() || null;
    const areaCode = matchAreaCode.trim() || null;
    if (!state && !areaCode) {
      setError('Enter a state and/or an area code to match on.');
      return;
    }
    if (state && !/^[A-Z]{2}$/.test(state)) {
      setError('State must be a 2-letter code (e.g. TX).');
      return;
    }
    if (areaCode && !/^[0-9]{3}$/.test(areaCode)) {
      setError('Area code must be 3 digits.');
      return;
    }
    if (!targetId) {
      setError(targetType === 'agent' ? 'Pick a teammate.' : 'Pick a pod.');
      return;
    }
    const input: TerritoryRuleInput = {
      matchState: state,
      matchAreaCode: areaCode,
      targetType,
      targetAgentId: targetType === 'agent' ? targetId : null,
      targetPodId: targetType === 'pod' ? targetId : null,
    };
    setSaving(true);
    try {
      if (editingId) {
        await updateTerritoryRule(editingId, input);
        toast.success('Territory rule updated');
      } else {
        await createTerritoryRule(input);
        toast.success('Territory rule added');
      }
      resetForm();
      load();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : editingId
            ? 'Failed to update rule'
            : 'Failed to create rule'
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (rule: TerritoryRule) => {
    try {
      await deleteTerritoryRule(rule.id);
      toast.success('Territory rule removed');
      if (editingId === rule.id) resetForm();
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete rule');
    }
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const next = [...rules];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    try {
      await reorderTerritoryRules(next.map((r) => r.id));
      setRules(next);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to reorder rules');
    }
  };

  const handlePreview = async () => {
    setError(null);
    setPreviewing(true);
    try {
      const rows = await previewTerritoryRules(campaignId, reassign);
      setPreview(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to preview territory rules');
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    setApplying(true);
    try {
      const result = await applyTerritoryRules(campaignId, reassign);
      toast.success(`Assigned ${result.assigned} lead(s); ${result.unmatched} left unmatched`);
      setPreview(null);
      load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to apply territory rules');
    } finally {
      setApplying(false);
    }
  };

  return createPortal(
    <div
      ref={modalRef}
      className="hd-touch fixed inset-0 flex items-center justify-center p-4 max-md:p-0 outline-none"
      style={{ zIndex: 10002 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="territory-rules-title"
      tabIndex={-1}
    >
      <div className="absolute inset-0 bg-black/70" aria-hidden="true" onClick={onClose} />
      <div className="relative z-[1] w-full max-w-lg max-h-[85vh] max-md:h-[100dvh] max-md:max-h-none max-md:max-w-none max-md:rounded-none max-md:border-0 overflow-y-auto rounded-app-lg border border-border-subtle bg-surface-1 shadow-app-md">
        <div className="border-b border-border-subtle p-4 max-md:pt-[max(1rem,env(safe-area-inset-top))]">
          <h2 id="territory-rules-title" className="text-page-title text-text-primary">
            Territory rules
          </h2>
          <p className="text-meta text-text-secondary mt-1">
            Route leads by contact state or phone area code to an agent or pod. First matching rule
            wins; anything unmatched is left for the normal distribution.
          </p>
        </div>
        <div className="p-4 space-y-4">
          {error && (
            <div className="rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body p-3">
              {error}
            </div>
          )}

          <div>
            <p className="text-meta text-text-secondary mb-1.5">Rules (checked in order)</p>
            {loading ? (
              <p className="text-meta text-text-secondary">Loading…</p>
            ) : rules.length === 0 ? (
              <p className="text-meta text-text-secondary">No territory rules yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {rules.map((rule, i) => (
                  <li
                    key={rule.id}
                    className="flex items-center gap-2 rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2"
                  >
                    <span className="text-meta text-text-secondary w-5 shrink-0">{i + 1}.</span>
                    <span className="text-body text-text-primary flex-1">
                      {matchLabel(rule)} → {targetName(rule)}
                    </span>
                    {isOwnerAdmin && (
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          type="button"
                          size="sm"
                          variant="fe-ghost"
                          aria-label="Move up"
                          disabled={i === 0}
                          onClick={() => void handleMove(i, -1)}
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="fe-ghost"
                          aria-label="Move down"
                          disabled={i === rules.length - 1}
                          onClick={() => void handleMove(i, 1)}
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      variant="fe-ghost"
                      aria-label="Edit rule"
                      onClick={() => handleEditStart(rule)}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="fe-ghost"
                      aria-label="Delete rule"
                      onClick={() => void handleDelete(rule)}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-danger" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="border-t border-border-subtle pt-4 space-y-2">
            <p className="text-meta text-text-secondary">
              {editingId ? 'Edit rule' : 'Add a rule'}
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="State (e.g. TX)"
                value={matchState}
                maxLength={2}
                onChange={(e) => setMatchState(e.target.value)}
                className="w-28 rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
              />
              <span className="text-meta text-text-secondary">and/or</span>
              <input
                type="text"
                placeholder="Area code"
                value={matchAreaCode}
                maxLength={3}
                onChange={(e) => setMatchAreaCode(e.target.value)}
                className="w-28 rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-to"
              />
            </div>
            <div className="flex items-center gap-2">
              <select
                value={targetType}
                onChange={(e) => {
                  setTargetType(e.target.value as 'agent' | 'pod');
                  setTargetId('');
                }}
                className="rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary focus:outline-none focus:border-accent-to"
              >
                <option value="agent">Agent</option>
                <option value="pod">Pod</option>
              </select>
              <select
                value={targetId}
                onChange={(e) => setTargetId(e.target.value)}
                className="flex-1 rounded-app-md bg-surface-2 border border-border-subtle px-3 py-2 text-text-primary focus:outline-none focus:border-accent-to"
              >
                <option value="">Choose {targetType === 'agent' ? 'a teammate' : 'a pod'}…</option>
                {targetType === 'agent'
                  ? members.map((m) => (
                      <option key={m.user_id} value={m.user_id}>
                        {memberName(m)}
                      </option>
                    ))
                  : pods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
              </select>
              <Button
                type="button"
                variant="primary"
                onClick={() => void handleSave()}
                disabled={saving}
              >
                {saving ? 'Saving…' : editingId ? 'Save' : 'Add'}
              </Button>
              {editingId && (
                <Button type="button" variant="fe-ghost" onClick={resetForm} disabled={saving}>
                  Cancel
                </Button>
              )}
            </div>
          </div>

          <div className="border-t border-border-subtle pt-4 space-y-2">
            <p className="text-meta text-text-secondary">Apply to this campaign</p>
            {isOwnerAdmin && (
              <label className="flex items-center gap-2 text-body text-text-primary">
                <input
                  type="checkbox"
                  checked={reassign}
                  onChange={(e) => {
                    setReassign(e.target.checked);
                    setPreview(null);
                  }}
                />
                Also reassign leads that already have an agent
              </label>
            )}
            {/* TASK-M5-T3 review NIT (eng2): the exact count (count_territory_reassign_impact)
             *  and T2's plain round-robin mode warning used to render as two separate lines that
             *  said overlapping things. Merged into one -- when the exact count is known, it's
             *  the single source of truth (round-robin gets a trailing clause, not a whole extra
             *  paragraph); the old mode-level-only wording is now just the FAILS-OPEN fallback
             *  for when the count call hasn't resolved yet or errored (reassignImpact stays
             *  null), same fails-open convention as EC-5/D2. */}
            {reassign &&
              (reassignImpact !== null
                ? reassignImpact > 0 && (
                    <div className="rounded-app-md bg-warning-soft border border-warning/30 text-warning text-body p-3">
                      {reassignImpact} lead{reassignImpact === 1 ? '' : 's'} currently assigned to
                      other agents will move
                      {distributionMode === 'round_robin'
                        ? ', including leads round-robin distributed.'
                        : '.'}
                    </div>
                  )
                : distributionMode === 'round_robin' && (
                    <div className="rounded-app-md bg-warning-soft border border-warning/30 text-warning text-body p-3">
                      This campaign uses round-robin distribution. Reassigning will also move leads
                      that were already fairly distributed by round-robin.
                    </div>
                  ))}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="fe-secondary"
                onClick={() => void handlePreview()}
                disabled={previewing}
              >
                {previewing ? 'Previewing…' : 'Preview'}
              </Button>
              {preview && (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void handleApply()}
                  disabled={applying}
                >
                  {applying ? 'Applying…' : 'Apply'}
                </Button>
              )}
            </div>
            {preview && (
              <ul className="text-body text-text-secondary space-y-0.5">
                {preview.map((row) => (
                  <li key={row.target_id ?? 'unmatched'}>
                    {row.lead_count} lead(s) → {row.target_name}
                  </li>
                ))}
                {preview.length === 0 && <li>No queued leads to route.</li>}
              </ul>
            )}
          </div>
        </div>
        <div className="border-t border-border-subtle p-4 flex justify-end">
          <Button type="button" variant="fe-ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

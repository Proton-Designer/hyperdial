import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
import {
  listOrgPods,
  listOrgMembers,
  setOrgGoal,
  createBroadcast,
  listOrgGoals,
  deleteOrgGoal,
  getActiveBroadcasts,
  deleteBroadcast,
  type OrgPod,
  type OrgMember,
  type GoalScope,
  type GoalMetric,
  type OrgGoal,
  type OrgBroadcast,
} from '@/lib/api';

const METRIC_OPTIONS: { value: GoalMetric; label: string }[] = [
  { value: 'dials', label: 'Dials' },
  { value: 'conversations', label: 'Conversations' },
  { value: 'wins', label: 'Wins' },
  { value: 'talk_minutes', label: 'Talk minutes' },
];

/** MISSION-5 TASK-M5-A6: owner/admin/manager set a daily goal and post a broadcast. Both forms
 *  offer every pod/agent in the org (this component doesn't try to pre-filter a manager's own
 *  supervised pods client-side) -- the RPC itself rejects an out-of-scope pod/agent with a clear
 *  message, same "server enforces, UI just tries" trust model the rest of this app already uses
 *  for pod scoping (assign_campaign_leads has no client-side pod filter either). Self-contained:
 *  fetches its own pods/members, no props, so Team.tsx's own diff to add this is one import + one
 *  line. */
export function TeamGoalsAndBroadcastPanel() {
  const { user } = useAuth();
  const { role } = useOrg();
  // eng2 review of 74e26af (audit/M5-followups/review-eng2.md, SHOULD): a manager could see live
  // Edit/Delete on rows the RPCs will reject (a scope='org' goal is owner/admin-only regardless
  // of who set it; a pod_id-null broadcast someone else posted is poster-or-owner/admin-only) --
  // not a security bug (the RPC is the real gate), but a routine, confusing failed round-trip on
  // rows a manager can plainly see. Hide/disable exactly where the server would reject.
  const canManageGoal = (g: OrgGoal): boolean =>
    role === 'owner' || role === 'admin' || g.scope !== 'org';
  const canManageBroadcast = (b: OrgBroadcast): boolean =>
    role === 'owner' || role === 'admin' || b.pod_id !== null || b.created_by === user?.id;

  const [pods, setPods] = useState<OrgPod[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [goals, setGoals] = useState<OrgGoal[]>([]);
  const [broadcasts, setBroadcasts] = useState<OrgBroadcast[]>([]);

  const loadGoals = () =>
    listOrgGoals()
      .then(setGoals)
      .catch(() => {});
  const loadBroadcasts = () =>
    getActiveBroadcasts()
      .then(setBroadcasts)
      .catch(() => {});

  useEffect(() => {
    listOrgPods()
      .then(setPods)
      .catch(() => {});
    listOrgMembers(false)
      .then((m) => setMembers(m.filter((x) => x.role === 'agent' || x.role === 'manager')))
      .catch(() => {});
    loadGoals();
    loadBroadcasts();
  }, []);

  // --- goal form ---
  const [goalScope, setGoalScope] = useState<GoalScope>('org');
  const [goalPodId, setGoalPodId] = useState('');
  const [goalAgentId, setGoalAgentId] = useState('');
  const [goalMetric, setGoalMetric] = useState<GoalMetric>('dials');
  const [goalTarget, setGoalTarget] = useState('');
  const [goalBusy, setGoalBusy] = useState(false);
  const [goalMessage, setGoalMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const handleSetGoal = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = Number(goalTarget);
    if (!Number.isFinite(target) || target <= 0) {
      setGoalMessage({ ok: false, text: 'Enter a positive whole number.' });
      return;
    }
    if (goalScope === 'pod' && !goalPodId) {
      setGoalMessage({ ok: false, text: 'Pick a pod.' });
      return;
    }
    if (goalScope === 'agent' && !goalAgentId) {
      setGoalMessage({ ok: false, text: 'Pick an agent.' });
      return;
    }
    setGoalBusy(true);
    setGoalMessage(null);
    try {
      await setOrgGoal(
        goalScope,
        goalMetric,
        Math.round(target),
        goalScope === 'pod' ? goalPodId : undefined,
        goalScope === 'agent' ? goalAgentId : undefined
      );
      setGoalMessage({ ok: true, text: 'Goal saved.' });
      setGoalTarget('');
      loadGoals();
    } catch (e) {
      setGoalMessage({ ok: false, text: e instanceof Error ? e.message : 'Failed to save goal' });
    } finally {
      setGoalBusy(false);
    }
  };

  // --- existing-goals list (edit/delete) ---
  const [goalEdits, setGoalEdits] = useState<Record<string, string>>({});
  const [goalRowBusy, setGoalRowBusy] = useState<string | null>(null);
  const [goalRowError, setGoalRowError] = useState<Record<string, string>>({});

  const goalLabel = (g: OrgGoal): string => {
    if (g.scope === 'org') return 'Whole org';
    if (g.scope === 'pod') return pods.find((p) => p.id === g.podId)?.name ?? 'Unknown pod';
    const m = members.find((x) => x.user_id === g.agentUserId);
    return m
      ? [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.user_id
      : 'Unknown agent';
  };

  const handleEditGoal = async (g: OrgGoal) => {
    const raw = goalEdits[g.id];
    const target = Number(raw);
    if (!Number.isFinite(target) || target <= 0) {
      setGoalRowError((e) => ({ ...e, [g.id]: 'Enter a positive whole number.' }));
      return;
    }
    setGoalRowBusy(g.id);
    setGoalRowError((e) => ({ ...e, [g.id]: '' }));
    try {
      await setOrgGoal(
        g.scope,
        g.metric,
        Math.round(target),
        g.scope === 'pod' ? (g.podId ?? undefined) : undefined,
        g.scope === 'agent' ? (g.agentUserId ?? undefined) : undefined
      );
      loadGoals();
    } catch (e) {
      setGoalRowError((err) => ({
        ...err,
        [g.id]: e instanceof Error ? e.message : 'Failed to update goal',
      }));
    } finally {
      setGoalRowBusy(null);
    }
  };

  const handleDeleteGoal = async (g: OrgGoal) => {
    setGoalRowBusy(g.id);
    setGoalRowError((e) => ({ ...e, [g.id]: '' }));
    try {
      await deleteOrgGoal(g.id);
      setGoals((rows) => rows.filter((r) => r.id !== g.id));
    } catch (e) {
      setGoalRowError((err) => ({
        ...err,
        [g.id]: e instanceof Error ? e.message : 'Failed to delete goal',
      }));
    } finally {
      setGoalRowBusy(null);
    }
  };

  // --- broadcast form ---
  const [broadcastPodId, setBroadcastPodId] = useState('');
  const [broadcastMessage, setBroadcastMessage] = useState('');
  const [broadcastExpiresAt, setBroadcastExpiresAt] = useState('');
  const [broadcastBusy, setBroadcastBusy] = useState(false);
  const [broadcastResult, setBroadcastResult] = useState<{ ok: boolean; text: string } | null>(
    null
  );

  const handlePostBroadcast = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!broadcastMessage.trim()) {
      setBroadcastResult({ ok: false, text: 'Message is required.' });
      return;
    }
    setBroadcastBusy(true);
    setBroadcastResult(null);
    try {
      await createBroadcast(
        broadcastMessage.trim(),
        broadcastPodId || undefined,
        broadcastExpiresAt ? new Date(broadcastExpiresAt) : undefined
      );
      setBroadcastResult({ ok: true, text: 'Broadcast posted.' });
      setBroadcastMessage('');
      setBroadcastExpiresAt('');
      loadBroadcasts();
    } catch (e) {
      setBroadcastResult({
        ok: false,
        text: e instanceof Error ? e.message : 'Failed to post broadcast',
      });
    } finally {
      setBroadcastBusy(false);
    }
  };

  // --- active-broadcasts list (delete) ---
  const [broadcastRowBusy, setBroadcastRowBusy] = useState<string | null>(null);
  const [broadcastRowError, setBroadcastRowError] = useState<Record<string, string>>({});

  const handleDeleteBroadcast = async (b: OrgBroadcast) => {
    setBroadcastRowBusy(b.id);
    setBroadcastRowError((e) => ({ ...e, [b.id]: '' }));
    try {
      await deleteBroadcast(b.id);
      setBroadcasts((rows) => rows.filter((r) => r.id !== b.id));
    } catch (e) {
      setBroadcastRowError((err) => ({
        ...err,
        [b.id]: e instanceof Error ? e.message : 'Failed to delete broadcast',
      }));
    } finally {
      setBroadcastRowBusy(null);
    }
  };

  const selectClass =
    'bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary w-full';
  const inputClass =
    'bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary w-full';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-8">
      <form
        onSubmit={handleSetGoal}
        className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 space-y-3"
      >
        <h3 className="text-body font-medium text-text-primary">Set a daily goal</h3>
        <div className="grid grid-cols-2 max-sm:grid-cols-1 gap-2">
          <select
            value={goalScope}
            onChange={(e) => setGoalScope(e.target.value as GoalScope)}
            className={selectClass}
          >
            <option value="org">Whole org</option>
            <option value="pod">A pod</option>
            <option value="agent">One agent</option>
          </select>
          <select
            value={goalMetric}
            onChange={(e) => setGoalMetric(e.target.value as GoalMetric)}
            className={selectClass}
          >
            {METRIC_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
        {goalScope === 'pod' && (
          <select
            value={goalPodId}
            onChange={(e) => setGoalPodId(e.target.value)}
            className={selectClass}
          >
            <option value="">Pick a pod…</option>
            {pods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        {goalScope === 'agent' && (
          <select
            value={goalAgentId}
            onChange={(e) => setGoalAgentId(e.target.value)}
            className={selectClass}
          >
            <option value="">Pick an agent…</option>
            {members.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {[m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.user_id}
              </option>
            ))}
          </select>
        )}
        <input
          type="number"
          min={1}
          step={1}
          placeholder="Target"
          value={goalTarget}
          onChange={(e) => setGoalTarget(e.target.value)}
          className={inputClass}
        />
        <Button type="submit" size="sm" variant="fe-secondary" disabled={goalBusy}>
          {goalBusy ? 'Saving…' : 'Save goal'}
        </Button>
        {goalMessage && (
          <p className={`text-meta ${goalMessage.ok ? 'text-success' : 'text-danger'}`}>
            {goalMessage.text}
          </p>
        )}
      </form>

      <form
        onSubmit={handlePostBroadcast}
        className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 space-y-3"
      >
        <h3 className="text-body font-medium text-text-primary">Post a broadcast</h3>
        <textarea
          value={broadcastMessage}
          onChange={(e) => setBroadcastMessage(e.target.value)}
          placeholder="Message everyone sees on the Dialer…"
          rows={3}
          maxLength={1000}
          className={`${inputClass} resize-none`}
        />
        <div className="grid grid-cols-2 max-sm:grid-cols-1 gap-2">
          <select
            value={broadcastPodId}
            onChange={(e) => setBroadcastPodId(e.target.value)}
            className={selectClass}
          >
            <option value="">Everyone</option>
            {pods.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} only
              </option>
            ))}
          </select>
          <input
            type="datetime-local"
            value={broadcastExpiresAt}
            onChange={(e) => setBroadcastExpiresAt(e.target.value)}
            className={inputClass}
            title="Optional expiry"
          />
        </div>
        <Button type="submit" size="sm" variant="fe-secondary" disabled={broadcastBusy}>
          {broadcastBusy ? 'Posting…' : 'Post broadcast'}
        </Button>
        {broadcastResult && (
          <p className={`text-meta ${broadcastResult.ok ? 'text-success' : 'text-danger'}`}>
            {broadcastResult.text}
          </p>
        )}
      </form>

      <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 space-y-2">
        <h3 className="text-body font-medium text-text-primary">Current goals</h3>
        {goals.length === 0 && (
          <p className="text-meta text-text-secondary">No standing goals set.</p>
        )}
        {goals.map((g) => (
          <div
            key={g.id}
            className="flex items-center gap-2 py-1 border-t border-border-subtle first:border-t-0 first:pt-0"
          >
            <div className="flex-1 min-w-0">
              <div className="text-sm text-text-primary truncate">
                {goalLabel(g)} ·{' '}
                {METRIC_OPTIONS.find((m) => m.value === g.metric)?.label ?? g.metric}
              </div>
              {goalRowError[g.id] && <p className="text-meta text-danger">{goalRowError[g.id]}</p>}
            </div>
            {canManageGoal(g) ? (
              <>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={goalEdits[g.id] ?? g.targetValue}
                  disabled={goalRowBusy === g.id}
                  onChange={(e) => setGoalEdits((edits) => ({ ...edits, [g.id]: e.target.value }))}
                  className={`${inputClass} w-20`}
                />
                <Button
                  size="sm"
                  variant="fe-ghost"
                  disabled={goalRowBusy === g.id}
                  onClick={() => handleEditGoal(g)}
                >
                  Save
                </Button>
                <Button
                  size="sm"
                  variant="fe-ghost"
                  disabled={goalRowBusy === g.id}
                  onClick={() => handleDeleteGoal(g)}
                >
                  Delete
                </Button>
              </>
            ) : (
              <span className="text-meta text-text-secondary">{g.targetValue}</span>
            )}
          </div>
        ))}
      </div>

      <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 space-y-2">
        <h3 className="text-body font-medium text-text-primary">Active broadcasts</h3>
        {broadcasts.length === 0 && (
          <p className="text-meta text-text-secondary">No active broadcasts.</p>
        )}
        {broadcasts.map((b) => (
          <div
            key={b.id}
            className="flex items-center gap-2 py-1 border-t border-border-subtle first:border-t-0 first:pt-0"
          >
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text-primary truncate">{b.message}</p>
              <p className="text-meta text-text-secondary">
                {b.pod_id ? (pods.find((p) => p.id === b.pod_id)?.name ?? 'A pod') : 'Everyone'}
                {b.expires_at ? ` · expires ${new Date(b.expires_at).toLocaleString()}` : ''}
              </p>
              {broadcastRowError[b.id] && (
                <p className="text-meta text-danger">{broadcastRowError[b.id]}</p>
              )}
            </div>
            {canManageBroadcast(b) && (
              <Button
                size="sm"
                variant="fe-ghost"
                disabled={broadcastRowBusy === b.id}
                onClick={() => handleDeleteBroadcast(b)}
              >
                Delete
              </Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

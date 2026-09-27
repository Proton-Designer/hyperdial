import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  listOrgPods,
  listOrgMembers,
  setOrgGoal,
  createBroadcast,
  type OrgPod,
  type OrgMember,
  type GoalScope,
  type GoalMetric,
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
  const [pods, setPods] = useState<OrgPod[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);

  useEffect(() => {
    listOrgPods()
      .then(setPods)
      .catch(() => {});
    listOrgMembers(false)
      .then((m) => setMembers(m.filter((x) => x.role === 'agent' || x.role === 'manager')))
      .catch(() => {});
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
    } catch (e) {
      setGoalMessage({ ok: false, text: e instanceof Error ? e.message : 'Failed to save goal' });
    } finally {
      setGoalBusy(false);
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
    } catch (e) {
      setBroadcastResult({
        ok: false,
        text: e instanceof Error ? e.message : 'Failed to post broadcast',
      });
    } finally {
      setBroadcastBusy(false);
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
        <div className="grid grid-cols-2 gap-2">
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
        <div className="grid grid-cols-2 gap-2">
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
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/contexts/AuthContext';
import { useOrg } from '@/contexts/OrgContext';
import {
  listOrgPods,
  createPowerHour,
  cancelPowerHour,
  listPowerHours,
  getManagerPods,
  powerHourStatus,
  type OrgPod,
  type PowerHour,
  type PowerHourScope,
  type PowerHourMetric,
} from '@/lib/api';
import { PowerHourBoard } from './PowerHourBoard';

const METRIC_OPTIONS: { value: PowerHourMetric; label: string }[] = [
  { value: 'conversations', label: 'Conversations' },
  { value: 'connects', label: 'Connects' },
  { value: 'appointments', label: 'Appointments' },
];

const DURATION_OPTIONS = [15, 30, 45, 60, 90, 120, 180, 240];

const POLL_MS = 20000;

const STATUS_BADGE: Record<
  ReturnType<typeof powerHourStatus>,
  { label: string; variant: 'destructive' | 'secondary' | 'outline' | 'default' }
> = {
  live: { label: 'Live', variant: 'destructive' },
  upcoming: { label: 'Upcoming', variant: 'secondary' },
  ended: { label: 'Ended', variant: 'outline' },
  cancelled: { label: 'Cancelled', variant: 'outline' },
};

function metricLabel(m: PowerHourMetric): string {
  return METRIC_OPTIONS.find((o) => o.value === m)?.label ?? m;
}

function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * MISSION-5 TASK-M5-E2: create/schedule/cancel a power hour, plus the list of recent ones (last
 * 20, RLS already scopes it to what this caller can see -- see api.ts's listPowerHours). Same
 * self-contained, no-props shape as TeamGoalsAndBroadcastPanel; server enforces every actual
 * scope/role rule, this component only hides/disables where the server would reject (same
 * lesson eng2's review left on that panel -- getManagerPods tells a manager caller which pods
 * they may cancel in, so Cancel isn't offered on a pod outside their own scope).
 */
export function PowerHourPanel() {
  const { user } = useAuth();
  const { role } = useOrg();
  const isManagerOrBetter = role === 'owner' || role === 'admin' || role === 'manager';

  const [pods, setPods] = useState<OrgPod[]>([]);
  const [hours, setHours] = useState<PowerHour[]>([]);
  const [managerPodIds, setManagerPodIds] = useState<string[]>([]);

  const loadHours = useCallback(() => {
    listPowerHours()
      .then(setHours)
      .catch(() => {});
  }, []);

  useEffect(() => {
    listOrgPods()
      .then(setPods)
      .catch(() => {});
    loadHours();
    const interval = setInterval(loadHours, POLL_MS);
    return () => clearInterval(interval);
  }, [loadHours]);

  useEffect(() => {
    if (role === 'manager' && user?.id) {
      getManagerPods(user.id)
        .then(setManagerPodIds)
        .catch(() => {});
    }
  }, [role, user?.id]);

  const canCancel = (p: PowerHour): boolean => {
    if (role === 'owner' || role === 'admin') return true;
    if (role === 'manager')
      return p.scope === 'pod' && !!p.podId && managerPodIds.includes(p.podId);
    return false;
  };

  // --- create form ---
  const [name, setName] = useState('');
  const [scope, setScope] = useState<PowerHourScope>(role === 'manager' ? 'pod' : 'org');
  const [podId, setPodId] = useState('');
  const [metric, setMetric] = useState<PowerHourMetric>('conversations');
  const [startNow, setStartNow] = useState(true);
  const [scheduledStart, setScheduledStart] = useState(() =>
    toDatetimeLocalValue(new Date(Date.now() + 5 * 60000))
  );
  const [durationMinutes, setDurationMinutes] = useState(60);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setMessage({ ok: false, text: 'Name is required.' });
      return;
    }
    if (scope === 'pod' && !podId) {
      setMessage({ ok: false, text: 'Pick a pod.' });
      return;
    }
    const startsAt = startNow ? new Date() : new Date(scheduledStart);
    if (!startNow && Number.isNaN(startsAt.getTime())) {
      setMessage({ ok: false, text: 'Pick a valid start time.' });
      return;
    }
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60000);
    const targetNum = target.trim() ? Number(target) : undefined;
    if (targetNum !== undefined && (!Number.isFinite(targetNum) || targetNum <= 0)) {
      setMessage({ ok: false, text: 'Target must be a positive whole number.' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await createPowerHour({
        name: name.trim(),
        startsAt,
        endsAt,
        scope,
        podId: scope === 'pod' ? podId : undefined,
        metric,
        target: targetNum !== undefined ? Math.round(targetNum) : undefined,
      });
      setMessage({ ok: true, text: 'Power hour created.' });
      setName('');
      setTarget('');
      loadHours();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : 'Failed to create' });
    } finally {
      setBusy(false);
    }
  };

  const [cancelBusy, setCancelBusy] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<Record<string, string>>({});

  const handleCancel = async (p: PowerHour) => {
    setCancelBusy(p.id);
    setCancelError((e) => ({ ...e, [p.id]: '' }));
    try {
      await cancelPowerHour(p.id);
      loadHours();
    } catch (err) {
      setCancelError((e) => ({
        ...e,
        [p.id]: err instanceof Error ? err.message : 'Failed to cancel',
      }));
    } finally {
      setCancelBusy(null);
    }
  };

  if (!isManagerOrBetter && hours.length === 0) return null;

  const selectClass =
    'bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary w-full';
  const inputClass =
    'bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary w-full';

  return (
    <div className="mb-8 space-y-4">
      {isManagerOrBetter && (
        <form
          onSubmit={handleCreate}
          className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 space-y-3"
        >
          <h3 className="text-body font-medium text-text-primary">Start a power hour</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Friday Sprint"
              className={inputClass}
              maxLength={100}
            />
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as PowerHourMetric)}
              className={selectClass}
            >
              {METRIC_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <select
              value={scope}
              onChange={(e) => setScope(e.target.value as PowerHourScope)}
              className={selectClass}
              disabled={role === 'manager'}
              title={
                role === 'manager' ? 'Managers can only start pod-scoped power hours' : undefined
              }
            >
              <option value="org">Whole org</option>
              <option value="pod">A pod</option>
            </select>
            {scope === 'pod' && (
              <select
                value={podId}
                onChange={(e) => setPodId(e.target.value)}
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
            <select
              value={durationMinutes}
              onChange={(e) => setDurationMinutes(Number(e.target.value))}
              className={selectClass}
            >
              {DURATION_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m < 60 ? `${m} min` : `${m / 60}h${m % 60 ? ` ${m % 60}m` : ''}`}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              step={1}
              placeholder="Target (optional)"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              className={inputClass}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-sm text-text-secondary">
              <input type="radio" checked={startNow} onChange={() => setStartNow(true)} />
              Start now
            </label>
            <label className="flex items-center gap-1.5 text-sm text-text-secondary">
              <input type="radio" checked={!startNow} onChange={() => setStartNow(false)} />
              Schedule
            </label>
            {!startNow && (
              <input
                type="datetime-local"
                value={scheduledStart}
                onChange={(e) => setScheduledStart(e.target.value)}
                className={`${inputClass} max-w-[220px]`}
              />
            )}
          </div>
          <Button type="submit" size="sm" variant="fe-secondary" disabled={busy}>
            {busy ? 'Starting…' : 'Start power hour'}
          </Button>
          {message && (
            <p className={`text-meta ${message.ok ? 'text-success' : 'text-danger'}`}>
              {message.text}
            </p>
          )}
        </form>
      )}

      {hours.length > 0 && (
        <div className="space-y-3">
          {hours.map((p) => {
            const status = powerHourStatus(p);
            const badge = STATUS_BADGE[status];
            const podName = p.podId ? (pods.find((x) => x.id === p.podId)?.name ?? 'a pod') : null;
            return (
              <div
                key={p.id}
                className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 space-y-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-body font-medium text-text-primary">{p.name}</span>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                  <span className="text-meta text-text-secondary">
                    {p.scope === 'org' ? 'Whole org' : podName} · {metricLabel(p.metric)}
                    {p.target ? ` · target ${p.target}` : ''}
                  </span>
                  <span className="text-meta text-text-secondary ml-auto">
                    {new Date(p.startsAt).toLocaleString()} –{' '}
                    {new Date(p.endsAt).toLocaleTimeString()}
                  </span>
                  {(status === 'live' || status === 'upcoming') && canCancel(p) && (
                    <Button
                      size="sm"
                      variant="danger-ghost"
                      disabled={cancelBusy === p.id}
                      onClick={() => handleCancel(p)}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
                {cancelError[p.id] && <p className="text-meta text-danger">{cancelError[p.id]}</p>}
                {(status === 'live' || status === 'ended') && <PowerHourBoard powerHour={p} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

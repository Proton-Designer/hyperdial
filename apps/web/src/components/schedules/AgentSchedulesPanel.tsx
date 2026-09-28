import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Plus, Trash2 } from 'lucide-react';
import {
  listOrgMembers,
  listAgentSchedules,
  setAgentScheduleDay,
  setAgentTimezone,
  type OrgMember,
  type AgentScheduleRow,
} from '@/lib/api';

interface Shift {
  start: string;
  end: string;
}

const WEEKDAYS: { value: number; label: string; short: string }[] = [
  { value: 0, label: 'Sunday', short: 'Sun' },
  { value: 1, label: 'Monday', short: 'Mon' },
  { value: 2, label: 'Tuesday', short: 'Tue' },
  { value: 3, label: 'Wednesday', short: 'Wed' },
  { value: 4, label: 'Thursday', short: 'Thu' },
  { value: 5, label: 'Friday', short: 'Fri' },
  { value: 6, label: 'Saturday', short: 'Sat' },
];

function emptyDraft(): Record<number, Shift[]> {
  const next: Record<number, Shift[]> = {};
  for (const day of WEEKDAYS) next[day.value] = [];
  return next;
}

function memberLabel(m: OrgMember): string {
  return [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || m.user_id;
}

/** MISSION-5 TASK-M5-F3 (deferred backlog item): per-agent weekly working-hours schedule editor.
 *  Reachable only by owner/admin/manager (Team.tsx's own tab gating in MainApp.tsx never routes a
 *  plain agent here at all) -- server still enforces the real scope (owner/admin any active
 *  member, manager only their own pod-scoped agents) on every write and read, this UI just tries.
 *  One agent's week at a time (dropdown), not a full team x 7-day matrix, to stay usable at the
 *  390px width this app supports. "Copy day to other days" and "apply this week to other agents"
 *  both compose `setAgentScheduleDay` per target rather than needing their own bulk RPC. */
export function AgentSchedulesPanel() {
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [schedules, setSchedules] = useState<AgentScheduleRow[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setLoadError(null);
    Promise.all([listOrgMembers(false), listAgentSchedules()])
      .then(([m, s]) => {
        const eligible = m.filter((x) => x.role === 'agent' || x.role === 'manager');
        setMembers(eligible);
        setSchedules(s);
        setSelectedAgentId((prev) =>
          prev && eligible.some((x) => x.user_id === prev) ? prev : (eligible[0]?.user_id ?? '')
        );
      })
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const selectedSchedule = useMemo(
    () => schedules.filter((s) => s.agentUserId === selectedAgentId),
    [schedules, selectedAgentId]
  );
  const effectiveTz = selectedSchedule[0]?.effectiveTimezone ?? null;

  const [draft, setDraft] = useState<Record<number, Shift[]>>(emptyDraft());
  const [dayBusy, setDayBusy] = useState<number | null>(null);
  const [dayError, setDayError] = useState<Record<number, string>>({});
  const [tzInput, setTzInput] = useState('');
  const [tzBusy, setTzBusy] = useState(false);
  const [tzMessage, setTzMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Rebuild the working draft from the loaded schedule whenever the selected agent (or the
  // underlying data) changes -- an unsaved in-progress edit on one agent is discarded on switch,
  // same "server is the source of truth, this is a thin editor" model as the rest of this file.
  useEffect(() => {
    const next = emptyDraft();
    for (const row of selectedSchedule) {
      next[row.weekday] = [...next[row.weekday], { start: row.start, end: row.end }];
    }
    setDraft(next);
    setDayError({});
    setTzInput('');
    setTzMessage(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedAgentId, schedules]);

  const [copySourceDay, setCopySourceDay] = useState(1);
  const [copyTargets, setCopyTargets] = useState<Record<number, boolean>>({});
  const [copyBusy, setCopyBusy] = useState(false);
  const [copyMessage, setCopyMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const [applyAgentIds, setApplyAgentIds] = useState<Record<string, boolean>>({});
  const [applyBusy, setApplyBusy] = useState(false);
  const [applyMessage, setApplyMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const updateShift = (weekday: number, index: number, field: 'start' | 'end', value: string) => {
    setDraft((d) => ({
      ...d,
      [weekday]: d[weekday].map((s, i) => (i === index ? { ...s, [field]: value } : s)),
    }));
  };
  const addShift = (weekday: number) => {
    setDraft((d) => ({ ...d, [weekday]: [...d[weekday], { start: '09:00', end: '17:00' }] }));
  };
  const removeShift = (weekday: number, index: number) => {
    setDraft((d) => ({ ...d, [weekday]: d[weekday].filter((_, i) => i !== index) }));
  };

  const saveDay = async (weekday: number) => {
    if (!selectedAgentId) return;
    setDayBusy(weekday);
    setDayError((e) => ({ ...e, [weekday]: '' }));
    try {
      await setAgentScheduleDay(selectedAgentId, weekday, draft[weekday]);
      load();
    } catch (e) {
      setDayError((err) => ({
        ...err,
        [weekday]: e instanceof Error ? e.message : 'Failed to save',
      }));
    } finally {
      setDayBusy(null);
    }
  };

  const handleSaveTimezone = async () => {
    if (!selectedAgentId) return;
    setTzBusy(true);
    setTzMessage(null);
    try {
      await setAgentTimezone(selectedAgentId, tzInput.trim() || null);
      setTzMessage({ ok: true, text: 'Timezone saved.' });
      load();
    } catch (e) {
      setTzMessage({ ok: false, text: e instanceof Error ? e.message : 'Failed to save timezone' });
    } finally {
      setTzBusy(false);
    }
  };

  const handleCopyDay = async () => {
    if (!selectedAgentId) return;
    const targets = WEEKDAYS.map((d) => d.value).filter(
      (v) => copyTargets[v] && v !== copySourceDay
    );
    if (targets.length === 0) {
      setCopyMessage({ ok: false, text: 'Pick at least one target day.' });
      return;
    }
    setCopyBusy(true);
    setCopyMessage(null);
    try {
      const sourceShifts = draft[copySourceDay];
      for (const day of targets) {
        await setAgentScheduleDay(selectedAgentId, day, sourceShifts);
      }
      setCopyMessage({ ok: true, text: `Copied to ${targets.length} day(s).` });
      setCopyTargets({});
      load();
    } catch (e) {
      setCopyMessage({ ok: false, text: e instanceof Error ? e.message : 'Failed to copy' });
    } finally {
      setCopyBusy(false);
    }
  };

  const handleApplyToAgents = async () => {
    const targetAgentIds = Object.keys(applyAgentIds).filter((id) => applyAgentIds[id]);
    if (targetAgentIds.length === 0) {
      setApplyMessage({ ok: false, text: 'Pick at least one agent.' });
      return;
    }
    setApplyBusy(true);
    setApplyMessage(null);
    try {
      for (const agentId of targetAgentIds) {
        for (const day of WEEKDAYS) {
          await setAgentScheduleDay(agentId, day.value, draft[day.value]);
        }
      }
      setApplyMessage({ ok: true, text: `Applied to ${targetAgentIds.length} agent(s).` });
      setApplyAgentIds({});
      load();
    } catch (e) {
      setApplyMessage({ ok: false, text: e instanceof Error ? e.message : 'Failed to apply' });
    } finally {
      setApplyBusy(false);
    }
  };

  const selectClass =
    'bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary w-full';
  const inputClass =
    'bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary';

  if (loading && members.length === 0) {
    return <Skeleton className="h-64 rounded-app-lg mb-8" />;
  }

  return (
    <div className="rounded-app-lg border border-border-subtle bg-surface-1 p-4 mb-8 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-body font-medium text-text-primary">Schedules</h3>
        {loadError && <p className="text-meta text-danger">{loadError}</p>}
      </div>

      {members.length === 0 ? (
        <p className="text-meta text-text-secondary">No agents to schedule.</p>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select
              value={selectedAgentId}
              onChange={(e) => setSelectedAgentId(e.target.value)}
              className={selectClass}
            >
              {members.map((m) => (
                <option key={m.user_id} value={m.user_id}>
                  {memberLabel(m)}
                </option>
              ))}
            </select>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder={effectiveTz ?? 'America/Chicago'}
                value={tzInput}
                onChange={(e) => setTzInput(e.target.value)}
                className={`${inputClass} flex-1`}
                title="IANA timezone, e.g. America/New_York (blank = org default)"
              />
              <Button size="sm" variant="fe-ghost" disabled={tzBusy} onClick={handleSaveTimezone}>
                {tzBusy ? 'Saving…' : 'Save tz'}
              </Button>
            </div>
          </div>
          {tzMessage && (
            <p className={`text-meta ${tzMessage.ok ? 'text-success' : 'text-danger'}`}>
              {tzMessage.text}
            </p>
          )}
          <p className="text-meta text-text-secondary">
            Times are local to {effectiveTz ?? 'the org default timezone'}.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            {WEEKDAYS.map((day) => (
              <div
                key={day.value}
                className="rounded-app-md border border-border-subtle bg-surface-2 p-3 space-y-2"
              >
                <div className="flex items-center justify-between">
                  <span className="text-meta font-medium text-text-primary">{day.label}</span>
                  <button
                    type="button"
                    onClick={() => addShift(day.value)}
                    className="text-text-secondary hover:text-text-primary"
                    title="Add a shift"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                </div>
                {draft[day.value].length === 0 && (
                  <p className="text-meta text-text-muted">No shifts</p>
                )}
                {draft[day.value].map((shift, i) => (
                  <div key={i} className="flex items-center gap-1">
                    <input
                      type="time"
                      value={shift.start}
                      onChange={(e) => updateShift(day.value, i, 'start', e.target.value)}
                      className={`${inputClass} w-full`}
                    />
                    <span className="text-text-muted">–</span>
                    <input
                      type="time"
                      value={shift.end}
                      onChange={(e) => updateShift(day.value, i, 'end', e.target.value)}
                      className={`${inputClass} w-full`}
                    />
                    <button
                      type="button"
                      onClick={() => removeShift(day.value, i)}
                      className="text-text-muted hover:text-danger flex-shrink-0"
                      title="Remove shift"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
                {dayError[day.value] && (
                  <p className="text-meta text-danger">{dayError[day.value]}</p>
                )}
                <Button
                  size="sm"
                  variant="fe-ghost"
                  disabled={dayBusy === day.value}
                  onClick={() => saveDay(day.value)}
                >
                  {dayBusy === day.value ? 'Saving…' : 'Save day'}
                </Button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-border-subtle">
            <div className="space-y-2">
              <p className="text-meta font-medium text-text-primary">Copy a day to other days</p>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  value={copySourceDay}
                  onChange={(e) => setCopySourceDay(Number(e.target.value))}
                  className={`${selectClass} w-auto`}
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </select>
                <span className="text-meta text-text-muted">to:</span>
                {WEEKDAYS.filter((d) => d.value !== copySourceDay).map((d) => (
                  <label
                    key={d.value}
                    className="flex items-center gap-1 text-meta text-text-secondary"
                  >
                    <input
                      type="checkbox"
                      checked={!!copyTargets[d.value]}
                      onChange={(e) =>
                        setCopyTargets((t) => ({ ...t, [d.value]: e.target.checked }))
                      }
                    />
                    {d.short}
                  </label>
                ))}
              </div>
              <Button size="sm" variant="fe-secondary" disabled={copyBusy} onClick={handleCopyDay}>
                {copyBusy ? 'Copying…' : 'Copy'}
              </Button>
              {copyMessage && (
                <p className={`text-meta ${copyMessage.ok ? 'text-success' : 'text-danger'}`}>
                  {copyMessage.text}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <p className="text-meta font-medium text-text-primary">
                Apply this whole week to other agents
              </p>
              <div className="flex flex-wrap gap-2 max-h-24 overflow-y-auto">
                {members
                  .filter((m) => m.user_id !== selectedAgentId)
                  .map((m) => (
                    <label
                      key={m.user_id}
                      className="flex items-center gap-1 text-meta text-text-secondary"
                    >
                      <input
                        type="checkbox"
                        checked={!!applyAgentIds[m.user_id]}
                        onChange={(e) =>
                          setApplyAgentIds((a) => ({ ...a, [m.user_id]: e.target.checked }))
                        }
                      />
                      {memberLabel(m)}
                    </label>
                  ))}
              </div>
              <Button
                size="sm"
                variant="fe-secondary"
                disabled={applyBusy}
                onClick={handleApplyToAgents}
              >
                {applyBusy ? 'Applying…' : 'Apply'}
              </Button>
              {applyMessage && (
                <p className={`text-meta ${applyMessage.ok ? 'text-success' : 'text-danger'}`}>
                  {applyMessage.text}
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

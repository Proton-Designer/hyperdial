import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { Users, ArrowUpDown, Ear, Mic, Radio, Download, Pause, PhoneOff, Hand } from 'lucide-react';
import { rowsToCsv, downloadCsv } from '@/lib/csv';
import {
  getTeamDailyStats,
  getTeamLiveBoard,
  getOrgTimezone,
  getAgentTimeInState,
  getAgentFirstActivity,
  getAgentScheduleAttendanceSignal,
  getAgentScheduleLiveStatus,
  listOrgMembers,
  startCoaching,
  CoachingActionError,
  logAuditEvent,
  pauseDialerSession,
  stopDialerSession,
  hangupLiveCall,
  LiveCallInProgressError,
  getQualityFlagOpenCounts,
  type TeamDailyStatsRow,
  type TeamLiveBoardRow,
  type TeamLiveStatus,
  type TeamMemberRole,
  type CoachingMode,
  type AgentTimeInStateRow,
  type AgentFirstActivityRow,
  type AgentScheduleAttendanceSignalRow,
  type AgentScheduleLiveStatusRow,
  type OrgMember,
} from '@/lib/api';
import { PageHeader } from '@/components/app/PageHeader';
import { EmptyState } from '@/components/app/EmptyState';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { TeamGoalsAndBroadcastPanel } from '@/components/goals/TeamGoalsAndBroadcastPanel';
import { TeamGoalAttainment } from '@/components/goals/TeamGoalAttainment';
import { PowerHourPanel } from '@/components/power-hour/PowerHourPanel';
import { OnboardingChecklistPanel } from '@/components/onboarding/OnboardingChecklistPanel';
import { AgentSchedulesPanel } from '@/components/schedules/AgentSchedulesPanel';

type Range = 'today' | 'yesterday' | '7d' | 'custom';
type TeamView = 'overview' | 'attendance';

const LIVE_POLL_MS = 5000;

/**
 * TASK-M2 (ADM-6/ADM-7): manager team view. Live board polls `team_live_board` every 5s (a
 * single RPC per poll -- see api.ts); the daily table below re-fetches `team_daily_stats` only
 * when the range changes. Both RPCs are owner/admin-gated by the DB itself (return empty for
 * anyone else), so there's no separate client-side role check needed here -- same trust model as
 * `contact_disposition_history`.
 *
 * MISSION-5 TASK-M5-A4: day-boundary math is now parameterized by the org's real timezone
 * (`getOrgTimezone()`, fetched once on mount) instead of a hardcoded 'America/Chicago' -- same
 * Intl round-trip technique as before (works for any IANA zone, correct across a DST
 * transition), just no longer assuming a single zone for every org.
 */

function localTodayParts(tz: string): { y: number; m: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get('year'), m: get('month'), day: get('day') };
}

function localMidnightUtc(tz: string, y: number, month: number, day: number): Date {
  // A zone AHEAD of UTC (e.g. Asia/Tokyo) has its own local midnight on the PREVIOUS UTC
  // calendar day -- search +/-16h in 15-min steps around UTC midnight of the target day (covers
  // every real IANA offset, including the :30/:45 ones), not just forward from it.
  const base = Date.UTC(y, month - 1, day, 0, 0, 0);
  const STEP_MS = 15 * 60 * 1000;
  for (let k = -64; k <= 64; k++) {
    const guess = new Date(base + k * STEP_MS);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(guess);
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    if (
      get('hour') === '00' &&
      get('minute') === '00' &&
      Number(get('year')) === y &&
      Number(get('month')) === month &&
      Number(get('day')) === day
    ) {
      return guess;
    }
  }
  return new Date(base); // unreachable for a real IANA zone (a +/-16h search always finds one)
}

function addDays(
  y: number,
  m: number,
  day: number,
  delta: number
): { y: number; m: number; day: number } {
  const d = new Date(Date.UTC(y, m - 1, day + delta));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function resolveRange(
  tz: string,
  range: Range,
  customStart: string,
  customEnd: string
): { start: Date; end: Date } | null {
  const today = localTodayParts(tz);
  if (range === 'today') {
    const start = localMidnightUtc(tz, today.y, today.m, today.day);
    const tomorrow = addDays(today.y, today.m, today.day, 1);
    return { start, end: localMidnightUtc(tz, tomorrow.y, tomorrow.m, tomorrow.day) };
  }
  if (range === 'yesterday') {
    const y = addDays(today.y, today.m, today.day, -1);
    return {
      start: localMidnightUtc(tz, y.y, y.m, y.day),
      end: localMidnightUtc(tz, today.y, today.m, today.day),
    };
  }
  if (range === '7d') {
    const start7 = addDays(today.y, today.m, today.day, -6);
    const endExclusive = addDays(today.y, today.m, today.day, 1);
    return {
      start: localMidnightUtc(tz, start7.y, start7.m, start7.day),
      end: localMidnightUtc(tz, endExclusive.y, endExclusive.m, endExclusive.day),
    };
  }
  // custom
  if (!customStart || !customEnd) return null;
  const [sy, sm, sd] = customStart.split('-').map(Number);
  const [ey, em, ed] = customEnd.split('-').map(Number);
  const endExclusive = addDays(ey, em, ed, 1);
  return {
    start: localMidnightUtc(tz, sy, sm, sd),
    end: localMidnightUtc(tz, endExclusive.y, endExclusive.m, endExclusive.day),
  };
}

const STATUS_META: Record<TeamLiveStatus, { label: string; dot: string; text: string }> = {
  offline: { label: 'Offline', dot: 'bg-text-muted', text: 'text-text-secondary' },
  ready: { label: 'Ready', dot: 'bg-accent-to', text: 'text-accent-to' },
  dialing: { label: 'Dialing', dot: 'bg-warning', text: 'text-warning' },
  on_call: { label: 'On call', dot: 'bg-success', text: 'text-success' },
  wrap_up: { label: 'Wrap-up', dot: 'bg-warning', text: 'text-warning' },
  paused: { label: 'Paused', dot: 'bg-danger', text: 'text-danger' },
};

function formatElapsed(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return '0m';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

const ROLE_LABEL: Record<TeamMemberRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  agent: 'Agent',
  manager: 'Manager',
};

function RoleChip({ role }: { role: TeamMemberRole }) {
  return (
    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide bg-surface-3 text-text-muted border border-border-subtle flex-shrink-0">
      {ROLE_LABEL[role]}
    </span>
  );
}

function statusLine(row: TeamLiveBoardRow): string {
  const meta = STATUS_META[row.status];
  if (row.status === 'dialing' && row.lines) return `${meta.label} (${row.lines} lines)`;
  if (row.status === 'on_call' && row.contact_name) return `${meta.label} — ${row.contact_name}`;
  return meta.label;
}

const COACHING_MODE_META: { mode: CoachingMode; label: string; icon: typeof Ear }[] = [
  { mode: 'listen', label: 'Listen', icon: Ear },
  { mode: 'whisper', label: 'Whisper', icon: Mic },
  { mode: 'barge', label: 'Barge', icon: Radio },
];

/** MISSION-5 TASK-M5-B2: statuses where a remote Pause actually does anything --
 *  `pauseSession`'s own gate (dialer-engine.ts), widened to include `ready_pending` for exactly
 *  this remote case. Mirrors ParallelDialerUI's own `PAUSABLE_STATES` (the agent's self-pause) --
 *  `ready_pending`/`ready` both fold into the live board's `'ready'` status string, so this list
 *  is just `['ready', 'dialing']` here, not four separate dial_sessions.state values. */
const REMOTE_PAUSABLE_STATUSES = new Set<TeamLiveStatus>(['ready', 'dialing']);

/** MISSION-5 TASK-M5-B2: a generic yes/no confirm, same portal/focus-trap/motion shape as
 *  ParallelDialerUI's own `StopConfirmDialog` -- reused for both remote actions that touch a
 *  live human (End session while on a call, and Hang up) rather than duplicating the dialog
 *  shell twice. */
function RemoteActionConfirmDialog({
  title,
  detail,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  detail: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, true);

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 10000 }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="remote-action-confirm-title"
    >
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} aria-hidden="true" />
      <motion.div
        ref={modalRef}
        tabIndex={-1}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="relative z-[1] w-full max-w-sm rounded-app-lg border border-border-subtle bg-surface-1 p-5 shadow-app-md outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="remote-action-confirm-title" className="text-page-title text-text-primary mb-2">
          {title}
        </h2>
        <p className="text-body text-text-secondary mb-5">{detail}</p>
        <div className="flex flex-col sm:flex-row sm:justify-end gap-2">
          <Button variant="primary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </div>
      </motion.div>
    </div>,
    document.body
  );
}

function LiveBoardCard({
  row,
  onCoach,
  coachingBusy,
  coachingError,
  onRemotePause,
  onRemoteEnd,
  onRemoteHangup,
  remoteBusy,
  remoteError,
  dialingOutsideSchedule,
}: {
  row: TeamLiveBoardRow;
  /** TASK-T3: undefined for interns viewing their OWN row is never possible here -- Team.tsx is
   *  owner/admin-only (route-gated, MainApp.tsx). Always passed for every row; the manager's own
   *  row (if they also dial) is not specially excluded client-side -- the server itself rejects
   *  coaching your own session (targetUserId === managerId, coaching-core.ts), so disabling it
   *  here too would just duplicate that check for no real benefit. */
  onCoach: (targetUserId: string, mode: CoachingMode) => void;
  coachingBusy: boolean;
  coachingError: string | null;
  /** MISSION-5 TASK-M5-B2: remote pause/end/hang-up. All three no-op (button hidden) with no
   *  `row.session_id` -- an offline agent has no session to act on. */
  onRemotePause: (row: TeamLiveBoardRow) => void;
  onRemoteEnd: (row: TeamLiveBoardRow) => void;
  onRemoteHangup: (row: TeamLiveBoardRow) => void;
  remoteBusy: boolean;
  remoteError: string | null;
  /** Deferred backlog item TASK-M5-F3: real-time, informational only -- never blocks dialing. */
  dialingOutsideSchedule: boolean;
}) {
  const meta = STATUS_META[row.status];
  return (
    <div className="rounded-app-md border border-border-subtle bg-surface-2 p-4 flex flex-wrap items-center gap-4">
      <div className="flex items-center gap-2.5 min-w-[160px] flex-1">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${meta.dot}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <div className="font-medium text-text-primary truncate">{row.name}</div>
            <RoleChip role={row.role} />
            {/* MISSION-5 TASK-M5-B2: raise-hand flag -- auto-clears server-side (coaching start
             *  or the call ending), never dismissed from here. */}
            {row.raised_hand_at && (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-warning-soft text-warning flex-shrink-0"
                title="This agent raised their hand"
              >
                <Hand className="w-3 h-3" />
                Raised hand
              </span>
            )}
            {dialingOutsideSchedule && (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-warning-soft text-warning flex-shrink-0"
                title="This agent is dialing outside their scheduled shift"
              >
                Outside schedule
              </span>
            )}
          </div>
          <div className={`text-meta ${meta.text}`}>{statusLine(row)}</div>
          {coachingError && <div className="text-meta text-danger mt-0.5">{coachingError}</div>}
          {remoteError && <div className="text-meta text-danger mt-0.5">{remoteError}</div>}
        </div>
      </div>
      <div className="flex items-center gap-6 text-meta text-text-secondary">
        <div>
          <div className="text-text-muted">Time in state</div>
          <div className="text-text-primary font-medium">{formatElapsed(row.state_since)}</div>
        </div>
        <div>
          <div className="text-text-muted">Session</div>
          <div className="text-text-primary font-medium">
            {formatElapsed(row.session_started_at)}
          </div>
        </div>
        <div>
          <div className="text-text-muted">Calls today</div>
          <div className="text-text-primary font-medium">{row.calls_today}</div>
        </div>
        <div>
          <div className="text-text-muted">Conversations</div>
          <div className="text-text-primary font-medium">{row.conversations_today}</div>
        </div>
      </div>
      {row.status === 'on_call' && (
        <div className="flex items-center gap-1.5">
          {COACHING_MODE_META.map(({ mode, label, icon: Icon }) => (
            <button
              key={mode}
              type="button"
              disabled={coachingBusy}
              onClick={() => onCoach(row.agent_id, mode)}
              className="px-2 py-1 rounded-app-md border border-border-subtle text-meta text-text-secondary hover:text-text-primary hover:border-accent-to/50 disabled:opacity-50 flex items-center gap-1"
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      )}
      {row.session_id && (
        <div className="flex items-center gap-1.5">
          {REMOTE_PAUSABLE_STATUSES.has(row.status) && (
            <button
              type="button"
              disabled={remoteBusy}
              onClick={() => onRemotePause(row)}
              title="Pause this agent's dialing"
              className="px-2 py-1 rounded-app-md border border-border-subtle text-meta text-text-secondary hover:text-text-primary hover:border-accent-to/50 disabled:opacity-50 flex items-center gap-1"
            >
              <Pause className="w-3.5 h-3.5" />
              Pause
            </button>
          )}
          {row.status === 'on_call' && (
            <button
              type="button"
              disabled={remoteBusy}
              onClick={() => onRemoteHangup(row)}
              title="Hang up on the current call"
              className="px-2 py-1 rounded-app-md border border-border-subtle text-meta text-text-secondary hover:text-danger hover:border-danger/50 disabled:opacity-50 flex items-center gap-1"
            >
              <PhoneOff className="w-3.5 h-3.5" />
              Hang up
            </button>
          )}
          <button
            type="button"
            disabled={remoteBusy}
            onClick={() => onRemoteEnd(row)}
            title="End this agent's session"
            className="px-2 py-1 rounded-app-md border border-border-subtle text-meta text-text-secondary hover:text-danger hover:border-danger/50 disabled:opacity-50 flex items-center gap-1"
          >
            End session
          </button>
        </div>
      )}
    </div>
  );
}

type SortKey =
  | keyof Pick<
      TeamDailyStatsRow,
      | 'name'
      | 'dials'
      | 'connects'
      | 'connect_rate'
      | 'conversations'
      | 'conversations_per_hr'
      | 'wins'
      | 'callbacks_set'
      | 'talk_time_seconds'
      | 'dialing_hours'
      | 'line_hours'
      | 'conversations_per_line_hour'
    >
  | 'conversations_per_100_dials';

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Agent' },
  { key: 'dials', label: 'Dials' },
  { key: 'connects', label: 'Connects' },
  { key: 'connect_rate', label: 'Connect %' },
  { key: 'conversations', label: 'Conversations' },
  { key: 'conversations_per_hr', label: 'Conv/hr' },
  { key: 'conversations_per_100_dials', label: 'Fairness' },
  { key: 'conversations_per_line_hour', label: 'Per line-hr' },
  { key: 'wins', label: 'Wins' },
  { key: 'callbacks_set', label: 'Callbacks' },
  { key: 'talk_time_seconds', label: 'Talk time' },
  { key: 'dialing_hours', label: 'Dialing hrs' },
  { key: 'line_hours', label: 'Line-hrs' },
];

/** MISSION-5 TASK-M5-A4: "Fairness" -- conversations per 100 dials, the task's own explicitly
 *  offered alternative to connects-per-line-hour (which would need a NEW `lines`-weighted
 *  aggregate column on team_daily_stats; this is derivable from columns it already returns).
 *  Null (render "—") with zero dials, same "don't show a nonsense figure over no denominator"
 *  convention as conversations_per_hr's own 0.1-hour floor. */
function fairnessScore(row: { dials: number; conversations: number }): number | null {
  if (row.dials <= 0) return null;
  return Math.round((row.conversations / row.dials) * 1000) / 10;
}

/** MISSION-5 TASK-M5-E13 (EC-13): the "connects-per-line-hour" alternative Fairness's own comment
 *  above flags as needing a new weighted column -- team_daily_stats now returns it directly
 *  (line_hours/conversations_per_line_hour), so unlike fairnessScore() this isn't computed
 *  client-side. */

function formatTalkTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return '0m';
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.round((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

/** MISSION-5 TASK-M5-A4 follow-up: renders an ISO instant as a local clock time in the org's own
 *  timezone -- same Intl-based approach as localTodayParts/localMidnightUtc above, just for
 *  display rather than day-boundary math. */
function formatClockTime(iso: string | null, tz: string): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

interface AttendanceRow {
  agent_id: string;
  name: string;
  day: string;
  dialing_seconds: number;
  on_call_seconds: number;
  wrap_up_seconds: number;
  paused_seconds: number;
  paused_by_reason: Record<string, number>;
  total_seconds: number;
  /** null when total_seconds is 0 -- nothing tracked that day, not "0% productive". */
  productive_pct: number | null;
  /** MISSION-5 TASK-M5-A4 follow-up: null only if `agent_first_activity` truly has no row for
   *  this agent/day (shouldn't happen if `agent_time_in_state` has one, since both read the same
   *  underlying events -- kept nullable defensively rather than assumed). */
  first_started_at: string | null;
  /** Deferred backlog item TASK-M5-F3: null means "no schedule for this agent/day at all" (the
   *  signal RPC emits no row for that case -- never a false warning), not "false". */
  scheduled_not_signed_in: boolean | null;
  dialed_outside_schedule: boolean | null;
}

/** MISSION-5 TASK-M5-A4: groups agent_time_in_state's per (agent, day, state, reason) seconds
 *  into one row per (agent, day). "Productive %" = (dialing + on_call + wrap_up) / every tracked
 *  second that day (now that agent_time_in_state excludes 'stopped'/'completed' -- see the A4
 *  migration -- "tracked" no longer includes time after a session ended). "First activity" comes
 *  from the sibling `agent_first_activity` RPC (follow-up) -- merged in here by the same
 *  (agent_id, day) key. */
function groupAttendance(
  rows: AgentTimeInStateRow[],
  firstActivityRows: AgentFirstActivityRow[],
  scheduleSignalRows: AgentScheduleAttendanceSignalRow[],
  namesById: Map<string, string>
): AttendanceRow[] {
  const byKey = new Map<string, AttendanceRow>();
  const blankRow = (agentId: string, day: string): AttendanceRow => ({
    agent_id: agentId,
    name: namesById.get(agentId) ?? 'Former member',
    day,
    dialing_seconds: 0,
    on_call_seconds: 0,
    wrap_up_seconds: 0,
    paused_seconds: 0,
    paused_by_reason: {},
    total_seconds: 0,
    productive_pct: null,
    first_started_at: null,
    scheduled_not_signed_in: null,
    dialed_outside_schedule: null,
  });
  for (const r of rows) {
    const key = `${r.agent_id}|${r.day}`;
    let row = byKey.get(key);
    if (!row) {
      row = blankRow(r.agent_id, r.day);
      byKey.set(key, row);
    }
    row.total_seconds += r.seconds;
    if (r.state === 'dialing' || r.state === 'connecting') row.dialing_seconds += r.seconds;
    else if (r.state === 'on_call') row.on_call_seconds += r.seconds;
    else if (r.state === 'wrap_up') row.wrap_up_seconds += r.seconds;
    else if (r.state === 'paused' || r.state === 'paused_agent_lost') {
      row.paused_seconds += r.seconds;
      const reason = r.reason ?? 'Unspecified';
      row.paused_by_reason[reason] = (row.paused_by_reason[reason] ?? 0) + r.seconds;
    }
  }
  for (const fa of firstActivityRows) {
    const key = `${fa.agent_id}|${fa.day}`;
    let row = byKey.get(key);
    if (!row) {
      // Defensive only -- agent_time_in_state's own `having sum(...) > 0` should mean every real
      // event contributes a row there too, but don't silently drop a first-activity value if it
      // ever doesn't.
      row = blankRow(fa.agent_id, fa.day);
      byKey.set(key, row);
    }
    row.first_started_at = fa.first_started_at;
  }
  for (const sig of scheduleSignalRows) {
    const key = `${sig.agentId}|${sig.day}`;
    let row = byKey.get(key);
    if (!row) {
      // A scheduled day with zero dial activity at all still needs its own row so the "scheduled,
      // not signed in" badge has somewhere to render -- agent_time_in_state/agent_first_activity
      // both only emit rows where at least one event happened.
      row = blankRow(sig.agentId, sig.day);
      byKey.set(key, row);
    }
    row.scheduled_not_signed_in = sig.scheduledNotSignedIn;
    row.dialed_outside_schedule = sig.dialedOutsideSchedule;
  }
  for (const row of byKey.values()) {
    const productiveSeconds = row.dialing_seconds + row.on_call_seconds + row.wrap_up_seconds;
    row.productive_pct =
      row.total_seconds > 0
        ? Math.round((productiveSeconds / row.total_seconds) * 1000) / 10
        : null;
  }
  return [...byKey.values()].sort(
    (a, b) => b.day.localeCompare(a.day) || a.name.localeCompare(b.name)
  );
}

const ATTENDANCE_COLUMNS: { key: keyof AttendanceRow | 'paused_label'; label: string }[] = [
  { key: 'name', label: 'Agent' },
  { key: 'day', label: 'Date' },
  { key: 'first_started_at', label: 'First activity' },
  { key: 'dialing_seconds', label: 'Dialing (s)' },
  { key: 'on_call_seconds', label: 'On call (s)' },
  { key: 'wrap_up_seconds', label: 'Wrap-up (s)' },
  { key: 'paused_seconds', label: 'Paused (s)' },
  { key: 'productive_pct', label: 'Productive %' },
  { key: 'scheduled_not_signed_in', label: 'Not signed in' },
  { key: 'dialed_outside_schedule', label: 'Outside schedule' },
];

/** Deferred backlog item TASK-M5-F3: null (no schedule that day) renders as a plain dash, never a
 *  warning -- see AttendanceRow's own field comment. */
function ScheduleSignalCell({ value }: { value: boolean | null }) {
  if (value === null) return <span className="text-text-muted">—</span>;
  return value ? (
    <span className="text-warning font-medium">Yes</span>
  ) : (
    <span className="text-text-secondary">No</span>
  );
}

function AttendanceTab({ orgTz }: { orgTz: string }) {
  const [range, setRange] = useState<Range>('7d');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [rows, setRows] = useState<AttendanceRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const resolved = useMemo(
    () => resolveRange(orgTz, range, customStart, customEnd),
    [orgTz, range, customStart, customEnd]
  );

  useEffect(() => {
    if (!resolved) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    Promise.all([
      getAgentTimeInState(resolved.start, resolved.end, undefined, orgTz),
      getAgentFirstActivity(resolved.start, resolved.end, undefined, orgTz),
      getAgentScheduleAttendanceSignal(resolved.start, resolved.end, undefined, orgTz),
      listOrgMembers(true),
    ])
      .then(([timeRows, firstActivityRows, scheduleSignalRows, members]) => {
        if (cancelled) return;
        const namesById = new Map<string, string>(
          members.map((m: OrgMember) => [
            m.user_id,
            [m.first_name, m.last_name].filter(Boolean).join(' ') || m.email || 'Member',
          ])
        );
        setRows(groupAttendance(timeRows, firstActivityRows, scheduleSignalRows, namesById));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [resolved, orgTz]);

  const handleExportCsv = () => {
    if (!rows || rows.length === 0) return;
    const exportRows = rows.map((r) => ({ ...r, paused_label: '' }));
    const csv = rowsToCsv(ATTENDANCE_COLUMNS, exportRows);
    downloadCsv(`attendance-${range}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    void logAuditEvent('export.attendance_csv', { range, rowCount: rows.length });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-1 bg-surface-1 rounded-app-md p-1 border border-border-subtle">
          {(['today', 'yesterday', '7d', 'custom'] as Range[]).map((r) => (
            <Button
              key={r}
              size="sm"
              variant={range === r ? 'fe-secondary' : 'fe-ghost'}
              onClick={() => setRange(r)}
            >
              {r === 'today'
                ? 'Today'
                : r === 'yesterday'
                  ? 'Yesterday'
                  : r === '7d'
                    ? 'Last 7 days'
                    : 'Custom'}
            </Button>
          ))}
        </div>
        <Button
          size="sm"
          variant="fe-ghost"
          onClick={handleExportCsv}
          disabled={!rows || rows.length === 0}
          title="Export this table as CSV"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </Button>
      </div>

      {range === 'custom' && (
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <input
            type="date"
            value={customStart}
            onChange={(e) => setCustomStart(e.target.value)}
            className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
          />
          <span className="text-text-secondary">to</span>
          <input
            type="date"
            value={customEnd}
            onChange={(e) => setCustomEnd(e.target.value)}
            className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
          />
        </div>
      )}

      <p className="text-meta text-text-muted mb-4">
        Per agent, per day. Paused time is broken down by reason below each row.
      </p>

      {error && (
        <div className="mb-4 p-4 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body">
          {error}
        </div>
      )}

      {loading ? (
        <Skeleton className="h-[300px] rounded-app-lg" />
      ) : !rows || rows.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No activity for this range"
          body="Once your team dials during this window, attendance will show up here."
        />
      ) : (
        <div className="rounded-app-lg border border-border-subtle bg-surface-1 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-text-secondary">
                {ATTENDANCE_COLUMNS.map((col) => (
                  <th key={String(col.key)} className="p-3 font-medium">
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.agent_id}|${row.day}`}
                  className="border-b border-border-subtle last:border-0 align-top"
                >
                  <td className="p-3 text-white font-medium">{row.name}</td>
                  <td className="p-3 text-text-secondary">{row.day}</td>
                  <td className="p-3 text-text-secondary">
                    {formatClockTime(row.first_started_at, orgTz)}
                  </td>
                  <td className="p-3 text-text-secondary">{formatDuration(row.dialing_seconds)}</td>
                  <td className="p-3 text-text-secondary">{formatDuration(row.on_call_seconds)}</td>
                  <td className="p-3 text-text-secondary">{formatDuration(row.wrap_up_seconds)}</td>
                  <td className="p-3 text-text-secondary">
                    {formatDuration(row.paused_seconds)}
                    {Object.keys(row.paused_by_reason).length > 0 && (
                      <div className="text-meta text-text-muted">
                        {Object.entries(row.paused_by_reason)
                          .map(([reason, seconds]) => `${reason}: ${formatDuration(seconds)}`)
                          .join(', ')}
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-text-secondary">
                    {row.productive_pct !== null ? `${row.productive_pct}%` : '—'}
                  </td>
                  <td className="p-3">
                    <ScheduleSignalCell value={row.scheduled_not_signed_in} />
                  </td>
                  <td className="p-3">
                    <ScheduleSignalCell value={row.dialed_outside_schedule} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function Team() {
  const [view, setView] = useState<TeamView>('overview');
  // MISSION-5 TASK-M5-A4: fetched once on mount, defaults to 'America/Chicago' until it resolves
  // (matches every RPC's own default) -- every day-boundary computation below waits on this.
  const [orgTz, setOrgTz] = useState('America/Chicago');
  useEffect(() => {
    getOrgTimezone()
      .then(setOrgTz)
      .catch(() => {}); // keep the 'America/Chicago' fallback -- not worth an error state here
  }, []);
  const [range, setRange] = useState<Range>('today');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [daily, setDaily] = useState<TeamDailyStatsRow[] | null>(null);
  const [dailyLoading, setDailyLoading] = useState(true);
  const [dailyError, setDailyError] = useState<string | null>(null);
  const [live, setLive] = useState<TeamLiveBoardRow[] | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  // Deferred backlog item TASK-M5-F3: best-effort, informational only -- a failure here never
  // surfaces as liveError (it would incorrectly read as "the whole live board is broken").
  const [scheduleLiveStatus, setScheduleLiveStatus] = useState<AgentScheduleLiveStatusRow[]>([]);
  // TASK-M5-E7: open disposition-quality-flag count per agent -- a live "today" signal, not
  // scoped to the daily-stats date range above, so it gets its own light poll rather than
  // reloading alongside loadDaily on every range change.
  const [qualityFlagCounts, setQualityFlagCounts] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    const load = () => {
      getQualityFlagOpenCounts()
        .then((counts) => {
          if (alive) setQualityFlagCounts(counts);
        })
        .catch(() => {});
    };
    load();
    const id = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  const [sortKey, setSortKey] = useState<SortKey>('dials');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // MISSION-5 TASK-M5-A4: live board filters (client-side over the already-polled rows -- no
  // extra RPC round trip). 'all' means unfiltered for both.
  const [liveStatusFilter, setLiveStatusFilter] = useState<TeamLiveStatus | 'all'>('all');
  const [liveCampaignFilter, setLiveCampaignFilter] = useState<string>('all');
  // MISSION-5 TASK-M5-A5: pod filter, same client-side-over-already-scoped-rows shape as the
  // campaign filter above -- a manager's own rows are ALREADY pod-scoped server-side
  // (team_live_board), this only lets them (or an owner/admin) narrow further within what they
  // can already see.
  const [livePodFilter, setLivePodFilter] = useState<string>('all');
  const [liveSortKey, setLiveSortKey] = useState<
    'name' | 'status' | 'calls_today' | 'conversations_today' | 'state_since'
  >('name');
  const [liveSortDir, setLiveSortDir] = useState<'asc' | 'desc'>('asc');
  // TASK-T3: 'busy' is global (the manager's own WebRTC client has one call slot, so only one
  // coaching attempt can ever be starting at a time regardless of which row it came from) --
  // the error is per-row (keyed by target agent_id) so a failure on one member's row doesn't
  // show stale text under a DIFFERENT member's row.
  const [coachingBusy, setCoachingBusy] = useState(false);
  const [coachingErrors, setCoachingErrors] = useState<Record<string, string>>({});

  const handleCoach = useCallback((targetUserId: string, mode: CoachingMode) => {
    setCoachingBusy(true);
    setCoachingErrors((prev) => ({ ...prev, [targetUserId]: '' }));
    startCoaching(targetUserId, mode)
      .then(() => {
        // No local "now coaching" state to set here -- useTelnyxCall's own inbound-invite
        // handler (Dialer.tsx, mounted app-wide) auto-answers the resulting invite and the
        // floating CoachingBanner (portal) takes over from there.
      })
      .catch((e) => {
        const message =
          e instanceof CoachingActionError
            ? e.message
            : e instanceof Error
              ? e.message
              : 'Failed to start coaching';
        setCoachingErrors((prev) => ({ ...prev, [targetUserId]: message }));
      })
      .finally(() => setCoachingBusy(false));
  }, []);

  // MISSION-5 TASK-M5-B2: remote pause/end/hang-up. Per-agent (not global like coaching's own
  // `coachingBusy`) -- these are independent HTTP calls against different sessions, no shared
  // client-side resource to serialize on.
  const [remoteBusy, setRemoteBusy] = useState<Record<string, boolean>>({});
  const [remoteErrors, setRemoteErrors] = useState<Record<string, string>>({});
  const [confirmTarget, setConfirmTarget] = useState<{
    row: TeamLiveBoardRow;
    kind: 'end' | 'hangup';
  } | null>(null);

  const runRemoteAction = useCallback(async (agentId: string, action: () => Promise<void>) => {
    setRemoteBusy((prev) => ({ ...prev, [agentId]: true }));
    setRemoteErrors((prev) => ({ ...prev, [agentId]: '' }));
    try {
      await action();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Action failed';
      setRemoteErrors((prev) => ({ ...prev, [agentId]: message }));
    } finally {
      setRemoteBusy((prev) => ({ ...prev, [agentId]: false }));
    }
  }, []);

  const handleRemotePause = useCallback(
    (row: TeamLiveBoardRow) => {
      if (!row.session_id) return;
      void runRemoteAction(row.agent_id, async () => {
        await pauseDialerSession(row.session_id as string, 'Paused by manager');
      });
    },
    [runRemoteAction]
  );

  // MISSION-5 TASK-M5-B2: End session skips the confirm step unless a live call is actually in
  // progress (only `on_call`/`wrap_up` can possibly have one) -- ending an already-idle session
  // (ready/dialing/paused) has no live human to warn about, same "only ever rendered while
  // there's someone to name" scoping StopConfirmDialog's own header already documents for the
  // agent's self-service equivalent.
  const handleRemoteEnd = useCallback(
    (row: TeamLiveBoardRow) => {
      if (!row.session_id) return;
      if (row.status === 'on_call' || row.status === 'wrap_up') {
        setConfirmTarget({ row, kind: 'end' });
        return;
      }
      void runRemoteAction(row.agent_id, async () => {
        await stopDialerSession(row.session_id as string, {});
      });
    },
    [runRemoteAction]
  );

  const handleRemoteHangup = useCallback((row: TeamLiveBoardRow) => {
    if (!row.session_id) return;
    setConfirmTarget({ row, kind: 'hangup' });
  }, []);

  const handleConfirmedRemoteAction = useCallback(() => {
    if (!confirmTarget) return;
    const { row, kind } = confirmTarget;
    setConfirmTarget(null);
    if (!row.session_id) return;
    void runRemoteAction(row.agent_id, async () => {
      if (kind === 'hangup') {
        await hangupLiveCall(row.session_id as string);
      } else {
        // `defer:true` -- "a live call is allowed to finish" (the task's own wording): the
        // session ends the moment this in-progress call's disposition is saved, not right now.
        try {
          await stopDialerSession(row.session_id as string, { defer: true });
        } catch (e) {
          // Genuinely unexpected here (LIVE_CALL_IN_PROGRESS is impossible with defer:true --
          // the server defers instead of refusing) -- surface it rather than silently retrying.
          if (!(e instanceof LiveCallInProgressError)) throw e;
        }
      }
    });
  }, [confirmTarget, runRemoteAction]);

  const resolved = useMemo(
    () => resolveRange(orgTz, range, customStart, customEnd),
    [orgTz, range, customStart, customEnd]
  );

  const loadDaily = useCallback(() => {
    if (!resolved) return;
    setDailyLoading(true);
    setDailyError(null);
    getTeamDailyStats(resolved.start, resolved.end)
      .then(setDaily)
      .catch((e) => setDailyError(e instanceof Error ? e.message : String(e)))
      .finally(() => setDailyLoading(false));
  }, [resolved]);

  useEffect(() => {
    loadDaily();
  }, [loadDaily]);

  // ADM-7: poll every 5s -- a single RPC round trip, cleaned up on unmount/tab switch (Team.tsx
  // is only ever mounted while the Team tab is active, unlike Dialer's always-mounted client).
  const pollingRef = useRef(false);
  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      if (pollingRef.current) return; // never overlap a slow poll with the next tick
      pollingRef.current = true;
      try {
        const rows = await getTeamLiveBoard();
        if (!cancelled) {
          setLive(rows);
          setLiveError(null);
        }
      } catch (e) {
        if (!cancelled) setLiveError(e instanceof Error ? e.message : String(e));
      } finally {
        pollingRef.current = false;
      }
      try {
        const signals = await getAgentScheduleLiveStatus();
        if (!cancelled) setScheduleLiveStatus(signals);
      } catch {
        // best-effort informational badge -- next 5s tick tries again, never blocks the live board
      }
    };
    void poll();
    const interval = setInterval(poll, LIVE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  /** ADM-8: exports exactly the sorted, currently-visible rows (not a fresh unsorted fetch) --
   *  what the export contains matches what the admin is looking at on screen. `conversations_
   *  per_100_dials` (Fairness) is computed onto each row here since it's a client-derived column,
   *  not one team_daily_stats itself returns. */
  const handleExportCsv = () => {
    if (!sortedDaily || sortedDaily.length === 0) return;
    const exportRows = sortedDaily.map((row) => ({
      ...row,
      conversations_per_100_dials: fairnessScore(row),
    }));
    const csv = rowsToCsv(COLUMNS, exportRows);
    downloadCsv(`team-daily-${range}-${new Date().toISOString().slice(0, 10)}.csv`, csv);
    void logAuditEvent('export.team_csv', { range, rowCount: sortedDaily.length });
  };

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  const sortedDaily = useMemo(() => {
    if (!daily) return [];
    const dir = sortDir === 'asc' ? 1 : -1;
    const valueFor = (row: TeamDailyStatsRow): string | number | null => {
      if (sortKey === 'conversations_per_100_dials') return fairnessScore(row);
      return row[sortKey];
    };
    return [...daily].sort((a, b) => {
      const av = valueFor(a);
      const bv = valueFor(b);
      if (typeof av === 'string' || typeof bv === 'string') {
        return dir * String(av ?? '').localeCompare(String(bv ?? ''));
      }
      return dir * (((av ?? 0) as number) - ((bv ?? 0) as number));
    });
  }, [daily, sortKey, sortDir]);

  const outsideScheduleAgentIds = useMemo(
    () => new Set(scheduleLiveStatus.filter((s) => s.dialingOutsideSchedule).map((s) => s.agentId)),
    [scheduleLiveStatus]
  );

  const filteredSortedLive = useMemo(() => {
    if (!live) return [];
    const filtered = live.filter((row) => {
      if (liveStatusFilter !== 'all' && row.status !== liveStatusFilter) return false;
      if (liveCampaignFilter !== 'all' && row.campaign_id !== liveCampaignFilter) return false;
      if (livePodFilter !== 'all' && row.pod_id !== livePodFilter) return false;
      return true;
    });
    const dir = liveSortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = a[liveSortKey];
      const bv = b[liveSortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1; // nulls (e.g. offline state_since) always sort last
      if (bv == null) return -1;
      // Review fix (A4 SHOULD): calls_today/conversations_today are numbers -- comparing them via
      // String().localeCompare() sorted lexicographically ("10" before "9"), not numerically.
      if (typeof av === 'number' && typeof bv === 'number') {
        return dir * (av - bv);
      }
      return dir * String(av).localeCompare(String(bv));
    });
  }, [live, liveStatusFilter, liveCampaignFilter, livePodFilter, liveSortKey, liveSortDir]);

  /** Distinct (campaign_id, campaign_name) pairs currently on the live board -- the filter's own
   *  option list, so it only ever offers a campaign someone is actually dialing right now. */
  const liveCampaignOptions = useMemo(() => {
    if (!live) return [];
    const seen = new Map<string, string>();
    for (const row of live) {
      if (row.campaign_id && !seen.has(row.campaign_id)) {
        seen.set(row.campaign_id, row.campaign_name ?? row.campaign_id);
      }
    }
    return [...seen.entries()];
  }, [live]);

  /** MISSION-5 TASK-M5-A5: same shape as liveCampaignOptions -- only offers a pod that has
   *  someone on the (already server-scoped) board right now. */
  const livePodOptions = useMemo(() => {
    if (!live) return [];
    const seen = new Map<string, string>();
    for (const row of live) {
      if (row.pod_id && !seen.has(row.pod_id)) {
        seen.set(row.pod_id, row.pod_name ?? row.pod_id);
      }
    }
    return [...seen.entries()];
  }, [live]);

  const toggleLiveSort = (key: typeof liveSortKey) => {
    if (key === liveSortKey) {
      setLiveSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setLiveSortKey(key);
      setLiveSortDir('asc');
    }
  };

  const totals = useMemo(() => {
    if (!daily || daily.length === 0) return null;
    const sum = (f: (r: TeamDailyStatsRow) => number) => daily.reduce((s, r) => s + f(r), 0);
    const dials = sum((r) => r.dials);
    const connects = sum((r) => r.connects);
    const conversations = sum((r) => r.conversations);
    const dialingHours = sum((r) => r.dialing_hours);
    const lineHours = sum((r) => r.line_hours);
    return {
      dials,
      connects,
      connectRate: dials > 0 ? Math.round((connects / dials) * 1000) / 10 : 0,
      conversations,
      conversationsPerHr:
        dialingHours >= 0.1 ? Math.round((conversations / dialingHours) * 100) / 100 : null,
      fairness: fairnessScore({ dials, conversations }),
      conversationsPerLineHour:
        lineHours >= 0.1 ? Math.round((conversations / lineHours) * 100) / 100 : null,
      wins: sum((r) => r.wins),
      callbacksSet: sum((r) => r.callbacks_set),
      talkTimeSeconds: sum((r) => r.talk_time_seconds),
      dialingHours: Math.round(dialingHours * 10) / 10,
      lineHours: Math.round(lineHours * 10) / 10,
    };
  }, [daily]);

  return (
    <div className="p-4 sm:p-8 max-w-[1440px] mx-auto">
      <PageHeader title="Team" description="Live status and daily performance across your team" />

      <div className="flex items-center gap-1 bg-surface-1 rounded-app-md p-1 border border-border-subtle mb-6 w-fit">
        <Button
          size="sm"
          variant={view === 'overview' ? 'fe-secondary' : 'fe-ghost'}
          onClick={() => setView('overview')}
        >
          Overview
        </Button>
        <Button
          size="sm"
          variant={view === 'attendance' ? 'fe-secondary' : 'fe-ghost'}
          onClick={() => setView('attendance')}
        >
          Attendance
        </Button>
      </div>

      {view === 'attendance' ? (
        <AttendanceTab orgTz={orgTz} />
      ) : (
        <>
          {/* MISSION-5 TASK-M5-E2: power hour / call blitz, same server-enforced-scope shape. */}
          <PowerHourPanel />

          {/* MISSION-5 TASK-M5-A6: goals + broadcasts. Server-enforced pod scoping (no client-side
              role/pod-scope filtering here -- see the panel's own header comment). */}
          <TeamGoalsAndBroadcastPanel />

          {/* Deferred backlog item TM-B2: onboarding checklist, same server-enforced pod scoping. */}
          <OnboardingChecklistPanel />

          {/* Deferred backlog item TASK-M5-F3: per-agent weekly schedule editor, same server-
              enforced pod scoping (owner/admin any active member, manager pod-scoped). */}
          <AgentSchedulesPanel />

          {/* ADM-7: live board */}
          <div className="mb-8">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className="text-section-title text-text-primary">Live board</h2>
              {/* MISSION-5 TASK-M5-A4: status + campaign filters, client-side over the already-polled
              rows. Sort is via the column labels below each card's own row (see the header row). */}
              <div className="flex items-center gap-2 flex-wrap">
                <select
                  value={liveStatusFilter}
                  onChange={(e) => setLiveStatusFilter(e.target.value as TeamLiveStatus | 'all')}
                  className="bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary"
                >
                  <option value="all">All statuses</option>
                  {(Object.keys(STATUS_META) as TeamLiveStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_META[s].label}
                    </option>
                  ))}
                </select>
                {liveCampaignOptions.length > 0 && (
                  <select
                    value={liveCampaignFilter}
                    onChange={(e) => setLiveCampaignFilter(e.target.value)}
                    className="bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary"
                  >
                    <option value="all">All campaigns</option>
                    {liveCampaignOptions.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
                {livePodOptions.length > 0 && (
                  <select
                    value={livePodFilter}
                    onChange={(e) => setLivePodFilter(e.target.value)}
                    className="bg-surface-2 border border-white/10 rounded-app-sm px-2 py-1.5 text-sm text-text-primary"
                  >
                    <option value="all">All pods</option>
                    {livePodOptions.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                )}
                <div className="flex items-center gap-1 bg-surface-2 rounded-app-sm p-0.5 border border-white/10">
                  {(
                    [
                      { key: 'name', label: 'Name' },
                      { key: 'status', label: 'Status' },
                      { key: 'calls_today', label: 'Calls' },
                      { key: 'conversations_today', label: 'Conv.' },
                      { key: 'state_since', label: 'Time in state' },
                    ] as const
                  ).map((col) => (
                    <button
                      key={col.key}
                      type="button"
                      onClick={() => toggleLiveSort(col.key)}
                      className={`px-2 py-1 rounded text-meta flex items-center gap-1 ${
                        liveSortKey === col.key
                          ? 'text-text-primary bg-surface-3'
                          : 'text-text-secondary'
                      }`}
                    >
                      {col.label}
                      {liveSortKey === col.key && <ArrowUpDown className="w-3 h-3" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            {liveError && (
              <div className="mb-3 p-3 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-meta">
                {liveError}
              </div>
            )}
            {live === null ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-[76px] rounded-app-md" />
                ))}
              </div>
            ) : live.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No team members yet"
                body="Invite interns from Settings to see them here."
              />
            ) : filteredSortedLive.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No one matches these filters"
                body="Try a different status or campaign filter."
              />
            ) : (
              <div className="space-y-2">
                {filteredSortedLive.map((row) => (
                  <LiveBoardCard
                    key={row.agent_id}
                    row={row}
                    onCoach={handleCoach}
                    coachingBusy={coachingBusy}
                    coachingError={coachingErrors[row.agent_id] || null}
                    onRemotePause={handleRemotePause}
                    onRemoteEnd={handleRemoteEnd}
                    onRemoteHangup={handleRemoteHangup}
                    remoteBusy={remoteBusy[row.agent_id] ?? false}
                    remoteError={remoteErrors[row.agent_id] || null}
                    dialingOutsideSchedule={outsideScheduleAgentIds.has(row.agent_id)}
                  />
                ))}
              </div>
            )}
          </div>
          {confirmTarget && (
            <RemoteActionConfirmDialog
              title={
                confirmTarget.kind === 'hangup'
                  ? `Hang up ${confirmTarget.row.name}'s current call?`
                  : `End ${confirmTarget.row.name}'s session?`
              }
              detail={
                confirmTarget.kind === 'hangup'
                  ? 'This disconnects the prospect right now. The agent stays signed in and ready for the next call.'
                  : "The current call is allowed to finish -- the session ends automatically once the agent saves that call's disposition."
              }
              confirmLabel={confirmTarget.kind === 'hangup' ? 'Hang up' : 'End session'}
              onCancel={() => setConfirmTarget(null)}
              onConfirm={handleConfirmedRemoteAction}
            />
          )}

          <TeamGoalAttainment daily={daily} />

          {/* ADM-6: daily numbers */}
          <div>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <h2 className="text-section-title text-text-primary">Daily numbers</h2>
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1 bg-surface-1 rounded-app-md p-1 border border-border-subtle">
                  {(['today', 'yesterday', '7d', 'custom'] as Range[]).map((r) => (
                    <Button
                      key={r}
                      size="sm"
                      variant={range === r ? 'fe-secondary' : 'fe-ghost'}
                      onClick={() => setRange(r)}
                    >
                      {r === 'today'
                        ? 'Today'
                        : r === 'yesterday'
                          ? 'Yesterday'
                          : r === '7d'
                            ? 'Last 7 days'
                            : 'Custom'}
                    </Button>
                  ))}
                </div>
                <Button
                  size="sm"
                  variant="fe-ghost"
                  onClick={handleExportCsv}
                  disabled={!daily || daily.length === 0}
                  title="Export this table as CSV"
                >
                  <Download className="w-4 h-4" />
                  Export CSV
                </Button>
              </div>
            </div>

            {range === 'custom' && (
              <div className="flex flex-wrap items-center gap-3 mb-4">
                <input
                  type="date"
                  value={customStart}
                  onChange={(e) => setCustomStart(e.target.value)}
                  className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
                />
                <span className="text-text-secondary">to</span>
                <input
                  type="date"
                  value={customEnd}
                  onChange={(e) => setCustomEnd(e.target.value)}
                  className="bg-surface-2 border border-white/10 rounded-app-md px-3 py-2 text-white focus:outline-none focus:border-accent-to"
                />
              </div>
            )}

            {dailyError && (
              <div className="mb-4 p-4 rounded-app-md bg-danger-soft border border-danger/30 text-danger text-body">
                {dailyError}
              </div>
            )}

            {dailyLoading ? (
              <Skeleton className="h-[300px] rounded-app-lg" />
            ) : !daily || daily.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No data for this range"
                body="Once your team starts dialing, their numbers will show up here."
              />
            ) : (
              <>
                {/* Desktop/tablet: real table. Mobile (<768): stacked cards. */}
                <div className="hidden md:block rounded-app-lg border border-border-subtle bg-surface-1 overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-border-subtle text-text-secondary">
                        {COLUMNS.map((col) => (
                          <th key={col.key} className="p-3 font-medium">
                            <button
                              type="button"
                              onClick={() => toggleSort(col.key)}
                              className="flex items-center gap-1 hover:text-text-primary"
                            >
                              {col.label}
                              {sortKey === col.key && <ArrowUpDown className="w-3 h-3" />}
                            </button>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedDaily.map((row) => (
                        <tr
                          key={row.agent_id}
                          className="border-b border-border-subtle last:border-0"
                        >
                          <td className="p-3 text-white font-medium">
                            <div className="flex items-center gap-1.5">
                              {row.name}
                              <RoleChip role={row.role} />
                              {qualityFlagCounts[row.agent_id] > 0 && (
                                <span
                                  className="px-1.5 py-0.5 rounded-full text-xs bg-warning/10 text-warning border border-warning/20"
                                  title="Open disposition quality flags -- review in Recordings"
                                >
                                  {qualityFlagCounts[row.agent_id]}
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-3 text-text-secondary">{row.dials}</td>
                          <td className="p-3 text-text-secondary">{row.connects}</td>
                          <td className="p-3 text-text-secondary">{row.connect_rate}%</td>
                          <td className="p-3 text-text-secondary">{row.conversations}</td>
                          <td className="p-3 text-text-secondary">
                            {row.conversations_per_hr !== null
                              ? row.conversations_per_hr.toFixed(2)
                              : '—'}
                          </td>
                          <td
                            className="p-3 text-text-secondary"
                            title="Conversations per 100 dials -- higher means a bigger share of this agent's dials turn into a real conversation."
                          >
                            {fairnessScore(row) !== null ? `${fairnessScore(row)}%` : '—'}
                          </td>
                          <td
                            className="p-3 text-text-secondary"
                            title="Conversations per line-hour (lines x dialing hours) -- corrects Fairness for agents dialing more simultaneous lines out-producing on raw counts alone."
                          >
                            {row.conversations_per_line_hour !== null
                              ? row.conversations_per_line_hour.toFixed(2)
                              : '—'}
                          </td>
                          <td className="p-3 text-text-secondary">{row.wins}</td>
                          <td className="p-3 text-text-secondary">{row.callbacks_set}</td>
                          <td className="p-3 text-text-secondary">
                            {formatTalkTime(row.talk_time_seconds)}
                          </td>
                          <td className="p-3 text-text-secondary">
                            {row.dialing_hours.toFixed(1)}
                          </td>
                          <td className="p-3 text-text-secondary">{row.line_hours.toFixed(1)}</td>
                        </tr>
                      ))}
                    </tbody>
                    {totals && (
                      <tfoot>
                        <tr className="border-t border-border-subtle font-semibold text-text-primary">
                          <td className="p-3">Total</td>
                          <td className="p-3">{totals.dials}</td>
                          <td className="p-3">{totals.connects}</td>
                          <td className="p-3">{totals.connectRate}%</td>
                          <td className="p-3">{totals.conversations}</td>
                          <td className="p-3">
                            {totals.conversationsPerHr !== null
                              ? totals.conversationsPerHr.toFixed(2)
                              : '—'}
                          </td>
                          <td className="p-3">
                            {totals.fairness !== null ? `${totals.fairness}%` : '—'}
                          </td>
                          <td className="p-3">
                            {totals.conversationsPerLineHour !== null
                              ? totals.conversationsPerLineHour.toFixed(2)
                              : '—'}
                          </td>
                          <td className="p-3">{totals.wins}</td>
                          <td className="p-3">{totals.callbacksSet}</td>
                          <td className="p-3">{formatTalkTime(totals.talkTimeSeconds)}</td>
                          <td className="p-3">{totals.dialingHours.toFixed(1)}</td>
                          <td className="p-3">{totals.lineHours.toFixed(1)}</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>

                {/* Mobile cards */}
                <div className="md:hidden space-y-2">
                  {sortedDaily.map((row) => (
                    <div
                      key={row.agent_id}
                      className="rounded-app-md border border-border-subtle bg-surface-2 p-4"
                    >
                      <div className="flex items-center gap-1.5 mb-2">
                        <div className="font-medium text-text-primary">{row.name}</div>
                        <RoleChip role={row.role} />
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-meta text-text-secondary">
                        <div>
                          Dials: <span className="text-text-primary">{row.dials}</span>
                        </div>
                        <div>
                          Connects: <span className="text-text-primary">{row.connects}</span>
                        </div>
                        <div>
                          Connect %: <span className="text-text-primary">{row.connect_rate}%</span>
                        </div>
                        <div>
                          Conversations:{' '}
                          <span className="text-text-primary">{row.conversations}</span>
                        </div>
                        <div>
                          Conv/hr:{' '}
                          <span className="text-text-primary">
                            {row.conversations_per_hr !== null
                              ? row.conversations_per_hr.toFixed(2)
                              : '—'}
                          </span>
                        </div>
                        <div>
                          Fairness:{' '}
                          <span className="text-text-primary">
                            {fairnessScore(row) !== null ? `${fairnessScore(row)}%` : '—'}
                          </span>
                        </div>
                        <div>
                          Per line-hr:{' '}
                          <span className="text-text-primary">
                            {row.conversations_per_line_hour !== null
                              ? row.conversations_per_line_hour.toFixed(2)
                              : '—'}
                          </span>
                        </div>
                        <div>
                          Wins: <span className="text-text-primary">{row.wins}</span>
                        </div>
                        <div>
                          Callbacks: <span className="text-text-primary">{row.callbacks_set}</span>
                        </div>
                        <div>
                          Talk time:{' '}
                          <span className="text-text-primary">
                            {formatTalkTime(row.talk_time_seconds)}
                          </span>
                        </div>
                        <div>
                          Dialing hrs:{' '}
                          <span className="text-text-primary">{row.dialing_hours.toFixed(1)}</span>
                        </div>
                        <div>
                          Line-hrs:{' '}
                          <span className="text-text-primary">{row.line_hours.toFixed(1)}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {totals && (
                    <div className="rounded-app-md border border-border-subtle bg-surface-1 p-4">
                      <div className="font-semibold text-text-primary mb-2">Total</div>
                      <div className="grid grid-cols-2 gap-2 text-meta text-text-secondary">
                        <div>
                          Dials: <span className="text-text-primary">{totals.dials}</span>
                        </div>
                        <div>
                          Connects: <span className="text-text-primary">{totals.connects}</span>
                        </div>
                        <div>
                          Connect %:{' '}
                          <span className="text-text-primary">{totals.connectRate}%</span>
                        </div>
                        <div>
                          Conversations:{' '}
                          <span className="text-text-primary">{totals.conversations}</span>
                        </div>
                        <div>
                          Conv/hr:{' '}
                          <span className="text-text-primary">
                            {totals.conversationsPerHr !== null
                              ? totals.conversationsPerHr.toFixed(2)
                              : '—'}
                          </span>
                        </div>
                        <div>
                          Fairness:{' '}
                          <span className="text-text-primary">
                            {totals.fairness !== null ? `${totals.fairness}%` : '—'}
                          </span>
                        </div>
                        <div>
                          Per line-hr:{' '}
                          <span className="text-text-primary">
                            {totals.conversationsPerLineHour !== null
                              ? totals.conversationsPerLineHour.toFixed(2)
                              : '—'}
                          </span>
                        </div>
                        <div>
                          Wins: <span className="text-text-primary">{totals.wins}</span>
                        </div>
                        <div>
                          Callbacks:{' '}
                          <span className="text-text-primary">{totals.callbacksSet}</span>
                        </div>
                        <div>
                          Talk time:{' '}
                          <span className="text-text-primary">
                            {formatTalkTime(totals.talkTimeSeconds)}
                          </span>
                        </div>
                        <div>
                          Dialing hrs:{' '}
                          <span className="text-text-primary">
                            {totals.dialingHours.toFixed(1)}
                          </span>
                        </div>
                        <div>
                          Line-hrs:{' '}
                          <span className="text-text-primary">{totals.lineHours.toFixed(1)}</span>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

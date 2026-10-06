// Shifts subsystem (TASK-S05): per-shift KPIs, pure. The edge function `shift-kpi-compute` feeds this the
// raw rows (shift_kpi_inputs RPC) and stores the result (shift_kpi_save RPC).
//
// Data mapping (docs/design/shifts.md D5/D6):
//  * Active dialing time = intervals of `agent_state_events` whose state is NOT paused / paused_agent_lost /
//    stopped / completed, clipped to the shift (and to "now" while it is still running). An interval that
//    never closed (browser closed, crash) ends at min(now, last contact-leg end of its session + tail minutes)
//    (no legs: its start + tail). `lastLegEnd` counts a leg still in progress as min(now, created + 30 min).
//  * Calls = contact legs created inside [starts_at, ends_at) of that agent's sessions (dialing outside a shift
//    never counts). connect = outcome 'connected' OR amd_result human/not_sure/human_residence/human_business;
//    conversation = connect with duration >= conversation_min_seconds; voicemail = amd 'machine' OR outcome
//    'machine'; no answer = outcome 'no_answer'.
//  * A shift that is still running is measured "so far": no_show / left_early / low_adherence only fire once
//    it has ended, so a live number never shows a flag it has not earned yet.

import { addDaysYmd, isoWeekdayOfYmd, localYmd, zonedToUtcMs } from './shifts-core.ts';

export const INACTIVE_STATES = ['paused', 'paused_agent_lost', 'stopped', 'completed'];

export interface KpiShift {
  id: string;
  org_id: string;
  user_id: string;
  starts_at: string;
  ends_at: string;
}

export interface KpiSettings {
  timezone: string;
  grace_minutes: number;
  idle_flag_minutes: number;
  adherence_flag_pct: number;
  conversation_min_seconds: number;
  open_session_tail_minutes: number;
}

export interface KpiWindow {
  iso_weekdays: number[];
  start_time: string;
  end_time: string;
  active: boolean;
}

export interface KpiEvent {
  state: string;
  started_at: string;
  ended_at: string | null;
  session_id: string;
}

export interface KpiLeg {
  created_at: string;
  ended_at: string | null;
  outcome: string | null;
  amd_result: string | null;
  duration_seconds: number | null;
  disposition: string | null;
}

export interface KpiInput {
  shift: KpiShift;
  settings: KpiSettings;
  windows: KpiWindow[];
  events: KpiEvent[];
  legs: KpiLeg[];
  /** session id -> ISO time of its last contact-leg end (an open leg counts as min(now, created + 30 min)). */
  lastLegEnd: Record<string, string>;
  nowMs: number;
}

export interface KpiResult {
  scheduled_minutes: number;
  active_dial_minutes: number;
  power_active_minutes: number;
  adherence_pct: number;
  first_dial_at: string | null;
  last_call_end_at: string | null;
  late_start_minutes: number;
  early_end_minutes: number;
  longest_idle_minutes: number;
  dials: number;
  connects: number;
  conversations: number;
  voicemails: number;
  no_answers: number;
  talk_minutes: number;
  dials_per_active_hour: number | null;
  connect_rate_pct: number | null;
  dispositions: Record<string, number>;
  flags: string[];
}

type Interval = [number, number];
const MIN = 60000;

const t = (v: string) => Date.parse(v);
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Sorted, merged, non-empty intervals. */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  const out: Interval[] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

export function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      const s = Math.max(a0, b0);
      const e = Math.min(a1, b1);
      if (e > s) out.push([s, e]);
    }
  }
  return mergeIntervals(out);
}

const total = (list: Interval[]) => list.reduce((n, [a, b]) => n + (b - a), 0);

/** Active dialing intervals from the state events (D5), closing unclosed ones with the tail rule. */
export function buildActiveIntervals(
  events: KpiEvent[],
  lastLegEnd: Record<string, string>,
  tailMinutes: number,
  nowMs: number
): Interval[] {
  const out: Interval[] = [];
  for (const e of events) {
    if (INACTIVE_STATES.includes(e.state)) continue;
    const start = t(e.started_at);
    let end: number;
    if (e.ended_at) {
      end = t(e.ended_at);
    } else {
      const anchor = e.session_id in lastLegEnd ? t(lastLegEnd[e.session_id]) : start;
      end = Math.min(nowMs, Math.max(anchor, start) + tailMinutes * MIN);
    }
    out.push([start, Math.max(start, end)]);
  }
  return mergeIntervals(out);
}

/** The parts of [from, to] that fall inside an active power window, per local date (DST-safe). */
export function powerIntervals(
  windows: KpiWindow[],
  tz: string,
  fromMs: number,
  toMs: number
): Interval[] {
  if (toMs <= fromMs) return [];
  const out: Interval[] = [];
  const firstDay = addDaysYmd(localYmd(fromMs, tz), -1);
  const lastDay = addDaysYmd(localYmd(toMs, tz), 1);
  for (let d = firstDay; d <= lastDay; d = addDaysYmd(d, 1)) {
    const wd = isoWeekdayOfYmd(d);
    for (const w of windows) {
      if (!w.active || !w.iso_weekdays.includes(wd)) continue;
      out.push([
        zonedToUtcMs(d, w.start_time.slice(0, 5), tz),
        zonedToUtcMs(d, w.end_time.slice(0, 5), tz),
      ]);
    }
  }
  return intersect(mergeIntervals(out), [[fromMs, toMs]]);
}

/** A leg that never got an end (lost webhook) counts as ended at min(now, created + 30 min), never as "now" for ever. */
export const OPEN_LEG_CAP_MINUTES = 30;
export const legEndMs = (l: Pick<KpiLeg, 'created_at' | 'ended_at'>, nowMs: number): number =>
  l.ended_at ? t(l.ended_at) : Math.min(nowMs, t(l.created_at) + OPEN_LEG_CAP_MINUTES * MIN);

const HUMAN_AMD = ['human', 'not_sure', 'human_residence', 'human_business'];
export const isConnect = (l: Pick<KpiLeg, 'outcome' | 'amd_result'>) =>
  l.outcome === 'connected' || (l.amd_result !== null && HUMAN_AMD.includes(l.amd_result));

export function computeShiftKpi(i: KpiInput): KpiResult {
  const { shift, settings: s, nowMs } = i;
  const starts = t(shift.starts_at);
  const ends = t(shift.ends_at);
  const ended = nowMs >= ends;
  const asOf = Math.min(nowMs, ends);
  const scheduledMinutes = Math.round((ends - starts) / MIN);

  const active = intersect(
    buildActiveIntervals(i.events, i.lastLegEnd, s.open_session_tail_minutes, nowMs),
    [[starts, asOf]]
  );
  const powerWin = powerIntervals(i.windows, s.timezone, starts, asOf);
  const activeMinutes = Math.round(total(active) / MIN);
  const powerMinutes = Math.round(total(intersect(active, powerWin)) / MIN);

  const legs = i.legs
    .filter((l) => t(l.created_at) >= starts && t(l.created_at) < ends)
    .sort((a, b) => t(a.created_at) - t(b.created_at));
  const dials = legs.length;
  const connects = legs.filter(isConnect);
  const conversations = connects.filter(
    (l) => (l.duration_seconds ?? 0) >= s.conversation_min_seconds
  );
  const voicemails = legs.filter((l) => l.amd_result === 'machine' || l.outcome === 'machine');
  const noAnswers = legs.filter((l) => l.outcome === 'no_answer');
  const talkSeconds = connects.reduce((n, l) => n + (l.duration_seconds ?? 0), 0);

  const dispositions: Record<string, number> = {};
  for (const l of legs) {
    if (l.disposition) dispositions[l.disposition] = (dispositions[l.disposition] ?? 0) + 1;
  }

  const firstDial = dials > 0 ? t(legs[0].created_at) : null;
  const ends_ = legs.map((l) => legEndMs(l, nowMs));
  const lastEnd = ends_.length > 0 ? Math.max(...ends_) : null;

  const lateStart =
    firstDial !== null
      ? Math.max(0, Math.round((firstDial - starts) / MIN))
      : Math.max(0, Math.round((asOf - starts) / MIN));
  const earlyEnd = !ended
    ? 0
    : lastEnd !== null
      ? Math.max(0, Math.round((ends - lastEnd) / MIN))
      : scheduledMinutes;

  // Largest gap between consecutive call starts, including shift start -> first dial and last call end ->
  // end of the (so far) shift.
  let longestIdle: number;
  if (dials === 0) {
    longestIdle = Math.round((asOf - starts) / MIN);
  } else {
    const points = legs.map((l) => t(l.created_at));
    let gap = points[0] - starts;
    for (let k = 1; k < points.length; k++) gap = Math.max(gap, points[k] - points[k - 1]);
    gap = Math.max(gap, asOf - (lastEnd ?? points[points.length - 1]));
    longestIdle = Math.max(0, Math.round(gap / MIN));
  }

  const adherence = scheduledMinutes > 0 ? Math.round((100 * activeMinutes) / scheduledMinutes) : 0;

  const noShow = ended && dials === 0;
  const flags: string[] = [];
  if (noShow) {
    flags.push('no_show');
  } else {
    if (lateStart > s.grace_minutes) flags.push('late_start');
    if (ended && earlyEnd > s.grace_minutes) flags.push('left_early');
    if (longestIdle > s.idle_flag_minutes) flags.push('long_idle');
    if (ended && adherence < s.adherence_flag_pct) flags.push('low_adherence');
  }

  return {
    scheduled_minutes: scheduledMinutes,
    active_dial_minutes: activeMinutes,
    power_active_minutes: powerMinutes,
    adherence_pct: adherence,
    first_dial_at: firstDial === null ? null : new Date(firstDial).toISOString(),
    last_call_end_at: lastEnd === null ? null : new Date(lastEnd).toISOString(),
    late_start_minutes: lateStart,
    early_end_minutes: earlyEnd,
    longest_idle_minutes: longestIdle,
    dials,
    connects: connects.length,
    conversations: conversations.length,
    voicemails: voicemails.length,
    no_answers: noAnswers.length,
    talk_minutes: Math.round(talkSeconds / 60),
    dials_per_active_hour: activeMinutes > 0 ? round1(dials / (activeMinutes / 60)) : null,
    connect_rate_pct: dials > 0 ? round1((100 * connects.length) / dials) : null,
    dispositions,
    flags,
  };
}

/** Whether a dialing shift is old enough to finalize (ended more than `afterMinutes` ago, default 2 h). */
export function isFinalizable(endsAtIso: string, nowMs: number, afterMinutes = 120): boolean {
  return nowMs - t(endsAtIso) > afterMinutes * MIN;
}

/** Power week test (week close): >= power_week_pct in power windows, dialed at least an hour, minimum met. */
export function earnedPowerWeek(args: {
  powerMinutes: number;
  activeMinutes: number;
  powerWeekPct: number;
  countedHours: number;
  minimumHours: number;
}): { pct: number | null; earned: boolean } {
  const pct =
    args.activeMinutes > 0 ? round1((100 * args.powerMinutes) / args.activeMinutes) : null;
  return {
    pct,
    earned:
      pct !== null &&
      pct >= args.powerWeekPct &&
      args.activeMinutes >= 60 &&
      args.countedHours >= args.minimumHours,
  };
}

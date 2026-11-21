// Shifts subsystem (TASK-S02): pure helpers shared by the shifts-* / shift-* / admin-shift* edge
// functions -- week math in the org's timezone, snake_case row -> camelCase DTO mappers
// (contract: docs/design/shifts.md section 3, mirrored by apps/web/src/lib/api.ts), input
// validation, and the error-code -> HTTP mapping. No I/O here; shifts-io.ts does the database work.

// ---------------------------------------------------------------------------------------------
// Row shapes (as PostgREST returns them)
// ---------------------------------------------------------------------------------------------

export interface ShiftSettingsRow {
  org_id: string;
  enabled: boolean;
  timezone: string;
  min_weekly_hours: number | string;
  lock_weekday: number;
  lock_time: string; // 'HH:MM:SS'
  change_notice_hours: number;
  grace_minutes: number;
  conversation_min_seconds: number;
  idle_flag_minutes: number;
  adherence_flag_pct: number;
  open_session_tail_minutes: number;
  power_coverage_alert: number;
  power_week_pct: number;
  ghl_calendar_id: string | null;
  ghl_owner_user_id: string | null;
  /** The first moment Shifts was switched on (null while it never was). */
  enabled_at?: string | null;
}

export interface OpenHoursRow {
  iso_weekday: number;
  open_from: string;
  open_until: string;
}

export interface PowerWindowRow {
  id: string;
  label: string;
  iso_weekdays: number[];
  start_time: string;
  end_time: string;
  active: boolean;
}

export interface ShiftRow {
  id: string;
  user_id: string;
  week_start: string;
  activity: string;
  starts_at: string;
  ends_at: string;
  hours: number | string;
  power_minutes: number;
  status: string;
  source: string;
  ghl_sync_status: string;
  clocked_in_at?: string | null;
  clocked_out_at?: string | null;
}

export interface SurveyRow {
  shift_id: string;
  top_objection: string;
  objection_note: string;
  what_worked: string;
  slowed_by: string;
  slowed_note: string | null;
  list_quality: number;
  submitted_at: string;
}

export interface CommitmentRow {
  week_start: string;
  submitted_at: string | null;
  scheduled_hours: number | string;
  power_hours: number | string;
  power_dial_pct: number | string | null;
  power_week: boolean;
  light_week: boolean;
  min_hours_override: number | string | null;
}

export interface KpiRow {
  shift_id: string;
  user_id: string;
  final: boolean;
  computed_at: string;
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
  dials_per_active_hour: number | string | null;
  connect_rate_pct: number | string | null;
  /** TASK-G01 columns: absent on a database that has not applied 20261019195842 yet. */
  sign_ups?: number | null;
  conversion_rate_pct?: number | string | null;
  dispositions: Record<string, number> | null;
  flags: string[] | null;
  clocked_in_at?: string | null;
  clocked_out_at?: string | null;
  clock_in_late_minutes?: number | null;
}

export interface RequestRow {
  id: string;
  user_id: string;
  week_start: string;
  type: string;
  from_shift_id: string | null;
  to_starts_at: string | null;
  to_ends_at: string | null;
  to_activity: string | null;
  requested_min_hours: number | string | null;
  reason: string;
  is_late: boolean;
  status: string;
  reviewer_id: string | null;
  reviewer_note: string | null;
  reviewed_at: string | null;
  created_at: string;
}

export interface RosterRow {
  user_id: string;
  name: string;
  activity: string;
  starts_at: string;
  ends_at: string;
}

// ---------------------------------------------------------------------------------------------
// Time zone / week math. Everything is computed in the org's IANA zone, per date, so DST can never
// shift a wall-clock time (the same rule submit_week applies in SQL).
// ---------------------------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

function zonedParts(ms: number, tz: string) {
  const p = partsFormatter(tz).formatToParts(new Date(ms));
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0);
  return {
    y: g('year'),
    mo: g('month'),
    d: g('day'),
    h: g('hour') % 24,
    mi: g('minute'),
    s: g('second'),
  };
}

/** Offset of `tz` from UTC at instant `ms`, in ms (east positive). */
function tzOffsetMs(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

export function isYmd(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(v) &&
    !Number.isNaN(Date.parse(`${v}T12:00:00Z`))
  );
}

export function isHm(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

/** Local wall-clock `ymd` + `hh:mm` in `tz` -> UTC epoch ms (DST-correct). */
export function zonedToUtcMs(ymd: string, hm: string, tz: string): number {
  const [y, mo, d] = ymd.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let utc = guess - tzOffsetMs(guess, tz);
  // The offset at the guess can differ from the offset at the real instant across a transition.
  utc = guess - tzOffsetMs(utc, tz);
  return utc;
}

export function addDaysYmd(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}

/** ISO weekday 1=Mon..7=Sun of a plain calendar date. */
export function isoWeekdayOfYmd(ymd: string): number {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function mondayOfYmd(ymd: string): string {
  return addDaysYmd(ymd, -(isoWeekdayOfYmd(ymd) - 1));
}

/** The local calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function localYmd(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

export function currentWeekStart(nowMs: number, tz: string): string {
  return mondayOfYmd(localYmd(nowMs, tz));
}

/** Pick deadline of the week starting `weekStart`: lock weekday of the PRECEDING week at lockTime
 *  (default 7 = Sunday = the day before), as a UTC epoch ms. Mirrors private.shift_week_deadline. */
export function weekDeadlineMs(
  weekStart: string,
  lockWeekday: number,
  lockTime: string,
  tz: string
): number {
  const lockDate = addDaysYmd(weekStart, lockWeekday - 8);
  return zonedToUtcMs(lockDate, lockTime.slice(0, 5), tz);
}

export function hm(t: string): string {
  return t.slice(0, 5);
}

// ---------------------------------------------------------------------------------------------
// DTOs (contract section 3)
// ---------------------------------------------------------------------------------------------

const num = (v: number | string | null): number | null =>
  v === null || v === undefined ? null : Number(v);

/** Normalises a PostgREST timestamptz ('...+00:00', or a session-zone offset) to UTC ISO 'Z' so the
 *  client can compare instants as strings. */
export const isoz = <T extends string | null>(v: T): T =>
  (v === null || v === undefined ? v : new Date(v).toISOString()) as T;

/** GHL ids are for manager-level callers only (`includeGhl`); interns get null. */
export function mapSettings(r: ShiftSettingsRow, includeGhl = false) {
  return {
    enabled: r.enabled,
    timezone: r.timezone,
    minWeeklyHours: Number(r.min_weekly_hours),
    lockWeekday: r.lock_weekday,
    lockTime: hm(r.lock_time),
    changeNoticeHours: r.change_notice_hours,
    graceMinutes: r.grace_minutes,
    conversationMinSeconds: r.conversation_min_seconds,
    idleFlagMinutes: r.idle_flag_minutes,
    adherenceFlagPct: r.adherence_flag_pct,
    openSessionTailMinutes: r.open_session_tail_minutes,
    powerCoverageAlert: r.power_coverage_alert,
    powerWeekPct: r.power_week_pct,
    ghlCalendarId: includeGhl ? r.ghl_calendar_id : null,
    ghlOwnerUserId: includeGhl ? r.ghl_owner_user_id : null,
  };
}

export const mapOpenHours = (r: OpenHoursRow) => ({
  isoWeekday: r.iso_weekday,
  openFrom: hm(r.open_from),
  openUntil: hm(r.open_until),
});

export const mapPowerWindow = (r: PowerWindowRow) => ({
  id: r.id,
  label: r.label,
  isoWeekdays: [...r.iso_weekdays].sort((a, b) => a - b),
  startTime: hm(r.start_time),
  endTime: hm(r.end_time),
  active: r.active,
});

/** Whole minutes the clock-in came after the picked start (0 when on time or early); null when not clocked in. */
export function clockInLateMinutes(
  startsAt: string,
  clockedInAt: string | null | undefined
): number | null {
  if (!clockedInAt) return null;
  return Math.max(0, Math.floor((Date.parse(clockedInAt) - Date.parse(startsAt)) / 60000));
}

export const mapSurvey = (r: SurveyRow) => ({
  topObjection: r.top_objection,
  objectionNote: r.objection_note,
  whatWorked: r.what_worked,
  slowedBy: r.slowed_by,
  slowedNote: r.slowed_note,
  listQuality: r.list_quality,
  submittedAt: isoz(r.submitted_at),
});

export function mapShift(
  r: ShiftRow,
  pendingShiftIds: ReadonlySet<string> = new Set(),
  surveys: ReadonlyMap<string, SurveyRow> = new Map()
) {
  const survey = surveys.get(r.id);
  return {
    id: r.id,
    userId: r.user_id,
    weekStart: r.week_start,
    activity: r.activity,
    startsAt: isoz(r.starts_at),
    endsAt: isoz(r.ends_at),
    hours: Number(r.hours),
    powerMinutes: r.power_minutes,
    status: r.status,
    source: r.source,
    ghlSyncStatus: r.ghl_sync_status,
    hasPendingRequest: pendingShiftIds.has(r.id),
    clockedInAt: isoz(r.clocked_in_at ?? null),
    clockedOutAt: isoz(r.clocked_out_at ?? null),
    clockInLateMinutes: clockInLateMinutes(r.starts_at, r.clocked_in_at),
    survey: survey ? mapSurvey(survey) : null,
  };
}

export const mapCommitment = (r: CommitmentRow) => ({
  weekStart: r.week_start,
  submittedAt: isoz(r.submitted_at),
  scheduledHours: Number(r.scheduled_hours),
  powerHours: Number(r.power_hours),
  powerDialPct: num(r.power_dial_pct),
  powerWeek: r.power_week,
  lightWeek: r.light_week,
  minHoursOverride: num(r.min_hours_override),
});

export const mapKpi = (r: KpiRow) => ({
  shiftId: r.shift_id,
  userId: r.user_id,
  final: r.final,
  computedAt: isoz(r.computed_at),
  scheduledMinutes: r.scheduled_minutes,
  activeDialMinutes: r.active_dial_minutes,
  powerActiveMinutes: r.power_active_minutes,
  adherencePct: r.adherence_pct,
  firstDialAt: isoz(r.first_dial_at),
  lastCallEndAt: isoz(r.last_call_end_at),
  lateStartMinutes: r.late_start_minutes,
  earlyEndMinutes: r.early_end_minutes,
  longestIdleMinutes: r.longest_idle_minutes,
  dials: r.dials,
  connects: r.connects,
  conversations: r.conversations,
  voicemails: r.voicemails,
  noAnswers: r.no_answers,
  talkMinutes: r.talk_minutes,
  dialsPerActiveHour: num(r.dials_per_active_hour),
  connectRatePct: num(r.connect_rate_pct),
  signUps: r.sign_ups ?? 0,
  conversionRatePct: num(r.conversion_rate_pct ?? null),
  dispositions: r.dispositions ?? {},
  flags: r.flags ?? [],
  clockedInAt: isoz(r.clocked_in_at ?? null),
  clockedOutAt: isoz(r.clocked_out_at ?? null),
  clockInLateMinutes: r.clock_in_late_minutes ?? null,
});

export const mapRosterEntry = (r: RosterRow, viewerId: string) => ({
  userId: r.user_id,
  name: r.name,
  activity: r.activity,
  startsAt: isoz(r.starts_at),
  endsAt: isoz(r.ends_at),
  isMe: r.user_id === viewerId,
});

/** Hours a user's week would total if `type` were approved. `weekShifts` = their counted shifts
 *  (scheduled/completed/missed) that week, `hoursBefore` = their total. */
export function hoursAfterRequest(
  r: Pick<RequestRow, 'type' | 'to_starts_at' | 'to_ends_at'>,
  from: Pick<ShiftRow, 'hours'> | null,
  hoursBefore: number
): number {
  const toHours =
    r.to_starts_at && r.to_ends_at
      ? (Date.parse(r.to_ends_at) - Date.parse(r.to_starts_at)) / 3600000
      : 0;
  switch (r.type) {
    case 'drop':
      return round2(Math.max(0, hoursBefore - Number(from?.hours ?? 0)));
    case 'move':
      return round2(Math.max(0, hoursBefore - Number(from?.hours ?? 0) + toHours));
    case 'add':
      return round2(hoursBefore + toHours);
    default:
      return round2(hoursBefore); // light_week changes the minimum, not the hours
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface RequestContext {
  userName: string;
  reviewerName: string | null;
  fromShift: ShiftRow | null;
  hoursBefore: number;
  /** The effective minimum of the request's week (override-aware). */
  weekMinimum: number;
  pendingShiftIds?: ReadonlySet<string>;
}

export function mapRequest(r: RequestRow, ctx: RequestContext) {
  return {
    id: r.id,
    userId: r.user_id,
    userName: ctx.userName,
    weekStart: r.week_start,
    type: r.type,
    fromShift: ctx.fromShift ? mapShift(ctx.fromShift, ctx.pendingShiftIds) : null,
    toStartsAt: isoz(r.to_starts_at),
    toEndsAt: isoz(r.to_ends_at),
    toActivity: r.to_activity,
    requestedMinHours: num(r.requested_min_hours),
    reason: r.reason,
    isLate: r.is_late,
    status: r.status,
    reviewerName: ctx.reviewerName,
    reviewerNote: r.reviewer_note,
    reviewedAt: isoz(r.reviewed_at),
    createdAt: isoz(r.created_at),
    hoursBefore: round2(ctx.hoursBefore),
    hoursAfter: hoursAfterRequest(r, ctx.fromShift, ctx.hoursBefore),
    weekMinimum: Number(ctx.weekMinimum),
  };
}

export function buildWeekInfo(
  weekStart: string,
  settings: Pick<
    ShiftSettingsRow,
    'timezone' | 'lock_weekday' | 'lock_time' | 'min_weekly_hours' | 'enabled_at'
  >,
  commitment: Pick<CommitmentRow, 'min_hours_override'> | null,
  nowMs: number
) {
  const tz = settings.timezone;
  const deadline = weekDeadlineMs(weekStart, settings.lock_weekday, settings.lock_time, tz);
  const thisWeek = currentWeekStart(nowMs, tz);
  return {
    weekStart,
    timezone: tz,
    deadlineAt: new Date(deadline).toISOString(),
    deadlinePassed: nowMs > deadline,
    isCurrentWeek: weekStart === thisWeek,
    isNextWeek: weekStart === addDaysYmd(thisWeek, 7),
    minHours: Number(commitment?.min_hours_override ?? settings.min_weekly_hours),
    // the pick deadline fell before Shifts was first switched on: such a week is neutral (nobody could have picked)
    beforeLaunch: settings.enabled_at ? deadline < Date.parse(settings.enabled_at) : false,
  };
}

/** "{First} {L}. dialed {hours} hrs this week, {all | NN%} in power windows." -- identical to
 *  private.shift_power_week_sentence (the sentence the GHL note carries). */
export function powerWeekSentence(name: string, dialMinutes: number, powerPct: number): string {
  const hours = (Math.round((dialMinutes / 60) * 10) / 10).toFixed(1);
  return `${name} dialed ${hours} hrs this week, ${powerPct >= 100 ? 'all' : `${Math.round(powerPct)}%`} in power windows.`;
}

/** Shift in progress, or starting within `leadMinutes`, for the Dialer banner. */
export function pickLiveShift<T extends Pick<ShiftRow, 'status' | 'starts_at' | 'ends_at'>>(
  shifts: T[],
  nowMs: number,
  leadMinutes = 15
): T | null {
  const live = shifts
    .filter(
      (s) =>
        s.status === 'scheduled' &&
        Date.parse(s.starts_at) <= nowMs + leadMinutes * 60000 &&
        Date.parse(s.ends_at) > nowMs
    )
    .sort((a, b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  return live[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Errors: SQL raises `P0001` with message = code, detail = json; every shifts function answers
// { error: code, message: <sentence>, ...detail } with the status below.
// ---------------------------------------------------------------------------------------------

const STATUS: Record<string, number> = {
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  shifts_disabled: 409,
  deadline_passed: 409,
  shift_started: 409,
  request_pending: 409,
  not_pending: 409,
  under_minimum_needs_ack: 409,
  ghl_not_connected: 409,
  ghl_error: 502,
  shift_not_scheduled: 409,
  too_early: 409,
  shift_over: 409,
  not_clocked_in: 409,
  already_ended: 409,
  survey_required: 422,
  bad_survey: 422,
  bad_block: 422,
  overlap: 422,
  under_minimum: 422,
  outside_open_hours: 422,
  bad_time_step: 422,
  reason_too_short: 422,
  bad_week: 422,
  bad_request: 422,
};

export function isShiftErrorCode(code: string): boolean {
  return code in STATUS;
}

function hrs(n: unknown): string {
  const v = Math.round(Number(n) * 10) / 10;
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${v === 1 ? 'hour' : 'hours'}`;
}

export function shiftErrorMessage(code: string, d: Record<string, unknown> = {}): string {
  switch (code) {
    case 'unauthorized':
      return 'Please sign in again.';
    case 'forbidden':
      return "You don't have access to that.";
    case 'not_found':
      return "We couldn't find that.";
    case 'shifts_disabled':
      return "Shifts isn't turned on for your team yet.";
    case 'deadline_passed':
      return 'Picking for that week has closed. You can still ask for changes.';
    case 'shift_started':
      return "That shift has already started, so it can't be changed.";
    case 'request_pending':
      return 'There is already a request waiting on that.';
    case 'not_pending':
      return 'That request has already been decided or withdrawn.';
    case 'under_minimum':
      return `You picked ${hrs(d.hours)}, the minimum is ${hrs(d.minimum)}.`;
    case 'under_minimum_needs_ack':
      return `Approving this leaves them at ${hrs(d.hoursAfter)}, below the ${hrs(d.minimum)} minimum.`;
    case 'overlap':
      return 'Those times overlap another shift.';
    case 'outside_open_hours':
      return 'That time is outside the hours shifts can be booked.';
    case 'bad_time_step':
      return 'Times have to start and end on the hour or half hour.';
    case 'reason_too_short':
      return `Add a bit more detail: the reason needs at least ${Number(d.minimum ?? 20)} characters.`;
    case 'bad_week':
      return 'That is not the start of a week (a Monday).';
    case 'ghl_not_connected':
      return 'GoHighLevel is not connected for this team.';
    case 'ghl_error':
      return 'GoHighLevel did not answer. Try again in a moment.';
    case 'shift_not_scheduled':
      return 'That shift is no longer scheduled.';
    case 'too_early':
      return 'You can start a shift up to 15 minutes before it begins.';
    case 'shift_over':
      return 'That shift is already over.';
    case 'not_clocked_in':
      return 'Start the shift first.';
    case 'already_ended':
      return 'You already ended that shift.';
    case 'survey_required':
      return 'Answer the short end-of-shift survey to end your shift.';
    case 'bad_survey':
      return 'Check your survey answers.';
    case 'bad_block':
      return d.reason === 'in_the_past'
        ? 'That time is in the past.'
        : d.reason === 'outside_open_hours'
          ? 'One of your times is outside the hours shifts can be booked.'
          : d.reason === 'bad_time_step'
            ? 'One of your times is not on the hour or half hour.'
            : 'One of your picks is not valid.';
    case 'bad_request':
      return d.reason === 'light_week_hours'
        ? `A light week has to be more than 0 and less than ${hrs(d.minimum)}.`
        : 'That request is not valid.';
    default:
      return 'Something went wrong. Try again.';
  }
}

export function shiftErrorBody(
  code: string,
  detail: Record<string, unknown> = {}
): { error: string; message: string } & Record<string, unknown> {
  return { error: code, message: shiftErrorMessage(code, detail), ...detail };
}

export function shiftErrorStatus(code: string): number {
  return STATUS[code] ?? 500;
}

const DETAIL_KEYS = [
  'index',
  'reason',
  'hours',
  'minimum',
  'hoursAfter',
  'length',
  'deadline',
  'opensAt',
  'field',
];

/** Recognises an error raised by one of our SQL functions (`P0001`, message = a known code). */
export function parseShiftRpcError(
  err: { code?: string; message?: string; details?: string | null } | null | undefined
): { code: string; detail: Record<string, unknown> } | null {
  if (!err || err.code !== 'P0001' || !err.message || !isShiftErrorCode(err.message)) return null;
  let detail: Record<string, unknown> = {};
  if (err.details) {
    try {
      const parsed = JSON.parse(err.details);
      if (parsed && typeof parsed === 'object') {
        // Only the keys our SQL raises ever reach a client; nothing else from the DB passes through.
        for (const k of DETAIL_KEYS)
          if (k in parsed) detail[k] = (parsed as Record<string, unknown>)[k];
      }
    } catch {
      // detail is best-effort
    }
  }
  return { code: err.message, detail };
}

// ---------------------------------------------------------------------------------------------
// Input validation (bodies/queries). Returns an error code + detail the handler turns into a 4xx.
// ---------------------------------------------------------------------------------------------

export type Parsed<T> =
  { ok: true; value: T } | { ok: false; code: string; detail: Record<string, unknown> };

const ACTIVITIES = new Set(['dialing', 'follow_up', 'social']);
const MAX_BLOCKS = 300;

export function parseWeekParam(raw: string | null): Parsed<string | null> {
  if (raw === null || raw === '') return { ok: true, value: null };
  if (!isYmd(raw) || isoWeekdayOfYmd(raw) !== 1) return { ok: false, code: 'bad_week', detail: {} };
  return { ok: true, value: raw };
}

export interface SubmitBody {
  weekStart: string;
  blocks: { date: string; start: string; end: string; activity: string }[];
}

export function parseSubmitBody(body: unknown): Parsed<SubmitBody> {
  const b = body as { weekStart?: unknown; blocks?: unknown } | null;
  if (!b || !isYmd(b.weekStart) || isoWeekdayOfYmd(b.weekStart) !== 1) {
    return { ok: false, code: 'bad_week', detail: {} };
  }
  if (!Array.isArray(b.blocks) || b.blocks.length > MAX_BLOCKS) {
    return { ok: false, code: 'bad_block', detail: { index: 0, reason: 'bad_format' } };
  }
  const blocks: SubmitBody['blocks'] = [];
  for (let i = 0; i < b.blocks.length; i++) {
    const x = b.blocks[i] as Record<string, unknown> | null;
    if (!x || !isYmd(x.date) || !isHm(x.start) || !isHm(x.end)) {
      return { ok: false, code: 'bad_block', detail: { index: i, reason: 'bad_format' } };
    }
    const activity = x.activity === undefined ? 'dialing' : x.activity;
    if (typeof activity !== 'string' || !ACTIVITIES.has(activity)) {
      return { ok: false, code: 'bad_block', detail: { index: i, reason: 'bad_activity' } };
    }
    blocks.push({ date: x.date, start: x.start, end: x.end, activity });
  }
  return { ok: true, value: { weekStart: b.weekStart, blocks } };
}

export interface CreateRequestBody {
  type: string;
  fromShiftId: string | null;
  date: string | null;
  start: string | null;
  end: string | null;
  toActivity: string | null;
  requestedMinHours: number | null;
  reason: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export function parseCreateRequestBody(body: unknown): Parsed<CreateRequestBody> {
  const b = (body ?? {}) as Record<string, unknown>;
  const bad = (reason: string): Parsed<CreateRequestBody> => ({
    ok: false,
    code: 'bad_request',
    detail: { reason },
  });
  if (typeof b.type !== 'string' || !['move', 'drop', 'add', 'light_week'].includes(b.type))
    return bad('bad_type');
  if (typeof b.reason !== 'string') {
    return { ok: false, code: 'reason_too_short', detail: { minimum: 20, length: 0 } };
  }
  if (b.fromShiftId !== undefined && b.fromShiftId !== null && !isUuid(b.fromShiftId))
    return bad('bad_shift_id');
  if ((b.type === 'move' || b.type === 'drop') && !isUuid(b.fromShiftId))
    return bad('missing_shift');
  if (b.date !== undefined && b.date !== null && !isYmd(b.date)) return bad('bad_date');
  if (b.start !== undefined && b.start !== null && !isHm(b.start)) return bad('bad_time');
  if (b.end !== undefined && b.end !== null && !isHm(b.end)) return bad('bad_time');
  if (
    b.toActivity !== undefined &&
    b.toActivity !== null &&
    !(typeof b.toActivity === 'string' && ACTIVITIES.has(b.toActivity))
  ) {
    return bad('bad_activity');
  }
  let hours: number | null = null;
  if (b.requestedMinHours !== undefined && b.requestedMinHours !== null) {
    hours = Number(b.requestedMinHours);
    if (!Number.isFinite(hours)) return bad('light_week_hours');
  }
  if (b.type === 'light_week' && hours === null) return bad('light_week_hours');
  return {
    ok: true,
    value: {
      type: b.type,
      fromShiftId: (b.fromShiftId as string | null | undefined) ?? null,
      date: (b.date as string | null | undefined) ?? null,
      start: (b.start as string | null | undefined) ?? null,
      end: (b.end as string | null | undefined) ?? null,
      toActivity: (b.toActivity as string | null | undefined) ?? null,
      requestedMinHours: hours,
      reason: b.reason,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Clock in/out + the end-of-shift survey (docs/design/shifts.md section 4b)
// ---------------------------------------------------------------------------------------------

export const TOP_OBJECTIONS = [
  'too_busy',
  'enough_work',
  'fees',
  'dont_trust_apps',
  'not_interested_app_jobs',
  'other',
] as const;
export const SLOWED_BY = [
  'bad_numbers',
  'dialer_issue',
  'didnt_know_answer',
  'script_off',
  'nothing',
] as const;

export interface ShiftSurveyInput {
  topObjection: (typeof TOP_OBJECTIONS)[number];
  objectionNote: string;
  whatWorked: string;
  slowedBy: (typeof SLOWED_BY)[number];
  slowedNote: string | null;
  listQuality: 1 | 2 | 3 | 4 | 5;
}

const badSurvey = (field: string): Parsed<never> => ({
  ok: false,
  code: 'bad_survey',
  detail: { field },
});

/** The same rules clock_shift enforces in SQL, so the client gets the offending field either way. */
export function parseSurveyInput(raw: unknown): Parsed<ShiftSurveyInput> {
  const b = raw as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return { ok: false, code: 'survey_required', detail: {} };
  const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  if (!(TOP_OBJECTIONS as readonly unknown[]).includes(b.topObjection))
    return badSurvey('topObjection');
  const objectionNote = text(b.objectionNote);
  if (objectionNote.length < 3 || objectionNote.length > 500) return badSurvey('objectionNote');
  const whatWorked = text(b.whatWorked);
  if (whatWorked.length < 3 || whatWorked.length > 500) return badSurvey('whatWorked');
  if (!(SLOWED_BY as readonly unknown[]).includes(b.slowedBy)) return badSurvey('slowedBy');
  let slowedNote: string | null = text(b.slowedNote) || null;
  if (b.slowedBy === 'nothing') slowedNote = null;
  else if (slowedNote === null || slowedNote.length < 3 || slowedNote.length > 500)
    return badSurvey('slowedNote');
  const q = b.listQuality;
  if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > 5)
    return badSurvey('listQuality');
  return {
    ok: true,
    value: {
      topObjection: b.topObjection as ShiftSurveyInput['topObjection'],
      objectionNote,
      whatWorked,
      slowedBy: b.slowedBy as ShiftSurveyInput['slowedBy'],
      slowedNote,
      listQuality: q as ShiftSurveyInput['listQuality'],
    },
  };
}

export interface ClockBody {
  shiftId: string;
  action: 'start' | 'end';
  survey: ShiftSurveyInput | null;
}

/** `survey` is only checked here when sent; whether it is REQUIRED depends on the shift (SQL decides). */
export function parseClockBody(body: unknown): Parsed<ClockBody> {
  const b = body as { shiftId?: unknown; action?: unknown; survey?: unknown } | null;
  if (!b || !isUuid(b.shiftId)) return { ok: false, code: 'not_found', detail: {} };
  if (b.action !== 'start' && b.action !== 'end')
    return { ok: false, code: 'bad_request', detail: { reason: 'bad_action' } };
  if (b.action === 'start' || b.survey === undefined || b.survey === null)
    return { ok: true, value: { shiftId: b.shiftId, action: b.action, survey: null } };
  const s = parseSurveyInput(b.survey);
  if (!s.ok) return s;
  return { ok: true, value: { shiftId: b.shiftId, action: 'end', survey: s.value } };
}

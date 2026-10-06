// Shifts subsystem (TASK-S03): pure helpers for the admin-* edge functions -- body parsers (one place
// that decides which input is `bad_request`), DTO mappers and the weekly rollup / power-week callouts.
// I/O (auth, queries) lives in shifts-io.ts and the function entry points.

import {
  isHm,
  isUuid,
  isYmd,
  powerWeekSentence,
  type CommitmentRow,
  type KpiRow,
  type Parsed,
  type ShiftRow,
} from './shifts-core.ts';

const bad = <T>(reason: string): Parsed<T> => ({
  ok: false,
  code: 'bad_request',
  detail: { reason },
});
const ACTIVITIES = ['dialing', 'follow_up', 'social'];
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

// ---- parsers ----------------------------------------------------------------------------------------

export interface ReviewBody {
  requestId: string;
  decision: 'approve' | 'deny';
  note: string | null;
  allowUnderMinimum: boolean;
}

export function parseReviewBody(body: unknown): Parsed<ReviewBody> {
  const b = obj(body);
  if (!isUuid(b.requestId)) return bad('bad_request_id');
  if (b.decision !== 'approve' && b.decision !== 'deny') return bad('bad_decision');
  if (b.note !== undefined && b.note !== null && typeof b.note !== 'string') return bad('bad_note');
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 1000) : '';
  return {
    ok: true,
    value: {
      requestId: b.requestId,
      decision: b.decision,
      note: note === '' ? null : note,
      allowUnderMinimum: b.allowUnderMinimum === true,
    },
  };
}

export interface AdminUpdateBody {
  action: 'create' | 'move' | 'cancel' | 'excuse';
  shiftId: string | null;
  userId: string | null;
  date: string | null;
  start: string | null;
  end: string | null;
  activity: string | null;
}

export function parseAdminUpdateBody(body: unknown): Parsed<AdminUpdateBody> {
  const b = obj(body);
  if (!['create', 'move', 'cancel', 'excuse'].includes(b.action as string))
    return bad('bad_action');
  const opt = (k: string) => (b[k] === undefined || b[k] === null ? null : b[k]);
  const shiftId = opt('shiftId');
  const userId = opt('userId');
  const date = opt('date');
  const start = opt('start');
  const end = opt('end');
  const activity = opt('activity');
  if (shiftId !== null && !isUuid(shiftId)) return bad('bad_shift_id');
  if (userId !== null && !isUuid(userId)) return bad('bad_user_id');
  if (date !== null && !isYmd(date)) return bad('bad_date');
  if ((start !== null && !isHm(start)) || (end !== null && !isHm(end))) return bad('bad_time');
  if (activity !== null && !(typeof activity === 'string' && ACTIVITIES.includes(activity)))
    return bad('bad_activity');
  const action = b.action as AdminUpdateBody['action'];
  if (action === 'create' && (userId === null || date === null || start === null || end === null))
    return bad(userId === null ? 'missing_user' : 'missing_time');
  if (action !== 'create' && shiftId === null) return bad('missing_shift');
  return {
    ok: true,
    value: {
      action,
      shiftId: shiftId as string | null,
      userId: userId as string | null,
      date: date as string | null,
      start: start as string | null,
      end: end as string | null,
      activity: activity as string | null,
    },
  };
}

export interface PowerWindowBody {
  id: string | null;
  label: string;
  isoWeekdays: number[];
  startTime: string;
  endTime: string;
  active: boolean;
}

export function parsePowerWindowBody(body: unknown): Parsed<PowerWindowBody> {
  const b = obj(body);
  if (b.id !== undefined && b.id !== null && !isUuid(b.id)) return bad('bad_id');
  if (typeof b.label !== 'string' || b.label.trim() === '') return bad('bad_label');
  if (
    !Array.isArray(b.isoWeekdays) ||
    b.isoWeekdays.length === 0 ||
    b.isoWeekdays.some((d) => !Number.isInteger(d) || d < 1 || d > 7)
  )
    return bad('bad_weekdays');
  if (!isHm(b.startTime) || !isHm(b.endTime) || b.endTime <= b.startTime) return bad('bad_time');
  return {
    ok: true,
    value: {
      id: (b.id as string | null | undefined) ?? null,
      label: b.label.trim(),
      isoWeekdays: b.isoWeekdays as number[],
      startTime: b.startTime,
      endTime: b.endTime,
      active: b.active !== false,
    },
  };
}

export function parseOpenHoursBody(
  body: unknown
): Parsed<{ isoWeekday: number; openFrom: string; openUntil: string }[]> {
  const rows = obj(body).rows;
  if (!Array.isArray(rows) || rows.length > 7) return bad('bad_rows');
  const out: { isoWeekday: number; openFrom: string; openUntil: string }[] = [];
  const seen = new Set<number>();
  for (const r of rows) {
    const x = obj(r);
    if (
      !Number.isInteger(x.isoWeekday) ||
      (x.isoWeekday as number) < 1 ||
      (x.isoWeekday as number) > 7 ||
      seen.has(x.isoWeekday as number) ||
      !isHm(x.openFrom) ||
      !isHm(x.openUntil) ||
      x.openUntil <= x.openFrom
    )
      return bad('bad_rows');
    seen.add(x.isoWeekday as number);
    out.push({
      isoWeekday: x.isoWeekday as number,
      openFrom: x.openFrom,
      openUntil: x.openUntil,
    });
  }
  return { ok: true, value: out };
}

const SETTING_TYPES: Record<string, 'bool' | 'num' | 'str' | 'hm' | 'strnull'> = {
  enabled: 'bool',
  timezone: 'str',
  minWeeklyHours: 'num',
  lockWeekday: 'num',
  lockTime: 'hm',
  changeNoticeHours: 'num',
  graceMinutes: 'num',
  conversationMinSeconds: 'num',
  idleFlagMinutes: 'num',
  adherenceFlagPct: 'num',
  openSessionTailMinutes: 'num',
  powerCoverageAlert: 'num',
  powerWeekPct: 'num',
  ghlCalendarId: 'strnull',
  ghlOwnerUserId: 'strnull',
};

/** Keeps only known keys with the right JSON type; the database enforces the ranges. */
export function parseSettingsPatch(body: unknown): Parsed<Record<string, unknown>> {
  const b = obj(body);
  const patch: Record<string, unknown> = {};
  for (const [k, kind] of Object.entries(SETTING_TYPES)) {
    if (!(k in b)) continue;
    const v = b[k];
    const ok =
      (kind === 'bool' && typeof v === 'boolean') ||
      (kind === 'num' && typeof v === 'number' && Number.isFinite(v)) ||
      (kind === 'str' && typeof v === 'string' && v.trim() !== '') ||
      (kind === 'hm' && isHm(v)) ||
      (kind === 'strnull' && (v === null || typeof v === 'string'));
    if (!ok) return bad('bad_setting');
    patch[k] = v;
  }
  if (Object.keys(patch).length === 0) return bad('bad_patch');
  return { ok: true, value: patch };
}

export interface MemberBody {
  userId: string;
  setContact: boolean;
  contact: string | null;
  setParticipates: boolean;
  participates: boolean | null;
}

export function parseMemberBody(body: unknown): Parsed<MemberBody> {
  const b = obj(body);
  if (!isUuid(b.userId)) return bad('bad_user_id');
  const setContact = 'ghlContactId' in b;
  if (setContact && b.ghlContactId !== null && typeof b.ghlContactId !== 'string')
    return bad('bad_contact');
  const setParticipates = 'participates' in b;
  if (setParticipates && typeof b.participates !== 'boolean') return bad('bad_participates');
  if (!setContact && !setParticipates) return bad('bad_patch');
  return {
    ok: true,
    value: {
      userId: b.userId,
      setContact,
      contact: setContact ? ((b.ghlContactId as string | null) ?? null) : null,
      setParticipates,
      participates: setParticipates ? (b.participates as boolean) : null,
    },
  };
}

export function parseEmailBody(body: unknown): Parsed<string> {
  const e = obj(body).email;
  if (typeof e !== 'string') return bad('bad_email');
  const email = e.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return bad('bad_email');
  return { ok: true, value: email };
}

export function parseRetryBody(body: unknown): Parsed<number | null> {
  const id = obj(body).outboxId;
  if (id === undefined || id === null) return { ok: true, value: null };
  if (!Number.isInteger(id) || (id as number) <= 0) return bad('bad_outbox_id');
  return { ok: true, value: id as number };
}

// ---- mappers ----------------------------------------------------------------------------------------

export interface MemberRow {
  user_id: string;
  name: string;
  email: string | null;
  role: string;
  participates: boolean;
  ghl_contact_id: string | null;
  pod_id: string | null;
  pod_name: string | null;
}

export const mapAdminMember = (r: MemberRow) => ({
  userId: r.user_id,
  name: r.name,
  email: r.email ?? '',
  role: r.role,
  participates: r.participates,
  ghlContactId: r.ghl_contact_id,
  podId: r.pod_id,
  podName: r.pod_name,
});

export interface OutboxHealthRow {
  id: number;
  kind: string;
  event: string | null;
  user_id: string | null;
  status: string;
  last_error: string | null;
  attempts: number;
  created_at: string;
}

/** Rows that need attention: errored, or pending but carrying an error (an org not connected to GHL). */
export function syncHealth(
  rows: OutboxHealthRow[],
  names: Map<string, string>,
  extra: { pendingCount: number; ghlConnected: boolean }
) {
  const attention = rows
    .filter((r) => r.status === 'error' || (r.status === 'pending' && r.last_error))
    .sort((a, b) => b.id - a.id);
  return {
    errorCount: attention.length,
    // every pending row of the org (rows behind an earlier delayed row of the same intern carry no error yet)
    pendingCount: extra.pendingCount,
    ghlConnected: extra.ghlConnected,
    lastError: attention[0]?.last_error ?? null,
    rows: attention.slice(0, 50).map((r) => ({
      id: r.id,
      kind: r.kind,
      event: r.event,
      userName: r.user_id ? (names.get(r.user_id) ?? null) : null,
      lastError: r.last_error,
      attempts: r.attempts,
      createdAt: new Date(r.created_at).toISOString(),
    })),
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export interface RollupInput {
  members: { userId: string; name: string; participates: boolean }[];
  shifts: Pick<ShiftRow, 'user_id' | 'status' | 'hours'>[];
  commitments: (CommitmentRow & { user_id: string })[];
  kpis: Pick<KpiRow, 'user_id' | 'active_dial_minutes' | 'dials' | 'conversations'>[];
}

/** One row per participating member with something this week; sorted by name (no ranking). */
export function buildRollup(i: RollupInput) {
  const out = [];
  for (const m of i.members) {
    if (!m.participates) continue;
    const mine = i.shifts.filter((s) => s.user_id === m.userId);
    const c = i.commitments.find((x) => x.user_id === m.userId);
    const k = i.kpis.filter((x) => x.user_id === m.userId);
    if (mine.length === 0 && !c) continue;
    const counted = mine
      .filter((s) => ['scheduled', 'completed', 'missed'].includes(s.status))
      .reduce((n, s) => n + Number(s.hours), 0);
    out.push({
      userId: m.userId,
      name: m.name,
      hoursScheduled: round1(c ? Number(c.scheduled_hours) : counted),
      hoursDialing: round1(k.reduce((n, x) => n + x.active_dial_minutes, 0) / 60),
      powerDialPct: c && c.power_dial_pct !== null ? Number(c.power_dial_pct) : null,
      dials: k.reduce((n, x) => n + x.dials, 0),
      conversations: k.reduce((n, x) => n + x.conversations, 0),
      missedShifts: mine.filter((s) => s.status === 'missed').length,
      powerWeek: c?.power_week === true,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Plain-language Power week sentences for a CLOSED week (positive recognition only). */
export function buildCallouts(
  commitments: (CommitmentRow & { user_id: string })[],
  kpis: Pick<KpiRow, 'user_id' | 'active_dial_minutes'>[],
  shortNames: Map<string, string>
) {
  return commitments
    .filter((c) => c.power_week)
    .map((c) => ({
      userId: c.user_id,
      name: shortNames.get(c.user_id) ?? 'Member',
      minutes: kpis
        .filter((k) => k.user_id === c.user_id)
        .reduce((n, k) => n + k.active_dial_minutes, 0),
      pct: Number(c.power_dial_pct ?? 100),
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((x) => ({ userId: x.userId, sentence: powerWeekSentence(x.name, x.minutes, x.pct) }));
}

// ---- GHL contact search -------------------------------------------------------------------------------

export interface ContactSearchClient {
  searchContacts(args: { locationId: string; query?: string; limit?: number }): Promise<{
    contacts: { id: string; firstName?: string; lastName?: string; email?: string }[];
  }>;
}

/** GET /contacts/?locationId=&query=<email>&limit=10 (documented params; the POST /contacts/search body
 *  is undocumented in the raw spec), then an exact, case-insensitive email match. */
export async function findContactsByEmail(
  client: ContactSearchClient,
  locationId: string,
  email: string
): Promise<{ id: string; name: string; email: string }[]> {
  const res = await client.searchContacts({ locationId, query: email, limit: 10 });
  return res.contacts
    .filter((c) => (c.email ?? '').trim().toLowerCase() === email)
    .map((c) => ({
      id: c.id,
      name: [c.firstName, c.lastName].filter(Boolean).join(' ').trim() || email,
      email: c.email ?? email,
    }));
}

/** Decided requests, newest first: by reviewed_at, or created_at for a withdrawn one (withdraw sets no reviewed_at). */
export function sortDecidedRequests<T extends { reviewed_at: string | null; created_at: string }>(
  rows: T[]
): T[] {
  const key = (r: T) => Date.parse(r.reviewed_at ?? r.created_at);
  return [...rows].sort((a, b) => key(b) - key(a));
}

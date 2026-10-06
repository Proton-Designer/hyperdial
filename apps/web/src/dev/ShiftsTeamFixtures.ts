import type {
  AdminShiftMember,
  AdminShiftRollupRow,
  ShiftKpi,
  AdminShiftsOverview,
  AdminShiftUpdateInput,
  Shift,
  ShiftActivity,
  ShiftRequest,
  ShiftWeekCommitment,
} from '@/lib/api';
import {
  OPEN_HOURS,
  POWER_WINDOWS,
  SETTINGS,
  TZ,
  addDays,
  localYmd,
  mondayOf,
  zoned,
} from './ShiftsHarness';

/** TASK-F04: the Team Shifts (admin-shifts-overview) fixtures for the dev harness.
 *  `?dev_shifts=1&view=team&scenario=default|empty|disabled|error|slow|update_overlap`. */

type TeamShift = Shift & { userName: string };

const NAMES: [string, string, string | null][] = [
  ['Sara Kim', 'sara.kim@example.com', 'Pod A'],
  ['Omar Banks', 'omar.banks@example.com', 'Pod A'],
  ['Priya Nair', 'priya.nair@example.com', 'Pod A'],
  ['Liam Torres', 'liam.torres@example.com', 'Pod B'],
  ['Maya Reyes', 'maya.reyes@example.com', 'Pod B'],
  ['Noah Webb', 'noah.webb@example.com', 'Pod B'],
  ['Ava Chen', 'ava.chen@example.com', 'Pod A'],
  ['Ethan Diaz', 'ethan.diaz@example.com', 'Pod B'],
];

const MEMBERS: AdminShiftMember[] = [
  ...NAMES.map(([name, email, pod], i) => ({
    userId: `intern-${i}`,
    name,
    email,
    role: 'agent',
    participates: true,
    ghlContactId: i < 6 ? `ghl-${i}` : null,
    podId: pod ? `pod-${pod.slice(-1)}` : null,
    podName: pod,
  })),
  {
    userId: 'mgr-henry',
    name: 'Henry Price',
    email: 'henry@example.com',
    role: 'manager',
    participates: false,
    ghlContactId: null,
    podId: null,
    podName: null,
  },
];

// [weekday offset 0-5, start, end, intern index, activity]
const PLAN: [number, string, string, number, ShiftActivity?][] = [
  [0, '07:00', '10:00', 0],
  [0, '07:00', '09:30', 1],
  [0, '08:00', '11:00', 2],
  [0, '09:00', '12:00', 3],
  [0, '16:00', '18:00', 4],
  [1, '07:00', '10:00', 0],
  [1, '11:00', '14:00', 1],
  [1, '12:00', '15:00', 4],
  [1, '16:00', '18:00', 5],
  [1, '16:30', '19:00', 6],
  [2, '09:00', '12:00', 2],
  [2, '10:00', '13:00', 3],
  [2, '11:00', '14:00', 0],
  [2, '17:00', '20:00', 1],
  [3, '07:00', '10:00', 5],
  [3, '08:00', '11:00', 4],
  [3, '12:00', '15:00', 2],
  [3, '16:00', '18:00', 3],
  [4, '07:00', '10:00', 6],
  [4, '11:00', '13:00', 0],
  [4, '11:00', '14:00', 1],
  [4, '12:00', '14:00', 2],
  [4, '16:00', '19:00', 4, 'follow_up'],
  [5, '07:00', '12:00', 3],
  [5, '08:00', '11:00', 5, 'social'],
];

let seq = 0;
const stores = new Map<string, TeamShift[]>();

function power(startsAt: string, endsAt: string): number {
  const day = localYmd(new Date(startsAt));
  const dow = (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;
  if (dow > 4) return 0;
  const a = new Date(startsAt).getTime();
  const b = new Date(endsAt).getTime();
  let n = 0;
  for (const w of POWER_WINDOWS) {
    const ws = new Date(zoned(day, w.startTime)).getTime();
    const we = new Date(zoned(day, w.endTime)).getTime();
    n += Math.max(0, Math.min(b, we) - Math.max(a, ws)) / 60000;
  }
  return n;
}

function build(weekStart: string, scenario: string): TeamShift[] {
  if (scenario === 'empty') return [];
  const now = Date.now();
  const planned = PLAN.map(([dow, a, b, who, activity]) => {
    const day = addDays(weekStart, dow);
    const startsAt = zoned(day, a);
    const endsAt = zoned(day, b);
    const past = new Date(endsAt).getTime() < now;
    const hours = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000;
    return {
      id: `ts-${++seq}`,
      userId: `intern-${who}`,
      userName: NAMES[who][0],
      weekStart,
      activity: activity ?? 'dialing',
      startsAt,
      endsAt,
      hours,
      powerMinutes: power(startsAt, endsAt),
      status: past ? (who === 4 && dow === 0 ? 'missed' : 'completed') : 'scheduled',
      source: 'pick',
      ghlSyncStatus: 'synced',
      hasPendingRequest: false,
    } satisfies TeamShift;
  });
  if (weekStart === mondayOf(localYmd(new Date(now)))) {
    // One shift in progress right now, so "Refresh live numbers" has something to act on.
    const startMs = Math.floor(now / 1800000) * 1800000 - 1800000;
    const startsAt = new Date(startMs).toISOString();
    const endsAt = new Date(startMs + 2 * 3600000).toISOString();
    planned.push({
      id: `ts-${++seq}`,
      userId: 'intern-6',
      userName: NAMES[6][0],
      weekStart,
      activity: 'dialing',
      startsAt,
      endsAt,
      hours: 2,
      powerMinutes: 0,
      status: 'scheduled',
      source: 'pick',
      ghlSyncStatus: 'synced',
      hasPendingRequest: false,
    });
  }
  return planned;
}

function shiftsFor(weekStart: string, scenario: string): TeamShift[] {
  const key = `${scenario === 'empty' ? 'empty' : 'plan'}|${weekStart}`;
  let list = stores.get(key);
  if (!list) {
    list = build(weekStart, scenario);
    stores.set(key, list);
  }
  return list;
}

function kpiFor(s: TeamShift, i: number): ShiftKpi {
  const sched = Math.round(s.hours * 60);
  const flagged = i % 5 === 2;
  const active = Math.round(sched * (flagged ? 0.55 : 0.88));
  const dials = Math.round((active / 60) * (flagged ? 22 : 38));
  return {
    shiftId: s.id,
    userId: s.userId,
    final: true,
    computedAt: s.endsAt,
    scheduledMinutes: sched,
    activeDialMinutes: active,
    powerActiveMinutes: Math.min(active, s.powerMinutes),
    adherencePct: Math.round((100 * active) / sched),
    firstDialAt: s.startsAt,
    lastCallEndAt: s.endsAt,
    lateStartMinutes: flagged ? 14 : 0,
    earlyEndMinutes: 0,
    longestIdleMinutes: flagged ? 26 : 8,
    dials,
    connects: Math.round(dials * 0.31),
    conversations: Math.round(dials * 0.12),
    voicemails: Math.round(dials * 0.2),
    noAnswers: Math.round(dials * 0.45),
    talkMinutes: Math.round(active * 0.22),
    dialsPerActiveHour: Math.round((dials / (active / 60)) * 10) / 10,
    connectRatePct: 31,
    dispositions: {},
    flags: flagged ? ['late_start', 'long_idle'] : [],
  };
}

function request(weekStart: string, who: number, over: Partial<ShiftRequest>): ShiftRequest {
  const mine = PLAN.map((_, i) => i).find((i) => PLAN[i][3] === who) ?? 0;
  const [dow, a, b] = PLAN[mine];
  const day = addDays(weekStart, dow);
  return {
    id: `rq-t-${who}-${over.type}`,
    userId: `intern-${who}`,
    userName: NAMES[who][0],
    weekStart,
    type: 'drop',
    fromShift: null,
    toStartsAt: null,
    toEndsAt: null,
    toActivity: null,
    requestedMinHours: null,
    reason: 'Exam moved to that afternoon so I need to free up time.',
    isLate: false,
    status: 'pending',
    reviewerName: null,
    reviewerNote: null,
    reviewedAt: null,
    createdAt: new Date(Date.now() - 3 * 3600000).toISOString(),
    hoursBefore: 8,
    hoursAfter: 5,
    ...over,
    ...(over.type === 'move' || over.type === 'add'
      ? { toStartsAt: zoned(day, a), toEndsAt: zoned(day, b) }
      : {}),
  };
}

export function buildAdminOverview(
  scenario: string,
  weekParam: string | null
): AdminShiftsOverview {
  const thisMonday = mondayOf(localYmd(new Date()));
  const weekStart = weekParam ?? thisMonday;
  const shifts = shiftsFor(weekStart, scenario);
  const commitments: (ShiftWeekCommitment & { userId: string })[] = MEMBERS.filter(
    (m) => m.participates && m.userId !== 'intern-7'
  ).map((m) => ({
    userId: m.userId,
    weekStart,
    submittedAt: new Date(Date.now() - 86400000).toISOString(),
    scheduledHours: shifts
      .filter((s) => s.userId === m.userId && s.status !== 'cancelled' && s.status !== 'excused')
      .reduce((n, s) => n + s.hours, 0),
    powerHours: 0,
    powerDialPct: null,
    powerWeek: false,
    lightWeek: false,
    minHoursOverride: null,
  }));
  const requests =
    scenario === 'empty'
      ? []
      : [
          request(weekStart, 1, {
            type: 'drop',
            isLate: true,
            hoursAfter: 5.5,
            fromShift: shifts.find((x) => x.userId === 'intern-1') ?? null,
          }),
          request(weekStart, 3, {
            type: 'move',
            hoursAfter: 9,
            fromShift: shifts.find((x) => x.userId === 'intern-3') ?? null,
          }),
          request(weekStart, 4, { type: 'light_week', requestedMinHours: 5, hoursAfter: 8 }),
        ];
  const kpis =
    scenario === 'empty'
      ? []
      : shifts.filter((s) => s.status === 'completed' && s.activity === 'dialing').map(kpiFor);
  const rollup: AdminShiftRollupRow[] = MEMBERS.filter((m) => m.participates).map((m) => {
    const mine = shifts.filter((s) => s.userId === m.userId && s.status !== 'cancelled');
    const k = kpis.filter((x) => x.userId === m.userId);
    const dialing = k.reduce((n, x) => n + x.activeDialMinutes, 0);
    return {
      userId: m.userId,
      name: m.name,
      hoursScheduled: mine.reduce((n, s) => n + s.hours, 0),
      hoursDialing: dialing / 60,
      powerDialPct: dialing
        ? Math.round((100 * k.reduce((n, x) => n + x.powerActiveMinutes, 0)) / dialing)
        : null,
      dials: k.reduce((n, x) => n + x.dials, 0),
      conversations: k.reduce((n, x) => n + x.conversations, 0),
      missedShifts: mine.filter((s) => s.status === 'missed').length,
      powerWeek: m.userId === 'intern-0' && weekStart < thisMonday,
    };
  });
  const thisW = weekStart === thisMonday;
  return {
    week: {
      weekStart,
      timezone: TZ,
      deadlineAt: zoned(addDays(weekStart, -1), '18:00'),
      deadlinePassed: new Date(zoned(addDays(weekStart, -1), '18:00')).getTime() < Date.now(),
      isCurrentWeek: thisW,
      isNextWeek: weekStart === addDays(thisMonday, 7),
      minHours: SETTINGS.minWeeklyHours,
    },
    settings: SETTINGS,
    openHours: OPEN_HOURS,
    powerWindows: POWER_WINDOWS,
    members: MEMBERS,
    shifts,
    commitments,
    requests,
    kpis,
    rollup,
    powerWeekCallouts:
      weekStart < thisMonday && scenario !== 'empty'
        ? [
            {
              userId: 'intern-0',
              sentence: 'Sara K. dialed 10.0 hrs this week, all in power windows.',
            },
          ]
        : [],
    syncHealth: { errorCount: 0, lastError: null, rows: [] },
  };
}

/** Applies an admin-shift-update to the in-memory store; returns the touched shift. */
export function applyAdminUpdate(
  scenario: string,
  body: AdminShiftUpdateInput
): { error?: { status: number; body: Record<string, unknown> }; shift?: Shift } {
  if (scenario === 'update_overlap' && (body.action === 'move' || body.action === 'create')) {
    return {
      error: {
        status: 422,
        body: { error: 'overlap', message: 'Those times overlap another shift.' },
      },
    };
  }
  const weekStart = body.date ? mondayOf(body.date) : null;
  if (body.action === 'create' && weekStart && body.userId && body.start && body.end) {
    const idx = Number(body.userId.replace('intern-', ''));
    const startsAt = zoned(body.date!, body.start);
    const endsAt = zoned(body.date!, body.end);
    const s: TeamShift = {
      id: `ts-${++seq}`,
      userId: body.userId,
      userName: NAMES[idx]?.[0] ?? 'Intern',
      weekStart,
      activity: body.activity ?? 'dialing',
      startsAt,
      endsAt,
      hours: (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000,
      powerMinutes: power(startsAt, endsAt),
      status: 'scheduled',
      source: 'admin',
      ghlSyncStatus: 'pending',
      hasPendingRequest: false,
    };
    for (const [k, list] of stores) if (k.endsWith(`|${weekStart}`)) list.push(s);
    return { shift: s };
  }
  for (const list of stores.values()) {
    const s = list.find((x) => x.id === body.shiftId);
    if (!s) continue;
    if (body.action === 'cancel') s.status = 'cancelled';
    else if (body.action === 'excuse') s.status = 'excused';
    else if (body.action === 'move' && body.date && body.start && body.end) {
      s.startsAt = zoned(body.date, body.start);
      s.endsAt = zoned(body.date, body.end);
      s.hours = (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime()) / 3600000;
      s.powerMinutes = power(s.startsAt, s.endsAt);
      s.activity = body.activity ?? s.activity;
      s.source = 'admin';
    }
    return { shift: s };
  }
  return { error: { status: 404, body: { error: 'not_found', message: 'No such shift.' } } };
}

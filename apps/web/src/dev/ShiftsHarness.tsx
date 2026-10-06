import { useState } from 'react';
import { supabase } from '@/lib/supabase';
import { Shifts } from '../components/Shifts';
import { TeamShifts } from '../components/TeamShifts';
import { applyAdminUpdate, buildAdminOverview } from './ShiftsTeamFixtures';
import { Toaster } from '@/components/ui/sonner';
import type {
  Shift,
  ShiftBlockInput,
  ShiftKpi,
  ShiftRequest,
  ShiftRosterEntry,
  ShiftsWeekResponse,
  ShiftSettings,
} from '@/lib/api';

/**
 * TASK-F01: the intern Shifts screen against fixture data -- no live network/DB (the backend is
 * built in parallel). Same stubbing approach as BillingHarness: window.fetch for the shifts-*
 * functions, supabase.auth/from for getActiveOrgId. `?dev_shifts=1&scenario=<name>`:
 *   default          this week + next week submitted, roster overlaps, KPIs w/ flags, requests
 *   unsubmitted      next week not submitted, deadline open (banner + Pick tab)
 *   under_minimum    this week 6 hrs against an 8 hr minimum
 *   deadline_passed  next week not submitted, deadline closed (request mode)
 *   power_week       this week earned a Power week + history
 *   empty            no shifts, no requests
 *   disabled         409 shifts_disabled
 *   error            500
 *   slow             2.5s latency (skeleton)
 * Later tasks (F02-F06) extend this file with picker/team fixtures.
 */
export const TZ = 'America/Chicago';
const ME = 'dev-me';
const FIXTURE_ORG_ID = 'dev-fixture-org';

function dtfParts(d: Date, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    hourCycle: 'h23',
    ...opts,
  }).formatToParts(d);
}
export function localYmd(d: Date): string {
  const p = dtfParts(d, { year: 'numeric', month: '2-digit', day: '2-digit' });
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}
export function addDays(ymd: string, n: number): string {
  return new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);
}
export function mondayOf(ymd: string): string {
  const dow = (new Date(`${ymd}T12:00:00Z`).getUTCDay() + 6) % 7; // Mon=0
  return addDays(ymd, -dow);
}
/** Local date + HH:MM in TZ -> UTC ISO (per-date offset, so DST-correct). */
export function zoned(ymd: string, hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = ymd.split('-').map(Number);
  let utc = Date.UTC(y, mo - 1, d, h, m);
  for (let i = 0; i < 2; i++) {
    const p = dtfParts(new Date(utc), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    const g = (t: string) => Number(p.find((x) => x.type === t)!.value);
    const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
    utc += Date.UTC(y, mo - 1, d, h, m) - asUtc;
  }
  return new Date(utc).toISOString();
}

export const SETTINGS: ShiftSettings = {
  enabled: true,
  timezone: TZ,
  minWeeklyHours: 8,
  lockWeekday: 7,
  lockTime: '18:00',
  changeNoticeHours: 12,
  graceMinutes: 10,
  conversationMinSeconds: 60,
  idleFlagMinutes: 20,
  adherenceFlagPct: 75,
  openSessionTailMinutes: 5,
  powerCoverageAlert: 2,
  powerWeekPct: 80,
  ghlCalendarId: null,
  ghlOwnerUserId: null,
};
export const OPEN_HOURS = [1, 2, 3, 4, 5]
  .map((d) => ({ isoWeekday: d, openFrom: '07:00', openUntil: '21:00' }))
  .concat([{ isoWeekday: 6, openFrom: '07:00', openUntil: '12:00' }]);
export const POWER_WINDOWS = [
  {
    id: 'pw1',
    label: 'Morning',
    isoWeekdays: [1, 2, 3, 4, 5],
    startTime: '07:00',
    endTime: '10:00',
    active: true,
  },
  {
    id: 'pw2',
    label: 'Lunch',
    isoWeekdays: [1, 2, 3, 4, 5],
    startTime: '11:00',
    endTime: '14:00',
    active: true,
  },
  {
    id: 'pw3',
    label: 'After work',
    isoWeekdays: [1, 2, 3, 4, 5],
    startTime: '16:00',
    endTime: '18:00',
    active: true,
  },
];
const OTHERS = ['Sara K.', 'Omar B.', 'Priya N.', 'Liam T.', 'Maya R.'];

/** Set once the stubbed admin-shift-settings-update ran, so a 'disabled' scenario flips on. */
let adminEnabled = false;
let seq = 0;
/** Blocks last accepted by the stubbed shifts-submit-week, so the refetch after a submit shows them. */
let submittedBlocks: ShiftBlockInput[] | null = null;
function shift(
  weekStart: string,
  startsAt: string,
  endsAt: string,
  over: Partial<Shift> = {}
): Shift {
  const hours = (new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 3600000;
  return {
    id: `sh-${++seq}`,
    userId: ME,
    weekStart,
    activity: 'dialing',
    startsAt,
    endsAt,
    hours,
    powerMinutes: 0,
    status: 'scheduled',
    source: 'pick',
    ghlSyncStatus: 'synced',
    hasPendingRequest: false,
    ...over,
  };
}
const iso = (offsetMin: number) =>
  new Date(Math.floor(Date.now() / 1800000) * 1800000 + offsetMin * 60000).toISOString();

function kpi(s: Shift, over: Partial<ShiftKpi>): ShiftKpi {
  return {
    shiftId: s.id,
    userId: ME,
    final: true,
    computedAt: iso(0),
    scheduledMinutes: s.hours * 60,
    activeDialMinutes: 104,
    powerActiveMinutes: 60,
    adherencePct: 87,
    firstDialAt: s.startsAt,
    lastCallEndAt: s.endsAt,
    lateStartMinutes: 0,
    earlyEndMinutes: 0,
    longestIdleMinutes: 9,
    dials: 142,
    connects: 19,
    conversations: 7,
    voicemails: 40,
    noAnswers: 60,
    talkMinutes: 38,
    dialsPerActiveHour: 82,
    connectRatePct: 13.4,
    dispositions: {},
    flags: [],
    ...over,
  };
}

function buildWeek(scenario: string, weekStart: string): ShiftsWeekResponse {
  const thisMonday = mondayOf(localYmd(new Date()));
  const isCurrent = weekStart === thisMonday;
  const isNext = weekStart === addDays(thisMonday, 7);
  const deadlineAt = zoned(addDays(weekStart, -1), '18:00');
  const passedByScenario = scenario === 'deadline_passed';
  const deadlinePassed = isNext ? passedByScenario : new Date(deadlineAt).getTime() < Date.now();
  const minHours = 8;

  let myShifts: Shift[] = [];
  let kpis: ShiftKpi[] = [];
  const roster: ShiftRosterEntry[] = [];

  if (isCurrent && scenario !== 'empty') {
    const done = shift(weekStart, iso(-240), iso(-150), { status: 'completed', powerMinutes: 90 });
    const flagged = shift(weekStart, iso(-150 - 360), iso(-150 - 240), { status: 'completed' });
    const live = shift(weekStart, iso(-30), iso(90), { powerMinutes: 60 });
    const later = shift(weekStart, iso(300), iso(420), {
      powerMinutes: 120,
      hasPendingRequest: true,
    });
    const social = shift(weekStart, iso(1500), iso(1620), { activity: 'follow_up' });
    myShifts = scenario === 'under_minimum' ? [done, later] : [flagged, done, live, later, social];
    kpis = [
      kpi(done, {}),
      kpi(flagged, {
        adherencePct: 58,
        activeDialMinutes: 70,
        lateStartMinutes: 18,
        longestIdleMinutes: 26,
        dials: 71,
        connects: 6,
        conversations: 2,
        flags: ['late_start', 'long_idle', 'low_adherence'],
      }),
    ].filter((k) => myShifts.some((s) => s.id === k.shiftId));
    OTHERS.slice(0, 3).forEach((n, i) =>
      roster.push({
        userId: `u${i}`,
        name: n,
        activity: 'dialing',
        startsAt: live.startsAt,
        endsAt: live.endsAt,
        isMe: false,
      })
    );
    OTHERS.slice(1, 6).forEach((n, i) =>
      roster.push({
        userId: `v${i}`,
        name: n,
        activity: 'dialing',
        startsAt: later.startsAt,
        endsAt: later.endsAt,
        isMe: false,
      })
    );
  }
  if (isNext && scenario !== 'empty') {
    // Other interns across next week so the picker's headcounts/popovers have something to show.
    const plan: [number, string, string, number][] = [
      [1, '07:00', '10:00', 0],
      [1, '07:00', '09:00', 1],
      [1, '08:00', '11:00', 2],
      [1, '09:00', '12:00', 3],
      [2, '11:00', '14:00', 0],
      [2, '12:00', '15:00', 4],
      [3, '16:00', '18:00', 1],
      [3, '16:00', '19:00', 2],
      [3, '17:00', '20:00', 3],
      [4, '07:00', '10:00', 4],
      [4, '10:00', '13:00', 0],
      [5, '16:00', '18:00', 2],
      [6, '07:00', '12:00', 1],
      [0, '08:30', '11:30', 3],
      [0, '13:00', '17:00', 4],
    ];
    for (const [dow, a, b, who] of plan) {
      const day = addDays(weekStart, dow);
      roster.push({
        userId: `r${roster.length}`,
        name: OTHERS[who],
        activity: 'dialing',
        startsAt: zoned(day, a),
        endsAt: zoned(day, b),
        isMe: false,
      });
    }
  }
  if (isNext && submittedBlocks) {
    myShifts = submittedBlocks.map((b) =>
      shift(weekStart, zoned(b.date, b.start), zoned(b.date, b.end), { activity: b.activity })
    );
  } else if (
    isNext &&
    scenario !== 'unsubmitted' &&
    scenario !== 'deadline_passed' &&
    scenario !== 'empty'
  ) {
    const a = shift(
      weekStart,
      zoned(addDays(weekStart, 1), '07:00'),
      zoned(addDays(weekStart, 1), '10:00'),
      { powerMinutes: 180 }
    );
    const b = shift(
      weekStart,
      zoned(addDays(weekStart, 2), '12:30'),
      zoned(addDays(weekStart, 2), '14:00'),
      { powerMinutes: 90 }
    );
    const c = shift(
      weekStart,
      zoned(addDays(weekStart, 4), '16:00'),
      zoned(addDays(weekStart, 4), '19:00'),
      { powerMinutes: 120 }
    );
    myShifts = [a, b, c];
    OTHERS.slice(0, 2).forEach((n, i) =>
      roster.push({
        userId: `n${i}`,
        name: n,
        activity: 'dialing',
        startsAt: a.startsAt,
        endsAt: a.endsAt,
        isMe: false,
      })
    );
  }

  const scheduledHours = myShifts.reduce((n, s) => n + s.hours, 0);
  const submitted =
    (!(isNext && (scenario === 'unsubmitted' || scenario === 'deadline_passed')) ||
      (isNext && submittedBlocks !== null)) &&
    myShifts.length > 0;
  const powerWeek = scenario === 'power_week' && isCurrent;

  const completedReq: ShiftRequest = {
    id: 'rq-1',
    userId: ME,
    userName: 'Me',
    weekStart: thisMonday,
    type: 'move',
    fromShift: shift(thisMonday, iso(-3000), iso(-2880)),
    toStartsAt: iso(-2400),
    toEndsAt: iso(-2280),
    toActivity: 'dialing',
    requestedMinHours: null,
    reason: 'Class schedule changed so I need the afternoon instead.',
    isLate: false,
    status: 'approved',
    reviewerName: 'Henry P.',
    reviewerNote: 'Approved, thanks for the heads up.',
    reviewedAt: iso(-2700),
    createdAt: iso(-3300),
    hoursBefore: 9.5,
    hoursAfter: 9.5,
  };
  const pendingReq: ShiftRequest = {
    id: 'rq-2',
    userId: ME,
    userName: 'Me',
    weekStart: thisMonday,
    type: 'drop',
    fromShift: myShifts.find((s) => s.hasPendingRequest) ?? null,
    toStartsAt: null,
    toEndsAt: null,
    toActivity: null,
    requestedMinHours: null,
    reason: 'I have a dentist appointment that I could not move.',
    isLate: true,
    status: 'pending',
    reviewerName: null,
    reviewerNote: null,
    reviewedAt: null,
    createdAt: iso(-90),
    hoursBefore: 9.5,
    hoursAfter: 7.5,
  };
  const deniedReq: ShiftRequest = {
    id: 'rq-3',
    userId: ME,
    userName: 'Me',
    weekStart: thisMonday,
    type: 'light_week',
    fromShift: null,
    toStartsAt: null,
    toEndsAt: null,
    toActivity: null,
    requestedMinHours: 4,
    reason: 'Midterms this week, I can only manage half my usual hours.',
    isLate: false,
    status: 'denied',
    reviewerName: 'Henry P.',
    reviewerNote: 'We need full coverage this week. Talk to me Monday.',
    reviewedAt: iso(-8000),
    createdAt: iso(-9000),
    hoursBefore: 8,
    hoursAfter: 8,
  };
  const myRequests = scenario === 'empty' ? [] : [pendingReq, completedReq, deniedReq];

  return {
    role: 'agent',
    week: {
      weekStart,
      timezone: TZ,
      deadlineAt,
      deadlinePassed,
      isCurrentWeek: isCurrent,
      isNextWeek: isNext,
      minHours,
    },
    settings: SETTINGS,
    openHours: OPEN_HOURS,
    powerWindows: POWER_WINDOWS,
    roster,
    myShifts,
    commitment: submitted
      ? {
          weekStart,
          submittedAt: iso(-5000),
          scheduledHours,
          powerHours: myShifts.reduce((n, s) => n + s.powerMinutes, 0) / 60,
          powerDialPct: isCurrent ? (powerWeek ? 100 : 82) : null,
          powerWeek,
          lightWeek: false,
          minHoursOverride: null,
        }
      : null,
    kpis,
    myRequests: isCurrent ? myRequests : [],
    powerWeekHistory:
      scenario === 'power_week' && isCurrent
        ? [
            {
              weekStart: addDays(thisMonday, -7),
              sentence: 'Dev M. dialed 10.0 hrs this week, all in power windows.',
            },
            {
              weekStart: addDays(thisMonday, -21),
              sentence: 'Dev M. dialed 8.5 hrs this week, 88% in power windows.',
            },
          ]
        : [],
    liveShift: null,
  };
}

function useShiftsFixtureStubs(scenario: string) {
  const [restore] = useState<() => void>(() => {
    const originalFetch = window.fetch;
    const authAny = supabase.auth as unknown as Record<string, unknown>;
    const originalGetSession = authAny.getSession;
    const originalGetUser = authAny.getUser;
    const supabaseAny = supabase as unknown as Record<string, unknown>;
    const originalFrom = supabaseAny.from;
    authAny.getSession = async () => ({
      data: { session: { access_token: 'dev-fixture-token' } },
      error: null,
    });
    authAny.getUser = async () => ({ data: { user: { id: ME } }, error: null });
    supabaseAny.from = (table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: { active_org_id: FIXTURE_ORG_ID }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`ShiftsHarness fake supabase: unexpected table ${table}`);
    };
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
    window.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url), window.location.origin);
      if (!u.pathname.includes('/functions/v1/') && !/\/(shifts?|admin)-/.test(u.pathname))
        return originalFetch(url as RequestInfo, init);
      if (scenario === 'slow') await new Promise((r) => setTimeout(r, 2500));
      if (
        scenario === 'disabled' &&
        !adminEnabled &&
        !u.pathname.endsWith('/admin-shift-settings-update')
      )
        return json(409, {
          error: 'shifts_disabled',
          message: 'Shifts is not enabled for this organization.',
        });
      if (scenario === 'error')
        return json(500, {
          error: 'internal',
          message: 'The shifts service is unavailable. Try again in a moment.',
        });
      if (u.pathname.endsWith('/admin-shifts-overview')) {
        return json(200, buildAdminOverview(scenario, u.searchParams.get('week')));
      }
      if (u.pathname.endsWith('/admin-shift-settings-update')) {
        adminEnabled = true;
        await new Promise((r) => setTimeout(r, 500));
        return json(200, { settings: { ...SETTINGS, enabled: true } });
      }
      if (u.pathname.endsWith('/admin-shift-update')) {
        await new Promise((r) => setTimeout(r, 500));
        const out = applyAdminUpdate(scenario, JSON.parse(String(init?.body ?? '{}')));
        return out.error ? json(out.error.status, out.error.body) : json(200, { shift: out.shift });
      }
      if (u.pathname.endsWith('/shifts-week-get')) {
        const week = u.searchParams.get('week') ?? mondayOf(localYmd(new Date()));
        return json(200, buildWeek(scenario, week));
      }
      if (u.pathname.endsWith('/shifts-submit-week')) {
        const { weekStart, blocks } = JSON.parse(String(init?.body ?? '{}')) as {
          weekStart: string;
          blocks: ShiftBlockInput[];
        };
        await new Promise((r) => setTimeout(r, 600));
        if (scenario === 'submit_deadline')
          return json(409, { error: 'deadline_passed', message: 'The pick deadline has passed.' });
        if (scenario === 'submit_badblock')
          return json(422, { error: 'bad_block', message: 'Block 0 is invalid.', index: 0 });
        if (scenario === 'submit_overlap')
          return json(422, {
            error: 'overlap',
            message: 'Overlap.',
            index: Math.min(1, blocks.length - 1),
          });
        if (scenario === 'submit_500')
          return json(500, {
            error: 'internal',
            message: 'The shifts service is unavailable. Try again in a moment.',
          });
        const hours = blocks.reduce(
          (n, b) =>
            n +
            (Number(b.end.slice(0, 2)) * 60 +
              Number(b.end.slice(3)) -
              Number(b.start.slice(0, 2)) * 60 -
              Number(b.start.slice(3))) /
              60,
          0
        );
        if (hours < 8)
          return json(422, {
            error: 'under_minimum',
            message: `You picked ${hours} hours, the minimum is 8.`,
            hours,
            minimum: 8,
          });
        submittedBlocks = blocks;
        return json(200, {
          shifts: [],
          commitment: {
            weekStart,
            submittedAt: new Date().toISOString(),
            scheduledHours: hours,
            powerHours: 0,
            powerDialPct: null,
            powerWeek: false,
            lightWeek: false,
            minHoursOverride: null,
          },
        });
      }
      if (u.pathname.endsWith('/shift-requests-create')) {
        const body = JSON.parse(String(init?.body ?? '{}')) as { type: string; reason: string };
        await new Promise((r) => setTimeout(r, 600));
        if (scenario === 'request_pending')
          return json(409, { error: 'request_pending', message: 'Already pending.' });
        if (scenario === 'request_started')
          return json(409, { error: 'shift_started', message: 'Started.' });
        if (scenario === 'request_500')
          return json(500, { error: 'server_error', message: 'Something went wrong. Try again.' });
        const base = buildWeek(scenario, mondayOf(localYmd(new Date()))).myRequests[0];
        return json(200, {
          request: {
            ...base,
            id: 'req-new',
            type: body.type,
            reason: body.reason,
            status: 'pending',
          },
        });
      }
      if (u.pathname.endsWith('/shift-requests-withdraw')) {
        const { requestId } = JSON.parse(String(init?.body ?? '{}'));
        if (scenario === 'withdraw_error')
          return json(409, { error: 'not_found', message: 'That request was already decided.' });
        const base = buildWeek(scenario, mondayOf(localYmd(new Date()))).myRequests.find(
          (r) => r.id === requestId
        );
        return json(200, { request: { ...base, status: 'withdrawn' } });
      }
      return json(404, { error: 'not_found', message: `Harness has no fixture for ${u.pathname}` });
    }) as typeof fetch;
    return () => {
      window.fetch = originalFetch;
      authAny.getSession = originalGetSession;
      authAny.getUser = originalGetUser;
      supabaseAny.from = originalFrom;
    };
  });
  return restore;
}

const SCENARIOS = [
  'default',
  'unsubmitted',
  'under_minimum',
  'deadline_passed',
  'power_week',
  'empty',
  'disabled',
  'error',
  'slow',
  'withdraw_error',
  'submit_deadline',
  'submit_badblock',
  'submit_overlap',
  'submit_500',
  'request_pending',
  'request_started',
  'request_500',
  'update_overlap',
];

export function ShiftsHarness() {
  const params = new URLSearchParams(window.location.search);
  const scenario = params.get('scenario') ?? 'default';
  const team = params.get('view') === 'team';
  useShiftsFixtureStubs(scenario);
  return (
    <div className="min-h-screen bg-surface-0 font-sans text-text-primary">
      <nav
        aria-label="Scenarios"
        className="flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-1 px-4 py-2 text-xs"
      >
        <span className="text-text-muted">Shifts harness (fixtures):</span>
        <a
          href={`?dev_shifts=1&view=${team ? 'intern' : 'team'}&scenario=${scenario}`}
          className="rounded-full border border-border-subtle px-2 py-0.5 text-text-primary"
        >
          {team ? 'Team view' : 'Intern view'} (switch)
        </a>
        {SCENARIOS.map((s) => (
          <a
            key={s}
            href={`?dev_shifts=1${team ? '&view=team' : ''}&scenario=${s}`}
            className={`rounded-full px-2 py-0.5 ${s === scenario ? 'bg-accent-to/15 text-accent-to' : 'text-text-secondary hover:text-text-primary'}`}
          >
            {s}
          </a>
        ))}
      </nav>
      {team ? <TeamShifts canEnable /> : <Shifts />}
      <Toaster theme="dark" position="bottom-right" />
    </div>
  );
}

import { assertEquals, assertStrictEquals } from 'jsr:@std/assert@1';
import {
  addDaysYmd,
  buildWeekInfo,
  currentWeekStart,
  hoursAfterRequest,
  isoWeekdayOfYmd,
  localYmd,
  mapCommitment,
  mapRequest,
  mapRosterEntry,
  mapSettings,
  mapShift,
  mondayOfYmd,
  parseCreateRequestBody,
  parseShiftRpcError,
  parseSubmitBody,
  parseWeekParam,
  pickLiveShift,
  powerWeekSentence,
  shiftErrorBody,
  shiftErrorStatus,
  weekDeadlineMs,
  zonedToUtcMs,
  type RequestRow,
  type ShiftRow,
  type ShiftSettingsRow,
} from './shifts-core.ts';

const TZ = 'America/Chicago';
const iso = (ms: number) => new Date(ms).toISOString();

Deno.test('zonedToUtcMs: a 07:00 pick stays 07:00 local across the Nov 1 2026 DST change', () => {
  assertEquals(iso(zonedToUtcMs('2026-10-26', '07:00', TZ)), '2026-10-26T12:00:00.000Z'); // CDT
  assertEquals(iso(zonedToUtcMs('2026-11-02', '07:00', TZ)), '2026-11-02T13:00:00.000Z'); // CST
  assertEquals(iso(zonedToUtcMs('2026-11-01', '12:00', TZ)), '2026-11-01T18:00:00.000Z'); // CST, change day
});

Deno.test(
  'zonedToUtcMs: the spring-forward day resolves each wall clock to its real offset',
  () => {
    assertEquals(iso(zonedToUtcMs('2027-03-14', '01:00', TZ)), '2027-03-14T07:00:00.000Z'); // CST
    assertEquals(iso(zonedToUtcMs('2027-03-14', '07:00', TZ)), '2027-03-14T12:00:00.000Z'); // CDT
  }
);

Deno.test('weekDeadlineMs: Sunday 18:00 CT before the week (CDT and CST)', () => {
  assertEquals(iso(weekDeadlineMs('2026-10-12', 7, '18:00:00', TZ)), '2026-10-11T23:00:00.000Z');
  assertEquals(iso(weekDeadlineMs('2026-11-02', 7, '18:00:00', TZ)), '2026-11-02T00:00:00.000Z');
  // another lock weekday: Friday (5) of the preceding week
  assertEquals(iso(weekDeadlineMs('2026-10-12', 5, '12:00', TZ)), '2026-10-09T17:00:00.000Z');
});

Deno.test(
  'week math: Monday of a date, local date of an instant, current week around midnight',
  () => {
    assertEquals(mondayOfYmd('2026-10-13'), '2026-10-12');
    assertEquals(mondayOfYmd('2026-10-12'), '2026-10-12');
    assertEquals(mondayOfYmd('2026-10-18'), '2026-10-12'); // Sunday belongs to the week that started Monday
    assertEquals(isoWeekdayOfYmd('2026-10-18'), 7);
    assertEquals(addDaysYmd('2026-10-28', 7), '2026-11-04');
    // Sunday 23:30 CDT (= Monday 04:30Z) is still the old week locally; 00:30 local Monday is the new week
    const sun2330 = Date.parse('2026-10-19T04:30:00Z');
    assertEquals(localYmd(sun2330, TZ), '2026-10-18');
    assertEquals(currentWeekStart(sun2330, TZ), '2026-10-12');
    assertEquals(currentWeekStart(Date.parse('2026-10-19T05:30:00Z'), TZ), '2026-10-19');
  }
);

const settings: ShiftSettingsRow = {
  org_id: 'o',
  enabled: true,
  timezone: TZ,
  min_weekly_hours: '8.00',
  lock_weekday: 7,
  lock_time: '18:00:00',
  change_notice_hours: 12,
  grace_minutes: 10,
  conversation_min_seconds: 60,
  idle_flag_minutes: 20,
  adherence_flag_pct: 75,
  open_session_tail_minutes: 5,
  power_coverage_alert: 2,
  power_week_pct: 80,
  ghl_calendar_id: null,
  ghl_owner_user_id: null,
};

Deno.test('mapSettings: camelCase, HH:MM, numeric strings become numbers', () => {
  const s = mapSettings(settings);
  assertEquals(s.minWeeklyHours, 8);
  assertEquals(s.lockTime, '18:00');
  assertEquals(s.ghlCalendarId, null);
  const withGhl = mapSettings(
    { ...settings, ghl_calendar_id: 'cal1', ghl_owner_user_id: 'own1' },
    true
  );
  assertEquals([withGhl.ghlCalendarId, withGhl.ghlOwnerUserId], ['cal1', 'own1']);
  const intern = mapSettings({ ...settings, ghl_calendar_id: 'cal1', ghl_owner_user_id: 'own1' });
  assertEquals([intern.ghlCalendarId, intern.ghlOwnerUserId], [null, null]);
  assertEquals(Object.keys(s).length, 15);
});

Deno.test(
  'buildWeekInfo: next week open before Sunday 18:00, closed after; light-week override wins',
  () => {
    const tue = Date.parse('2026-10-06T17:00:00Z'); // Tue Oct 6, noon CDT
    const next = buildWeekInfo('2026-10-12', settings, null, tue);
    assertEquals(next.isNextWeek, true);
    assertEquals(next.isCurrentWeek, false);
    assertEquals(next.deadlinePassed, false);
    assertEquals(next.deadlineAt, '2026-10-11T23:00:00.000Z');
    assertEquals(next.minHours, 8);
    const sunNight = Date.parse('2026-10-12T00:00:00Z'); // Sun 19:00 CDT, past 18:00
    assertEquals(buildWeekInfo('2026-10-12', settings, null, sunNight).deadlinePassed, true);
    const cur = buildWeekInfo('2026-10-05', settings, { min_hours_override: '5.50' }, tue);
    assertEquals(cur.isCurrentWeek, true);
    assertEquals(cur.deadlinePassed, true);
    assertEquals(cur.minHours, 5.5);
  }
);

const shiftRow = (over: Partial<ShiftRow> = {}): ShiftRow => ({
  id: 's1',
  user_id: 'u1',
  week_start: '2026-10-12',
  activity: 'dialing',
  starts_at: '2026-10-13T12:00:00+00:00',
  ends_at: '2026-10-13T15:00:00+00:00',
  hours: '3.00',
  power_minutes: 180,
  status: 'scheduled',
  source: 'pick',
  ghl_sync_status: 'pending',
  ...over,
});

Deno.test('mapShift / mapCommitment / mapRosterEntry keys and values', () => {
  const s = mapShift(shiftRow(), new Set(['s1']));
  assertEquals(s.hours, 3);
  assertEquals(s.hasPendingRequest, true);
  assertEquals(Object.keys(s).sort(), [
    'activity',
    'endsAt',
    'ghlSyncStatus',
    'hasPendingRequest',
    'hours',
    'id',
    'powerMinutes',
    'source',
    'startsAt',
    'status',
    'userId',
    'weekStart',
  ]);
  assertEquals(mapShift(shiftRow()).hasPendingRequest, false);
  assertEquals(s.startsAt, '2026-10-13T12:00:00.000Z'); // '+00:00' and offset forms normalise to Z
  assertEquals(
    mapShift(shiftRow({ starts_at: '2026-10-13T07:00:00-05:00' })).startsAt,
    '2026-10-13T12:00:00.000Z'
  );
  const c = mapCommitment({
    week_start: '2026-10-12',
    submitted_at: null,
    scheduled_hours: '9.50',
    power_hours: '6.00',
    power_dial_pct: null,
    power_week: false,
    light_week: true,
    min_hours_override: '5.00',
  });
  assertEquals(c, {
    weekStart: '2026-10-12',
    submittedAt: null,
    scheduledHours: 9.5,
    powerHours: 6,
    powerDialPct: null,
    powerWeek: false,
    lightWeek: true,
    minHoursOverride: 5,
  });
  const r = mapRosterEntry(
    {
      user_id: 'u1',
      name: 'Sara K.',
      activity: 'dialing',
      starts_at: '2026-10-13T12:00:00Z',
      ends_at: '2026-10-13T13:00:00Z',
    },
    'u1'
  );
  assertEquals(r.isMe, true);
  assertEquals(
    mapRosterEntry(
      {
        user_id: 'u2',
        name: 'Omar B.',
        activity: 'social',
        starts_at: '2026-10-13T12:00:00Z',
        ends_at: '2026-10-13T13:00:00Z',
      },
      'u1'
    ).isMe,
    false
  );
});

const reqRow = (over: Partial<RequestRow> = {}): RequestRow => ({
  id: 'r1',
  user_id: 'u1',
  week_start: '2026-10-12',
  type: 'drop',
  from_shift_id: 's1',
  to_starts_at: null,
  to_ends_at: null,
  to_activity: null,
  requested_min_hours: null,
  reason: 'a reason that is long enough',
  is_late: false,
  status: 'pending',
  reviewer_id: null,
  reviewer_note: null,
  reviewed_at: null,
  created_at: '2026-10-06T12:00:00Z',
  ...over,
});

Deno.test('hoursAfterRequest: drop, move, add, light_week', () => {
  const from = { hours: 3 };
  assertEquals(hoursAfterRequest(reqRow({ type: 'drop' }), from, 9.5), 6.5);
  assertEquals(
    hoursAfterRequest(
      reqRow({
        type: 'move',
        to_starts_at: '2026-10-14T15:00:00Z',
        to_ends_at: '2026-10-14T17:00:00Z',
      }),
      from,
      9.5
    ),
    8.5
  );
  assertEquals(
    hoursAfterRequest(
      reqRow({
        type: 'add',
        from_shift_id: null,
        to_starts_at: '2026-10-14T15:00:00Z',
        to_ends_at: '2026-10-14T16:30:00Z',
      }),
      null,
      8
    ),
    9.5
  );
  assertEquals(hoursAfterRequest(reqRow({ type: 'light_week', from_shift_id: null }), null, 4), 4);
  assertEquals(hoursAfterRequest(reqRow({ type: 'drop' }), from, 2), 0); // never negative
});

Deno.test('mapRequest: full DTO incl. fromShift, names and hours', () => {
  const m = mapRequest(reqRow(), {
    userName: 'Sara Kim',
    reviewerName: null,
    fromShift: shiftRow(),
    hoursBefore: 9.5,
    weekMinimum: 7,
  });
  assertEquals(m.weekMinimum, 7);
  assertEquals(m.userName, 'Sara Kim');
  assertEquals(m.hoursBefore, 9.5);
  assertEquals(m.hoursAfter, 6.5);
  assertEquals(m.fromShift?.id, 's1');
  assertEquals(m.reviewerName, null);
  assertEquals(Object.keys(m).length, 20);
});

Deno.test('powerWeekSentence: "all" at 100%, rounded percent otherwise', () => {
  assertStrictEquals(
    powerWeekSentence('Sara K.', 600, 100),
    'Sara K. dialed 10.0 hrs this week, all in power windows.'
  );
  assertStrictEquals(
    powerWeekSentence('Omar B.', 510, 88.4),
    'Omar B. dialed 8.5 hrs this week, 88% in power windows.'
  );
});

Deno.test('pickLiveShift: in progress or starting within 15 minutes, scheduled only', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  const mk = (s: string, e: string, status = 'scheduled') =>
    shiftRow({ starts_at: s, ends_at: e, status });
  assertEquals(pickLiveShift([mk('2026-10-13T11:00:00Z', '2026-10-13T13:00:00Z')], now)?.id, 's1'); // in progress
  assertEquals(pickLiveShift([mk('2026-10-13T12:14:00Z', '2026-10-13T14:00:00Z')], now)?.id, 's1'); // starts in 14 min
  assertEquals(pickLiveShift([mk('2026-10-13T12:16:00Z', '2026-10-13T14:00:00Z')], now), null); // 16 min away
  assertEquals(pickLiveShift([mk('2026-10-13T10:00:00Z', '2026-10-13T12:00:00Z')], now), null); // just ended
  assertEquals(
    pickLiveShift([mk('2026-10-13T11:00:00Z', '2026-10-13T13:00:00Z', 'cancelled')], now),
    null
  );
});

Deno.test('error mapping: statuses, sentences, details spread, rpc error parsing', () => {
  assertEquals(shiftErrorStatus('unauthorized'), 401);
  assertEquals(shiftErrorStatus('forbidden'), 403);
  assertEquals(shiftErrorStatus('shifts_disabled'), 409);
  assertEquals(shiftErrorStatus('deadline_passed'), 409);
  assertEquals(shiftErrorStatus('bad_block'), 422);
  assertEquals(shiftErrorStatus('overlap'), 422);
  assertEquals(shiftErrorStatus('under_minimum'), 422);
  assertEquals(shiftErrorStatus('shift_started'), 409);
  assertEquals(shiftErrorStatus('request_pending'), 409);
  assertEquals(shiftErrorStatus('not_found'), 404);
  assertEquals(shiftErrorStatus('ghl_not_connected'), 409);
  assertEquals(shiftErrorStatus('something_else'), 500);
  const b = shiftErrorBody('under_minimum', { hours: 6, minimum: 8 });
  assertEquals(b, {
    error: 'under_minimum',
    message: 'You picked 6 hours, the minimum is 8 hours.',
    hours: 6,
    minimum: 8,
  });
  assertEquals(
    shiftErrorBody('under_minimum', { hours: 7.5, minimum: 8 }).message,
    'You picked 7.5 hours, the minimum is 8 hours.'
  );
  assertEquals(shiftErrorBody('bad_block', { index: 2, reason: 'bad_time_step' }).index, 2);
  assertEquals(
    parseShiftRpcError({
      code: 'P0001',
      message: 'under_minimum',
      details: '{"hours": 7.50, "minimum": 8.00}',
    }),
    { code: 'under_minimum', detail: { hours: 7.5, minimum: 8 } }
  );
  assertEquals(parseShiftRpcError({ code: 'P0001', message: 'shifts_disabled', details: '' }), {
    code: 'shifts_disabled',
    detail: {},
  });
  assertEquals(
    parseShiftRpcError({
      code: 'P0001',
      message: 'overlap',
      details: '{"reason": "x", "secret": "y"}',
    }),
    { code: 'overlap', detail: { reason: 'x' } }
  );
  assertEquals(parseShiftRpcError({ code: '23505', message: 'duplicate key' }), null);
  assertEquals(parseShiftRpcError({ code: 'P0001', message: 'some random exception' }), null);
  assertEquals(parseShiftRpcError(null), null);
});

Deno.test('parseWeekParam: empty = current week, Monday only', () => {
  assertEquals(parseWeekParam(null), { ok: true, value: null });
  assertEquals(parseWeekParam('2026-10-12'), { ok: true, value: '2026-10-12' });
  assertEquals(parseWeekParam('2026-10-13').ok, false);
  assertEquals(parseWeekParam('garbage').ok, false);
});

Deno.test(
  'parseSubmitBody: weekStart Monday, blocks well-formed, index of the first bad block',
  () => {
    const ok = parseSubmitBody({
      weekStart: '2026-10-12',
      blocks: [
        { date: '2026-10-13', start: '07:00', end: '10:00', activity: 'dialing' },
        { date: '2026-10-14', start: '12:30', end: '13:00' },
      ],
    });
    assertEquals(ok.ok, true);
    if (ok.ok) assertEquals(ok.value.blocks[1].activity, 'dialing');
    assertEquals(parseSubmitBody({ weekStart: '2026-10-13', blocks: [] }), {
      ok: false,
      code: 'bad_week',
      detail: {},
    });
    assertEquals(parseSubmitBody({ weekStart: '2026-10-12' }), {
      ok: false,
      code: 'bad_block',
      detail: { index: 0, reason: 'bad_format' },
    });
    assertEquals(
      parseSubmitBody({
        weekStart: '2026-10-12',
        blocks: [
          { date: '2026-10-13', start: '07:00', end: '10:00' },
          { date: '2026-10-14', start: '7am', end: '10:00' },
        ],
      }),
      { ok: false, code: 'bad_block', detail: { index: 1, reason: 'bad_format' } }
    );
    assertEquals(
      parseSubmitBody({
        weekStart: '2026-10-12',
        blocks: [{ date: '2026-10-13', start: '07:00', end: '10:00', activity: 'nap' }],
      }),
      { ok: false, code: 'bad_block', detail: { index: 0, reason: 'bad_activity' } }
    );
  }
);

Deno.test('parseCreateRequestBody: shape rules per type', () => {
  const id = '5b020000-0000-4000-8000-0000000000e1';
  const drop = parseCreateRequestBody({ type: 'drop', fromShiftId: id, reason: 'x'.repeat(20) });
  assertEquals(drop.ok, true);
  assertEquals(parseCreateRequestBody({ type: 'drop', reason: 'x'.repeat(20) }), {
    ok: false,
    code: 'bad_request',
    detail: { reason: 'missing_shift' },
  });
  assertEquals(parseCreateRequestBody({ type: 'swap', reason: 'x' }), {
    ok: false,
    code: 'bad_request',
    detail: { reason: 'bad_type' },
  });
  assertEquals(parseCreateRequestBody({ type: 'light_week', reason: 'x'.repeat(20) }), {
    ok: false,
    code: 'bad_request',
    detail: { reason: 'light_week_hours' },
  });
  const lw = parseCreateRequestBody({
    type: 'light_week',
    requestedMinHours: 5.5,
    reason: 'x'.repeat(20),
  });
  assertEquals(lw.ok && lw.value.requestedMinHours, 5.5);
  assertEquals(
    parseCreateRequestBody({
      type: 'add',
      date: '2026-10-14',
      start: '9:00',
      end: '10:00',
      reason: 'x'.repeat(20),
    }),
    { ok: false, code: 'bad_request', detail: { reason: 'bad_time' } }
  );
  assertEquals(
    parseCreateRequestBody({
      type: 'add',
      date: '2026-10-14',
      start: '09:00',
      end: '10:00',
      toActivity: 'sleep',
      reason: 'x'.repeat(20),
    }),
    { ok: false, code: 'bad_request', detail: { reason: 'bad_activity' } }
  );
  assertEquals(parseCreateRequestBody({ type: 'add', reason: 5 }), {
    ok: false,
    code: 'reason_too_short',
    detail: { minimum: 20, length: 0 },
  });
});

Deno.test('buildWeekInfo: beforeLaunch only when the pick deadline fell before enabled_at', () => {
  const tue = Date.parse('2026-10-06T15:00:00Z');
  const withEnabled = (enabled_at: string | null) => ({ ...settings, enabled_at });
  // week of Oct 12: deadline Sun Oct 11 18:00 CDT (23:00Z)
  assertEquals(
    buildWeekInfo('2026-10-12', withEnabled('2026-10-06T17:12:00Z'), null, tue).beforeLaunch,
    false
  );
  assertEquals(
    buildWeekInfo('2026-10-12', withEnabled('2026-10-12T01:00:00Z'), null, tue).beforeLaunch,
    true
  );
  // the current week (deadline Sun Oct 4) was before an Oct 6 launch
  assertEquals(
    buildWeekInfo('2026-10-05', withEnabled('2026-10-06T17:12:00Z'), null, tue).beforeLaunch,
    true
  );
  assertEquals(buildWeekInfo('2026-10-05', withEnabled(null), null, tue).beforeLaunch, false);
});

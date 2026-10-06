import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildCallouts,
  buildRollup,
  findContactsByEmail,
  mapAdminMember,
  parseAdminUpdateBody,
  parseEmailBody,
  parseMemberBody,
  parseOpenHoursBody,
  parsePowerWindowBody,
  parseRetryBody,
  parseReviewBody,
  parseSettingsPatch,
  sortDecidedRequests,
  surveySummary,
  syncHealth,
} from './shifts-admin.ts';
import { shiftErrorBody, shiftErrorStatus } from './shifts-core.ts';

const U1 = '5b030000-0000-4000-8000-0000000000a1';
const R1 = '5b030000-0000-4000-8000-0000000000f1';

const reason = (p: { ok: boolean } & Record<string, unknown>) =>
  p.ok ? null : (p.detail as { reason?: string }).reason;

Deno.test('review body: needs a uuid + approve/deny, trims the note, ack is strictly true', () => {
  assertEquals(parseReviewBody({ requestId: 'x', decision: 'approve' }).ok, false);
  assertEquals(parseReviewBody({ requestId: R1, decision: 'maybe' }).ok, false);
  const p = parseReviewBody({
    requestId: R1,
    decision: 'deny',
    note: '  too busy  ',
    allowUnderMinimum: 'yes',
  });
  assertEquals(p.ok && p.value, {
    requestId: R1,
    decision: 'deny',
    note: 'too busy',
    allowUnderMinimum: false,
  });
  const q = parseReviewBody({
    requestId: R1,
    decision: 'approve',
    note: '   ',
    allowUnderMinimum: true,
  });
  assertEquals(q.ok && q.value.note, null);
  assertEquals(q.ok && q.value.allowUnderMinimum, true);
});

Deno.test('admin update body: per-action required keys', () => {
  assertEquals(reason(parseAdminUpdateBody({ action: 'nope' })), 'bad_action');
  assertEquals(reason(parseAdminUpdateBody({ action: 'cancel' })), 'missing_shift');
  assertEquals(
    reason(
      parseAdminUpdateBody({ action: 'create', date: '2026-11-09', start: '09:00', end: '10:00' })
    ),
    'missing_user'
  );
  assertEquals(
    reason(
      parseAdminUpdateBody({ action: 'create', userId: U1, date: '2026-11-09', start: '09:00' })
    ),
    'missing_time'
  );
  assertEquals(
    reason(parseAdminUpdateBody({ action: 'move', shiftId: R1, start: '9:00' })),
    'bad_time'
  );
  assertEquals(
    reason(parseAdminUpdateBody({ action: 'move', shiftId: R1, activity: 'lunch' })),
    'bad_activity'
  );
  const ok = parseAdminUpdateBody({
    action: 'move',
    shiftId: R1,
    date: '2026-11-09',
    start: '09:00',
    end: '11:00',
    activity: 'social',
  });
  assertEquals(ok.ok && ok.value.activity, 'social');
  // excuse needs only a shift
  assertEquals(parseAdminUpdateBody({ action: 'excuse', shiftId: R1 }).ok, true);
});

Deno.test('power window / open hours bodies', () => {
  const w = {
    label: ' Morning ',
    isoWeekdays: [1, 2],
    startTime: '07:00',
    endTime: '10:00',
    active: false,
  };
  const p = parsePowerWindowBody(w);
  assertEquals(p.ok && p.value, {
    id: null,
    label: 'Morning',
    isoWeekdays: [1, 2],
    startTime: '07:00',
    endTime: '10:00',
    active: false,
  });
  assertEquals(reason(parsePowerWindowBody({ ...w, isoWeekdays: [] })), 'bad_weekdays');
  assertEquals(reason(parsePowerWindowBody({ ...w, isoWeekdays: [8] })), 'bad_weekdays');
  assertEquals(reason(parsePowerWindowBody({ ...w, endTime: '07:00' })), 'bad_time');
  assertEquals(reason(parsePowerWindowBody({ ...w, label: ' ' })), 'bad_label');
  assertEquals(reason(parsePowerWindowBody({ ...w, id: 'nope' })), 'bad_id');

  assertEquals(parseOpenHoursBody({ rows: [] }).ok, true); // everything closed is allowed
  assertEquals(
    reason(
      parseOpenHoursBody({ rows: [{ isoWeekday: 1, openFrom: '08:00', openUntil: '08:00' }] })
    ),
    'bad_rows'
  );
  assertEquals(
    reason(
      parseOpenHoursBody({
        rows: [
          { isoWeekday: 1, openFrom: '08:00', openUntil: '09:00' },
          { isoWeekday: 1, openFrom: '10:00', openUntil: '11:00' },
        ],
      })
    ),
    'bad_rows'
  );
  assertEquals(reason(parseOpenHoursBody({})), 'bad_rows');
});

Deno.test('settings patch: only known keys with the right JSON type; empty patch refused', () => {
  const p = parseSettingsPatch({
    minWeeklyHours: 6,
    ghlCalendarId: null,
    lockTime: '18:00',
    evil: 1,
    org_id: 'x',
  });
  assertEquals(p.ok && p.value, { minWeeklyHours: 6, ghlCalendarId: null, lockTime: '18:00' });
  assertEquals(reason(parseSettingsPatch({ minWeeklyHours: '6' })), 'bad_setting');
  assertEquals(reason(parseSettingsPatch({ enabled: 1 })), 'bad_setting');
  assertEquals(reason(parseSettingsPatch({ lockTime: '6pm' })), 'bad_setting');
  assertEquals(reason(parseSettingsPatch({ timezone: '' })), 'bad_setting');
  assertEquals(reason(parseSettingsPatch({ evil: 1 })), 'bad_patch');
});

Deno.test('member / email / retry bodies', () => {
  assertEquals(reason(parseMemberBody({ userId: U1 })), 'bad_patch');
  assertEquals(reason(parseMemberBody({ userId: U1, participates: 'yes' })), 'bad_participates');
  const m = parseMemberBody({ userId: U1, ghlContactId: null });
  assertEquals(m.ok && m.value, {
    userId: U1,
    setContact: true,
    contact: null,
    setParticipates: false,
    participates: null,
  });
  const m2 = parseMemberBody({ userId: U1, participates: false });
  assertEquals(m2.ok && m2.value.setContact, false);

  const e = parseEmailBody({ email: '  Sara@Example.COM ' });
  assertEquals(e.ok && e.value, 'sara@example.com');
  assertEquals(parseEmailBody({ email: 'nope' }).ok, false);
  assertEquals(parseEmailBody({}).ok, false);

  assertEquals(parseRetryBody({}), { ok: true, value: null });
  assertEquals(parseRetryBody({ outboxId: 12 }), { ok: true, value: 12 });
  assertEquals(parseRetryBody({ outboxId: 0 }).ok, false);
  assertEquals(parseRetryBody({ outboxId: '12' }).ok, false);
});

Deno.test(
  'sync health counts error rows AND pending rows that carry an error (org not connected)',
  () => {
    const rows = [
      {
        id: 1,
        kind: 'contact_note',
        event: 'a',
        user_id: U1,
        status: 'error',
        last_error: 'boom',
        attempts: 6,
        created_at: '2026-10-06T17:00:00Z',
      },
      {
        id: 2,
        kind: 'contact_note',
        event: 'a',
        user_id: U1,
        status: 'pending',
        last_error: 'org has no connected GHL integration',
        attempts: 0,
        created_at: '2026-10-06T17:01:00Z',
      },
      {
        id: 3,
        kind: 'contact_note',
        event: 'a',
        user_id: U1,
        status: 'pending',
        last_error: null,
        attempts: 0,
        created_at: '2026-10-06T17:02:00Z',
      },
      {
        id: 4,
        kind: 'contact_note',
        event: 'a',
        user_id: null,
        status: 'done',
        last_error: null,
        attempts: 1,
        created_at: '2026-10-06T17:03:00Z',
      },
    ];
    const h = syncHealth(rows, new Map([[U1, 'Sara Kim']]), {
      pendingCount: 9,
      ghlConnected: false,
    });
    assertEquals(h.errorCount, 2);
    assertEquals(h.lastError, 'org has no connected GHL integration'); // newest first
    assertEquals(
      h.rows.map((r) => r.id),
      [2, 1]
    );
    assertEquals(h.rows[0].userName, 'Sara Kim');
    assertEquals(h.rows[0].createdAt, '2026-10-06T17:01:00.000Z');
    assertEquals(syncHealth([], new Map(), { pendingCount: 0, ghlConnected: true }), {
      errorCount: 0,
      pendingCount: 0,
      ghlConnected: true,
      lastError: null,
      rows: [],
    });
  }
);

Deno.test(
  'rollup: per participating member, sorted by name, no ranking; callouts only for power weeks',
  () => {
    const U2 = '5b030000-0000-4000-8000-0000000000a2';
    const commitments = [
      {
        user_id: U1,
        week_start: '2026-10-05',
        submitted_at: null,
        scheduled_hours: '10.00',
        power_hours: '8.00',
        power_dial_pct: '100.0',
        power_week: true,
        light_week: false,
        min_hours_override: null,
      },
      {
        user_id: U2,
        week_start: '2026-10-05',
        submitted_at: null,
        scheduled_hours: '8.50',
        power_hours: '4.00',
        power_dial_pct: '88.0',
        power_week: true,
        light_week: false,
        min_hours_override: null,
      },
    ];
    const kpis = [
      { user_id: U1, active_dial_minutes: 600, dials: 300, conversations: 20 },
      { user_id: U2, active_dial_minutes: 510, dials: 200, conversations: 9 },
      { user_id: U2, active_dial_minutes: 0, dials: 0, conversations: 0 },
    ];
    const roll = buildRollup({
      members: [
        { userId: U2, name: 'Omar Bello', participates: true },
        { userId: U1, name: 'Sara Kim', participates: true },
        { userId: 'm', name: 'Henry', participates: false },
      ],
      shifts: [
        { user_id: U1, status: 'completed', hours: 10 },
        { user_id: U2, status: 'completed', hours: 6 },
        { user_id: U2, status: 'missed', hours: 2.5 },
      ],
      commitments,
      kpis,
    });
    assertEquals(
      roll.map((r) => r.name),
      ['Omar Bello', 'Sara Kim']
    );
    assertEquals(roll[0], {
      userId: U2,
      name: 'Omar Bello',
      hoursScheduled: 8.5,
      hoursDialing: 8.5,
      powerDialPct: 88,
      dials: 200,
      conversations: 9,
      missedShifts: 1,
      powerWeek: true,
    });
    assertEquals(roll[1].hoursDialing, 10);

    const callouts = buildCallouts(
      commitments,
      kpis,
      new Map([
        [U1, 'Sara K.'],
        [U2, 'Omar B.'],
      ])
    );
    assertEquals(callouts, [
      { userId: U2, sentence: 'Omar B. dialed 8.5 hrs this week, 88% in power windows.' },
      { userId: U1, sentence: 'Sara K. dialed 10.0 hrs this week, all in power windows.' },
    ]);
    assertEquals(buildCallouts([{ ...commitments[0], power_week: false }], kpis, new Map()), []);
  }
);

Deno.test(
  'GHL contact search: pinned query args, exact case-insensitive email match, name fallback',
  async () => {
    const calls: unknown[] = [];
    const client = {
      searchContacts(args: unknown) {
        calls.push(args);
        return Promise.resolve({
          contacts: [
            { id: 'c1', firstName: 'Sara', lastName: 'Kim', email: 'Sara@Example.com' },
            { id: 'c2', email: 'sara@example.com.au' },
            { id: 'c3', email: 'sara@example.com' },
          ],
        });
      },
    };
    const found = await findContactsByEmail(client, 'loc1', 'sara@example.com');
    assertEquals(calls, [{ locationId: 'loc1', query: 'sara@example.com', limit: 10 }]);
    assertEquals(found, [
      { id: 'c1', name: 'Sara Kim', email: 'Sara@Example.com' },
      { id: 'c3', name: 'sara@example.com', email: 'sara@example.com' },
    ]);
  }
);

Deno.test('member DTO + new error codes', () => {
  assertEquals(
    mapAdminMember({
      user_id: U1,
      name: 'Sara Kim',
      email: null,
      role: 'agent',
      participates: true,
      ghl_contact_id: 'g1',
      pod_id: null,
      pod_name: null,
    }),
    {
      userId: U1,
      name: 'Sara Kim',
      email: '',
      role: 'agent',
      participates: true,
      ghlContactId: 'g1',
      podId: null,
      podName: null,
    }
  );
  assertEquals(shiftErrorStatus('ghl_error'), 502);
  assertEquals(shiftErrorStatus('under_minimum_needs_ack'), 409);
  assertEquals(
    shiftErrorBody('under_minimum_needs_ack', { hoursAfter: 4, minimum: 8 }).message,
    'Approving this leaves them at 4 hours, below the 8 hours minimum.'
  );
});

Deno.test(
  'sortDecidedRequests: withdrawn requests (no reviewed_at) sort by created_at, newest first',
  () => {
    const rows = [
      { id: 'denied', reviewed_at: '2026-10-06T15:00:00Z', created_at: '2026-10-06T10:00:00Z' },
      { id: 'withdrawn', reviewed_at: null, created_at: '2026-10-06T17:00:00Z' },
      { id: 'approved', reviewed_at: '2026-10-06T16:00:00Z', created_at: '2026-10-05T10:00:00Z' },
    ];
    assertEquals(
      sortDecidedRequests(rows).map((r) => r.id),
      ['withdrawn', 'approved', 'denied']
    );
  }
);

Deno.test(
  'surveySummary: counts every objection/slow-down key (zeros included) and averages list quality',
  () => {
    const empty = surveySummary([]);
    assertEquals(empty.responses, 0);
    assertEquals(empty.avgListQuality, null);
    assertEquals(Object.keys(empty.topObjections).length, 6);
    assertEquals(Object.keys(empty.slowedBy).length, 5);
    const s = surveySummary([
      { top_objection: 'fees', slowed_by: 'nothing', list_quality: 4 },
      { top_objection: 'fees', slowed_by: 'bad_numbers', list_quality: 3 },
      { top_objection: 'too_busy', slowed_by: 'nothing', list_quality: 5 },
    ]);
    assertEquals(s.responses, 3);
    assertEquals(s.topObjections.fees, 2);
    assertEquals(s.topObjections.too_busy, 1);
    assertEquals(s.topObjections.other, 0);
    assertEquals(s.slowedBy.nothing, 2);
    assertEquals(s.slowedBy.bad_numbers, 1);
    assertEquals(s.avgListQuality, 4);
  }
);

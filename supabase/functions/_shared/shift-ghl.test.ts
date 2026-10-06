import { assert, assertEquals, assertStringIncludes } from 'jsr:@std/assert@1';
import {
  buildCustomFields,
  createShiftGhlHttp,
  fetchContactFieldDefs,
  type FieldDef,
  GHL_APPT_VERSION,
  GHL_CONTACT_VERSION,
  offsetIso,
  type OutboxRow,
  type ProcessDeps,
  processOutbox,
  type RowResult,
  type ShiftForSync,
  ShiftGhlError,
  type ShiftGhlHttp,
  shiftTitle,
} from './shift-ghl.ts';

const TZ = 'America/Chicago';
const DEFS: FieldDef[] = [
  { id: 'f1', fieldKey: 'contact.shift_week_submitted', dataType: 'TEXT' },
  { id: 'f2', fieldKey: 'contact.shifts_missed_total', dataType: 'NUMERICAL' },
  { id: 'f3', fieldKey: 'contact.shift_next_shift_at', dataType: 'DATE' },
];

interface Call {
  method: string;
  path: string;
  version: string;
  body?: unknown;
}

function fakeHttp(handler: (c: Call) => Record<string, unknown> | ShiftGhlError = () => ({})): {
  http: ShiftGhlHttp;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    http: {
      request(method, path, version, body) {
        const c = { method, path, version, body };
        calls.push(c);
        const r = handler(c);
        if (r instanceof ShiftGhlError) return Promise.reject(r);
        return Promise.resolve(r);
      },
    },
  };
}

let nextId = 1;
function row(over: Partial<OutboxRow>): OutboxRow {
  return {
    id: nextId++,
    org_id: 'org',
    kind: 'contact_note',
    event: 'Week submitted',
    shift_id: null,
    user_id: 'u1',
    payload: {},
    attempts: 0,
    created_at: '2026-10-06T17:00:00Z',
    ...over,
  };
}

const SHIFT: ShiftForSync = {
  id: 's1',
  status: 'scheduled',
  activity: 'dialing',
  starts_at: '2026-10-13T19:00:00Z', // 2:00 PM CDT
  ends_at: '2026-10-13T21:00:00Z',
  ghl_appointment_id: null,
};

function deps(http: ShiftGhlHttp, over: Partial<ProcessDeps> = {}) {
  const recorded: RowResult[] = [];
  const d: ProcessDeps = {
    http,
    locationId: 'loc1',
    settings: { timezone: TZ, calendarId: 'cal1', ownerUserId: 'owner1' },
    contactIdFor: (u) => (u ? `c-${u}` : null),
    loadShift: () => Promise.resolve(SHIFT),
    loadFieldDefs: () => Promise.resolve(DEFS),
    record: (r) => {
      recorded.push(r);
      return Promise.resolve();
    },
    ...over,
  };
  return { d, recorded };
}

Deno.test('offsets follow the DATE: CDT before Nov 1 2026, CST after', () => {
  assertEquals(offsetIso('2026-10-26T12:00:00Z', TZ), '2026-10-26T07:00:00-05:00');
  assertEquals(offsetIso('2026-11-02T13:00:00Z', TZ), '2026-11-02T07:00:00-06:00');
});

Deno.test('title format', () => {
  assertEquals(shiftTitle(SHIFT, TZ), 'Shift: Dialing, Tue Oct 13, 2:00-4:00 PM');
  assertEquals(
    shiftTitle(
      {
        activity: 'follow_up',
        starts_at: '2026-10-13T16:00:00Z',
        ends_at: '2026-10-13T19:30:00Z',
      },
      TZ
    ),
    'Shift: Follow up, Tue Oct 13, 11:00 AM-2:30 PM'
  );
});

Deno.test(
  'appointment POST: URL, version header key and body keys are pinned; id is returned',
  async () => {
    const { http, calls } = fakeHttp(() => ({ id: 'appt1' }));
    const { d, recorded } = deps(http);
    await processOutbox([row({ kind: 'appointment_upsert', shift_id: 's1' })], d);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].method, 'POST');
    assertEquals(calls[0].path, '/calendars/events/appointments');
    assertEquals(calls[0].version, GHL_APPT_VERSION);
    assertEquals(calls[0].body, {
      calendarId: 'cal1',
      locationId: 'loc1',
      contactId: 'c-u1',
      startTime: '2026-10-13T14:00:00-05:00',
      endTime: '2026-10-13T16:00:00-05:00',
      title: 'Shift: Dialing, Tue Oct 13, 2:00-4:00 PM',
      appointmentStatus: 'confirmed',
      ignoreDateRange: true,
      ignoreFreeSlotValidation: true,
      toNotify: true,
      assignedUserId: 'owner1',
    });
    assertEquals(recorded, [
      {
        id: recorded[0].id,
        outcome: 'done',
        appointmentId: 'appt1',
      },
    ]);
  }
);

Deno.test('appointment with an id is a PUT without contactId/locationId', async () => {
  const { http, calls } = fakeHttp();
  const { d } = deps(http, {
    loadShift: () => Promise.resolve({ ...SHIFT, ghl_appointment_id: 'appt9' }),
  });
  await processOutbox([row({ kind: 'appointment_upsert', shift_id: 's1' })], d);
  assertEquals(calls[0].method, 'PUT');
  assertEquals(calls[0].path, '/calendars/events/appointments/appt9');
  const body = calls[0].body as Record<string, unknown>;
  assertEquals(Object.keys(body).sort(), [
    'appointmentStatus',
    'assignedUserId',
    'calendarId',
    'endTime',
    'ignoreDateRange',
    'ignoreFreeSlotValidation',
    'startTime',
    'title',
    'toNotify',
  ]);
});

Deno.test(
  'stale upsert for a cancelled shift sends a cancel instead; never-created is a no-op',
  async () => {
    const cancelled = { ...SHIFT, status: 'cancelled' };
    const a = fakeHttp();
    await processOutbox(
      [row({ kind: 'appointment_upsert', shift_id: 's1' })],
      deps(a.http, {
        loadShift: () => Promise.resolve({ ...cancelled, ghl_appointment_id: 'appt9' }),
      }).d
    );
    assertEquals(a.calls.length, 1);
    assertEquals(a.calls[0].method, 'PUT');
    assertEquals(a.calls[0].path, '/calendars/events/appointments/appt9');
    assertEquals(a.calls[0].body, { appointmentStatus: 'cancelled' });
    const b = fakeHttp();
    const { d, recorded } = deps(b.http, {
      loadShift: () => Promise.resolve(cancelled),
    });
    await processOutbox([row({ kind: 'appointment_upsert', shift_id: 's1' })], d);
    assertEquals(b.calls.length, 0);
    assertEquals(recorded[0].outcome, 'done');
  }
);

Deno.test(
  'appointment_cancel body; appointment_status derives showed/noshow from the re-read shift',
  async () => {
    const cancel = fakeHttp();
    await processOutbox(
      [row({ kind: 'appointment_cancel', shift_id: 's1' })],
      deps(cancel.http, {
        loadShift: () => Promise.resolve({ ...SHIFT, ghl_appointment_id: 'appt9' }),
      }).d
    );
    assertEquals(cancel.calls[0].method, 'PUT');
    assertEquals(cancel.calls[0].body, { appointmentStatus: 'cancelled' });
    for (const [status, expected] of [
      ['completed', 'showed'],
      ['missed', 'noshow'],
    ] as const) {
      const { http, calls } = fakeHttp();
      await processOutbox(
        // the stale payload says the opposite: the shift row wins
        [
          row({
            kind: 'appointment_status',
            shift_id: 's1',
            payload: { status: expected === 'showed' ? 'noshow' : 'showed' },
          }),
        ],
        deps(http, {
          loadShift: () => Promise.resolve({ ...SHIFT, status, ghl_appointment_id: 'appt9' }),
        }).d
      );
      assertEquals(calls[0].body, { appointmentStatus: expected });
    }
    // a still-scheduled shift is not showed/noshow: permanent error, no call
    const { http, calls } = fakeHttp();
    const { d, recorded } = deps(http, {
      loadShift: () => Promise.resolve({ ...SHIFT, ghl_appointment_id: 'appt9' }),
    });
    await processOutbox(
      [row({ kind: 'appointment_status', shift_id: 's1', payload: { status: 'showed' } })],
      d
    );
    assertEquals(calls.length, 0);
    assertEquals(recorded[0].outcome, 'error');
  }
);

Deno.test(
  'upsert after the shift was completed / missed keeps that status; excused sends a cancel',
  async () => {
    for (const [status, expected] of [
      ['completed', 'showed'],
      ['missed', 'noshow'],
    ] as const) {
      const edit = fakeHttp();
      await processOutbox(
        [row({ kind: 'appointment_upsert', shift_id: 's1' })],
        deps(edit.http, {
          loadShift: () => Promise.resolve({ ...SHIFT, status, ghl_appointment_id: 'a1' }),
        }).d
      );
      assertEquals((edit.calls[0].body as Record<string, unknown>).appointmentStatus, expected);
      const create = fakeHttp(() => ({ id: 'new' }));
      await processOutbox(
        [row({ kind: 'appointment_upsert', shift_id: 's1' })],
        deps(create.http, { loadShift: () => Promise.resolve({ ...SHIFT, status }) }).d
      );
      assertEquals((create.calls[0].body as Record<string, unknown>).appointmentStatus, expected);
    }
    const ex = fakeHttp();
    await processOutbox(
      [row({ kind: 'appointment_upsert', shift_id: 's1' })],
      deps(ex.http, {
        loadShift: () => Promise.resolve({ ...SHIFT, status: 'excused', ghl_appointment_id: 'a1' }),
      }).d
    );
    assertEquals(ex.calls.length, 1);
    assertEquals(ex.calls[0].body, { appointmentStatus: 'cancelled' });
  }
);

Deno.test('upsert then cancel in one batch reuses the id the POST just created', async () => {
  const { http, calls } = fakeHttp((c) => (c.method === 'POST' ? { id: 'new1' } : {}));
  const { d } = deps(http);
  await processOutbox(
    [
      row({ kind: 'appointment_upsert', shift_id: 's1' }),
      row({ kind: 'appointment_cancel', shift_id: 's1' }),
    ],
    d
  );
  assertEquals(
    calls.map((c) => `${c.method} ${c.path}`),
    ['POST /calendars/events/appointments', 'PUT /calendars/events/appointments/new1']
  );
});

Deno.test('calendar unset -> permanent error on appointment rows only', async () => {
  const { http, calls } = fakeHttp();
  const { d, recorded } = deps(http, {
    settings: { timezone: TZ, calendarId: null, ownerUserId: null },
  });
  await processOutbox(
    [
      row({ kind: 'appointment_upsert', shift_id: 's1' }),
      row({ kind: 'contact_note', payload: { body: 'hi' } }),
    ],
    d
  );
  assertEquals(recorded[0].outcome, 'error');
  assertStringIncludes((recorded[0] as { error: string }).error, 'calendar');
  assertEquals(recorded[1].outcome, 'done');
  assertEquals(calls.length, 1);
});

Deno.test(
  'contact_fields resolves keys to ids, numbers stay numbers, null clears the field with ""',
  async () => {
    const { http, calls } = fakeHttp();
    const { d } = deps(http);
    await processOutbox(
      [
        row({
          kind: 'contact_fields',
          payload: {
            fields: {
              shift_week_submitted: 'Yes',
              shifts_missed_total: 2,
              shift_next_shift_at: null,
            },
          },
        }),
      ],
      d
    );
    assertEquals(calls[0].method, 'PUT');
    assertEquals(calls[0].path, '/contacts/c-u1');
    assertEquals(calls[0].version, GHL_CONTACT_VERSION);
    assertEquals(calls[0].body, {
      customFields: [
        { id: 'f1', field_value: 'Yes' },
        { id: 'f2', field_value: 2 },
        { id: 'f3', field_value: '' },
      ],
    });
  }
);

Deno.test(
  'missing custom-field definitions -> permanent error naming them; later note/tags of that event are skipped',
  async () => {
    const { http, calls } = fakeHttp();
    const { d, recorded } = deps(http);
    await processOutbox(
      [
        row({ kind: 'contact_fields', payload: { fields: { nope_field: 'x' } } }),
        row({ kind: 'contact_note', payload: { body: 'n' } }),
        row({ kind: 'contact_tags_remove', payload: { tags: ['a'] } }),
        row({ kind: 'contact_tags_add', payload: { tags: ['b'] } }),
        row({
          kind: 'contact_note',
          event: 'Other',
          payload: { body: 'later event' },
        }),
      ],
      d
    );
    assertEquals(
      recorded.map((r) => r.outcome),
      ['error', 'error', 'error', 'error', 'done']
    );
    assertStringIncludes((recorded[0] as { error: string }).error, 'nope_field');
    assertEquals((recorded[1] as { error: string }).error, 'skipped: earlier step failed');
    assertEquals(calls.length, 1); // only the later event's note
  }
);

Deno.test('note and tags: URLs and body keys; tags DELETE before POST', async () => {
  const { http, calls } = fakeHttp();
  const { d } = deps(http);
  await processOutbox(
    [
      row({ kind: 'contact_note', payload: { body: 'Week of Oct 12' } }),
      row({
        kind: 'contact_tags_remove',
        payload: { tags: ['shift-not-submitted'] },
      }),
      row({ kind: 'contact_tags_add', payload: { tags: ['shift-submitted'] } }),
    ],
    d
  );
  assertEquals(calls, [
    {
      method: 'POST',
      path: '/contacts/c-u1/notes',
      version: GHL_CONTACT_VERSION,
      body: { body: 'Week of Oct 12' },
    },
    {
      method: 'DELETE',
      path: '/contacts/c-u1/tags',
      version: GHL_CONTACT_VERSION,
      body: { tags: ['shift-not-submitted'] },
    },
    {
      method: 'POST',
      path: '/contacts/c-u1/tags',
      version: GHL_CONTACT_VERSION,
      body: { tags: ['shift-submitted'] },
    },
  ]);
});

Deno.test('rows go out per contact in id order even when handed in scrambled', async () => {
  const { http, calls } = fakeHttp();
  const { d } = deps(http);
  const a = row({ payload: { body: 'first' } });
  const b = row({ payload: { body: 'second' } });
  const c = row({ user_id: 'u2', payload: { body: 'other' } });
  await processOutbox([c, b, a], d);
  assertEquals(
    calls.map((x) => (x.body as { body: string }).body),
    ['first', 'second', 'other']
  );
});

Deno.test('a retryable failure holds the later rows of that contact only', async () => {
  const { http, calls } = fakeHttp((c) =>
    c.path === '/contacts/c-u1/notes' ? new ShiftGhlError('GHL 503', 503, true) : {}
  );
  const { d, recorded } = deps(http);
  const r1 = row({ payload: { body: 'x' } });
  const r2 = row({ kind: 'contact_tags_add', payload: { tags: ['t'] } });
  const r3 = row({ user_id: 'u2', payload: { body: 'y' } });
  await processOutbox([r1, r2, r3], d);
  assertEquals(
    recorded.map((r) => `${r.id}:${r.outcome}`),
    [`${r1.id}:retry`, `${r2.id}:release`, `${r3.id}:done`]
  );
  assertEquals(calls.length, 2);
});

Deno.test('a permanent failure does not hold the contact', async () => {
  const { http } = fakeHttp((c) =>
    c.method === 'POST' && c.path.endsWith('/notes') ? new ShiftGhlError('GHL 422', 422, false) : {}
  );
  const { d, recorded } = deps(http);
  await processOutbox(
    [row({ payload: { body: 'x' } }), row({ kind: 'contact_tags_add', payload: { tags: ['t'] } })],
    d
  );
  assertEquals(
    recorded.map((r) => r.outcome),
    ['error', 'done']
  );
});

Deno.test('429 stops the whole batch: the rest is released, not attempted', async () => {
  const { http, calls } = fakeHttp(() => new ShiftGhlError('GHL 429', 429, true));
  const { d, recorded } = deps(http);
  await processOutbox(
    [
      row({ payload: { body: 'a' } }),
      row({ user_id: 'u2', payload: { body: 'b' } }),
      row({ user_id: 'u3', payload: { body: 'c' } }),
    ],
    d
  );
  assertEquals(
    recorded.map((r) => r.outcome),
    ['retry', 'release', 'release']
  );
  assertEquals(calls.length, 1);
});

Deno.test('missing GHL contact id -> permanent error, no HTTP call', async () => {
  const { http, calls } = fakeHttp();
  const { d, recorded } = deps(http, { contactIdFor: () => null });
  await processOutbox([row({ payload: { body: 'x' } })], d);
  assertEquals(calls.length, 0);
  assertEquals(recorded[0], {
    id: recorded[0].id,
    outcome: 'error',
    error: 'intern has no GHL contact id',
  });
});

Deno.test(
  'http layer: 429/5xx/network are retryable, other 4xx permanent; headers and body',
  async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const mk = (status: number | 'throw') =>
      createShiftGhlHttp({
        token: 'tok',
        apiBase: 'https://ghl.test',
        fetchFn: ((url: string, init: RequestInit) => {
          seen.push({ url, init });
          if (status === 'throw') return Promise.reject(new Error('boom'));
          return Promise.resolve(new Response('{"id":"x"}', { status }));
        }) as typeof fetch,
      });
    const res = await mk(200).request('POST', '/contacts/c1/notes', GHL_CONTACT_VERSION, {
      body: 'n',
    });
    assertEquals(res, { id: 'x' });
    assertEquals(seen[0].url, 'https://ghl.test/contacts/c1/notes');
    const h = seen[0].init.headers as Record<string, string>;
    assertEquals(h.Authorization, 'Bearer tok');
    assertEquals(h.Version, '2021-07-28');
    assertEquals(seen[0].init.body, '{"body":"n"}');
    for (const [s, retry] of [
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [404, false],
      [422, false],
      ['throw', true],
    ] as const) {
      try {
        await mk(s).request('GET', '/x', GHL_CONTACT_VERSION);
        assert(false, 'should throw');
      } catch (e) {
        assert(e instanceof ShiftGhlError);
        assertEquals(e.retryable, retry, `status ${s}`);
      }
    }
  }
);

Deno.test(
  'field definitions: GET URL pinned; fieldKey prefix "contact." is stripped when matching',
  async () => {
    const { http, calls } = fakeHttp(() => ({
      fields: [
        {
          id: 'f1',
          fieldKey: 'contact.shift_week_submitted',
          dataType: 'TEXT',
        },
        { name: 'junk' },
      ],
    }));
    const defs = await fetchContactFieldDefs(http, 'loc 1');
    assertEquals(calls[0].path, '/custom-fields/object-key/contact?locationId=loc+1');
    assertEquals(calls[0].version, '2021-07-28');
    assertEquals(defs.length, 1);
    assertEquals(buildCustomFields({ shift_week_submitted: 'No' }, defs).items, [
      {
        id: 'f1',
        field_value: 'No',
      },
    ]);
  }
);

Deno.test(
  'every GHL call carries a timeout signal; an abort/timeout is a retryable network error',
  async () => {
    let signal: AbortSignal | null | undefined;
    const ok = createShiftGhlHttp({
      token: 't',
      fetchFn: ((_u: string, init: RequestInit) => {
        signal = init.signal;
        return Promise.resolve(new Response('{}'));
      }) as typeof fetch,
    });
    await ok.request('GET', '/x', GHL_CONTACT_VERSION);
    assert(signal instanceof AbortSignal);
    for (const name of ['TimeoutError', 'AbortError']) {
      const http = createShiftGhlHttp({
        token: 't',
        fetchFn: (() =>
          Promise.reject(Object.assign(new Error('aborted'), { name }))) as typeof fetch,
      });
      try {
        await http.request('GET', '/x', GHL_CONTACT_VERSION);
        assert(false);
      } catch (e) {
        assert(e instanceof ShiftGhlError);
        assertEquals(e.retryable, true);
        assertEquals(e.message, 'GHL request timed out');
      }
    }
  }
);

Deno.test(
  '401/403 is an org-level pause: nothing burns to error, the rest of the batch is released 10 min with the reconnect message',
  async () => {
    for (const status of [401, 403]) {
      const { http, calls } = fakeHttp(() => new ShiftGhlError(`GHL ${status}`, status, false));
      const { d, recorded } = deps(http);
      await processOutbox(
        [
          row({ payload: { body: 'a' } }),
          row({ user_id: 'u2', payload: { body: 'b' } }),
          row({ user_id: 'u3', payload: { body: 'c' } }),
        ],
        d
      );
      assertEquals(calls.length, 1);
      assertEquals(
        recorded.map((r) => r.outcome),
        ['release', 'release', 'release']
      );
      for (const r of recorded) {
        assertEquals(r, {
          id: r.id,
          outcome: 'release',
          delaySeconds: 600,
          error:
            status === 403
              ? 'GHL denied access (403): check the integration scopes and calendar permissions'
              : 'GHL token rejected (401/403): reconnect GoHighLevel',
        });
      }
    }
    // the same status through the real http layer
    const http = createShiftGhlHttp({
      token: 't',
      fetchFn: (() => Promise.resolve(new Response('no', { status: 401 }))) as typeof fetch,
    });
    try {
      await http.request('GET', '/x', GHL_CONTACT_VERSION);
      assert(false);
    } catch (e) {
      assert(e instanceof ShiftGhlError);
      assertEquals([e.status, e.retryable, e.orgLevel], [401, false, true]);
    }
  }
);

Deno.test(
  'after a 429 the released rows are delayed (60 s, or Retry-After, capped at an hour)',
  async () => {
    const mk = (retryAfter?: number) =>
      fakeHttp(() => new ShiftGhlError('GHL 429', 429, true, retryAfter));
    for (const [ra, expected] of [
      [undefined, 60],
      [5, 60],
      [120, 120],
      [99999, 3600],
    ] as const) {
      const { http } = mk(ra);
      const { d, recorded } = deps(http);
      await processOutbox(
        [row({ payload: { body: 'a' } }), row({ user_id: 'u2', payload: { body: 'b' } })],
        d
      );
      assertEquals(recorded[0].outcome, 'retry');
      assertEquals(recorded[1], { id: recorded[1].id, outcome: 'release', delaySeconds: expected });
    }
    // Retry-After header is read by the http layer
    const http = createShiftGhlHttp({
      token: 't',
      fetchFn: (() =>
        Promise.resolve(
          new Response('slow down', { status: 429, headers: { 'Retry-After': '90' } })
        )) as typeof fetch,
    });
    try {
      await http.request('GET', '/x', GHL_CONTACT_VERSION);
      assert(false);
    } catch (e) {
      assert(e instanceof ShiftGhlError);
      assertEquals(e.retryAfterSeconds, 90);
    }
  }
);

Deno.test(
  'run budget: past the deadline the rest of the batch is released unsent, no attempt counted',
  async () => {
    let t = 1000;
    const { http, calls } = fakeHttp(() => {
      t += 60_000; // each call "takes" a minute
      return {};
    });
    const { d, recorded } = deps(http, { deadlineMs: 1000 + 100_000, now: () => t });
    await processOutbox(
      [
        row({ payload: { body: 'a' } }),
        row({ user_id: 'u2', payload: { body: 'b' } }),
        row({ user_id: 'u3', payload: { body: 'c' } }),
        row({ user_id: 'u4', payload: { body: 'd' } }),
      ],
      d
    );
    assertEquals(calls.length, 2);
    assertEquals(
      recorded.map((r) => r.outcome),
      ['done', 'done', 'release', 'release']
    );
    assertEquals(recorded[2], { id: recorded[2].id, outcome: 'release', delaySeconds: 0 });
  }
);

Deno.test(
  'three timeouts in one run pause the org for 2 minutes; the rows are released, not burned',
  async () => {
    const { http, calls } = fakeHttp(() => new ShiftGhlError('GHL request timed out', 0, true));
    const { d, recorded } = deps(http);
    await processOutbox(
      [1, 2, 3, 4, 5].map((n) => row({ user_id: `u${n}`, payload: { body: String(n) } })),
      d
    );
    assertEquals(calls.length, 3);
    assertEquals(
      recorded.map((r) => r.outcome),
      ['retry', 'retry', 'retry', 'release', 'release']
    );
    assertEquals(recorded[3], {
      id: recorded[3].id,
      outcome: 'release',
      delaySeconds: 120,
      error: 'GHL is not answering (repeated timeouts); will retry',
    });
    // two timeouts then success: no pause
    let n = 0;
    const mixed = fakeHttp(() =>
      ++n <= 2 ? new ShiftGhlError('GHL request timed out', 0, true) : {}
    );
    const r2 = deps(mixed.http);
    await processOutbox(
      [1, 2, 3, 4].map((k) => row({ user_id: `u${k}`, payload: { body: String(k) } })),
      r2.d
    );
    assertEquals(
      r2.recorded.map((r) => r.outcome),
      ['retry', 'retry', 'done', 'done']
    );
  }
);

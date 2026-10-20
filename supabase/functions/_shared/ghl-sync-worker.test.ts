import { assertEquals } from 'jsr:@std/assert@1';
import { createGhlClient, type GhlClient } from './ghl-client.ts';
import {
  buildDispositionNote,
  buildPushCustomFields,
  processContactUpsertJob,
  processDispositionJob,
  processDncFlagJob,
  processInboundCallNoteJob,
  processNurtureTagJob,
  processTagJob,
  processTransferNoteJob,
  shouldSkipDispositionNote,
  type DispositionPayload,
  type InboundCallNotePayload,
  type TransferNotePayload,
} from './ghl-sync-worker.ts';

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const PAYLOAD: DispositionPayload = {
  disposition_key: 'interested',
  disposition_label: 'Interested',
  notes: 'Wants a callback next week',
  callback_at: '2026-10-01T15:00:00.000Z',
  ghl_tag: 'Interested',
  creates_task: true,
  agent_name: 'Jane Agent',
  duration_seconds: 142,
  recording_url: 'https://example.com/rec/1',
  transcript_excerpt: 'Hello, this is Jane calling about...',
  license_number: null,
  zips: null,
  is_dnc: false,
};

Deno.test('buildDispositionNote: includes every provided field', () => {
  const note = buildDispositionNote(PAYLOAD);
  assertEquals(note.includes('Disposition: Interested'), true);
  assertEquals(note.includes('Agent: Jane Agent'), true);
  assertEquals(note.includes('Duration: 142s'), true);
  assertEquals(note.includes('Notes: Wants a callback next week'), true);
  assertEquals(note.includes('Recording: https://example.com/rec/1'), true);
  assertEquals(note.includes('Transcript: Hello, this is Jane calling about...'), true);
});

Deno.test('buildDispositionNote: caps the transcript at 1000 characters', () => {
  const longPayload = { ...PAYLOAD, transcript_excerpt: 'x'.repeat(2000) };
  const note = buildDispositionNote(longPayload);
  const transcriptLine = note.split('\n').find((l) => l.startsWith('Transcript: '))!;
  assertEquals(transcriptLine.length, 'Transcript: '.length + 1000);
});

Deno.test('buildDispositionNote: omits optional lines when absent', () => {
  const minimal: DispositionPayload = {
    ...PAYLOAD,
    notes: null,
    recording_url: null,
    transcript_excerpt: null,
  };
  const note = buildDispositionNote(minimal);
  assertEquals(note.includes('Notes:'), false);
  assertEquals(note.includes('Recording:'), false);
  assertEquals(note.includes('Transcript:'), false);
});

// ---------------------------------------------------------------------------
// processDispositionJob -- stubbed fetch through a real createGhlClient.
// ---------------------------------------------------------------------------

Deno.test(
  'processDispositionJob: happy path runs every step exactly once and returns ok',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(url).pathname}`);
      if (url.includes('/contacts/upsert')) {
        return Response.json({ new: true, contact: { id: 'ghl-new-1' } });
      }
      if (url.endsWith('/notes')) return Response.json({ id: 'note-1' });
      if (url.endsWith('/tags')) return Response.json({});
      if (url.endsWith('/tasks')) return Response.json({ id: 'task-1' });
      return Response.json({});
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: PAYLOAD,
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(result.resolvedGhlContactId, 'ghl-new-1');
      assertEquals(result.progress, {
        upserted: true,
        note_added: true,
        tag_added: true,
        task_created: true,
        dnd_set: true,
        custom_fields_pushed: true,
        stage_moved: true,
      });
      assertEquals(calls, [
        'POST /contacts/upsert',
        'POST /contacts/ghl-new-1/notes',
        'POST /contacts/ghl-new-1/tags',
        'POST /contacts/ghl-new-1/tasks',
      ]);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: already-linked contact skips the upsert step entirely',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: 'ghl-existing-1',
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: PAYLOAD,
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(
        calls.some((c) => c.includes('/contacts/upsert')),
        false
      );
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: a 500 on the tag step fails without double-posting the note on retry',
  async () => {
    let noteCalls = 0;
    let tagCalls = 0;
    const restore = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      if (url.endsWith('/notes')) {
        noteCalls++;
        return Response.json({ id: 'note-1' });
      }
      if (url.endsWith('/tags')) {
        tagCalls++;
        if (tagCalls === 1) {
          return new Response(JSON.stringify({ errors: [{ detail: 'server error' }] }), {
            status: 500,
          });
        }
        return Response.json({});
      }
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const firstAttempt = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: PAYLOAD,
        progress: {},
      });
      assertEquals(firstAttempt.ok, false);
      assertEquals(firstAttempt.progress, { upserted: true, note_added: true });
      assertEquals(firstAttempt.resolvedGhlContactId, 'ghl-1');
      assertEquals(noteCalls, 1);
      assertEquals(tagCalls, 1);

      // Retry: caller persists progress + resolvedGhlContactId from the first attempt.
      const secondAttempt = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: firstAttempt.resolvedGhlContactId,
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: PAYLOAD,
        progress: firstAttempt.progress,
      });
      assertEquals(secondAttempt.ok, true);
      assertEquals(noteCalls, 1, 'note must not be re-posted on retry');
      assertEquals(tagCalls, 2);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: no callback_at skips task creation but still marks it done',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: { ...PAYLOAD, callback_at: null },
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress.task_created, true);
      assertEquals(
        calls.some((c) => c.endsWith('/tasks')),
        false
      );
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: null ghl_tag (TASK-P3-E1, e.g. "voicemail"/"no_answer") skips the tag step entirely but still marks it done',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: { ...PAYLOAD, ghl_tag: null },
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress.tag_added, true);
      assertEquals(
        calls.some((c) => c.endsWith('/tags')),
        false
      );
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: creates_task=false (TASK-P3-E1) skips task creation even with a callback_at set',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: { ...PAYLOAD, creates_task: false },
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress.task_created, true);
      assertEquals(
        calls.some((c) => c.endsWith('/tasks')),
        false
      );
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: is_dnc=true sets DND; is_dnc=false never calls setDnd, ' +
    'regardless of disposition_key (TASK-F-P1: a legacy "dnc" org and a new "do_not_call" ' +
    'org must both work -- the key string is never consulted)',
  async () => {
    const dndCalls: string[] = [];
    const restore = stubFetch((url, init) => {
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      if ((init?.method ?? 'GET') === 'PUT') dndCalls.push(url);
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const nonDnc = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: null, lastName: null, phone: '+14155552671' },
        payload: { ...PAYLOAD, disposition_key: 'interested', is_dnc: false },
        progress: {},
      });
      assertEquals(nonDnc.ok, true);
      assertEquals(dndCalls.length, 0);

      const legacyDnc = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: 'ghl-2',
        contactFields: { firstName: null, lastName: null, phone: '+14155552672' },
        payload: { ...PAYLOAD, disposition_key: 'dnc', is_dnc: true },
        progress: {},
      });
      assertEquals(legacyDnc.ok, true);
      assertEquals(dndCalls.length, 1);

      const newDoNotCall = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: 'ghl-3',
        contactFields: { firstName: null, lastName: null, phone: '+14155552673' },
        payload: { ...PAYLOAD, disposition_key: 'do_not_call', is_dnc: true },
        progress: {},
      });
      assertEquals(newDoNotCall.ok, true);
      assertEquals(dndCalls.length, 2);
    } finally {
      restore();
    }
  }
);

Deno.test('buildDispositionNote: includes license_number and zips when present', () => {
  const withFields: DispositionPayload = {
    ...PAYLOAD,
    license_number: 'TX-LIC-99182',
    zips: ['78701', '78702'],
  };
  const note = buildDispositionNote(withFields);
  assertEquals(note.includes('License #: TX-LIC-99182'), true);
  assertEquals(note.includes('ZIPs served: 78701, 78702'), true);
});

Deno.test(
  'processDispositionJob: no phone and not yet linked fails cleanly before any GHL call',
  async () => {
    let calls = 0;
    const restore = stubFetch(() => {
      calls++;
      return Response.json({});
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Alice', lastName: null, phone: null },
        payload: PAYLOAD,
        progress: {},
      });
      assertEquals(result.ok, false);
      assertEquals(result.error?.includes('no phone number'), true);
      assertEquals(calls, 0);
    } finally {
      restore();
    }
  }
);

// ---------------------------------------------------------------------------
// processContactUpsertJob
// ---------------------------------------------------------------------------

Deno.test('processContactUpsertJob: already linked is a no-op success', async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls++;
    return Response.json({});
  });
  try {
    const client: GhlClient = createGhlClient('tok');
    const result = await processContactUpsertJob({
      client,
      locationId: 'loc-1',
      ghlContactId: 'ghl-already',
      contactFields: { firstName: null, lastName: null, phone: '+14155552671' },
    });
    assertEquals(result.ok, true);
    assertEquals(result.resolvedGhlContactId, 'ghl-already');
    assertEquals(calls, 0);
  } finally {
    restore();
  }
});

Deno.test(
  'processContactUpsertJob: unlinked contact upserts and returns the new GHL id',
  async () => {
    const restore = stubFetch((url) => {
      if (url.includes('/contacts/upsert'))
        return Response.json({ new: true, contact: { id: 'ghl-fresh' } });
      return Response.json({});
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processContactUpsertJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Bob', lastName: null, phone: '+14155552672' },
      });
      assertEquals(result.ok, true);
      assertEquals(result.resolvedGhlContactId, 'ghl-fresh');
    } finally {
      restore();
    }
  }
);

// ---------------------------------------------------------------------------
// processNurtureTagJob (TASK-F-T1, QUE-3)
// ---------------------------------------------------------------------------

Deno.test('processNurtureTagJob: already linked, already tagged is a full no-op', async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls++;
    return Response.json({});
  });
  try {
    const client: GhlClient = createGhlClient('tok');
    const result = await processNurtureTagJob({
      client,
      locationId: 'loc-1',
      ghlContactId: 'ghl-already',
      contactFields: { firstName: null, lastName: null, phone: '+14155552671' },
      progress: { upserted: true, tag_added: true },
    });
    assertEquals(result.ok, true);
    assertEquals(result.resolvedGhlContactId, 'ghl-already');
    assertEquals(result.progress.tag_added, true);
    assertEquals(calls, 0);
  } finally {
    restore();
  }
});

Deno.test('processNurtureTagJob: unlinked contact upserts first, then tags "nurture"', async () => {
  let taggedWith: string[] | null = null;
  const restore = stubFetch((url, init) => {
    if (url.includes('/contacts/upsert'))
      return Response.json({ new: true, contact: { id: 'ghl-fresh' } });
    if (url.includes('/tags')) {
      taggedWith = JSON.parse(String(init?.body)).tags;
      return Response.json({});
    }
    return Response.json({});
  });
  try {
    const client: GhlClient = createGhlClient('tok');
    const result = await processNurtureTagJob({
      client,
      locationId: 'loc-1',
      ghlContactId: null,
      contactFields: { firstName: 'Bob', lastName: null, phone: '+14155552672' },
      progress: {},
    });
    assertEquals(result.ok, true);
    assertEquals(result.resolvedGhlContactId, 'ghl-fresh');
    assertEquals(result.progress.upserted, true);
    assertEquals(result.progress.tag_added, true);
    assertEquals(taggedWith, ['nurture']);
  } finally {
    restore();
  }
});

Deno.test(
  'processNurtureTagJob: upsert failure returns ok:false with no contact id and no tag call',
  async () => {
    let tagCalls = 0;
    const restore = stubFetch((url) => {
      if (url.includes('/tags')) {
        tagCalls++;
        return Response.json({});
      }
      return new Response('server error', { status: 500 });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processNurtureTagJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Bob', lastName: null, phone: '+14155552673' },
        progress: {},
      });
      assertEquals(result.ok, false);
      assertEquals(result.resolvedGhlContactId, null);
      assertEquals(result.progress.upserted, undefined);
      assertEquals(tagCalls, 0);
    } finally {
      restore();
    }
  }
);

// ---------------------------------------------------------------------------
// processTagJob (TASK-F-T3, VMD-3/GHL-9) -- same shape as processNurtureTagJob, tag from payload
// ---------------------------------------------------------------------------

Deno.test('processTagJob: already linked, already tagged is a full no-op', async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls++;
    return Response.json({});
  });
  try {
    const client: GhlClient = createGhlClient('tok');
    const result = await processTagJob({
      client,
      locationId: 'loc-1',
      ghlContactId: 'ghl-already',
      contactFields: { firstName: null, lastName: null, phone: '+14155552671' },
      tag: 'call:voicemail-1',
      progress: { upserted: true, tag_added: true },
    });
    assertEquals(result.ok, true);
    assertEquals(result.resolvedGhlContactId, 'ghl-already');
    assertEquals(calls, 0);
  } finally {
    restore();
  }
});

Deno.test(
  'processTagJob: unlinked contact upserts first, then pushes the EXACT tag from the payload',
  async () => {
    let taggedWith: string[] | null = null;
    const restore = stubFetch((url, init) => {
      if (url.includes('/contacts/upsert'))
        return Response.json({ new: true, contact: { id: 'ghl-fresh' } });
      if (url.includes('/tags')) {
        taggedWith = JSON.parse(String(init?.body)).tags;
        return Response.json({});
      }
      return Response.json({});
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processTagJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Bob', lastName: null, phone: '+14155552672' },
        tag: 'call:no-answer-3',
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(result.resolvedGhlContactId, 'ghl-fresh');
      assertEquals(taggedWith, ['call:no-answer-3']);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processTagJob: upsert failure returns ok:false, never calls the tag endpoint',
  async () => {
    let tagCalls = 0;
    const restore = stubFetch((url) => {
      if (url.includes('/tags')) {
        tagCalls++;
        return Response.json({});
      }
      return new Response('server error', { status: 500 });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processTagJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Bob', lastName: null, phone: '+14155552673' },
        tag: 'call:voicemail-1',
        progress: {},
      });
      assertEquals(result.ok, false);
      assertEquals(result.resolvedGhlContactId, null);
      assertEquals(tagCalls, 0);
    } finally {
      restore();
    }
  }
);

// ---------------------------------------------------------------------------
// MISSION-4 TASK-T2 (GHL-2,10,11,12,13,16) additions
// ---------------------------------------------------------------------------

Deno.test('buildPushCustomFields: no mapping at all -- contributes nothing', () => {
  assertEquals(
    buildPushCustomFields(undefined, { lastCallAt: '2026-09-27T00:00:00Z', callAttempts: 3 }),
    []
  );
});

Deno.test('buildPushCustomFields: only the mapped, present keys are included', () => {
  const result = buildPushCustomFields(
    { last_call_at: 'f-lca', call_attempts: 'f-att' },
    {
      lastCallAt: '2026-09-27T00:00:00Z',
      lastCallOutcome: 'Interested', // not mapped -- must be omitted
      callAttempts: 3,
      licenseNumber: null,
      serviceZips: null,
    }
  );
  assertEquals(result, [
    { id: 'f-lca', fieldValue: '2026-09-27T00:00:00Z' },
    { id: 'f-att', fieldValue: '3' },
  ]);
});

Deno.test(
  'buildPushCustomFields: call_attempts of 0 is a real value, not treated as absent',
  () => {
    const result = buildPushCustomFields({ call_attempts: 'f-att' }, { callAttempts: 0 });
    assertEquals(result, [{ id: 'f-att', fieldValue: '0' }]);
  }
);

Deno.test(
  'buildPushCustomFields: service_zips joins into one string, license_number/zips reuse the same call',
  () => {
    const result = buildPushCustomFields(
      { license_number: 'f-lic', service_zips: 'f-zips' },
      { licenseNumber: 'LN-123', serviceZips: ['90210', '90211'] }
    );
    assertEquals(result, [
      { id: 'f-lic', fieldValue: 'LN-123' },
      { id: 'f-zips', fieldValue: '90210, 90211' },
    ]);
  }
);

Deno.test(
  'processDispositionJob: GHL-11/13 custom fields pushed when pushConfig + pushTimeContext are given',
  async () => {
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      if (url.endsWith('/contacts/ghl-1') && init?.method === 'PUT') {
        seenBody = JSON.parse(String(init.body));
      }
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const buildProfilePayload: DispositionPayload = {
        ...PAYLOAD,
        license_number: 'LN-999',
        zips: ['30301'],
      };
      const result = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: buildProfilePayload,
        progress: {},
        pushConfig: {
          pushFieldMapping: {
            last_call_at: 'f-lca',
            last_call_outcome: 'f-lco',
            call_attempts: 'f-att',
            license_number: 'f-lic',
            service_zips: 'f-zips',
          },
        },
        pushTimeContext: { lastCallAt: '2026-09-27T00:00:00Z', callAttempts: 4 },
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress.custom_fields_pushed, true);
      assertEquals(seenBody, {
        customFields: [
          { id: 'f-lca', field_value: '2026-09-27T00:00:00Z' },
          { id: 'f-lco', field_value: 'Interested' },
          { id: 'f-att', field_value: '4' },
          { id: 'f-lic', field_value: 'LN-999' },
          { id: 'f-zips', field_value: '30301' },
        ],
      });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: no pushConfig at all -- the custom-fields step is a clean no-op, never PUTs',
  async () => {
    let putCalls = 0;
    const restore = stubFetch((url, init) => {
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      if (init?.method === 'PUT') putCalls++;
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: PAYLOAD,
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress.custom_fields_pushed, true);
      assertEquals(putCalls, 0);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: GHL-12 stage move -- calls moveOpportunityStage when a stageTarget is configured',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(url).pathname}`);
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      if (url.includes('/opportunities/search')) return Response.json({ opportunities: [] });
      if (url.includes('/opportunities/')) return Response.json({ opportunity: { id: 'opp-1' } });
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: PAYLOAD,
        progress: {},
        pushTimeContext: {
          stageTarget: { pipelineId: 'p1', pipelineStageId: 'stage-2' },
        },
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress.stage_moved, true);
      assertEquals(
        calls.some((c) => c.includes('/opportunities/search')),
        true
      );
      assertEquals(
        calls.some((c) => c === 'POST /opportunities/'),
        true
      );
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: unmapped disposition (no stageTarget) never calls the opportunities endpoint',
  async () => {
    let opportunityCalls = 0;
    const restore = stubFetch((url) => {
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      if (url.includes('/opportunities')) opportunityCalls++;
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Alice', lastName: 'Doe', phone: '+14155552671' },
        payload: PAYLOAD,
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress.stage_moved, true);
      assertEquals(opportunityCalls, 0);
    } finally {
      restore();
    }
  }
);

const INBOUND_PAYLOAD: InboundCallNotePayload = {
  from_e164: '+14155559999',
  outcome: 'answered_by_agent',
  agent_name: 'Jane Agent',
  duration_seconds: 60,
  recording_url: null,
  occurred_at: '2026-09-27T01:00:00Z',
};

Deno.test(
  'processInboundCallNoteJob: GHL-16 happy path -- upsert, note, call:inbound tag, then custom fields',
  async () => {
    const calls: string[] = [];
    let tagBody: unknown = null;
    let customFieldsBody: unknown = null;
    const restore = stubFetch((url, init) => {
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${new URL(url).pathname}`);
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      if (url.endsWith('/notes')) return Response.json({ id: 'note-1' });
      if (url.endsWith('/tags')) {
        tagBody = JSON.parse(String(init?.body ?? '{}'));
        return Response.json({});
      }
      if (url.endsWith('/contacts/ghl-1') && method === 'PUT') {
        customFieldsBody = JSON.parse(String(init?.body ?? '{}'));
      }
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processInboundCallNoteJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Bob', lastName: null, phone: '+14155552673' },
        payload: INBOUND_PAYLOAD,
        progress: {},
        pushConfig: {
          pushFieldMapping: { last_call_at: 'f-lca', last_call_outcome: 'f-lco' },
        },
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress, {
        upserted: true,
        note_added: true,
        tag_added: true,
        custom_fields_pushed: true,
      });
      assertEquals(tagBody, { tags: ['call:inbound'] });
      assertEquals(customFieldsBody, {
        customFields: [
          { id: 'f-lca', field_value: '2026-09-27T01:00:00Z' },
          { id: 'f-lco', field_value: 'answered_by_agent' },
        ],
      });
      assertEquals(calls, [
        'POST /contacts/upsert',
        'POST /contacts/ghl-1/notes',
        'POST /contacts/ghl-1/tags',
        'PUT /contacts/ghl-1',
      ]);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processInboundCallNoteJob: no pushConfig -- tag still pushed, custom-fields step is a clean no-op',
  async () => {
    let putCalls = 0;
    const restore = stubFetch((url, init) => {
      if (url.includes('/contacts/upsert')) return Response.json({ contact: { id: 'ghl-1' } });
      if (init?.method === 'PUT') putCalls++;
      return Response.json({ id: 'ok' });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processInboundCallNoteJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Bob', lastName: null, phone: '+14155552673' },
        payload: { ...INBOUND_PAYLOAD, occurred_at: null },
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress.tag_added, true);
      assertEquals(result.progress.custom_fields_pushed, true);
      assertEquals(putCalls, 0);
    } finally {
      restore();
    }
  }
);

// ---------------------------------------------------------------------------
// processTransferNoteJob (lead follow-up to MISSION-4 TASK-T2's own fix-forward -- crm_sync_jobs
// kind widened by eng2's 20260926070002_transfer_hold.sql; T4's own enqueue_crm_job call is still
// pending, this is the worker-side processor so the queue doesn't get stuck once it lands)
// ---------------------------------------------------------------------------

const TRANSFER_NOTE_PAYLOAD: TransferNotePayload = {
  note_body: 'Warm transfer to Jane (sales) -- prospect asked about pricing tiers.',
  transfer_type: 'warm',
  call_leg_id: '11111111-1111-4111-8111-111111111111',
};

Deno.test('processTransferNoteJob: already linked, already noted is a full no-op', async () => {
  let calls = 0;
  const restore = stubFetch(() => {
    calls++;
    return Response.json({});
  });
  try {
    const client: GhlClient = createGhlClient('tok');
    const result = await processTransferNoteJob({
      client,
      locationId: 'loc-1',
      ghlContactId: 'ghl-already',
      contactFields: { firstName: null, lastName: null, phone: '+14155552671' },
      payload: TRANSFER_NOTE_PAYLOAD,
      progress: { upserted: true, note_added: true },
    });
    assertEquals(result.ok, true);
    assertEquals(result.resolvedGhlContactId, 'ghl-already');
    assertEquals(calls, 0);
  } finally {
    restore();
  }
});

Deno.test(
  'processTransferNoteJob: unlinked contact upserts first, then posts note_body VERBATIM (not reformatted, no transfer_type prefix)',
  async () => {
    let notedBody: string | null = null;
    const restore = stubFetch((url, init) => {
      if (url.includes('/contacts/upsert'))
        return Response.json({ new: true, contact: { id: 'ghl-fresh' } });
      if (url.includes('/notes')) {
        notedBody = JSON.parse(String(init?.body)).body;
        return Response.json({ id: 'note-1' });
      }
      return Response.json({});
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processTransferNoteJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Bob', lastName: null, phone: '+14155552672' },
        payload: TRANSFER_NOTE_PAYLOAD,
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(result.resolvedGhlContactId, 'ghl-fresh');
      assertEquals(notedBody, TRANSFER_NOTE_PAYLOAD.note_body);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processTransferNoteJob: a retry that already upserted skips straight to the note step',
  async () => {
    let upsertCalls = 0;
    let notedBody: string | null = null;
    const restore = stubFetch((url, init) => {
      if (url.includes('/contacts/upsert')) {
        upsertCalls++;
        return Response.json({ new: true, contact: { id: 'ghl-fresh' } });
      }
      if (url.includes('/notes')) {
        notedBody = JSON.parse(String(init?.body)).body;
        return Response.json({ id: 'note-1' });
      }
      return Response.json({});
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processTransferNoteJob({
        client,
        locationId: 'loc-1',
        ghlContactId: 'ghl-already',
        contactFields: { firstName: null, lastName: null, phone: '+14155552671' },
        payload: TRANSFER_NOTE_PAYLOAD,
        progress: { upserted: true },
      });
      assertEquals(result.ok, true);
      assertEquals(upsertCalls, 0);
      assertEquals(notedBody, TRANSFER_NOTE_PAYLOAD.note_body);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processTransferNoteJob: upsert failure returns ok:false, never calls the notes endpoint',
  async () => {
    let noteCalls = 0;
    const restore = stubFetch((url) => {
      if (url.includes('/notes')) {
        noteCalls++;
        return Response.json({});
      }
      return new Response('server error', { status: 500 });
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processTransferNoteJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Bob', lastName: null, phone: '+14155552673' },
        payload: TRANSFER_NOTE_PAYLOAD,
        progress: {},
      });
      assertEquals(result.ok, false);
      assertEquals(result.resolvedGhlContactId, null);
      assertEquals(noteCalls, 0);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processTransferNoteJob: no phone and no existing GHL contact id -- fails before any network call',
  async () => {
    let calls = 0;
    const restore = stubFetch(() => {
      calls++;
      return Response.json({});
    });
    try {
      const client: GhlClient = createGhlClient('tok');
      const result = await processTransferNoteJob({
        client,
        locationId: 'loc-1',
        ghlContactId: null,
        contactFields: { firstName: 'Bob', lastName: null, phone: null },
        payload: TRANSFER_NOTE_PAYLOAD,
        progress: {},
      });
      assertEquals(result.ok, false);
      assertEquals(calls, 0);
    } finally {
      restore();
    }
  }
);

// ---------------------------------------------------------------------------
// TASK-G02 (spec §1): callback_at / call_duration / recording_url, no-answer note skip,
// callback task assignedTo
// ---------------------------------------------------------------------------

Deno.test(
  'buildPushCustomFields: TASK-G02 callback_at/call_duration/recording_url, mapped only',
  () => {
    const values = {
      callbackAt: '2026-10-20T15:00:00.000Z',
      callDurationSeconds: 142,
      recordingUrl: 'https://example.com/rec/1',
    };
    assertEquals(
      buildPushCustomFields(
        { callback_at: 'f-cb', call_duration: 'f-dur', recording_url: 'f-rec' },
        values
      ),
      [
        { id: 'f-cb', fieldValue: '2026-10-20T15:00:00.000Z' },
        { id: 'f-dur', fieldValue: '142' },
        { id: 'f-rec', fieldValue: 'https://example.com/rec/1' },
      ]
    );
    // an unmapped key is skipped, never an error
    assertEquals(buildPushCustomFields({ call_duration: 'f-dur' }, values), [
      { id: 'f-dur', fieldValue: '142' },
    ]);
    // 0 seconds is a real value; null callback/recording contribute nothing
    assertEquals(
      buildPushCustomFields(
        { callback_at: 'f-cb', call_duration: 'f-dur', recording_url: 'f-rec' },
        { callbackAt: null, callDurationSeconds: 0, recordingUrl: null }
      ),
      [{ id: 'f-dur', fieldValue: '0' }]
    );
  }
);

Deno.test('shouldSkipDispositionNote: only no-answer/voicemail with empty notes', () => {
  const p = (disposition_key: string, notes: string | null): DispositionPayload => ({
    ...PAYLOAD,
    disposition_key,
    notes,
  });
  assertEquals(shouldSkipDispositionNote(p('no_answer', null)), true);
  assertEquals(shouldSkipDispositionNote(p('voicemail_left', '  ')), true);
  assertEquals(shouldSkipDispositionNote(p('no_answer', 'left a message w/ gatekeeper')), false);
  assertEquals(shouldSkipDispositionNote(p('callback', null)), false);
  assertEquals(shouldSkipDispositionNote(p('not_interested', '')), false);
});

Deno.test(
  'processDispositionJob: TASK-G02 no-answer with empty notes posts NO note but still tags',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      return Response.json({ id: 'ok' });
    });
    try {
      const result = await processDispositionJob({
        client: createGhlClient('tok'),
        locationId: 'loc-1',
        ghlContactId: 'ghl-1',
        contactFields: { firstName: 'A', lastName: 'B', phone: '+14155552671' },
        payload: {
          ...PAYLOAD,
          disposition_key: 'no_answer',
          disposition_label: 'No answer (manual)',
          notes: null,
          ghl_tag: 'call:no_answer',
          creates_task: false,
          callback_at: null,
        },
        progress: {},
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress.note_added, true);
      assertEquals(calls, ['POST /contacts/ghl-1/tags']);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: TASK-G02 callback task body carries assignedTo = caller GHL user; custom fields carry callback/duration/recording',
  async () => {
    const bodies: Record<string, unknown> = {};
    const restore = stubFetch((url, init) => {
      const path = new URL(url).pathname;
      if (init?.body) bodies[`${init.method} ${path}`] = JSON.parse(String(init.body));
      return Response.json({ id: 'ok' });
    });
    try {
      const result = await processDispositionJob({
        client: createGhlClient('tok'),
        locationId: 'loc-1',
        ghlContactId: 'ghl-1',
        contactFields: { firstName: 'A', lastName: 'B', phone: '+14155552671' },
        payload: PAYLOAD,
        progress: {},
        pushConfig: {
          pushFieldMapping: { callback_at: 'f-cb', call_duration: 'f-dur', recording_url: 'f-rec' },
        },
        pushTimeContext: { callerGhlUserId: 'ghl-user-7' },
      });
      assertEquals(result.ok, true);
      assertEquals(bodies['POST /contacts/ghl-1/tasks'], {
        title: 'Callback: Interested',
        dueDate: '2026-10-01T15:00:00.000Z',
        completed: false,
        assignedTo: 'ghl-user-7',
      });
      assertEquals(bodies['PUT /contacts/ghl-1'], {
        customFields: [
          { id: 'f-cb', field_value: '2026-10-01T15:00:00.000Z' },
          { id: 'f-dur', field_value: '142' },
          { id: 'f-rec', field_value: 'https://example.com/rec/1' },
        ],
      });
      // never touches the contact's own owner
      assertEquals(JSON.stringify(bodies['PUT /contacts/ghl-1']).includes('assignedTo'), false);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processDispositionJob: TASK-G02 task has no assignedTo key when the caller has no GHL user',
  async () => {
    let taskBody: Record<string, unknown> = {};
    const restore = stubFetch((url, init) => {
      if (url.endsWith('/tasks')) taskBody = JSON.parse(String(init?.body));
      return Response.json({ id: 'ok' });
    });
    try {
      await processDispositionJob({
        client: createGhlClient('tok'),
        locationId: 'loc-1',
        ghlContactId: 'ghl-1',
        contactFields: { firstName: 'A', lastName: 'B', phone: '+14155552671' },
        payload: PAYLOAD,
        progress: {},
        pushTimeContext: { callerGhlUserId: null },
      });
      assertEquals('assignedTo' in taskBody, false);
    } finally {
      restore();
    }
  }
);

// ---------------------------------------------------------------------------
// TASK-G03 (spec §1): attempt count + last attempt date for automated no-answer / voicemail
// ---------------------------------------------------------------------------

Deno.test(
  'processTagJob: TASK-G03 pushes call_attempts + last_call_at custom fields after the tag, and no note',
  async () => {
    const calls: string[] = [];
    let putBody: unknown = null;
    const restore = stubFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (init?.method === 'PUT') putBody = JSON.parse(String(init.body));
      return Response.json({ id: 'ok' });
    });
    try {
      const result = await processTagJob({
        client: createGhlClient('tok'),
        locationId: 'loc-1',
        ghlContactId: 'ghl-1',
        contactFields: { firstName: 'A', lastName: 'B', phone: '+14155552671' },
        tag: 'call:no-answer-3',
        progress: {},
        pushConfig: { pushFieldMapping: { call_attempts: 'f-att', last_call_at: 'f-lca' } },
        pushTimeContext: { lastCallAt: '2026-10-19T21:00:00.000Z', callAttempts: 3 },
      });
      assertEquals(result.ok, true);
      assertEquals(result.progress.custom_fields_pushed, true);
      assertEquals(calls, ['POST /contacts/ghl-1/tags', 'PUT /contacts/ghl-1']);
      assertEquals(putBody, {
        customFields: [
          { id: 'f-lca', field_value: '2026-10-19T21:00:00.000Z' },
          { id: 'f-att', field_value: '3' },
        ],
      });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processTagJob: TASK-G03 no push mapping -> tag only, no PUT; a retry skips an already-pushed field step',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      return Response.json({ id: 'ok' });
    });
    try {
      const base = {
        client: createGhlClient('tok'),
        locationId: 'loc-1',
        ghlContactId: 'ghl-1',
        contactFields: { firstName: 'A', lastName: 'B', phone: '+14155552671' },
        tag: 'call:voicemail-1',
      };
      const noMap = await processTagJob({
        ...base,
        progress: {},
        pushTimeContext: { lastCallAt: '2026-10-19T21:00:00.000Z', callAttempts: 1 },
      });
      assertEquals(noMap.ok, true);
      assertEquals(calls, ['POST /contacts/ghl-1/tags']);

      calls.length = 0;
      const retry = await processTagJob({
        ...base,
        progress: { upserted: true, tag_added: true, custom_fields_pushed: true },
        pushConfig: { pushFieldMapping: { call_attempts: 'f-att' } },
        pushTimeContext: { callAttempts: 1 },
      });
      assertEquals(retry.ok, true);
      assertEquals(calls, []);
    } finally {
      restore();
    }
  }
);

// ---------------------------------------------------------------------------
// TASK-G05 (spec section 4): dnc_flag job -- HyperDial DNC -> GHL DND + tag
// ---------------------------------------------------------------------------

function dncStub(ghlContact: Record<string, unknown>) {
  const calls: string[] = [];
  const bodies: Record<string, unknown> = {};
  const restore = stubFetch((url, init) => {
    const key = `${init?.method ?? 'GET'} ${new URL(url).pathname}`;
    calls.push(key);
    if (init?.body) bodies[key] = JSON.parse(String(init.body));
    if (key === 'GET /contacts/ghl-1')
      return Response.json({ contact: { id: 'ghl-1', ...ghlContact } });
    return Response.json({});
  });
  return { calls, bodies, restore };
}

Deno.test('processDncFlagJob: sets DND and adds the DNC tag when GHL has neither', async () => {
  const s = dncStub({ dnd: false, tags: ['lead'] });
  try {
    const r = await processDncFlagJob({
      client: createGhlClient('tok'),
      ghlContactId: 'ghl-1',
      dncTag: 'DNC',
      progress: {},
    });
    assertEquals(r.ok, true);
    assertEquals(s.calls, [
      'GET /contacts/ghl-1',
      'PUT /contacts/ghl-1',
      'POST /contacts/ghl-1/tags',
    ]);
    assertEquals(s.bodies['PUT /contacts/ghl-1'], { dnd: true });
    assertEquals(s.bodies['POST /contacts/ghl-1/tags'], { tags: ['DNC'] });
    assertEquals(r.progress, { dnd_set: true, tag_added: true });
  } finally {
    s.restore();
  }
});

Deno.test(
  'processDncFlagJob: DNC that already exists in GHL (came from GHL) is not echoed back',
  async () => {
    const s = dncStub({ dnd: true, tags: ['dnc'] }); // tag match is case-insensitive
    try {
      const r = await processDncFlagJob({
        client: createGhlClient('tok'),
        ghlContactId: 'ghl-1',
        dncTag: 'DNC',
        progress: {},
      });
      assertEquals(r.ok, true);
      assertEquals(s.calls, ['GET /contacts/ghl-1']);
    } finally {
      s.restore();
    }
  }
);

Deno.test('processDncFlagJob: retry after DND step skips it; no GHL id fails', async () => {
  const s = dncStub({ dnd: true, tags: [] });
  try {
    const r = await processDncFlagJob({
      client: createGhlClient('tok'),
      ghlContactId: 'ghl-1',
      dncTag: 'Do Not Call',
      progress: { dnd_set: true },
    });
    assertEquals(r.ok, true);
    assertEquals(s.calls, ['GET /contacts/ghl-1', 'POST /contacts/ghl-1/tags']);
    const done = await processDncFlagJob({
      client: createGhlClient('tok'),
      ghlContactId: 'ghl-1',
      dncTag: 'DNC',
      progress: { dnd_set: true, tag_added: true },
    });
    assertEquals(done.ok, true);
    assertEquals(s.calls.length, 2); // nothing more
    const bad = await processDncFlagJob({
      client: createGhlClient('tok'),
      ghlContactId: null,
      dncTag: 'DNC',
      progress: {},
    });
    assertEquals(bad.ok, false);
  } finally {
    s.restore();
  }
});

// ---------------------------------------------------------------------------
// TASK-G11 (spec §1): called_by / called_by_ghl_user_id / lead_list
// ---------------------------------------------------------------------------

Deno.test(
  'buildPushCustomFields: TASK-G11 called_by, called_by_ghl_user_id, lead_list (mapped only)',
  () => {
    const mapping = { called_by: 'f-by', called_by_ghl_user_id: 'f-byid', lead_list: 'f-list' };
    const values = {
      calledBy: 'Jane Intern',
      calledByGhlUserId: 'ghl-u-9',
      leadList: 'Austin HVAC batch 3',
    };
    assertEquals(buildPushCustomFields(mapping, values), [
      { id: 'f-by', fieldValue: 'Jane Intern' },
      { id: 'f-byid', fieldValue: 'ghl-u-9' },
      { id: 'f-list', fieldValue: 'Austin HVAC batch 3' },
    ]);
    assertEquals(buildPushCustomFields({ lead_list: 'f-list' }, values), [
      { id: 'f-list', fieldValue: 'Austin HVAC batch 3' },
    ]);
    assertEquals(buildPushCustomFields(mapping, { calledBy: null, leadList: '' }), []);
  }
);

Deno.test(
  'processDispositionJob: TASK-G11 pushes called_by (context name beats payload agent_name), lead_list; never the contact owner',
  async () => {
    const bodies: Record<string, unknown> = {};
    const restore = stubFetch((url, init) => {
      if (init?.body)
        bodies[`${init.method} ${new URL(url).pathname}`] = JSON.parse(String(init.body));
      return Response.json({ id: 'ok' });
    });
    try {
      const run = (ctx: Record<string, unknown>) =>
        processDispositionJob({
          client: createGhlClient('tok'),
          locationId: 'loc-1',
          ghlContactId: 'ghl-1',
          contactFields: { firstName: 'A', lastName: 'B', phone: '+14155552671' },
          payload: PAYLOAD,
          progress: {},
          pushConfig: {
            pushFieldMapping: {
              called_by: 'f-by',
              called_by_ghl_user_id: 'f-byid',
              lead_list: 'f-list',
            },
          },
          pushTimeContext: ctx,
        });
      await run({ callerName: 'Jane Intern', callerGhlUserId: 'ghl-u-9', leadList: 'Batch 3' });
      assertEquals(bodies['PUT /contacts/ghl-1'], {
        customFields: [
          { id: 'f-by', field_value: 'Jane Intern' },
          { id: 'f-byid', field_value: 'ghl-u-9' },
          { id: 'f-list', field_value: 'Batch 3' },
        ],
      });
      assertEquals(JSON.stringify(bodies['PUT /contacts/ghl-1']).includes('assignedTo'), false);
      // no session context -> falls back to the payload's agent_name
      await run({});
      assertEquals(bodies['PUT /contacts/ghl-1'], {
        customFields: [{ id: 'f-by', field_value: 'Jane Agent' }],
      });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'processTagJob: TASK-G11 automated no-answer/voicemail also pushes called_by + lead_list',
  async () => {
    let putBody: unknown = null;
    const restore = stubFetch((_url, init) => {
      if (init?.method === 'PUT') putBody = JSON.parse(String(init.body));
      return Response.json({ id: 'ok' });
    });
    try {
      const r = await processTagJob({
        client: createGhlClient('tok'),
        locationId: 'loc-1',
        ghlContactId: 'ghl-1',
        contactFields: { firstName: 'A', lastName: 'B', phone: '+14155552671' },
        tag: 'call:no-answer-2',
        progress: { upserted: true, tag_added: true },
        pushConfig: { pushFieldMapping: { called_by: 'f-by', lead_list: 'f-list' } },
        pushTimeContext: { callerName: 'Jane Intern', leadList: 'Batch 3' },
      });
      assertEquals(r.ok, true);
      assertEquals(putBody, {
        customFields: [
          { id: 'f-by', field_value: 'Jane Intern' },
          { id: 'f-list', field_value: 'Batch 3' },
        ],
      });
    } finally {
      restore();
    }
  }
);

import { assertEquals } from 'jsr:@std/assert@1';
import { createGhlClient, type GhlClient } from './ghl-client.ts';
import {
  buildDispositionNote,
  processContactUpsertJob,
  processDispositionJob,
  type DispositionPayload,
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
  agent_name: 'Jane Agent',
  duration_seconds: 142,
  recording_url: 'https://example.com/rec/1',
  transcript_excerpt: 'Hello, this is Jane calling about...',
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
  'processDispositionJob: disposition_key "dnc" sets DND; anything else never calls setDnd',
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
        payload: { ...PAYLOAD, disposition_key: 'interested' },
        progress: {},
      });
      assertEquals(nonDnc.ok, true);
      assertEquals(dndCalls.length, 0);

      const dnc = await processDispositionJob({
        client,
        locationId: 'loc-1',
        ghlContactId: 'ghl-2',
        contactFields: { firstName: null, lastName: null, phone: '+14155552672' },
        payload: { ...PAYLOAD, disposition_key: 'dnc' },
        progress: {},
      });
      assertEquals(dnc.ok, true);
      assertEquals(dndCalls.length, 1);
    } finally {
      restore();
    }
  }
);

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

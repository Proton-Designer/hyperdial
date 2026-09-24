import { assertEquals } from 'jsr:@std/assert@1';
import {
  buildAddNotePayload,
  buildCreateTaskPayload,
  buildSearchContactsQuery,
  buildUpsertContactPayload,
  createGhlClient,
} from './ghl-client.ts';

// ---------------------------------------------------------------------------
// Pure builder tests — no network involved.
// ---------------------------------------------------------------------------

Deno.test(
  'buildUpsertContactPayload: locationId is always present; omitted fields stay omitted',
  () => {
    assertEquals(buildUpsertContactPayload({ locationId: 'loc-1' }), { locationId: 'loc-1' });
  }
);

Deno.test(
  'buildUpsertContactPayload: passes through every provided field, including dnd=false',
  () => {
    const payload = buildUpsertContactPayload({
      locationId: 'loc-1',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      phone: '+15551234567',
      timezone: 'America/New_York',
      tags: ['softdial-import'],
      dnd: false,
      source: 'softdial',
    });
    assertEquals(payload, {
      locationId: 'loc-1',
      firstName: 'Jane',
      lastName: 'Doe',
      email: 'jane@example.com',
      phone: '+15551234567',
      timezone: 'America/New_York',
      tags: ['softdial-import'],
      dnd: false,
      source: 'softdial',
    });
  }
);

Deno.test('buildSearchContactsQuery: locationId only', () => {
  assertEquals(buildSearchContactsQuery({ locationId: 'loc-1' }), 'locationId=loc-1');
});

Deno.test('buildSearchContactsQuery: includes every optional param when given', () => {
  const qs = buildSearchContactsQuery({
    locationId: 'loc-1',
    query: 'jane',
    limit: 50,
    startAfterId: 'contact-9',
    startAfter: 1700000000000,
  });
  const params = new URLSearchParams(qs);
  assertEquals(params.get('locationId'), 'loc-1');
  assertEquals(params.get('query'), 'jane');
  assertEquals(params.get('limit'), '50');
  assertEquals(params.get('startAfterId'), 'contact-9');
  assertEquals(params.get('startAfter'), '1700000000000');
});

Deno.test('buildAddNotePayload: body only when userId is omitted', () => {
  assertEquals(buildAddNotePayload({ body: 'called, left voicemail' }), {
    body: 'called, left voicemail',
  });
});

Deno.test('buildAddNotePayload: includes userId when given', () => {
  assertEquals(buildAddNotePayload({ body: 'note', userId: 'user-1' }), {
    body: 'note',
    userId: 'user-1',
  });
});

Deno.test('buildCreateTaskPayload: a new task always starts incomplete (completed: false)', () => {
  assertEquals(buildCreateTaskPayload({ title: 'Call back', dueDate: '2026-09-25T14:00:00Z' }), {
    title: 'Call back',
    dueDate: '2026-09-25T14:00:00Z',
    completed: false,
  });
});

Deno.test('buildCreateTaskPayload: includes body and assignedTo when given', () => {
  const payload = buildCreateTaskPayload({
    title: 'Call back',
    dueDate: '2026-09-25T14:00:00Z',
    body: 'Requested a callback after 2pm',
    assignedTo: 'user-1',
  });
  assertEquals(payload, {
    title: 'Call back',
    dueDate: '2026-09-25T14:00:00Z',
    completed: false,
    body: 'Requested a callback after 2pm',
    assignedTo: 'user-1',
  });
});

// ---------------------------------------------------------------------------
// Client request-shape tests — fetch is stubbed, no real network call.
// ---------------------------------------------------------------------------

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

Deno.test(
  'createGhlClient.getLocation: GET /locations/{id} with Bearer + Version headers',
  async () => {
    let seenUrl = '';
    let seenAuth: string | null = null;
    let seenVersion: string | null = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      const headers = init?.headers as Record<string, string>;
      seenAuth = headers?.Authorization ?? null;
      seenVersion = headers?.Version ?? null;
      return new Response(JSON.stringify({ location: { id: 'loc-1', name: 'Acme Sales' } }), {
        status: 200,
      });
    });
    try {
      const client = createGhlClient('test-token');
      const location = await client.getLocation('loc-1');
      assertEquals(location, { id: 'loc-1', name: 'Acme Sales' });
      assertEquals(seenUrl, 'https://services.leadconnectorhq.com/locations/loc-1');
      assertEquals(seenAuth, 'Bearer test-token');
      assertEquals(seenVersion, '2021-07-28');
    } finally {
      restore();
    }
  }
);

Deno.test('createGhlClient.getLocation: throws when the response has no location.id', async () => {
  const restore = stubFetch(() => new Response(JSON.stringify({ location: {} }), { status: 200 }));
  try {
    const client = createGhlClient('test-token');
    let threw = false;
    try {
      await client.getLocation('loc-1');
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  } finally {
    restore();
  }
});

Deno.test(
  'createGhlClient.getLocation: a non-2xx response throws with the status code',
  async () => {
    const restore = stubFetch(
      () => new Response(JSON.stringify({ message: 'invalid token' }), { status: 401 })
    );
    try {
      const client = createGhlClient('bad-token');
      let message = '';
      try {
        await client.getLocation('loc-1');
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      assertEquals(message.includes('(401)'), true);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createGhlClient.upsertContact: posts to /contacts/upsert and reads new/contact.id',
  async () => {
    let seenUrl = '';
    let seenBody: unknown = null;
    const restore = stubFetch((url, init) => {
      seenUrl = url;
      seenBody = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({ new: true, contact: { id: 'contact-1' } }), {
        status: 200,
      });
    });
    try {
      const client = createGhlClient('test-token');
      const result = await client.upsertContact({ locationId: 'loc-1', phone: '+15551234567' });
      assertEquals(result, { contactId: 'contact-1', isNew: true });
      assertEquals(seenUrl, 'https://services.leadconnectorhq.com/contacts/upsert');
      assertEquals((seenBody as { locationId: string }).locationId, 'loc-1');
    } finally {
      restore();
    }
  }
);

Deno.test(
  'createGhlClient.searchContacts: GET /contacts/ with the built query string',
  async () => {
    let seenUrl = '';
    const restore = stubFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ contacts: [{ id: 'contact-1' }], count: 1 }), {
        status: 200,
      });
    });
    try {
      const client = createGhlClient('test-token');
      const result = await client.searchContacts({ locationId: 'loc-1', query: 'jane' });
      assertEquals(result, { contacts: [{ id: 'contact-1' }], count: 1 });
      assertEquals(
        seenUrl,
        'https://services.leadconnectorhq.com/contacts/?locationId=loc-1&query=jane'
      );
    } finally {
      restore();
    }
  }
);

Deno.test('createGhlClient.addNote: posts to /contacts/{id}/notes', async () => {
  let seenUrl = '';
  const restore = stubFetch((url) => {
    seenUrl = url;
    return new Response(JSON.stringify({ id: 'note-1' }), { status: 200 });
  });
  try {
    const client = createGhlClient('test-token');
    const result = await client.addNote('contact-1', { body: 'left voicemail' });
    assertEquals(result, { noteId: 'note-1' });
    assertEquals(seenUrl, 'https://services.leadconnectorhq.com/contacts/contact-1/notes');
  } finally {
    restore();
  }
});

Deno.test('createGhlClient.addTags: posts { tags } to /contacts/{id}/tags', async () => {
  let seenBody: unknown = null;
  const restore = stubFetch((_url, init) => {
    seenBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({}), { status: 200 });
  });
  try {
    const client = createGhlClient('test-token');
    await client.addTags('contact-1', ['disposition-interested']);
    assertEquals(seenBody, { tags: ['disposition-interested'] });
  } finally {
    restore();
  }
});

Deno.test(
  'createGhlClient.createTask: posts to /contacts/{id}/tasks and reads the task id',
  async () => {
    let seenUrl = '';
    const restore = stubFetch((url) => {
      seenUrl = url;
      return new Response(JSON.stringify({ id: 'task-1' }), { status: 200 });
    });
    try {
      const client = createGhlClient('test-token');
      const result = await client.createTask('contact-1', {
        title: 'Call back',
        dueDate: '2026-09-25T14:00:00Z',
      });
      assertEquals(result, { taskId: 'task-1' });
      assertEquals(seenUrl, 'https://services.leadconnectorhq.com/contacts/contact-1/tasks');
    } finally {
      restore();
    }
  }
);

Deno.test('createGhlClient.setDnd: PUTs { dnd } to /contacts/{id}, nothing else', async () => {
  let seenUrl = '';
  let seenMethod = '';
  let seenBody: unknown = null;
  const restore = stubFetch((url, init) => {
    seenUrl = url;
    seenMethod = init?.method ?? '';
    seenBody = JSON.parse(String(init?.body ?? '{}'));
    return new Response(JSON.stringify({}), { status: 200 });
  });
  try {
    const client = createGhlClient('test-token');
    await client.setDnd('contact-1', true);
    assertEquals(seenUrl, 'https://services.leadconnectorhq.com/contacts/contact-1');
    assertEquals(seenMethod, 'PUT');
    assertEquals(seenBody, { dnd: true });
  } finally {
    restore();
  }
});

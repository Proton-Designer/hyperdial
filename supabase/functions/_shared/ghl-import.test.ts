import { assertEquals } from 'jsr:@std/assert@1';
import { createGhlClient, type GhlClient, type GhlContact } from './ghl-client.ts';
import { fetchAllGhlContacts, planGhlImport, type ExistingContactRow } from './ghl-import.ts';

// ---------------------------------------------------------------------------
// fetchAllGhlContacts -- stubbed fetch through a real createGhlClient, exercising
// the actual cursor-paging loop end to end (same stubFetch pattern as
// ghl-client.test.ts).
// ---------------------------------------------------------------------------

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function ghlContact(id: string, dateAdded: string, extra: Partial<GhlContact> = {}): GhlContact {
  return { id, dateAdded, ...extra };
}

function pageResponse(contacts: GhlContact[]) {
  return new Response(JSON.stringify({ contacts, count: contacts.length }), { status: 200 });
}

Deno.test('fetchAllGhlContacts: a single short page makes one request and stops', async () => {
  let calls = 0;
  const restore = stubFetch((url) => {
    calls++;
    const qs = new URL(url).searchParams;
    assertEquals(qs.get('startAfterId'), null);
    assertEquals(qs.get('startAfter'), null);
    return pageResponse([ghlContact('c1', '2026-01-01T00:00:00.000Z')]);
  });
  try {
    const client = createGhlClient('tok');
    const result = await fetchAllGhlContacts(client, { locationId: 'loc-1', pageLimit: 100 });
    assertEquals(calls, 1);
    assertEquals(
      result.contacts.map((c) => c.id),
      ['c1']
    );
    assertEquals(result.truncated, false);
  } finally {
    restore();
  }
});

Deno.test(
  'fetchAllGhlContacts: empty first page returns immediately with no contacts',
  async () => {
    let calls = 0;
    const restore = stubFetch(() => {
      calls++;
      return pageResponse([]);
    });
    try {
      const client = createGhlClient('tok');
      const result = await fetchAllGhlContacts(client, { locationId: 'loc-1' });
      assertEquals(calls, 1);
      assertEquals(result.contacts, []);
      assertEquals(result.truncated, false);
    } finally {
      restore();
    }
  }
);

Deno.test(
  "fetchAllGhlContacts: pages with the previous page's last contact as the cursor until a short page",
  async () => {
    const seenCursors: { startAfterId: string | null; startAfter: string | null }[] = [];
    const restore = stubFetch((url) => {
      const qs = new URL(url).searchParams;
      seenCursors.push({
        startAfterId: qs.get('startAfterId'),
        startAfter: qs.get('startAfter'),
      });
      if (seenCursors.length === 1) {
        return pageResponse([
          ghlContact('c1', '2026-01-01T00:00:00.000Z'),
          ghlContact('c2', '2026-01-02T00:00:00.000Z'),
        ]);
      }
      if (seenCursors.length === 2) {
        assertEquals(seenCursors[1].startAfterId, 'c2');
        assertEquals(seenCursors[1].startAfter, String(Date.parse('2026-01-02T00:00:00.000Z')));
        return pageResponse([ghlContact('c3', '2026-01-03T00:00:00.000Z')]);
      }
      throw new Error('unexpected third page fetch');
    });
    try {
      const client = createGhlClient('tok');
      const result = await fetchAllGhlContacts(client, { locationId: 'loc-1', pageLimit: 2 });
      assertEquals(
        result.contacts.map((c) => c.id),
        ['c1', 'c2', 'c3']
      );
      assertEquals(seenCursors.length, 2);
      assertEquals(result.truncated, false);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'fetchAllGhlContacts: stops at maxPages and reports truncated when every page was full',
  async () => {
    let calls = 0;
    const restore = stubFetch(() => {
      calls++;
      return pageResponse([ghlContact(`c${calls}`, '2026-01-01T00:00:00.000Z')]);
    });
    try {
      const client = createGhlClient('tok');
      const result = await fetchAllGhlContacts(client, {
        locationId: 'loc-1',
        pageLimit: 1,
        maxPages: 3,
      });
      assertEquals(calls, 3);
      assertEquals(result.contacts.length, 3);
      assertEquals(result.truncated, true);
    } finally {
      restore();
    }
  }
);

Deno.test('fetchAllGhlContacts: passes query through for search mode', async () => {
  const restore = stubFetch((url) => {
    const qs = new URL(url).searchParams;
    assertEquals(qs.get('query'), 'acme roofing');
    return pageResponse([]);
  });
  try {
    const client: GhlClient = createGhlClient('tok');
    await fetchAllGhlContacts(client, { locationId: 'loc-1', query: 'acme roofing' });
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// planGhlImport -- pure, no network at all.
// ---------------------------------------------------------------------------

Deno.test(
  'planGhlImport: tag mode keeps only contacts with a matching tag, case-insensitively',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: ['Hot Lead', 'roofing'] }),
      ghlContact('g2', '2026-01-01', { phone: '+14155552672', tags: ['cold'] }),
      ghlContact('g3', '2026-01-01', { phone: '+14155552673', tags: ['ROOFING'] }),
    ];
    const plan = planGhlImport({
      mode: 'tag',
      value: 'roofing',
      ghlContacts: contacts,
      existing: [],
    });
    assertEquals(plan.toInsert.map((c) => c.ghl_contact_id).sort(), ['g1', 'g3']);
    assertEquals(plan.created, 2);
    assertEquals(plan.skipped, 0);
  }
);

Deno.test('planGhlImport: search mode does not filter by tag at all', () => {
  const contacts: GhlContact[] = [
    ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: [] }),
    ghlContact('g2', '2026-01-01', { phone: '+14155552672' }),
  ];
  const plan = planGhlImport({
    mode: 'search',
    value: 'acme',
    ghlContacts: contacts,
    existing: [],
  });
  assertEquals(plan.created, 2);
});

Deno.test('planGhlImport: no phone at all is skipped, not counted invalid', () => {
  const contacts: GhlContact[] = [ghlContact('g1', '2026-01-01', {})];
  const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
  assertEquals(plan.skipped, 1);
  assertEquals(plan.invalid, 0);
  assertEquals(plan.created, 0);
});

Deno.test('planGhlImport: a provided-but-unparseable phone is both skipped and invalid', () => {
  const contacts: GhlContact[] = [ghlContact('g1', '2026-01-01', { phone: 'not-a-phone' })];
  const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
  assertEquals(plan.skipped, 1);
  assertEquals(plan.invalid, 1);
});

Deno.test(
  'planGhlImport: dedupes on ghl_contact_id first, even if the phone changed in GHL',
  () => {
    const existing: ExistingContactRow[] = [
      { id: 'db-1', phone_number: '+14155550000', ghl_contact_id: 'g1' },
    ];
    const contacts: GhlContact[] = [ghlContact('g1', '2026-01-01', { phone: '+14155559999' })];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing });
    assertEquals(plan.created, 0);
    assertEquals(plan.updated, 1);
    assertEquals(plan.toUpdate[0].id, 'db-1');
    assertEquals(plan.toUpdate[0].patch.phone_number, '+14155559999');
  }
);

Deno.test(
  'planGhlImport: falls back to phone match and stamps ghl_contact_id onto an unlinked contact',
  () => {
    const existing: ExistingContactRow[] = [
      { id: 'db-1', phone_number: '+14155552671', ghl_contact_id: null },
    ];
    const contacts: GhlContact[] = [ghlContact('g1', '2026-01-01', { phone: '+14155552671' })];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing });
    assertEquals(plan.updated, 1);
    assertEquals(plan.toUpdate[0].id, 'db-1');
    assertEquals(plan.toUpdate[0].patch.ghl_contact_id, 'g1');
  }
);

Deno.test(
  'planGhlImport: rerunning the same fetch against its own prior output creates no duplicates',
  () => {
    const contacts: GhlContact[] = [ghlContact('g1', '2026-01-01', { phone: '+14155552671' })];
    const firstRun = planGhlImport({
      mode: 'search',
      value: '',
      ghlContacts: contacts,
      existing: [],
    });
    assertEquals(firstRun.created, 1);

    // Simulate the DB after firstRun.toInsert actually landed.
    const existingAfterFirstRun: ExistingContactRow[] = [
      { id: 'db-1', phone_number: firstRun.toInsert[0].phone_number, ghl_contact_id: 'g1' },
    ];
    const secondRun = planGhlImport({
      mode: 'search',
      value: '',
      ghlContacts: contacts,
      existing: existingAfterFirstRun,
    });
    assertEquals(secondRun.created, 0);
    assertEquals(secondRun.updated, 1);
  }
);

Deno.test(
  'planGhlImport: a duplicate ghl id within the same fetched batch is skipped, not double-inserted',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '+14155552671' }),
      ghlContact('g1', '2026-01-01', { phone: '+14155552671' }),
    ];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
    assertEquals(plan.created, 1);
    assertEquals(plan.skipped, 1);
  }
);

Deno.test(
  'planGhlImport: two different GHL contacts sharing one normalized phone -- only the first is kept',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '(415) 555-2671' }),
      ghlContact('g2', '2026-01-01', { phone: '+14155552671' }),
    ];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
    assertEquals(plan.created, 1);
    assertEquals(plan.skipped, 1);
  }
);

Deno.test(
  'planGhlImport: dnd=true sets dnc=true; dnd=false or absent never forces dnc at all',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '+14155552671', dnd: true }),
      ghlContact('g2', '2026-01-01', { phone: '+14155552672', dnd: false }),
      ghlContact('g3', '2026-01-01', { phone: '+14155552673' }),
    ];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
    const byGhlId = new Map(plan.toInsert.map((c) => [c.ghl_contact_id, c]));
    assertEquals(byGhlId.get('g1')?.dnc, true);
    assertEquals('dnc' in (byGhlId.get('g2') ?? {}), false);
    assertEquals('dnc' in (byGhlId.get('g3') ?? {}), false);
  }
);

Deno.test('planGhlImport: derives timezone from the normalized phone area code when known', () => {
  const contacts: GhlContact[] = [ghlContact('g1', '2026-01-01', { phone: '+14155552671' })];
  const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
  assertEquals(plan.toInsert[0].timezone, 'America/Los_Angeles');
});

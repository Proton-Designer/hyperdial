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
      {
        id: 'db-1',
        phone_number: '+14155550000',
        ghl_contact_id: 'g1',
        dnc: false,
        ghl_tags: null,
      },
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
      {
        id: 'db-1',
        phone_number: '+14155552671',
        ghl_contact_id: null,
        dnc: false,
        ghl_tags: null,
      },
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
      {
        id: 'db-1',
        phone_number: firstRun.toInsert[0].phone_number,
        ghl_contact_id: 'g1',
        dnc: false,
        ghl_tags: firstRun.toInsert[0].ghl_tags,
      },
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

Deno.test(
  'planGhlImport: a default DNC tag sets dnc=true even when GHL dnd is false/absent (TASK-G7, GHL-7), using the built-in default list when none is passed',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', {
        phone: '+14155552671',
        dnd: false,
        tags: ['Do Not Call', 'other-tag'],
      }),
      ghlContact('g2', '2026-01-01', { phone: '+14155552672', tags: ['paused'] }),
    ];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
    const byGhlId = new Map(plan.toInsert.map((c) => [c.ghl_contact_id, c]));
    assertEquals(byGhlId.get('g1')?.dnc, true);
    assertEquals('dnc' in (byGhlId.get('g2') ?? {}), false);
  }
);

Deno.test(
  'planGhlImport: pausedGhlContactIds collects every default-paused-tagged contact, case-insensitively and whitespace-trimmed, and nothing else',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: ['  Paused  '] }),
      ghlContact('g2', '2026-01-01', { phone: '+14155552672', tags: ['DNC'] }),
      ghlContact('g3', '2026-01-01', { phone: '+14155552673' }),
    ];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
    assertEquals(plan.pausedGhlContactIds, new Set(['g1']));
  }
);

Deno.test(
  'positive control: pausedGhlContactIds would be empty for an untagged contact, proving the tag match is doing real work',
  () => {
    const contacts: GhlContact[] = [ghlContact('g1', '2026-01-01', { phone: '+14155552671' })];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
    if (plan.pausedGhlContactIds.size !== 0) {
      throw new Error('positive control failed: an untagged contact was marked paused');
    }
  }
);

Deno.test(
  'planGhlImport: an org-configured custom tag list replaces the defaults entirely -- a default tag no longer matches, a custom one does',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: ['dnc'] }), // a DEFAULT tag
      ghlContact('g2', '2026-01-01', { phone: '+14155552672', tags: ['blacklisted'] }), // the org's custom tag
    ];
    const plan = planGhlImport({
      mode: 'search',
      value: '',
      ghlContacts: contacts,
      existing: [],
      dncTags: ['blacklisted'],
    });
    const byGhlId = new Map(plan.toInsert.map((c) => [c.ghl_contact_id, c]));
    assertEquals('dnc' in (byGhlId.get('g1') ?? {}), false);
    assertEquals(byGhlId.get('g2')?.dnc, true);
  }
);

Deno.test('planGhlImport: matching is exact after trim+lowercase, not a substring match', () => {
  const contacts: GhlContact[] = [
    ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: ['dncx'] }),
  ];
  const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
  assertEquals('dnc' in (plan.toInsert[0] ?? {}), false);
});

Deno.test(
  'planGhlImport: dncTagNoteByGhlContactId cites the exact matched tag (original casing) for the dnc_numbers note, and is absent for a dnd-only DNC',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: ['Do-Not-Call'] }),
      ghlContact('g2', '2026-01-01', { phone: '+14155552672', dnd: true }),
    ];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
    assertEquals(plan.dncTagNoteByGhlContactId.get('g1'), 'GHL tag: Do-Not-Call');
    assertEquals(plan.dncTagNoteByGhlContactId.has('g2'), false);
  }
);

Deno.test(
  'planGhlImport: a contact previously paused (per its stored ghl_tags) that no longer carries a paused tag increments unpausedCount',
  () => {
    const existing: ExistingContactRow[] = [
      {
        id: 'db-1',
        phone_number: '+14155552671',
        ghl_contact_id: 'g1',
        dnc: false,
        ghl_tags: ['paused', 'roofing'],
      },
    ];
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: ['roofing'] }),
    ];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing });
    assertEquals(plan.unpausedCount, 1);
    assertEquals(plan.pausedGhlContactIds.has('g1'), false);
  }
);

Deno.test(
  'planGhlImport: a contact that was never paused before does not count toward unpausedCount, even if it is unpaused now',
  () => {
    const existing: ExistingContactRow[] = [
      {
        id: 'db-1',
        phone_number: '+14155552671',
        ghl_contact_id: 'g1',
        dnc: false,
        ghl_tags: ['roofing'],
      },
    ];
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: ['roofing'] }),
    ];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing });
    assertEquals(plan.unpausedCount, 0);
  }
);

Deno.test(
  'planGhlImport: still paused this run does not count as unpaused, and a brand-new contact (no prior row) never counts',
  () => {
    const existing: ExistingContactRow[] = [
      {
        id: 'db-1',
        phone_number: '+14155552671',
        ghl_contact_id: 'g1',
        dnc: false,
        ghl_tags: ['paused'],
      },
    ];
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: ['paused'] }), // still paused
      ghlContact('g2', '2026-01-01', { phone: '+14155552672', tags: [] }), // brand new, never paused
    ];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing });
    assertEquals(plan.unpausedCount, 0);
    assertEquals(plan.pausedGhlContactIds, new Set(['g1']));
  }
);

Deno.test('planGhlImport: a paused contact is still inserted/updated normally, not skipped', () => {
  const contacts: GhlContact[] = [
    ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: ['paused'] }),
  ];
  const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
  assertEquals(plan.created, 1);
  assertEquals(plan.toInsert[0].ghl_contact_id, 'g1');
});

Deno.test("planGhlImport: stores the contact's raw GHL tags on every insert and update", () => {
  const existing: ExistingContactRow[] = [
    { id: 'db-1', phone_number: '+14155552672', ghl_contact_id: 'g2', dnc: false, ghl_tags: null },
  ];
  const contacts: GhlContact[] = [
    ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: ['roofing', 'hot'] }),
    ghlContact('g2', '2026-01-01', { phone: '+14155552672', tags: ['cold'] }),
  ];
  const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing });
  assertEquals(plan.toInsert[0].ghl_tags, ['roofing', 'hot']);
  assertEquals(plan.toUpdate[0].patch.ghl_tags, ['cold']);
});

Deno.test('planGhlImport: derives timezone from the normalized phone area code when known', () => {
  const contacts: GhlContact[] = [ghlContact('g1', '2026-01-01', { phone: '+14155552671' })];
  const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing: [] });
  assertEquals(plan.toInsert[0].timezone, 'America/Los_Angeles');
});

// ---------------------------------------------------------------------------
// TASK-T1 (MISSION-4, GHL-3/4/6/8) additions
// ---------------------------------------------------------------------------

Deno.test(
  'planGhlImport: stage mode does no client-side tag filtering, same as search mode',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', { phone: '+14155552671', tags: [] }),
    ];
    const plan = planGhlImport({
      mode: 'stage',
      value: 'stage-1',
      ghlContacts: contacts,
      existing: [],
    });
    assertEquals(plan.created, 1);
  }
);

Deno.test('planGhlImport: no enrichment (default) sets none of the new fields', () => {
  const contacts: GhlContact[] = [
    ghlContact('g1', '2026-01-01', {
      phone: '+14155552671',
      pipelineStageId: 'stage-1',
      assignedTo: 'ghl-user-1',
      customFields: [{ id: 'f1', value: 'Ace Roofing' }],
    } as Partial<GhlContact>),
  ];
  const plan = planGhlImport({
    mode: 'stage',
    value: 'stage-1',
    ghlContacts: contacts,
    existing: [],
  });
  assertEquals(plan.toInsert[0].ghl_pipeline_stage, undefined);
  assertEquals(plan.toInsert[0].ghl_custom_fields, undefined);
  assertEquals(plan.toInsert[0].assigned_user_id, undefined);
});

Deno.test(
  'planGhlImport: resolves stage name, custom fields, and assigned owner when enrichment is provided',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', {
        phone: '+14155552671',
        pipelineStageId: 'stage-1',
        assignedTo: 'ghl-user-1',
        customFields: [
          { id: 'f1', value: 'RF-1234' },
          { id: 'f-unmapped', value: 'ignored' },
        ],
      } as Partial<GhlContact>),
    ];
    const plan = planGhlImport({
      mode: 'stage',
      value: 'stage-1',
      ghlContacts: contacts,
      existing: [],
      enrichment: {
        stageNameByPipelineStageId: { 'stage-1': 'Qualified' },
        fieldMappingByGhlFieldId: { f1: 'license_number' },
        orgMemberIdByGhlUserId: { 'ghl-user-1': 'user-abc' },
      },
    });
    assertEquals(plan.toInsert[0].ghl_pipeline_stage, 'Qualified');
    assertEquals(plan.toInsert[0].ghl_custom_fields, { license_number: 'RF-1234' });
    assertEquals(plan.toInsert[0].assigned_user_id, 'user-abc');
  }
);

Deno.test(
  'planGhlImport: business_name/website/rating/review_count map onto their existing dedicated columns, not into ghl_custom_fields',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', {
        phone: '+14155552671',
        customFields: [
          { id: 'f-name', value: '  Ace Roofing  ' },
          { id: 'f-site', value: 'https://aceroofing.example' },
          { id: 'f-rating', value: '4.5' },
          { id: 'f-reviews', value: '127' },
        ],
      } as Partial<GhlContact>),
    ];
    const plan = planGhlImport({
      mode: 'search',
      value: '',
      ghlContacts: contacts,
      existing: [],
      enrichment: {
        fieldMappingByGhlFieldId: {
          'f-name': 'business_name',
          'f-site': 'website',
          'f-rating': 'rating',
          'f-reviews': 'review_count',
        },
      },
    });
    const inserted = plan.toInsert[0];
    assertEquals(inserted.business_name, 'Ace Roofing');
    assertEquals(inserted.website, 'https://aceroofing.example');
    assertEquals(inserted.rating, 4.5);
    assertEquals(inserted.review_count, 127);
    assertEquals(inserted.ghl_custom_fields, undefined);
  }
);

Deno.test(
  'planGhlImport: an unparseable rating/review_count value is dropped, not written as NaN',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', {
        phone: '+14155552671',
        customFields: [{ id: 'f-rating', value: 'not-a-number' }],
      } as Partial<GhlContact>),
    ];
    const plan = planGhlImport({
      mode: 'search',
      value: '',
      ghlContacts: contacts,
      existing: [],
      enrichment: { fieldMappingByGhlFieldId: { 'f-rating': 'rating' } },
    });
    assertEquals(plan.toInsert[0].rating, undefined);
  }
);

Deno.test(
  'planGhlImport: an unmapped stage id / assignee / custom field is simply left unset, never guessed',
  () => {
    const contacts: GhlContact[] = [
      ghlContact('g1', '2026-01-01', {
        phone: '+14155552671',
        pipelineStageId: 'stage-unknown',
        assignedTo: 'ghl-user-unknown',
        customFields: [{ id: 'f-unknown', value: 'x' }],
      } as Partial<GhlContact>),
    ];
    const plan = planGhlImport({
      mode: 'stage',
      value: 'stage-unknown',
      ghlContacts: contacts,
      existing: [],
      enrichment: {
        stageNameByPipelineStageId: { 'stage-1': 'Qualified' },
        fieldMappingByGhlFieldId: { f1: 'business_name' },
        orgMemberIdByGhlUserId: { 'ghl-user-1': 'user-abc' },
      },
    });
    assertEquals(plan.toInsert[0].ghl_pipeline_stage, undefined);
    assertEquals(plan.toInsert[0].ghl_custom_fields, undefined);
    assertEquals(plan.toInsert[0].assigned_user_id, undefined);
  }
);

Deno.test(
  're-importing a contact with no stage this run (e.g. via a tag-mode re-pull) does not blank out a stage stored by an earlier stage-mode pull',
  () => {
    const existing: ExistingContactRow[] = [
      {
        id: 'db-1',
        phone_number: '+14155552671',
        ghl_contact_id: 'g1',
        dnc: false,
        ghl_tags: null,
      },
    ];
    const contacts: GhlContact[] = [ghlContact('g1', '2026-01-01', { phone: '+14155552671' })];
    const plan = planGhlImport({ mode: 'search', value: '', ghlContacts: contacts, existing });
    // The patch simply never mentions ghl_pipeline_stage -- an UPDATE with this patch leaves the
    // column's existing DB value untouched, which is the actual behavior being proven here (this
    // test only proves the PLANNER'S contribution to that: it must not emit an explicit
    // `ghl_pipeline_stage: undefined`/null override).
    assertEquals('ghl_pipeline_stage' in plan.toUpdate[0].patch, false);
  }
);

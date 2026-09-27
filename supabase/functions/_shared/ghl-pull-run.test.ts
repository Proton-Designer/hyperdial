import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import type { GhlClient, GhlContact, GhlOpportunity } from './ghl-client.ts';
import { runGhlPullForOrg, runGhlPullMapping, type GhlCampaignMappingRow } from './ghl-pull-run.ts';

// ---------------------------------------------------------------------------
// A small multi-table fake supabase -- purpose-built for exactly the query shapes
// runGhlPullMapping/campaign-queue-io.ts send (same "bespoke per-table dispatcher, not a generic
// ORM" convention as billing-core.test.ts's own fake). Every builder method is chainable; the
// final await resolves via `then()` unless `.maybeSingle()`/`.single()` is called instead.
// ---------------------------------------------------------------------------

interface Tables {
  org_members: { org_id: string; user_id: string; role: string }[];
  contacts: Record<string, unknown>[];
  dnc_numbers: { org_id: string; e164: string; note?: string }[];
  campaign_leads: { campaign_id: string; contact_id: string; org_id: string; status: string }[];
}

function makeFakeSupabase(seed: Partial<Tables> = {}) {
  const tables: Tables = {
    org_members: seed.org_members ?? [],
    contacts: seed.contacts ?? [],
    dnc_numbers: seed.dnc_numbers ?? [],
    campaign_leads: seed.campaign_leads ?? [],
  };
  let nextContactId = 1;

  function from(table: keyof Tables) {
    const filters: ((r: Record<string, unknown>) => boolean)[] = [];
    let mode: 'select' | 'insert' | 'update' | 'upsert' = 'select';
    let insertRows: Record<string, unknown>[] | null = null;
    let updatePatch: Record<string, unknown> | null = null;
    let limitN: number | null = null;

    function apply(): Record<string, unknown>[] {
      return (tables[table] as Record<string, unknown>[]).filter((r) => filters.every((f) => f(r)));
    }

    function runWrite(): { data: unknown; error: null } {
      if (mode === 'insert' || mode === 'upsert') {
        const inserted = (insertRows ?? []).map((values) => {
          if (table === 'contacts' && !values.id) {
            return { id: `c-${nextContactId++}`, ...values };
          }
          return { ...values };
        });
        (tables[table] as Record<string, unknown>[]).push(...inserted);
        return { data: inserted, error: null };
      }
      if (mode === 'update') {
        const matched = apply();
        for (const r of matched) Object.assign(r, updatePatch);
        return { data: null, error: null };
      }
      return { data: apply(), error: null };
    }

    const builder = {
      select(_cols?: string) {
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push((r) => r[col] === val);
        return builder;
      },
      neq(col: string, val: unknown) {
        filters.push((r) => r[col] !== val);
        return builder;
      },
      in(col: string, vals: unknown[]) {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      order(_col: string) {
        return builder;
      },
      range(_from: number, _to: number) {
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      insert(values: Record<string, unknown> | Record<string, unknown>[]) {
        mode = 'insert';
        insertRows = Array.isArray(values) ? values : [values];
        return builder;
      },
      update(patch: Record<string, unknown>) {
        mode = 'update';
        updatePatch = patch;
        return builder;
      },
      upsert(values: Record<string, unknown> | Record<string, unknown>[], _opts?: unknown) {
        mode = 'upsert';
        insertRows = Array.isArray(values) ? values : [values];
        return builder;
      },
      async maybeSingle() {
        const matched = apply();
        const limited = limitN !== null ? matched.slice(0, limitN) : matched;
        return { data: limited[0] ?? null, error: null };
      },
      async single() {
        if (mode === 'insert' || mode === 'upsert') {
          const res = runWrite();
          const rows = res.data as Record<string, unknown>[];
          return { data: rows[0] ?? null, error: null };
        }
        const matched = apply();
        return { data: matched[0] ?? null, error: null };
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return Promise.resolve(runWrite()).then(resolve, reject);
      },
    };
    return builder;
  }

  return { tables, from };
}

// ---------------------------------------------------------------------------
// A minimal fake GhlClient -- only the methods runGhlPullMapping actually calls.
// ---------------------------------------------------------------------------

function makeFakeGhlClient(overrides: Partial<GhlClient> = {}): GhlClient {
  return {
    getLocation: async () => ({ id: 'loc-1', name: 'Test Location' }),
    upsertContact: async () => ({ contactId: 'x', isNew: true }),
    searchContacts: async () => ({ contacts: [], count: 0 }),
    addNote: async () => ({ noteId: 'n1' }),
    addTags: async () => {},
    createTask: async () => ({ taskId: 't1' }),
    setDnd: async () => {},
    getContact: async (id: string) => ({ id, phone: '+14155552671' }) as GhlContact,
    searchOpportunities: async () => ({ opportunities: [], count: 0 }),
    getPipelines: async () => [],
    listUsers: async () => [],
    listContactCustomFieldDefs: async () => [],
    ...overrides,
  } as unknown as GhlClient;
}

const ORG = 'org-1';
const OWNER = 'owner-1';
const TAG_MAPPING: GhlCampaignMappingRow = {
  id: 'map-1',
  match_type: 'tag',
  tag: 'roofing',
  pipeline_stage_id: null,
  campaign_id: 'campaign-1',
};
const STAGE_MAPPING: GhlCampaignMappingRow = {
  id: 'map-2',
  match_type: 'stage',
  tag: null,
  pipeline_stage_id: 'stage-1',
  campaign_id: 'campaign-1',
};

Deno.test(
  'runGhlPullMapping (tag): creates a contact and queues it onto the mapped campaign',
  async () => {
    const supabase = makeFakeSupabase({
      org_members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }],
    });
    const client = makeFakeGhlClient({
      searchContacts: async () => ({
        contacts: [{ id: 'g1', phone: '+14155552671', tags: ['roofing'] } as GhlContact],
        count: 1,
      }),
    });
    const result = await runGhlPullMapping(supabase, client, {
      orgId: ORG,
      locationId: 'loc-1',
      mapping: TAG_MAPPING,
    });
    assertEquals(result.created, 1);
    assertEquals(result.error, undefined);
    assertEquals(supabase.tables.contacts.length, 1);
    assertEquals(supabase.tables.contacts[0].user_id, OWNER);
    assertEquals(supabase.tables.campaign_leads.length, 1);
    assertEquals(supabase.tables.campaign_leads[0].campaign_id, 'campaign-1');
  }
);

Deno.test(
  'runGhlPullMapping (stage): pages opportunities, fetches contact detail, stamps the stage',
  async () => {
    const supabase = makeFakeSupabase({
      org_members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }],
    });
    const client = makeFakeGhlClient({
      searchOpportunities: async () => ({
        opportunities: [
          {
            id: 'o1',
            pipelineId: 'p1',
            pipelineStageId: 'stage-1',
            contactId: 'g1',
          } as GhlOpportunity,
        ],
        count: 1,
      }),
      getContact: async (id: string) =>
        ({ id, phone: '+14155552671', dateUpdated: '2026-09-26T00:00:00Z' }) as GhlContact,
    });
    const result = await runGhlPullMapping(supabase, client, {
      orgId: ORG,
      locationId: 'loc-1',
      mapping: STAGE_MAPPING,
      enrichment: { stageNameByPipelineStageId: { 'stage-1': 'Qualified' } },
    });
    assertEquals(result.created, 1);
    assertEquals(supabase.tables.contacts[0].ghl_pipeline_stage, 'Qualified');
    assertEquals(result.maxDateUpdatedIso, '2026-09-26T00:00:00.000Z');
  }
);

Deno.test(
  'runGhlPullMapping: a contact whose dateUpdated is at or before the cursor is excluded from the plan',
  async () => {
    const supabase = makeFakeSupabase({
      org_members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }],
    });
    const client = makeFakeGhlClient({
      searchContacts: async () => ({
        contacts: [
          {
            id: 'g1',
            phone: '+14155552671',
            tags: ['roofing'],
            dateUpdated: '2026-09-01T00:00:00Z',
          } as GhlContact,
        ],
        count: 1,
      }),
    });
    const result = await runGhlPullMapping(supabase, client, {
      orgId: ORG,
      locationId: 'loc-1',
      mapping: TAG_MAPPING,
      sinceDate: new Date('2026-09-15T00:00:00Z'),
    });
    assertEquals(result.created, 0);
    assertEquals(supabase.tables.contacts.length, 0);
  }
);

Deno.test('runGhlPullMapping: a contact updated AFTER the cursor is still included', async () => {
  const supabase = makeFakeSupabase({
    org_members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }],
  });
  const client = makeFakeGhlClient({
    searchContacts: async () => ({
      contacts: [
        {
          id: 'g1',
          phone: '+14155552671',
          tags: ['roofing'],
          dateUpdated: '2026-09-20T00:00:00Z',
        } as GhlContact,
      ],
      count: 1,
    }),
  });
  const result = await runGhlPullMapping(supabase, client, {
    orgId: ORG,
    locationId: 'loc-1',
    mapping: TAG_MAPPING,
    sinceDate: new Date('2026-09-15T00:00:00Z'),
  });
  assertEquals(result.created, 1);
});

Deno.test(
  'runGhlPullMapping: a DNC-tagged contact is created but never queued onto the campaign',
  async () => {
    const supabase = makeFakeSupabase({
      org_members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }],
    });
    const client = makeFakeGhlClient({
      searchContacts: async () => ({
        contacts: [{ id: 'g1', phone: '+14155552671', tags: ['roofing', 'dnc'] } as GhlContact],
        count: 1,
      }),
    });
    const result = await runGhlPullMapping(supabase, client, {
      orgId: ORG,
      locationId: 'loc-1',
      mapping: TAG_MAPPING,
    });
    assertEquals(result.created, 1);
    assertEquals(result.dncTagged, 1);
    assertEquals(supabase.tables.campaign_leads.length, 0);
    assertExists(supabase.tables.dnc_numbers.find((r) => r.e164 === '+14155552671'));
  }
);

Deno.test(
  'runGhlPullMapping: one throwing mapping does not stop runGhlPullForOrg from running the rest',
  async () => {
    const supabase = makeFakeSupabase({
      org_members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }],
    });
    const client = makeFakeGhlClient({
      searchContacts: async () => {
        throw new Error('GHL API GET /contacts/ failed (500): {}');
      },
      searchOpportunities: async () => ({
        opportunities: [
          {
            id: 'o1',
            pipelineId: 'p1',
            pipelineStageId: 'stage-1',
            contactId: 'g1',
          } as GhlOpportunity,
        ],
        count: 1,
      }),
      getContact: async (id: string) => ({ id, phone: '+14155552671' }) as GhlContact,
    });
    const result = await runGhlPullForOrg(supabase, client, {
      orgId: ORG,
      locationId: 'loc-1',
      mappings: [TAG_MAPPING, STAGE_MAPPING],
    });
    assertEquals(result.results.length, 2);
    assertExists(result.results[0].error);
    assertEquals(result.results[1].error, undefined);
    assertEquals(result.results[1].created, 1);
  }
);

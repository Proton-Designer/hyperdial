import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { GhlClient, GhlContact } from './ghl-client.ts';
import { intakeWebhookContact, type IntakeMapping, type IntakeOrg } from './ghl-intake.ts';
import { handleGhlWebhook } from './ghl-webhook-run.ts';
import { generateWebhookSecret, sha256Hex } from './ghl-webhook.ts';

// A small multi-table fake supabase for exactly the query shapes the shared import path, the intake log and the
// enrichment builder send (same bespoke-dispatcher approach as ghl-pull-run.test.ts).
interface Tables {
  org_members: { org_id: string; user_id: string; role: string }[];
  contacts: Record<string, unknown>[];
  dnc_numbers: { org_id: string; e164: string; note?: string }[];
  campaign_leads: { campaign_id: string; contact_id: string; org_id: string; status: string }[];
  org_ghl_campaign_mappings: { id: string; ghl_pull_cursor: string | null }[];
  ghl_intake_log: Record<string, unknown>[];
}

function makeFakeSupabase(seed: Partial<Tables> = {}) {
  const tables: Tables = {
    org_members: seed.org_members ?? [],
    contacts: seed.contacts ?? [],
    dnc_numbers: seed.dnc_numbers ?? [],
    campaign_leads: seed.campaign_leads ?? [],
    org_ghl_campaign_mappings: seed.org_ghl_campaign_mappings ?? [],
    ghl_intake_log: seed.ghl_intake_log ?? [],
  };
  let nextContactId = 1;

  function from(table: keyof Tables) {
    const filters: ((r: Record<string, unknown>) => boolean)[] = [];
    let mode: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select';
    let insertRows: Record<string, unknown>[] | null = null;
    let updatePatch: Record<string, unknown> | null = null;
    let limitN: number | null = null;

    function apply(): Record<string, unknown>[] {
      return (tables[table] as Record<string, unknown>[]).filter((r) => filters.every((f) => f(r)));
    }

    function runWrite(): { data: unknown; error: null } {
      if (mode === 'delete') {
        const rows = tables[table] as Record<string, unknown>[];
        const doomed = new Set(apply());
        tables[table] = rows.filter((r) => !doomed.has(r)) as never;
        return { data: null, error: null };
      }
      if (mode === 'insert' || mode === 'upsert') {
        const inserted = (insertRows ?? [])
          .filter(
            (values) =>
              !(
                mode === 'upsert' &&
                table === 'campaign_leads' &&
                (tables.campaign_leads as Record<string, unknown>[]).some(
                  (r) => r.campaign_id === values.campaign_id && r.contact_id === values.contact_id
                )
              )
          )
          .map((values) => {
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
      not(col: string, _op: string, _val: unknown) {
        filters.push((r) => r[col] !== null && r[col] !== undefined);
        return builder;
      },
      lt(col: string, val: unknown) {
        filters.push((r) => String(r[col]) < String(val));
        return builder;
      },
      or(expr: string) {
        const parts = expr.split(',').map((p) => {
          const [col, , ...rest] = p.split('.');
          return [col, rest.join('.')] as const;
        });
        filters.push((r) => parts.some(([col, val]) => r[col] === val));
        return builder;
      },
      delete() {
        mode = 'delete';
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

function makeGhl(opts: {
  contact?: Partial<GhlContact> | null;
  opps?: { contactId: string; pipelineStageId: string }[];
  getError?: string;
  reads?: string[];
}): GhlClient {
  return {
    getContact: async (id: string) => {
      opts.reads?.push(id);
      if (opts.getError) throw new Error(opts.getError);
      return { id, phone: '+14155552671', tags: [], ...opts.contact } as GhlContact;
    },
    searchOpportunities: async () => ({
      opportunities: opts.opps ?? [],
      count: (opts.opps ?? []).length,
    }),
    getPipelines: async () => [],
  } as unknown as GhlClient;
}

const ORG = 'org-1';
const OWNER = 'owner-1';
const ORG_ROW: IntakeOrg = { org_id: ORG, location_id: 'loc1' };
const TAG: IntakeMapping = {
  id: 'm1',
  match_type: 'tag',
  tag: 'Roofing',
  pipeline_stage_id: null,
  campaign_id: 'camp-1',
  created_at: '2026-01-02T00:00:00Z',
};
const STAGE: IntakeMapping = {
  id: 'm2',
  match_type: 'stage',
  tag: null,
  pipeline_stage_id: 'stage-1',
  campaign_id: 'camp-2',
  created_at: '2026-01-01T00:00:00Z',
};
const seedOwner = () =>
  makeFakeSupabase({ org_members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }] });
const run = (
  db: ReturnType<typeof makeFakeSupabase>,
  ghl: GhlClient,
  mappings: IntakeMapping[],
  org: IntakeOrg = ORG_ROW,
  id = 'g1',
  logNoMatch = true
) => intakeWebhookContact(db, ghl, org, mappings, id, { logNoMatch });

Deno.test(
  'intake: tag match -> contact created, lead queued once, list_name GHL (auto), logged',
  async () => {
    const db = seedOwner();
    const r = await run(db, makeGhl({ contact: { tags: ['roofing', 'x'] } }), [TAG]);
    assertEquals([r.outcome, r.campaignId, r.logged], ['queued', 'camp-1', true]);
    assertEquals(db.tables.contacts.length, 1);
    assertEquals(db.tables.campaign_leads.length, 1);
    assertEquals(db.tables.campaign_leads[0].status, 'queued');
    assertEquals((db.tables.campaign_leads[0] as Record<string, unknown>).list_name, 'GHL (auto)');
    assertEquals(db.tables.ghl_intake_log.length, 1);
    assertEquals(db.tables.ghl_intake_log[0].outcome, 'queued');
    assertEquals(db.tables.ghl_intake_log[0].campaign_id, 'camp-1');
  }
);

Deno.test(
  'intake: duplicate delivery -> still one contact, one lead; second outcome already_queued',
  async () => {
    const db = seedOwner();
    const ghl = makeGhl({ contact: { tags: ['roofing'] } });
    assertEquals((await run(db, ghl, [TAG])).outcome, 'queued');
    assertEquals((await run(db, ghl, [TAG])).outcome, 'already_queued');
    assertEquals(db.tables.contacts.length, 1);
    assertEquals(db.tables.campaign_leads.length, 1);
  }
);

Deno.test('intake: existing list_name is never overwritten', async () => {
  const db = seedOwner();
  const ghl = makeGhl({ contact: { tags: ['roofing'] } });
  await run(db, ghl, [TAG]);
  (db.tables.campaign_leads[0] as Record<string, unknown>).list_name = 'My list';
  await run(db, ghl, [TAG]);
  assertEquals((db.tables.campaign_leads[0] as Record<string, unknown>).list_name, 'My list');
});

Deno.test(
  'intake: contact matching no mapping -> no write at all, no_matching_rule logged',
  async () => {
    const db = seedOwner();
    const r = await run(db, makeGhl({ contact: { tags: ['plumbing'] } }), [TAG]);
    assertEquals([r.outcome, r.logged], ['no_matching_rule', true]);
    assertEquals([db.tables.contacts.length, db.tables.campaign_leads.length], [0, 0]);
    assertEquals(db.tables.ghl_intake_log[0].outcome, 'no_matching_rule');
  }
);

Deno.test('intake: no-match is not logged when the event was not a new-lead trigger', async () => {
  const db = seedOwner();
  const r = await run(db, makeGhl({ contact: { tags: [] } }), [TAG], ORG_ROW, 'g1', false);
  assertEquals(
    [r.outcome, r.logged, db.tables.ghl_intake_log.length],
    ['no_matching_rule', false, 0]
  );
});

Deno.test('intake: DNC-tagged contact is saved as DNC and NOT queued (skipped_dnc)', async () => {
  const db = seedOwner();
  const r = await run(db, makeGhl({ contact: { tags: ['roofing', 'dnc'] } }), [TAG]);
  assertEquals(r.outcome, 'skipped_dnc');
  assertEquals(db.tables.campaign_leads.length, 0);
  assertEquals(db.tables.contacts[0].dnc, true);
  assertEquals(db.tables.dnc_numbers.length, 1);
});

Deno.test('intake: GHL do-not-disturb contact -> skipped_dnc', async () => {
  const db = seedOwner();
  const r = await run(db, makeGhl({ contact: { tags: ['roofing'], dnd: true } }), [TAG]);
  assertEquals([r.outcome, db.tables.campaign_leads.length], ['skipped_dnc', 0]);
});

Deno.test('intake: paused-tagged contact -> skipped_paused, not queued', async () => {
  const db = seedOwner();
  const r = await run(db, makeGhl({ contact: { tags: ['roofing', 'Paused'] } }), [TAG]);
  assertEquals([r.outcome, db.tables.campaign_leads.length], ['skipped_paused', 0]);
});

Deno.test(
  'intake: contact already active in ANOTHER campaign -> skipped_active_elsewhere',
  async () => {
    const db = makeFakeSupabase({
      org_members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }],
      contacts: [
        {
          id: 'c-9',
          org_id: ORG,
          ghl_contact_id: 'g1',
          phone_number: '+14155552671',
          dnc: false,
          ghl_tags: [],
        },
      ],
      campaign_leads: [{ campaign_id: 'other', contact_id: 'c-9', org_id: ORG, status: 'queued' }],
    });
    const r = await run(db, makeGhl({ contact: { tags: ['roofing'] } }), [TAG]);
    assertEquals(r.outcome, 'skipped_active_elsewhere');
    assertEquals(db.tables.campaign_leads.length, 1);
    assertEquals(db.tables.contacts.length, 1); // matched by ghl id, updated not duplicated
  }
);

Deno.test('intake: contact with no usable phone -> error outcome, nothing written', async () => {
  const db = seedOwner();
  const r = await run(db, makeGhl({ contact: { tags: ['roofing'], phone: '' } }), [TAG]);
  assertEquals(r.outcome, 'error');
  assertEquals([db.tables.contacts.length, db.tables.campaign_leads.length], [0, 0]);
});

Deno.test(
  'intake: several mappings -> the first by created_at wins (stage before tag here)',
  async () => {
    const db = seedOwner();
    const ghl = makeGhl({
      contact: { tags: ['roofing'] },
      opps: [{ contactId: 'g1', pipelineStageId: 'stage-1' }],
    });
    const r = await run(db, ghl, [TAG, STAGE]);
    assertEquals([r.outcome, r.campaignId], ['queued', 'camp-2']);
    assertEquals(
      db.tables.campaign_leads.map((l) => l.campaign_id),
      ['camp-2']
    );
  }
);

Deno.test(
  'intake: stage mapping matches only an opportunity of THIS contact in that stage',
  async () => {
    const dbMiss = seedOwner();
    const miss = await run(
      dbMiss,
      makeGhl({ opps: [{ contactId: 'someone-else', pipelineStageId: 'stage-1' }] }),
      [STAGE]
    );
    assertEquals(miss.outcome, 'no_matching_rule');
    const dbHit = seedOwner();
    const hit = await run(
      dbHit,
      makeGhl({ opps: [{ contactId: 'g1', pipelineStageId: 'stage-1' }] }),
      [STAGE]
    );
    assertEquals(hit.outcome, 'queued');
  }
);

Deno.test(
  'intake: unreadable contact (GHL 404) -> error logged, no write; transient (503) -> rethrown for a GHL retry',
  async () => {
    const db = seedOwner();
    const r = await run(
      db,
      makeGhl({ getError: 'GHL API GET /contacts/g1 failed (404): not found' }),
      [TAG]
    );
    assertEquals(
      [r.outcome, db.tables.contacts.length, db.tables.ghl_intake_log[0].outcome],
      ['error', 0, 'error']
    );
    let thrown = false;
    try {
      await run(db, makeGhl({ getError: 'GHL API GET /contacts/g1 failed (503): down' }), [TAG]);
    } catch {
      thrown = true;
    }
    assert(thrown);
  }
);

Deno.test('intake: log rows older than 30 days are pruned on the next insert', async () => {
  const db = makeFakeSupabase({
    org_members: [{ org_id: ORG, user_id: OWNER, role: 'owner' }],
    ghl_intake_log: [
      { org_id: ORG, received_at: '2020-01-01T00:00:00Z', outcome: 'queued' },
      { org_id: 'org-2', received_at: '2020-01-01T00:00:00Z', outcome: 'queued' },
    ],
  });
  await run(db, makeGhl({ contact: { tags: ['roofing'] } }), [TAG]);
  const orgs = db.tables.ghl_intake_log.map((l) => l.org_id).sort();
  assertEquals(orgs, ['org-1', 'org-2']); // only this org's stale row was pruned
});

// ---------------------------------------------------------------------------------------------------
// ghl-webhook end to end (auth + org + event + intake) over the same fake database
// ---------------------------------------------------------------------------------------------------

const WH_ORG = {
  org_id: ORG,
  location_id: 'loc1',
  ghl_reconcile_enabled: false,
  ghl_dnc_tags: null,
  ghl_paused_tags: null,
  ghl_exclude_tags: null,
  ghl_exclude_stage_ids: null,
  ghl_pull_enabled: true,
  ghl_field_mapping: null,
};

async function webhookWorld(
  opts: {
    org?: Record<string, unknown>;
    mappings?: IntakeMapping[];
    accepts?: string[];
    ghl?: GhlClient;
  } = {}
) {
  const secret = generateWebhookSecret();
  const hash = await sha256Hex(secret);
  const db = seedOwner();
  const rpcCalls: string[] = [];
  const seen = new Set<string>();
  const reads: string[] = [];
  const supabase = {
    from(table: string) {
      if (table === 'ghl_webhook_state') {
        const f: Record<string, unknown> = {};
        const c: Record<string, unknown> = {
          eq: (_k: string, v: unknown) => {
            f.hash = v;
            return c;
          },
          select: () => c,
          maybeSingle: async () => ({
            data: f.hash === hash ? { org_id: ORG } : null,
            error: null,
          }),
        };
        return c;
      }
      if (table === 'org_integrations') {
        const c: Record<string, unknown> = {
          select: () => c,
          eq: () => c,
          maybeSingle: async () => ({ data: { ...WH_ORG, ...opts.org }, error: null }),
        };
        return c;
      }
      if (table === 'org_ghl_campaign_mappings') {
        const c: Record<string, unknown> = {
          select: () => c,
          eq: () => c,
          then: (res: (v: unknown) => unknown) =>
            Promise.resolve({ data: opts.mappings ?? [TAG], error: null }).then(res),
        };
        return c;
      }
      return db.from(table as never);
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push(fn);
      if (fn === 'ghl_webhook_accept') {
        const forced = opts.accepts?.shift();
        if (forced) return { data: forced, error: null };
        const h = String(args.p_hash);
        if (seen.has(h)) return { data: 'duplicate', error: null };
        seen.add(h);
        return { data: 'ok', error: null };
      }
      if (fn === 'ghl_webhook_forget') {
        seen.delete(String(args.p_hash));
        return { data: null, error: null };
      }
      if (fn === 'get_org_ghl_token') return { data: 'tok', error: null };
      return { data: null, error: null };
    },
  };
  const ghl =
    opts.ghl ??
    ({
      getContact: async (id: string) => {
        reads.push(id);
        return { id, phone: '+14155552671', tags: ['roofing'] } as GhlContact;
      },
      searchOpportunities: async () => ({ opportunities: [], count: 0 }),
      getPipelines: async () => [],
    } as unknown as GhlClient);
  const send = (
    body: unknown,
    headers: Record<string, string> = { 'x-hyperdial-webhook-secret': secret }
  ) => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    return handleGhlWebhook(
      { supabase, makeClient: () => ghl },
      { method: 'POST', headers: new Headers(headers), rawBody: raw }
    );
  };
  return { send, db, rpcCalls, reads, secret };
}

// what a GHL workflow "Custom Webhook" sends: no `type`, contact_id, location.id, tags as one comma string
const WORKFLOW_BODY = {
  contact_id: 'g1',
  first_name: 'Dana',
  tags: 'roofing, new lead',
  location: { id: 'loc1', name: 'My Business' },
};

Deno.test(
  'webhook intake: workflow payload (no type, contact_id, location.id, comma tags) -> queued, response says so',
  async () => {
    const w = await webhookWorld();
    const r = await w.send(WORKFLOW_BODY);
    assertEquals(r.status, 200);
    assertEquals((r.body.intake as { outcome: string }).outcome, 'queued');
    assertEquals(w.db.tables.campaign_leads.length, 1);
    assertEquals(w.reads, ['g1']);
  }
);

Deno.test(
  'webhook intake: the same delivery twice -> one lead (second is a duplicate, no second GHL read)',
  async () => {
    const w = await webhookWorld();
    await w.send(WORKFLOW_BODY);
    const r2 = await w.send(WORKFLOW_BODY);
    assertEquals(r2.body.ignored, 'duplicate');
    assertEquals(w.db.tables.campaign_leads.length, 1);
    assertEquals(w.reads.length, 1);
  }
);

Deno.test(
  'webhook intake: org with NO mappings behaves as before (reconcile off -> ignored, nothing written, no GHL read)',
  async () => {
    const w = await webhookWorld({ mappings: [] });
    const r = await w.send(WORKFLOW_BODY);
    assertEquals([r.status, r.body.ignored], [200, 'reconcile_off']);
    assertEquals([w.db.tables.contacts.length, w.reads.length], [0, 0]);
  }
);

Deno.test('webhook intake: auto-pull switched off -> no intake even with mappings', async () => {
  const w = await webhookWorld({ org: { ghl_pull_enabled: false } });
  const r = await w.send(WORKFLOW_BODY);
  assertEquals([r.status, r.body.ignored], [200, 'reconcile_off']);
  assertEquals(w.db.tables.contacts.length, 0);
});

Deno.test('webhook intake: bad or missing secret -> 401 and nothing written', async () => {
  const w = await webhookWorld();
  const bad = await w.send(WORKFLOW_BODY, {
    'x-hyperdial-webhook-secret': generateWebhookSecret(),
  });
  const malformed = await w.send(WORKFLOW_BODY, { 'x-hyperdial-webhook-secret': 'nope' });
  const none = await w.send(WORKFLOW_BODY, {});
  assertEquals([bad.status, malformed.status, none.status], [401, 401, 401]);
  assertEquals(
    [w.db.tables.contacts.length, w.db.tables.ghl_intake_log.length, w.reads.length],
    [0, 0, 0]
  );
});

Deno.test(
  'webhook intake: payload naming another location -> ignored, no GHL read, no write',
  async () => {
    const w = await webhookWorld();
    const r = await w.send({ ...WORKFLOW_BODY, location: { id: 'someone-elses-loc' } });
    assertEquals(r.body.ignored, 'location_mismatch');
    assertEquals([w.db.tables.contacts.length, w.reads.length], [0, 0]);
  }
);

Deno.test(
  'webhook intake: a forged contact id GHL will not return for this location -> no write (error logged)',
  async () => {
    const ghl = {
      getContact: async () => {
        throw new Error('GHL API GET /contacts/zz failed (404): not found');
      },
      searchOpportunities: async () => ({ opportunities: [], count: 0 }),
      getPipelines: async () => [],
    } as unknown as GhlClient;
    const w = await webhookWorld({ ghl });
    const r = await w.send({ ...WORKFLOW_BODY, contact_id: 'zz' });
    assertEquals(r.status, 200);
    assertEquals((r.body.intake as { outcome: string }).outcome, 'error');
    assertEquals([w.db.tables.contacts.length, w.db.tables.campaign_leads.length], [0, 0]);
  }
);

Deno.test(
  "webhook intake: transient GHL failure -> 503 and the delivery is forgotten so GHL's retry is processed",
  async () => {
    const ghl = {
      getContact: async () => {
        throw new Error('GHL API GET /contacts/g1 failed (503): down');
      },
      searchOpportunities: async () => ({ opportunities: [], count: 0 }),
      getPipelines: async () => [],
    } as unknown as GhlClient;
    const w = await webhookWorld({ ghl });
    const r = await w.send(WORKFLOW_BODY);
    assertEquals(r.status, 503);
    assert(w.rpcCalls.includes('ghl_webhook_forget'));
    assertEquals(w.db.tables.contacts.length, 0);
  }
);

Deno.test(
  'webhook intake: rate limited -> 200 ignored, dropped (the 5-minute pull picks it up), nothing written',
  async () => {
    const w = await webhookWorld({ accepts: ['rate_limited'] });
    const r = await w.send(WORKFLOW_BODY);
    assertEquals([r.status, r.body.ignored], [200, 'rate_limited']);
    assertEquals([w.db.tables.contacts.length, w.reads.length], [0, 0]);
  }
);

Deno.test('webhook intake: DNC-tagged lead via webhook -> not queued, skipped_dnc', async () => {
  const ghl = {
    getContact: async (id: string) =>
      ({ id, phone: '+14155552671', tags: ['roofing', 'dnc'] }) as GhlContact,
    searchOpportunities: async () => ({ opportunities: [], count: 0 }),
    getPipelines: async () => [],
  } as unknown as GhlClient;
  const w = await webhookWorld({ ghl });
  const r = await w.send(WORKFLOW_BODY);
  assertEquals((r.body.intake as { outcome: string }).outcome, 'skipped_dnc');
  assertEquals(w.db.tables.campaign_leads.length, 0);
});

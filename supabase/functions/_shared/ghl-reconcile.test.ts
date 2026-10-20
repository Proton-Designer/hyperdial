import { assertEquals } from 'jsr:@std/assert@1';
import { createGhlClient, type GhlContact } from './ghl-client.ts';
import {
  decideReconcile,
  fetchContactIdsInStage,
  ghlBlocksCalls,
  isTransientReadError,
  reconcileOrg,
  transientReleaseCap,
  type ReconcileConfig,
} from './ghl-reconcile.ts';

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(handler(String(url), init))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

const CFG: ReconcileConfig = {
  dncTags: ['do not call', 'dnc'],
  pausedTags: ['paused'],
  excludeTags: ['signed up', 'active'],
  excludeStageContactIds: new Set(['g-stage']),
};
const gc = (over: Record<string, unknown>): GhlContact => ({ id: 'g1', ...over }) as GhlContact;

Deno.test('ghlBlocksCalls: blanket dnd or Call channel active/permanent only', () => {
  assertEquals(ghlBlocksCalls(gc({ dnd: true })), true);
  assertEquals(ghlBlocksCalls(gc({ dndSettings: { Call: { status: 'active' } } })), true);
  assertEquals(ghlBlocksCalls(gc({ dndSettings: { Call: { status: 'permanent' } } })), true);
  assertEquals(ghlBlocksCalls(gc({ dndSettings: { Call: { status: 'inactive' } } })), false);
  assertEquals(ghlBlocksCalls(gc({ dndSettings: { SMS: { status: 'active' } } })), false); // SMS DND does not block calls
  assertEquals(ghlBlocksCalls(gc({ dnd: false })), false);
});

Deno.test('decideReconcile: precedence dnc > exclude > paused; case-insensitive exact tags', () => {
  assertEquals(decideReconcile(gc({ dnd: true, tags: ['signed up'] }), CFG)?.action, 'dnc');
  assertEquals(decideReconcile(gc({ tags: [' DNC '] }), CFG), {
    action: 'dnc',
    reason: 'tag  DNC ',
  });
  assertEquals(decideReconcile(gc({ tags: ['Signed Up', 'paused'] }), CFG)?.action, 'exclude');
  assertEquals(decideReconcile(gc({ id: 'g-stage' }), CFG), { action: 'exclude', reason: 'stage' });
  assertEquals(decideReconcile(gc({ tags: ['PAUSED'] }), CFG)?.action, 'paused');
  assertEquals(decideReconcile(gc({ tags: ['dncx', 'activee'] }), CFG), null); // not substring
  assertEquals(decideReconcile(gc({}), CFG), null);
});

Deno.test(
  'fetchContactIdsInStage: pins GET /opportunities/search query keys and pages',
  async () => {
    const urls: string[] = [];
    const restore = stubFetch((url) => {
      urls.push(url);
      const page2 = url.includes('startAfterId=');
      const opps = page2
        ? [{ id: 'o-101', contactId: 'c-101', updatedAt: '2026-10-01T00:00:00Z' }]
        : Array.from({ length: 100 }, (_, i) => ({
            id: `o-${i}`,
            contactId: `c-${i}`,
            updatedAt: '2026-10-02T00:00:00Z',
          }));
      return Response.json({ opportunities: opps, meta: { total: 101 } });
    });
    try {
      const ids = await fetchContactIdsInStage(createGhlClient('tok'), {
        locationId: 'loc-1',
        pipelineStageId: 'stg-9',
      });
      assertEquals(ids.size, 101);
      const q1 = new URL(urls[0]).searchParams;
      assertEquals(new URL(urls[0]).pathname, '/opportunities/search');
      assertEquals(q1.get('location_id'), 'loc-1');
      assertEquals(q1.get('pipeline_stage_id'), 'stg-9');
      assertEquals(q1.get('limit'), '100');
      const q2 = new URL(urls[1]).searchParams;
      assertEquals(q2.get('startAfterId'), 'o-99');
      assertEquals(q2.get('startAfter'), String(Date.parse('2026-10-02T00:00:00Z')));
    } finally {
      restore();
    }
  }
);

/** Fake supabase: records rpc calls, canned data for the one contacts select + claim. */
function fakeSupabase(opts: {
  claim: { contact_id: string; ghl_contact_id: string; prev_reconciled_at?: string | null }[];
  applyError?: string;
  stageContacts?: { id: string; ghl_contact_id: string }[];
}) {
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const selects: string[] = [];
  const ins: string[] = [];
  const sb = {
    from(table: string) {
      const q = {
        select: (cols: string) => {
          selects.push(cols);
          return q;
        },
        eq: () => q,
        in: (col: string) => {
          ins.push(col);
          return q;
        },
        // awaiting the builder resolves it, like supabase-js
        then: (ok: (v: unknown) => unknown) =>
          Promise.resolve({
            data: table === 'contacts' ? (opts.stageContacts ?? []) : [],
            error: null,
          }).then(ok),
      };
      return q;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      if (fn === 'claim_ghl_reconcile_batch')
        return Promise.resolve({ data: opts.claim, error: null });
      if (fn === 'apply_ghl_reconcile' && opts.applyError)
        return Promise.resolve({ data: null, error: { message: opts.applyError } });
      if (fn === 'apply_ghl_reconcile')
        return Promise.resolve({ data: { leads_moved: 3 }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { sb, rpcs, selects, ins };
}

Deno.test(
  'reconcileOrg: reads claimed contacts, applies one batch of decisions, no GHL writes',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url, init) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      const id = new URL(url).pathname.split('/').pop()!;
      const bodies: Record<string, unknown> = {
        'g-dnd': { id: 'g-dnd', dnd: true },
        'g-signed': { id: 'g-signed', tags: ['Signed Up'] },
        'g-clean': { id: 'g-clean', tags: ['lead'] },
      };
      return Response.json({ contact: bodies[id] });
    });
    const { sb, rpcs } = fakeSupabase({
      claim: [
        { contact_id: 'c1', ghl_contact_id: 'g-dnd' },
        { contact_id: 'c2', ghl_contact_id: 'g-signed' },
        { contact_id: 'c3', ghl_contact_id: 'g-clean' },
      ],
    });
    try {
      const r = await reconcileOrg(sb, createGhlClient('tok'), {
        orgId: 'org-1',
        locationId: 'loc-1',
        dncTags: null,
        pausedTags: null,
        excludeTags: ['signed up'],
        excludeStageIds: [],
        batchSize: 50,
      });
      assertEquals(calls, [
        'GET /contacts/g-dnd',
        'GET /contacts/g-signed',
        'GET /contacts/g-clean',
      ]);
      assertEquals(r.decisions, { dnc: 1, exclude: 1, paused: 0 });
      assertEquals(r.checked, 3);
      assertEquals(rpcs[0], {
        fn: 'claim_ghl_reconcile_batch',
        args: { p_org: 'org-1', p_limit: 50 },
      });
      assertEquals(rpcs[1], {
        fn: 'apply_ghl_reconcile',
        args: {
          p_org: 'org-1',
          p_items: [
            { contact_id: 'c1', action: 'dnc', reason: 'dnd' },
            { contact_id: 'c2', action: 'exclude', reason: 'tag Signed Up' },
          ],
        },
      });
      assertEquals(r.applied, { leads_moved: 3 });
    } finally {
      restore();
    }
  }
);

Deno.test(
  'reconcileOrg: a failed GHL read is counted and skipped, nothing applied when no decisions',
  async () => {
    const restore = stubFetch(() => new Response('nope', { status: 404 }));
    const { sb, rpcs } = fakeSupabase({ claim: [{ contact_id: 'c1', ghl_contact_id: 'g-gone' }] });
    try {
      const r = await reconcileOrg(sb, createGhlClient('tok'), {
        orgId: 'org-1',
        locationId: 'loc-1',
        dncTags: null,
        pausedTags: null,
        excludeTags: null,
        excludeStageIds: null,
        batchSize: 10,
      });
      assertEquals(r.readErrors, 1);
      assertEquals(r.applied, null);
      assertEquals(
        rpcs.map((x) => x.fn),
        ['claim_ghl_reconcile_batch']
      );
    } finally {
      restore();
    }
  }
);

Deno.test(
  'reconcileOrg: stage members among our linked contacts are excluded without a per-contact read',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url) => {
      calls.push(new URL(url).pathname);
      return Response.json({ opportunities: [{ id: 'o1', contactId: 'g-in-stage' }] });
    });
    const { sb, rpcs, selects, ins } = fakeSupabase({
      claim: [],
      stageContacts: [{ id: 'c9', ghl_contact_id: 'g-in-stage' }],
    });
    try {
      const r = await reconcileOrg(sb, createGhlClient('tok'), {
        orgId: 'org-1',
        locationId: 'loc-1',
        dncTags: null,
        pausedTags: null,
        excludeTags: null,
        excludeStageIds: ['stg-1'],
        batchSize: 10,
      });
      assertEquals(calls, ['/opportunities/search']);
      assertEquals(r.decisions.exclude, 1);
      // G16: only contacts that still have a queued/callback lead
      assertEquals(selects, ['id, ghl_contact_id, campaign_leads!inner(id)']);
      assertEquals(ins, ['ghl_contact_id', 'campaign_leads.status']);
      assertEquals(rpcs[1].args.p_items, [
        { contact_id: 'c9', action: 'exclude', reason: 'stage' },
      ]);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'reconcileOrg (G15): sends each read contact owner to apply_ghl_owner_routing; no owner -> no call',
  async () => {
    const restore = stubFetch((url) => {
      const id = new URL(url).pathname.split('/').pop()!;
      const bodies: Record<string, unknown> = {
        'g-owned': { id: 'g-owned', assignedTo: 'ghl-user-1' },
        'g-blank': { id: 'g-blank', assignedTo: '  ' },
        'g-none': { id: 'g-none' },
      };
      return Response.json({ contact: bodies[id] });
    });
    const args = {
      orgId: 'org-1',
      locationId: 'loc-1',
      dncTags: null,
      pausedTags: null,
      excludeTags: null,
      excludeStageIds: null,
      batchSize: 10,
    };
    try {
      const a = fakeSupabase({
        claim: [
          { contact_id: 'c1', ghl_contact_id: 'g-owned' },
          { contact_id: 'c2', ghl_contact_id: 'g-blank' },
          { contact_id: 'c3', ghl_contact_id: 'g-none' },
        ],
      });
      const r = await reconcileOrg(a.sb, createGhlClient('tok'), args);
      const routing = a.rpcs.filter((x) => x.fn === 'apply_ghl_owner_routing');
      assertEquals(routing.length, 1);
      assertEquals(routing[0].args, {
        p_org: 'org-1',
        p_items: [{ contact_id: 'c1', ghl_user_id: 'ghl-user-1' }],
      });
      assertEquals(r.ownerRouting, {});

      const b = fakeSupabase({ claim: [{ contact_id: 'c3', ghl_contact_id: 'g-none' }] });
      const r2 = await reconcileOrg(b.sb, createGhlClient('tok'), args);
      assertEquals(
        b.rpcs.map((x) => x.fn),
        ['claim_ghl_reconcile_batch']
      );
      assertEquals(r2.ownerRouting, null);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'reconcileOrg (G16): deadline stops the read loop, stage lookup needs a live lead',
  async () => {
    const calls: string[] = [];
    const restore = stubFetch((url) => {
      calls.push(new URL(url).pathname);
      return Response.json({ contact: { id: 'x', dnd: true } });
    });
    const { sb, rpcs, selects, ins } = fakeSupabase({
      claim: [
        { contact_id: 'c1', ghl_contact_id: 'g-1' },
        { contact_id: 'c2', ghl_contact_id: 'g-2' },
      ],
      stageContacts: [],
    });
    try {
      const r = await reconcileOrg(sb, createGhlClient('tok'), {
        orgId: 'org-1',
        locationId: 'loc-1',
        dncTags: null,
        pausedTags: null,
        excludeTags: null,
        excludeStageIds: [],
        batchSize: 10,
        deadlineMs: Date.now() - 1,
      });
      assertEquals(r.deadlineHit, true);
      assertEquals(calls, []);
      assertEquals(r.checked, 0);
      // G19: no time left -> nothing is claimed, so nothing gets a lease stamp without a read
      assertEquals(r.claimed, 0);
      assertEquals(rpcs, []);
      assertEquals(selects, []); // no stages configured -> no contact lookup
      assertEquals(ins, []);
    } finally {
      restore();
    }
  }
);

const orgArgs = {
  orgId: 'org-1',
  locationId: 'loc-1',
  dncTags: null,
  pausedTags: null,
  excludeTags: null,
  excludeStageIds: null,
  batchSize: 10,
};

Deno.test(
  'reconcileOrg (G19): deadline mid-batch hands back the stamp of every UNREAD contact only',
  async () => {
    const restore = stubFetch(() => {
      const until = Date.now() + 80; // the first read eats the whole budget
      while (Date.now() < until);
      return Response.json({ contact: { id: 'x', dnd: true } });
    });
    const { sb, rpcs } = fakeSupabase({
      claim: [
        { contact_id: 'c1', ghl_contact_id: 'g-1', prev_reconciled_at: '2026-10-01T00:00:00Z' },
        { contact_id: 'c2', ghl_contact_id: 'g-2', prev_reconciled_at: '2026-10-02T00:00:00Z' },
        { contact_id: 'c3', ghl_contact_id: 'g-3', prev_reconciled_at: null },
      ],
    });
    try {
      const r = await reconcileOrg(sb, createGhlClient('tok'), {
        ...orgArgs,
        deadlineMs: Date.now() + 40,
      });
      assertEquals([r.checked, r.deadlineHit, r.released], [1, true, 2]);
      const rel = rpcs.filter((x) => x.fn === 'release_ghl_reconcile_leases');
      assertEquals(rel.length, 1);
      assertEquals(rel[0].args, {
        p_org: 'org-1',
        p_items: [
          { contact_id: 'c2', prev_reconciled_at: '2026-10-02T00:00:00Z' },
          { contact_id: 'c3', prev_reconciled_at: null },
        ],
      });
      // the one read contact's decision is still applied
      assertEquals(
        rpcs.some((x) => x.fn === 'apply_ghl_reconcile'),
        true
      );
    } finally {
      restore();
    }
  }
);

Deno.test(
  'reconcileOrg (G19): a failed apply hands the whole batch back, then rethrows',
  async () => {
    const restore = stubFetch(() => Response.json({ contact: { id: 'x', dnd: true } }));
    const { sb, rpcs } = fakeSupabase({
      claim: [{ contact_id: 'c1', ghl_contact_id: 'g-1', prev_reconciled_at: null }],
      applyError: 'boom',
    });
    try {
      let msg = '';
      try {
        await reconcileOrg(sb, createGhlClient('tok'), orgArgs);
      } catch (e) {
        msg = (e as Error).message;
      }
      assertEquals(msg, 'apply_ghl_reconcile failed: boom');
      const rel = rpcs.find((x) => x.fn === 'release_ghl_reconcile_leases');
      assertEquals(rel?.args, {
        p_org: 'org-1',
        p_items: [{ contact_id: 'c1', prev_reconciled_at: null }],
      });
    } finally {
      restore();
    }
  }
);

Deno.test('reconcileOrg (G19): no deadline pressure -> no release call', async () => {
  const restore = stubFetch(() => Response.json({ contact: { id: 'x' } }));
  const { sb, rpcs } = fakeSupabase({ claim: [{ contact_id: 'c1', ghl_contact_id: 'g-1' }] });
  try {
    const r = await reconcileOrg(sb, createGhlClient('tok'), {
      ...orgArgs,
      deadlineMs: Date.now() + 60_000,
    });
    assertEquals([r.released, r.deadlineHit], [0, false]);
    assertEquals(
      rpcs.some((x) => x.fn === 'release_ghl_reconcile_leases'),
      false
    );
  } finally {
    restore();
  }
});

Deno.test(
  'isTransientReadError: only deleted/bad-request statuses are permanent (TASK-G25)',
  () => {
    for (const code of [400, 404, 410, 422])
      assertEquals(
        isTransientReadError(new Error(`GHL API GET /contacts/x failed (${code}): {}`)),
        false
      );
    for (const code of [401, 403, 429, 500, 502, 503])
      assertEquals(
        isTransientReadError(new Error(`GHL API GET /contacts/x failed (${code}): {}`)),
        true
      );
    assertEquals(isTransientReadError(new TypeError('network down')), true); // no status at all
  }
);

Deno.test('transientReleaseCap: a quarter of the batch, at least 10', () => {
  assertEquals(
    [transientReleaseCap(100), transientReleaseCap(300), transientReleaseCap(20)],
    [25, 75, 10]
  );
});

function statusStub(byId: Record<string, number>) {
  return stubFetch((url) => {
    const id = new URL(url).pathname.split('/').pop()!;
    const status = byId[id] ?? 200;
    return status === 200 ? Response.json({ contact: { id } }) : new Response('err', { status });
  });
}

Deno.test(
  'reconcileOrg (G27): a failed apply does not hand back a transient-error row a second time',
  async () => {
    const restore = stubFetch((url) =>
      new URL(url).pathname.endsWith('/g-5xx')
        ? new Response('err', { status: 503 })
        : Response.json({ contact: { id: 'x', dnd: true } })
    );
    const { sb, rpcs } = fakeSupabase({
      claim: [
        { contact_id: 'c1', ghl_contact_id: 'g-5xx', prev_reconciled_at: null },
        { contact_id: 'c2', ghl_contact_id: 'g-ok', prev_reconciled_at: null },
      ],
      applyError: 'boom',
    });
    try {
      await reconcileOrg(sb, createGhlClient('tok'), orgArgs).catch(() => {});
      const ids = rpcs
        .filter((x) => x.fn === 'release_ghl_reconcile_leases')
        .flatMap((x) => (x.args.p_items as { contact_id: string }[]).map((i) => i.contact_id));
      assertEquals(ids.sort(), ['c1', 'c2']);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'reconcileOrg (G25): transient read errors are handed back, permanent ones keep the stamp',
  async () => {
    const restore = statusStub({ 'g-gone': 404, 'g-limited': 429, 'g-5xx': 503 });
    const { sb, rpcs } = fakeSupabase({
      claim: [
        { contact_id: 'c1', ghl_contact_id: 'g-ok', prev_reconciled_at: '2026-10-01T00:00:00Z' },
        { contact_id: 'c2', ghl_contact_id: 'g-gone', prev_reconciled_at: '2026-10-02T00:00:00Z' },
        {
          contact_id: 'c3',
          ghl_contact_id: 'g-limited',
          prev_reconciled_at: '2026-10-03T00:00:00Z',
        },
        { contact_id: 'c4', ghl_contact_id: 'g-ok2', prev_reconciled_at: null },
        { contact_id: 'c5', ghl_contact_id: 'g-ok3', prev_reconciled_at: null },
        { contact_id: 'c6', ghl_contact_id: 'g-ok4', prev_reconciled_at: null },
      ],
    });
    try {
      const r = await reconcileOrg(sb, createGhlClient('tok'), orgArgs);
      assertEquals([r.checked, r.readErrors, r.released], [4, 2, 1]);
      const rel = rpcs.filter((x) => x.fn === 'release_ghl_reconcile_leases');
      assertEquals(rel.length, 1);
      // only the 429 contact is handed back (the 404 keeps its stamp), with its previous value
      assertEquals(rel[0].args.p_items, [
        { contact_id: 'c3', prev_reconciled_at: '2026-10-03T00:00:00Z' },
      ]);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'reconcileOrg (G25): when most of a tick fails transiently (outage) all of them are handed back; isolated ones are capped',
  async () => {
    // outage: 3 of 3 reads fail with 503 -> all released
    let restore = statusStub({ 'g-1': 503, 'g-2': 503, 'g-3': 503 });
    let t = fakeSupabase({
      claim: ['1', '2', '3'].map((n) => ({
        contact_id: `c${n}`,
        ghl_contact_id: `g-${n}`,
        prev_reconciled_at: null,
      })),
    });
    try {
      const r = await reconcileOrg(t.sb, createGhlClient('tok'), orgArgs);
      assertEquals(r.released, 3);
    } finally {
      restore();
    }
    // isolated: 12 transient failures among 100 reads (< half) with batch 40 -> cap = max(10, 10) = 10 released
    const failing: Record<string, number> = {};
    const claim = Array.from({ length: 100 }, (_, i) => ({
      contact_id: `c${i}`,
      ghl_contact_id: `g-${i}`,
      prev_reconciled_at: null,
    }));
    for (let i = 0; i < 12; i++) failing[`g-${i}`] = 500;
    restore = statusStub(failing);
    t = fakeSupabase({ claim });
    try {
      const r = await reconcileOrg(t.sb, createGhlClient('tok'), { ...orgArgs, batchSize: 40 });
      assertEquals([r.readErrors, r.released], [12, 10]);
    } finally {
      restore();
    }
  }
);

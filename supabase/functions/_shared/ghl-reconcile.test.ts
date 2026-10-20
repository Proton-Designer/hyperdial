import { assertEquals } from 'jsr:@std/assert@1';
import { createGhlClient, type GhlContact } from './ghl-client.ts';
import {
  decideReconcile,
  fetchContactIdsInStage,
  ghlBlocksCalls,
  reconcileOrg,
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
  claim: { contact_id: string; ghl_contact_id: string }[];
  stageContacts?: { id: string; ghl_contact_id: string }[];
}) {
  const rpcs: { fn: string; args: Record<string, unknown> }[] = [];
  const sb = {
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        in: () =>
          Promise.resolve({
            data: table === 'contacts' ? (opts.stageContacts ?? []) : [],
            error: null,
          }),
      };
      return q;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      if (fn === 'claim_ghl_reconcile_batch')
        return Promise.resolve({ data: opts.claim, error: null });
      if (fn === 'apply_ghl_reconcile')
        return Promise.resolve({ data: { leads_moved: 3 }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
  };
  return { sb, rpcs };
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
    const { sb, rpcs } = fakeSupabase({
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

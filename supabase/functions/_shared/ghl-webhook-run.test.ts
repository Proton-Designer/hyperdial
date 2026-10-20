import { assert, assertEquals } from 'jsr:@std/assert@1';
import type { GhlClient } from './ghl-client.ts';
import { handleGhlWebhook, type WebhookDeps, type WebhookRequest } from './ghl-webhook-run.ts';
import { generateWebhookSecret, sha256Hex } from './ghl-webhook.ts';

function b64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const ORG = {
  org_id: 'org-1',
  location_id: 'loc1',
  ghl_reconcile_enabled: true,
  ghl_dnc_tags: null,
  ghl_paused_tags: null,
  ghl_exclude_tags: null,
  ghl_exclude_stage_ids: null,
};

interface FakeOpts {
  orgsByLocation?: unknown[];
  stateBySecretHash?: Record<string, string>;
  orgRow?: unknown;
  accept?: string;
  contact?: { id: string } | null;
  token?: string | null;
}

function fake(opts: FakeOpts = {}) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  const supabase = {
    from(table: string) {
      const f: Record<string, unknown> = {};
      const filters: Record<string, unknown> = {};
      const chain = new Proxy(f, {
        get(_t, prop: string) {
          if (prop === 'limit') {
            return async () => ({ data: opts.orgsByLocation ?? [ORG], error: null });
          }
          if (prop === 'maybeSingle') {
            return async () => {
              if (table === 'ghl_webhook_state') {
                const org = opts.stateBySecretHash?.[String(filters.secret_hash)];
                return { data: org ? { org_id: org } : null, error: null };
              }
              if (table === 'contacts') {
                return {
                  data: opts.contact === undefined ? { id: 'ct-1' } : opts.contact,
                  error: null,
                };
              }
              return { data: opts.orgRow === undefined ? ORG : opts.orgRow, error: null };
            };
          }
          if (prop === 'eq') {
            return (k: string, v: unknown) => {
              filters[k] = v;
              return chain;
            };
          }
          return () => chain;
        },
      });
      return chain;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      calls.push({ fn, args });
      if (fn === 'ghl_webhook_accept') return { data: opts.accept ?? 'ok', error: null };
      if (fn === 'get_org_ghl_token')
        return { data: opts.token === undefined ? 'tok' : opts.token, error: null };
      if (fn === 'apply_ghl_reconcile') return { data: { dnc_contacts: 1 }, error: null };
      if (fn === 'apply_ghl_owner_routing') return { data: { routed: 1 }, error: null };
      return { data: null, error: null };
    },
  };
  return { supabase, calls };
}

function ghl(contact: Record<string, unknown> | Error, reads: string[] = []): GhlClient {
  return {
    getContact: async (id: string) => {
      reads.push(id);
      if (contact instanceof Error) throw contact;
      return { id, ...contact };
    },
    searchOpportunities: async () => ({ opportunities: [], count: 0 }),
  } as unknown as GhlClient;
}

const BODY = JSON.stringify({
  type: 'ContactDndUpdate',
  id: 'gc1',
  locationId: 'loc1',
  dnd: false,
});

function req(headers: Record<string, string>, rawBody = BODY, method = 'POST'): WebhookRequest {
  return { method, headers: new Headers(headers), rawBody };
}

async function keyPair() {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const spki = b64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey)));
  const signBody = async (body: string) =>
    b64(
      new Uint8Array(
        await crypto.subtle.sign('Ed25519', pair.privateKey, new TextEncoder().encode(body))
      )
    );
  return { spki, signBody };
}

function deps(f: ReturnType<typeof fake>, client: GhlClient, spki?: string): WebhookDeps {
  return { supabase: f.supabase, makeClient: () => client, publicKeySpkiB64: spki };
}

Deno.test(
  'webhook (signature): good signature + DND in GHL -> contact marked dnc (positive control)',
  async () => {
    const k = await keyPair();
    const reads: string[] = [];
    const f = fake();
    const r = await handleGhlWebhook(
      deps(f, ghl({ dnd: true }, reads), k.spki),
      req({ 'x-ghl-signature': await k.signBody(BODY) })
    );
    assertEquals(r.status, 200);
    assertEquals(r.body.outcome, 'applied');
    assertEquals(reads, ['gc1']);
    const apply = f.calls.find((c) => c.fn === 'apply_ghl_reconcile')!;
    assertEquals(apply.args.p_items, [{ contact_id: 'ct-1', action: 'dnc', reason: 'dnd' }]);
  }
);

Deno.test(
  'webhook (signature): the payload is not believed -- payload says dnd, GHL says not',
  async () => {
    const k = await keyPair();
    const body = JSON.stringify({
      type: 'ContactDndUpdate',
      id: 'gc1',
      locationId: 'loc1',
      dnd: true,
      tags: ['dnc'],
    });
    const f = fake();
    const r = await handleGhlWebhook(
      deps(f, ghl({ dnd: false, tags: [] }), k.spki),
      req({ 'x-ghl-signature': await k.signBody(body) }, body)
    );
    assertEquals(r.status, 200);
    assertEquals(r.body.outcome, 'no_change');
    assertEquals(f.calls.filter((c) => c.fn === 'apply_ghl_reconcile').length, 0);
  }
);

Deno.test(
  'webhook (signature): tampered body, wrong key, missing header, legacy header only -> 401, no DB / GHL work',
  async () => {
    const k = await keyPair();
    const other = await keyPair();
    const sig = await k.signBody(BODY);
    const cases: [string, WebhookRequest, string][] = [
      ['tampered', req({ 'x-ghl-signature': sig }, BODY.replace('gc1', 'gc2')), k.spki],
      ['wrong key', req({ 'x-ghl-signature': sig }), other.spki],
      ['no header', req({}), k.spki],
      ['legacy only', req({ 'x-wh-signature': sig }), k.spki],
      ['bad base64', req({ 'x-ghl-signature': '***' }), k.spki],
    ];
    for (const [name, request, spki] of cases) {
      const reads: string[] = [];
      const f = fake();
      const r = await handleGhlWebhook(deps(f, ghl({ dnd: true }, reads), spki), request);
      assertEquals(r.status, 401, name);
      assertEquals(f.calls.length, 0, `${name}: no rpc`);
      assertEquals(reads.length, 0, `${name}: no GHL read`);
    }
  }
);

Deno.test(
  'webhook (signature): unsupported event type and unknown location are ignored with 200',
  async () => {
    const k = await keyPair();
    const odd = JSON.stringify({ type: 'ContactCreate', id: 'gc1', locationId: 'loc1' });
    const f1 = fake();
    const r1 = await handleGhlWebhook(
      deps(f1, ghl({}), k.spki),
      req({ 'x-ghl-signature': await k.signBody(odd) }, odd)
    );
    assertEquals([r1.status, r1.body.ignored], [200, 'unsupported_event']);
    const f2 = fake({ orgsByLocation: [] });
    const r2 = await handleGhlWebhook(
      deps(f2, ghl({}), k.spki),
      req({ 'x-ghl-signature': await k.signBody(BODY) })
    );
    assertEquals([r2.status, r2.body.ignored], [200, 'unknown_location']);
  }
);

Deno.test(
  'webhook (signature): a location shared by two connected orgs is rejected with 409 (positive control: one org works)',
  async () => {
    const k = await keyPair();
    const headers = { 'x-ghl-signature': await k.signBody(BODY) };
    const ambiguous = fake({ orgsByLocation: [ORG, { ...ORG, org_id: 'org-2' }] });
    const reads: string[] = [];
    const r = await handleGhlWebhook(
      deps(ambiguous, ghl({ dnd: true }, reads), k.spki),
      req(headers)
    );
    assertEquals(r.status, 409);
    assertEquals(ambiguous.calls.length, 0);
    assertEquals(reads.length, 0);
    const one = fake({ orgsByLocation: [ORG] });
    const ok = await handleGhlWebhook(deps(one, ghl({ dnd: true }), k.spki), req(headers));
    assertEquals(ok.status, 200);
  }
);

Deno.test(
  'webhook (secret): the right secret works; wrong, malformed and missing are 401',
  async () => {
    const secret = generateWebhookSecret();
    const hash = await sha256Hex(secret);
    const body = JSON.stringify({ contact_id: 'gc1' });
    const mk = () => fake({ stateBySecretHash: { [hash]: 'org-1' } });

    const f = mk();
    const ok = await handleGhlWebhook(
      deps(f, ghl({ tags: ['dnc'] })),
      req({ 'x-hyperdial-webhook-secret': secret }, body)
    );
    assertEquals(ok.status, 200);
    assertEquals(ok.body.outcome, 'applied');

    for (const [name, headers] of [
      ['wrong', { 'x-hyperdial-webhook-secret': generateWebhookSecret() }],
      ['malformed', { 'x-hyperdial-webhook-secret': 'hello' }],
      ['missing', {}],
    ] as [string, Record<string, string>][]) {
      const reads: string[] = [];
      const g = mk();
      const r = await handleGhlWebhook(deps(g, ghl({ dnd: true }, reads)), req(headers, body));
      assertEquals(r.status, 401, name);
      assertEquals(g.calls.length, 0, `${name}: no rpc`);
      assertEquals(reads.length, 0, `${name}: no GHL read`);
    }
  }
);

Deno.test(
  'webhook (secret): a body naming another location is ignored, a matching one is handled',
  async () => {
    const secret = generateWebhookSecret();
    const hash = await sha256Hex(secret);
    const f = () => fake({ stateBySecretHash: { [hash]: 'org-1' } });
    const other = await handleGhlWebhook(
      deps(f(), ghl({ dnd: true })),
      req(
        { 'x-hyperdial-webhook-secret': secret },
        JSON.stringify({ contact_id: 'gc1', location: { id: 'locX' } })
      )
    );
    assertEquals([other.status, other.body.ignored], [200, 'location_mismatch']);
    const same = await handleGhlWebhook(
      deps(f(), ghl({ dnd: true })),
      req(
        { 'x-hyperdial-webhook-secret': secret },
        JSON.stringify({ contact_id: 'gc1', location: { id: 'loc1' } })
      )
    );
    assertEquals(same.body.outcome, 'applied');
  }
);

Deno.test(
  'webhook: duplicate and rate-limited events do no GHL work; reconcile-off and unlinked are ignored',
  async () => {
    const k = await keyPair();
    const headers = { 'x-ghl-signature': await k.signBody(BODY) };
    for (const [accept, label] of [
      ['duplicate', 'duplicate'],
      ['rate_limited', 'rate_limited'],
    ]) {
      const reads: string[] = [];
      const f = fake({ accept });
      const r = await handleGhlWebhook(deps(f, ghl({ dnd: true }, reads), k.spki), req(headers));
      assertEquals([r.status, r.body.ignored], [200, label]);
      assertEquals(reads.length, 0);
    }
    const off = fake({ orgsByLocation: [{ ...ORG, ghl_reconcile_enabled: false }] });
    const rOff = await handleGhlWebhook(deps(off, ghl({ dnd: true }), k.spki), req(headers));
    assertEquals(rOff.body.ignored, 'reconcile_off');
    assertEquals(off.calls.length, 0);
    const unlinked = fake({ contact: null });
    const reads: string[] = [];
    const rU = await handleGhlWebhook(
      deps(unlinked, ghl({ dnd: true }, reads), k.spki),
      req(headers)
    );
    assertEquals(rU.body.outcome, 'unlinked');
    assertEquals(reads.length, 0);
  }
);

Deno.test(
  'webhook: transient GHL failure -> 503 and the body is un-seen; permanent -> 200 ignored',
  async () => {
    const k = await keyPair();
    const headers = { 'x-ghl-signature': await k.signBody(BODY) };
    const f = fake();
    const r = await handleGhlWebhook(
      deps(f, ghl(new Error('GHL API GET /contacts/gc1 failed (503): down')), k.spki),
      req(headers)
    );
    assertEquals(r.status, 503);
    assert(f.calls.some((c) => c.fn === 'ghl_webhook_forget'));
    const f2 = fake();
    const r2 = await handleGhlWebhook(
      deps(f2, ghl(new Error('GHL API GET /contacts/gc1 failed (404): gone')), k.spki),
      req(headers)
    );
    assertEquals([r2.status, r2.body.ignored], [200, 'contact_unreadable']);
    assert(!f2.calls.some((c) => c.fn === 'ghl_webhook_forget'));
  }
);

Deno.test('webhook: owner (assignedTo) is routed even when nothing else changes', async () => {
  const k = await keyPair();
  const f = fake();
  const r = await handleGhlWebhook(
    deps(f, ghl({ assignedTo: 'u9' }), k.spki),
    req({ 'x-ghl-signature': await k.signBody(BODY) })
  );
  assertEquals(r.body.outcome, 'applied');
  const route = f.calls.find((c) => c.fn === 'apply_ghl_owner_routing')!;
  assertEquals(route.args.p_items, [{ contact_id: 'ct-1', ghl_user_id: 'u9' }]);
  assertEquals(f.calls.filter((c) => c.fn === 'apply_ghl_reconcile').length, 0);
});

Deno.test(
  'webhook: oversized body is 413 before any auth or DB work; non-POST is 405',
  async () => {
    const f = fake();
    const big = 'x'.repeat(300 * 1024);
    const r = await handleGhlWebhook(deps(f, ghl({})), req({}, big));
    assertEquals(r.status, 413);
    const r2 = await handleGhlWebhook(deps(f, ghl({})), { ...req({}), contentLength: 999999 });
    assertEquals(r2.status, 413);
    const r3 = await handleGhlWebhook(deps(f, ghl({})), req({}, BODY, 'GET'));
    assertEquals(r3.status, 405);
    assertEquals(f.calls.length, 0);
  }
);

Deno.test(
  'webhook (secret): unknown or missing secret is 401 even when the body is not JSON; a valid secret + bad JSON is 400',
  async () => {
    const secret = generateWebhookSecret();
    const hash = await sha256Hex(secret);
    const mk = () => fake({ stateBySecretHash: { [hash]: 'org-1' } });
    const junk = 'this is not json';
    const unknown = await handleGhlWebhook(
      deps(mk(), ghl({})),
      req({ 'x-hyperdial-webhook-secret': generateWebhookSecret() }, junk)
    );
    assertEquals(unknown.status, 401);
    const missing = await handleGhlWebhook(deps(mk(), ghl({})), req({}, junk));
    assertEquals(missing.status, 401);
    const malformed = await handleGhlWebhook(
      deps(mk(), ghl({})),
      req({ 'x-hyperdial-webhook-secret': 'nope' }, junk)
    );
    assertEquals(malformed.status, 401);
    // positive control: the same junk body with the RIGHT secret reaches the parser
    const good = await handleGhlWebhook(
      deps(mk(), ghl({})),
      req({ 'x-hyperdial-webhook-secret': secret }, junk)
    );
    assertEquals(good.status, 400);
  }
);

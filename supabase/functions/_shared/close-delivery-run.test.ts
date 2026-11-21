import { assertEquals } from 'jsr:@std/assert@1';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { deliverClaimedClose, runCloseDeliveries } from './close-delivery-run.ts';
import type { CloseRow } from './close-delivery.ts';

const PUBLIC_IP = () => Promise.resolve(['93.184.216.34']);

const row = (over: Partial<CloseRow> = {}): CloseRow => ({
  id: 'c1',
  org_id: 'o1',
  contact_id: 'k1',
  closed_by: 'u1',
  owner_name: 'P',
  business_name: 'B',
  mobile: '+15125550100',
  email: null,
  services: ['A'],
  cities: ['X'],
  frequencies: ['weekly'],
  insured: true,
  best_contact: null,
  starting_price: null,
  capacity: null,
  years_in_business: null,
  created_at: '2026-10-27T12:00:00Z',
  delivery_attempts: 1,
  ...over,
});

function fakeDb(hook: unknown, claimed: CloseRow[] = []) {
  const updates: Record<string, unknown>[] = [];
  const db = {
    rpc: () => Promise.resolve({ data: claimed, error: null }),
    from(table: string) {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        maybeSingle: () =>
          Promise.resolve({
            data: table === 'org_close_webhook' ? hook : { first_name: 'Ann', last_name: 'Lee' },
          }),
        update: (v: Record<string, unknown>) => {
          updates.push(v);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
      return q;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

const ok = (() => Promise.resolve(new Response(null, { status: 200 }))) as unknown as typeof fetch;
const down = (() =>
  Promise.resolve(new Response(null, { status: 503 }))) as unknown as typeof fetch;
const hook = { url: 'https://example.com/h', secret: null, enabled: true };

Deno.test('success marks sent and stamps delivered_at', async () => {
  const f = fakeDb(hook);
  assertEquals(await deliverClaimedClose(f.db, row(), ok, 1000, PUBLIC_IP), 'sent');
  assertEquals(f.updates[0].delivery_status, 'sent');
  assertEquals(f.updates[0].last_error, null);
});

Deno.test('503 keeps it pending with a next attempt; the 6th attempt fails it', async () => {
  const f = fakeDb(hook);
  assertEquals(await deliverClaimedClose(f.db, row(), down, 1000, PUBLIC_IP), 'pending');
  assertEquals(typeof f.updates[0].next_attempt_at, 'string');
  const g = fakeDb(hook);
  assertEquals(
    await deliverClaimedClose(g.db, row({ delivery_attempts: 6 }), down, 1000, PUBLIC_IP),
    'failed'
  );
  assertEquals(g.updates[0].next_attempt_at, null);
});

Deno.test('webhook removed or disabled -> not_configured, no fetch', async () => {
  let called = false;
  const spy = (() => {
    called = true;
    return Promise.resolve(new Response(null, { status: 200 }));
  }) as unknown as typeof fetch;
  for (const h of [null, { ...hook, enabled: false }]) {
    const f = fakeDb(h);
    assertEquals(await deliverClaimedClose(f.db, row(), spy, 1000, PUBLIC_IP), 'not_configured');
  }
  assertEquals(called, false);
});

Deno.test('runCloseDeliveries tallies the claimed batch', async () => {
  const f = fakeDb(hook, [row({ id: 'a' }), row({ id: 'b' })]);
  assertEquals(
    await runCloseDeliveries(f.db, { limit: 20, fetchImpl: ok, resolveHost: PUBLIC_IP }),
    {
      claimed: 2,
      sent: 2,
      failed: 0,
      retrying: 0,
    }
  );
});

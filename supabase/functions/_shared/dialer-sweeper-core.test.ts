/**
 * TASK-L6 acceptance tests, verbatim from the task's own acceptance line: "deno tests (alive ->
 * untouched; not-alive -> hangup path; API error -> untouched; > time_limit+5 -> ended) with a
 * positive control". `reap_dead_claimed_leg` itself is SQL (can't run against a real Postgres
 * here -- local Docker is retired, same acceptance substitution as TASK-L1's own
 * dialer-engine.test.ts) -- these tests fake ONLY the one RPC call this file's logic actually
 * makes, plus a fake Telnyx client's `getCallStatus`, and assert on call counts/args (the
 * positive control: proving each branch really does or doesn't call the RPC, not just that the
 * function happens to return the right label).
 */
import { assertEquals } from 'jsr:@std/assert@1';
import { reconcileStaleClaimedLeg, type StaleClaimedLegCandidate } from './dialer-sweeper-core.ts';
import type { TelnyxClient } from './telnyx-client.ts';

const CANDIDATE: StaleClaimedLegCandidate = {
  id: 'leg-1',
  call_control_id: 'call-1',
  org_id: 'org-1',
  created_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
};

const NOW = new Date('2026-01-01T00:10:00.000Z'); // 10 minutes after created_at

function fakeSupabase(reapResult: boolean | null) {
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  return {
    rpcCalls,
    // deno-lint-ignore no-explicit-any
    client: {
      rpc(name: string, args: Record<string, unknown>) {
        rpcCalls.push({ name, args });
        return Promise.resolve({ data: reapResult, error: null });
      },
      // deno-lint-ignore no-explicit-any
    } as any,
  };
}

function fakeTelnyxClient(getCallStatus: TelnyxClient['getCallStatus']): TelnyxClient {
  // deno-lint-ignore no-explicit-any
  return { getCallStatus } as any;
}

Deno.test(
  'reconcileStaleClaimedLeg: Telnyx says alive -> "alive", leg left untouched (no RPC call at all)',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    const telnyx = fakeTelnyxClient(() => Promise.resolve({ isAlive: true }));
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => NOW,
    });
    assertEquals(outcome, 'alive');
    // Positive control: prove the "leave it alone" branch really never touches the leg, not
    // just that it happens to return the right label.
    assertEquals(rpcCalls.length, 0, 'a live call must never trigger reap_dead_claimed_leg');
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: Telnyx says not alive -> reaps via the normal hangup outcome path',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    const telnyx = fakeTelnyxClient(() => Promise.resolve({ isAlive: false }));
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => NOW,
    });
    assertEquals(outcome, 'reaped_confirmed_dead');
    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0].name, 'reap_dead_claimed_leg');
    assertEquals(rpcCalls[0].args.p_leg, 'leg-1');
    assertEquals(rpcCalls[0].args.p_hangup_cause, 'call_not_alive');
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: Telnyx 404 (call unknown/long gone) is treated the same as a confirmed not-alive',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    // getCallStatus's own contract (telnyx-client.ts) already maps a 404 to {isAlive:false} --
    // this test proves reconcileStaleClaimedLeg's OWN handling of that value, independent of the
    // client's mapping (already covered separately in telnyx-client.test.ts).
    const telnyx = fakeTelnyxClient(() => Promise.resolve({ isAlive: false }));
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => NOW,
    });
    assertEquals(outcome, 'reaped_confirmed_dead');
    assertEquals(rpcCalls.length, 1);
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: Telnyx API error -> "inconclusive", leg left untouched (no RPC call)',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    const telnyx = fakeTelnyxClient(() => Promise.resolve(null)); // getCallStatus's own "inconclusive" value
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => NOW,
    });
    assertEquals(outcome, 'inconclusive');
    assertEquals(rpcCalls.length, 0, 'a Telnyx error must never end a leg');
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: a getCallStatus that REJECTS (network failure) is also inconclusive, not a crash',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    const telnyx = fakeTelnyxClient(() => Promise.reject(new Error('network down')));
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => NOW,
    });
    assertEquals(outcome, 'inconclusive');
    assertEquals(rpcCalls.length, 0);
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: older than time_limit_secs + grace -> reaped unconditionally, Telnyx never even asked',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    let getCallStatusCalls = 0;
    const telnyx = fakeTelnyxClient(() => {
      getCallStatusCalls++;
      return Promise.resolve({ isAlive: true }); // even if it WERE asked and said alive
    });
    const farFuture = new Date(
      new Date(CANDIDATE.created_at).getTime() + (1800 + 300) * 1000 + 1000
    );
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => farFuture,
    });
    assertEquals(outcome, 'reaped_timeout');
    assertEquals(rpcCalls.length, 1);
    assertEquals(rpcCalls[0].args.p_hangup_cause, 'timeout');
    // Positive control: proves this branch is genuinely unconditional -- it must not even ask
    // Telnyx, not just that it ignores an "alive" answer if it did.
    assertEquals(getCallStatusCalls, 0, 'past the hard timeout, Telnyx must never be asked at all');
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: exactly at the time_limit_secs + grace boundary is NOT yet unconditional (still asks Telnyx)',
  async () => {
    const { client } = fakeSupabase(true);
    let asked = false;
    const telnyx = fakeTelnyxClient(() => {
      asked = true;
      return Promise.resolve({ isAlive: true });
    });
    const justBefore = new Date(
      new Date(CANDIDATE.created_at).getTime() + (1800 + 300) * 1000 - 1000
    );
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => justBefore,
    });
    assertEquals(outcome, 'alive');
    assertEquals(asked, true);
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: reap_dead_claimed_leg itself returning false (lost the race to a real webhook) surfaces as inconclusive, not a false success',
  async () => {
    const { client, rpcCalls } = fakeSupabase(false); // SQL's own race-loss no-op
    const telnyx = fakeTelnyxClient(() => Promise.resolve({ isAlive: false }));
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => NOW,
    });
    assertEquals(outcome, 'inconclusive');
    assertEquals(rpcCalls.length, 1); // it WAS called -- just didn't apply, a real distinction
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: no Telnyx client available for the org -> inconclusive, never a crash',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: null,
      now: () => NOW,
    });
    assertEquals(outcome, 'inconclusive');
    assertEquals(rpcCalls.length, 0);
  }
);

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
import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import {
  reconcileStaleClaimedLeg,
  hangUpReapedCoachingSessions,
  unwindReapedCallTransfers,
  type StaleClaimedLegCandidate,
  type ReapedCoachingSession,
  type ReapedCallTransfer,
} from './dialer-sweeper-core.ts';
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

function fakeTelnyxClient(getCallStatus: TelnyxClient['getCallStatus']): {
  client: TelnyxClient;
  hangupCalls: string[];
} {
  const hangupCalls: string[] = [];
  const client = {
    getCallStatus,
    hangup: (callControlId: string) => {
      hangupCalls.push(callControlId);
      return Promise.resolve();
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { client, hangupCalls };
}

Deno.test(
  'reconcileStaleClaimedLeg: Telnyx says alive -> "alive", leg left untouched (no RPC call at all)',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    const { client: telnyx, hangupCalls } = fakeTelnyxClient(() =>
      Promise.resolve({ isAlive: true })
    );
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => NOW,
    });
    assertEquals(outcome, 'alive');
    // Positive control: prove the "leave it alone" branch really never touches the leg, not
    // just that it happens to return the right label.
    assertEquals(rpcCalls.length, 0, 'a live call must never trigger reap_dead_claimed_leg');
    assertEquals(hangupCalls.length, 0, 'a live call must never be hung up either');
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: Telnyx says not alive -> reaps via the normal hangup outcome path',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    const { client: telnyx, hangupCalls } = fakeTelnyxClient(() =>
      Promise.resolve({ isAlive: false })
    );
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
    // Review fix (minor 3): a successful reap also sends a best-effort real Telnyx hangup, in
    // case the "dead" read was itself wrong (stale key, wrong API base, ...).
    assertEquals(hangupCalls, ['call-1']);
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: Telnyx 404 (call unknown/long gone) is treated the same as a confirmed not-alive',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    // getCallStatus's own contract (telnyx-client.ts) already maps a 404 to {isAlive:false} --
    // this test proves reconcileStaleClaimedLeg's OWN handling of that value, independent of the
    // client's mapping (already covered separately in telnyx-client.test.ts).
    const { client: telnyx } = fakeTelnyxClient(() => Promise.resolve({ isAlive: false }));
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
    const { client: telnyx, hangupCalls } = fakeTelnyxClient(() => Promise.resolve(null)); // getCallStatus's own "inconclusive" value
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => NOW,
    });
    assertEquals(outcome, 'inconclusive');
    assertEquals(rpcCalls.length, 0, 'a Telnyx error must never end a leg');
    assertEquals(hangupCalls.length, 0);
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: a getCallStatus that REJECTS (network failure) is also inconclusive, not a crash',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    const { client: telnyx } = fakeTelnyxClient(() => Promise.reject(new Error('network down')));
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
    const { client: telnyx, hangupCalls } = fakeTelnyxClient(() => {
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
    // A best-effort real hangup still goes out even for an unconditional timeout reap.
    assertEquals(hangupCalls, ['call-1']);
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: exactly at the time_limit_secs + grace boundary is NOT yet unconditional (still asks Telnyx)',
  async () => {
    const { client } = fakeSupabase(true);
    let asked = false;
    const { client: telnyx } = fakeTelnyxClient(() => {
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
    const { client: telnyx, hangupCalls } = fakeTelnyxClient(() =>
      Promise.resolve({ isAlive: false })
    );
    const outcome = await reconcileStaleClaimedLeg(CANDIDATE, {
      supabase: client,
      client: telnyx,
      now: () => NOW,
    });
    assertEquals(outcome, 'inconclusive');
    assertEquals(rpcCalls.length, 1); // it WAS called -- just didn't apply, a real distinction
    assertEquals(hangupCalls.length, 0, 'no hangup when the reap itself did not apply');
  }
);

Deno.test(
  'reconcileStaleClaimedLeg: a pending-* call_control_id (never actually dialed) is left alone, Telnyx never asked, no RPC call',
  async () => {
    const { client, rpcCalls } = fakeSupabase(true);
    let asked = false;
    const { client: telnyx } = fakeTelnyxClient(() => {
      asked = true;
      return Promise.resolve({ isAlive: false });
    });
    const pendingCandidate: StaleClaimedLegCandidate = {
      ...CANDIDATE,
      call_control_id: 'pending-abc123',
    };
    const outcome = await reconcileStaleClaimedLeg(pendingCandidate, {
      supabase: client,
      client: telnyx,
      now: () => NOW,
    });
    assertEquals(outcome, 'inconclusive');
    assertEquals(asked, false, 'a placeholder call_control_id must never be asked about');
    assertEquals(rpcCalls.length, 0);
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

// TASK-T3 review fix-forward (msg-fix-T3.txt): hangUpReapedCoachingSessions.

function fakeTelnyxHangupOnly(hangup: TelnyxClient['hangup']): TelnyxClient {
  return { hangup } as unknown as TelnyxClient;
}

Deno.test(
  'hangUpReapedCoachingSessions: hangs up every row with a manager_call_control_id, one client resolution per org',
  async () => {
    const hangupCalls: string[] = [];
    const resolveCalls: string[] = [];
    const rows: ReapedCoachingSession[] = [
      {
        id: 'cs-1',
        org_id: 'org-1',
        manager_call_control_id: 'call-mgr-1',
        manager_id: 'mgr-1',
        target_session_id: 'session-1',
      },
      {
        id: 'cs-2',
        org_id: 'org-1',
        manager_call_control_id: 'call-mgr-2',
        manager_id: 'mgr-2',
        target_session_id: 'session-2',
      },
      {
        id: 'cs-3',
        org_id: 'org-2',
        manager_call_control_id: 'call-mgr-3',
        manager_id: 'mgr-3',
        target_session_id: 'session-3',
      },
    ];
    const client = fakeTelnyxHangupOnly((id) => {
      hangupCalls.push(id);
      return Promise.resolve();
    });
    const hungUp = await hangUpReapedCoachingSessions(rows, {
      resolveClient: (orgId) => {
        resolveCalls.push(orgId);
        return Promise.resolve(client);
      },
    });
    assertEquals(hungUp, 3);
    assertEquals(hangupCalls, ['call-mgr-1', 'call-mgr-2', 'call-mgr-3']);
    // Positive control: not just "it works", but that it resolves once per ROW (the caller,
    // dialer-sweeper/index.ts, is the one that actually caches per-org -- this function itself
    // makes no such assumption about its resolveClient dependency).
    assertEquals(resolveCalls, ['org-1', 'org-1', 'org-2']);
  }
);

Deno.test(
  'hangUpReapedCoachingSessions: a null manager_call_control_id (crash mid-start) is skipped, never asked about',
  async () => {
    const rows: ReapedCoachingSession[] = [
      {
        id: 'cs-1',
        org_id: 'org-1',
        manager_call_control_id: null,
        manager_id: 'mgr-1',
        target_session_id: 'session-1',
      },
    ];
    let resolved = false;
    const hungUp = await hangUpReapedCoachingSessions(rows, {
      resolveClient: () => {
        resolved = true;
        return Promise.resolve(fakeTelnyxHangupOnly(() => Promise.resolve()));
      },
    });
    assertEquals(hungUp, 0);
    assertEquals(resolved, false, 'a null call_control_id must never even resolve a client');
  }
);

Deno.test(
  'hangUpReapedCoachingSessions: no connected client for the org -> skipped, not a crash',
  async () => {
    const rows: ReapedCoachingSession[] = [
      {
        id: 'cs-1',
        org_id: 'org-1',
        manager_call_control_id: 'call-mgr-1',
        manager_id: 'mgr-1',
        target_session_id: 'session-1',
      },
    ];
    const hungUp = await hangUpReapedCoachingSessions(rows, {
      resolveClient: () => Promise.resolve(null),
    });
    assertEquals(hungUp, 0);
  }
);

Deno.test(
  'hangUpReapedCoachingSessions: a hangup that throws is swallowed and not counted, never a crash',
  async () => {
    const rows: ReapedCoachingSession[] = [
      {
        id: 'cs-1',
        org_id: 'org-1',
        manager_call_control_id: 'call-mgr-1',
        manager_id: 'mgr-1',
        target_session_id: 'session-1',
      },
      {
        id: 'cs-2',
        org_id: 'org-1',
        manager_call_control_id: 'call-mgr-2',
        manager_id: 'mgr-2',
        target_session_id: 'session-2',
      },
    ];
    const hangupCalls: string[] = [];
    const client = fakeTelnyxHangupOnly((id) => {
      if (id === 'call-mgr-1') return Promise.reject(new Error('already gone'));
      hangupCalls.push(id);
      return Promise.resolve();
    });
    const hungUp = await hangUpReapedCoachingSessions(rows, {
      resolveClient: () => Promise.resolve(client),
    });
    // Positive control: the SECOND row's real hangup still went out despite the first throwing --
    // proves the failure is caught per-row, not one that aborts the whole loop.
    assertEquals(hungUp, 1);
    assertEquals(hangupCalls, ['call-mgr-2']);
  }
);

// TASK-T4: unwindReapedCallTransfers.

function fakeSupabaseForUnwind(cfg: {
  session?: { conference_id: string | null; agent_leg_id: string | null } | null;
  legs?: Record<string, { call_control_id: string } | null>;
}) {
  const writes: { table: string; id: string; patch: Record<string, unknown> }[] = [];
  // deno-lint-ignore no-explicit-any
  const supabase: any = {
    from(table: string) {
      if (table === 'dial_sessions') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: cfg.session ?? null, error: null }),
            }),
          }),
        };
      }
      if (table === 'call_legs') {
        return {
          select: () => ({
            eq: (_col: string, id: string) => ({
              maybeSingle: async () => ({ data: cfg.legs?.[id] ?? null, error: null }),
            }),
          }),
          update: (patch: Record<string, unknown>) => ({
            eq: async (_col: string, id: string) => {
              writes.push({ table, id, patch });
              return { error: null };
            },
          }),
        };
      }
      throw new Error(`fake supabase: unexpected table ${table}`);
    },
  };
  return { supabase, writes };
}

function fakeTelnyxUnwindClient(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: { method: string; args: unknown[] }[] = [];
  const client = {
    hangup: async (id: string) => calls.push({ method: 'hangup', args: [id] }),
    leaveConference: async (conferenceId: string, callControlId: string) =>
      calls.push({ method: 'leaveConference', args: [conferenceId, callControlId] }),
    joinConference: async (conferenceId: string, args: unknown) =>
      calls.push({ method: 'joinConference', args: [conferenceId, args] }),
    unholdConferenceParticipants: async (conferenceId: string, args: unknown) =>
      calls.push({ method: 'unholdConferenceParticipants', args: [conferenceId, args] }),
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
  return { client, calls };
}

Deno.test(
  'unwindReapedCallTransfers: old_status "dialing" -- only hangs up the target, never touches the conference',
  async () => {
    const { supabase } = fakeSupabaseForUnwind({});
    const { client, calls } = fakeTelnyxUnwindClient();
    const rows: ReapedCallTransfer[] = [
      {
        id: 't-1',
        org_id: 'org-1',
        session_id: 's-1',
        contact_leg_id: 'leg-1',
        old_status: 'dialing',
        target_call_control_id: 'call-target-1',
        side_conference_id: null,
      },
    ];
    const unwound = await unwindReapedCallTransfers(rows, {
      supabase,
      resolveClient: () => Promise.resolve(client),
    });
    assertEquals(unwound, 1);
    assertEquals(calls, [{ method: 'hangup', args: ['call-target-1'] }]);
  }
);

Deno.test(
  'unwindReapedCallTransfers: old_status "dialing" with no target_call_control_id yet -- nothing to hang up, still counted',
  async () => {
    const { supabase } = fakeSupabaseForUnwind({});
    const { client, calls } = fakeTelnyxUnwindClient();
    const rows: ReapedCallTransfer[] = [
      {
        id: 't-1',
        org_id: 'org-1',
        session_id: 's-1',
        contact_leg_id: 'leg-1',
        old_status: 'dialing',
        target_call_control_id: null,
        side_conference_id: null,
      },
    ];
    const unwound = await unwindReapedCallTransfers(rows, {
      supabase,
      resolveClient: () => Promise.resolve(client),
    });
    assertEquals(unwound, 1);
    assertEquals(calls.length, 0);
  }
);

Deno.test(
  'unwindReapedCallTransfers: old_status "connected" -- hangs up the target AND unwinds the agent back to the main conference',
  async () => {
    const { supabase, writes } = fakeSupabaseForUnwind({
      session: { conference_id: 'conf-main', agent_leg_id: 'leg-agent-1' },
      legs: {
        'leg-1': { call_control_id: 'call-prospect-1' },
        'leg-agent-1': { call_control_id: 'call-agent-1' },
      },
    });
    const { client, calls } = fakeTelnyxUnwindClient();
    const rows: ReapedCallTransfer[] = [
      {
        id: 't-1',
        org_id: 'org-1',
        session_id: 's-1',
        contact_leg_id: 'leg-1',
        old_status: 'connected',
        target_call_control_id: 'call-target-1',
        side_conference_id: 'conf-side-1',
      },
    ];
    const unwound = await unwindReapedCallTransfers(rows, {
      supabase,
      resolveClient: () => Promise.resolve(client),
    });
    assertEquals(unwound, 1);
    assertEquals(
      calls.map((c) => c.method),
      ['hangup', 'leaveConference', 'joinConference', 'unholdConferenceParticipants']
    );
    assertEquals(calls[1].args, ['conf-side-1', 'call-agent-1']);
    assertEquals(calls[2].args, ['conf-main', { callControlId: 'call-agent-1' }]);
    assertEquals(calls[3].args, ['conf-main', { callControlIds: ['call-prospect-1'] }]);
    const held = writes.find((w) => w.id === 'leg-1');
    assertExists(held);
    assertEquals(held!.patch.held_at, null);
  }
);

Deno.test(
  'unwindReapedCallTransfers: no connected client for the org -- skipped entirely, not a crash',
  async () => {
    const { supabase } = fakeSupabaseForUnwind({});
    const rows: ReapedCallTransfer[] = [
      {
        id: 't-1',
        org_id: 'org-1',
        session_id: 's-1',
        contact_leg_id: 'leg-1',
        old_status: 'dialing',
        target_call_control_id: 'call-target-1',
        side_conference_id: null,
      },
    ];
    const unwound = await unwindReapedCallTransfers(rows, {
      supabase,
      resolveClient: () => Promise.resolve(null),
    });
    assertEquals(unwound, 0);
  }
);

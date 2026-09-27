/**
 * TASK-T4: hand-rolled fake supabase + fake TelnyxClient, same "ordered per-table results
 * consumed by call order, writes captured for assertion" shape as coaching-core.test.ts's own
 * fakes -- not a general query engine. `.rpc()` results are similarly ordered per rpc NAME (this
 * module calls `transition_call_transfer`/`transition_session`/`enqueue_crm_job` by name, never
 * needing WHERE-clause-aware matching to prove its own logic).
 */
import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import type { TelnyxClient } from './telnyx-client.ts';
import {
  runHoldAction,
  runResumeAction,
  runStartTransferAction,
  runCompleteTransferAction,
  runCancelTransferAction,
  processTelnyxTransferEvent,
  cancelInFlightTransferForSession,
} from './transfer-core.ts';

type Result<T = Record<string, unknown> | null> = {
  data: T;
  error: { message: string; code?: string } | null;
};

function selectChain(result: Result) {
  // deno-lint-ignore no-explicit-any
  const chain: any = {
    eq: () => chain,
    in: () => chain,
    not: () => chain,
    order: () => chain,
    limit: () => chain,
    select: () => chain,
    maybeSingle: async () => result,
  };
  return chain;
}

function updateChain(onSettle: () => void) {
  // deno-lint-ignore no-explicit-any
  const chain: any = {
    eq: () => chain,
    neq: () => chain,
    then: (resolve: (v: unknown) => void) => {
      onSettle();
      resolve({ error: null });
    },
  };
  return chain;
}

/** Terminal chain for a `.select(col, {count:'exact',head:true})` query -- awaited directly
 *  (no `.maybeSingle()`/`.single()`), matching `externalTransferRateLimited`'s own call shape. */
function countChain(count: number) {
  // deno-lint-ignore no-explicit-any
  const chain: any = {
    eq: () => chain,
    gte: () => chain,
    in: () => chain,
    then: (resolve: (v: unknown) => void) => resolve({ count, data: null, error: null }),
  };
  return chain;
}

function makeFakeSupabase(cfg: {
  dial_sessions?: Result[];
  call_legs?: Result[];
  org_members?: Result[];
  user_phone_numbers?: Result[];
  profiles?: Result[];
  call_transfersSelect?: Result[];
  call_transfersInsert?: Result;
  org_transfer_settings?: Result[];
  dnc_numbers?: Result[];
  org_spend_settings?: Result[];
  org_telephony?: Result[];
  call_transfersCount?: number[];
  // deno-lint-ignore no-explicit-any
  rpc?: Record<string, Result<any>[]>;
}) {
  const counters: Record<string, number> = {};
  const next = (key: string, arr?: Result[]): Result => {
    const i = counters[key] ?? 0;
    counters[key] = i + 1;
    if (!arr || !arr[i]) throw new Error(`fake supabase: no configured result #${i} for ${key}`);
    return arr[i];
  };
  const nextCount = (key: string, arr?: number[]): number => {
    const i = counters[key] ?? 0;
    counters[key] = i + 1;
    if (!arr || arr[i] === undefined) {
      throw new Error(`fake supabase: no configured count #${i} for ${key}`);
    }
    return arr[i];
  };
  const writes: { table: string; patch: Record<string, unknown> }[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

  const supabase = {
    from(table: string) {
      switch (table) {
        case 'dial_sessions':
          return { select: () => selectChain(next('dial_sessions', cfg.dial_sessions)) };
        case 'call_legs':
          return {
            select: () => selectChain(next('call_legs', cfg.call_legs)),
            update: (patch: Record<string, unknown>) =>
              updateChain(() => writes.push({ table, patch })),
          };
        case 'org_members':
          return { select: () => selectChain(next('org_members', cfg.org_members)) };
        case 'user_phone_numbers':
          return { select: () => selectChain(next('user_phone_numbers', cfg.user_phone_numbers)) };
        case 'profiles':
          return { select: () => selectChain(next('profiles', cfg.profiles)) };
        case 'call_transfers':
          return {
            insert: (row: Record<string, unknown>) => {
              writes.push({ table: 'call_transfers:insert', patch: row });
              return {
                select: () => ({
                  single: async () =>
                    cfg.call_transfersInsert ?? {
                      data: null,
                      error: { message: 'not configured' },
                    },
                }),
              };
            },
            // Review fix-forward: externalTransferRateLimited's own count query
            // (`.select('id', {count:'exact',head:true})`) is awaited directly, no
            // `.maybeSingle()` -- dispatch on the presence of `count` in opts to tell it apart
            // from every other row-lookup `.select(...)` this module makes on the same table.
            select: (_cols?: string, opts?: { count?: string }) =>
              opts?.count
                ? countChain(nextCount('call_transfersCount', cfg.call_transfersCount))
                : selectChain(next('call_transfers', cfg.call_transfersSelect)),
            update: (patch: Record<string, unknown>) =>
              updateChain(() => writes.push({ table, patch })),
          };
        case 'org_transfer_settings':
          return {
            select: () => selectChain(next('org_transfer_settings', cfg.org_transfer_settings)),
          };
        case 'dnc_numbers':
          return { select: () => selectChain(next('dnc_numbers', cfg.dnc_numbers)) };
        case 'org_spend_settings':
          return { select: () => selectChain(next('org_spend_settings', cfg.org_spend_settings)) };
        case 'org_telephony':
          return { select: () => selectChain(next('org_telephony', cfg.org_telephony)) };
        default:
          throw new Error(`fake supabase: unexpected table ${table}`);
      }
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      const configured = cfg.rpc?.[name];
      if (!configured) return { data: true, error: null };
      return next(`rpc:${name}`, configured);
    },
    _writes: writes,
    _rpcCalls: rpcCalls,
    // deno-lint-ignore no-explicit-any
  } as any;
  return supabase;
}

function makeFakeTelnyxClient(overrides: Partial<TelnyxClient> = {}): {
  client: TelnyxClient;
  calls: { method: string; args: unknown[] }[];
} {
  const calls: { method: string; args: unknown[] }[] = [];
  const record = (method: string, args: unknown[]) => calls.push({ method, args });
  const client = {
    dial: async (args: unknown) => {
      record('dial', [args]);
      return { callControlId: 'call-target-1' };
    },
    hangup: async (id: string) => record('hangup', [id]),
    getTelephonyCredential: async () => ({ sip_username: 'target-sip-user' }),
    holdConferenceParticipants: async (conferenceId: string, args: unknown) =>
      record('holdConferenceParticipants', [conferenceId, args]),
    unholdConferenceParticipants: async (conferenceId: string, args: unknown) =>
      record('unholdConferenceParticipants', [conferenceId, args]),
    createConference: async (args: unknown) => {
      record('createConference', [args]);
      return { id: 'conf-side-1', name: 'hyperdial-transfer' };
    },
    joinConference: async (conferenceId: string, args: unknown) =>
      record('joinConference', [conferenceId, args]),
    leaveConference: async (conferenceId: string, callControlId: string) =>
      record('leaveConference', [conferenceId, callControlId]),
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
  return { client, calls };
}

const OK = <T>(data: T): Result<T> => ({ data, error: null });

/**
 * TASK-T4 review fix-forward (BLOCKER 2): `runStartTransferAction`'s new external-target guard
 * chain (org_transfer_settings, dnc_numbers, checkSpendGate's own org_spend_settings/
 * org_telephony, the rate-limit count) touches 4 tables this fake never needed before. Spread
 * this into any test exercising a targetKind:'external' happy path so it isn't blocked by an
 * unconfigured table -- org_spend_settings/org_telephony default to "not connected" (checkSpendGate
 * fails OPEN, its own documented behavior, re-tested in spend-gate.test.ts, not reimplemented
 * here) and dnc_numbers/the rate count default to "no match"/"zero so far this hour".
 */
const EXTERNAL_TRANSFER_ALLOWED_DEFAULTS = {
  org_transfer_settings: [OK({ allow_external_transfers: true })],
  dnc_numbers: [OK(null)],
  org_spend_settings: [OK(null)],
  org_telephony: [OK(null)],
  call_transfersCount: [0],
};

const SESSION_ON_CALL = OK({
  id: 's-1',
  org_id: 'org-1',
  agent_id: 'agent-1',
  state: 'on_call',
  conference_id: 'conf-main',
  agent_leg_id: 'leg-agent-1',
  active_leg_id: 'leg-prospect-1',
});

const PROSPECT_LEG = OK({
  id: 'leg-prospect-1',
  call_control_id: 'call-prospect-1',
  kind: 'contact',
  state: 'claimed',
  held_at: null,
  contact_id: 'contact-1',
});

// ---------------------------------------------------------------------------
// Hold / Resume (AUD-6)
// ---------------------------------------------------------------------------

Deno.test('runHoldAction: happy path holds the prospect leg and stamps held_at', async () => {
  const supabase = makeFakeSupabase({
    dial_sessions: [SESSION_ON_CALL],
    call_legs: [PROSPECT_LEG],
  });
  const { client, calls } = makeFakeTelnyxClient();
  const result = await runHoldAction(supabase, client, 'org-1', 'agent', 'agent-1', {
    sessionId: 's-1',
  });
  assertEquals(result.status, 200);
  assertExists(result.body.heldAt);
  const hold = calls.find((c) => c.method === 'holdConferenceParticipants');
  assertExists(hold);
  assertEquals(hold!.args, ['conf-main', { callControlIds: ['call-prospect-1'] }]);
  const write = supabase._writes.find((w: { table: string }) => w.table === 'call_legs');
  assertExists(write);
  assertExists(write.patch.held_at);
});

Deno.test('runHoldAction: already held is a no-op, never re-issues the Telnyx hold', async () => {
  const supabase = makeFakeSupabase({
    dial_sessions: [SESSION_ON_CALL],
    call_legs: [OK({ ...PROSPECT_LEG.data, held_at: '2026-01-01T00:00:00Z' })],
  });
  const { client, calls } = makeFakeTelnyxClient();
  const result = await runHoldAction(supabase, client, 'org-1', 'agent', 'agent-1', {
    sessionId: 's-1',
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.heldAt, '2026-01-01T00:00:00Z');
  assertEquals(calls.length, 0);
});

Deno.test("runHoldAction: an agent acting on someone else's session is refused", async () => {
  const supabase = makeFakeSupabase({ dial_sessions: [SESSION_ON_CALL] });
  const { client } = makeFakeTelnyxClient();
  const result = await runHoldAction(supabase, client, 'org-1', 'agent', 'someone-else', {
    sessionId: 's-1',
  });
  assertEquals(result.status, 403);
});

Deno.test('runHoldAction: not on_call at all -> NOT_ON_CALL, never calls Telnyx', async () => {
  const supabase = makeFakeSupabase({
    dial_sessions: [OK({ ...SESSION_ON_CALL.data, state: 'wrap_up' })],
  });
  const { client, calls } = makeFakeTelnyxClient();
  const result = await runHoldAction(supabase, client, 'org-1', 'agent', 'agent-1', {
    sessionId: 's-1',
  });
  assertEquals(result.status, 409);
  assertEquals(result.body.code, 'NOT_ON_CALL');
  assertEquals(calls.length, 0);
});

Deno.test('runResumeAction: happy path unholds and clears held_at', async () => {
  const supabase = makeFakeSupabase({
    dial_sessions: [SESSION_ON_CALL],
    call_legs: [OK({ ...PROSPECT_LEG.data, held_at: '2026-01-01T00:00:00Z' })],
  });
  const { client, calls } = makeFakeTelnyxClient();
  const result = await runResumeAction(supabase, client, 'org-1', 'admin', 'admin-1', {
    sessionId: 's-1',
  });
  assertEquals(result.status, 200);
  assertEquals(result.body.heldAt, null);
  const unhold = calls.find((c) => c.method === 'unholdConferenceParticipants');
  assertExists(unhold);
  const write = supabase._writes.find((w: { table: string }) => w.table === 'call_legs');
  assertEquals(write.patch.held_at, null);
});

Deno.test('runResumeAction: not currently held is a no-op, never calls Telnyx', async () => {
  const supabase = makeFakeSupabase({
    dial_sessions: [SESSION_ON_CALL],
    call_legs: [PROSPECT_LEG],
  });
  const { client, calls } = makeFakeTelnyxClient();
  const result = await runResumeAction(supabase, client, 'org-1', 'admin', 'admin-1', {
    sessionId: 's-1',
  });
  assertEquals(result.status, 200);
  assertEquals(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Start transfer
// ---------------------------------------------------------------------------

Deno.test(
  'runStartTransferAction: rejects an invalid type/targetKind without touching the DB',
  async () => {
    const supabase = makeFakeSupabase({});
    const { client } = makeFakeTelnyxClient();
    const result = await runStartTransferAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'agent',
      'agent-1',
      {
        sessionId: 's-1',
        type: 'lukewarm',
        targetKind: 'member',
        targetUserId: 'u-1',
      }
    );
    assertEquals(result.status, 400);
  }
);

Deno.test('runStartTransferAction: external target requires a valid E.164 number', async () => {
  const supabase = makeFakeSupabase({});
  const { client } = makeFakeTelnyxClient();
  const result = await runStartTransferAction(
    supabase,
    client,
    'app-1',
    'conn-1',
    'org-1',
    'agent',
    'agent-1',
    {
      sessionId: 's-1',
      type: 'cold',
      targetKind: 'external',
      targetNumber: 'not-a-number',
    }
  );
  assertEquals(result.status, 400);
});

Deno.test(
  'runStartTransferAction: happy path (external cold) dials with the transfer client_state',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [SESSION_ON_CALL],
      call_legs: [PROSPECT_LEG],
      user_phone_numbers: [OK({ phone_number: '+15551230000' })],
      call_transfersInsert: OK({ id: 'transfer-1' }),
      ...EXTERNAL_TRANSFER_ALLOWED_DEFAULTS,
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartTransferAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'agent',
      'agent-1',
      {
        sessionId: 's-1',
        type: 'cold',
        targetKind: 'external',
        targetNumber: '+14155552671',
      }
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.transferId, 'transfer-1');
    const dialCall = calls.find((c) => c.method === 'dial');
    assertExists(dialCall);
    const dialArgs = dialCall!.args[0] as { to: string; from: string; clientState: string };
    assertEquals(dialArgs.to, '+14155552671');
    assertEquals(dialArgs.from, '+15551230000');
    const decoded = JSON.parse(atob(dialArgs.clientState));
    assertEquals(decoded, { org: 'org-1', transfer: 'transfer-1', kind: 'transfer_target' });
    const persisted = supabase._rpcCalls.find(
      (c: { name: string; args: Record<string, unknown> }) => c.name === 'transition_call_transfer'
    );
    assertExists(persisted);
    assertEquals(
      (persisted.args.p_fields as Record<string, unknown>).target_call_control_id,
      'call-target-1'
    );
  }
);

Deno.test(
  'runStartTransferAction: happy path (member warm) resolves the SIP URI via agentSipUri',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [SESSION_ON_CALL],
      call_legs: [PROSPECT_LEG],
      org_members: [OK({ user_id: 'teammate-1' }), OK({ telnyx_credential_id: 'cred-1' })],
      user_phone_numbers: [OK({ phone_number: '+15551230000' })],
      call_transfersInsert: OK({ id: 'transfer-2' }),
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartTransferAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'agent',
      'agent-1',
      {
        sessionId: 's-1',
        type: 'warm',
        targetKind: 'member',
        targetUserId: 'teammate-1',
      }
    );
    assertEquals(result.status, 200);
    const dialArgs = calls.find((c) => c.method === 'dial')!.args[0] as { to: string };
    assertEquals(dialArgs.to, 'sip:target-sip-user@sip.telnyx.com');
  }
);

Deno.test(
  'runStartTransferAction: 23505 on the insert maps to TRANSFER_IN_PROGRESS (TOCTOU close)',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [SESSION_ON_CALL],
      call_legs: [PROSPECT_LEG],
      user_phone_numbers: [OK({ phone_number: '+15551230000' })],
      call_transfersInsert: { data: null, error: { message: 'duplicate', code: '23505' } },
      ...EXTERNAL_TRANSFER_ALLOWED_DEFAULTS,
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartTransferAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'agent',
      'agent-1',
      {
        sessionId: 's-1',
        type: 'cold',
        targetKind: 'external',
        targetNumber: '+14155552671',
      }
    );
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'TRANSFER_IN_PROGRESS');
    assertEquals(calls.length, 0); // never reached dial()
  }
);

Deno.test(
  'runStartTransferAction: a dial() failure marks the row failed, never leaves it dangling',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [SESSION_ON_CALL],
      call_legs: [PROSPECT_LEG],
      user_phone_numbers: [OK({ phone_number: '+15551230000' })],
      call_transfersInsert: OK({ id: 'transfer-3' }),
      ...EXTERNAL_TRANSFER_ALLOWED_DEFAULTS,
    });
    const { client } = makeFakeTelnyxClient({
      dial: async () => {
        throw new Error('Telnyx rejected the dial');
      },
    });
    const result = await runStartTransferAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'agent',
      'agent-1',
      {
        sessionId: 's-1',
        type: 'cold',
        targetKind: 'external',
        targetNumber: '+14155552671',
      }
    );
    assertEquals(result.status, 502);
    const failCall = supabase._rpcCalls.find(
      (c: { name: string; args: Record<string, unknown> }) =>
        c.name === 'transition_call_transfer' && c.args.p_new_status === 'failed'
    );
    assertExists(failCall);
    assertEquals((failCall.args.p_fields as Record<string, unknown>).ended_reason, 'dial_failed');
  }
);

// ---------------------------------------------------------------------------
// Review fix-forward (BLOCKER 2): external-target guard chain
// ---------------------------------------------------------------------------

Deno.test(
  'runStartTransferAction: external target rejected when a premium/toll number, before any DB call',
  async () => {
    // No org_transfer_settings/etc. configured at all -- externalTransferRejectionReason must
    // reject BEFORE any of those tables are ever touched (a misconfigured harness here would
    // throw "no configured result", not silently pass).
    const supabase = makeFakeSupabase({
      dial_sessions: [SESSION_ON_CALL],
      call_legs: [PROSPECT_LEG],
    });
    const { client, calls } = makeFakeTelnyxClient();
    for (const targetNumber of ['+19005551234', '+12129761234', '+19115551234']) {
      const result = await runStartTransferAction(
        supabase,
        client,
        'app-1',
        'conn-1',
        'org-1',
        'agent',
        'agent-1',
        { sessionId: 's-1', type: 'cold', targetKind: 'external', targetNumber }
      );
      assertEquals(result.status, 400);
      assertEquals(result.body.code, 'EXTERNAL_TRANSFER_NUMBER_REJECTED');
    }
    assertEquals(calls.length, 0);
  }
);

Deno.test(
  'runStartTransferAction: external target rejected (403) when the org has not enabled external transfers',
  async () => {
    const supabase = makeFakeSupabase({
      org_transfer_settings: [OK({ allow_external_transfers: false })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartTransferAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'agent',
      'agent-1',
      { sessionId: 's-1', type: 'cold', targetKind: 'external', targetNumber: '+14155552671' }
    );
    assertEquals(result.status, 403);
    assertEquals(result.body.code, 'EXTERNAL_TRANSFERS_DISABLED');
    assertEquals(calls.length, 0); // never reached the DB session/leg lookup or Telnyx
  }
);

Deno.test(
  'runStartTransferAction: external target rejected when it is on the org DNC list',
  async () => {
    const supabase = makeFakeSupabase({
      org_transfer_settings: [OK({ allow_external_transfers: true })],
      dnc_numbers: [OK({ e164: '+14155552671' })],
    });
    const { client } = makeFakeTelnyxClient();
    const result = await runStartTransferAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'agent',
      'agent-1',
      { sessionId: 's-1', type: 'cold', targetKind: 'external', targetNumber: '+14155552671' }
    );
    assertEquals(result.status, 400);
    assertEquals(result.body.code, 'EXTERNAL_TRANSFER_NUMBER_REJECTED');
  }
);

Deno.test(
  'runStartTransferAction: external target rejected (429) at the per-agent rolling-hour rate limit',
  async () => {
    const supabase = makeFakeSupabase({
      org_transfer_settings: [OK({ allow_external_transfers: true })],
      dnc_numbers: [OK(null)],
      org_spend_settings: [OK(null)],
      org_telephony: [OK(null)],
      call_transfersCount: [10],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartTransferAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'agent',
      'agent-1',
      { sessionId: 's-1', type: 'cold', targetKind: 'external', targetNumber: '+14155552671' }
    );
    assertEquals(result.status, 429);
    assertEquals(result.body.code, 'EXTERNAL_TRANSFER_RATE_LIMIT');
    assertEquals(calls.length, 0);
  }
);

Deno.test(
  'runStartTransferAction: a member (internal) target skips every external-only guard',
  async () => {
    // Zero org_transfer_settings/dnc_numbers/org_spend_settings/org_telephony/
    // call_transfersCount configured -- a member target must never touch any of them (item e of
    // the review fix-forward dispatch: "member transfers are unaffected").
    const supabase = makeFakeSupabase({
      dial_sessions: [SESSION_ON_CALL],
      call_legs: [PROSPECT_LEG],
      org_members: [OK({ user_id: 'teammate-1' }), OK({ telnyx_credential_id: 'cred-1' })],
      user_phone_numbers: [OK({ phone_number: '+15551230000' })],
      call_transfersInsert: OK({ id: 'transfer-member-1' }),
    });
    const { client } = makeFakeTelnyxClient();
    const result = await runStartTransferAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'agent',
      'agent-1',
      { sessionId: 's-1', type: 'warm', targetKind: 'member', targetUserId: 'teammate-1' }
    );
    assertEquals(result.status, 200);
  }
);

// ---------------------------------------------------------------------------
// Complete / Cancel (warm)
// ---------------------------------------------------------------------------

const WARM_CONNECTED = OK({
  id: 'transfer-1',
  org_id: 'org-1',
  session_id: 's-1',
  contact_leg_id: 'leg-prospect-1',
  type: 'warm',
  target_kind: 'external',
  target_user_id: null,
  target_number: '+15559998888',
  target_call_control_id: 'call-target-1',
  side_conference_id: 'conf-side-1',
  status: 'connected',
});

Deno.test(
  'runCompleteTransferAction: happy path moves prospect to the side conference, agent back to main',
  async () => {
    const supabase = makeFakeSupabase({
      call_transfersSelect: [WARM_CONNECTED],
      dial_sessions: [SESSION_ON_CALL],
      // Third entry: enqueueTransferNote's own loadLegById re-read (for contact_id) after the move.
      call_legs: [PROSPECT_LEG, OK({ call_control_id: 'call-agent-1' }), PROSPECT_LEG],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runCompleteTransferAction(supabase, client, 'org-1', 'agent', 'agent-1', {
      transferId: 'transfer-1',
    });
    assertEquals(result.status, 200);
    assertEquals(
      calls.map((c) => c.method),
      ['leaveConference', 'joinConference', 'leaveConference', 'joinConference']
    );
    assertEquals(calls[0].args, ['conf-main', 'call-prospect-1']);
    assertEquals(calls[1].args, ['conf-side-1', { callControlId: 'call-prospect-1' }]);
    assertEquals(calls[2].args, ['conf-side-1', 'call-agent-1']);
    assertEquals(calls[3].args, ['conf-main', { callControlId: 'call-agent-1' }]);
    const legWrite = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) =>
        w.table === 'call_legs' && w.patch.transferred_to
    );
    assertExists(legWrite);
    assertEquals(legWrite.patch.transferred_to, '+15559998888');
    assertEquals(legWrite.patch.transfer_type, 'warm');
    const enqueued = supabase._rpcCalls.find((c: { name: string }) => c.name === 'enqueue_crm_job');
    assertExists(enqueued);
    assertEquals(enqueued.args.p_kind, 'transfer_note');
    const payload = enqueued.args.p_payload as Record<string, unknown>;
    assertEquals(payload.transfer_type, 'warm');
    assertEquals(payload.call_leg_id, 'leg-prospect-1');
    assertExists(payload.note_body);
  }
);

Deno.test(
  'runCompleteTransferAction: a cold (already-completed) transfer id is refused, not silently re-run',
  async () => {
    const supabase = makeFakeSupabase({
      call_transfersSelect: [OK({ ...WARM_CONNECTED.data, type: 'cold', status: 'completed' })],
    });
    const { client } = makeFakeTelnyxClient();
    const result = await runCompleteTransferAction(supabase, client, 'org-1', 'agent', 'agent-1', {
      transferId: 'transfer-1',
    });
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'TRANSFER_NOT_ACTIVE');
  }
);

Deno.test(
  'runCancelTransferAction: happy path hangs up the target, unwinds the agent+prospect back to normal',
  async () => {
    const supabase = makeFakeSupabase({
      call_transfersSelect: [WARM_CONNECTED],
      dial_sessions: [SESSION_ON_CALL],
      call_legs: [PROSPECT_LEG, OK({ call_control_id: 'call-agent-1' })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runCancelTransferAction(supabase, client, 'org-1', 'agent', 'agent-1', {
      transferId: 'transfer-1',
    });
    assertEquals(result.status, 200);
    assertEquals(calls[0].method, 'hangup');
    assertEquals(calls[0].args, ['call-target-1']);
    assertEquals(
      calls.slice(1).map((c) => c.method),
      ['leaveConference', 'joinConference', 'unholdConferenceParticipants']
    );
    const legWrite = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) => w.table === 'call_legs'
    );
    assertEquals(legWrite.patch.held_at, null);
    const cancelCall = supabase._rpcCalls.find(
      (c: { name: string; args: Record<string, unknown> }) =>
        c.name === 'transition_call_transfer' && c.args.p_new_status === 'cancelled'
    );
    assertExists(cancelCall);
  }
);

// ---------------------------------------------------------------------------
// Target leg webhook processing
// ---------------------------------------------------------------------------

const COLD_DIALING = OK({
  id: 'transfer-4',
  org_id: 'org-1',
  session_id: 's-1',
  contact_leg_id: 'leg-prospect-1',
  type: 'cold',
  target_kind: 'external',
  target_user_id: null,
  target_number: '+15559998888',
  target_call_control_id: 'call-target-1',
  side_conference_id: null,
  status: 'dialing',
});

Deno.test(
  'processTelnyxTransferEvent: cold, call.answered -- moves prospect to a fresh side conference and completes immediately',
  async () => {
    const supabase = makeFakeSupabase({
      call_transfersSelect: [COLD_DIALING],
      dial_sessions: [SESSION_ON_CALL],
      // Second entry: enqueueTransferNote's own loadLegById re-read (for contact_id) after the move.
      call_legs: [PROSPECT_LEG, PROSPECT_LEG],
      rpc: { transition_call_transfer: [OK(true)] },
    });
    const { client, calls } = makeFakeTelnyxClient();
    await processTelnyxTransferEvent(supabase, client, {
      orgId: 'org-1',
      eventType: 'call.answered',
      callControlId: 'call-target-1',
      transferId: 'transfer-4',
    });
    assertEquals(
      calls.map((c) => c.method),
      ['createConference', 'leaveConference', 'joinConference']
    );
    assertEquals(calls[1].args, ['conf-main', 'call-prospect-1']);
    assertEquals(calls[2].args, ['conf-side-1', { callControlId: 'call-prospect-1' }]);
    const completeCall = supabase._rpcCalls.find(
      (c: { name: string; args: Record<string, unknown> }) =>
        c.name === 'transition_call_transfer' && c.args.p_new_status === 'completed'
    );
    assertExists(completeCall);
    const sessionUpdate = supabase._rpcCalls.find(
      (c: { name: string }) => c.name === 'transition_session'
    );
    assertExists(sessionUpdate);
    assertEquals(sessionUpdate.args.p_new_state, 'wrap_up');
  }
);

const WARM_DIALING = OK({ ...COLD_DIALING.data, id: 'transfer-5', type: 'warm' });

Deno.test(
  'processTelnyxTransferEvent: warm, call.answered -- holds the prospect in main, moves the AGENT into the side conference',
  async () => {
    const supabase = makeFakeSupabase({
      call_transfersSelect: [WARM_DIALING],
      dial_sessions: [SESSION_ON_CALL],
      call_legs: [PROSPECT_LEG, OK({ call_control_id: 'call-agent-1' })],
      rpc: { transition_call_transfer: [OK(true)] },
    });
    const { client, calls } = makeFakeTelnyxClient();
    await processTelnyxTransferEvent(supabase, client, {
      orgId: 'org-1',
      eventType: 'call.answered',
      callControlId: 'call-target-1',
      transferId: 'transfer-5',
    });
    assertEquals(
      calls.map((c) => c.method),
      ['createConference', 'holdConferenceParticipants', 'leaveConference', 'joinConference']
    );
    assertEquals(calls[1].args, ['conf-main', { callControlIds: ['call-prospect-1'] }]);
    assertEquals(calls[2].args, ['conf-main', 'call-agent-1']);
    assertEquals(calls[3].args, ['conf-side-1', { callControlId: 'call-agent-1' }]);
    const connectedCall = supabase._rpcCalls.find(
      (c: { name: string; args: Record<string, unknown> }) =>
        c.name === 'transition_call_transfer' && c.args.p_new_status === 'connected'
    );
    assertExists(connectedCall);
    const legWrite = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) => w.table === 'call_legs'
    );
    assertExists(legWrite.patch.held_at);
  }
);

Deno.test(
  'processTelnyxTransferEvent: call.hangup while dialing (never answered) -- marks failed, nothing to unwind',
  async () => {
    const supabase = makeFakeSupabase({
      call_transfersSelect: [COLD_DIALING],
      rpc: { transition_call_transfer: [OK(true)] },
    });
    const { client, calls } = makeFakeTelnyxClient();
    await processTelnyxTransferEvent(supabase, client, {
      orgId: 'org-1',
      eventType: 'call.hangup',
      callControlId: 'call-target-1',
      transferId: 'transfer-4',
    });
    assertEquals(calls.length, 0); // nothing to unwind -- prospect/agent were never touched
    const failCall = supabase._rpcCalls.find(
      (c: { name: string; args: Record<string, unknown> }) =>
        c.name === 'transition_call_transfer' && c.args.p_new_status === 'failed'
    );
    assertExists(failCall);
    assertEquals(
      (failCall.args.p_fields as Record<string, unknown>).ended_reason,
      'target_no_answer'
    );
  }
);

Deno.test(
  'processTelnyxTransferEvent: call.hangup while connected (warm, target hung up mid-call) -- unwinds the agent back to main',
  async () => {
    const supabase = makeFakeSupabase({
      call_transfersSelect: [
        OK({ ...WARM_DIALING.data, status: 'connected', side_conference_id: 'conf-side-1' }),
      ],
      dial_sessions: [SESSION_ON_CALL],
      call_legs: [PROSPECT_LEG, OK({ call_control_id: 'call-agent-1' })],
      rpc: { transition_call_transfer: [OK(true)] },
    });
    const { client, calls } = makeFakeTelnyxClient();
    await processTelnyxTransferEvent(supabase, client, {
      orgId: 'org-1',
      eventType: 'call.hangup',
      callControlId: 'call-target-1',
      transferId: 'transfer-5',
    });
    assertEquals(
      calls.map((c) => c.method),
      ['leaveConference', 'joinConference', 'unholdConferenceParticipants']
    );
    const failCall = supabase._rpcCalls.find(
      (c: { name: string; args: Record<string, unknown> }) =>
        c.name === 'transition_call_transfer' && c.args.p_new_status === 'failed'
    );
    assertExists(failCall);
    assertEquals((failCall.args.p_fields as Record<string, unknown>).ended_reason, 'target_hangup');
  }
);

Deno.test(
  'processTelnyxTransferEvent: already-resolved row (redelivery) is a pure no-op',
  async () => {
    const supabase = makeFakeSupabase({
      call_transfersSelect: [OK({ ...COLD_DIALING.data, status: 'completed' })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    await processTelnyxTransferEvent(supabase, client, {
      orgId: 'org-1',
      eventType: 'call.answered',
      callControlId: 'call-target-1',
      transferId: 'transfer-4',
    });
    assertEquals(calls.length, 0);
    assertEquals(supabase._rpcCalls.length, 0);
  }
);

// ---------------------------------------------------------------------------
// Review fix-forward (SHOULD): cancelInFlightTransferForSession
// ---------------------------------------------------------------------------

Deno.test(
  'cancelInFlightTransferForSession: no in-flight transfer for the session is a pure no-op',
  async () => {
    const supabase = makeFakeSupabase({ call_transfersSelect: [OK(null)] });
    const { client, calls } = makeFakeTelnyxClient();
    await cancelInFlightTransferForSession(supabase, client, 'org-1', 's-1', 'agent_hangup');
    assertEquals(calls.length, 0);
    assertEquals(supabase._rpcCalls.length, 0);
  }
);

Deno.test(
  'cancelInFlightTransferForSession: dialing -- hangs up the target only, no conference unwind needed',
  async () => {
    const supabase = makeFakeSupabase({
      call_transfersSelect: [COLD_DIALING],
      rpc: { transition_call_transfer: [OK(true)] },
    });
    const { client, calls } = makeFakeTelnyxClient();
    await cancelInFlightTransferForSession(supabase, client, 'org-1', 's-1', 'agent_hangup');
    assertEquals(
      calls.map((c) => c.method),
      ['hangup']
    );
    assertEquals(calls[0].args, ['call-target-1']);
    const cancelCall = supabase._rpcCalls.find(
      (c: { name: string; args: Record<string, unknown> }) =>
        c.name === 'transition_call_transfer' && c.args.p_new_status === 'cancelled'
    );
    assertExists(cancelCall);
    assertEquals(
      (cancelCall.args.p_fields as Record<string, unknown>).ended_reason,
      'agent_hangup'
    );
    assertEquals(cancelCall.args.p_expected_statuses, ['dialing', 'connected']);
  }
);

Deno.test(
  'cancelInFlightTransferForSession: connected -- hangs up the target AND unwinds the agent back to main',
  async () => {
    const supabase = makeFakeSupabase({
      call_transfersSelect: [WARM_CONNECTED],
      dial_sessions: [SESSION_ON_CALL],
      call_legs: [PROSPECT_LEG, OK({ call_control_id: 'call-agent-1' })],
      rpc: { transition_call_transfer: [OK(true)] },
    });
    const { client, calls } = makeFakeTelnyxClient();
    await cancelInFlightTransferForSession(supabase, client, 'org-1', 's-1', 'session_ended');
    assertEquals(
      calls.map((c) => c.method),
      ['hangup', 'leaveConference', 'joinConference', 'unholdConferenceParticipants']
    );
    assertEquals(calls[0].args, ['call-target-1']);
    const legWrite = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) => w.table === 'call_legs'
    );
    assertExists(legWrite);
    assertEquals(legWrite.patch.held_at, null);
    const cancelCall = supabase._rpcCalls.find(
      (c: { name: string; args: Record<string, unknown> }) =>
        c.name === 'transition_call_transfer' && c.args.p_new_status === 'cancelled'
    );
    assertExists(cancelCall);
    assertEquals(
      (cancelCall.args.p_fields as Record<string, unknown>).ended_reason,
      'session_ended'
    );
  }
);

import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import type { TelnyxClient } from './telnyx-client.ts';
import {
  processTelnyxCoachingEvent,
  runStartCoachingAction,
  runSwitchCoachingModeAction,
  runTakeoverAction,
  endActiveCoachingSessionsForManager,
} from './coaching-core.ts';

// ---------------------------------------------------------------------------
// A hand-rolled, purpose-built fake supabase -- NOT a general query engine. Each table's
// `select()...maybeSingle()` reads are pre-seeded per test as an ORDERED array (this module
// calls `dial_sessions` exactly twice in start's happy/manager-busy paths -- manager, then
// target -- so results are consumed by call order, not by matching a WHERE clause). `update()`/
// `insert()` calls are captured into `_writes` for assertions rather than modeled with real
// semantics -- coaching-core.ts never reads a write's own return value except `insert().select()
// .single()`, which IS modeled (via `coachingInsert`).
// ---------------------------------------------------------------------------
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
    // MISSION-5 TASK-M5-B2: endActiveCoachingSessionsForManager awaits the query directly (a
    // multi-row select, no `.maybeSingle()`) -- same `result` shape either way.
    then: (resolve: (v: unknown) => void) => resolve(result),
  };
  return chain;
}

function updateChain(onSettle: () => void) {
  // deno-lint-ignore no-explicit-any
  const chain: any = {
    eq: () => chain,
    neq: () => chain,
    in: () => chain,
    then: (resolve: (v: unknown) => void) => {
      onSettle();
      resolve({ error: null });
    },
  };
  return chain;
}

/** MISSION-5 TASK-M5-N1: models the ONE conditional-update-with-a-returned-row shape this module
 *  needs (`runTakeoverAction`'s own race-guard claim on `coaching_sessions.taken_over_at`) --
 *  distinct from the generic fire-and-forget `updateChain` above, which has no `.select()` at
 *  all. `result` is configurable per test: a row back means "this call won the claim," `null`
 *  data means "lost the race." */
function claimChain(onSettle: () => void, result: Result) {
  // deno-lint-ignore no-explicit-any
  const chain: any = {
    eq: () => chain,
    is: () => chain,
    select: () => ({
      maybeSingle: async () => {
        onSettle();
        return result;
      },
    }),
  };
  return chain;
}

function makeFakeSupabase(cfg: {
  dial_sessions?: Result[];
  call_legs?: Result[];
  org_members?: Result[];
  org_manager_pods?: Result[];
  user_phone_numbers?: Result[];
  profiles?: Result[];
  coachingInsert?: Result;
  // deno-lint-ignore no-explicit-any
  coachingSelect?: Result<any>[];
  // MISSION-5 TASK-M5-N1
  org_call_takeover_settings?: Result[];
  // Result of runTakeoverAction's own conditional-claim UPDATE (`.select('id').maybeSingle()`)
  // -- a row back means "won the claim", `null` data means "lost the race" (already taken over).
  takeoverClaimResult?: Result;
  // MISSION-5 TASK-M5-N1: transition_leg/transition_session results, in CALL ORDER
  // (runTakeoverAction always calls transition_leg first, then transition_session).
  rpcResults?: Result[];
}) {
  const counters: Record<string, number> = {};
  const next = (key: string, arr?: Result[]): Result => {
    const i = counters[key] ?? 0;
    counters[key] = i + 1;
    if (!arr || !arr[i]) throw new Error(`fake supabase: no configured result #${i} for ${key}`);
    return arr[i];
  };
  const writes: { table: string; patch: Record<string, unknown> }[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];

  const supabase = {
    // deno-lint-ignore no-explicit-any
    rpc(name: string, args: Record<string, unknown>): any {
      rpcCalls.push({ name, args });
      const result = cfg.rpcResults ? next('rpc', cfg.rpcResults) : { data: true, error: null };
      return Promise.resolve(result);
    },
    from(table: string) {
      switch (table) {
        case 'dial_sessions':
          return {
            select: () => selectChain(next('dial_sessions', cfg.dial_sessions)),
            // MISSION-5 TASK-M5-B2: a successful coaching start clears the target's raised_hand_at.
            update: (patch: Record<string, unknown>) =>
              updateChain(() => writes.push({ table, patch })),
          };
        case 'call_legs':
          return { select: () => selectChain(next('call_legs', cfg.call_legs)) };
        case 'org_members':
          return {
            select: () => selectChain(next('org_members', cfg.org_members)),
            update: (patch: Record<string, unknown>) =>
              updateChain(() => writes.push({ table, patch })),
          };
        // MISSION-5 TASK-M5-B4: pod-scope.ts's own isManagerScopedToAgent reads this table --
        // only ever reached when a test's callerRole is 'manager' (every existing test here
        // passes 'owner', which never touches it, hence no `org_manager_pods` cfg needed on any
        // of them).
        case 'org_manager_pods':
          return { select: () => selectChain(next('org_manager_pods', cfg.org_manager_pods)) };
        case 'user_phone_numbers':
          return { select: () => selectChain(next('user_phone_numbers', cfg.user_phone_numbers)) };
        case 'profiles':
          return { select: () => selectChain(next('profiles', cfg.profiles)) };
        case 'coaching_sessions':
          return {
            insert: (row: Record<string, unknown>) => {
              writes.push({ table: 'coaching_sessions:insert', patch: row });
              return {
                select: () => ({
                  single: async () =>
                    cfg.coachingInsert ?? { data: null, error: { message: 'not configured' } },
                }),
              };
            },
            select: () => selectChain(next('coaching_sessions', cfg.coachingSelect)),
            // MISSION-5 TASK-M5-N1: runTakeoverAction's own conditional claim is the ONE update
            // on this table that reads its own result back (`.select('id').maybeSingle()`) --
            // routed to `claimChain` by the presence of `taken_over_at` in the patch; every other
            // caller (runSwitchCoachingModeAction's plain `{mode}` patch) keeps the old
            // fire-and-forget `updateChain` behavior unchanged.
            update: (patch: Record<string, unknown>) => {
              writes.push({ table, patch });
              if ('taken_over_at' in patch) {
                return claimChain(
                  () => {},
                  cfg.takeoverClaimResult ?? { data: { id: 'coaching-1' }, error: null }
                );
              }
              return updateChain(() => {});
            },
          };
        // MISSION-5 TASK-M5-N1
        case 'org_call_takeover_settings':
          return {
            select: () =>
              selectChain(next('org_call_takeover_settings', cfg.org_call_takeover_settings)),
          };
        // TASK-A1: logOrgAction's own insert -- a plain fire-and-forget write, modeled the same
        // "capture into _writes, always succeed" way as every other insert in this fake.
        case 'org_audit_log':
          return {
            insert: (row: Record<string, unknown>) => {
              writes.push({ table: 'org_audit_log:insert', patch: row });
              return Promise.resolve({ error: null });
            },
          };
        default:
          throw new Error(`fake supabase: unexpected table ${table}`);
      }
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
      return { callControlId: 'call-manager-1' };
    },
    hangup: async (id: string) => record('hangup', [id]),
    getTelephonyCredential: async () => ({ sip_username: 'mgr-sip-user' }),
    findTelephonyCredentialByName: async () => null,
    createTelephonyCredential: async () => ({ id: 'cred-new' }),
    joinConference: async (conferenceId: string, args: unknown) =>
      record('joinConference', [conferenceId, args]),
    // MISSION-5 TASK-M5-N1
    leaveConference: async (conferenceId: string, callControlId: string) =>
      record('leaveConference', [conferenceId, callControlId]),
    updateConferenceSupervisorRole: async (conferenceId: string, args: unknown) =>
      record('updateConferenceSupervisorRole', [conferenceId, args]),
    ...overrides,
    // deno-lint-ignore no-explicit-any
  } as any;
  return { client, calls };
}

const OK = <T>(data: T): Result<T> => ({ data, error: null });
const EMPTY: Result<null> = { data: null, error: null };

Deno.test('runStartCoachingAction: rejects an invalid mode without touching the DB', async () => {
  const supabase = makeFakeSupabase({});
  const { client } = makeFakeTelnyxClient();
  const result = await runStartCoachingAction(
    supabase,
    client,
    'app-1',
    'conn-1',
    'org-1',
    'mgr-1',
    'owner',
    { targetUserId: 'agent-1', mode: 'yell' }
  );
  assertEquals(result.status, 400);
});

Deno.test(
  'runStartCoachingAction: rejects coaching your own session without touching the DB',
  async () => {
    const supabase = makeFakeSupabase({});
    const { client } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'mgr-1', mode: 'listen' }
    );
    assertEquals(result.status, 400);
  }
);

Deno.test(
  'MISSION-5 TASK-M5-B4: a manager outside their pod scope is rejected before touching dial_sessions',
  async () => {
    const supabase = makeFakeSupabase({
      org_members: [OK({ pod_id: 'pod-a' })],
      org_manager_pods: [EMPTY], // no row scoping this manager to pod-a
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'manager',
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    assertEquals(result.status, 403);
    assertEquals(calls.length, 0); // never dialed -- rejected before the busy/target checks
  }
);

// Positive control for the rejection above: an in-scope manager (org_manager_pods DOES have a
// row for pod-a) passes the gate and reaches the normal MANAGER_BUSY/TARGET_NOT_ON_CALL checks
// exactly like every 'owner' test above -- proves the gate isn't unconditionally closed.
Deno.test(
  'MISSION-5 TASK-M5-B4: a manager INSIDE their pod scope passes the gate and reaches the normal flow',
  async () => {
    const supabase = makeFakeSupabase({
      org_members: [OK({ pod_id: 'pod-a' })],
      org_manager_pods: [OK({ pod_id: 'pod-a' })],
      dial_sessions: [OK({ id: 's-mgr', state: 'on_call' })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'manager',
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    // Reached the manager-busy check (their own session is on_call) -- proof the pod-scope gate
    // let this request through to the rest of the function, not rejected at 403.
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'MANAGER_BUSY');
    assertEquals(calls.length, 0);
  }
);

Deno.test(
  'runStartCoachingAction: MANAGER_BUSY when the manager is on their own call',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [
        OK({ id: 's-mgr', state: 'on_call', conference_id: 'conf-mgr', agent_leg_id: null }),
      ],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'MANAGER_BUSY');
    assertEquals(calls.length, 0); // never even reached Telnyx
  }
);

Deno.test(
  'runStartCoachingAction: TARGET_NOT_ON_CALL when the target has no live conference',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [
        EMPTY, // manager: no session at all -- not busy
        OK({ id: 's-target', state: 'dialing', conference_id: null, agent_leg_id: null }),
      ],
    });
    const { client } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'TARGET_NOT_ON_CALL');
  }
);

Deno.test(
  'runStartCoachingAction: whisper mode with no agent leg on record is also TARGET_NOT_ON_CALL',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [
        EMPTY,
        OK({ id: 's-target', state: 'on_call', conference_id: 'conf-1', agent_leg_id: null }),
      ],
      // MISSION-5 TASK-M5-B2 (EC-8): alreadyCoachedError's own pre-check runs BEFORE the
      // whisper-specific agent-leg check -- EMPTY means "nobody else is already coaching this
      // target", so this test still reaches (and fails at) the check it's actually testing.
      coachingSelect: [EMPTY],
    });
    const { client } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'agent-1', mode: 'whisper' }
    );
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'TARGET_NOT_ON_CALL');
  }
);

Deno.test(
  'runStartCoachingAction: 23505 on the insert maps to MANAGER_BUSY (TOCTOU close)',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [
        EMPTY,
        OK({ id: 's-target', state: 'on_call', conference_id: 'conf-1', agent_leg_id: null }),
      ],
      // The pre-check itself passes (nobody found) -- this test is specifically about losing a
      // race AT THE INSERT, after the pre-check already said it was clear.
      coachingSelect: [EMPTY],
      coachingInsert: { data: null, error: { message: 'duplicate', code: '23505' } },
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'MANAGER_BUSY');
    assertEquals(calls.length, 0); // never reached dial()
  }
);

Deno.test(
  "MISSION-5 TASK-M5-B2 (EC-8): the pre-check 409s with the OTHER manager's name before ever dialing",
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [
        EMPTY,
        OK({ id: 's-target', state: 'on_call', conference_id: 'conf-1', agent_leg_id: null }),
      ],
      coachingSelect: [OK({ manager_id: 'mgr-other' })],
      profiles: [OK({ first_name: 'Pat', last_name: 'Lee' })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'ALREADY_COACHED');
    assertEquals(result.body.error, 'Already being coached by Pat Lee');
    assertEquals(calls.length, 0); // never even dialed
  }
);

Deno.test(
  'MISSION-5 B2 SHOULD follow-up: the SAME manager double-clicking gets a self-referential message, not their own name',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [
        EMPTY,
        OK({ id: 's-target', state: 'on_call', conference_id: 'conf-1', agent_leg_id: null }),
      ],
      // The caller (mgr-1) is already the one coaching this target -- same shape as the
      // OTHER-manager pre-check test above, just with the winning manager_id matching the caller.
      coachingSelect: [OK({ manager_id: 'mgr-1' })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'ALREADY_COACHED');
    assertEquals(result.body.error, 'You are already coaching this call.');
    assertEquals(calls.length, 0); // never even dialed
  }
);

Deno.test(
  'MISSION-5 TASK-M5-B2 (EC-8): a race at the insert (target-index 23505) still names the winner, not a generic MANAGER_BUSY',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [
        EMPTY,
        OK({ id: 's-target', state: 'on_call', conference_id: 'conf-1', agent_leg_id: null }),
      ],
      // First select (the pre-check) finds nothing -- the race hasn't landed yet. Second select
      // (inside the 23505 handler, re-checking who actually won) finds the other manager.
      coachingSelect: [EMPTY, OK({ manager_id: 'mgr-other' })],
      coachingInsert: {
        data: null,
        error: {
          message:
            'duplicate key value violates unique constraint "coaching_sessions_one_active_per_target"',
          code: '23505',
        },
      },
      profiles: [OK({ first_name: 'Pat', last_name: 'Lee' })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'ALREADY_COACHED');
    assertEquals(result.body.error, 'Already being coached by Pat Lee');
    assertEquals(calls.length, 0); // never reached dial()
  }
);

Deno.test(
  "MISSION-5 TASK-M5-B2: a successful start clears the TARGET session's raised_hand_at",
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [
        EMPTY,
        OK({ id: 's-target', state: 'on_call', conference_id: 'conf-1', agent_leg_id: null }),
      ],
      org_members: [OK({ telnyx_credential_id: 'cred-1' })],
      user_phone_numbers: [OK({ phone_number: '+15551230000' })],
      coachingSelect: [EMPTY],
      coachingInsert: OK({ id: 'coaching-1' }),
    });
    const { client } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    assertEquals(result.status, 200);
    const clearWrite = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) =>
        w.table === 'dial_sessions' && w.patch.raised_hand_at === null
    );
    assertExists(clearWrite);
  }
);

Deno.test(
  'runStartCoachingAction: happy path dials the manager SIP URI with a coaching client_state, never joins yet',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [
        EMPTY,
        OK({
          id: 's-target',
          state: 'on_call',
          conference_id: 'conf-1',
          agent_leg_id: 'leg-agent',
        }),
      ],
      call_legs: [OK({ call_control_id: 'call-agent-1' })],
      org_members: [OK({ telnyx_credential_id: 'cred-1' })],
      user_phone_numbers: [OK({ phone_number: '+15551230000' })],
      coachingSelect: [EMPTY],
      coachingInsert: OK({ id: 'coaching-1' }),
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'agent-1', mode: 'whisper' }
    );
    assertEquals(result.status, 200);
    assertEquals(result.body.coachingId, 'coaching-1');
    const dialCall = calls.find((c) => c.method === 'dial');
    assertExists(dialCall);
    const dialArgs = dialCall!.args[0] as {
      connectionId: string;
      to: string;
      from: string;
      clientState: string;
    };
    assertEquals(dialArgs.connectionId, 'app-1');
    assertEquals(dialArgs.to, 'sip:mgr-sip-user@sip.telnyx.com');
    assertEquals(dialArgs.from, '+15551230000');
    // Never joins the target conference here -- that's processTelnyxCoachingEvent's job, once
    // call.answered actually fires. Confirms the split this file's own header describes.
    assertEquals(
      calls.some((c) => c.method === 'joinConference'),
      false
    );
    const decoded = JSON.parse(atob(dialArgs.clientState));
    assertEquals(decoded, {
      org: 'org-1',
      coaching: 'coaching-1',
      kind: 'coaching',
      mode: 'whisper',
      targetSession: 's-target',
    });
    // TASK-A1: a successful start is audit-logged.
    const auditWrite = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) => w.table === 'org_audit_log:insert'
    );
    assertExists(auditWrite);
    assertEquals(auditWrite.patch.action, 'coaching.start');
    assertEquals(auditWrite.patch.actor_user_id, 'mgr-1');
    assertEquals(auditWrite.patch.target_id, 's-target');
  }
);

Deno.test(
  'runStartCoachingAction: a dial() failure ends the row instead of leaving it dangling',
  async () => {
    const supabase = makeFakeSupabase({
      dial_sessions: [
        EMPTY,
        OK({ id: 's-target', state: 'on_call', conference_id: 'conf-1', agent_leg_id: null }),
      ],
      org_members: [OK({ telnyx_credential_id: 'cred-1' })],
      user_phone_numbers: [OK({ phone_number: '+15551230000' })],
      coachingSelect: [EMPTY],
      coachingInsert: OK({ id: 'coaching-1' }),
    });
    const { client } = makeFakeTelnyxClient({
      dial: async () => {
        throw new Error('Telnyx rejected the dial');
      },
    });
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
      'owner',
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    assertEquals(result.status, 502);
    const endedWrite = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) =>
        w.table === 'coaching_sessions' && w.patch.status === 'ended'
    );
    assertExists(endedWrite);
    assertEquals(endedWrite.patch.ended_reason, 'error');
  }
);

Deno.test(
  'runSwitchCoachingModeAction: 404 when the row does not exist for this manager',
  async () => {
    const supabase = makeFakeSupabase({ coachingSelect: [EMPTY] });
    const { client } = makeFakeTelnyxClient();
    const result = await runSwitchCoachingModeAction(supabase, client, 'org-1', 'mgr-1', {
      coachingId: 'coaching-1',
      mode: 'whisper',
    });
    assertEquals(result.status, 404);
  }
);

Deno.test('runSwitchCoachingModeAction: NOT_ACTIVE while the leg is still connecting', async () => {
  const supabase = makeFakeSupabase({
    coachingSelect: [
      OK({
        id: 'coaching-1',
        target_session_id: 's-target',
        manager_call_control_id: null,
        status: 'starting',
      }),
    ],
  });
  const { client } = makeFakeTelnyxClient();
  const result = await runSwitchCoachingModeAction(supabase, client, 'org-1', 'mgr-1', {
    coachingId: 'coaching-1',
    mode: 'whisper',
  });
  assertEquals(result.status, 409);
  assertEquals(result.body.code, 'NOT_ACTIVE');
});

Deno.test(
  'runSwitchCoachingModeAction: target no longer on_call ends the row and hangs up, TARGET_NOT_ON_CALL',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [
        OK({
          id: 'coaching-1',
          target_session_id: 's-target',
          manager_call_control_id: 'call-manager-1',
          status: 'active',
        }),
      ],
      dial_sessions: [
        OK({ id: 's-target', state: 'wrap_up', conference_id: 'conf-1', agent_leg_id: null }),
      ],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runSwitchCoachingModeAction(supabase, client, 'org-1', 'mgr-1', {
      coachingId: 'coaching-1',
      mode: 'whisper',
    });
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'TARGET_NOT_ON_CALL');
    assertEquals(
      calls.some((c) => c.method === 'hangup' && c.args[0] === 'call-manager-1'),
      true
    );
  }
);

Deno.test(
  'runSwitchCoachingModeAction: happy path calls updateConferenceSupervisorRole with the mapped role',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [
        OK({
          id: 'coaching-1',
          target_session_id: 's-target',
          manager_call_control_id: 'call-manager-1',
          status: 'active',
        }),
      ],
      dial_sessions: [
        OK({
          id: 's-target',
          state: 'on_call',
          conference_id: 'conf-1',
          agent_leg_id: 'leg-agent',
        }),
      ],
      call_legs: [OK({ call_control_id: 'call-agent-1' })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runSwitchCoachingModeAction(supabase, client, 'org-1', 'mgr-1', {
      coachingId: 'coaching-1',
      mode: 'whisper',
    });
    assertEquals(result.status, 200);
    const call = calls.find((c) => c.method === 'updateConferenceSupervisorRole');
    assertExists(call);
    assertEquals(call!.args[0], 'conf-1');
    assertEquals(call!.args[1], {
      callControlId: 'call-manager-1',
      supervisorRole: 'whisper',
      whisperCallControlIds: ['call-agent-1'],
    });
  }
);

// ---------------------------------------------------------------------------
// MISSION-5 TASK-M5-N1: runTakeoverAction
// ---------------------------------------------------------------------------

function baseTakeoverRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'coaching-1',
    target_session_id: 's-target',
    target_user_id: 'agent-1',
    manager_id: 'mgr-1',
    manager_call_control_id: 'call-manager-1',
    mode: 'whisper',
    status: 'active',
    taken_over_at: null,
    ...overrides,
  };
}

function baseTakeoverTargetSession(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-target',
    state: 'on_call',
    conference_id: 'conf-1',
    agent_leg_id: 'leg-agent',
    ...overrides,
  };
}

Deno.test(
  'runTakeoverAction: happy path -- promotes to barge, leaves then hangs up the agent leg, transitions leg+session, logs once',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [OK(baseTakeoverRow())],
      org_call_takeover_settings: [OK({ enabled: true })],
      dial_sessions: [OK(baseTakeoverTargetSession())],
      call_legs: [OK({ call_control_id: 'call-agent-1', state: 'answered' })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'owner', {
      coachingId: 'coaching-1',
    });

    assertEquals(result.status, 200);
    assertEquals(result.body, { ok: true, roleUpdateFailed: false });

    const roleCall = calls.find((c) => c.method === 'updateConferenceSupervisorRole');
    assertExists(roleCall);
    assertEquals(roleCall!.args[0], 'conf-1');
    assertEquals(roleCall!.args[1], { callControlId: 'call-manager-1', supervisorRole: 'barge' });

    const leaveIndex = calls.findIndex((c) => c.method === 'leaveConference');
    const hangupIndex = calls.findIndex((c) => c.method === 'hangup');
    assertEquals(leaveIndex >= 0, true);
    assertEquals(calls[leaveIndex].args, ['conf-1', 'call-agent-1']);
    assertEquals(calls[hangupIndex].args, ['call-agent-1']);
    // MISSION-5 TASK-M5-N1 (api-evidence.md): leave BEFORE hangup, not the other order.
    assertEquals(leaveIndex < hangupIndex, true);

    // deno-lint-ignore no-explicit-any
    const rpcCalls = (supabase as { _rpcCalls: { name: string; args: any }[] })._rpcCalls;
    assertEquals(rpcCalls[0].name, 'transition_leg');
    assertEquals(rpcCalls[0].args.p_call_control_id, 'call-agent-1');
    assertEquals(rpcCalls[0].args.p_expected_states, ['answered']);
    assertEquals(rpcCalls[0].args.p_new_state, 'ended');
    assertEquals(rpcCalls[0].args.p_fields.hangup_cause, 'supervisor_takeover');
    assertExists(rpcCalls[0].args.p_fields.ended_at);
    assertEquals(rpcCalls[1].name, 'transition_session');
    assertEquals(rpcCalls[1].args.p_session, 's-target');
    assertEquals(rpcCalls[1].args.p_expected_states, ['on_call', 'paused_agent_lost']);
    assertEquals(rpcCalls[1].args.p_new_state, 'paused');
    assertEquals(rpcCalls[1].args.p_fields, {
      pause_reason: 'call_taken_over_by_manager',
      taken_over_by_manager_id: 'mgr-1',
      agent_leg_id: null,
      active_leg_id: null,
      conference_id: null,
      paused_agent_lost_from: null,
    });

    const writes = (supabase as { _writes: { table: string; patch: Record<string, unknown> }[] })
      ._writes;
    const auditWrite = writes.find((w) => w.table === 'org_audit_log:insert');
    assertExists(auditWrite);
    assertEquals(auditWrite!.patch.action, 'session.call_takeover');
    assertEquals(auditWrite!.patch.actor_user_id, 'mgr-1');
    // Exactly ONE audit row per takeover.
    assertEquals(writes.filter((w) => w.table === 'org_audit_log:insert').length, 1);
  }
);

Deno.test(
  'runTakeoverAction: already barge -- does not re-call updateConferenceSupervisorRole',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [OK(baseTakeoverRow({ mode: 'barge' }))],
      org_call_takeover_settings: [OK({ enabled: true })],
      dial_sessions: [OK(baseTakeoverTargetSession())],
      call_legs: [OK({ call_control_id: 'call-agent-1', state: 'answered' })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'owner', {
      coachingId: 'coaching-1',
    });
    assertEquals(result.status, 200);
    assertEquals(
      calls.find((c) => c.method === 'updateConferenceSupervisorRole'),
      undefined
    );
    assertExists(calls.find((c) => c.method === 'leaveConference'));
    assertExists(calls.find((c) => c.method === 'hangup'));
  }
);

Deno.test(
  'runTakeoverAction: a leaveConference failure does not stop hangup or the session-side transition',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [OK(baseTakeoverRow({ mode: 'barge' }))],
      org_call_takeover_settings: [OK({ enabled: true })],
      dial_sessions: [OK(baseTakeoverTargetSession())],
      call_legs: [OK({ call_control_id: 'call-agent-1', state: 'answered' })],
    });
    const { client, calls } = makeFakeTelnyxClient({
      leaveConference: async () => {
        throw new Error('call not found (already gone)');
      },
    });
    const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'owner', {
      coachingId: 'coaching-1',
    });
    assertEquals(result.status, 200);
    assertExists(calls.find((c) => c.method === 'hangup'));
    const rpcCalls = (supabase as { _rpcCalls: { name: string }[] })._rpcCalls;
    assertEquals(rpcCalls.length, 2);
  }
);

Deno.test('runTakeoverAction: coaching attempt not found -> 404', async () => {
  const supabase = makeFakeSupabase({ coachingSelect: [EMPTY] });
  const { client } = makeFakeTelnyxClient();
  const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'owner', {
    coachingId: 'coaching-1',
  });
  assertEquals(result.status, 404);
});

Deno.test('runTakeoverAction: not yet connected -> 409 NOT_ACTIVE', async () => {
  const supabase = makeFakeSupabase({
    coachingSelect: [OK(baseTakeoverRow({ status: 'starting', manager_call_control_id: null }))],
  });
  const { client } = makeFakeTelnyxClient();
  const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'owner', {
    coachingId: 'coaching-1',
  });
  assertEquals(result.status, 409);
  assertEquals(result.body.code, 'NOT_ACTIVE');
});

Deno.test(
  'runTakeoverAction: already taken over -> 409 ALREADY_TAKEN_OVER, before touching Telnyx',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [OK(baseTakeoverRow({ taken_over_at: '2026-09-27T00:00:00Z' }))],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'owner', {
      coachingId: 'coaching-1',
    });
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'ALREADY_TAKEN_OVER');
    assertEquals(calls.length, 0);
  }
);

Deno.test(
  'runTakeoverAction: manager outside the target agent pod scope -> 403, before touching Telnyx',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [OK(baseTakeoverRow())],
      org_members: [OK({ pod_id: 'pod-a' })],
      org_manager_pods: [EMPTY],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'manager', {
      coachingId: 'coaching-1',
    });
    assertEquals(result.status, 403);
    assertEquals(calls.length, 0);
  }
);

Deno.test('runTakeoverAction: org has takeover disabled -> 403 TAKEOVER_DISABLED', async () => {
  const supabase = makeFakeSupabase({
    coachingSelect: [OK(baseTakeoverRow())],
    org_call_takeover_settings: [OK({ enabled: false })],
  });
  const { client, calls } = makeFakeTelnyxClient();
  const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'owner', {
    coachingId: 'coaching-1',
  });
  assertEquals(result.status, 403);
  assertEquals(result.body.code, 'TAKEOVER_DISABLED');
  assertEquals(calls.length, 0);
});

Deno.test(
  'runTakeoverAction: target no longer on_call (already in wrap-up) -> 409 TARGET_NOT_ON_CALL',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [OK(baseTakeoverRow())],
      org_call_takeover_settings: [OK({ enabled: true })],
      dial_sessions: [OK(baseTakeoverTargetSession({ state: 'wrap_up' }))],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'owner', {
      coachingId: 'coaching-1',
    });
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'TARGET_NOT_ON_CALL');
    assertEquals(calls.length, 0);
  }
);

Deno.test(
  "runTakeoverAction: the agent's own leg is already gone -> 409 TARGET_NOT_ON_CALL",
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [OK(baseTakeoverRow())],
      org_call_takeover_settings: [OK({ enabled: true })],
      dial_sessions: [OK(baseTakeoverTargetSession())],
      call_legs: [EMPTY],
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'owner', {
      coachingId: 'coaching-1',
    });
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'TARGET_NOT_ON_CALL');
    assertEquals(calls.length, 0);
  }
);

Deno.test(
  'runTakeoverAction: two clicks land at once -- the loser gets 409 ALREADY_TAKEN_OVER, never touches Telnyx',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [OK(baseTakeoverRow())],
      org_call_takeover_settings: [OK({ enabled: true })],
      dial_sessions: [OK(baseTakeoverTargetSession())],
      call_legs: [OK({ call_control_id: 'call-agent-1', state: 'answered' })],
      takeoverClaimResult: EMPTY,
    });
    const { client, calls } = makeFakeTelnyxClient();
    const result = await runTakeoverAction(supabase, client, 'org-1', 'mgr-1', 'owner', {
      coachingId: 'coaching-1',
    });
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'ALREADY_TAKEN_OVER');
    assertEquals(calls.length, 0);
  }
);

Deno.test('processTelnyxCoachingEvent: call.hangup ends the row (manager_hangup)', async () => {
  const supabase = makeFakeSupabase({
    coachingSelect: [
      OK({
        id: 'coaching-1',
        target_session_id: 's-target',
        manager_id: 'mgr-1',
        mode: 'listen',
        status: 'active',
      }),
    ],
  });
  const { client } = makeFakeTelnyxClient();
  await processTelnyxCoachingEvent(supabase, client, {
    orgId: 'org-1',
    eventType: 'call.hangup',
    callControlId: 'call-manager-1',
    coachingId: 'coaching-1',
  });
  const write = supabase._writes.find(
    (w: { table: string; patch: Record<string, unknown> }) => w.table === 'coaching_sessions'
  );
  assertExists(write);
  assertEquals(write.patch.status, 'ended');
  assertEquals(write.patch.ended_reason, 'manager_hangup');
  // TASK-A1: the end is also audit-logged, attributed to the coaching manager (not the target
  // agent whose hangup webhook this technically is).
  const auditWrite = supabase._writes.find(
    (w: { table: string; patch: Record<string, unknown> }) => w.table === 'org_audit_log:insert'
  );
  assertExists(auditWrite);
  assertEquals(auditWrite.patch.action, 'coaching.end');
  assertEquals(auditWrite.patch.actor_user_id, 'mgr-1');
});

Deno.test('processTelnyxCoachingEvent: already-ended row is a pure no-op', async () => {
  const supabase = makeFakeSupabase({
    coachingSelect: [
      OK({ id: 'coaching-1', target_session_id: 's-target', mode: 'listen', status: 'ended' }),
    ],
  });
  const { client, calls } = makeFakeTelnyxClient();
  await processTelnyxCoachingEvent(supabase, client, {
    orgId: 'org-1',
    eventType: 'call.answered',
    callControlId: 'call-manager-1',
    coachingId: 'coaching-1',
  });
  assertEquals(calls.length, 0);
  assertEquals(supabase._writes.length, 0);
});

Deno.test(
  'processTelnyxCoachingEvent: call.answered joins the target conference with whisper_call_control_ids and marks active',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [
        OK({
          id: 'coaching-1',
          target_session_id: 's-target',
          mode: 'whisper',
          status: 'starting',
        }),
      ],
      dial_sessions: [OK({ state: 'on_call', conference_id: 'conf-1', agent_leg_id: 'leg-agent' })],
      call_legs: [OK({ call_control_id: 'call-agent-1' })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    await processTelnyxCoachingEvent(supabase, client, {
      orgId: 'org-1',
      eventType: 'call.answered',
      callControlId: 'call-manager-1',
      coachingId: 'coaching-1',
    });
    const join = calls.find((c) => c.method === 'joinConference');
    assertExists(join);
    assertEquals(join!.args[0], 'conf-1');
    assertEquals(join!.args[1], {
      callControlId: 'call-manager-1',
      supervisorRole: 'whisper',
      whisperCallControlIds: ['call-agent-1'],
      endConferenceOnExit: false,
    });
    const write = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) => w.table === 'coaching_sessions'
    );
    assertExists(write);
    assertEquals(write.patch.status, 'active');
  }
);

Deno.test(
  'processTelnyxCoachingEvent: call.answered but the target already left on_call hangs up the manager leg',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [
        OK({ id: 'coaching-1', target_session_id: 's-target', mode: 'listen', status: 'starting' }),
      ],
      dial_sessions: [OK({ state: 'wrap_up', conference_id: 'conf-1', agent_leg_id: null })],
    });
    const { client, calls } = makeFakeTelnyxClient();
    await processTelnyxCoachingEvent(supabase, client, {
      orgId: 'org-1',
      eventType: 'call.answered',
      callControlId: 'call-manager-1',
      coachingId: 'coaching-1',
    });
    assertEquals(
      calls.some((c) => c.method === 'hangup' && c.args[0] === 'call-manager-1'),
      true
    );
    const write = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) => w.table === 'coaching_sessions'
    );
    assertExists(write);
    assertEquals(write.patch.ended_reason, 'target_ended');
  }
);

// ---------------------------------------------------------------------------
// endActiveCoachingSessionsForManager (MISSION-5 TASK-M5-B2, EC-8: "coaching ends cleanly if
// ... the coach is disabled/removed") -- called from org-members/index.ts's cascadeOffboard.
// ---------------------------------------------------------------------------

Deno.test(
  'endActiveCoachingSessionsForManager: ends every active/starting row for the manager and hangs up each one',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [
        OK([
          { id: 'coaching-1', manager_call_control_id: 'call-mgr-1' },
          { id: 'coaching-2', manager_call_control_id: 'call-mgr-2' },
        ]),
      ],
    });
    const hangupCalls: string[] = [];
    const { client } = makeFakeTelnyxClient({
      hangup: async (id: string) => {
        hangupCalls.push(id);
      },
    });
    const count = await endActiveCoachingSessionsForManager(
      supabase,
      client,
      'mgr-1',
      'coach_offboarded'
    );
    assertEquals(count, 2);
    assertEquals(hangupCalls, ['call-mgr-1', 'call-mgr-2']);
    const endedWrite = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) =>
        w.table === 'coaching_sessions' && w.patch.status === 'ended'
    );
    assertExists(endedWrite);
    assertEquals(endedWrite.patch.ended_reason, 'coach_offboarded');
  }
);

Deno.test(
  'endActiveCoachingSessionsForManager: no active rows -- a pure no-op, never even calls Telnyx -- positive control',
  async () => {
    const supabase = makeFakeSupabase({ coachingSelect: [OK([])] });
    let telnyxTouched = false;
    const { client } = makeFakeTelnyxClient({
      hangup: async () => {
        telnyxTouched = true;
      },
    });
    const count = await endActiveCoachingSessionsForManager(
      supabase,
      client,
      'mgr-1',
      'coach_offboarded'
    );
    assertEquals(count, 0);
    assertEquals(telnyxTouched, false);
    assertEquals(supabase._writes.length, 0);
  }
);

Deno.test(
  'endActiveCoachingSessionsForManager: a null Telnyx client (org not connected) still ends the row in our own bookkeeping',
  async () => {
    const supabase = makeFakeSupabase({
      coachingSelect: [OK([{ id: 'coaching-1', manager_call_control_id: 'call-mgr-1' }])],
    });
    const count = await endActiveCoachingSessionsForManager(
      supabase,
      null,
      'mgr-1',
      'coach_offboarded'
    );
    assertEquals(count, 1);
    const endedWrite = supabase._writes.find(
      (w: { table: string; patch: Record<string, unknown> }) =>
        w.table === 'coaching_sessions' && w.patch.status === 'ended'
    );
    assertExists(endedWrite);
  }
);

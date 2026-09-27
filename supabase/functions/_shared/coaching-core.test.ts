import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import type { TelnyxClient } from './telnyx-client.ts';
import {
  processTelnyxCoachingEvent,
  runStartCoachingAction,
  runSwitchCoachingModeAction,
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

function makeFakeSupabase(cfg: {
  dial_sessions?: Result[];
  call_legs?: Result[];
  org_members?: Result[];
  user_phone_numbers?: Result[];
  coachingInsert?: Result;
  coachingSelect?: Result[];
}) {
  const counters: Record<string, number> = {};
  const next = (key: string, arr?: Result[]): Result => {
    const i = counters[key] ?? 0;
    counters[key] = i + 1;
    if (!arr || !arr[i]) throw new Error(`fake supabase: no configured result #${i} for ${key}`);
    return arr[i];
  };
  const writes: { table: string; patch: Record<string, unknown> }[] = [];

  const supabase = {
    from(table: string) {
      switch (table) {
        case 'dial_sessions':
          return { select: () => selectChain(next('dial_sessions', cfg.dial_sessions)) };
        case 'call_legs':
          return { select: () => selectChain(next('call_legs', cfg.call_legs)) };
        case 'org_members':
          return {
            select: () => selectChain(next('org_members', cfg.org_members)),
            update: (patch: Record<string, unknown>) =>
              updateChain(() => writes.push({ table, patch })),
          };
        case 'user_phone_numbers':
          return { select: () => selectChain(next('user_phone_numbers', cfg.user_phone_numbers)) };
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
            update: (patch: Record<string, unknown>) =>
              updateChain(() => writes.push({ table, patch })),
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
      { targetUserId: 'mgr-1', mode: 'listen' }
    );
    assertEquals(result.status, 400);
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
    });
    const { client } = makeFakeTelnyxClient();
    const result = await runStartCoachingAction(
      supabase,
      client,
      'app-1',
      'conn-1',
      'org-1',
      'mgr-1',
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
      { targetUserId: 'agent-1', mode: 'listen' }
    );
    assertEquals(result.status, 409);
    assertEquals(result.body.code, 'MANAGER_BUSY');
    assertEquals(calls.length, 0); // never reached dial()
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

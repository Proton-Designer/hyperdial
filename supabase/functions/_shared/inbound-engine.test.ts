/**
 * TASK-I1: exercises inbound-engine.ts against a real createTelnyxClient (stubbed fetch, same
 * pattern as telnyx-client.test.ts/dialer-engine.test.ts) and the SAME FakeDb/createFakeSupabase
 * harness dialer-engine.test.ts uses (exported from there specifically so this file doesn't
 * need its own parallel reimplementation of the tables/RPCs `pauseSession` -- real
 * dialer-engine.ts code, reused as-is -- also depends on).
 */
import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import { createTelnyxClient } from './telnyx-client.ts';
import { FakeDb, createFakeSupabase } from './dialer-fake-supabase.ts';
import { encodeInboundClientState, type InboundCallStep } from './client-state.ts';
import {
  reapStaleInboundCalls,
  handleFreshInboundCall,
  handleOriginalLegEvent,
  handleClientStateEvent,
  type InboundCallRow,
} from './inbound-engine.ts';

// ---------------------------------------------------------------------------
// Fake Telnyx server -- only the endpoints TASK-I1's own commands hit.
// ---------------------------------------------------------------------------

class FakeTelnyxServer {
  answers: string[] = [];
  transfers: { callControlId: string; body: Record<string, unknown> }[] = [];
  speaks: { callControlId: string; body: Record<string, unknown> }[] = [];
  recordStarts: { callControlId: string; body: Record<string, unknown> }[] = [];
  joins: { conferenceId: string; callControlId: string }[] = [];
  sipUsernames = new Map<string, string>();
  hangups: string[] = [];
  /** TASK-H36: action name ('transfer' | 'answer' | 'speak' | 'record_start' | 'join' |
   *  'hangup') -> how many upcoming calls of it answer 422 instead of succeeding. */
  failNext = new Map<string, number>();
  /** HTTP status the injected failure answers with (422 = definitive rejection, 500/503 = unknown). */
  failStatus = 422;
  /** GET /calls/{id}: 'alive' | 'dead' | 'error' (anything unreadable) */
  callStatus = new Map<string, 'alive' | 'dead' | 'error'>();

  private shouldFail(action: string): boolean {
    const n = this.failNext.get(action) ?? 0;
    if (n <= 0) return false;
    this.failNext.set(action, n - 1);
    return true;
  }

  handle(url: string, init?: RequestInit): Response {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const action = path.match(/\/actions\/([a-z_]+)$/)?.[1];
    if (method === 'POST' && action && this.shouldFail(action)) {
      return Response.json(
        {
          errors: [
            { code: '10016', title: 'Phone number must be in +E164 format', detail: 'test 422' },
          ],
        },
        { status: this.failStatus }
      );
    }
    if (method === 'GET' && /\/calls\/([^/]+)$/.test(path)) {
      const id = decodeURIComponent(path.match(/\/calls\/([^/]+)$/)![1]);
      const st = this.callStatus.get(id) ?? 'error';
      if (st === 'error') return Response.json({ errors: [] }, { status: 500 });
      return Response.json({ data: { is_alive: st === 'alive' } });
    }
    if (method === 'POST' && /\/calls\/([^/]+)\/actions\/hangup$/.test(path)) {
      this.hangups.push(path.match(/\/calls\/([^/]+)\/actions\/hangup$/)![1]);
      return Response.json({ data: {} });
    }

    if (method === 'POST' && /\/calls\/[^/]+\/actions\/answer$/.test(path)) {
      this.answers.push(path);
      return Response.json({ data: {} });
    }
    if (method === 'POST' && /\/calls\/([^/]+)\/actions\/transfer$/.test(path)) {
      const callControlId = path.match(/\/calls\/([^/]+)\/actions\/transfer$/)![1];
      this.transfers.push({ callControlId, body });
      return Response.json({ data: {} });
    }
    if (method === 'POST' && /\/calls\/([^/]+)\/actions\/speak$/.test(path)) {
      const callControlId = path.match(/\/calls\/([^/]+)\/actions\/speak$/)![1];
      this.speaks.push({ callControlId, body });
      return Response.json({ data: {} });
    }
    if (method === 'POST' && /\/calls\/([^/]+)\/actions\/record_start$/.test(path)) {
      const callControlId = path.match(/\/calls\/([^/]+)\/actions\/record_start$/)![1];
      this.recordStarts.push({ callControlId, body });
      return Response.json({ data: {} });
    }
    if (method === 'POST' && /\/conferences\/([^/]+)\/actions\/join$/.test(path)) {
      const conferenceId = path.match(/\/conferences\/([^/]+)\/actions\/join$/)![1];
      this.joins.push({ conferenceId, callControlId: body.call_control_id as string });
      return Response.json({ data: {} });
    }
    if (method === 'GET' && /\/telephony_credentials\/([^/]+)$/.test(path)) {
      const id = path.match(/\/telephony_credentials\/([^/]+)$/)![1];
      return Response.json({
        data: { sip_username: this.sipUsernames.get(id) ?? 'agent-sip-user' },
      });
    }
    return Response.json(
      { errors: [{ detail: `not mocked: ${method} ${path}` }] },
      { status: 404 }
    );
  }
}

function stubTelnyxFetch(server: FakeTelnyxServer): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) =>
    Promise.resolve(server.handle(String(url), init))) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ---------------------------------------------------------------------------
// The three RPCs inbound-engine.ts calls that dialer-engine.test.ts's own switch doesn't know
// about (record_webhook_event/transition_session are already handled there, and reused as-is).
// Mirrors 20260925070100_inbound_routing.sql closely enough for these tests to exercise real
// inbound-engine.ts orchestration, same spirit as dialer-engine.test.ts's own header comment.
// ---------------------------------------------------------------------------

const INBOUND_CALL_FIELDS = [
  'routed_to_user_id',
  'dial_session_id',
  'contact_id',
  'outcome',
  'answered_at',
  'ended_at',
  'duration_seconds',
  'recording_status',
  'recording_path',
  'recording_duration_seconds',
  'recording_telnyx_call_leg_id',
  'ghl_note_queued_at',
];

function makeExtraRpc(db: FakeDb) {
  return (
    name: string,
    args: Record<string, unknown>
  ): { data: unknown; error: null } | undefined => {
    if (name === 'pick_inbound_route') {
      const orgId = args.p_org_id as string;
      const toE164 = args.p_to_e164 as string;
      const row = [...db.table('user_phone_numbers').values()].find(
        (n) => n.org_id === orgId && n.phone_number === toE164
      );
      return {
        data: row ? [{ number_id: row.id, assigned_user_id: row.assigned_user_id ?? null }] : [],
        error: null,
      };
    }
    if (name === 'transition_inbound_call') {
      const callControlId = args.p_call_control_id as string;
      const expected = args.p_expected_states as string[];
      const row = [...db.table('inbound_calls').values()].find(
        (r) => r.call_control_id === callControlId
      );
      if (!row || !expected.includes(row.state as string)) return { data: false, error: null };
      row.state = args.p_new_state;
      const fields = (args.p_fields as Record<string, unknown>) ?? {};
      for (const key of INBOUND_CALL_FIELDS) if (key in fields) row[key] = fields[key];
      return { data: true, error: null };
    }
    if (name === 'list_stale_inbound_calls') {
      const now = Date.now();
      const rows = [...db.table('inbound_calls').values()].filter((r) => {
        if (r.state === 'ended') return false;
        if (
          r.state === 'bridging_session' &&
          !r.answered_at &&
          now - new Date(r.created_at as string).getTime() >
            (args.p_bridging_after_seconds as number) * 1000
        ) {
          return true;
        }
        if (!r.answered_at) {
          return (
            now - new Date(r.created_at as string).getTime() >
            (args.p_unanswered_after_seconds as number) * 1000
          );
        }
        const limit =
          r.state === 'voicemail'
            ? (args.p_voicemail_after_seconds as number)
            : (args.p_answered_after_seconds as number);
        return now - new Date(r.answered_at as string).getTime() > limit * 1000;
      });
      return { data: rows.map((r) => ({ ...r })), error: null };
    }
    if (name === 'end_stale_inbound_call') {
      const row = db.table('inbound_calls').get(args.p_id as string);
      if (!row || row.state === 'ended') return { data: null, error: null };
      row.outcome = !row.answered_at
        ? 'missed'
        : row.state === 'voicemail'
          ? 'voicemail'
          : row.state === 'bridging_session' || row.state === 'ringing_intern'
            ? 'answered_by_agent'
            : 'forwarded';
      row.state = 'ended';
      row.ended_at = new Date().toISOString();
      return { data: row.outcome, error: null };
    }
    if (name === 'enqueue_crm_job') {
      const orgId = args.p_org as string;
      const connected = [...db.table('org_integrations').values()].some(
        (i) => i.org_id === orgId && i.provider === 'ghl' && i.status === 'connected'
      );
      if (!connected) return { data: null, error: null };
      const job = db.insert('crm_sync_jobs', {
        org_id: orgId,
        provider: 'ghl',
        kind: args.p_kind,
        contact_id: args.p_contact_id,
        call_leg_id: args.p_call_leg_id,
        payload: args.p_payload,
        status: 'queued',
      });
      return { data: job.id, error: null };
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG_ID = 'org-i1';
const CAMPAIGN_ID = 'campaign-i1';

function seedOrg(db: FakeDb, overrides: { sharedDestinationNumber?: string | null } = {}) {
  db.insert('orgs', { id: ORG_ID, name: 'I1 Test Org' });
  db.insert('org_telephony', {
    id: 'telephony-i1',
    org_id: ORG_ID,
    status: 'connected',
    call_control_app_id: 'cca-i1',
  });
  db.insert('org_inbound_settings', {
    id: ORG_ID,
    org_id: ORG_ID,
    shared_destination_number: overrides.sharedDestinationNumber ?? null,
    voicemail_greeting_text: "You've reached {org_name}. Please leave a message.",
  });
}

function seedIntern(
  db: FakeDb,
  args: {
    userId: string;
    lastSeenAt?: string | null;
    forwardPhoneNumber?: string | null;
    credentialId?: string | null;
  }
) {
  db.insert('org_members', {
    id: `member-${args.userId}`,
    org_id: ORG_ID,
    user_id: args.userId,
    telnyx_credential_id: args.credentialId ?? 'cred-1',
    last_seen_at: args.lastSeenAt ?? null,
    forward_phone_number: args.forwardPhoneNumber ?? null,
  });
}

function freshInboundArgs(
  overrides: Partial<{ to: string; from: string; callControlId: string; eventId: string }> = {}
) {
  return {
    orgId: ORG_ID,
    eventId: overrides.eventId ?? crypto.randomUUID(),
    callControlId: overrides.callControlId ?? `call-${crypto.randomUUID()}`,
    payload: {
      call_control_id: overrides.callControlId ?? 'call-1',
      to: overrides.to ?? '+12145550000',
      from: overrides.from ?? '+15125559999',
      direction: 'incoming',
      state: 'parked',
      call_leg_id: 'leg-1',
    },
  };
}

function loadRow(db: FakeDb, callControlId: string): InboundCallRow {
  const row = [...db.table('inbound_calls').values()].find(
    (r) => r.call_control_id === callControlId
  );
  assertExists(row, `no inbound_calls row for ${callControlId}`);
  return row as unknown as InboundCallRow;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

Deno.test(
  'team-pool number (no assigned intern), nothing configured -> straight to voicemail',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restore = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db, makeExtraRpc(db));
    const client = createTelnyxClient('fake-key');
    seedOrg(db);
    db.insert('user_phone_numbers', {
      id: 'num-pool-1',
      org_id: ORG_ID,
      phone_number: '+12145550000',
      assigned_user_id: null,
    });
    try {
      const args = freshInboundArgs({ callControlId: 'call-1' });
      await handleFreshInboundCall(supabase, client, args);

      let row = loadRow(db, 'call-1');
      assertEquals(row.state, 'voicemail');
      assertEquals(server.answers.length, 1, 'voicemail step answers the original leg');

      await handleOriginalLegEvent(
        supabase,
        client,
        {
          orgId: ORG_ID,
          eventId: crypto.randomUUID(),
          eventType: 'call.answered',
          callControlId: 'call-1',
          payload: {},
        },
        row
      );
      assertEquals(server.speaks.length, 1);
      assertEquals(server.speaks[0].callControlId, 'call-1');

      row = loadRow(db, 'call-1');
      assertExists(row.answered_at);

      await handleOriginalLegEvent(
        supabase,
        client,
        {
          orgId: ORG_ID,
          eventId: crypto.randomUUID(),
          eventType: 'call.speak.ended',
          callControlId: 'call-1',
          payload: {},
        },
        row
      );
      assertEquals(server.recordStarts.length, 1);

      await handleOriginalLegEvent(
        supabase,
        client,
        {
          orgId: ORG_ID,
          eventId: crypto.randomUUID(),
          eventType: 'call.hangup',
          callControlId: 'call-1',
          payload: {},
        },
        row
      );
      row = loadRow(db, 'call-1');
      assertEquals(row.state, 'ended');
      assertEquals(row.outcome, 'voicemail');
    } finally {
      restore();
    }
  }
);

Deno.test(
  'assigned intern, online, no active session -> rings the WebRTC client, answers -> answered_by_agent',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restore = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db, makeExtraRpc(db));
    const client = createTelnyxClient('fake-key');
    seedOrg(db);
    seedIntern(db, {
      userId: 'intern-1',
      lastSeenAt: new Date().toISOString(),
      credentialId: 'cred-online',
    });
    server.sipUsernames.set('cred-online', 'intern-1-sip');
    db.insert('user_phone_numbers', {
      id: 'num-1',
      org_id: ORG_ID,
      phone_number: '+12145550000',
      assigned_user_id: 'intern-1',
    });
    try {
      const args = freshInboundArgs({ callControlId: 'call-2' });
      await handleFreshInboundCall(supabase, client, args);

      let row = loadRow(db, 'call-2');
      assertEquals(row.state, 'ringing_intern');
      assertEquals(server.transfers.length, 1);
      assertEquals(server.transfers[0].body.to, 'sip:intern-1-sip@sip.telnyx.com');
      assertEquals(server.transfers[0].body.timeout_secs, 20);
      const targetState = server.transfers[0].body.target_leg_client_state as string;
      assertExists(targetState);

      // Leg B (the intern's browser) answers.
      await handleClientStateEvent(
        supabase,
        client,
        {
          orgId: ORG_ID,
          eventId: crypto.randomUUID(),
          eventType: 'call.answered',
          callControlId: 'call-b-1',
          payload: {},
        },
        { org: ORG_ID, inbound: row.id, step: 'intern' as InboundCallStep }
      );
      row = loadRow(db, 'call-2');
      assertEquals(
        row.state,
        'ringing_intern',
        'stays in the same step while the bridged call is live'
      );
      assertExists(row.answered_at);

      // Leg B eventually hangs up -- the live call ended, not a failed ring.
      await handleClientStateEvent(
        supabase,
        client,
        {
          orgId: ORG_ID,
          eventId: crypto.randomUUID(),
          eventType: 'call.hangup',
          callControlId: 'call-b-1',
          payload: {},
        },
        { org: ORG_ID, inbound: row.id, step: 'intern' as InboundCallStep }
      );
      row = loadRow(db, 'call-2');
      assertEquals(row.state, 'ended');
      assertEquals(row.outcome, 'answered_by_agent');
    } finally {
      restore();
    }
  }
);

Deno.test(
  'assigned intern offline, has a forward number -> rings the cell; unanswered -> falls through to voicemail',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restore = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db, makeExtraRpc(db));
    const client = createTelnyxClient('fake-key');
    seedOrg(db);
    seedIntern(db, { userId: 'intern-1', lastSeenAt: null, forwardPhoneNumber: '+19995550001' });
    db.insert('user_phone_numbers', {
      id: 'num-1',
      org_id: ORG_ID,
      phone_number: '+12145550000',
      assigned_user_id: 'intern-1',
    });
    try {
      const args = freshInboundArgs({ callControlId: 'call-3' });
      await handleFreshInboundCall(supabase, client, args);

      let row = loadRow(db, 'call-3');
      assertEquals(
        row.state,
        'ringing_cell',
        'offline -> intern is skipped, straight to the cell fallback'
      );
      assertEquals(server.transfers.length, 1);
      assertEquals(server.transfers[0].body.to, '+19995550001');

      // Cell never answers.
      await handleClientStateEvent(
        supabase,
        client,
        {
          orgId: ORG_ID,
          eventId: crypto.randomUUID(),
          eventType: 'call.hangup',
          callControlId: 'call-b-1',
          payload: { to: '+12145550000' },
        },
        { org: ORG_ID, inbound: row.id, step: 'cell' as InboundCallStep }
      );
      row = loadRow(db, 'call-3');
      assertEquals(row.state, 'voicemail', 'no shared destination configured -> voicemail is next');
      assertEquals(server.answers.length, 1);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'assigned intern busy on a call -> never rung at all, straight to the shared line',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restore = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db, makeExtraRpc(db));
    const client = createTelnyxClient('fake-key');
    seedOrg(db, { sharedDestinationNumber: '+18885550000' });
    seedIntern(db, { userId: 'intern-1', lastSeenAt: new Date().toISOString() });
    db.insert('dial_sessions', {
      id: 'sess-busy',
      org_id: ORG_ID,
      campaign_id: CAMPAIGN_ID,
      agent_id: 'intern-1',
      state: 'on_call',
    });
    db.insert('user_phone_numbers', {
      id: 'num-1',
      org_id: ORG_ID,
      phone_number: '+12145550000',
      assigned_user_id: 'intern-1',
    });
    try {
      const args = freshInboundArgs({ callControlId: 'call-4' });
      await handleFreshInboundCall(supabase, client, args);

      const row = loadRow(db, 'call-4');
      assertEquals(row.state, 'ringing_shared');
      assertEquals(server.transfers.length, 1);
      assertEquals(server.transfers[0].body.to, '+18885550000');
    } finally {
      restore();
    }
  }
);

Deno.test(
  'assigned intern in a joinable session -> pauses it and joins the caller into its conference',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restore = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db, makeExtraRpc(db));
    const client = createTelnyxClient('fake-key');
    seedOrg(db);
    seedIntern(db, { userId: 'intern-1', lastSeenAt: new Date().toISOString() });
    db.insert('dial_sessions', {
      id: 'sess-joinable',
      org_id: ORG_ID,
      campaign_id: CAMPAIGN_ID,
      agent_id: 'intern-1',
      state: 'dialing',
      conference_id: 'conf-1',
    });
    db.insert('user_phone_numbers', {
      id: 'num-1',
      org_id: ORG_ID,
      phone_number: '+12145550000',
      assigned_user_id: 'intern-1',
    });
    try {
      const args = freshInboundArgs({ callControlId: 'call-5' });
      await handleFreshInboundCall(supabase, client, args);

      let row = loadRow(db, 'call-5');
      assertEquals(row.state, 'bridging_session');
      assertEquals(row.dial_session_id, 'sess-joinable');
      assertEquals(server.answers.length, 1);
      assertEquals(
        db.table('dial_sessions').get('sess-joinable')!.state,
        'paused',
        'INB-3: pause the batch dialing before connecting the inbound caller'
      );
      assertEquals(db.table('dial_sessions').get('sess-joinable')!.pause_reason, 'inbound_call');

      await handleOriginalLegEvent(
        supabase,
        client,
        {
          orgId: ORG_ID,
          eventId: crypto.randomUUID(),
          eventType: 'call.answered',
          callControlId: 'call-5',
          payload: {},
        },
        row
      );
      assertEquals(server.joins.length, 1);
      assertEquals(server.joins[0].conferenceId, 'conf-1');
      assertEquals(server.joins[0].callControlId, 'call-5');

      row = loadRow(db, 'call-5');
      await handleOriginalLegEvent(
        supabase,
        client,
        {
          orgId: ORG_ID,
          eventId: crypto.randomUUID(),
          eventType: 'call.hangup',
          callControlId: 'call-5',
          payload: {},
        },
        row
      );
      row = loadRow(db, 'call-5');
      assertEquals(row.state, 'ended');
      assertEquals(row.outcome, 'answered_by_agent');
    } finally {
      restore();
    }
  }
);

Deno.test(
  'a second inbound call while the first is still bridged goes down the busy path, not ' +
    'double-joined into the same conference (eng1 review-eng1.md finding #4)',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restore = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db, makeExtraRpc(db));
    const client = createTelnyxClient('fake-key');
    seedOrg(db, { sharedDestinationNumber: '+15559990000' });
    seedIntern(db, { userId: 'intern-1', lastSeenAt: new Date().toISOString() });
    db.insert('dial_sessions', {
      id: 'sess-joinable',
      org_id: ORG_ID,
      campaign_id: CAMPAIGN_ID,
      agent_id: 'intern-1',
      state: 'dialing',
      conference_id: 'conf-1',
    });
    db.insert('user_phone_numbers', {
      id: 'num-1',
      org_id: ORG_ID,
      phone_number: '+12145550000',
      assigned_user_id: 'intern-1',
    });
    try {
      // Caller A: bridges in as usual, pausing the session for the whole duration of the call.
      const argsA = freshInboundArgs({ callControlId: 'call-a', from: '+15125551111' });
      await handleFreshInboundCall(supabase, client, argsA);
      let rowA = loadRow(db, 'call-a');
      assertEquals(rowA.state, 'bridging_session');
      assertEquals(
        db.table('dial_sessions').get('sess-joinable')!.state,
        'paused',
        'caller A bridged in, session paused for the whole duration'
      );

      // Caller B: a second inbound call for the SAME intern while caller A is still live.
      const argsB = freshInboundArgs({ callControlId: 'call-b', from: '+15125552222' });
      await handleFreshInboundCall(supabase, client, argsB);
      const rowB = loadRow(db, 'call-b');

      // Must NOT be routed to bridging_session (which would join B into A's own conference) --
      // goes down the busy fallback chain instead. No forward number is set for intern-1 in
      // this fixture, so the first fallback step is the shared destination.
      assertEquals(rowB.state, 'ringing_shared');
      assertEquals(
        server.transfers.length,
        1,
        'exactly one transfer -- caller B to the shared line'
      );
      assertEquals(server.transfers[0].callControlId, argsB.callControlId);
      assertEquals(server.joins.length, 0, 'caller B was never joined into any conference');

      // Caller A's own row/session are untouched by B's routing.
      rowA = loadRow(db, 'call-a');
      assertEquals(rowA.state, 'bridging_session');
      assertEquals(
        db.table('dial_sessions').get('sess-joinable')!.state,
        'paused',
        "caller A's session is still paused, not disturbed by B's routing decision"
      );
    } finally {
      restore();
    }
  }
);

Deno.test('webhook redelivery (same event id twice) is a no-op the second time', async () => {
  const db = new FakeDb();
  const server = new FakeTelnyxServer();
  const restore = stubTelnyxFetch(server);
  const supabase = createFakeSupabase(db, makeExtraRpc(db));
  const client = createTelnyxClient('fake-key');
  seedOrg(db);
  db.insert('user_phone_numbers', {
    id: 'num-1',
    org_id: ORG_ID,
    phone_number: '+12145550000',
    assigned_user_id: null,
  });
  try {
    const eventId = crypto.randomUUID();
    const args = freshInboundArgs({ callControlId: 'call-6', eventId });
    await handleFreshInboundCall(supabase, client, args);
    await handleFreshInboundCall(supabase, client, args); // exact redelivery -- same event id

    assertEquals(
      [...db.table('inbound_calls').values()].filter((r) => r.call_control_id === 'call-6').length,
      1,
      'a redelivered call.initiated must never insert a second row'
    );
    assertEquals(server.answers.length, 1, 'the voicemail answer command was issued exactly once');
  } finally {
    restore();
  }
});

Deno.test(
  'a recognized contact enqueues a crm_sync_jobs inbound_call_note job; an unrecognized caller does not',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restore = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db, makeExtraRpc(db));
    const client = createTelnyxClient('fake-key');
    seedOrg(db);
    db.insert('org_integrations', {
      id: 'oi-1',
      org_id: ORG_ID,
      provider: 'ghl',
      status: 'connected',
    });
    db.insert('user_phone_numbers', {
      id: 'num-1',
      org_id: ORG_ID,
      phone_number: '+12145550000',
      assigned_user_id: null,
    });
    db.insert('contacts', { id: 'contact-1', org_id: ORG_ID, phone_number: '+15125559999' });
    try {
      const args = freshInboundArgs({ callControlId: 'call-7', from: '+15125559999' });
      await handleFreshInboundCall(supabase, client, args);
      let row = loadRow(db, 'call-7');
      assertEquals(row.contact_id, 'contact-1');

      await handleOriginalLegEvent(
        supabase,
        client,
        {
          orgId: ORG_ID,
          eventId: crypto.randomUUID(),
          eventType: 'call.hangup',
          callControlId: 'call-7',
          payload: {},
        },
        row
      );
      const jobs = [...db.table('crm_sync_jobs').values()].filter(
        (j) => j.kind === 'inbound_call_note'
      );
      assertEquals(jobs.length, 1);
      assertEquals(jobs[0].contact_id, 'contact-1');
    } finally {
      restore();
    }
  }
);

// ---------------------------------------------------------------------------
// TASK-H36: stuck inbound calls
// ---------------------------------------------------------------------------

function h36Setup(opts: { forward?: string | null; shared?: string | null; online?: boolean }) {
  const db = new FakeDb();
  const server = new FakeTelnyxServer();
  const restore = stubTelnyxFetch(server);
  const supabase = createFakeSupabase(db, makeExtraRpc(db));
  const client = createTelnyxClient('fake-key');
  seedOrg(db, { sharedDestinationNumber: opts.shared ?? null });
  seedIntern(db, {
    userId: 'intern-1',
    lastSeenAt: opts.online ? new Date().toISOString() : null,
    forwardPhoneNumber: opts.forward ?? null,
  });
  db.insert('user_phone_numbers', {
    id: 'num-1',
    org_id: ORG_ID,
    phone_number: '+12145550000',
    assigned_user_id: 'intern-1',
  });
  return { db, server, restore, supabase, client };
}

const origEvent = (type: string, cc: string) => ({
  orgId: ORG_ID,
  eventId: crypto.randomUUID(),
  eventType: type,
  callControlId: cc,
  payload: {},
});

Deno.test(
  'H36: a bare 10-digit forward number is normalised to E.164 before the transfer',
  async () => {
    const { db, server, restore, supabase, client } = h36Setup({ forward: '(830) 563-5638' });
    try {
      await handleFreshInboundCall(supabase, client, freshInboundArgs({ callControlId: 'h36-a' }));
      assertEquals(loadRow(db, 'h36-a').state, 'ringing_cell');
      assertEquals(server.transfers[0].body.to, '+18305635638');
    } finally {
      restore();
    }
  }
);

Deno.test(
  'H36: an unusable forward number is skipped (not stuck): next step is voicemail',
  async () => {
    const { db, server, restore, supabase, client } = h36Setup({ forward: 'call me maybe' });
    try {
      await handleFreshInboundCall(supabase, client, freshInboundArgs({ callControlId: 'h36-b' }));
      assertEquals(loadRow(db, 'h36-b').state, 'voicemail');
      assertEquals(server.transfers.length, 0);
      assertEquals(server.answers.length, 1);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'H36: transfer to the cell fails (422) -> advances to the shared line, then voicemail',
  async () => {
    const { db, server, restore, supabase, client } = h36Setup({
      forward: '+18305635638',
      shared: '+19995550002',
    });
    try {
      server.failNext.set('transfer', 2); // cell AND shared transfers both rejected
      await handleFreshInboundCall(supabase, client, freshInboundArgs({ callControlId: 'h36-c' }));
      const row = loadRow(db, 'h36-c');
      assertEquals(row.state, 'voicemail', 'never left parked in ringing_cell');
      assertEquals(server.answers.length, 1, 'caller reaches voicemail instead of dead air');
    } finally {
      restore();
    }
  }
);

Deno.test('H36: cell transfer fails, shared line works -> rings the shared line', async () => {
  const { db, server, restore, supabase, client } = h36Setup({
    forward: '+18305635638',
    shared: '+19995550002',
  });
  try {
    server.failNext.set('transfer', 1);
    await handleFreshInboundCall(supabase, client, freshInboundArgs({ callControlId: 'h36-d' }));
    assertEquals(loadRow(db, 'h36-d').state, 'ringing_shared');
    assertEquals(server.transfers.length, 1);
    assertEquals(server.transfers[0].body.to, '+19995550002');
  } finally {
    restore();
  }
});

Deno.test(
  'H36: voicemail answer fails -> row ends as missed and the caller is hung up',
  async () => {
    const { db, server, restore, supabase, client } = h36Setup({});
    try {
      server.failNext.set('answer', 1);
      await handleFreshInboundCall(supabase, client, freshInboundArgs({ callControlId: 'h36-e' }));
      const row = loadRow(db, 'h36-e');
      assertEquals(row.state, 'ended');
      assertEquals(row.outcome, 'missed');
      assertEquals(server.hangups, ['h36-e']);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'H36: voicemail speak fails -> ends as missed + hangup (not stuck in voicemail)',
  async () => {
    const { db, server, restore, supabase, client } = h36Setup({});
    try {
      await handleFreshInboundCall(supabase, client, freshInboundArgs({ callControlId: 'h36-f' }));
      server.failNext.set('speak', 1);
      await handleOriginalLegEvent(
        supabase,
        client,
        origEvent('call.answered', 'h36-f'),
        loadRow(db, 'h36-f')
      );
      const row = loadRow(db, 'h36-f');
      assertEquals(row.state, 'ended');
      assertEquals(row.outcome, 'missed');
      assertEquals(server.hangups, ['h36-f']);
    } finally {
      restore();
    }
  }
);

Deno.test('H36: record_start fails -> ends as missed + hangup', async () => {
  const { db, server, restore, supabase, client } = h36Setup({});
  try {
    await handleFreshInboundCall(supabase, client, freshInboundArgs({ callControlId: 'h36-g' }));
    await handleOriginalLegEvent(
      supabase,
      client,
      origEvent('call.answered', 'h36-g'),
      loadRow(db, 'h36-g')
    );
    server.failNext.set('record_start', 1);
    await handleOriginalLegEvent(
      supabase,
      client,
      origEvent('call.speak.ended', 'h36-g'),
      loadRow(db, 'h36-g')
    );
    assertEquals(loadRow(db, 'h36-g').state, 'ended');
    assertEquals(loadRow(db, 'h36-g').outcome, 'missed');
  } finally {
    restore();
  }
});

Deno.test(
  'H36: bridging_session answer fails (Repuvance row) -> advances instead of sticking',
  async () => {
    const { db, server, restore, supabase, client } = h36Setup({
      online: true,
      forward: '+18305635638',
    });
    db.insert('dial_sessions', {
      id: 'sess-h36',
      org_id: ORG_ID,
      campaign_id: CAMPAIGN_ID,
      agent_id: 'intern-1',
      state: 'dialing',
      conference_id: 'conf-h36',
    });
    try {
      server.failNext.set('answer', 1);
      await handleFreshInboundCall(supabase, client, freshInboundArgs({ callControlId: 'h36-h' }));
      assertEquals(
        loadRow(db, 'h36-h').state,
        'ringing_cell',
        'moved on to the cell, not stuck in bridging_session'
      );
      assertEquals(server.transfers.length, 1);
    } finally {
      restore();
    }
  }
);

Deno.test(
  'H36: bridging_session -- caller leg answered WITHOUT client_state still joins the conference; join failure advances',
  async () => {
    for (const joinFails of [false, true]) {
      const cc = joinFails ? 'h36-i2' : 'h36-i1';
      const { db, server, restore, supabase, client } = h36Setup({
        online: true,
        forward: '+18305635638',
      });
      db.insert('dial_sessions', {
        id: 'sess-h36',
        org_id: ORG_ID,
        campaign_id: CAMPAIGN_ID,
        agent_id: 'intern-1',
        state: 'dialing',
        conference_id: 'conf-h36',
      });
      try {
        await handleFreshInboundCall(supabase, client, freshInboundArgs({ callControlId: cc }));
        assertEquals(loadRow(db, cc).state, 'bridging_session');
        if (joinFails) server.failNext.set('join', 1);
        // The webhook gate (telnyx-webhook/index.ts) now delivers this original-leg event even
        // though it has no client_state; the engine matches it by call_control_id.
        await handleOriginalLegEvent(
          supabase,
          client,
          origEvent('call.answered', cc),
          loadRow(db, cc)
        );
        if (!joinFails) {
          assertEquals(server.joins.length, 1);
          assertEquals(loadRow(db, cc).state, 'bridging_session');
        } else {
          assertEquals(server.joins.length, 0);
          assertEquals(
            loadRow(db, cc).state,
            'ringing_cell',
            'join failure falls through to the cell'
          );
        }
      } finally {
        restore();
      }
    }
  }
);

Deno.test(
  'H36: caller hangs up while the cell is ringing (original-leg hangup, no client_state) -> ended missed',
  async () => {
    const { db, server, restore, supabase, client } = h36Setup({ forward: '+18305635638' });
    try {
      await handleFreshInboundCall(supabase, client, freshInboundArgs({ callControlId: 'h36-j' }));
      assertEquals(loadRow(db, 'h36-j').state, 'ringing_cell');
      await handleOriginalLegEvent(
        supabase,
        client,
        origEvent('call.hangup', 'h36-j'),
        loadRow(db, 'h36-j')
      );
      const row = loadRow(db, 'h36-j');
      assertEquals(row.state, 'ended');
      assertEquals(row.outcome, 'missed');
      assertEquals(server.hangups.length, 0);
    } finally {
      restore();
    }
  }
);

// ---------------------------------------------------------------------------
// TASK-H36 round 2
// ---------------------------------------------------------------------------

const agoIso = (secs: number) => new Date(Date.now() - secs * 1000).toISOString();

async function reap(h: ReturnType<typeof h36Setup>, opts: { noClient?: boolean } = {}) {
  return await reapStaleInboundCalls(h.supabase, async () => (opts.noClient ? null : h.client));
}

Deno.test(
  'H36r2 reaper: a ringing_cell row 200 s old that Telnyx says is ALIVE is left alone (no hangup, still open)',
  async () => {
    const h = h36Setup({ forward: '+18305635638' });
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'r-a' })
      );
      loadRow(h.db, 'r-a');
      (h.db.table('inbound_calls').values().next().value as Record<string, unknown>).created_at =
        agoIso(200);
      h.server.callStatus.set('r-a', 'alive');
      const res = await reap(h);
      assertEquals(res.leftAlive, 1);
      assertEquals(h.server.hangups.length, 0, 'never cuts a live call');
      assertEquals(loadRow(h.db, 'r-a').state, 'ringing_cell');
    } finally {
      h.restore();
    }
  }
);

Deno.test(
  'H36r2 reaper: dead leg -> ended; unanswered=missed, answered=its connected outcome',
  async () => {
    const h = h36Setup({ forward: '+18305635638' });
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'r-b1' })
      );
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'r-b2' })
      );
      for (const r of h.db.table('inbound_calls').values()) {
        r.created_at = agoIso(400);
        if (r.call_control_id === 'r-b2') r.answered_at = agoIso(2000); // connected, then lost
      }
      h.server.callStatus.set('r-b1', 'dead');
      h.server.callStatus.set('r-b2', 'dead');
      const res = await reap(h);
      assertEquals(res.ended, 2);
      assertEquals(loadRow(h.db, 'r-b1').outcome, 'missed');
      assertEquals(loadRow(h.db, 'r-b2').outcome, 'forwarded');
      assertEquals(h.server.hangups.length, 0, 'dead legs need no hangup');
    } finally {
      h.restore();
    }
  }
);

Deno.test(
  'H36r2 reaper: alive + never routed (ringing) or unanswered voicemail, >10 min -> hangup + missed',
  async () => {
    for (const state of ['ringing', 'voicemail']) {
      const h = h36Setup({ forward: '+18305635638' });
      try {
        await handleFreshInboundCall(
          h.supabase,
          h.client,
          freshInboundArgs({ callControlId: 'r-c' })
        );
        for (const r of h.db.table('inbound_calls').values()) {
          r.created_at = agoIso(700);
          r.state = state;
        }
        h.server.callStatus.set('r-c', 'alive');
        const res = await reap(h);
        assertEquals(res.hungUp, 1, state);
        assertEquals(h.server.hangups, ['r-c']);
        assertEquals(loadRow(h.db, 'r-c').state, 'ended');
        assertEquals(loadRow(h.db, 'r-c').outcome, 'missed');
      } finally {
        h.restore();
      }
    }
  }
);

Deno.test(
  'H36r3 reaper: an ALIVE ringing_intern/cell/shared/bridging_session row is never hung up, however old',
  async () => {
    for (const state of ['ringing_intern', 'ringing_cell', 'ringing_shared', 'bridging_session']) {
      const h = h36Setup({ forward: '+18305635638' });
      try {
        await handleFreshInboundCall(
          h.supabase,
          h.client,
          freshInboundArgs({ callControlId: 'r-g' })
        );
        for (const r of h.db.table('inbound_calls').values()) {
          r.created_at = agoIso(3600);
          r.state = state;
          // an unanswered bridging_session is a stalled join (round 4: advanced, not hung up);
          // an answered one is a live conversation and is left alone
          if (state === 'bridging_session') r.answered_at = agoIso(3000);
        }
        h.server.callStatus.set('r-g', 'alive');
        const res = await reap(h);
        assertEquals(res.leftAlive, 1, state);
        assertEquals(h.server.hangups.length, 0, state);
        assertEquals(loadRow(h.db, 'r-g').state, state);
      } finally {
        h.restore();
      }
    }
  }
);

Deno.test('H36r2 reaper: Telnyx error/unknown, or no Telnyx key -> left alone', async () => {
  const h = h36Setup({ forward: '+18305635638' });
  try {
    await handleFreshInboundCall(h.supabase, h.client, freshInboundArgs({ callControlId: 'r-d' }));
    for (const r of h.db.table('inbound_calls').values()) r.created_at = agoIso(900);
    // callStatus unset -> fake answers 500
    let res = await reap(h);
    assertEquals(res.unknown, 1);
    assertEquals(loadRow(h.db, 'r-d').state, 'ringing_cell');
    res = await reap(h, { noClient: true });
    assertEquals(res.unknown, 1);
    assertEquals(loadRow(h.db, 'r-d').state, 'ringing_cell');
    assertEquals(h.server.hangups.length, 0);
  } finally {
    h.restore();
  }
});

Deno.test(
  'H36r2 reaper: a live answered call (long forwarded conversation) is left alone',
  async () => {
    const h = h36Setup({ forward: '+18305635638' });
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'r-e' })
      );
      for (const r of h.db.table('inbound_calls').values()) {
        r.created_at = agoIso(5000);
        r.answered_at = agoIso(4000);
      }
      h.server.callStatus.set('r-e', 'alive');
      const res = await reap(h);
      assertEquals(res.leftAlive, 1);
      assertEquals(loadRow(h.db, 'r-e').state, 'ringing_cell');
      assertEquals(h.server.hangups.length, 0);
    } finally {
      h.restore();
    }
  }
);

function seedJoinableSession(h: ReturnType<typeof h36Setup>, conf: string | null = 'conf-h36') {
  h.db.insert('dial_sessions', {
    id: 'sess-h36',
    org_id: ORG_ID,
    campaign_id: CAMPAIGN_ID,
    agent_id: 'intern-1',
    state: 'dialing',
    conference_id: conf,
  });
}
const sessionOf = (h: ReturnType<typeof h36Setup>) => h.db.table('dial_sessions').get('sess-h36')!;

Deno.test(
  'H36r2 reaper: ending a dead bridging_session row resumes the agent session',
  async () => {
    const h = h36Setup({ online: true });
    seedJoinableSession(h);
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'r-f' })
      );
      assertEquals(sessionOf(h).state, 'paused');
      for (const r of h.db.table('inbound_calls').values()) r.created_at = agoIso(400);
      h.server.callStatus.set('r-f', 'dead');
      await reap(h);
      assertEquals(loadRow(h.db, 'r-f').state, 'ended');
      assertEquals(sessionOf(h).state, 'dialing');
      assertEquals(sessionOf(h).pause_reason, null);
    } finally {
      h.restore();
    }
  }
);

Deno.test(
  'H36r3 original-leg call.answered while ringing sets answered_at once; call.bridged does NOT',
  async () => {
    const h = h36Setup({ forward: '+18305635638' });
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'b-a' })
      );
      await handleOriginalLegEvent(
        h.supabase,
        h.client,
        origEvent('call.bridged', 'b-a'),
        loadRow(h.db, 'b-a')
      );
      assertEquals(!!loadRow(h.db, 'b-a').answered_at, false, 'bridged is not an answer');
      await handleOriginalLegEvent(
        h.supabase,
        h.client,
        origEvent('call.answered', 'b-a'),
        loadRow(h.db, 'b-a')
      );
      const first = loadRow(h.db, 'b-a').answered_at;
      assertExists(first);
      await handleOriginalLegEvent(
        h.supabase,
        h.client,
        origEvent('call.answered', 'b-a'),
        loadRow(h.db, 'b-a')
      );
      assertEquals(loadRow(h.db, 'b-a').answered_at, first, 'idempotent');
      await handleOriginalLegEvent(
        h.supabase,
        h.client,
        origEvent('call.hangup', 'b-a'),
        loadRow(h.db, 'b-a')
      );
      assertEquals(loadRow(h.db, 'b-a').outcome, 'forwarded');
    } finally {
      h.restore();
    }
  }
);

Deno.test(
  'H36r3 real sequence: intern SIP leg initiated -> bridged -> hangup (no answered) falls through to the cell',
  async () => {
    // Live webhook_events (4 of 5 forwarded rows): Telnyx sends call.bridged on the intern leg a
    // fraction of a second after call.initiated and call.hangup ~1 s later, with NO call.answered.
    const h = h36Setup({ online: true, forward: '+18305635638', shared: '+19995550002' });
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'b-c' })
      );
      assertEquals(loadRow(h.db, 'b-c').state, 'ringing_intern');
      const row = loadRow(h.db, 'b-c');
      const cs = { org: ORG_ID, inbound: row.id, step: 'intern' as InboundCallStep };
      for (const type of ['call.initiated', 'call.bridged', 'call.hangup']) {
        await handleClientStateEvent(
          h.supabase,
          h.client,
          { ...origEvent(type, 'leg-b-intern'), payload: {} },
          cs
        );
      }
      const after = loadRow(h.db, 'b-c');
      assertEquals(!!after.answered_at, false, 'bridged without answered is not a connection');
      assertEquals(after.state, 'ringing_cell', 'the chain continues to the cell');
      assertEquals(h.server.transfers.length, 2);
      assertEquals(h.server.transfers[1].body.to, '+18305635638');
    } finally {
      h.restore();
    }
  }
);

Deno.test(
  'H36r2 bridging failures resume the agent session: answer fail, join fail, no conference, caller left first',
  async () => {
    // answer fails
    {
      const h = h36Setup({ online: true });
      seedJoinableSession(h);
      try {
        h.server.failNext.set('answer', 1);
        await handleFreshInboundCall(
          h.supabase,
          h.client,
          freshInboundArgs({ callControlId: 'v-1' })
        );
        assertEquals(sessionOf(h).state, 'dialing', 'answer failure resumes');
      } finally {
        h.restore();
      }
    }
    // join fails
    {
      const h = h36Setup({ online: true });
      seedJoinableSession(h);
      try {
        await handleFreshInboundCall(
          h.supabase,
          h.client,
          freshInboundArgs({ callControlId: 'v-2' })
        );
        assertEquals(sessionOf(h).state, 'paused');
        h.server.failNext.set('join', 1);
        await handleOriginalLegEvent(
          h.supabase,
          h.client,
          origEvent('call.answered', 'v-2'),
          loadRow(h.db, 'v-2')
        );
        assertEquals(sessionOf(h).state, 'dialing', 'join failure resumes');
      } finally {
        h.restore();
      }
    }
    // no conference id
    {
      const h = h36Setup({ online: true });
      seedJoinableSession(h, null);
      try {
        await handleFreshInboundCall(
          h.supabase,
          h.client,
          freshInboundArgs({ callControlId: 'v-3' })
        );
        await handleOriginalLegEvent(
          h.supabase,
          h.client,
          origEvent('call.answered', 'v-3'),
          loadRow(h.db, 'v-3')
        );
        assertEquals(sessionOf(h).state, 'dialing');
      } finally {
        h.restore();
      }
    }
    // caller hangs up before the join
    {
      const h = h36Setup({ online: true });
      seedJoinableSession(h);
      try {
        await handleFreshInboundCall(
          h.supabase,
          h.client,
          freshInboundArgs({ callControlId: 'v-4' })
        );
        await handleOriginalLegEvent(
          h.supabase,
          h.client,
          origEvent('call.hangup', 'v-4'),
          loadRow(h.db, 'v-4')
        );
        assertEquals(sessionOf(h).state, 'dialing');
        assertEquals(loadRow(h.db, 'v-4').outcome, 'missed');
      } finally {
        h.restore();
      }
    }
    // a REAL conversation (joined, then hangup) leaves the session paused for the agent's Resume
    {
      const h = h36Setup({ online: true });
      seedJoinableSession(h);
      try {
        await handleFreshInboundCall(
          h.supabase,
          h.client,
          freshInboundArgs({ callControlId: 'v-5' })
        );
        await handleOriginalLegEvent(
          h.supabase,
          h.client,
          origEvent('call.answered', 'v-5'),
          loadRow(h.db, 'v-5')
        );
        await handleOriginalLegEvent(
          h.supabase,
          h.client,
          origEvent('call.hangup', 'v-5'),
          loadRow(h.db, 'v-5')
        );
        assertEquals(sessionOf(h).state, 'paused');
        assertEquals(loadRow(h.db, 'v-5').outcome, 'answered_by_agent');
      } finally {
        h.restore();
      }
    }
  }
);

Deno.test(
  'H36r2 failed join with no cell/shared -> already-answered caller gets voicemail via speak (no 2nd answer), record has max_length',
  async () => {
    const h = h36Setup({ online: true });
    seedJoinableSession(h);
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'w-1' })
      );
      assertEquals(h.server.answers.length, 1);
      h.server.failNext.set('join', 1);
      await handleOriginalLegEvent(
        h.supabase,
        h.client,
        origEvent('call.answered', 'w-1'),
        loadRow(h.db, 'w-1')
      );
      const row = loadRow(h.db, 'w-1');
      assertEquals(row.state, 'voicemail', 'caller is not dropped');
      assertEquals(h.server.answers.length, 1, 'no second answer on an answered leg');
      assertEquals(h.server.speaks.length, 1);
      assertExists(h.server.speaks[0].body.client_state);
      assertEquals(h.server.hangups.length, 0);
      await handleOriginalLegEvent(
        h.supabase,
        h.client,
        origEvent('call.speak.ended', 'w-1'),
        loadRow(h.db, 'w-1')
      );
      assertEquals(h.server.recordStarts.length, 1);
      assertEquals(h.server.recordStarts[0].body.max_length, 120);
    } finally {
      h.restore();
    }
  }
);

Deno.test(
  'H36r2 join failure -> cell: answered_at cleared, so a caller hang-up during the ring is missed (not forwarded)',
  async () => {
    const h = h36Setup({ online: true, forward: '+18305635638' });
    seedJoinableSession(h);
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'w-2' })
      );
      h.server.failNext.set('join', 1);
      await handleOriginalLegEvent(
        h.supabase,
        h.client,
        origEvent('call.answered', 'w-2'),
        loadRow(h.db, 'w-2')
      );
      assertEquals(loadRow(h.db, 'w-2').state, 'ringing_cell');
      assertEquals(loadRow(h.db, 'w-2').answered_at, null);
      await handleOriginalLegEvent(
        h.supabase,
        h.client,
        origEvent('call.hangup', 'w-2'),
        loadRow(h.db, 'w-2')
      );
      assertEquals(loadRow(h.db, 'w-2').outcome, 'missed');
    } finally {
      h.restore();
    }
  }
);

Deno.test(
  'H36r2 transfer failing with an UNKNOWN outcome (5xx/timeout) does not ring a second destination',
  async () => {
    const h = h36Setup({ forward: '+18305635638', shared: '+19995550002' });
    try {
      h.server.failNext.set('transfer', 1);
      h.server.failStatus = 503;
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'x-1' })
      );
      assertEquals(
        loadRow(h.db, 'x-1').state,
        'ringing_cell',
        'stays; Leg B events or the reaper decide'
      );
      assertEquals(h.server.transfers.length, 0, 'no second transfer');
    } finally {
      h.restore();
    }
  }
);

// ---------------------------------------------------------------------------
// TASK-H36 round 4
// ---------------------------------------------------------------------------

Deno.test(
  'H36r4 auto-resume restores the PRE-inbound state: ready stays ready, dialing goes back to dialing',
  async () => {
    for (const prior of ['ready', 'dialing']) {
      const h = h36Setup({ online: true });
      h.db.insert('dial_sessions', {
        id: 'sess-h36',
        org_id: ORG_ID,
        campaign_id: CAMPAIGN_ID,
        agent_id: 'intern-1',
        state: prior,
        conference_id: 'conf-h36',
      });
      try {
        h.server.failNext.set('answer', 1);
        await handleFreshInboundCall(
          h.supabase,
          h.client,
          freshInboundArgs({ callControlId: `p-${prior}` })
        );
        assertEquals(
          h.db.table('dial_sessions').get('sess-h36')!.state,
          prior,
          `restored to ${prior}`
        );
        assertEquals(h.db.table('dial_sessions').get('sess-h36')!.pause_reason, null);
      } finally {
        h.restore();
      }
    }
  }
);

Deno.test(
  'H36r4 voicemail: recording saved/error hangs the caller up (no silent line)',
  async () => {
    const h = h36Setup({});
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'rec-1' })
      );
      const row = loadRow(h.db, 'rec-1');
      assertEquals(row.state, 'voicemail');
      await handleClientStateEvent(
        h.supabase,
        h.client,
        { ...origEvent('call.recording.error', 'rec-1'), payload: {} },
        { org: ORG_ID, inbound: row.id, step: 'voicemail' as InboundCallStep }
      );
      assertEquals(h.server.hangups, ['rec-1']);
    } finally {
      h.restore();
    }
  }
);

Deno.test(
  'H36r4 bridging_session whose join answer never arrives: stalled > 30 s -> agent resumed, caller to the next step',
  async () => {
    const h = h36Setup({ online: true, forward: '+18305635638' });
    h.db.insert('dial_sessions', {
      id: 'sess-h36',
      org_id: ORG_ID,
      campaign_id: CAMPAIGN_ID,
      agent_id: 'intern-1',
      state: 'ready',
      conference_id: 'conf-h36',
    });
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'st-1' })
      );
      assertEquals(loadRow(h.db, 'st-1').state, 'bridging_session');
      // too fresh: nothing happens
      h.server.callStatus.set('st-1', 'alive');
      assertEquals((await reap(h)).checked, 0);
      for (const r of h.db.table('inbound_calls').values()) r.created_at = agoIso(45);
      const res = await reap(h);
      assertEquals(res.advanced, 1);
      assertEquals(loadRow(h.db, 'st-1').state, 'ringing_cell');
      assertEquals(h.db.table('dial_sessions').get('sess-h36')!.state, 'ready');
      assertEquals(h.server.hangups.length, 0);
    } finally {
      h.restore();
    }
  }
);

Deno.test(
  'H36r4 bridging stall: a late real answer (answered_at set) is not advanced; a dead leg is ended + agent resumed',
  async () => {
    const h = h36Setup({ online: true, forward: '+18305635638' });
    h.db.insert('dial_sessions', {
      id: 'sess-h36',
      org_id: ORG_ID,
      campaign_id: CAMPAIGN_ID,
      agent_id: 'intern-1',
      state: 'dialing',
      conference_id: 'conf-h36',
    });
    try {
      await handleFreshInboundCall(
        h.supabase,
        h.client,
        freshInboundArgs({ callControlId: 'st-2' })
      );
      for (const r of h.db.table('inbound_calls').values()) {
        r.created_at = agoIso(45);
        r.answered_at = agoIso(10); // answer arrived after all
      }
      h.server.callStatus.set('st-2', 'alive');
      assertEquals((await reap(h)).advanced, 0);
      assertEquals(loadRow(h.db, 'st-2').state, 'bridging_session');
      // dead leg, never answered
      for (const r of h.db.table('inbound_calls').values()) r.answered_at = null;
      h.server.callStatus.set('st-2', 'dead');
      const res = await reap(h);
      assertEquals(res.ended, 1);
      assertEquals(loadRow(h.db, 'st-2').state, 'ended');
      assertEquals(h.db.table('dial_sessions').get('sess-h36')!.state, 'dialing');
    } finally {
      h.restore();
    }
  }
);

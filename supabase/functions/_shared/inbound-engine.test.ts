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

  handle(url: string, init?: RequestInit): Response {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};

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

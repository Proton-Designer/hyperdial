/**
 * TASK-L1 acceptance substitution, per the lead's explicit decision (this run's launch-
 * blockers phase forbids starting a local Supabase/Docker stack -- see RESUME_PLAN-eng2.md
 * and this task's own Log). The task's original acceptance item #2 ("a mock-sim script
 * walks Go Ready -> ... -> Reconnect -> ready") required `supabase functions serve` + a real
 * local Postgres, exactly like `scripts/dev/dialer-sim.ts` (TASK-P2-E2's own acceptance
 * script) -- both are unrunnable now that local Docker is retired.
 *
 * This file drives the SAME scenario end-to-end, but against:
 * - an in-memory fake of the Supabase client (`.from()`/`.rpc()`) that reimplements exactly
 *   the table shapes and RPC semantics `dialer-engine.ts` actually calls (claim_next_leads,
 *   claim_leg, transition_leg, transition_session, apply_leg_outcome, record_webhook_event,
 *   get_org_telnyx_key) -- no network, no DB, no Docker.
 * - the REAL `createTelnyxClient` (`_shared/telnyx-client.ts`), with `globalThis.fetch`
 *   stubbed exactly like `telnyx-client.test.ts` already does. This is deliberately not a
 *   hand-rolled fake Telnyx client -- reusing the real client means this test also exercises
 *   the real request-shape code (BUG-8's time_limit_secs, the custom_headers/client_state on
 *   the agent dial), not just the engine's own decisions.
 *
 * Scenario (mirrors the task's own acceptance walk):
 *   startSession (Go Ready) -> agent leg dialed -> agent call.answered -> conference created,
 *   session ready_pending -> ready -> dialing -> refillSession dials 3 contacts -> one
 *   contact's call.answered (amd off) claims the session -> winner joins the (already-
 *   existing) conference, session -> on_call, the other two contacts get dropped/abandoned ->
 *   agent call.hangup -> session -> paused_agent_lost, the winner (claimed) leg is untouched,
 *   any other still-active contact leg is hung up -> reconnectAgentLeg redials a fresh agent
 *   leg into the SAME conference -> its own call.answered -> ready (asserted via the
 *   transition log, since this engine cascades further in the same call) -> on_call (rejoins
 *   the still-live winner call, which is the correct behavior per this task's own invariant:
 *   a live claimed contact is never abandoned by an agent-leg problem).
 */
import { assertEquals, assertExists } from 'jsr:@std/assert@1';
import {
  startSession,
  reconnectAgentLeg,
  processTelnyxDialerEvent,
  pauseSession,
  type RawTelnyxEvent,
} from './dialer-engine.ts';
import type { DialClientStateKind } from './client-state.ts';

// ---------------------------------------------------------------------------
// In-memory fake Supabase client -- exactly the tables/RPCs dialer-engine.ts uses.
// ---------------------------------------------------------------------------

interface Row {
  [key: string]: unknown;
}

class FakeDb {
  tables = new Map<string, Map<string, Row>>();
  webhookEvents = new Set<string>();
  /** Every transition_session call, in order -- lets the test prove an intermediate state
   *  (e.g. 'ready') was really reached even though the engine cascades past it synchronously
   *  within the same call. */
  sessionTransitions: { from: string; to: string }[] = [];

  table(name: string): Map<string, Row> {
    if (!this.tables.has(name)) this.tables.set(name, new Map());
    return this.tables.get(name)!;
  }

  insert(table: string, row: Row): Row {
    const id = (row.id as string | undefined) ?? crypto.randomUUID();
    const full = { ...row, id };
    this.table(table).set(id, full);
    return full;
  }
}

function matchesFilters(row: Row, filters: [string, 'eq' | 'neq' | 'is', unknown][]): boolean {
  return filters.every(([col, op, val]) => {
    // A never-set fixture field is `undefined`, not `null` -- normalize for `.is()` so it
    // matches the same way a genuinely-NULL Postgres column would.
    if (op === 'is') return (row[col] ?? null) === val;
    if (op === 'eq') return row[col] === val;
    return row[col] !== val;
  });
}

class FakeQuery implements PromiseLike<{ data: unknown; error: null }> {
  private filters: [string, 'eq' | 'neq' | 'is', unknown][] = [];
  private mode: 'select' | 'insert' | 'update' = 'select';
  private payload: Row = {};
  private singleMode: 'single' | 'maybeSingle' | null = null;
  private limitCount: number | null = null;
  private insertedRow: Row | null = null;

  constructor(
    private db: FakeDb,
    private table: string
  ) {}

  select(_cols?: string): this {
    return this;
  }
  insert(payload: Row): this {
    this.mode = 'insert';
    this.payload = payload;
    return this;
  }
  update(payload: Row): this {
    this.mode = 'update';
    this.payload = payload;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push([col, 'eq', val]);
    return this;
  }
  neq(col: string, val: unknown): this {
    this.filters.push([col, 'neq', val]);
    return this;
  }
  is(col: string, val: unknown): this {
    this.filters.push([col, 'is', val]);
    return this;
  }
  limit(count: number): this {
    this.limitCount = count;
    return this;
  }
  single(): this {
    this.singleMode = 'single';
    return this;
  }
  maybeSingle(): this {
    this.singleMode = 'maybeSingle';
    return this;
  }

  private execute(): { data: unknown; error: null } {
    if (this.mode === 'insert') {
      this.insertedRow = this.db.insert(this.table, this.payload);
      return { data: this.singleMode ? this.insertedRow : [this.insertedRow], error: null };
    }
    if (this.mode === 'update') {
      const rows = [...this.db.table(this.table).values()].filter((r) =>
        matchesFilters(r, this.filters)
      );
      for (const row of rows) Object.assign(row, this.payload);
      return { data: null, error: null };
    }
    // select
    let rows = [...this.db.table(this.table).values()].filter((r) =>
      matchesFilters(r, this.filters)
    );
    if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
    if (this.singleMode) return { data: rows[0] ?? null, error: null };
    return { data: rows, error: null };
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?:
      ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }
}

const FAKE_TELNYX_KEY = 'fake-telnyx-key';

/** Must track exactly the case-when arms in transition_session's real SQL definition
 *  (20260924000800_dialer_rpcs.sql + the 20260925005200 fix-forward for
 *  paused_agent_lost_from). See the M4 comment at this constant's one use site below. */
const TRANSITION_SESSION_FIELDS = [
  'agent_leg_id',
  'active_leg_id',
  'conference_id',
  'ended_at',
  'paused_agent_lost_from',
];

/** Same masking-bug class as TRANSITION_SESSION_FIELDS above (M4) -- transition_leg's fake used
 *  to be a blind `Object.assign`, which would have silently accepted a p_fields key the real
 *  SQL (20260924000800_dialer_rpcs.sql + 20260925020000's bridged_at/duration_seconds addition)
 *  doesn't write, exactly the way M4 went unnoticed. Must track that function's case-when arms
 *  exactly. */
const TRANSITION_LEG_FIELDS = [
  'outcome',
  'amd_result',
  'hangup_cause',
  'answered_at',
  'claimed_at',
  'bridged_at',
  'ended_at',
  'duration_seconds',
];

function rpc(
  db: FakeDb,
  name: string,
  args: Record<string, unknown>
): { data: unknown; error: null } {
  switch (name) {
    case 'get_org_telnyx_key':
      return { data: FAKE_TELNYX_KEY, error: null };

    case 'record_webhook_event': {
      const eventId = args.p_event_id as string;
      if (db.webhookEvents.has(eventId)) return { data: false, error: null };
      db.webhookEvents.add(eventId);
      return { data: true, error: null };
    }

    case 'claim_next_leads': {
      const sessionId = args.p_session as string;
      const session = db.table('dial_sessions').get(sessionId);
      if (!session) return { data: [], error: null };
      // TASK-F-T3 (VMD-5): must track the real SQL's own capacity check exactly (see this
      // migration's own comment on that line) -- a leg playing a voicemail drop never holds up
      // a refill the way an 'ended' leg already doesn't.
      const activeContactLegs = [...db.table('call_legs').values()].filter(
        (l) =>
          l.session_id === sessionId &&
          l.kind === 'contact' &&
          l.state !== 'ended' &&
          l.state !== 'voicemail_dropping'
      ).length;
      const capacity = Math.max(0, (session.lines as number) - activeContactLegs);
      if (capacity === 0) return { data: [], error: null };
      const dueLeads = [...db.table('campaign_leads').values()]
        .filter((l) => l.campaign_id === session.campaign_id && l.status === 'queued')
        .sort((a, b) => (a.position as number) - (b.position as number))
        .slice(0, capacity);
      const results = dueLeads.map((lead) => {
        lead.status = 'in_flight';
        const contact = db.table('contacts').get(lead.contact_id as string)!;
        const legId = crypto.randomUUID();
        const callControlId = `pending-${crypto.randomUUID()}`;
        db.insert('call_legs', {
          id: legId,
          org_id: session.org_id,
          session_id: sessionId,
          campaign_id: session.campaign_id,
          contact_id: lead.contact_id,
          lead_id: lead.id,
          kind: 'contact',
          call_control_id: callControlId,
          state: 'initiated',
          outcome: null,
        });
        return {
          leg_id: legId,
          lead_id: lead.id,
          contact_id: lead.contact_id,
          phone_number: contact.phone_number,
          call_control_id: callControlId,
        };
      });
      return { data: results, error: null };
    }

    case 'claim_leg': {
      const session = db.table('dial_sessions').get(args.p_session as string);
      const leg = db.table('call_legs').get(args.p_leg as string);
      if (!session || !leg || session.state !== 'dialing' || session.active_leg_id) {
        return { data: false, error: null };
      }
      session.active_leg_id = leg.id;
      session.state = 'connecting';
      leg.state = 'claimed';
      leg.claimed_at = new Date().toISOString();
      return { data: true, error: null };
    }

    case 'transition_leg': {
      const callControlId = args.p_call_control_id as string;
      const expected = args.p_expected_states as string[];
      const leg = [...db.table('call_legs').values()].find(
        (l) => l.call_control_id === callControlId
      );
      if (!leg || !expected.includes(leg.state as string)) return { data: false, error: null };
      leg.state = args.p_new_state;
      const fields = (args.p_fields as Row | undefined) ?? {};
      for (const key of Object.keys(fields)) {
        if (!TRANSITION_LEG_FIELDS.includes(key)) {
          throw new Error(
            `fake transition_leg: unrecognized p_fields key '${key}' -- the real SQL function ` +
              `does not write it either; add it to both if that's intentional`
          );
        }
      }
      for (const key of TRANSITION_LEG_FIELDS) {
        if (key in fields) leg[key] = fields[key];
      }
      return { data: true, error: null };
    }

    case 'transition_session': {
      const session = db.table('dial_sessions').get(args.p_session as string);
      const expected = args.p_expected_states as string[];
      if (!session || !expected.includes(session.state as string)) {
        return { data: false, error: null };
      }
      const from = session.state as string;
      const to = args.p_new_state as string;
      session.state = to;
      // Review fix (M4): the real SQL function (20260924000800 + the 20260925005200
      // fix-forward) only ever writes this exact allowlist of columns -- anything else in
      // p_fields is silently ignored by Postgres's `case when p_fields ? 'x' then ...`. The
      // old blind `Object.assign` here accepted ANY key, which is exactly how M4 (engine code
      // sending paused_agent_lost_from before the SQL function knew about it) went unnoticed
      // by every test in this file. Throwing on an unrecognized key means a future field added
      // to the engine's p_fields without a matching SQL migration + allowlist update fails a
      // test immediately instead of silently no-op'ing in prod.
      const fields = (args.p_fields as Row | undefined) ?? {};
      for (const key of Object.keys(fields)) {
        if (!TRANSITION_SESSION_FIELDS.includes(key)) {
          throw new Error(
            `fake transition_session: unrecognized p_fields key '${key}' -- the real SQL ` +
              `function does not write it either; add it to both if that's intentional`
          );
        }
      }
      for (const key of TRANSITION_SESSION_FIELDS) {
        if (key in fields) session[key] = fields[key];
      }
      db.sessionTransitions.push({ from, to });
      return { data: true, error: null };
    }

    case 'apply_leg_outcome': {
      const leg = db.table('call_legs').get(args.p_leg as string);
      if (!leg || leg.outcome == null) return { data: null, error: null };
      if (leg.session_id) {
        const session = db.table('dial_sessions').get(leg.session_id as string);
        if (session && session.active_leg_id === leg.id) session.active_leg_id = null;
      }
      return { data: null, error: null };
    }

    default:
      throw new Error(`fake rpc: unhandled function ${name}`);
  }
}

function createFakeSupabase(db: FakeDb) {
  return {
    from(table: string) {
      return new FakeQuery(db, table);
    },
    rpc(name: string, args: Record<string, unknown>) {
      return Promise.resolve(rpc(db, name, args));
    },
    // TASK-F-T2: minimal fake of `.storage.from(bucket).upload()` -- the recording download
    // path's only Storage call. No error, no real bytes kept: the DB row update that follows
    // (recording_status/recording_path) is what the tests actually assert on.
    storage: {
      from(bucket: string) {
        return {
          upload(path: string, _body: unknown, _opts?: unknown) {
            return Promise.resolve({ data: { path }, error: null });
          },
          // TASK-F-T3: a minimal fake of `.storage.from(bucket).createSignedUrl()` -- the
          // voicemail playback path's only Storage call. No real signing; the returned URL just
          // encodes bucket/path/ttl so tests can assert the RIGHT file was signed.
          createSignedUrl(path: string, expiresIn: number) {
            return Promise.resolve({
              data: { signedUrl: `https://fake-storage.test/${bucket}/${path}?ttl=${expiresIn}` },
              error: null,
            });
          },
        };
      },
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

// ---------------------------------------------------------------------------
// Fake Telnyx HTTP surface -- stubs the REAL createTelnyxClient's fetch calls, same
// technique as telnyx-client.test.ts's stubFetch. No network, no mock server process.
// ---------------------------------------------------------------------------

interface FakeTelnyxCall {
  callControlId: string;
  to: string;
  body: Record<string, unknown>;
}

class FakeTelnyxServer {
  calls = new Map<string, FakeTelnyxCall>();
  conferenceCounter = 0;
  requests: { method: string; path: string; body: unknown }[] = [];
  /** B2 regression test hook: makes the NEXT conference join fail (simulating a dead/expired
   *  conference), then resets itself -- exactly one failure, not a permanent outage. */
  failNextConferenceJoin = false;
  /** TASK-F-T2: fake "recording download" URLs (an entirely different host than the Telnyx API
   *  itself) -- checked before any path-based Telnyx routing below, since these aren't
   *  `/v2/...` paths at all. */
  recordingFiles = new Map<string, Uint8Array>();
  recordingDownloadCount = 0;

  handle(url: string, init?: RequestInit): Response {
    if (this.recordingFiles.has(url)) {
      this.recordingDownloadCount++;
      return new Response(this.recordingFiles.get(url) as BodyInit);
    }
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    this.requests.push({ method, path, body });

    if (method === 'POST' && path === '/v2/calls') {
      const callControlId = `call-${this.calls.size + 1}`;
      this.calls.set(callControlId, { callControlId, to: String(body.to), body });
      return Response.json({ data: { call_control_id: callControlId } });
    }
    if (method === 'POST' && /\/v2\/calls\/[^/]+\/actions\/(hangup|speak)$/.test(path)) {
      return Response.json({ data: {} });
    }
    if (method === 'POST' && /\/v2\/calls\/[^/]+\/actions\/record_start$/.test(path)) {
      return Response.json({ data: {} });
    }
    if (method === 'POST' && /\/v2\/calls\/[^/]+\/actions\/playback_start$/.test(path)) {
      return Response.json({ data: {} });
    }
    if (method === 'POST' && path === '/v2/conferences') {
      this.conferenceCounter++;
      return Response.json({ data: { id: `conf-${this.conferenceCounter}`, name: body.name } });
    }
    if (method === 'POST' && /\/v2\/conferences\/[^/]+\/actions\/join$/.test(path)) {
      if (this.failNextConferenceJoin) {
        this.failNextConferenceJoin = false;
        return Response.json({ errors: [{ detail: 'conference not found' }] }, { status: 404 });
      }
      return Response.json({ data: {} });
    }
    if (method === 'POST' && /\/v2\/conferences\/[^/]+\/actions\/leave$/.test(path)) {
      return Response.json({ data: {} });
    }
    if (method === 'GET' && /\/v2\/telephony_credentials\/[^/]+$/.test(path)) {
      return Response.json({ data: { sip_username: 'agent-sip-user' } });
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
// Fixtures
// ---------------------------------------------------------------------------

function seedFixtures(db: FakeDb) {
  const orgId = 'org-1';
  const agentId = 'agent-1';
  const campaignId = 'campaign-1';
  const numberId = 'number-1';

  db.insert('orgs', { id: orgId, name: 'Fixture Org' });
  db.insert('org_telephony', {
    id: 'telephony-1',
    org_id: orgId,
    status: 'connected',
    call_control_app_id: 'cca-1',
    credential_connection_id: 'cred-conn-1',
  });
  db.insert('org_members', {
    id: 'member-1',
    org_id: orgId,
    user_id: agentId,
    telnyx_credential_id: 'cred-1',
  });
  db.insert('user_phone_numbers', { id: numberId, org_id: orgId, phone_number: '+15550001000' });
  db.insert('campaigns', {
    id: campaignId,
    org_id: orgId,
    name: 'Fixture Campaign',
    abandon_message_enabled: true,
    caller_id_number_id: numberId,
  });

  const contactIds = ['contact-1', 'contact-2', 'contact-3'];
  for (const [i, contactId] of contactIds.entries()) {
    db.insert('contacts', { id: contactId, phone_number: `+1555000100${i + 1}` });
    db.insert('campaign_leads', {
      id: `lead-${i + 1}`,
      campaign_id: campaignId,
      contact_id: contactId,
      status: 'queued',
      position: i + 1,
    });
  }

  return { orgId, agentId, campaignId };
}

function agentEvent(
  orgId: string,
  sessionId: string,
  legId: string,
  callControlId: string,
  eventType: 'call.answered' | 'call.hangup',
  extra: Record<string, unknown> = {}
): RawTelnyxEvent {
  return {
    orgId,
    eventId: crypto.randomUUID(),
    eventType,
    callControlId,
    payload: extra,
    clientState: {
      org: orgId,
      session: sessionId,
      leg: legId,
      kind: 'agent' as DialClientStateKind,
    },
  };
}

function contactEvent(
  orgId: string,
  sessionId: string,
  legId: string,
  callControlId: string,
  eventType: string,
  extra: Record<string, unknown> = {}
): RawTelnyxEvent {
  return {
    orgId,
    eventId: crypto.randomUUID(),
    eventType,
    callControlId,
    payload: extra,
    clientState: {
      org: orgId,
      session: sessionId,
      leg: legId,
      kind: 'contact' as DialClientStateKind,
    },
  };
}

function recordingEvent(
  orgId: string,
  sessionId: string,
  legId: string,
  eventType: 'call.recording.saved' | 'call.recording.error',
  payload: Record<string, unknown>
): RawTelnyxEvent {
  // Neither event's real payload carries call_control_id (recording-core.ts's header) --
  // callControlId here mirrors what telnyx-webhook/index.ts actually falls back to
  // (call_session_id), which never matches a real call_legs row, forcing the SAME
  // clientState.leg fallback path production traffic goes through.
  return {
    orgId,
    eventId: crypto.randomUUID(),
    eventType,
    callControlId: String(payload.call_session_id ?? ''),
    payload,
    clientState: {
      org: orgId,
      session: sessionId,
      leg: legId,
      kind: 'contact' as DialClientStateKind,
    },
  };
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

Deno.test(
  'dialer-engine end-to-end (fake Supabase + real TelnyxClient/stubbed fetch): Go Ready -> answered -> ready -> dialing -> winner joins conference -> agent lost (claimed leg untouched) -> reconnect -> rejoins the live call',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, agentId, campaignId } = seedFixtures(db);

    try {
      // --- Go Ready ------------------------------------------------------------------------
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 3,
        amdMode: 'off',
      });
      const sessionAfterStart = db.table('dial_sessions').get(sessionId)!;
      assertEquals(sessionAfterStart.state, 'ready_pending');

      const agentLeg1 = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
      assertExists(agentLeg1, 'agent leg row should exist after Go Ready');
      assertEquals(agentLeg1.state, 'initiated');
      assertEquals(sessionAfterStart.agent_leg_id, agentLeg1.id);
      // BUG-8 is contact-only: the agent leg dial must NOT carry time_limit_secs.
      const agentDial1 = server.calls.get(agentLeg1.call_control_id as string)!;
      assertEquals(agentDial1.body.time_limit_secs, undefined);
      assertEquals(agentDial1.to, 'sip:agent-sip-user@sip.telnyx.com');
      assertEquals(
        (agentDial1.body.custom_headers as { name: string }[])[0].name,
        'X-Hyperdial-Session'
      );
      // m5 (review): zero contacts dialed before the agent leg has even answered -- refillCount's
      // gate is genuinely closed, not just coincidentally 3==3 by the time we check later.
      assertEquals(
        [...db.table('call_legs').values()].filter((l) => l.kind === 'contact').length,
        0,
        'no contact should be dialed until the agent leg answers'
      );

      // --- Agent answers -> ready -> dialing (3 contacts dialed) ----------------------------
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg1.id as string,
          agentLeg1.call_control_id as string,
          'call.answered'
        )
      );
      const sessionAfterAgentAnswered = db.table('dial_sessions').get(sessionId)!;
      assertEquals(sessionAfterAgentAnswered.state, 'dialing');
      assertExists(
        sessionAfterAgentAnswered.conference_id,
        'conference should be created around the agent leg'
      );
      // Prove 'ready' was really reached, even though the engine cascades past it in the same
      // call (see this file's header) -- not just a guessed intermediate value.
      assertEquals(
        db.sessionTransitions.some((t) => t.from === 'ready_pending' && t.to === 'ready'),
        true
      );
      assertEquals(
        db.sessionTransitions.some((t) => t.from === 'ready' && t.to === 'dialing'),
        true
      );

      const contactLegs = [...db.table('call_legs').values()].filter((l) => l.kind === 'contact');
      assertEquals(contactLegs.length, 3, 'refillSession should have dialed all 3 fixture leads');
      for (const leg of contactLegs) {
        const dialed = server.calls.get(leg.call_control_id as string)!;
        // BUG-8: every CONTACT dial carries time_limit_secs 1800.
        assertEquals(dialed.body.time_limit_secs, 1800);
      }

      // --- One contact answers (amd off) -> claims the session -> winner joins conference --
      const winnerLeg = contactLegs[0];
      const loserLegs = contactLegs.slice(1);
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(
          orgId,
          sessionId,
          winnerLeg.id as string,
          winnerLeg.call_control_id as string,
          'call.answered'
        )
      );
      const sessionAfterWin = db.table('dial_sessions').get(sessionId)!;
      assertEquals(sessionAfterWin.state, 'on_call');
      assertEquals(sessionAfterWin.active_leg_id, winnerLeg.id);
      const winnerLegRow = db.table('call_legs').get(winnerLeg.id as string)!;
      assertEquals(winnerLegRow.state, 'claimed');
      assertEquals(winnerLegRow.outcome, 'connected');
      // The winner joins the conference the AGENT already created -- not a second, new one.
      const joinRequests = server.requests.filter((r) => /\/actions\/join$/.test(r.path));
      assertEquals(joinRequests.length >= 1, true);
      const conferenceCreateRequests = server.requests.filter((r) => r.path === '/v2/conferences');
      assertEquals(
        conferenceCreateRequests.length,
        1,
        'only ever ONE conference for the whole session'
      );
      // The two losing legs are moved to 'dropped' (never having answered) by handleWin
      // itself; `outcome` is only finalized once each leg's OWN call.hangup webhook lands
      // (hangupOutcome preserves the dropped/abandoned decision through to it -- dialer-
      // core.ts's own header) -- exactly what the real hangup command handleWin just issued
      // will eventually produce. Fire it here, same as dialer-sim.ts's own scenario did.
      for (const loser of loserLegs) {
        const loserRow = db.table('call_legs').get(loser.id as string)!;
        assertEquals(loserRow.state, 'dropped');
        assertEquals(loserRow.outcome, null);
        await processTelnyxDialerEvent(
          supabase,
          contactEvent(
            orgId,
            sessionId,
            loser.id as string,
            loser.call_control_id as string,
            'call.hangup',
            {
              hangup_cause: 'normal_clearing',
            }
          )
        );
        assertEquals(db.table('call_legs').get(loser.id as string)!.outcome, 'dropped');
      }
      // The agent's own leg was NOT touched by the loser-resolution loop (the real bug this
      // test caught: loserActions/loadActiveLegs predate the agent leg and are kind-agnostic
      // -- handleWin now filters to kind==='contact' before computing losers).
      assertEquals(db.table('call_legs').get(agentLeg1.id as string)!.state, 'answered');
      const agentHangupCommands = server.requests.filter(
        (r) => r.path === `/v2/calls/${agentLeg1.call_control_id}/actions/hangup`
      );
      assertEquals(
        agentHangupCommands.length,
        0,
        'the agent leg must never be hung up as a "loser"'
      );

      // --- Agent leg lost -> paused_agent_lost, claimed leg untouched -----------------------
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg1.id as string,
          agentLeg1.call_control_id as string,
          'call.hangup',
          { hangup_cause: 'normal_clearing' }
        )
      );
      const sessionAfterLost = db.table('dial_sessions').get(sessionId)!;
      assertEquals(sessionAfterLost.state, 'paused_agent_lost');
      assertEquals(db.table('call_legs').get(agentLeg1.id as string)!.state, 'ended');
      // The task's own explicit invariant: a live, bridged (claimed) contact is never hung up
      // for an agent-leg problem.
      const winnerAfterAgentLost = db.table('call_legs').get(winnerLeg.id as string)!;
      assertEquals(winnerAfterAgentLost.state, 'claimed');
      assertEquals(sessionAfterLost.active_leg_id, winnerLeg.id);
      const winnerHangupRequests = server.requests.filter(
        (r) => r.path === `/v2/calls/${winnerLeg.call_control_id}/actions/hangup`
      );
      assertEquals(winnerHangupRequests.length, 0, 'the claimed leg must never be hung up');

      // --- Reconnect: fresh agent leg into the SAME conference ------------------------------
      const reconnectResult = await reconnectAgentLeg(supabase, orgId, sessionId);
      assertEquals(reconnectResult.ok, true);
      const agentLeg2 = [...db.table('call_legs').values()].find(
        (l) => l.kind === 'agent' && l.id !== agentLeg1.id
      )!;
      assertExists(agentLeg2, 'a fresh agent leg should have been dialed for reconnect');
      assertEquals(agentLeg2.state, 'initiated');
      assertEquals(db.table('dial_sessions').get(sessionId)!.agent_leg_id, agentLeg2.id);
      // Still paused until the new leg actually answers.
      assertEquals(db.table('dial_sessions').get(sessionId)!.state, 'paused_agent_lost');

      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg2.id as string,
          agentLeg2.call_control_id as string,
          'call.answered'
        )
      );
      // 'ready' really was reached from paused_agent_lost, then cascaded to on_call because
      // the winner leg is STILL claimed/live -- rejoining the live call is the correct
      // behavior (see this file's header), not a literal stop at 'ready'.
      assertEquals(
        db.sessionTransitions.some((t) => t.from === 'paused_agent_lost' && t.to === 'ready'),
        true
      );
      const sessionAfterReconnect = db.table('dial_sessions').get(sessionId)!;
      assertEquals(sessionAfterReconnect.state, 'on_call');
      assertEquals(sessionAfterReconnect.active_leg_id, winnerLeg.id);
      // Joined the ORIGINAL conference again, never created a second one.
      const conferenceCreateRequestsAfterReconnect = server.requests.filter(
        (r) => r.path === '/v2/conferences'
      );
      assertEquals(conferenceCreateRequestsAfterReconnect.length, 1);
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'dialer-engine: reconnectAgentLeg is a no-op (ok:false) from any state other than paused_agent_lost',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 1,
        amdMode: 'off',
      });
      // Still ready_pending -- never answered.
      const result = await reconnectAgentLeg(supabase, orgId, sessionId);
      assertEquals(result, { ok: false, reason: 'not_paused_agent_lost' });
    } finally {
      restoreFetch();
    }
  }
);

// ---------------------------------------------------------------------------
// Review fix regression tests (stage 03 review, audit/L1/review-notes.md)
// ---------------------------------------------------------------------------

Deno.test(
  'dialer-engine review fix M2: a stale agent leg (no longer dial_sessions.agent_leg_id) has its events ignored even while still non-terminal',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 1,
        amdMode: 'off',
      });
      const currentAgentLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;

      // A second, stale agent leg that is NOT the session's current agent_leg_id, deliberately
      // still non-terminal -- the scenario this guard exists for (an out-of-order/duplicate
      // webhook for a superseded leg) can't be reached through the public API anymore once
      // reconnectAgentLeg also refuses to double-dial (M2's other half), so this constructs it
      // directly to test the guard itself.
      const staleLeg = db.insert('call_legs', {
        org_id: orgId,
        session_id: sessionId,
        campaign_id: campaignId,
        kind: 'agent',
        call_control_id: 'call-stale-1',
        state: 'initiated',
      });

      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          staleLeg.id as string,
          staleLeg.call_control_id as string,
          'call.answered'
        )
      );

      assertEquals(
        db.table('dial_sessions').get(sessionId)!.state,
        'ready_pending',
        'a stale leg answering must not cascade the session anywhere'
      );
      assertEquals(
        db.table('call_legs').get(staleLeg.id as string)!.state,
        'initiated',
        'the stale leg itself must be untouched'
      );
      assertEquals(db.table('call_legs').get(currentAgentLeg.id as string)!.state, 'initiated');
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'dialer-engine review fix M3: agent-lost speaks the abandon message to an already-answered contact and leaves an already-abandoned leg alone',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 3,
        amdMode: 'premium', // amd on: call.answered alone does NOT claim -- lands at amd_pending.
      });
      const agentLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg.id as string,
          agentLeg.call_control_id as string,
          'call.answered'
        )
      );

      const contactLegs = [...db.table('call_legs').values()].filter((l) => l.kind === 'contact');
      assertEquals(contactLegs.length, 3);
      const [ringingLeg, answeredLeg, alreadyAbandonedLeg] = contactLegs;

      await processTelnyxDialerEvent(
        supabase,
        contactEvent(
          orgId,
          sessionId,
          answeredLeg.id as string,
          answeredLeg.call_control_id as string,
          'call.answered'
        )
      );
      assertEquals(db.table('call_legs').get(answeredLeg.id as string)!.state, 'amd_pending');

      // Simulate an EARLIER, independent resolution to 'abandoned' (e.g. a different contact
      // had already won before the agent dropped) -- the point of this leg is to prove
      // agent-lost does not re-touch it mid-message.
      db.table('call_legs').get(alreadyAbandonedLeg.id as string)!.state = 'abandoned';

      server.requests.length = 0; // only care about what THIS agent-lost event itself issues

      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg.id as string,
          agentLeg.call_control_id as string,
          'call.hangup',
          {
            hangup_cause: 'normal_clearing',
          }
        )
      );

      assertEquals(db.table('dial_sessions').get(sessionId)!.state, 'paused_agent_lost');

      // Still-ringing leg: bare hangup, no speak.
      assertEquals(db.table('call_legs').get(ringingLeg.id as string)!.state, 'dropped');
      assertEquals(
        server.requests.filter(
          (r) => r.path === `/v2/calls/${ringingLeg.call_control_id}/actions/hangup`
        ).length,
        1
      );
      assertEquals(
        server.requests.some(
          (r) => r.path === `/v2/calls/${ringingLeg.call_control_id}/actions/speak`
        ),
        false
      );

      // Already-answered leg (M3): speak_then_hangup -- the abandon message, not a silent
      // hangup. No hangup command YET (that only fires after call.speak.ended, same as
      // handleWin's own pattern).
      assertEquals(db.table('call_legs').get(answeredLeg.id as string)!.state, 'abandoned');
      assertEquals(
        server.requests.filter(
          (r) => r.path === `/v2/calls/${answeredLeg.call_control_id}/actions/speak`
        ).length,
        1,
        'an already-answered contact must hear the abandon message, not a silent hangup'
      );
      assertEquals(
        server.requests.some(
          (r) => r.path === `/v2/calls/${answeredLeg.call_control_id}/actions/hangup`
        ),
        false,
        'no hangup yet -- only after call.speak.ended'
      );

      // Already-abandoned leg: completely untouched -- no new command of any kind, state
      // unchanged (never cut off mid-message).
      assertEquals(db.table('call_legs').get(alreadyAbandonedLeg.id as string)!.state, 'abandoned');
      assertEquals(
        server.requests.some((r) => r.path.includes(String(alreadyAbandonedLeg.call_control_id))),
        false,
        'an already-abandoned leg must never be touched again'
      );
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'dialer-engine review fix B2: a failed join against a dead conference creates a fresh one instead of silently proceeding',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 1,
        amdMode: 'off',
      });
      const agentLeg1 = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg1.id as string,
          agentLeg1.call_control_id as string,
          'call.answered'
        )
      );
      const firstConferenceId = db.table('dial_sessions').get(sessionId)!.conference_id as string;
      assertExists(firstConferenceId);

      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg1.id as string,
          agentLeg1.call_control_id as string,
          'call.hangup',
          {
            hangup_cause: 'normal_clearing',
          }
        )
      );
      const reconnectResult = await reconnectAgentLeg(supabase, orgId, sessionId);
      assertEquals(reconnectResult.ok, true);
      const agentLeg2 = [...db.table('call_legs').values()].find(
        (l) => l.kind === 'agent' && l.id !== agentLeg1.id
      )!;

      // The upcoming join against the (now presumably dead) existing conference fails.
      server.failNextConferenceJoin = true;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg2.id as string,
          agentLeg2.call_control_id as string,
          'call.answered'
        )
      );

      const sessionAfter = db.table('dial_sessions').get(sessionId)!;
      assertEquals(
        sessionAfter.state,
        'dialing',
        'still recovers to dialing, but only via a CONFIRMED fresh conference'
      );
      assertExists(sessionAfter.conference_id);
      assertEquals(
        sessionAfter.conference_id !== firstConferenceId,
        true,
        'the fresh conference must be a NEW id, not the dead one'
      );
      const createConferenceRequests = server.requests.filter((r) => r.path === '/v2/conferences');
      assertEquals(
        createConferenceRequests.length,
        2,
        'Go Readys own conference, plus exactly one fallback create after the failed join'
      );
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'dialer-engine re-review fix M4: paused_agent_lost_from actually persists through the real transition_session field list, so Reconnect from a manual pause returns to paused',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 3,
        amdMode: 'off',
      });
      const agentLeg1 = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg1.id as string,
          agentLeg1.call_control_id as string,
          'call.answered'
        )
      );
      assertEquals(db.table('dial_sessions').get(sessionId)!.state, 'dialing');

      const paused = await pauseSession(supabase, orgId, sessionId);
      assertEquals(paused, true);
      assertEquals(db.table('dial_sessions').get(sessionId)!.state, 'paused');

      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg1.id as string,
          agentLeg1.call_control_id as string,
          'call.hangup',
          { hangup_cause: 'normal_clearing' }
        )
      );
      const sessionAfterLost = db.table('dial_sessions').get(sessionId)!;
      assertEquals(sessionAfterLost.state, 'paused_agent_lost');
      // The bug: before the migration + fake fix, this was always silently dropped (null).
      assertEquals(
        sessionAfterLost.paused_agent_lost_from,
        'paused',
        'the pre-loss state must actually be persisted, not silently dropped'
      );

      const reconnectResult = await reconnectAgentLeg(supabase, orgId, sessionId);
      assertEquals(reconnectResult.ok, true);
      const agentLeg2 = [...db.table('call_legs').values()].find(
        (l) => l.kind === 'agent' && l.id !== agentLeg1.id
      )!;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg2.id as string,
          agentLeg2.call_control_id as string,
          'call.answered'
        )
      );

      // Without the fix this resumes dialing (overriding the intern's own Pause) -- the exact
      // regression the re-reviewer flagged as "not effective in prod".
      assertEquals(
        db.table('dial_sessions').get(sessionId)!.state,
        'paused',
        'Reconnect must restore the manual pause, not silently resume dialing'
      );
      assertEquals(db.table('dial_sessions').get(sessionId)!.paused_agent_lost_from, null);
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'dialer-engine re-review fix (minor): a failed conference join with a live claimed contact does NOT fork a second conference',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 1,
        amdMode: 'off',
      });
      const agentLeg1 = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg1.id as string,
          agentLeg1.call_control_id as string,
          'call.answered'
        )
      );
      const contactLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'contact')!;
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(
          orgId,
          sessionId,
          contactLeg.id as string,
          contactLeg.call_control_id as string,
          'call.answered'
        )
      );
      const sessionOnCall = db.table('dial_sessions').get(sessionId)!;
      assertEquals(sessionOnCall.state, 'on_call');
      assertEquals(sessionOnCall.active_leg_id, contactLeg.id);
      const firstConferenceId = sessionOnCall.conference_id as string;
      assertExists(firstConferenceId);

      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg1.id as string,
          agentLeg1.call_control_id as string,
          'call.hangup',
          { hangup_cause: 'normal_clearing' }
        )
      );
      assertEquals(db.table('dial_sessions').get(sessionId)!.state, 'paused_agent_lost');
      // The task's own explicit invariant, unaffected by this fix: the live claimed contact
      // is never touched by an agent-leg problem.
      assertEquals(db.table('call_legs').get(contactLeg.id as string)!.state, 'claimed');

      const reconnectResult = await reconnectAgentLeg(supabase, orgId, sessionId);
      assertEquals(reconnectResult.ok, true);
      const agentLeg2 = [...db.table('call_legs').values()].find(
        (l) => l.kind === 'agent' && l.id !== agentLeg1.id
      )!;

      server.requests.length = 0;
      server.failNextConferenceJoin = true;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg2.id as string,
          agentLeg2.call_control_id as string,
          'call.answered'
        )
      );

      const sessionAfter = db.table('dial_sessions').get(sessionId)!;
      assertEquals(
        sessionAfter.state,
        'paused_agent_lost',
        'must NOT cascade past paused_agent_lost -- there is nothing confirmed to cascade into'
      );
      assertEquals(
        sessionAfter.conference_id,
        firstConferenceId,
        'must not fork a second conference while the customer is still live in the first'
      );
      assertEquals(
        server.requests.some((r) => r.path === '/v2/conferences'),
        false,
        'no fallback conference create when a claimed contact is still live'
      );
      // hangupLeg only issues the Telnyx command (the leg's own row only flips to 'ended' once
      // a real call.hangup webhook comes back, which this test doesn't need to simulate) --
      // assert the command was actually sent, same technique as the existing B2 test's own
      // hangup-command assertions elsewhere in this file.
      assertEquals(
        server.requests.some(
          (r) => r.path === `/v2/calls/${agentLeg2.call_control_id}/actions/hangup`
        ),
        true,
        'the reconnecting agent leg that could not confirm a conference must be hung up'
      );
      assertEquals(
        db.table('call_legs').get(contactLeg.id as string)!.state,
        'claimed',
        'the live claimed contact must still be untouched after the aborted reconnect'
      );
    } finally {
      restoreFetch();
    }
  }
);

// ---------------------------------------------------------------------------
// TASK-M1: call_legs.duration_seconds was never written (the RPC supported it,
// dialer-engine.ts never passed it) -- Talk Time always showed 0m and "Conversations / hr"
// needs a real duration to know which connected legs count as a conversation (>= 30s).
// ---------------------------------------------------------------------------

Deno.test(
  "TASK-M1: a connected leg's own call.hangup writes duration_seconds from bridged_at, and stays null for a losing leg",
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 3,
        amdMode: 'off',
      });
      const agentLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg.id as string,
          agentLeg.call_control_id as string,
          'call.answered'
        )
      );
      const contactLegs = [...db.table('call_legs').values()].filter((l) => l.kind === 'contact');
      const winnerLeg = contactLegs[0];
      const loserLeg = contactLegs[1];

      await processTelnyxDialerEvent(
        supabase,
        contactEvent(
          orgId,
          sessionId,
          winnerLeg.id as string,
          winnerLeg.call_control_id as string,
          'call.answered'
        )
      );
      const winnerRowAfterWin = db.table('call_legs').get(winnerLeg.id as string)!;
      assertEquals(winnerRowAfterWin.state, 'claimed');
      assertExists(
        winnerRowAfterWin.bridged_at,
        'handleWin must stamp bridged_at on a successful join'
      );

      // Backdate the bridge so the test doesn't need to actually wait -- same technique the
      // rest of this file uses (fixed fixtures, not real elapsed time) to make the assertion a
      // real positive control instead of "duration_seconds is truthy".
      const bridgedAt = new Date(Date.now() - 90_000);
      winnerRowAfterWin.bridged_at = bridgedAt.toISOString();

      await processTelnyxDialerEvent(
        supabase,
        contactEvent(
          orgId,
          sessionId,
          winnerLeg.id as string,
          winnerLeg.call_control_id as string,
          'call.hangup',
          { hangup_cause: 'normal_clearing' }
        )
      );
      const winnerRowAfterHangup = db.table('call_legs').get(winnerLeg.id as string)!;
      assertEquals(winnerRowAfterHangup.state, 'ended');
      assertEquals(winnerRowAfterHangup.outcome, 'connected');
      const duration = winnerRowAfterHangup.duration_seconds as number;
      assertEquals(duration >= 89 && duration <= 92, true, `expected ~90s, got ${duration}`);

      // The loser (dropped, never bridged, never answered) gets a normal hangup too -- its
      // outcome becomes 'dropped', not 'connected', so duration_seconds is never computed at
      // all (negative control for the `result.outcome === 'connected'` gate above).
      const loserRow = db.table('call_legs').get(loserLeg.id as string)!;
      assertEquals(loserRow.state, 'dropped');
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(
          orgId,
          sessionId,
          loserLeg.id as string,
          loserLeg.call_control_id as string,
          'call.hangup',
          { hangup_cause: 'normal_clearing' }
        )
      );
      const loserRowAfterHangup = db.table('call_legs').get(loserLeg.id as string)!;
      assertEquals(loserRowAfterHangup.outcome, 'dropped');
      assertEquals(
        loserRowAfterHangup.duration_seconds ?? null,
        null,
        'a leg that was never bridged/connected must never get a duration_seconds'
      );
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-M1: redelivering the same call.hangup webhook is a no-op -- duration_seconds is not recomputed',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 1,
        amdMode: 'off',
      });
      const agentLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg.id as string,
          agentLeg.call_control_id as string,
          'call.answered'
        )
      );
      const contactLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'contact')!;
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(
          orgId,
          sessionId,
          contactLeg.id as string,
          contactLeg.call_control_id as string,
          'call.answered'
        )
      );
      db.table('call_legs').get(contactLeg.id as string)!.bridged_at = new Date(
        Date.now() - 45_000
      ).toISOString();

      const hangupEvent = contactEvent(
        orgId,
        sessionId,
        contactLeg.id as string,
        contactLeg.call_control_id as string,
        'call.hangup',
        { hangup_cause: 'normal_clearing' }
      );
      await processTelnyxDialerEvent(supabase, hangupEvent);
      const durationAfterFirst = db.table('call_legs').get(contactLeg.id as string)!
        .duration_seconds as number;
      assertEquals(durationAfterFirst >= 44 && durationAfterFirst <= 47, true);

      // A second call.hangup for the same leg, deliberately with a FRESH event id -- so this
      // exercises the state-CAS idempotency (legTransition('ended', call.hangup) returns null,
      // dialer-core.ts: "if (current === 'ended') return null"), not just record_webhook_event's
      // own event-id dedup, which is the deeper guarantee that also covers an out-of-order
      // duplicate Telnyx delivery carrying a different event id for the same underlying hangup.
      await processTelnyxDialerEvent(supabase, { ...hangupEvent, eventId: crypto.randomUUID() });
      const durationAfterRetry = db.table('call_legs').get(contactLeg.id as string)!
        .duration_seconds as number;
      assertEquals(
        durationAfterRetry,
        durationAfterFirst,
        'a redelivered hangup must not recompute duration_seconds'
      );
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-M1: a failed conference join leaves bridged_at null -- duration_seconds falls back to claimed_at (the winner never gets its own answered_at written)',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 1,
        amdMode: 'off',
      });
      const agentLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg.id as string,
          agentLeg.call_control_id as string,
          'call.answered'
        )
      );
      const contactLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'contact')!;

      server.failNextConferenceJoin = true;
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(
          orgId,
          sessionId,
          contactLeg.id as string,
          contactLeg.call_control_id as string,
          'call.answered'
        )
      );
      const winnerRow = db.table('call_legs').get(contactLeg.id as string)!;
      assertEquals(winnerRow.state, 'claimed');
      assertEquals(winnerRow.outcome, 'connected');
      assertEquals(
        winnerRow.bridged_at ?? null,
        null,
        'a leg whose conference join threw must never get a bridged_at it does not deserve'
      );
      // The winner's own call.answered is handled by processContactLegEvent's claim-win branch
      // directly, never by applyLegTransition -- so answered_at is never written for it.
      // claim_leg's own claimed_at is the winner's real equivalent, and this is exactly why the
      // fallback chain is bridged_at ?? answered_at ?? claimed_at, not just the first two.
      assertEquals(winnerRow.answered_at ?? null, null);
      assertExists(winnerRow.claimed_at, 'claim_leg must still have stamped claimed_at');

      winnerRow.claimed_at = new Date(Date.now() - 60_000).toISOString();
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(
          orgId,
          sessionId,
          contactLeg.id as string,
          contactLeg.call_control_id as string,
          'call.hangup',
          { hangup_cause: 'normal_clearing' }
        )
      );
      const winnerRowAfterHangup = db.table('call_legs').get(contactLeg.id as string)!;
      assertEquals(winnerRowAfterHangup.bridged_at ?? null, null);
      const duration = winnerRowAfterHangup.duration_seconds as number;
      assertEquals(
        duration >= 59 && duration <= 62,
        true,
        `expected ~60s from claimed_at fallback, got ${duration}`
      );
    } finally {
      restoreFetch();
    }
  }
);

// ---------------------------------------------------------------------------
// TASK-F-T2: recording (REC-1/REC-2/REC-3) -- record_start on the winner only, gated on
// org_recording_settings, and the call.recording.saved/error webhook updating call_legs.
// ---------------------------------------------------------------------------

Deno.test(
  'REC-1: handleWin starts recording (dual/mp3 + client_state) on the winning leg only, when enabled',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 3,
        amdMode: 'off',
      });
      const agentLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
      await processTelnyxDialerEvent(
        supabase,
        agentEvent(
          orgId,
          sessionId,
          agentLeg.id as string,
          agentLeg.call_control_id as string,
          'call.answered'
        )
      );
      const contactLegs = [...db.table('call_legs').values()].filter((l) => l.kind === 'contact');
      const winnerLeg = contactLegs[0];
      const loserLeg = contactLegs[1];

      await processTelnyxDialerEvent(
        supabase,
        contactEvent(
          orgId,
          sessionId,
          winnerLeg.id as string,
          winnerLeg.call_control_id as string,
          'call.answered'
        )
      );

      const recordStartReq = server.requests.find(
        (r) =>
          r.method === 'POST' &&
          r.path === `/v2/calls/${winnerLeg.call_control_id}/actions/record_start`
      );
      assertExists(recordStartReq, 'record_start must be called for the winning leg');
      const body = recordStartReq!.body as Record<string, unknown>;
      assertEquals(body.format, 'mp3');
      assertEquals(body.channels, 'dual');
      const decoded = JSON.parse(atob(String(body.client_state)));
      assertEquals(decoded, { org: orgId, session: sessionId, leg: winnerLeg.id, kind: 'contact' });

      const winnerRow = db.table('call_legs').get(winnerLeg.id as string)!;
      assertEquals(winnerRow.recording_status, 'recording');

      const loserRecordStartReq = server.requests.find(
        (r) =>
          r.method === 'POST' &&
          r.path === `/v2/calls/${loserLeg.call_control_id}/actions/record_start`
      );
      assertEquals(loserRecordStartReq, undefined, 'a losing leg must never be recorded');
    } finally {
      restoreFetch();
    }
  }
);

Deno.test('REC-1: recording_enabled=false on the org skips record_start entirely', async () => {
  const db = new FakeDb();
  const server = new FakeTelnyxServer();
  const restoreFetch = stubTelnyxFetch(server);
  const supabase = createFakeSupabase(db);
  const { orgId, campaignId, agentId } = seedFixtures(db);
  db.insert('org_recording_settings', { id: orgId, org_id: orgId, recording_enabled: false });
  try {
    const { sessionId } = await startSession(supabase, {
      orgId,
      campaignId,
      agentId,
      lines: 3,
      amdMode: 'off',
    });
    const agentLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
    await processTelnyxDialerEvent(
      supabase,
      agentEvent(
        orgId,
        sessionId,
        agentLeg.id as string,
        agentLeg.call_control_id as string,
        'call.answered'
      )
    );
    const winnerLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'contact')!;
    await processTelnyxDialerEvent(
      supabase,
      contactEvent(
        orgId,
        sessionId,
        winnerLeg.id as string,
        winnerLeg.call_control_id as string,
        'call.answered'
      )
    );

    const recordStartReq = server.requests.find((r) => r.path.endsWith('/actions/record_start'));
    assertEquals(
      recordStartReq,
      undefined,
      'recording_enabled=false must skip record_start entirely'
    );
    const winnerRow = db.table('call_legs').get(winnerLeg.id as string)!;
    assertEquals(winnerRow.recording_status ?? null, null);
  } finally {
    restoreFetch();
  }
});

Deno.test(
  'REC-2/REC-3: call.recording.saved downloads the mp3, uploads it, and stores path/duration/status',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const orgId = 'org-1';
    const sessionId = 'session-1';
    const legId = 'leg-1';
    db.insert('call_legs', {
      id: legId,
      org_id: orgId,
      session_id: sessionId,
      campaign_id: 'campaign-1',
      kind: 'contact',
      call_control_id: 'call-winner-1',
      state: 'claimed',
    });
    const mp3Url = 'https://fake-recordings.example.com/rec-1.mp3';
    server.recordingFiles.set(mp3Url, new Uint8Array([1, 2, 3, 4]));
    try {
      await processTelnyxDialerEvent(
        supabase,
        recordingEvent(orgId, sessionId, legId, 'call.recording.saved', {
          call_session_id: 'sess-abc',
          call_leg_id: 'telnyx-leg-uuid-1',
          recording_started_at: '2026-01-01T00:00:00.000Z',
          recording_ended_at: '2026-01-01T00:01:30.000Z',
          recording_urls: { mp3: mp3Url, wav: null },
        })
      );
      const row = db.table('call_legs').get(legId)!;
      assertEquals(row.recording_status, 'saved');
      assertEquals(row.recording_path, `${orgId}/${legId}.mp3`);
      assertEquals(row.recording_duration_seconds, 90);
      assertEquals(row.recording_telnyx_call_leg_id, 'telnyx-leg-uuid-1');
      assertExists(row.recording_saved_at);
    } finally {
      restoreFetch();
    }
  }
);

Deno.test('REC-2: call.recording.error marks the leg recording_failed, never throws', async () => {
  const db = new FakeDb();
  const server = new FakeTelnyxServer();
  const restoreFetch = stubTelnyxFetch(server);
  const supabase = createFakeSupabase(db);
  const orgId = 'org-1';
  const legId = 'leg-1';
  db.insert('call_legs', {
    id: legId,
    org_id: orgId,
    session_id: 'session-1',
    campaign_id: 'campaign-1',
    kind: 'contact',
    call_control_id: 'call-winner-1',
    state: 'claimed',
  });
  try {
    await processTelnyxDialerEvent(
      supabase,
      recordingEvent(orgId, 'session-1', legId, 'call.recording.error', {
        call_session_id: 'sess-abc',
        reason: 'invalid-recording-config',
      })
    );
    const row = db.table('call_legs').get(legId)!;
    assertEquals(row.recording_status, 'recording_failed');
  } finally {
    restoreFetch();
  }
});

Deno.test(
  'call.recording.saved is deduped on redelivery, same as every other webhook event',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const orgId = 'org-1';
    const legId = 'leg-1';
    db.insert('call_legs', {
      id: legId,
      org_id: orgId,
      session_id: 'session-1',
      campaign_id: 'campaign-1',
      kind: 'contact',
      call_control_id: 'call-winner-1',
      state: 'claimed',
    });
    const mp3Url = 'https://fake-recordings.example.com/rec-2.mp3';
    server.recordingFiles.set(mp3Url, new Uint8Array([9, 9, 9]));
    try {
      const event = recordingEvent(orgId, 'session-1', legId, 'call.recording.saved', {
        call_session_id: 'sess-abc',
        recording_started_at: '2026-01-01T00:00:00.000Z',
        recording_ended_at: '2026-01-01T00:00:10.000Z',
        recording_urls: { mp3: mp3Url },
      });
      await processTelnyxDialerEvent(supabase, event);
      assertEquals(server.recordingDownloadCount, 1);
      // Redeliver the EXACT same event (same eventId) -- record_webhook_event's existing dedupe
      // must skip it before processRecordingEvent ever runs a second download.
      await processTelnyxDialerEvent(supabase, event);
      assertEquals(server.recordingDownloadCount, 1, 'a redelivered eventId must not re-download');
    } finally {
      restoreFetch();
    }
  }
);

// ---------------------------------------------------------------------------
// TASK-F-T3 (VMD-1..5, BUG-7): voicemail drop + real AMD modes.
// ---------------------------------------------------------------------------

/** Bootstraps a session (given amdMode) through Go Ready -> dialing, and returns the FIRST
 *  contact leg dialed (the machine-detection candidate every test below drives itself). Mirrors
 *  the REC-1 tests' own bootstrap sequence exactly. */
async function bootstrapToMachineCandidate(
  db: FakeDb,
  supabase: ReturnType<typeof createFakeSupabase>,
  args: { orgId: string; campaignId: string; agentId: string; amdMode: string }
): Promise<{ sessionId: string; legId: string; callControlId: string }> {
  const { sessionId } = await startSession(supabase, {
    orgId: args.orgId,
    campaignId: args.campaignId,
    agentId: args.agentId,
    lines: 3,
    // deno-lint-ignore no-explicit-any
    amdMode: args.amdMode as any,
  });
  const agentLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'agent')!;
  await processTelnyxDialerEvent(
    supabase,
    agentEvent(
      args.orgId,
      sessionId,
      agentLeg.id as string,
      agentLeg.call_control_id as string,
      'call.answered'
    )
  );
  const leg = [...db.table('call_legs').values()].find((l) => l.kind === 'contact')!;
  return { sessionId, legId: leg.id as string, callControlId: leg.call_control_id as string };
}

Deno.test(
  'VMD-2/VMD-3: machine detected under detect_words -> armed, greeting-ended plays the drop, playback-ended hangs up -> voicemail_left',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    db.table('campaigns').get(campaignId)!.voicemail_drop_mode = 'first_attempt';
    db.insert('voicemail_drop_settings', {
      id: 'vd-org-default',
      org_id: orgId,
      user_id: null,
      storage_path: `${orgId}/org-default.mp3`,
    });
    try {
      const { sessionId, legId, callControlId } = await bootstrapToMachineCandidate(db, supabase, {
        orgId,
        campaignId,
        agentId,
        amdMode: 'detect_words',
      });

      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, legId, callControlId, 'call.answered')
      );
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, legId, callControlId, 'call.machine.detection.ended', {
          result: 'machine',
        })
      );

      let legRow = db.table('call_legs').get(legId)!;
      assertEquals(legRow.state, 'machine');
      assertEquals(legRow.voicemail_drop_path, `${orgId}/org-default.mp3`);
      assertEquals(
        server.requests.some((r) => r.path === `/v2/calls/${callControlId}/actions/hangup`),
        false,
        'must NOT hang up yet -- waiting for the greeting to end'
      );

      // Real call.machine.greeting.ended carries no call_control_id -- route through the
      // client_state.leg fallback, same technique as recordingEvent.
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, legId, '', 'call.machine.greeting.ended')
      );

      legRow = db.table('call_legs').get(legId)!;
      assertEquals(legRow.state, 'voicemail_dropping');
      const playbackReq = server.requests.find(
        (r) => r.method === 'POST' && r.path === `/v2/calls/${callControlId}/actions/playback_start`
      );
      assertExists(playbackReq, 'playback_start must be called once the greeting ends');
      const playbackBody = playbackReq!.body as Record<string, unknown>;
      assertEquals(
        playbackBody.audio_url,
        `https://fake-storage.test/voicemail-drops/${orgId}/org-default.mp3?ttl=900`
      );
      assertEquals(playbackBody.audio_type, 'mp3');
      const decoded = JSON.parse(atob(String(playbackBody.client_state)));
      assertEquals(decoded, { org: orgId, session: sessionId, leg: legId, kind: 'contact' });

      // call.playback.ended's real payload DOES carry call_control_id -- no fallback needed.
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, legId, callControlId, 'call.playback.ended')
      );
      const hangupReq = server.requests.find(
        (r) => r.method === 'POST' && r.path === `/v2/calls/${callControlId}/actions/hangup`
      );
      assertExists(hangupReq, 'the drop finished -- the engine must hang up now');

      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, legId, callControlId, 'call.hangup', {
          hangup_cause: 'normal_clearing',
        })
      );
      legRow = db.table('call_legs').get(legId)!;
      assertEquals(legRow.state, 'ended');
      assertEquals(legRow.outcome, 'voicemail_left');
    } finally {
      restoreFetch();
    }
  }
);

Deno.test('VMD-4: voicemail_drop_mode=never -> plain hangup, no drop armed', async () => {
  const db = new FakeDb();
  const server = new FakeTelnyxServer();
  const restoreFetch = stubTelnyxFetch(server);
  const supabase = createFakeSupabase(db);
  const { orgId, campaignId, agentId } = seedFixtures(db);
  db.table('campaigns').get(campaignId)!.voicemail_drop_mode = 'never';
  db.insert('voicemail_drop_settings', {
    id: 'vd-org-default',
    org_id: orgId,
    user_id: null,
    storage_path: `${orgId}/org-default.mp3`,
  });
  try {
    const { sessionId, legId, callControlId } = await bootstrapToMachineCandidate(db, supabase, {
      orgId,
      campaignId,
      agentId,
      amdMode: 'premium',
    });
    await processTelnyxDialerEvent(
      supabase,
      contactEvent(orgId, sessionId, legId, callControlId, 'call.answered')
    );
    await processTelnyxDialerEvent(
      supabase,
      contactEvent(orgId, sessionId, legId, callControlId, 'call.machine.premium.detection.ended', {
        result: 'machine',
      })
    );

    const legRow = db.table('call_legs').get(legId)!;
    assertEquals(legRow.voicemail_drop_path ?? null, null, 'never mode must never arm a drop');
    const hangupReq = server.requests.find(
      (r) => r.method === 'POST' && r.path === `/v2/calls/${callControlId}/actions/hangup`
    );
    assertExists(hangupReq, 'must hang up immediately, exactly like before this task');
  } finally {
    restoreFetch();
  }
});

Deno.test('VMD-4: first_attempt mode does not drop on a second attempt (attempts=1)', async () => {
  const db = new FakeDb();
  const server = new FakeTelnyxServer();
  const restoreFetch = stubTelnyxFetch(server);
  const supabase = createFakeSupabase(db);
  const { orgId, campaignId, agentId } = seedFixtures(db);
  db.table('campaigns').get(campaignId)!.voicemail_drop_mode = 'first_attempt';
  db.insert('voicemail_drop_settings', {
    id: 'vd-org-default',
    org_id: orgId,
    user_id: null,
    storage_path: `${orgId}/org-default.mp3`,
  });
  try {
    const { sessionId, legId, callControlId } = await bootstrapToMachineCandidate(db, supabase, {
      orgId,
      campaignId,
      agentId,
      amdMode: 'detect_words',
    });
    const leg = db.table('call_legs').get(legId)!;
    db.table('campaign_leads').get(leg.lead_id as string)!.attempts = 1;

    await processTelnyxDialerEvent(
      supabase,
      contactEvent(orgId, sessionId, legId, callControlId, 'call.answered')
    );
    await processTelnyxDialerEvent(
      supabase,
      contactEvent(orgId, sessionId, legId, callControlId, 'call.machine.detection.ended', {
        result: 'machine',
      })
    );

    const legRow = db.table('call_legs').get(legId)!;
    assertEquals(legRow.voicemail_drop_path ?? null, null);
    const hangupReq = server.requests.find(
      (r) => r.method === 'POST' && r.path === `/v2/calls/${callControlId}/actions/hangup`
    );
    assertExists(hangupReq);
  } finally {
    restoreFetch();
  }
});

Deno.test('VMD-4: no drop file configured anywhere -> plain hangup', async () => {
  const db = new FakeDb();
  const server = new FakeTelnyxServer();
  const restoreFetch = stubTelnyxFetch(server);
  const supabase = createFakeSupabase(db);
  const { orgId, campaignId, agentId } = seedFixtures(db);
  db.table('campaigns').get(campaignId)!.voicemail_drop_mode = 'every_attempt';
  // Deliberately no voicemail_drop_settings row at all.
  try {
    const { sessionId, legId, callControlId } = await bootstrapToMachineCandidate(db, supabase, {
      orgId,
      campaignId,
      agentId,
      amdMode: 'detect_words',
    });
    await processTelnyxDialerEvent(
      supabase,
      contactEvent(orgId, sessionId, legId, callControlId, 'call.answered')
    );
    await processTelnyxDialerEvent(
      supabase,
      contactEvent(orgId, sessionId, legId, callControlId, 'call.machine.detection.ended', {
        result: 'machine',
      })
    );

    const legRow = db.table('call_legs').get(legId)!;
    assertEquals(legRow.voicemail_drop_path ?? null, null);
    const hangupReq = server.requests.find(
      (r) => r.method === 'POST' && r.path === `/v2/calls/${callControlId}/actions/hangup`
    );
    assertExists(hangupReq);
  } finally {
    restoreFetch();
  }
});

Deno.test('VMD-4: a per-user drop file takes priority over the org default', async () => {
  const db = new FakeDb();
  const server = new FakeTelnyxServer();
  const restoreFetch = stubTelnyxFetch(server);
  const supabase = createFakeSupabase(db);
  const { orgId, campaignId, agentId } = seedFixtures(db);
  db.table('campaigns').get(campaignId)!.voicemail_drop_mode = 'every_attempt';
  db.insert('voicemail_drop_settings', {
    id: 'vd-org-default',
    org_id: orgId,
    user_id: null,
    storage_path: `${orgId}/org-default.mp3`,
  });
  db.insert('voicemail_drop_settings', {
    id: 'vd-agent',
    org_id: orgId,
    user_id: agentId,
    storage_path: `${orgId}/${agentId}.wav`,
  });
  try {
    const { sessionId, legId, callControlId } = await bootstrapToMachineCandidate(db, supabase, {
      orgId,
      campaignId,
      agentId,
      amdMode: 'detect_words',
    });
    await processTelnyxDialerEvent(
      supabase,
      contactEvent(orgId, sessionId, legId, callControlId, 'call.answered')
    );
    await processTelnyxDialerEvent(
      supabase,
      contactEvent(orgId, sessionId, legId, callControlId, 'call.machine.detection.ended', {
        result: 'machine',
      })
    );
    const legRow = db.table('call_legs').get(legId)!;
    assertEquals(legRow.voicemail_drop_path, `${orgId}/${agentId}.wav`);
  } finally {
    restoreFetch();
  }
});

Deno.test(
  "BUG-7 vendor constraint: plain 'detect' mode never gets a greeting signal -- machine leg hangs up immediately even when a drop file exists",
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    db.table('campaigns').get(campaignId)!.voicemail_drop_mode = 'every_attempt';
    db.insert('voicemail_drop_settings', {
      id: 'vd-org-default',
      org_id: orgId,
      user_id: null,
      storage_path: `${orgId}/org-default.mp3`,
    });
    try {
      const { sessionId, legId, callControlId } = await bootstrapToMachineCandidate(db, supabase, {
        orgId,
        campaignId,
        agentId,
        amdMode: 'detect',
      });
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, legId, callControlId, 'call.answered')
      );
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, legId, callControlId, 'call.machine.detection.ended', {
          result: 'machine',
        })
      );

      const legRow = db.table('call_legs').get(legId)!;
      assertEquals(
        legRow.voicemail_drop_path ?? null,
        null,
        'detect mode can never safely arm a drop -- no greeting-ended signal will ever arrive'
      );
      const hangupReq = server.requests.find(
        (r) => r.method === 'POST' && r.path === `/v2/calls/${callControlId}/actions/hangup`
      );
      assertExists(hangupReq);
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'VMD-5: a voicemail-dropping leg is excluded from the active-line count -- refill dials past `lines` while it plays',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    db.table('campaigns').get(campaignId)!.voicemail_drop_mode = 'every_attempt';
    db.insert('voicemail_drop_settings', {
      id: 'vd-org-default',
      org_id: orgId,
      user_id: null,
      storage_path: `${orgId}/org-default.mp3`,
    });
    // A 4th queued lead beyond the 3 seedFixtures already inserts -- there must be room for a
    // NEW dial once the machine leg stops counting as active, even though `lines` (3) contact
    // legs already exist.
    db.insert('contacts', { id: 'contact-4', phone_number: '+15550001004' });
    db.insert('campaign_leads', {
      id: 'lead-4',
      campaign_id: campaignId,
      contact_id: 'contact-4',
      status: 'queued',
      position: 4,
    });
    try {
      const { sessionId, legId, callControlId } = await bootstrapToMachineCandidate(db, supabase, {
        orgId,
        campaignId,
        agentId,
        amdMode: 'detect_words',
      });
      assertEquals(
        [...db.table('call_legs').values()].filter((l) => l.kind === 'contact').length,
        3,
        'lines=3 -- exactly 3 contact legs dialed initially'
      );

      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, legId, callControlId, 'call.answered')
      );
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, legId, callControlId, 'call.machine.detection.ended', {
          result: 'machine',
        })
      );
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, legId, '', 'call.machine.greeting.ended')
      );

      const legRow = db.table('call_legs').get(legId)!;
      assertEquals(legRow.state, 'voicemail_dropping');
      assertEquals(
        [...db.table('call_legs').values()].filter((l) => l.kind === 'contact').length,
        4,
        'the 4th lead must be dialed immediately -- the voicemail-dropping leg does not hold the slot'
      );
    } finally {
      restoreFetch();
    }
  }
);

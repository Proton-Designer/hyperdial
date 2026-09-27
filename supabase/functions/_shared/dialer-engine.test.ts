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
  stopSession,
  endLiveCall,
  pauseRecording,
  resumeRecording,
  AGENT_DIAL_TIMEOUT_SECS,
  AGENT_DIAL_TIME_LIMIT_SECS,
  type RawTelnyxEvent,
} from './dialer-engine.ts';
import type { DialClientStateKind } from './client-state.ts';
// The in-memory fake Supabase client lives in its own non-test module now (dialer-fake-
// supabase.ts's own header explains why: importing THIS file, a .test.ts file, from another
// .test.ts file would re-run every Deno.test() below a second time under `deno test`).
// inbound-engine.test.ts imports directly from dialer-fake-supabase.ts, never from here.
import { FakeDb, createFakeSupabase, fakeToday } from './dialer-fake-supabase.ts';

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
  /** TASK-N1 fix-forward (finding L) regression test hook: makes the NEXT `POST /v2/calls`
   *  (a real dial attempt) fail outright, simulating Telnyx rejecting it -- then resets itself. */
  failNextDial = false;
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
      if (this.failNextDial) {
        this.failNextDial = false;
        return Response.json({ errors: [{ detail: 'invalid destination' }] }, { status: 422 });
      }
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
    if (method === 'POST' && /\/v2\/calls\/[^/]+\/actions\/record_(pause|resume)$/.test(path)) {
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
      // TASK-S1/BUG-8: the agent leg's own dial now explicitly carries its own (longer) ring
      // timeout and max call length, not Telnyx's implicit defaults.
      const agentDial1 = server.calls.get(agentLeg1.call_control_id as string)!;
      assertEquals(agentDial1.body.timeout_secs, AGENT_DIAL_TIMEOUT_SECS);
      assertEquals(agentDial1.body.time_limit_secs, AGENT_DIAL_TIME_LIMIT_SECS);
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
  'TASK-T8: handleWin speaks a consent notice on the winner leg when announce_recording_mode is "all"',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    db.insert('org_recording_settings', {
      id: orgId,
      org_id: orgId,
      recording_enabled: true,
      announce_recording_mode: 'all',
      all_party_consent_states: [],
    });
    try {
      const { winnerCallControlId } = await bootstrapToOnCall(db, supabase, {
        orgId,
        campaignId,
        agentId,
      });
      const speakReq = server.requests.find(
        (r) => r.method === 'POST' && r.path === `/v2/calls/${winnerCallControlId}/actions/speak`
      );
      assertExists(speakReq, 'mode "all" must speak a consent notice on the winner leg');
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-T8: handleWin never speaks a consent notice when announce_recording_mode is "never" (the default)',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    // No org_recording_settings row at all -- missing row = default 'never', same "missing row
    // = default" contract as recording_enabled itself.
    try {
      const { winnerCallControlId } = await bootstrapToOnCall(db, supabase, {
        orgId,
        campaignId,
        agentId,
      });
      const speakReq = server.requests.find(
        (r) => r.method === 'POST' && r.path === `/v2/calls/${winnerCallControlId}/actions/speak`
      );
      assertEquals(speakReq, undefined, 'default mode "never" must not speak a consent notice');
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-T8: "all_party_consent_states" mode announces when the contact\'s area code IS in the org list',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    db.insert('org_recording_settings', {
      id: orgId,
      org_id: orgId,
      recording_enabled: true,
      announce_recording_mode: 'all_party_consent_states',
      all_party_consent_states: ['CA'],
    });
    // Every seeded contact gets a real CA (415) number, so whichever contact wins the race is
    // still a positive case -- avoids depending on which of several fixture legs happens to
    // answer first.
    for (const contact of db.table('contacts').values()) {
      contact.phone_number = '+14155550000';
    }
    try {
      const { winnerCallControlId } = await bootstrapToOnCall(db, supabase, {
        orgId,
        campaignId,
        agentId,
      });
      const speakReq = server.requests.find(
        (r) => r.method === 'POST' && r.path === `/v2/calls/${winnerCallControlId}/actions/speak`
      );
      assertExists(speakReq, "CA (415) is in the org's consent-state list -- must announce");
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-T8: "all_party_consent_states" mode does NOT announce when the contact\'s area code is not in the org list',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    db.insert('org_recording_settings', {
      id: orgId,
      org_id: orgId,
      recording_enabled: true,
      announce_recording_mode: 'all_party_consent_states',
      all_party_consent_states: ['CA'],
    });
    // Every seeded contact gets a real NY (212) number -- not in the org's list.
    for (const contact of db.table('contacts').values()) {
      contact.phone_number = '+12125550000';
    }
    try {
      const { winnerCallControlId } = await bootstrapToOnCall(db, supabase, {
        orgId,
        campaignId,
        agentId,
      });
      const speakReq = server.requests.find(
        (r) => r.method === 'POST' && r.path === `/v2/calls/${winnerCallControlId}/actions/speak`
      );
      assertEquals(speakReq, undefined, "NY (212) is not in the org's consent-state list");
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-T8: pauseRecording pauses the active winner leg and stamps recording_paused_at',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId, winnerLegId, winnerCallControlId } = await bootstrapToOnCall(
        db,
        supabase,
        {
          orgId,
          campaignId,
          agentId,
        }
      );
      const before = db.table('call_legs').get(winnerLegId)!;
      assertEquals(before.recording_status, 'recording');

      const ok = await pauseRecording(supabase, orgId, sessionId);
      assertEquals(ok, true);

      const pauseReq = server.requests.find(
        (r) =>
          r.method === 'POST' && r.path === `/v2/calls/${winnerCallControlId}/actions/record_pause`
      );
      assertExists(pauseReq, 'record_pause must be called on the winner leg');

      const after = db.table('call_legs').get(winnerLegId)!;
      assertEquals(after.recording_status, 'paused');
      assertExists(after.recording_paused_at, 'recording_paused_at must be stamped');
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-T8: pauseRecording is a no-op (false, no Telnyx call) when the leg is not currently recording',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    db.insert('org_recording_settings', { id: orgId, org_id: orgId, recording_enabled: false });
    try {
      const { sessionId } = await bootstrapToOnCall(db, supabase, { orgId, campaignId, agentId });
      const ok = await pauseRecording(supabase, orgId, sessionId);
      assertEquals(ok, false);
      const pauseReq = server.requests.find((r) => r.path.endsWith('/actions/record_pause'));
      assertEquals(pauseReq, undefined, 'no recording was ever started, so pause must no-op');
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-T8: resumeRecording resumes the leg, clears recording_paused_at, and appends the closed span',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId, winnerLegId, winnerCallControlId } = await bootstrapToOnCall(
        db,
        supabase,
        {
          orgId,
          campaignId,
          agentId,
        }
      );
      const paused = await pauseRecording(supabase, orgId, sessionId);
      assertEquals(paused, true);

      const resumed = await resumeRecording(supabase, orgId, sessionId);
      assertEquals(resumed, true);

      const resumeReq = server.requests.find(
        (r) =>
          r.method === 'POST' && r.path === `/v2/calls/${winnerCallControlId}/actions/record_resume`
      );
      assertExists(resumeReq, 'record_resume must be called on the winner leg');

      const after = db.table('call_legs').get(winnerLegId)!;
      assertEquals(after.recording_status, 'recording');
      assertEquals(after.recording_paused_at, null);
      const spans = after.recording_paused_spans as Array<{
        paused_at: string;
        resumed_at: string;
      }>;
      assertEquals(spans.length, 1);
      assertExists(spans[0].paused_at);
      assertExists(spans[0].resumed_at);
    } finally {
      restoreFetch();
    }
  }
);

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

// ---------------------------------------------------------------------------
// BUG-11 (TASK-S1): stopSession refuses to silently hang up a live claimed contact leg.
// ---------------------------------------------------------------------------

/** Drives Go Ready -> agent answers -> dialing -> one contact answers (amd off, so it claims
 *  immediately) -> session on_call, exactly like the main end-to-end test's own winner-joins-
 *  conference step, but as a standalone helper for the stopSession tests below. */
async function bootstrapToOnCall(
  db: FakeDb,
  supabase: ReturnType<typeof createFakeSupabase>,
  args: { orgId: string; campaignId: string; agentId: string }
): Promise<{ sessionId: string; winnerLegId: string; winnerCallControlId: string }> {
  const { sessionId } = await startSession(supabase, {
    orgId: args.orgId,
    campaignId: args.campaignId,
    agentId: args.agentId,
    lines: 3,
    amdMode: 'off',
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
  const winnerLeg = [...db.table('call_legs').values()].find((l) => l.kind === 'contact')!;
  await processTelnyxDialerEvent(
    supabase,
    contactEvent(
      args.orgId,
      sessionId,
      winnerLeg.id as string,
      winnerLeg.call_control_id as string,
      'call.answered'
    )
  );
  return {
    sessionId,
    winnerLegId: winnerLeg.id as string,
    winnerCallControlId: winnerLeg.call_control_id as string,
  };
}

// ---------------------------------------------------------------------------
// TASK-T4 review fix-forward (SHOULD): cancelling an in-flight transfer the instant its own
// session's active leg ends -- proves the WIRING in endLiveCall/processContactLegEvent, not the
// underlying cancelInFlightTransferForSession logic itself (already covered end-to-end by its
// own dedicated unit tests in transfer-core.test.ts).
// ---------------------------------------------------------------------------

Deno.test(
  'TASK-T4 review fix-forward: endLiveCall cancels an in-flight transfer before hanging up the prospect leg',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId, winnerLegId, winnerCallControlId } = await bootstrapToOnCall(
        db,
        supabase,
        {
          orgId,
          campaignId,
          agentId,
        }
      );
      const transferId = 'transfer-fix-a';
      db.insert('call_transfers', {
        id: transferId,
        org_id: orgId,
        session_id: sessionId,
        contact_leg_id: winnerLegId,
        type: 'cold',
        target_kind: 'external',
        target_number: '+14155552671',
        target_call_control_id: 'call-target-x',
        status: 'dialing',
      });

      const ok = await endLiveCall(supabase, orgId, sessionId);
      assertEquals(ok, true);

      assertEquals(
        server.requests.some(
          (r) => r.method === 'POST' && r.path === '/v2/calls/call-target-x/actions/hangup'
        ),
        true,
        'the transfer target must be hung up, not left ringing'
      );
      assertEquals(
        server.requests.some(
          (r) => r.method === 'POST' && r.path === `/v2/calls/${winnerCallControlId}/actions/hangup`
        ),
        true,
        'the prospect leg itself must still be hung up as usual'
      );
      assertEquals(db.table('call_transfers').get(transferId)!.status, 'cancelled');
      assertEquals(db.table('call_transfers').get(transferId)!.ended_reason, 'agent_hangup');
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-T4 review fix-forward: the winner-ended webhook branch cancels an in-flight transfer, covering "the customer leg ends" too',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId, winnerLegId, winnerCallControlId } = await bootstrapToOnCall(
        db,
        supabase,
        {
          orgId,
          campaignId,
          agentId,
        }
      );
      const transferId = 'transfer-fix-b';
      db.insert('call_transfers', {
        id: transferId,
        org_id: orgId,
        session_id: sessionId,
        contact_leg_id: winnerLegId,
        type: 'cold',
        target_kind: 'external',
        target_number: '+14155552671',
        target_call_control_id: 'call-target-y',
        status: 'dialing',
      });

      // The CUSTOMER's own leg hangs up -- not an explicit agent action, purely the webhook path.
      await processTelnyxDialerEvent(
        supabase,
        contactEvent(orgId, sessionId, winnerLegId, winnerCallControlId, 'call.hangup', {
          hangup_cause: 'normal_clearing',
        })
      );

      assertEquals(
        server.requests.some(
          (r) => r.method === 'POST' && r.path === '/v2/calls/call-target-y/actions/hangup'
        ),
        true,
        'the transfer target must be hung up even when the CUSTOMER ends the call, not the agent'
      );
      assertEquals(db.table('call_transfers').get(transferId)!.status, 'cancelled');
      assertEquals(db.table('call_transfers').get(transferId)!.ended_reason, 'session_ended');
      assertEquals(db.table('dial_sessions').get(sessionId)!.state, 'wrap_up');
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'BUG-11: stopSession refuses (live_call_in_progress) when a contact leg is claimed and force is not passed -- nothing is hung up, session state is unchanged',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId, winnerCallControlId } = await bootstrapToOnCall(db, supabase, {
        orgId,
        campaignId,
        agentId,
      });
      assertEquals(db.table('dial_sessions').get(sessionId)!.state, 'on_call');

      const result = await stopSession(supabase, orgId, sessionId);
      assertEquals(result, { ok: false, reason: 'live_call_in_progress' });
      assertEquals(
        db.table('dial_sessions').get(sessionId)!.state,
        'on_call',
        'a refused stop must not transition the session'
      );
      assertEquals(
        server.requests.some(
          (r) => r.method === 'POST' && r.path === `/v2/calls/${winnerCallControlId}/actions/hangup`
        ),
        false,
        'a refused stop must not hang up the live leg'
      );
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'BUG-11: stopSession with force:true hangs up the claimed leg and stops the session (the confirm dialog\'s "Hang up and stop")',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixtures(db);
    try {
      const { sessionId, winnerCallControlId } = await bootstrapToOnCall(db, supabase, {
        orgId,
        campaignId,
        agentId,
      });

      const result = await stopSession(supabase, orgId, sessionId, true);
      assertEquals(result, { ok: true });
      assertEquals(db.table('dial_sessions').get(sessionId)!.state, 'stopped');
      assertEquals(
        server.requests.some(
          (r) => r.method === 'POST' && r.path === `/v2/calls/${winnerCallControlId}/actions/hangup`
        ),
        true,
        'force:true must hang up the live leg'
      );
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'BUG-11: stopSession with no claimed contact leg succeeds without force -- Stop still "always works" outside on_call',
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
      assertEquals(db.table('dial_sessions').get(sessionId)!.state, 'ready_pending');

      const result = await stopSession(supabase, orgId, sessionId);
      assertEquals(result, { ok: true });
      assertEquals(db.table('dial_sessions').get(sessionId)!.state, 'stopped');
    } finally {
      restoreFetch();
    }
  }
);

// ---------------------------------------------------------------------------
// TASK-N1: caller-ID number pool (CID-1, CID-2, ADM-5, CID-5).
//
// The pool's own selection/priority-order/cap/resting SQL logic (private.pick_and_reserve_
// dial_number / private.has_available_dial_number, 20260925070000_number_pool.sql) is verified
// against the REAL migration by audit/N1/dryrun-tests.sql, same as claim_next_leads' own
// selection logic -- the fake `rpc()` cases above mirror that SQL closely enough for the
// engine tests below to exercise real dialer-engine.ts orchestration (does it call the right
// RPC, does it wire a returned number into the actual dial, does it recover correctly from a
// null result), not to re-prove the SQL's own correctness a second time.
// ---------------------------------------------------------------------------

/** No legacy caller_id_number_id, no ELIGIBLE user_phone_numbers -- but the org still owns one
 *  RETIRED number (so the agent leg's own dial -- out of the pool's scope entirely, see
 *  agentDialFromNumber's header -- still has something to dial `from`; a pool-only org never
 *  needs a legacy campaign number, just at least one number ever purchased). */
function seedFixturesNoNumbers(db: FakeDb) {
  const orgId = 'org-n1';
  const agentId = 'agent-n1';
  const campaignId = 'campaign-n1';

  db.insert('orgs', { id: orgId, name: 'N1 Fixture Org' });
  db.insert('org_telephony', {
    id: 'telephony-n1',
    org_id: orgId,
    status: 'connected',
    call_control_app_id: 'cca-n1',
    credential_connection_id: 'cred-conn-n1',
  });
  db.insert('org_members', {
    id: 'member-n1',
    org_id: orgId,
    user_id: agentId,
    telnyx_credential_id: 'cred-n1',
  });
  db.insert('user_phone_numbers', {
    id: 'retired-1',
    org_id: orgId,
    phone_number: '+15125559999',
    status: 'retired',
    daily_cap: 100,
    assigned_user_id: null,
  });
  db.insert('campaigns', {
    id: campaignId,
    org_id: orgId,
    name: 'N1 Fixture Campaign',
    abandon_message_enabled: true,
    caller_id_number_id: null,
  });
  for (const [i, contactId] of ['contact-n1', 'contact-n2'].entries()) {
    db.insert('contacts', { id: contactId, phone_number: `+1555000200${i + 1}` });
    db.insert('campaign_leads', {
      id: `lead-n${i + 1}`,
      campaign_id: campaignId,
      contact_id: contactId,
      status: 'queued',
      position: i + 1,
    });
  }
  return { orgId, agentId, campaignId };
}

Deno.test(
  'TASK-N1: no pool number and no legacy caller ID -> refillSession pauses before claiming any lead',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixturesNoNumbers(db);
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 2,
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

      const session = db.table('dial_sessions').get(sessionId)!;
      assertEquals(session.state, 'paused');
      assertEquals(session.pause_reason, 'no_numbers_available');
      assertEquals(
        [...db.table('call_legs').values()].filter((l) => l.kind === 'contact').length,
        0,
        'no lead should ever be claimed if there is nothing to dial it with'
      );
      assertEquals(
        [...db.table('campaign_leads').values()].every((l) => l.status === 'queued'),
        true,
        'every lead must stay queued, untouched'
      );
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-N1: a pool number is used as the dial from-number and persisted on the leg; hitting its cap mid-batch releases the next lead and pauses the session',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixturesNoNumbers(db);
    db.insert('user_phone_numbers', {
      id: 'pool-1',
      org_id: orgId,
      phone_number: '+15125550000',
      status: 'active',
      daily_cap: 1,
      assigned_user_id: null,
    });
    try {
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 2,
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
      assertEquals(contactLegs.length, 1, 'only the first lead could actually be dialed');
      const dialedLeg = contactLegs[0];
      assertEquals(dialedLeg.from_number_id, 'pool-1');
      const dialReq = server.calls.get(dialedLeg.call_control_id as string)!;
      assertEquals(dialReq.body.from, '+15125550000');

      assertEquals(
        db.table('user_phone_numbers').get('pool-1')!.status,
        'resting',
        'the only number must be resting once its cap (1) is hit'
      );

      const dialedLeadId = dialedLeg.lead_id as string;
      const strandedLead = [...db.table('campaign_leads').values()].find(
        (l) => l.id !== dialedLeadId
      )!;
      assertEquals(
        strandedLead.status,
        'queued',
        'the second lead must be released back to queued, not left in_flight'
      );

      const session = db.table('dial_sessions').get(sessionId)!;
      assertEquals(session.state, 'paused');
      assertEquals(session.pause_reason, 'no_numbers_available');
    } finally {
      restoreFetch();
    }
  }
);

Deno.test(
  'TASK-N1 fix-forward (finding L): a dial Telnyx rejects outright gives back its number_daily_usage reservation and un-rests the number',
  async () => {
    const db = new FakeDb();
    const server = new FakeTelnyxServer();
    const restoreFetch = stubTelnyxFetch(server);
    const supabase = createFakeSupabase(db);
    const { orgId, campaignId, agentId } = seedFixturesNoNumbers(db);
    db.insert('user_phone_numbers', {
      id: 'pool-1',
      org_id: orgId,
      phone_number: '+15125550000',
      status: 'active',
      daily_cap: 1,
      assigned_user_id: null,
    });
    try {
      // lines: 1 (not 2, unlike the sibling test above) deliberately keeps this batch to a
      // single claimed lead -- with 2 lines, the second lead's own resolveDialNumberForLeg call
      // would immediately re-reserve (and legitimately re-rest) the same just-released number
      // later in the SAME refillSession loop, which would defeat isolating this specific
      // assertion (the release itself, not what happens to capacity afterward).
      const { sessionId } = await startSession(supabase, {
        orgId,
        campaignId,
        agentId,
        lines: 1,
        amdMode: 'off',
      });
      // Only make the CONTACT leg's dial fail -- startSession above already dialed (and
      // consumed) the agent leg's own real /v2/calls POST.
      server.failNextDial = true;
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
      assertEquals(contactLegs.length, 1, 'the one lead that was claimed got a leg');
      assertEquals(
        contactLegs[0].outcome,
        'no_answer',
        'a dial Telnyx rejects outright terminates the leg as retryable, not permanently failed'
      );

      const today = fakeToday();
      const usage = db.table('number_daily_usage').get(`pool-1|${today}`);
      assertEquals(
        (usage?.dials as number | undefined) ?? 0,
        0,
        'the reservation pick_and_reserve_dial_number made for the failed dial must be given back'
      );
      assertEquals(
        db.table('user_phone_numbers').get('pool-1')!.status,
        'active',
        'a number rested only by the failed dial must be un-rested once that reservation is released'
      );
      assertEquals(db.table('user_phone_numbers').get('pool-1')!.resting_until, null);
    } finally {
      restoreFetch();
    }
  }
);

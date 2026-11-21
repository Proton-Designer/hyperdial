#!/usr/bin/env -S deno run --allow-net --allow-env --allow-run --allow-read --allow-write
/**
 * TASK-P2-E2 acceptance script: local `functions serve` + a mock Telnyx HTTP server + signed
 * fake webhooks, driving the rolling-refill dial engine end-to-end. Mirrors the task's own
 * Acceptance+verify #2 scenario exactly (see the SCENARIO block below).
 *
 * Prerequisites: `supabase start` already running (real local Postgres + GoTrue + PostgREST).
 * Nothing else needs to be started by hand -- this script starts its own mock Telnyx server
 * (fixed port, see MOCK_PORT) AND spawns `supabase functions serve` itself, pointed at that
 * mock via a generated --env-file (TELNYX_API_BASE + DIALER_DEV_SKIP_AGENT_GATE), and tears
 * both down on exit (success, failure, or Ctrl-C).
 *
 * amd_mode is 'on' for this scenario deliberately: with AMD off, a leg's call.answered event
 * resolves its claim decision synchronously in the same request (win or lose immediately) --
 * there is no window where a losing leg sits "answered but undecided" for a second event to
 * find, so a scripted (non-concurrent) run can only ever deterministically reach "dropped"
 * (silent hangup) for every other leg, never a genuine "abandoned" (speak+hangup). With AMD
 * on, call.answered alone only reaches 'amd_pending' (amdDecision('on', undefined) = 'wait'),
 * genuinely holding a leg there until ITS OWN detection-ended event -- exactly the window
 * needed to deterministically exercise handleWin's "already-answered loser -> abandoned" path
 * without relying on real concurrency. Run: `deno run --allow-net --allow-env --allow-run
 * --allow-read --allow-write scripts/dev/dialer-sim.ts`
 *
 * SCENARIO (mirrors the task file's Acceptance+verify #2):
 *   1. Start a session (lines=3, amd_mode=on) -> 3 dials.
 *   2. One no-answer hangup -> 1 refill dial (4th lead claimed).
 *   3. Two answered legs both reach amd_pending, then one detection-ended(human) claims the
 *      session -> the OTHER already-answered leg is resolved to abandoned (speak+hangup) and
 *      the still-ringing refill leg is resolved to dropped (silent hangup), both via handleWin.
 *   4. The SAME detection-ended event redelivered (same event_id) -> a dedupe no-op; a
 *      detection-ended for the now-abandoned leg -> a legTransition state-guard no-op.
 *   5. The winner hangs up -> wrap_up, and every lead's outcome is correct in the DB.
 *   6. resumeToDialing (called directly, not via HTTP -- see dialer-engine.ts's header for why
 *      there's no dedicated endpoint) flips the session back to 'dialing' and attempts a
 *      refill (0 dials is the correct outcome here: every remaining lead's retry delay hasn't
 *      elapsed yet, so nothing is due -- this still proves the mechanism works).
 *   7. TASK-P2-E2 fix-forward item 2 (lead's diff-read, high): a fresh lead is dialed, then its
 *      call.answered and call.hangup webhooks are fired as two GENUINELY concurrent HTTP
 *      requests (Promise.all, never awaited in sequence) -- the only way a same-process script
 *      can produce a real interleaving, not a simulated one (LANE-eng2.md's
 *      NEEDS-CONCURRENCY-VERIFY lesson: a sequential script can only prove logic correct for
 *      orderings it can actually produce). Whichever request's transition_leg call commits
 *      first, the other used to be silently dropped by the expected-state check if it landed a
 *      terminal event -- applyLegTransition's reload-and-retry means the leg still reaches
 *      'ended' with a real outcome either way.
 *
 * All fixtures (org/users/campaign/contacts/org_telephony) are created fresh under a
 * disposable orgId and deleted at the end, success or failure -- this never touches real data.
 */

import { resumeToDialing, refillSession } from '../../supabase/functions/_shared/dialer-engine.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';

const MOCK_PORT = 9911;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
// `supabase functions serve` runs the edge runtime inside its own Docker container (confirmed
// live: `docker ps` shows supabase_edge_runtime_HyperDial), so "127.0.0.1" from inside it means
// the CONTAINER's own loopback, not the host's -- found live as an immediate "Connection
// refused" on every dial the moment refillSession actually tried to call the mock. Docker
// Desktop's host.docker.internal resolves to the host machine from inside any container; the
// mock server itself still binds to all interfaces (Deno.serve's default) so that reaches it.
const MOCK_BASE_FOR_CONTAINER = `http://host.docker.internal:${MOCK_PORT}`;

function log(step: string, meta: Record<string, unknown> = {}): void {
  console.log(`[dialer-sim] ${step}`, JSON.stringify(meta));
}

function fail(message: string): never {
  console.error(`[dialer-sim] FAIL: ${message}`);
  throw new Error(message);
}

function assertEqual(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  console.log(`  PASS [${label}]: ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// Mock Telnyx HTTP server -- only the endpoints this engine actually calls.
// ---------------------------------------------------------------------------

interface MockCall {
  to: string;
  from: string;
  webhookUrl: string;
  clientState: string;
}

const mockCalls = new Map<string, MockCall>();
const mockRequestLog: { method: string; path: string; body: unknown }[] = [];
let mockCallCounter = 0;
let mockConferenceCounter = 0;

function startMockTelnyxServer(): void {
  Deno.serve({ port: MOCK_PORT, onListen: () => {} }, async (req) => {
    const url = new URL(req.url);
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    mockRequestLog.push({ method: req.method, path: url.pathname, body });

    if (req.method === 'GET' && url.pathname === '/__log') {
      return Response.json({ calls: Object.fromEntries(mockCalls), requests: mockRequestLog });
    }
    if (req.method === 'POST' && url.pathname === '/calls') {
      mockCallCounter++;
      const callControlId = `mock-call-${mockCallCounter}`;
      mockCalls.set(callControlId, {
        to: String(body.to),
        from: String(body.from),
        webhookUrl: String(body.webhook_url),
        clientState: String(body.client_state),
      });
      return Response.json({ data: { call_control_id: callControlId } });
    }
    if (req.method === 'POST' && /^\/calls\/[^/]+\/actions\/(hangup|speak)$/.test(url.pathname)) {
      return Response.json({ data: {} });
    }
    if (req.method === 'POST' && url.pathname === '/conferences') {
      mockConferenceCounter++;
      const id = `mock-conf-${mockConferenceCounter}`;
      return Response.json({ data: { id, name: body.name } });
    }
    if (
      req.method === 'POST' &&
      /^\/conferences\/[^/]+\/actions\/(join|leave)$/.test(url.pathname)
    ) {
      return Response.json({ data: {} });
    }
    if (req.method === 'GET' && url.pathname === '/balance') {
      return Response.json({ data: { balance: '100.00' } });
    }
    return Response.json(
      { errors: [{ detail: `not mocked: ${req.method} ${url.pathname}` }] },
      { status: 404 }
    );
  });
  log('mock_telnyx_server_started', { port: MOCK_PORT });
}

function mockCallControlIdForPhone(phone: string): string {
  for (const [id, call] of mockCalls) {
    if (call.to === phone) return id;
  }
  fail(`no mock call found dialing ${phone}`);
}

// ---------------------------------------------------------------------------
// Shell helpers
// ---------------------------------------------------------------------------

async function run(cmd: string[], opts: Deno.CommandOptions = {}): Promise<string> {
  const command = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: 'piped',
    stderr: 'piped',
    ...opts,
  });
  const { code, stdout, stderr } = await command.output();
  const out = new TextDecoder().decode(stdout);
  const err = new TextDecoder().decode(stderr);
  if (code !== 0) fail(`command failed (${cmd.join(' ')}): ${err || out}`);
  return out;
}

async function psql(sql: string, dbUrl: string): Promise<string> {
  return run(['psql', dbUrl, '-t', '-A', '-c', sql]);
}

// ---------------------------------------------------------------------------
// Webhook signing (same technique as TASK-P1-04/05's webhook-verify.test.ts and the
// P1-05/P1-06 live acceptance runs -- see LANE-eng2.md)
// ---------------------------------------------------------------------------

async function generateWebhookKeypair(): Promise<{ keyPair: CryptoKeyPair; publicKeyB64: string }> {
  const keyPair = (await crypto.subtle.generateKey(
    { name: 'Ed25519' } as unknown as EcKeyGenParams,
    true,
    ['sign', 'verify']
  )) as CryptoKeyPair;
  const rawPublic = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  return { keyPair, publicKeyB64: btoa(String.fromCharCode(...new Uint8Array(rawPublic))) };
}

async function signWebhook(
  keyPair: CryptoKeyPair,
  rawBody: string
): Promise<{ signatureB64: string; timestamp: string }> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signedPayload = new TextEncoder().encode(`${timestamp}|${rawBody}`);
  const signature = await crypto.subtle.sign(
    { name: 'Ed25519' } as unknown as AlgorithmIdentifier,
    keyPair.privateKey,
    signedPayload
  );
  return { signatureB64: btoa(String.fromCharCode(...new Uint8Array(signature))), timestamp };
}

async function sendWebhook(
  functionsUrl: string,
  orgId: string,
  keyPair: CryptoKeyPair,
  eventId: string,
  eventType: string,
  callControlId: string,
  clientState: string,
  extraPayload: Record<string, unknown> = {}
): Promise<Response> {
  const rawBody = JSON.stringify({
    data: {
      id: eventId,
      event_type: eventType,
      occurred_at: new Date().toISOString(),
      payload: { call_control_id: callControlId, client_state: clientState, ...extraPayload },
    },
  });
  const { signatureB64, timestamp } = await signWebhook(keyPair, rawBody);
  return fetch(`${functionsUrl}/telnyx-webhook?org=${orgId}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'telnyx-signature-ed25519': signatureB64,
      'telnyx-timestamp': timestamp,
    },
    body: rawBody,
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // `resumeToDialing`/`refillSession` are also called DIRECTLY from this script's own process
  // (step 6 and step 7 below), not only through `functions serve`'s container -- the env file
  // written further down only reaches THAT container, not this process. Found live: step 7's
  // fresh race-scenario lead is genuinely due (unlike the rest of the fixture at that point),
  // so it's the first place in this script where a closed agent-leg gate in THIS process
  // actually produces a visibly wrong "0 dials" instead of a coincidentally-correct one, and
  // where the default TELNYX_API_BASE (the real Telnyx API, since this process never got the
  // env file) sent a real outbound HTTP request with a fake key and got a real 401 back.
  // MOCK_BASE (not MOCK_BASE_FOR_CONTAINER) is correct here -- this process runs on the host,
  // not inside functions serve's container.
  Deno.env.set('DIALER_DEV_SKIP_AGENT_GATE', 'true');
  Deno.env.set('TELNYX_API_BASE', MOCK_BASE);

  const statusOut = await run(['supabase', 'status', '-o', 'env']);
  const env: Record<string, string> = {};
  for (const line of statusOut.split('\n')) {
    const m = line.match(/^(\w+)="?(.*?)"?$/);
    if (m) env[m[1]] = m[2];
  }
  const apiUrl = env.API_URL ?? fail('API_URL not found in `supabase status`');
  const dbUrl = env.DB_URL ?? fail('DB_URL not found in `supabase status`');
  const anonKey = env.ANON_KEY ?? fail('ANON_KEY not found in `supabase status`');
  const functionsUrl = `${apiUrl}/functions/v1`;
  log('supabase_status_parsed', { apiUrl, functionsUrl });

  startMockTelnyxServer();

  const envFilePath = await Deno.makeTempFile({ prefix: 'dialer-sim-env-' });
  await Deno.writeTextFile(
    envFilePath,
    `TELNYX_API_BASE=${MOCK_BASE_FOR_CONTAINER}\nDIALER_DEV_SKIP_AGENT_GATE=true\n`
  );

  const functionsServe = new Deno.Command('supabase', {
    args: ['functions', 'serve', '--env-file', envFilePath, '--no-verify-jwt'],
    stdout: 'piped',
    stderr: 'piped',
  }).spawn();
  log('functions_serve_spawned', { envFilePath });
  const pipeToConsole = async (stream: ReadableStream<Uint8Array>, prefix: string) => {
    for await (const chunk of stream) {
      Deno.stderr.writeSync(
        new TextEncoder().encode(`[${prefix}] ${new TextDecoder().decode(chunk)}`)
      );
    }
  };
  pipeToConsole(functionsServe.stdout, 'functions-serve:out').catch(() => {});
  pipeToConsole(functionsServe.stderr, 'functions-serve:err').catch(() => {});

  // Set once the owner user is created below -- handle_new_user (the on_auth_user_created
  // trigger) auto-provisions an org via private.ensure_org_for_user for any signup with no
  // invite_token, same as a real signup. Found live: an earlier version of this script also
  // manually inserted its own org row, leaving that auto-provisioned one as an orphan that
  // blocked the auth.users cleanup delete via orgs_created_by_fkey. Use the real one instead
  // of creating a second, competing org.
  let orgId = '';
  const ownerId = crypto.randomUUID();
  let sessionId = '';

  const cleanup = async () => {
    log('cleanup_start', {});
    try {
      functionsServe.kill('SIGTERM');
    } catch {
      // already dead
    }
    try {
      if (orgId) await psql(`delete from public.orgs where id = '${orgId}';`, dbUrl);
      await psql(`delete from auth.users where id = '${ownerId}';`, dbUrl);
    } catch (err) {
      console.error('[dialer-sim] cleanup DB error (non-fatal):', err);
    }
    try {
      await Deno.remove(envFilePath);
    } catch {
      // best effort
    }
    log('cleanup_done', {});
  };

  try {
    // Wait for functions serve to become ready.
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${functionsUrl}/telnyx-webhook`, { method: 'OPTIONS' });
        if (res.ok || res.status === 204) {
          ready = true;
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!ready) fail('supabase functions serve never became ready after 30s');
    log('functions_serve_ready', {});

    const { keyPair, publicKeyB64 } = await generateWebhookKeypair();

    // --- Fixtures -----------------------------------------------------------------------
    // auth.users first -- orgs.created_by is a FK into it.
    await psql(
      `insert into auth.users (
         instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
         raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
         confirmation_token, recovery_token, email_change, email_change_token_new,
         email_change_token_current, phone_change, phone_change_token,
         reauthentication_token, is_sso_user, is_anonymous
       ) values (
         '00000000-0000-0000-0000-000000000000', '${ownerId}', 'authenticated', 'authenticated',
         'dialer-sim-owner@example.com', crypt('dialer-sim-pw', gen_salt('bf')), now(),
         '{}', '{}', now(), now(), '', '', '', '', '', '', '', '', false, false
       );`,
      dbUrl
    );
    // handle_new_user already auto-provisioned an org (owner membership + active_org_id) for
    // this signup via private.ensure_org_for_user -- read its id rather than creating a
    // second, competing one.
    orgId = (
      await psql(`select active_org_id from public.profiles where user_id = '${ownerId}';`, dbUrl)
    ).trim();
    if (!orgId) fail('profiles.active_org_id was not auto-provisioned for the owner user');
    await psql(`select public.set_org_telnyx_key('${orgId}', 'mock-telnyx-key');`, dbUrl);
    await psql(
      `update public.org_telephony set
         status = 'connected',
         call_control_app_id = 'mock-cca-1',
         credential_connection_id = 'mock-cred-1',
         webhook_public_key = '${publicKeyB64}'
       where org_id = '${orgId}';`,
      dbUrl
    );
    const numberId = crypto.randomUUID();
    await psql(
      `insert into public.user_phone_numbers (id, user_id, org_id, telnyx_phone_number_id, phone_number)
       values ('${numberId}', '${ownerId}', '${orgId}', 'mock-number-1', '+15550001000');`,
      dbUrl
    );
    const campaignId = crypto.randomUUID();
    await psql(
      // calling_window_start/end wide open (00:00-23:59): claim_next_leads' calling-window
      // check (private.is_lead_callable_now) falls back to requiring BOTH America/New_York
      // AND America/Los_Angeles to be within the campaign's default 08:00-21:00 window for
      // any contact with no timezone set (all four sim contacts, deliberately) -- found live
      // when this script's first run claimed 0 of 3 requested leads because the real
      // wall-clock happened to be outside that window in New York. A scripted test's
      // correctness should never depend on what time of day it happens to run.
      `insert into public.campaigns (id, org_id, user_id, name, lines, amd_mode, caller_id_number_id, abandon_message_enabled, calling_window_start, calling_window_end)
       values ('${campaignId}', '${orgId}', '${ownerId}', 'Sim Campaign', 3, 'on', '${numberId}', true, '00:00', '23:59');`,
      dbUrl
    );
    const contactIds = [1, 2, 3, 4].map(() => crypto.randomUUID());
    const leadIds = [1, 2, 3, 4].map(() => crypto.randomUUID());
    for (let i = 0; i < 4; i++) {
      const phone = `+1555000${1000 + i + 1}`.replace('10001000', '1000'); // keep it simple below
      const p = `+155500010${i + 1}`;
      await psql(
        `insert into public.contacts (id, org_id, user_id, first_name, phone_number)
         values ('${contactIds[i]}', '${orgId}', '${ownerId}', 'Sim Contact ${i + 1}', '${p}');
         insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status)
         values ('${leadIds[i]}', '${campaignId}', '${contactIds[i]}', '${orgId}', 'queued');`,
        dbUrl
      );
    }
    log('fixtures_seeded', { orgId, campaignId, contactIds });

    // --- Sign in as the owner -------------------------------------------------------------
    const tokenRes = await fetch(`${apiUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: anonKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'dialer-sim-owner@example.com', password: 'dialer-sim-pw' }),
    });
    if (!tokenRes.ok) fail(`sign-in failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const { access_token: accessToken } = await tokenRes.json();
    const authHeaders = {
      Authorization: `Bearer ${accessToken}`,
      apikey: anonKey,
      'Content-Type': 'application/json',
      'X-Org-Id': orgId,
    };
    log('signed_in', {});

    // --- 1. Start session -> 3 dials --------------------------------------------------------
    const startRes = await fetch(`${functionsUrl}/dialer-session-start`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ campaignId }),
    });
    const startBody = await startRes.json();
    if (!startRes.ok)
      fail(`dialer-session-start failed: ${startRes.status} ${JSON.stringify(startBody)}`);
    sessionId = startBody.sessionId;
    log('session_started', { sessionId });

    await new Promise((r) => setTimeout(r, 500)); // let refillSession's dials land
    assertEqual('3 dials fired at session start', mockCalls.size, 3);

    const phones = [1, 2, 3, 4].map((i) => `+155500010${i}`);
    const leg1 = mockCallControlIdForPhone(phones[0]);
    const leg2 = mockCallControlIdForPhone(phones[1]);
    const leg3 = mockCallControlIdForPhone(phones[2]);
    const clientStateFor = (legId: string) => mockCalls.get(legId)!.clientState;

    // --- 2. leg1 no-answer hangup -> 1 refill dial -----------------------------------------
    let res = await sendWebhook(
      functionsUrl,
      orgId,
      keyPair,
      crypto.randomUUID(),
      'call.hangup',
      leg1,
      clientStateFor(leg1),
      { hangup_cause: 'no_answer' }
    );
    if (!res.ok) fail(`call.hangup(leg1) rejected: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 500));
    assertEqual('refill dial after no-answer', mockCalls.size, 4);
    const leg4 = mockCallControlIdForPhone(phones[3]);

    // --- 3. leg2 and leg3 both answered -> amd_pending -------------------------------------
    // The webhook's outer handler acks (200) before processing (ack-then-process, by design
    // -- see telnyx-webhook/index.ts) -- a 200 here only confirms the ack, not that the async
    // processing landed. Firing the next dependent event immediately, with no settle delay,
    // raced against that processing live: leg2's own detection-ended arrived and read a
    // snapshot before/while leg2's own call.answered was still committing, and the two
    // concurrent transition_leg calls correctly detected the conflict (a safe
    // leg_transition_race_lost no-op) -- exactly the race-safety this design is supposed to
    // have, but not the deterministic scenario this script is trying to demonstrate. Fixed by
    // waiting for each event's processing to actually land before sending the next dependent
    // one, same discipline as every other step in this script.
    for (const leg of [leg2, leg3]) {
      res = await sendWebhook(
        functionsUrl,
        orgId,
        keyPair,
        crypto.randomUUID(),
        'call.answered',
        leg,
        clientStateFor(leg)
      );
      if (!res.ok) fail(`call.answered(${leg}) rejected: ${res.status} ${await res.text()}`);
      await new Promise((r) => setTimeout(r, 400));
    }

    // leg2's detection-ended(human) claims the session.
    const winEventId = crypto.randomUUID();
    res = await sendWebhook(
      functionsUrl,
      orgId,
      keyPair,
      winEventId,
      'call.machine.detection.ended',
      leg2,
      clientStateFor(leg2),
      { result: 'human' }
    );
    if (!res.ok) fail(`detection-ended(leg2) rejected: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 500));

    // --- 4a. Redeliver the exact same event -> dedupe no-op --------------------------------
    const requestsBeforeRedelivery = mockRequestLog.length;
    res = await sendWebhook(
      functionsUrl,
      orgId,
      keyPair,
      winEventId,
      'call.machine.detection.ended',
      leg2,
      clientStateFor(leg2),
      { result: 'human' }
    );
    if (!res.ok)
      fail(`redelivered detection-ended(leg2) rejected: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 300));
    assertEqual(
      'redelivered event issues no new Telnyx commands (dedupe no-op)',
      mockRequestLog.length,
      requestsBeforeRedelivery
    );

    // --- 4b. detection-ended for the now-abandoned leg3 -> state-guard no-op ---------------
    const requestsBeforeStaleEvent = mockRequestLog.length;
    res = await sendWebhook(
      functionsUrl,
      orgId,
      keyPair,
      crypto.randomUUID(),
      'call.machine.detection.ended',
      leg3,
      clientStateFor(leg3),
      { result: 'human' }
    );
    if (!res.ok) fail(`detection-ended(leg3, stale) rejected: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 300));
    assertEqual(
      'detection-ended on an already-resolved leg issues no new Telnyx commands',
      mockRequestLog.length,
      requestsBeforeStaleEvent
    );

    // --- Verify leg2 claimed, leg3 abandoned (speak issued), leg4 dropped (hangup issued) ---
    const legStatesAfterWin = await psql(
      `select id, state, outcome from public.call_legs where session_id = '${sessionId}' order by created_at;`,
      dbUrl
    );
    log('leg_states_after_win', { raw: legStatesAfterWin.trim() });
    const speakRequests = mockRequestLog.filter((r) => r.path.endsWith('/actions/speak'));
    const hangupRequests = mockRequestLog.filter((r) => r.path.endsWith('/actions/hangup'));
    if (speakRequests.length < 1)
      fail('expected at least one speak command (leg3 abandon message)');
    if (hangupRequests.length < 1) fail('expected at least one hangup command (leg4 silent drop)');
    log('speak_and_hangup_commands_confirmed', {
      speakCount: speakRequests.length,
      hangupCount: hangupRequests.length,
    });

    // --- Close out leg3 (speak.ended -> engine hangs it up) and leg4 -----------------------
    res = await sendWebhook(
      functionsUrl,
      orgId,
      keyPair,
      crypto.randomUUID(),
      'call.speak.ended',
      leg3,
      clientStateFor(leg3)
    );
    if (!res.ok) fail(`call.speak.ended(leg3) rejected: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 400));

    // TASK-P2-E2 fix-forward item 6 (eng1's review): call.speak.ended's own no-op confirmation
    // on an already-'abandoned' leg (current === 'abandoned', legTransition returns
    // {next:'abandoned'} with no outcome -- "no state change, the engine issues the hangup
    // next") used to re-trigger sendAbandonMessage a second time, because the old dispatch
    // gated on `result.next === 'abandoned'` instead of `result.outcome === 'abandoned'`. Every
    // abandoned leg got the "sorry we missed you" message spoken twice. Assert EXACTLY one
    // speak command total for leg3, not "at least one".
    const speakRequestsAfterConfirmation = mockRequestLog.filter((r) =>
      r.path.endsWith('/actions/speak')
    );
    assertEqual(
      'exactly one speak command total for the abandoned leg (no duplicate on the speak.ended confirmation)',
      speakRequestsAfterConfirmation.length,
      1
    );

    res = await sendWebhook(
      functionsUrl,
      orgId,
      keyPair,
      crypto.randomUUID(),
      'call.hangup',
      leg3,
      clientStateFor(leg3),
      { hangup_cause: 'normal_clearing' }
    );
    if (!res.ok) fail(`call.hangup(leg3) rejected: ${res.status} ${await res.text()}`);
    res = await sendWebhook(
      functionsUrl,
      orgId,
      keyPair,
      crypto.randomUUID(),
      'call.hangup',
      leg4,
      clientStateFor(leg4),
      { hangup_cause: 'normal_clearing' }
    );
    if (!res.ok) fail(`call.hangup(leg4) rejected: ${res.status} ${await res.text()}`);

    // --- 5. Winner hangup -> wrap_up ---------------------------------------------------------
    res = await sendWebhook(
      functionsUrl,
      orgId,
      keyPair,
      crypto.randomUUID(),
      'call.hangup',
      leg2,
      clientStateFor(leg2),
      { hangup_cause: 'normal_clearing' }
    );
    if (!res.ok) fail(`call.hangup(leg2, winner) rejected: ${res.status} ${await res.text()}`);
    await new Promise((r) => setTimeout(r, 500));

    const sessionState = (
      await psql(`select state from public.dial_sessions where id = '${sessionId}';`, dbUrl)
    ).trim();
    assertEqual('session reaches wrap_up after the winner hangs up', sessionState, 'wrap_up');

    // --- Final DB assertions: every lead's outcome is correct -------------------------------
    const leadRows = (
      await psql(
        `select id, status, attempts, last_outcome from public.campaign_leads where campaign_id = '${campaignId}' order by position;`,
        dbUrl
      )
    )
      .trim()
      .split('\n')
      .map((line) => line.split('|'));
    log('final_lead_rows', { leadRows });
    const [lead1, lead2, lead3, lead4] = leadRows;
    assertEqual(
      'lead1 (no_answer): queued, attempts=1',
      [lead1[1], lead1[2], lead1[3]],
      ['queued', '1', 'no_answer']
    );
    assertEqual(
      'lead2 (winner): still in_flight, attempts=1, last_outcome=connected',
      [lead2[1], lead2[2], lead2[3]],
      ['in_flight', '1', 'connected']
    );
    assertEqual(
      'lead3 (abandoned): queued, attempts=1',
      [lead3[1], lead3[2], lead3[3]],
      ['queued', '1', 'abandoned']
    );
    assertEqual(
      'lead4 (dropped): queued, attempts=0',
      [lead4[1], lead4[2], lead4[3]],
      ['queued', '0', 'dropped']
    );

    // By call_control_id, not `order by created_at` -- claim_next_leads (fix-forward item 1)
    // now inserts every leg from one refill in a single statement, so several legs can share
    // the exact same created_at (stable within one statement); relying on row order to infer
    // which leg is which broke this exact assertion when re-verifying the fix-forward live.
    const legOutcomes: string[] = [];
    for (const cc of [leg1, leg2, leg3, leg4]) {
      const outcome = (
        await psql(`select outcome from public.call_legs where call_control_id = '${cc}';`, dbUrl)
      ).trim();
      legOutcomes.push(outcome);
    }
    assertEqual('all 4 legs reached the expected outcome', legOutcomes, [
      'no_answer',
      'connected',
      'abandoned',
      'dropped',
    ]);

    // --- 6. resumeToDialing -------------------------------------------------------------------
    const supabase = createClient(
      apiUrl,
      env.SERVICE_ROLE_KEY ?? fail('SERVICE_ROLE_KEY not found')
    );
    const resumed = await resumeToDialing(supabase, orgId, sessionId);
    assertEqual('resumeToDialing succeeds from wrap_up', resumed, true);
    const stateAfterResume = (
      await psql(`select state from public.dial_sessions where id = '${sessionId}';`, dbUrl)
    ).trim();
    assertEqual('session back to dialing after resumeToDialing', stateAfterResume, 'dialing');

    // --- 7. TASK-P2-E2 fix-forward item 2: answered/hangup interleaved via two genuinely
    // concurrent requests -------------------------------------------------------------------
    const raceContactId = crypto.randomUUID();
    const raceLeadId = crypto.randomUUID();
    const racePhone = '+15550009999';
    await psql(
      `insert into public.contacts (id, org_id, user_id, first_name, phone_number)
       values ('${raceContactId}', '${orgId}', '${ownerId}', 'Race Contact', '${racePhone}');
       insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status)
       values ('${raceLeadId}', '${campaignId}', '${raceContactId}', '${orgId}', 'queued');`,
      dbUrl
    );
    await refillSession(supabase, orgId, sessionId);
    await new Promise((r) => setTimeout(r, 500));
    const raceLeg = mockCallControlIdForPhone(racePhone);
    const raceClientState = clientStateFor(raceLeg);
    log('race_leg_dialed', { raceLeg });

    // Fired via Promise.all, NOT awaited in sequence -- two real overlapping HTTP requests is
    // the only way this same-process script can produce a genuine interleaving (see this
    // file's header, and LANE-eng2.md's NEEDS-CONCURRENCY-VERIFY lesson). Whichever of
    // call.answered's amd_pending transition or call.hangup's ended transition commits first,
    // the loser's own transition_leg call used to be silently dropped -- applyLegTransition's
    // reload-and-retry means the leg still reaches a terminal state either way. This is a
    // best-effort real-concurrency exercise (the exact interleaving isn't forced
    // deterministically the way the SQL-level `for update` lock is in
    // run-dialer-concurrency-test.sh's scenario 2) -- said plainly, not overclaimed.
    const [raceAnsweredRes, raceHangupRes] = await Promise.all([
      sendWebhook(
        functionsUrl,
        orgId,
        keyPair,
        crypto.randomUUID(),
        'call.answered',
        raceLeg,
        raceClientState
      ),
      sendWebhook(
        functionsUrl,
        orgId,
        keyPair,
        crypto.randomUUID(),
        'call.hangup',
        raceLeg,
        raceClientState,
        { hangup_cause: 'normal_clearing' }
      ),
    ]);
    if (!raceAnsweredRes.ok)
      fail(
        `race call.answered rejected: ${raceAnsweredRes.status} ${await raceAnsweredRes.text()}`
      );
    if (!raceHangupRes.ok)
      fail(`race call.hangup rejected: ${raceHangupRes.status} ${await raceHangupRes.text()}`);
    await new Promise((r) => setTimeout(r, 800)); // let both async paths, and any retry, settle

    const raceLegRow = (
      await psql(
        `select state, outcome from public.call_legs where call_control_id = '${raceLeg}';`,
        dbUrl
      )
    )
      .trim()
      .split('|');
    log('race_scenario_result', { state: raceLegRow[0], outcome: raceLegRow[1] });
    assertEqual(
      'interleaved answered/hangup: the leg still reaches a terminal state, not stuck non-terminal',
      raceLegRow[0],
      'ended'
    );
    // 'normal_clearing' isn't one of hangupOutcome's explicit-mapped causes and this leg never
    // reached a claim/reject decision either way (amd_pending at worst) -- 'no_answer' is the
    // correct outcome regardless of which event's transition committed first.
    assertEqual(
      'interleaved answered/hangup: outcome is deterministic regardless of race ordering',
      raceLegRow[1],
      'no_answer'
    );

    console.log('\n[dialer-sim] ALL ASSERTIONS PASSED\n');
  } finally {
    await cleanup();
  }
}

main()
  .then(() => Deno.exit(0))
  .catch((err) => {
    console.error('[dialer-sim] SCRIPT FAILED:', err);
    Deno.exit(1);
  });

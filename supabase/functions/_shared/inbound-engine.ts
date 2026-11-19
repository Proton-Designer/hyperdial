/**
 * TASK-I1 (INB-1..4, CID-6): I/O orchestration for inbound callback routing -- built on
 * inbound-core.ts's pure decision logic, same split as dialer-core.ts/dialer-engine.ts.
 *
 * Design (full reasoning in decisions.md's TASK-I1 entry):
 * - Two correlation mechanisms, matching which leg an event is about:
 *   1. The ORIGINAL inbound leg (the caller): its call_control_id never changes for the whole
 *      call, and is stored on `inbound_calls.call_control_id` from the very first webhook --
 *      every later event on it (call.answered/call.hangup/call.speak.ended) is matched by
 *      looking that call_control_id straight up, no client_state needed.
 *   2. A fallback-step's OWN new leg (a `transfer` destination -- Leg B) or a per-command
 *      webhook with no call_control_id at all (call.recording.saved/error): matched by decoding
 *      `InboundClientState` from the event's `client_state` (see client-state.ts).
 * - The routing "plan" (inbound-core.ts's `planInboundSteps`) is never persisted -- it's
 *   recomputed fresh from org_members/org_inbound_settings/dial_sessions every time a step
 *   ends, and `inbound_calls.state` (the CURRENT step) plus that fresh plan is enough to find
 *   "what's next" (`nextInboundStep`). Nothing about the inputs changes mid-call.
 * - `dial_sessions` is paused (`pause_reason: 'inbound_call'`), not driven through
 *   on_call/wrap_up, while a caller is bridged into a session's conference -- a deliberate
 *   scope decision (decisions.md) to avoid widening call_legs' NOT NULL session_id/campaign_id
 *   for a flow that doesn't have either. The agent manually resumes dialing afterward, same as
 *   any other pause.
 */
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2';
import type { TelnyxClient } from './telnyx-client.ts';
import {
  encodeInboundClientState,
  decodeInboundClientState,
  type InboundCallStep as ClientStateStep,
} from './client-state.ts';
import {
  planInboundSteps,
  nextInboundStep,
  outcomeForEndedCall,
  isAgentBusyOnACall,
  isAgentInJoinableSession,
  isAgentOnline,
  isPlausibleE164,
  normalizeToE164,
  INBOUND_RING_TIMEOUT_SECS,
  type InboundStep,
  type InboundRoutingInputs,
} from './inbound-core.ts';
import { pauseSession, refillSession } from './dialer-engine.ts';

function inboundLog(step: string, meta: Record<string, unknown> = {}): void {
  console.log('[inbound-engine]', step, meta);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

type InboundCallDbState = 'ringing' | InboundStep | 'ended';

interface InboundCallRow {
  id: string;
  org_id: string;
  call_control_id: string;
  telnyx_call_leg_id: string | null;
  to_number_id: string | null;
  from_e164: string;
  contact_id: string | null;
  routed_to_user_id: string | null;
  dial_session_id: string | null;
  state: InboundCallDbState;
  outcome: string | null;
  answered_at: string | null;
  ended_at: string | null;
}

const INBOUND_CALL_COLUMNS =
  'id, org_id, call_control_id, telnyx_call_leg_id, to_number_id, from_e164, contact_id, ' +
  'routed_to_user_id, dial_session_id, state, outcome, answered_at, ended_at';

async function recordInboundWebhookEvent(
  supabase: SupabaseClient,
  args: { orgId: string; eventId: string; eventType: string; callControlId: string }
): Promise<boolean> {
  const { data, error } = await supabase.rpc('record_webhook_event', {
    p_org: args.orgId,
    p_event_id: args.eventId,
    p_event_type: args.eventType,
    p_call_control_id: args.callControlId || null,
  });
  if (error) throw new Error(`record_webhook_event: ${error.message}`);
  return data === true;
}

async function loadInboundCallByCallControlId(
  supabase: SupabaseClient,
  callControlId: string
): Promise<InboundCallRow | null> {
  const { data } = await supabase
    .from('inbound_calls')
    .select(INBOUND_CALL_COLUMNS)
    .eq('call_control_id', callControlId)
    .maybeSingle();
  return (data as InboundCallRow | null) ?? null;
}

async function loadInboundCallById(
  supabase: SupabaseClient,
  id: string
): Promise<InboundCallRow | null> {
  const { data } = await supabase
    .from('inbound_calls')
    .select(INBOUND_CALL_COLUMNS)
    .eq('id', id)
    .maybeSingle();
  return (data as InboundCallRow | null) ?? null;
}

async function transitionInboundCall(
  supabase: SupabaseClient,
  args: {
    callControlId: string;
    expectedStates: InboundCallDbState[];
    newState: InboundCallDbState;
    fields?: Record<string, unknown>;
  }
): Promise<boolean> {
  const { data, error } = await supabase.rpc('transition_inbound_call', {
    p_call_control_id: args.callControlId,
    p_expected_states: args.expectedStates,
    p_new_state: args.newState,
    p_fields: args.fields ?? {},
  });
  if (error) throw new Error(`transition_inbound_call: ${error.message}`);
  return data === true;
}

/** Every input `planInboundSteps`/`nextInboundStep` need, freshly read. Nothing here is cached
 *  on the inbound_calls row -- see this file's header for why that's deliberate. */
async function buildRoutingInputs(
  supabase: SupabaseClient,
  orgId: string,
  routedToUserId: string | null
): Promise<InboundRoutingInputs> {
  const { data: settings } = await supabase
    .from('org_inbound_settings')
    .select('shared_destination_number')
    .eq('org_id', orgId)
    .maybeSingle();
  const hasSharedDestination = Boolean(settings?.shared_destination_number);

  if (!routedToUserId) {
    return {
      hasAssignedIntern: false,
      internBusyOnACall: false,
      joinableSessionId: null,
      internOnline: false,
      hasForwardNumber: false,
      hasSharedDestination,
    };
  }

  const { data: member } = await supabase
    .from('org_members')
    .select('forward_phone_number, last_seen_at')
    .eq('org_id', orgId)
    .eq('user_id', routedToUserId)
    .maybeSingle();

  const { data: session } = await supabase
    .from('dial_sessions')
    .select('id, state, pause_reason')
    .eq('org_id', orgId)
    .eq('agent_id', routedToUserId)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const sessionSnapshot = session
    ? {
        id: session.id as string,
        state: session.state as string,
        pauseReason: (session.pause_reason as string | null) ?? null,
      }
    : null;

  return {
    hasAssignedIntern: true,
    internBusyOnACall: isAgentBusyOnACall(sessionSnapshot),
    joinableSessionId: isAgentInJoinableSession(sessionSnapshot) ? sessionSnapshot!.id : null,
    internOnline: isAgentOnline(member?.last_seen_at ?? null),
    hasForwardNumber: Boolean(member?.forward_phone_number),
    hasSharedDestination,
  };
}

async function resolveInternSipUri(
  client: TelnyxClient,
  supabase: SupabaseClient,
  orgId: string,
  userId: string
): Promise<string | null> {
  const { data: member } = await supabase
    .from('org_members')
    .select('telnyx_credential_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  const credentialId = member?.telnyx_credential_id as string | null | undefined;
  if (!credentialId) return null;
  try {
    const credential = (await client.getTelephonyCredential(credentialId)) as {
      sip_username?: string;
    };
    if (!credential.sip_username) return null;
    return `sip:${credential.sip_username}@sip.telnyx.com`;
  } catch (err) {
    inboundLog('resolve_intern_sip_uri_failed', { orgId, userId, error: String(err) });
    return null;
  }
}

async function loadOrgInboundGreeting(
  supabase: SupabaseClient,
  orgId: string
): Promise<{ sharedDestinationNumber: string | null; greetingText: string }> {
  const [{ data: settings }, { data: org }] = await Promise.all([
    supabase
      .from('org_inbound_settings')
      .select('shared_destination_number, voicemail_greeting_text')
      .eq('org_id', orgId)
      .maybeSingle(),
    supabase.from('orgs').select('name').eq('id', orgId).maybeSingle(),
  ]);
  const template =
    settings?.voicemail_greeting_text ?? "You've reached {org_name}. Please leave a message.";
  const greetingText = template.replaceAll('{org_name}', (org?.name as string | undefined) ?? 'us');
  return {
    sharedDestinationNumber: (settings?.shared_destination_number as string | null) ?? null,
    greetingText,
  };
}

/** Issues the Telnyx command for `step` and persists the transition INTO it. Never throws past
 *  this function on a routing-side failure (e.g. the intern has no telephony credential at all)
 *  -- that's treated as "this step can't actually be attempted," advancing to the next one
 *  immediately, same as a real ring timeout would, rather than leaving the caller stuck. */
/** TASK-H36: voicemail's own ceiling (Telnyx record_start max_length), so a caller who just stays
 *  on the line cannot hold a recording open indefinitely. */
const INBOUND_VOICEMAIL_MAX_SECS = 120;

/** TASK-H36: enterStep pauses the agent's dial session (pause_reason 'inbound_call') BEFORE the
 *  caller is answered/joined. On every path where the caller never actually reaches the agent
 *  (answer/join failure, no conference, caller hung up first, reaper) the agent never had a
 *  conversation, so put the session back to dialing. Guarded: only a session that is paused FOR
 *  an inbound call, and only when no OTHER open bridging_session row still uses it. After a real
 *  conversation nothing calls this -- the agent resumes with the Resume button as before. */
export async function resumeInboundPausedSession(
  supabase: SupabaseClient,
  orgId: string,
  inboundCallId: string,
  sessionId: string | null
): Promise<boolean> {
  if (!sessionId) return false;
  const { data: others } = await supabase
    .from('inbound_calls')
    .select('id')
    .eq('dial_session_id', sessionId)
    .eq('state', 'bridging_session')
    .neq('id', inboundCallId)
    .limit(1);
  if ((others ?? []).length > 0) return false;
  // Same result as the Resume button (dialer-session-resume -> resumeToDialing: state 'dialing',
  // pause_reason cleared, then refill; that endpoint makes no presence check either), but with an
  // atomic guard on pause_reason so it can only undo OUR pause.
  // Same result as the Resume button (dialer-session-resume -> resumeToDialing: state 'dialing',
  // pause_reason cleared, then refill; that endpoint makes no presence check either), but with an
  // atomic guard on pause_reason so it can only undo OUR pause.
  const { data, error } = await supabase
    .from('dial_sessions')
    .update({ state: 'dialing', pause_reason: null })
    .eq('id', sessionId)
    .eq('org_id', orgId)
    .eq('state', 'paused')
    .eq('pause_reason', 'inbound_call')
    .select('id');
  if (error) {
    inboundLog('resume_inbound_session_failed', { inboundCallId, sessionId, error: error.message });
    return false;
  }
  if ((data ?? []).length === 0) return false;
  inboundLog('resume_inbound_session', { inboundCallId, sessionId });
  try {
    await refillSession(supabase, orgId, sessionId);
  } catch (err) {
    inboundLog('resume_inbound_session_refill_failed', { sessionId, error: String(err) });
  }
  return true;
}

async function enterStep(
  supabase: SupabaseClient,
  client: TelnyxClient,
  args: {
    orgId: string;
    inboundCallId: string;
    callControlId: string;
    toE164: string;
    fromE164: string;
    routedToUserId: string | null;
    joinableSessionId: string | null;
  },
  step: InboundStep,
  fromState: InboundCallDbState
): Promise<void> {
  const ok = await transitionInboundCall(supabase, {
    callControlId: args.callControlId,
    expectedStates: [fromState],
    newState: step,
    // answered_at: reaching bridging_session sets dial_session_id; leaving it for a step that is
    // NOT voicemail means nobody connected, so clear the answered_at the bridging answer wrote
    // (otherwise a caller hang-up during the next ring is mislabelled 'forwarded').
    fields:
      step === 'bridging_session'
        ? { dial_session_id: args.joinableSessionId }
        : fromState === 'bridging_session'
          ? { answered_at: step === 'voicemail' ? new Date().toISOString() : null }
          : {},
  });
  if (!ok) {
    inboundLog('enter_step_cas_lost', { inboundCallId: args.inboundCallId, step, fromState });
    return;
  }
  inboundLog('enter_step', { inboundCallId: args.inboundCallId, step });

  // TASK-H36: the row is already CAS'd into `step` above, so a command that THROWS (e.g. Telnyx
  // 422 on a malformed forward number) would otherwise leave the row parked in `step` forever
  // and the caller ringing into nothing. Any failure here advances to the next step instead;
  // the chain always ends in voicemail, and voicemail's own failure ends the call as missed.
  const failAndAdvance = async (reason: string, err: unknown): Promise<void> => {
    inboundLog('step_command_failed', {
      inboundCallId: args.inboundCallId,
      step,
      reason,
      error: String(err).slice(0, 300),
    });
    // A transfer that failed with a timeout / network / 5xx error may still have started Leg B;
    // advancing would ring a SECOND destination too. Only a definitive 4xx rejection advances;
    // otherwise leave the row to Leg B's own events or the reaper.
    if (reason === 'transfer' && !/failed \(4\d\d\)/.test(String(err))) {
      inboundLog('transfer_outcome_unknown_not_advancing', {
        inboundCallId: args.inboundCallId,
        step,
      });
      return;
    }
    // Guard on state: if another event already moved the row, do not advance it again.
    const current = await loadInboundCallById(supabase, args.inboundCallId);
    if (!current || current.state !== step) {
      inboundLog('step_command_failed_state_moved', { inboundCallId: args.inboundCallId, step });
      return;
    }
    if (step === 'voicemail') {
      await failVoicemail(supabase, client, args);
      return;
    }
    await advanceInboundCall(supabase, client, args, step);
  };

  if (step === 'bridging_session') {
    if (!args.joinableSessionId) {
      inboundLog('bridging_session_no_joinable_session', { inboundCallId: args.inboundCallId });
      await advanceInboundCall(supabase, client, args, step);
      return;
    }
    // Review fix (eng1 review-eng1.md finding #4): pauseSession's CAS (expects
    // ['dialing','ready']) can lose the race -- e.g. a concurrent second inbound call, or the
    // intern's own session having moved on between buildRoutingInputs' read and this write. The
    // return value was previously discarded, so a lost CAS still fell through to answering and
    // joining the caller into whatever conference_id the session happened to have, unconditionally.
    // Treat a lost CAS exactly like "no joinable session" -- advance past this step instead.
    const paused = await pauseSession(supabase, args.orgId, args.joinableSessionId, 'inbound_call');
    if (!paused) {
      inboundLog('bridging_session_pause_cas_lost', {
        inboundCallId: args.inboundCallId,
        joinableSessionId: args.joinableSessionId,
      });
      await advanceInboundCall(supabase, client, args, step);
      return;
    }
    try {
      await client.answer(args.callControlId);
    } catch (err) {
      await failAndAdvance('answer', err);
    }
    return;
  }

  if (step === 'ringing_intern') {
    let sipUri: string | null = null;
    try {
      sipUri = args.routedToUserId
        ? await resolveInternSipUri(client, supabase, args.orgId, args.routedToUserId)
        : null;
    } catch (err) {
      await failAndAdvance('resolve_sip_uri', err);
      return;
    }
    if (!sipUri) {
      inboundLog('ringing_intern_no_sip_uri', { inboundCallId: args.inboundCallId });
      await advanceInboundCall(supabase, client, args, step);
      return;
    }
    // `from: args.fromE164` (the real caller), not the org's own number -- TransferCallRequest.
    // from is "the caller id presented to the destination," and real call-forwarding always
    // shows the original caller, not the forwarding line, so the intern's incoming-call banner
    // (Dialer.tsx/useTelnyxCall.ts) shows who's actually calling.
    try {
      await client.transfer(args.callControlId, {
        to: sipUri,
        from: args.fromE164,
        timeoutSecs: INBOUND_RING_TIMEOUT_SECS,
        targetLegClientState: encodeInboundClientState({
          org: args.orgId,
          inbound: args.inboundCallId,
          step: 'intern',
        }),
      });
    } catch (err) {
      await failAndAdvance('transfer', err);
    }
    return;
  }

  if (step === 'ringing_cell' || step === 'ringing_shared') {
    const { data: member } = args.routedToUserId
      ? await supabase
          .from('org_members')
          .select('forward_phone_number')
          .eq('org_id', args.orgId)
          .eq('user_id', args.routedToUserId)
          .maybeSingle()
      : { data: null };
    const { sharedDestinationNumber } = await loadOrgInboundGreeting(supabase, args.orgId);
    const rawTo =
      step === 'ringing_cell'
        ? ((member?.forward_phone_number as string | null) ?? null)
        : sharedDestinationNumber;
    // TASK-H36: a stored number that isn't E.164 ("8305635638") made Telnyx answer 422 10016 --
    // normalise at use time; a value that cannot be normalised is treated as "no destination".
    const to = normalizeToE164(rawTo);
    if (!to) {
      inboundLog(rawTo ? 'ringing_step_invalid_destination' : 'ringing_step_no_destination', {
        inboundCallId: args.inboundCallId,
        step,
      });
      await advanceInboundCall(supabase, client, args, step);
      return;
    }
    try {
      await client.transfer(args.callControlId, {
        to,
        from: args.fromE164,
        timeoutSecs: INBOUND_RING_TIMEOUT_SECS,
        targetLegClientState: encodeInboundClientState({
          org: args.orgId,
          inbound: args.inboundCallId,
          step: step === 'ringing_cell' ? 'cell' : 'shared',
        }),
      });
    } catch (err) {
      await failAndAdvance('transfer', err);
    }
    return;
  }

  // step === 'voicemail'
  if (fromState === 'bridging_session') {
    // The caller's leg is ALREADY answered (bridging answered it, e.g. the conference join then
    // failed): a second `answer` would 422 and drop a caller who was answered. Greet them with
    // speak (carrying the voicemail client_state); call.speak.ended then starts the recording.
    try {
      const { greetingText } = await loadOrgInboundGreeting(supabase, args.orgId);
      await client.speak(args.callControlId, {
        payload: greetingText,
        voice: 'female',
        client_state: encodeInboundClientState({
          org: args.orgId,
          inbound: args.inboundCallId,
          step: 'voicemail',
        }),
      });
    } catch (err) {
      await failAndAdvance('speak', err);
    }
    return;
  }
  try {
    await client.answer(args.callControlId, {
      clientState: encodeInboundClientState({
        org: args.orgId,
        inbound: args.inboundCallId,
        step: 'voicemail',
      }),
    });
  } catch (err) {
    await failAndAdvance('answer', err);
  }
}

/** TASK-H36: the end of the chain failed (voicemail could not be answered / spoken / recorded):
 *  nothing left to try, so end the row as missed (fires the Inbox trigger) and hang the caller
 *  up best-effort instead of leaving them on a dead line. */
async function failVoicemail(
  supabase: SupabaseClient,
  client: TelnyxClient,
  args: { inboundCallId: string; callControlId: string }
): Promise<void> {
  await endInboundCall(supabase, {
    inboundCallId: args.inboundCallId,
    callControlId: args.callControlId,
    fromState: 'voicemail',
    lastStep: 'voicemail',
    connected: false,
  });
  try {
    await client.hangup(args.callControlId);
  } catch (err) {
    inboundLog('voicemail_failure_hangup_failed', {
      inboundCallId: args.inboundCallId,
      error: String(err).slice(0, 200),
    });
  }
}

/** Computes fresh routing inputs, finds the next step after `currentStep` (or the FIRST step,
 *  when `currentStep` is null), and either enters it or ends the call (voicemail exhausted). */
export async function advanceInboundCall(
  supabase: SupabaseClient,
  client: TelnyxClient,
  args: {
    orgId: string;
    inboundCallId: string;
    callControlId: string;
    toE164: string;
    fromE164: string;
    routedToUserId: string | null;
    joinableSessionId: string | null;
  },
  currentStep: InboundStep | null
): Promise<void> {
  if (currentStep === 'bridging_session') {
    // Leaving bridging_session without a conversation (see resumeInboundPausedSession).
    const current = await loadInboundCallById(supabase, args.inboundCallId);
    await resumeInboundPausedSession(
      supabase,
      args.orgId,
      args.inboundCallId,
      current?.dial_session_id ?? null
    );
  }
  const inputs = await buildRoutingInputs(supabase, args.orgId, args.routedToUserId);
  const nextStep =
    currentStep === null ? planInboundSteps(inputs)[0] : nextInboundStep(currentStep, inputs);
  const fromState: InboundCallDbState = currentStep ?? 'ringing';

  if (!nextStep) {
    await endInboundCall(supabase, {
      inboundCallId: args.inboundCallId,
      callControlId: args.callControlId,
      fromState,
      lastStep: currentStep ?? 'voicemail',
      connected: false,
    });
    return;
  }

  await enterStep(
    supabase,
    client,
    { ...args, joinableSessionId: inputs.joinableSessionId },
    nextStep,
    fromState
  );
}

async function endInboundCall(
  supabase: SupabaseClient,
  args: {
    inboundCallId: string;
    callControlId: string;
    fromState: InboundCallDbState;
    lastStep: InboundStep;
    connected: boolean;
    durationSeconds?: number;
  }
): Promise<void> {
  const outcome = outcomeForEndedCall({ lastStep: args.lastStep, connected: args.connected });
  const ok = await transitionInboundCall(supabase, {
    callControlId: args.callControlId,
    expectedStates: [args.fromState],
    newState: 'ended',
    fields: {
      outcome,
      ended_at: new Date().toISOString(),
      ...(args.durationSeconds !== undefined ? { duration_seconds: args.durationSeconds } : {}),
    },
  });
  if (!ok) {
    inboundLog('end_inbound_call_cas_lost', { inboundCallId: args.inboundCallId });
    return;
  }
  inboundLog('inbound_call_ended', { inboundCallId: args.inboundCallId, outcome });

  const row = await loadInboundCallById(supabase, args.inboundCallId);
  if (row?.contact_id) {
    await enqueueInboundCallNoteJob(supabase, row);
  }
}

async function enqueueInboundCallNoteJob(
  supabase: SupabaseClient,
  row: InboundCallRow
): Promise<void> {
  let agentName: string | null = null;
  if (row.routed_to_user_id) {
    // Same `public.profiles` lookup submit_disposition's own SQL uses for its GHL note
    // (20260924002200_dispositions.sql) -- org_members has no display-name column at all.
    const { data: profile } = await supabase
      .from('profiles')
      .select('first_name, last_name')
      .eq('user_id', row.routed_to_user_id)
      .maybeSingle();
    const name = [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim();
    agentName = name || null;
  }
  const durationSeconds =
    row.answered_at && row.ended_at
      ? Math.max(
          0,
          Math.round(
            (new Date(row.ended_at).getTime() - new Date(row.answered_at).getTime()) / 1000
          )
        )
      : 0;

  const { error } = await supabase.rpc('enqueue_crm_job', {
    p_org: row.org_id,
    p_kind: 'inbound_call_note',
    p_contact_id: row.contact_id,
    p_call_leg_id: row.id,
    p_payload: {
      from_e164: row.from_e164,
      outcome: row.outcome,
      agent_name: agentName,
      duration_seconds: durationSeconds,
      recording_url: null,
      // MISSION-4 TASK-T2 (GHL-11/16): the real call time, not "now" -- this job can be retried
      // well after the call itself. ended_at first (the call is over by the time this note job
      // is enqueued at all -- see this function's own call site), answered_at as a fallback for
      // the unusual case ended_at is somehow unset.
      occurred_at: row.ended_at ?? row.answered_at ?? null,
    },
  });
  if (error)
    inboundLog('enqueue_inbound_call_note_failed', { inboundCallId: row.id, error: error.message });
}

/** The very first event for a brand-new inbound call: no client_state at all, direction
 *  incoming, state parked (see receiving-webhooks.md's own example payload). */
export async function handleFreshInboundCall(
  supabase: SupabaseClient,
  client: TelnyxClient,
  args: { orgId: string; eventId: string; callControlId: string; payload: Record<string, unknown> }
): Promise<void> {
  const isNew = await recordInboundWebhookEvent(supabase, {
    orgId: args.orgId,
    eventId: args.eventId,
    eventType: 'call.initiated',
    callControlId: args.callControlId,
  });
  if (!isNew) {
    inboundLog('fresh_inbound_call_dedup_skip', { eventId: args.eventId });
    return;
  }

  const toE164 = asString(args.payload.to);
  const fromE164 = asString(args.payload.from);
  const telnyxCallLegId = asString(args.payload.call_leg_id);

  const { data: routeRows } = await supabase.rpc('pick_inbound_route', {
    p_org_id: args.orgId,
    p_to_e164: toE164,
  });
  const route = (
    (routeRows ?? []) as { number_id: string | null; assigned_user_id: string | null }[]
  )[0];

  let contactId: string | null = null;
  if (isPlausibleE164(fromE164)) {
    const { data: contact } = await supabase
      .from('contacts')
      .select('id')
      .eq('org_id', args.orgId)
      .eq('phone_number', fromE164)
      .maybeSingle();
    contactId = (contact?.id as string | undefined) ?? null;
  }

  const { data: inserted, error } = await supabase
    .from('inbound_calls')
    .insert({
      org_id: args.orgId,
      call_control_id: args.callControlId,
      telnyx_call_leg_id: telnyxCallLegId || null,
      to_number_id: route?.number_id ?? null,
      from_e164: fromE164,
      contact_id: contactId,
      routed_to_user_id: route?.assigned_user_id ?? null,
      state: 'ringing',
    })
    .select('id')
    .single();
  if (error) throw new Error(`inbound_calls insert: ${error.message}`);
  const inboundCallId = inserted.id as string;
  inboundLog('fresh_inbound_call_created', {
    inboundCallId,
    toE164,
    fromE164,
    routedToUserId: route?.assigned_user_id ?? null,
  });

  await advanceInboundCall(
    supabase,
    client,
    {
      orgId: args.orgId,
      inboundCallId,
      callControlId: args.callControlId,
      toE164,
      fromE164,
      routedToUserId: route?.assigned_user_id ?? null,
      joinableSessionId: null,
    },
    null
  );
}

/** Events on the ORIGINAL leg, matched by call_control_id (see this file's header). Covers both
 *  the bridging_session path (answer -> join conference) and the voicemail sub-flow (answer ->
 *  speak -> record_start), plus the caller hanging up at any point. */
export async function handleOriginalLegEvent(
  supabase: SupabaseClient,
  client: TelnyxClient,
  args: {
    orgId: string;
    eventId: string;
    eventType: string;
    callControlId: string;
    payload: Record<string, unknown>;
  },
  row: InboundCallRow
): Promise<void> {
  const isNew = await recordInboundWebhookEvent(supabase, {
    orgId: args.orgId,
    eventId: args.eventId,
    eventType: args.eventType,
    callControlId: args.callControlId,
  });
  if (!isNew) return;

  if (args.eventType === 'call.hangup') {
    if (row.state === 'ended') return; // already finalized by some other event; nothing to do.
    if (row.state === 'bridging_session' && !row.answered_at) {
      // Caller left before being joined: the agent never had a conversation.
      await resumeInboundPausedSession(supabase, args.orgId, row.id, row.dial_session_id);
    }
    // The caller hung up -- whatever step we were on never (or already did) connect. If it
    // already connected (answered_at set: e.g. mid-voicemail-recording, or bridged into a
    // session/Leg B and the CALLER left first), this IS the normal end of that connection, not
    // a failure to reach it.
    await endInboundCall(supabase, {
      inboundCallId: row.id,
      callControlId: args.callControlId,
      fromState: row.state,
      lastStep: row.state === 'ringing' ? 'voicemail' : (row.state as InboundStep),
      connected: Boolean(row.answered_at),
      durationSeconds: row.answered_at
        ? Math.max(0, Math.round((Date.now() - new Date(row.answered_at).getTime()) / 1000))
        : undefined,
    });
    return;
  }

  // TASK-H36: an ORIGINAL-leg call.answered while we are ringing a fallback target means the
  // transfer connected, even if Leg B's own call.answered was lost. Recorded once. Deliberately
  // NOT call.bridged: live data shows Telnyx sends call.bridged on a transfer leg that never
  // connects (the intern SIP leg: initiated -> bridged -> hangup within ~1 s, no answered), and
  // treating that as a connection would end the call as answered_by_agent without trying the cell.
  if (
    args.eventType === 'call.answered' &&
    (row.state === 'ringing_intern' ||
      row.state === 'ringing_cell' ||
      row.state === 'ringing_shared')
  ) {
    if (!row.answered_at) {
      await transitionInboundCall(supabase, {
        callControlId: args.callControlId,
        expectedStates: [row.state],
        newState: row.state,
        fields: { answered_at: new Date().toISOString() },
      });
    }
    return;
  }

  if (args.eventType === 'call.answered') {
    if (row.state === 'bridging_session') {
      await transitionInboundCall(supabase, {
        callControlId: args.callControlId,
        expectedStates: ['bridging_session'],
        newState: 'bridging_session',
        fields: { answered_at: new Date().toISOString() },
      });
      const fresh = await loadInboundCallById(supabase, row.id);
      const { data: session } = fresh?.dial_session_id
        ? await supabase
            .from('dial_sessions')
            .select('conference_id')
            .eq('id', fresh.dial_session_id)
            .maybeSingle()
        : { data: null };
      const conferenceId = session?.conference_id as string | null | undefined;
      if (!conferenceId) {
        inboundLog('bridging_session_no_conference_id', { inboundCallId: row.id });
        await advanceInboundCall(
          supabase,
          client,
          {
            orgId: args.orgId,
            inboundCallId: row.id,
            callControlId: args.callControlId,
            toE164: asString(args.payload.to) || row.from_e164,
            fromE164: row.from_e164,
            routedToUserId: row.routed_to_user_id,
            joinableSessionId: null,
          },
          'bridging_session'
        );
        return;
      }
      try {
        await client.joinConference(conferenceId, { callControlId: args.callControlId });
      } catch (err) {
        // TASK-H36: the caller is answered but cannot be put in the agent's conference -- fall
        // through to the next step (cell/shared/voicemail) rather than leaving them on hold.
        inboundLog('bridging_session_join_failed', {
          inboundCallId: row.id,
          error: String(err).slice(0, 300),
        });
        await advanceInboundCall(
          supabase,
          client,
          {
            orgId: args.orgId,
            inboundCallId: row.id,
            callControlId: args.callControlId,
            toE164: asString(args.payload.to) || row.from_e164,
            fromE164: row.from_e164,
            routedToUserId: row.routed_to_user_id,
            joinableSessionId: null,
          },
          'bridging_session'
        );
      }
      return;
    }
    if (row.state === 'voicemail') {
      const { greetingText } = await loadOrgInboundGreeting(supabase, args.orgId);
      await transitionInboundCall(supabase, {
        callControlId: args.callControlId,
        expectedStates: ['voicemail'],
        newState: 'voicemail',
        fields: { answered_at: new Date().toISOString() },
      });
      try {
        await client.speak(args.callControlId, { payload: greetingText, voice: 'female' });
      } catch (err) {
        inboundLog('voicemail_speak_failed', {
          inboundCallId: row.id,
          error: String(err).slice(0, 300),
        });
        await failVoicemail(supabase, client, {
          inboundCallId: row.id,
          callControlId: args.callControlId,
        });
      }
      return;
    }
    return;
  }

  if (args.eventType === 'call.speak.ended' && row.state === 'voicemail') {
    try {
      await client.recordStart(args.callControlId, {
        channels: 'single',
        maxLengthSecs: INBOUND_VOICEMAIL_MAX_SECS,
        clientState: encodeInboundClientState({
          org: args.orgId,
          inbound: row.id,
          step: 'voicemail',
        }),
      });
    } catch (err) {
      inboundLog('voicemail_record_failed', {
        inboundCallId: row.id,
        error: String(err).slice(0, 300),
      });
      await failVoicemail(supabase, client, {
        inboundCallId: row.id,
        callControlId: args.callControlId,
      });
    }
    return;
  }

  inboundLog('original_leg_event_unhandled', { eventType: args.eventType, state: row.state });
}

/** Events correlated by decoded InboundClientState: a fallback step's Leg B answering or
 *  hanging up (intern/cell/shared), or a recording webhook for the voicemail leg (which carries
 *  no call_control_id at all -- see recording-core.ts's own header). */
export async function handleClientStateEvent(
  supabase: SupabaseClient,
  client: TelnyxClient,
  args: {
    orgId: string;
    eventId: string;
    eventType: string;
    callControlId: string;
    payload: Record<string, unknown>;
  },
  clientState: { org: string; inbound: string; step: ClientStateStep }
): Promise<void> {
  const isNew = await recordInboundWebhookEvent(supabase, {
    orgId: args.orgId,
    eventId: args.eventId,
    eventType: args.eventType,
    callControlId: args.callControlId,
  });
  if (!isNew) return;

  const row = await loadInboundCallById(supabase, clientState.inbound);
  if (!row || row.org_id !== args.orgId) {
    inboundLog('client_state_event_no_row_or_org_mismatch', { inboundCallId: clientState.inbound });
    return;
  }

  if (args.eventType === 'call.recording.saved' || args.eventType === 'call.recording.error') {
    await processInboundRecordingEvent(supabase, args, row);
    return;
  }

  // intern/cell/shared: events on Leg B, the fallback target -- never on the original leg.
  const mappedStep: InboundStep =
    clientState.step === 'intern'
      ? 'ringing_intern'
      : clientState.step === 'cell'
        ? 'ringing_cell'
        : 'ringing_shared';
  if (row.state !== mappedStep) {
    inboundLog('client_state_event_state_mismatch', {
      inboundCallId: row.id,
      expected: mappedStep,
      actual: row.state,
    });
    return;
  }

  if (args.eventType === 'call.answered') {
    // Leg B picked up -- Telnyx has ALREADY bridged it to the original leg (that's what
    // `transfer` does; no separate bridge command needed). The call is now live; stay in
    // `mappedStep` and just record when it connected -- the eventual hangup (of EITHER leg)
    // is what finalizes the row, matched by whichever leg's own event arrives first.
    if (row.answered_at) return; // already recorded (by the other leg's event); idempotent
    await transitionInboundCall(supabase, {
      callControlId: row.call_control_id,
      expectedStates: [mappedStep],
      newState: mappedStep,
      fields: { answered_at: new Date().toISOString() },
    });
    return;
  }

  if (args.eventType === 'call.hangup') {
    if (row.answered_at) {
      // The live bridged call just ended -- Leg B's own hangup, not a failure to reach it.
      await endInboundCall(supabase, {
        inboundCallId: row.id,
        callControlId: row.call_control_id,
        fromState: row.state,
        lastStep: mappedStep,
        connected: true,
        durationSeconds: Math.max(
          0,
          Math.round((Date.now() - new Date(row.answered_at).getTime()) / 1000)
        ),
      });
      return;
    }
    // Leg B never answered (rang out / rejected) -- the ORIGINAL leg is still parked and live
    // per TransferCallRequest's own docs ("the original call will remain active"). Advance it.
    await advanceInboundCall(
      supabase,
      client,
      {
        orgId: args.orgId,
        inboundCallId: row.id,
        callControlId: row.call_control_id,
        toE164: asString(args.payload.to) || row.from_e164,
        fromE164: row.from_e164,
        routedToUserId: row.routed_to_user_id,
        joinableSessionId: null,
      },
      mappedStep
    );
    return;
  }

  inboundLog('client_state_event_unhandled', { eventType: args.eventType, step: clientState.step });
}

async function processInboundRecordingEvent(
  supabase: SupabaseClient,
  args: { eventType: string; payload: Record<string, unknown> },
  row: InboundCallRow
): Promise<void> {
  if (args.eventType === 'call.recording.error') {
    await transitionInboundCall(supabase, {
      callControlId: row.call_control_id,
      expectedStates: ['voicemail', 'ended'],
      newState: row.state,
      fields: { recording_status: 'recording_failed' },
    });
    return;
  }

  const recordingUrls = (args.payload.recording_urls ?? {}) as Record<string, unknown>;
  const mp3Url = asString(recordingUrls.mp3);
  const telnyxCallLegId = asString(args.payload.call_leg_id);
  const startedAt = asString(args.payload.recording_started_at);
  const endedAt = asString(args.payload.recording_ended_at);
  let durationSeconds: number | null = null;
  if (startedAt && endedAt) {
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();
    if (!Number.isNaN(durationMs)) durationSeconds = Math.max(0, Math.round(durationMs / 1000));
  }

  if (!mp3Url) {
    await transitionInboundCall(supabase, {
      callControlId: row.call_control_id,
      expectedStates: ['voicemail', 'ended'],
      newState: row.state,
      fields: {
        recording_status: 'download_failed',
        recording_telnyx_call_leg_id: telnyxCallLegId || null,
        recording_duration_seconds: durationSeconds,
      },
    });
    return;
  }

  try {
    const res = await fetch(mp3Url);
    if (!res.ok) throw new Error(`recording download failed: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const path = `${row.org_id}/inbound/${row.id}.mp3`;
    const { error: uploadError } = await supabase.storage
      .from('recordings')
      .upload(path, bytes, { contentType: 'audio/mpeg', upsert: true });
    if (uploadError) throw new Error(uploadError.message);

    await transitionInboundCall(supabase, {
      callControlId: row.call_control_id,
      expectedStates: ['voicemail', 'ended'],
      newState: row.state,
      fields: {
        recording_status: 'saved',
        recording_path: path,
        recording_duration_seconds: durationSeconds,
        recording_telnyx_call_leg_id: telnyxCallLegId || null,
      },
    });
  } catch (err) {
    await transitionInboundCall(supabase, {
      callControlId: row.call_control_id,
      expectedStates: ['voicemail', 'ended'],
      newState: row.state,
      fields: {
        recording_status: 'download_failed',
        recording_telnyx_call_leg_id: telnyxCallLegId || null,
        recording_duration_seconds: durationSeconds,
      },
    });
    inboundLog('inbound_recording_download_failed', { inboundCallId: row.id, error: String(err) });
  }
}

/** Top-level dispatcher -- telnyx-webhook/index.ts calls this for every call.* event that
 *  either decodes an InboundClientState for this org, or is a genuinely fresh inbound
 *  call.initiated (see this file's header for the two correlation mechanisms). */
export async function processTelnyxInboundEvent(
  supabase: SupabaseClient,
  client: TelnyxClient,
  raw: {
    orgId: string;
    eventId: string;
    eventType: string;
    callControlId: string;
    payload: Record<string, unknown>;
    inboundClientState: { org: string; inbound: string; step: ClientStateStep } | null;
  }
): Promise<void> {
  const byOriginalLeg = await loadInboundCallByCallControlId(supabase, raw.callControlId);
  if (byOriginalLeg) {
    if (byOriginalLeg.org_id !== raw.orgId) {
      inboundLog('original_leg_org_mismatch', { inboundCallId: byOriginalLeg.id });
      return;
    }
    await handleOriginalLegEvent(supabase, client, raw, byOriginalLeg);
    return;
  }

  if (raw.inboundClientState) {
    await handleClientStateEvent(supabase, client, raw, raw.inboundClientState);
    return;
  }

  if (raw.eventType === 'call.initiated' && raw.payload.direction === 'incoming') {
    await handleFreshInboundCall(supabase, client, {
      orgId: raw.orgId,
      eventId: raw.eventId,
      callControlId: raw.callControlId,
      payload: raw.payload,
    });
    return;
  }

  inboundLog('unhandled_inbound_event', {
    eventType: raw.eventType,
    callControlId: raw.callControlId,
  });
}

export type { InboundCallRow };

// ---------------------------------------------------------------------------
// TASK-H36 round 2: reaper for stuck inbound rows (called by dialer-sweeper)
// ---------------------------------------------------------------------------

/** A never-answered row is stale after this (3 x 20 s rings + the voicemail answer fit well inside). */
export const INBOUND_UNANSWERED_STALE_SECS = 180;
/** Answered rows: a voicemail recording is capped at INBOUND_VOICEMAIL_MAX_SECS, so 10 min is far
 *  past it; anything else (forwarded / bridged conversation) can legitimately run long. */
export const INBOUND_VOICEMAIL_STALE_SECS = 600;
export const INBOUND_ANSWERED_STALE_SECS = 1800;
/** An UNANSWERED row Telnyx still reports alive this long after it started is dead weight. */
export const INBOUND_RINGING_HANGUP_AFTER_SECS = 600;

interface StaleInboundRow {
  id: string;
  org_id: string;
  call_control_id: string;
  state: InboundCallDbState;
  answered_at: string | null;
  created_at: string;
  dial_session_id: string | null;
}

export interface InboundReapResult {
  checked: number;
  ended: number;
  hungUp: number;
  leftAlive: number;
  unknown: number;
}

/** The rule (lead, round 2): NEVER hang up or end a call Telnyx says is still alive. Each stale
 *  open row is checked with GET /calls/{id} (is_alive) using the org's own key:
 *   - not alive (or 404) -> end the row (missed if never answered, else its connected outcome);
 *   - alive              -> leave it, unless it never connected and has been ringing/parked for
 *                           more than 10 minutes (then hang up + end as missed);
 *   - Telnyx error / unknown / no key -> leave it and log. */
export async function reapStaleInboundCalls(
  supabase: SupabaseClient,
  resolveClient: (orgId: string) => Promise<TelnyxClient | null>
): Promise<InboundReapResult> {
  const result: InboundReapResult = { checked: 0, ended: 0, hungUp: 0, leftAlive: 0, unknown: 0 };
  const { data, error } = await supabase.rpc('list_stale_inbound_calls', {
    p_unanswered_after_seconds: INBOUND_UNANSWERED_STALE_SECS,
    p_voicemail_after_seconds: INBOUND_VOICEMAIL_STALE_SECS,
    p_answered_after_seconds: INBOUND_ANSWERED_STALE_SECS,
  });
  if (error) {
    inboundLog('list_stale_inbound_calls_failed', { error: error.message });
    return result;
  }
  for (const row of (data ?? []) as StaleInboundRow[]) {
    result.checked++;
    const client = await resolveClient(row.org_id).catch(() => null);
    if (!client) {
      result.unknown++;
      inboundLog('reap_inbound_no_client', { inboundCallId: row.id });
      continue;
    }
    const status = await client.getCallStatus(row.call_control_id).catch(() => null);
    if (!status) {
      result.unknown++;
      inboundLog('reap_inbound_status_unknown', { inboundCallId: row.id });
      continue;
    }
    if (status.isAlive) {
      const ageSecs = (Date.now() - new Date(row.created_at).getTime()) / 1000;
      // Only a row that was never routed ('ringing') or never got its voicemail answer
      // ('voicemail', unanswered) may be hung up. ringing_intern/cell/shared and bridging_session
      // can hold a LIVE conversation whose answer webhook was lost, so an alive call there is
      // always left alone (and logged), however old.
      const hangupable = !row.answered_at && (row.state === 'ringing' || row.state === 'voicemail');
      if (!(hangupable && ageSecs > INBOUND_RINGING_HANGUP_AFTER_SECS)) {
        result.leftAlive++;
        inboundLog('reap_inbound_left_alive', { inboundCallId: row.id, state: row.state });
        continue;
      }
      try {
        await client.hangup(row.call_control_id);
        result.hungUp++;
      } catch (err) {
        inboundLog('reap_inbound_hangup_failed', { inboundCallId: row.id, error: String(err) });
      }
    }
    const { data: outcome, error: endError } = await supabase.rpc('end_stale_inbound_call', {
      p_id: row.id,
    });
    if (endError) {
      inboundLog('end_stale_inbound_call_failed', {
        inboundCallId: row.id,
        error: endError.message,
      });
      continue;
    }
    if (!outcome) continue; // lost the race to a real event: already ended
    result.ended++;
    inboundLog('reap_inbound_ended', { inboundCallId: row.id, state: row.state, outcome });
    if (row.state === 'bridging_session') {
      await resumeInboundPausedSession(supabase, row.org_id, row.id, row.dial_session_id);
    }
  }
  return result;
}

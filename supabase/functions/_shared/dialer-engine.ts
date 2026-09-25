/**
 * The org-scoped dial engine (TASK-P2-E2): rolling refill, single-winner claim, AMD
 * toggle, webhook-driven leg lifecycle -- built on dialer-core.ts's pure decision logic
 * (TASK-P2-E0) and the E1 RPCs (claim_next_leads/claim_leg/transition_leg/
 * transition_session/apply_leg_outcome/record_webhook_event). This REPLACES the previous
 * contents of this file (the legacy Redis/dialer_sessions/call_logs engine) entirely --
 * that legacy engine is gone, not kept alongside. The legacy `dialer_sessions`/`call_logs`
 * TABLES stay untouched (design's own instruction: nothing in this lane writes to them
 * anymore, they just aren't dropped).
 *
 * Design decisions made while building this (mirrored in LANE-eng2.md and
 * .brain/domains/dialer.md -- read those for the "why", this header is the "what"):
 *
 * - (Historical, TASK-P2-E2) No agent leg existed yet at this point -- `refillCount`'s
 *   agent-leg gate was bypassed via `DIALER_DEV_SKIP_AGENT_GATE=true` (server env, dev/test
 *   only). TASK-L1 removes that flag entirely and builds the real agent leg -- see this
 *   file's TASK-L1 header paragraph below.
 * - `hungUpByEngine` (dialer-core's `hangupOutcome` needs it) has no DB column -- derived
 *   at hangup-processing time instead: true iff the session's `active_leg_id` already
 *   names a DIFFERENT leg (some other leg already won, so this leg's hangup was
 *   necessarily commanded by the engine), or the session is already past
 *   dialing/connecting. See `hungUpByEngineFor` below for why this covers every real case
 *   (the winner's own hangup and an AMD-machine hangup both short-circuit inside
 *   `hangupOutcome` via the leg's own state before `hungUpByEngine` is ever consulted).
 * - Two independent paths can resolve a losing leg to 'abandoned'/'dropped', both guarded
 *   by `transition_leg`'s expected-state check so whichever gets there first wins and the
 *   other is a safe no-op: (1) `handleWin`, right after the winner is decided, proactively
 *   resolves every OTHER active leg from a snapshot; (2) a losing leg's OWN
 *   call.answered/detection-ended event, if it happens to arrive independently, resolves
 *   itself via the normal per-event `legTransition` dispatch. `dropped` is never produced
 *   by `legTransition` itself (grep it -- it only appears as a LEG_STATES/LEG_OUTCOMES
 *   member and in `hangupOutcome`'s preserve-a-prior-decision check) -- it is always set
 *   directly by the engine (path 1), exactly for this reason.
 * - Conference: create it (winner as first participant) on the session's first ever
 *   winner; join it on every winner after that. `dial_sessions.conference_id` is the
 *   marker.
 * - "dialer-session-resume or equivalent returns the session to dialing" (task spec) is
 *   deliberately NOT a new HTTP endpoint -- no such function is in this task's file list.
 *   `resumeToDialing` below calls `transition_session` directly; Phase 3's dispositions
 *   submission is the real caller once it exists, and this task's own functions-serve
 *   acceptance script calls it directly to prove the rolling loop across a wrap_up cycle.
 *
 * TASK-L1 (agent audio leg): removes the DIALER_DEV_SKIP_AGENT_GATE bypass entirely and
 * builds the real thing it stood in for. `startSession` no longer jumps straight to
 * 'dialing' -- it inserts the session as 'ready_pending' (the schema's own default) and
 * dials the agent's WebRTC credential SIP URI (`dialAgentLeg`, "Go Ready"). The agent leg's
 * own `call.answered` webhook (`processAgentLegEvent`, a NEW branch that replaces the old
 * "agent legs don't exist yet, skip" no-op) creates the session's conference around the
 * agent leg (first time) and cascades ready_pending -> ready -> dialing, then calls
 * refillSession for the first time -- this is the only place dialing ever starts now.
 * `handleWin` needed NO change: it already had an if(!conferenceId) create / else join
 * branch: since the agent leg creates the conference before any contact is ever dialed, the
 * create branch is now dead in the normal path (kept as a defensive fallback, not deleted --
 * still correct if conference_id is ever unset for any reason).
 * `agentLegTransition` (dialer-core.ts) is the agent leg's own tiny state machine --
 * deliberately NOT `legTransition`, which is wired to AMD/claim decisions that never apply to
 * the agent's own leg. Agent-leg-lost (`call.hangup` on the agent leg) moves the session to
 * `paused_agent_lost` and hangs up every active contact leg EXCEPT a `claimed` one (the one
 * invariant the task spec states explicitly: a live, bridged contact is never hung up for an
 * agent-leg problem) -- reusing `legTransition`'s own `hungUpByEngine` hangupOutcome bucketing
 * for the ones that DO get hung up, exactly the same dropped/abandoned split as every other
 * engine-initiated hangup in this file. `reconnectAgentLeg` (the UI's Reconnect button) redials
 * a FRESH agent leg into the SAME conference; the resulting `call.answered` runs through the
 * exact same `processAgentLegEvent` cascade, ending in `on_call` if a contact is still
 * `claimed` (rejoins the live call) or `dialing` (+ an immediate refill) if not.
 *
 * Fix-forward (lead's diff-read on the first version of this file, plus eng1's review of the
 * fix -- both folded in here rather than kept as a separate pass):
 * - The overdial race: `refillSession` used to compute "room for N more" in TS from its own
 *   read of the active-leg count, then ask `claim_next_leads` for that many. Two concurrent
 *   refills for the same session (two leg-end webhooks landing at once) could each compute
 *   the same stale room and together dial past `lines`. `claim_next_leads` (see its
 *   migration) now does the capacity check AND inserts each new leg's placeholder
 *   `call_legs` row itself, under a `dial_sessions` row lock held for the whole call -- the
 *   TS side no longer decides "how many", only "dial whatever came back". `refillCount`'s
 *   local `activeLegs`-based count is now only a fast-path hint to skip the RPC call
 *   entirely when there's obviously no room, never the source of truth for how many to dial.
 * - Lost terminal events on a race loss: `applyLegTransition` below reloads the leg and
 *   retries the decision (bounded, 3 attempts) instead of just dropping the event when
 *   `transition_leg`'s expected-state check fails. A dropped event that would have been
 *   THIS leg's own terminal transition (most notably its own `call.hangup` racing a
 *   concurrent AMD/claim decision) used to leave the leg stuck non-terminal forever --
 *   retrying against the leg's now-current state fixes that while staying a safe no-op for
 *   every case where the race loss really was final (the reloaded state makes
 *   `legTransition` return null).
 * - Double abandon-message send: the loser dispatch below gates on `result.outcome ===
 *   'abandoned'`, not `result.next === 'abandoned'`. `call.speak.ended`'s own no-op
 *   confirmation (leg already 'abandoned', "no state change, the engine issues the hangup
 *   next") also has `next: 'abandoned'` but no `outcome` -- gating on `next` fired
 *   `sendAbandonMessage` a second time on that confirmation event.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import {
  legTransition,
  agentLegTransition,
  amdDecision,
  refillCount,
  loserActions,
  type LegState,
  type SessionState,
  type TelnyxDialerEvent,
  type AmdMode as CoreAmdMode,
  type DialerLeg,
  type AmdStandardResult,
  type AmdPremiumResult,
  type HangupCause,
} from './dialer-core.ts';
import { encodeDialClientState, type DialClientState } from './client-state.ts';
import { getConnectedOrgTelnyxContext } from './telnyx-org-context.ts';
import { webhookUrlForOrg } from './telnyx-provision.ts';
import { getOrCreateMemberCredentialId } from './agent-webrtc-credential.ts';
import type { TelnyxClient } from './telnyx-client.ts';

function dialerLog(step: string, meta: Record<string, unknown> = {}): void {
  console.log('[dialer-engine]', step, meta);
}

/** TASK-L1: the session-identifying custom SIP header on the agent leg's own dial (belt-and-
 *  suspenders alongside client_state{kind:'agent'} -- see telnyx-client.ts's DialArgs header
 *  comment for the spec citation). Not read anywhere server-side; the browser's incoming-call
 *  handler is the reader (useTelnyxCall.ts). */
const AGENT_SESSION_HEADER_NAME = 'X-Hyperdial-Session';

/** CallRequest.time_limit_secs for every CONTACT dial (BUG-8) -- see telnyx-client.ts's
 *  DialArgs header comment for the spec citation. Not applied to the agent leg dial, which
 *  keeps Telnyx's own 4h default (an agent shift, not a parallel-dial candidate). Exported
 *  (TASK-L6) so dialer-sweeper-core.ts's own hard-timeout check uses this SAME value, not an
 *  independently-maintained copy that could drift out of sync with the actual dial. */
export const CONTACT_DIAL_TIME_LIMIT_SECS = 1800;

function webhookBaseUrl(): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-webhook`;
}

/** A real, spec-listed AWS Polly neural voice (spec3.json's own example of the -Neural suffix
 *  pattern for the Speak Request's `voice` field) -- not a made-up "female"/"male" value. */
const DEFAULT_SPEAK_VOICE = 'AWS.Polly.Joanna-Neural';

function abandonMessage(orgName: string | null): string {
  return `Sorry, we missed you${orgName ? ` at ${orgName}` : ''}. We'll try to reach you again soon.`;
}

// ---------------------------------------------------------------------------
// Row shapes (only the columns this module actually reads/writes)
// ---------------------------------------------------------------------------

interface DialSessionRow {
  id: string;
  org_id: string;
  campaign_id: string;
  agent_id: string;
  state: SessionState;
  lines: number;
  amd_mode: CoreAmdMode;
  agent_leg_id: string | null;
  active_leg_id: string | null;
  conference_id: string | null;
  /** TASK-L1 review fix M4: the session state right before an agent-lost transition, so
   *  Reconnect's cascade can tell "was manually paused" apart from "was rolling dialing" --
   *  see the migration's own header for why this is only used for the `paused` case. */
  paused_agent_lost_from: string | null;
}

interface CampaignRow {
  id: string;
  org_id: string;
  name: string;
  abandon_message_enabled: boolean;
  caller_id_number_id: string | null;
}

interface CallLegRow {
  id: string;
  org_id: string;
  session_id: string;
  campaign_id: string;
  contact_id: string | null;
  lead_id: string | null;
  kind: 'contact' | 'agent';
  call_control_id: string;
  state: LegState;
}

const SESSION_COLUMNS =
  'id, org_id, campaign_id, agent_id, state, lines, amd_mode, agent_leg_id, active_leg_id, conference_id, paused_agent_lost_from';
const LEG_COLUMNS =
  'id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state';

async function loadSession(
  supabase: SupabaseClient,
  sessionId: string
): Promise<DialSessionRow | null> {
  const { data, error } = await supabase
    .from('dial_sessions')
    .select(SESSION_COLUMNS)
    .eq('id', sessionId)
    .maybeSingle();
  if (error) throw new Error(`loadSession: ${error.message}`);
  return data as DialSessionRow | null;
}

async function loadCampaign(
  supabase: SupabaseClient,
  campaignId: string
): Promise<CampaignRow | null> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('id, org_id, name, abandon_message_enabled, caller_id_number_id')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) throw new Error(`loadCampaign: ${error.message}`);
  return data as CampaignRow | null;
}

async function loadActiveLegs(supabase: SupabaseClient, sessionId: string): Promise<CallLegRow[]> {
  const { data, error } = await supabase
    .from('call_legs')
    .select(LEG_COLUMNS)
    .eq('session_id', sessionId)
    .neq('state', 'ended');
  if (error) throw new Error(`loadActiveLegs: ${error.message}`);
  return (data ?? []) as CallLegRow[];
}

async function loadLegByCallControlIdOrClientLeg(
  supabase: SupabaseClient,
  callControlId: string,
  clientStateLegId: string
): Promise<CallLegRow | null> {
  const byControlId = await supabase
    .from('call_legs')
    .select(LEG_COLUMNS)
    .eq('call_control_id', callControlId)
    .maybeSingle();
  if (byControlId.error) throw new Error(`loadLeg: ${byControlId.error.message}`);
  if (byControlId.data) return byControlId.data as CallLegRow;

  // Fallback: dial()'s call_control_id update to the real value hasn't landed yet -- a race
  // that shouldn't happen (dial() is awaited before any webhook could fire) but this is
  // cheap insurance. client_state.leg is always the row's true id regardless.
  const byId = await supabase
    .from('call_legs')
    .select(LEG_COLUMNS)
    .eq('id', clientStateLegId)
    .maybeSingle();
  if (byId.error) throw new Error(`loadLeg fallback: ${byId.error.message}`);
  return (byId.data as CallLegRow) ?? null;
}

async function loadOrgName(supabase: SupabaseClient, orgId: string): Promise<string | null> {
  const { data } = await supabase.from('orgs').select('name').eq('id', orgId).maybeSingle();
  return (data?.name as string | undefined) ?? null;
}

async function resolvedFromNumber(
  supabase: SupabaseClient,
  orgId: string,
  campaign: CampaignRow
): Promise<string | null> {
  if (!campaign.caller_id_number_id) return null;
  const { data } = await supabase
    .from('user_phone_numbers')
    .select('phone_number')
    .eq('id', campaign.caller_id_number_id)
    .eq('org_id', orgId)
    .maybeSingle();
  return (data?.phone_number as string | undefined) ?? null;
}

/** TASK-L1: reads the REAL agent leg's state -- no bypass. `refillCount`'s gate (dialer-
 *  core.ts) stays shut until this genuinely reads 'answered', which only happens once the
 *  agent leg's own call.answered webhook has been processed (see processAgentLegEvent). */
async function agentLegStateFor(
  supabase: SupabaseClient,
  session: DialSessionRow
): Promise<LegState> {
  if (!session.agent_leg_id) return 'initiated';
  const { data } = await supabase
    .from('call_legs')
    .select('state')
    .eq('id', session.agent_leg_id)
    .maybeSingle();
  return (data?.state as LegState | undefined) ?? 'initiated';
}

function toTelnyxAmdMode(mode: CoreAmdMode): 'off' | 'premium' {
  return mode === 'on' ? 'premium' : 'off';
}

/** TASK-L1: the agent's own WebRTC credential SIP URI, per design's own text ("dial the
 *  member's WebRTC credential SIP URI... sip:<credential sip_username>@sip.telnyx.com").
 *
 *  Review fix (B1): this used to only READ `org_members.telnyx_credential_id` and throw
 *  `AGENT_NOT_REGISTERED` if it was still null -- but that column is only ever set by the
 *  BROWSER's own `getWebrtcCredentials` call, and the browser only starts trying to connect
 *  after it learns a session exists, i.e. after `dialer-session-start` (which calls this)
 *  already returned. There was no possible ordering where a first-time member's credential
 *  already existed -- every first Start failed. Now uses the same get-or-create
 *  (`_shared/agent-webrtc-credential.ts`) the browser's own endpoint uses, so the credential
 *  and the dial no longer depend on the browser having connected first. The browser still
 *  needs to actually be listening for the auto-answer itself to work -- that remains a
 *  disclosed, separate timing gap (NOT-done in the task log), not something this function can
 *  fix on its own. */
async function agentSipUri(
  supabase: SupabaseClient,
  client: TelnyxClient,
  orgId: string,
  agentId: string,
  credentialConnectionId: string | null
): Promise<string> {
  if (!credentialConnectionId) {
    throw new Error(
      'Telnyx is connected but has no WebRTC credential connection on record for this org.'
    );
  }
  const credentialId = await getOrCreateMemberCredentialId(
    client,
    supabase,
    orgId,
    agentId,
    credentialConnectionId
  );
  const credential = await client.getTelephonyCredential(credentialId);
  const sipUsername = credential.sip_username as string | undefined;
  if (!sipUsername) {
    throw new Error('Telnyx returned no sip_username for the agent credential.');
  }
  return `sip:${sipUsername}@sip.telnyx.com`;
}

// ---------------------------------------------------------------------------
// Starting a session and the rolling refill loop
// ---------------------------------------------------------------------------

export async function startSession(
  supabase: SupabaseClient,
  args: { orgId: string; campaignId: string; agentId: string; lines: number; amdMode: CoreAmdMode }
): Promise<{ sessionId: string }> {
  // TASK-L1: 'ready_pending' (the schema's own default), not 'dialing' -- dialing must not
  // start until the agent leg is answered and in the conference. dialAgentLeg (Go Ready)
  // below is what actually gets it there; refillSession only ever runs from
  // processAgentLegEvent's answered branch now, never from here.
  const { data, error } = await supabase
    .from('dial_sessions')
    .insert({
      org_id: args.orgId,
      campaign_id: args.campaignId,
      agent_id: args.agentId,
      state: 'ready_pending',
      lines: args.lines,
      amd_mode: args.amdMode,
    })
    .select('id')
    .single();
  if (error) {
    // SEC-8: dial_sessions_one_active_per_agent (partial unique index on agent_id, live
    // migration) -- the caller (dialer-session-start) maps this specific error to a 409, the
    // same TOCTOU-fallback shape as the pre-existing "deleted campaign" mapping just below.
    // Review fix (m2): detect by the Postgres SQLSTATE (`23505` unique_violation) via
    // PostgrestError's own `.code`, not a message substring -- the message's exact wording/
    // constraint-name inclusion isn't a contract, the error code is.
    if (error.code === '23505') {
      throw new Error('ACTIVE_SESSION_EXISTS_FOR_AGENT');
    }
    throw new Error(`startSession: ${error.message}`);
  }
  if (!data) throw new Error('startSession: insert failed');
  const sessionId = data.id as string;
  dialerLog('session_started', { sessionId, orgId: args.orgId, campaignId: args.campaignId });
  await dialAgentLeg(supabase, args.orgId, sessionId);
  return { sessionId };
}

/**
 * "Go Ready" (TASK-L1 spec item 1): dials the agent's own WebRTC credential SIP URI from the
 * session's own row (called once, from startSession, right after insert -- session.state is
 * still 'ready_pending'). Inserts the agent's call_legs row and points
 * dial_sessions.agent_leg_id at it BEFORE dialing, same placeholder-then-overwrite shape as
 * every contact dial (dialLead) -- a dial failure below still leaves a real, terminable row
 * behind, never a phantom reference.
 *
 * Bridging into a conference and cascading ready_pending -> ready -> dialing happens later,
 * asynchronously, in processAgentLegEvent once this leg's own call.answered webhook lands --
 * this function only ever dials, it never itself changes session.state.
 */
export async function dialAgentLeg(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<void> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId) return;
  await dialAgentLegInternal(supabase, orgId, session);
}

/**
 * The Reconnect button (TASK-L1 spec item 5): only valid from 'paused_agent_lost'. Dials a
 * FRESH agent leg (the old one is 'ended') into the SAME conference -- processAgentLegEvent's
 * answered branch does the actual join once it answers, and decides on_call-vs-dialing there
 * based on whether a contact leg is still `claimed`.
 */
export async function reconnectAgentLeg(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<{ ok: boolean; reason?: string }> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId) return { ok: false, reason: 'not_found' };
  if (session.state !== 'paused_agent_lost') {
    return { ok: false, reason: 'not_paused_agent_lost' };
  }
  // Review fix (M2, partial): `transition_session`'s CAS is on `state`, which stays
  // 'paused_agent_lost' for the ENTIRE reconnect attempt (it only changes once the new leg
  // answers) -- it cannot by itself stop two concurrent Reconnect clicks (or two open tabs)
  // from both passing the check above and each dialing a fresh agent leg. This closes the
  // common case by refusing outright if the session's own (old) agent leg is still non-
  // terminal -- i.e. a reconnect is already in flight. Not a perfect atomic CAS (a narrow
  // TOCTOU window remains between this check and the new leg's own insert+link), said
  // plainly rather than silently assumed fixed.
  if (session.agent_leg_id) {
    const { data: currentAgentLeg } = await supabase
      .from('call_legs')
      .select('state')
      .eq('id', session.agent_leg_id)
      .maybeSingle();
    if (currentAgentLeg && currentAgentLeg.state !== 'ended') {
      return { ok: false, reason: 'reconnect_already_in_flight' };
    }
  }
  await dialAgentLegInternal(supabase, orgId, session);
  return { ok: true };
}

/**
 * Review fix (B1): every step here used to throw OUTSIDE any catch except the final
 * `client.dial()` call -- a failure in the Telnyx-context lookup, the campaign/caller-ID
 * lookup, `agentSipUri`, or even the leg INSERT itself propagated straight up with no
 * cleanup, leaving the session stranded in `ready_pending` forever (and, with SEC-8's unique
 * index live, every later Start for that agent then hit a 409 against a session that could
 * never be recovered). The whole body is now one try/catch; ANY failure terminates whatever
 * leg row exists and, if this was the initial Go Ready, stops the session outright so the
 * agent can retry from a clean state instead of being stuck.
 *
 * Review fix (M1): `dial_sessions.agent_leg_id` is now linked in the SAME step as the leg
 * INSERT, before `client.dial()` ever runs -- not after, with a CAS on the pre-dial session
 * state. The old post-dial link raced a fast `call.answered` webhook two ways: (1)
 * `refillSession` reading `agent_leg_id` (still null) saw no agent leg and refilled zero; (2)
 * if the session's OWN state had already moved on by the time the post-dial link ran (because
 * `handleAgentLegAnswered` doesn't check `agent_leg_id` linkage before cascading -- see M2), the
 * link's CAS lost the race and the code hung up the agent's own live, just-answered leg as an
 * "orphan". Linking before dialing removes the window entirely -- by the time Telnyx could
 * possibly deliver any webhook for this leg, `agent_leg_id` already points at it.
 */
async function dialAgentLegInternal(
  supabase: SupabaseClient,
  orgId: string,
  session: DialSessionRow
): Promise<void> {
  let legId: string | null = null;
  let placeholderCallControlId: string | null = null;
  let dialedCallControlId: string | null = null;
  try {
    const { client, callControlAppId, credentialConnectionId, error } =
      await getConnectedOrgTelnyxContext(supabase, orgId);
    if (error || !client || !callControlAppId) {
      throw new Error('Telnyx is not connected for this org.');
    }

    const campaign = await loadCampaign(supabase, session.campaign_id);
    if (!campaign) throw new Error(`dialAgentLeg: campaign ${session.campaign_id} not found`);
    const fromNumber = await resolvedFromNumber(supabase, orgId, campaign);
    if (!fromNumber) throw new Error('dialAgentLeg: campaign has no caller ID number set');

    const sipUri = await agentSipUri(
      supabase,
      client,
      orgId,
      session.agent_id,
      credentialConnectionId
    );

    const { data: legRow, error: insertError } = await supabase
      .from('call_legs')
      .insert({
        org_id: orgId,
        session_id: session.id,
        campaign_id: session.campaign_id,
        kind: 'agent',
        call_control_id: `pending-agent-${crypto.randomUUID()}`,
        state: 'initiated',
      })
      .select('id, call_control_id')
      .single();
    if (insertError || !legRow) {
      throw new Error(`dialAgentLeg: agent leg insert failed: ${insertError?.message}`);
    }
    legId = legRow.id as string;
    placeholderCallControlId = legRow.call_control_id as string;

    const { data: linked, error: linkError } = await supabase.rpc('transition_session', {
      p_session: session.id,
      p_expected_states: [session.state],
      p_new_state: session.state,
      p_fields: { agent_leg_id: legId },
    });
    if (linkError) throw new Error(`dialAgentLeg link: ${linkError.message}`);
    if (!linked) {
      // The session moved on (e.g. an explicit Stop) between load and here -- never dial at
      // all; nothing will ever process this leg's events since agent_leg_id never pointed at
      // it. The catch block below terminates the (never-dialed) placeholder leg.
      throw new Error('dialAgentLeg: session moved on before the agent leg could be linked');
    }

    const clientState = encodeDialClientState({
      org: orgId,
      session: session.id,
      leg: legId,
      kind: 'agent',
    });
    const webhookUrl = webhookUrlForOrg(webhookBaseUrl(), orgId);

    const { callControlId } = await client.dial({
      connectionId: callControlAppId,
      to: sipUri,
      from: fromNumber,
      webhookUrl,
      clientState,
      timeoutSecs: 25,
      amdMode: 'off',
      customHeaders: [{ name: AGENT_SESSION_HEADER_NAME, value: session.id }],
    });
    dialedCallControlId = callControlId;
    const { error: updateError } = await supabase
      .from('call_legs')
      .update({ call_control_id: callControlId })
      .eq('id', legId);
    if (updateError) throw new Error(`dialAgentLeg update: ${updateError.message}`);
    dialerLog('dial_agent_leg_success', { sessionId: session.id, legId, callControlId });
  } catch (err) {
    dialerLog('dial_agent_leg_failed', {
      sessionId: session.id,
      legId,
      error: String(err),
    });
    if (legId) {
      // Terminate by whatever call_control_id is actually in the DB row right now (the
      // placeholder if dial() never ran or never returned, the real one if only the
      // post-dial UPDATE failed).
      const currentCallControlId = dialedCallControlId ?? placeholderCallControlId;
      if (currentCallControlId) {
        await supabase.rpc('transition_leg', {
          p_call_control_id: currentCallControlId,
          p_expected_states: ['initiated'],
          p_new_state: 'ended',
          p_fields: {
            outcome: 'failed',
            hangup_cause: 'unspecified',
            ended_at: new Date().toISOString(),
          },
        });
      }
      // If Telnyx actually accepted the dial but the DB update that would have let us find
      // it by its real id failed, still tell Telnyx to hang it up -- hangupLeg already
      // swallows its own errors (logs, never throws), safe to call unconditionally here.
      if (dialedCallControlId) {
        await hangupLeg(
          supabase,
          orgId,
          dialedCallControlId,
          'dial_agent_leg_cleanup_hangup_failed'
        );
      }
    }
    // No agent leg means no way forward for this session -- stop it outright rather than
    // leaving a phantom ready_pending row nobody can ever recover (Go Ready failing means the
    // caller's HTTP request itself fails; a failed Reconnect leaves the session in
    // paused_agent_lost, which already has its own Reconnect retry path -- don't stop THAT).
    if (session.state === 'ready_pending') {
      await supabase.rpc('transition_session', {
        p_session: session.id,
        p_expected_states: ['ready_pending'],
        p_new_state: 'stopped',
        p_fields: { ended_at: new Date().toISOString() },
      });
    }
    throw err;
  }
}

export async function refillSession(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<{ dialed: number }> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId) return { dialed: 0 };
  if (session.state !== 'dialing') {
    dialerLog('refill_skip_not_dialing', { sessionId, state: session.state });
    return { dialed: 0 };
  }

  const agentLegState = await agentLegStateFor(supabase, session);
  const activeLegs = await loadActiveLegs(supabase, sessionId);
  // TASK-L1 review-fix follow-on: loadActiveLegs is kind-agnostic by design (stopSession
  // relies on that to also hang up the agent leg) -- this fast-path hint is a CONTACT
  // capacity check (claim_next_leads' own RPC, the real source of truth, only ever counts
  // kind='contact' rows), so it needs the same filter or it silently double-counts the
  // agent's own leg as if it were a dialed contact. With `lines===1` (the narrowest, but real,
  // case) this made the hint compute exactly 0 the INSTANT the agent leg answered -- refill
  // would skip forever without ever calling claim_next_leads at all, so a single-line session
  // could never dial a single contact. Found by this task's own review-fix regression test
  // (B2's scenario), not by inspection.
  const activeContactLegs = activeLegs.filter((l) => l.kind === 'contact').length;
  const n = refillCount(session.state, agentLegState, session.lines, activeContactLegs);
  if (n <= 0) {
    dialerLog('refill_skip_zero', {
      sessionId,
      agentLegState,
      lines: session.lines,
      active: activeContactLegs,
    });
    return { dialed: 0 };
  }

  const campaign = await loadCampaign(supabase, session.campaign_id);
  if (!campaign) throw new Error(`refillSession: campaign ${session.campaign_id} not found`);
  const fromNumber = await resolvedFromNumber(supabase, orgId, campaign);
  if (!fromNumber) {
    dialerLog('refill_skip_no_caller_id', { sessionId, campaignId: campaign.id });
    return { dialed: 0 };
  }

  const { client, callControlAppId, error } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (error || !client || !callControlAppId) {
    dialerLog('refill_skip_not_connected', { sessionId, orgId });
    return { dialed: 0 };
  }

  // claim_next_leads now does its own capacity check AND inserts each new leg's placeholder
  // call_legs row atomically, under a dial_sessions row lock, in the same call (TASK-P2-E2
  // fix-forward item 1: the overdial race). `n` above is only a fast-path hint to skip this
  // RPC call entirely when we already know there's no room -- the RPC recomputes the real
  // capacity itself from a fresh, locked read, so a stale `n` here can never cause an
  // overdial even if this read raced with another refill.
  const { data: claimed, error: claimError } = await supabase.rpc('claim_next_leads', {
    p_session: sessionId,
  });
  if (claimError) throw new Error(`claim_next_leads: ${claimError.message}`);
  const legs = (claimed ?? []) as {
    leg_id: string;
    lead_id: string;
    contact_id: string;
    phone_number: string | null;
    call_control_id: string;
  }[];

  const webhookUrl = webhookUrlForOrg(webhookBaseUrl(), orgId);
  let dialed = 0;
  for (const leg of legs) {
    if (!leg.phone_number) {
      // The row already exists (claim_next_leads inserted it) -- terminate it now via the
      // normal RPCs so it doesn't sit as a phantom 'initiated' leg forever. In practice
      // contacts.phone_number is NOT NULL (TASK-P2-P1), so this is defensive, not expected.
      dialerLog('refill_skip_lead_no_phone', { sessionId, legId: leg.leg_id, leadId: leg.lead_id });
      await supabase.rpc('transition_leg', {
        p_call_control_id: leg.call_control_id,
        p_expected_states: ['initiated'],
        p_new_state: 'ended',
        p_fields: {
          outcome: 'no_answer',
          hangup_cause: 'unspecified',
          ended_at: new Date().toISOString(),
        },
      });
      await supabase.rpc('apply_leg_outcome', { p_leg: leg.leg_id });
      continue;
    }
    await dialLead(supabase, client, {
      orgId,
      sessionId,
      legId: leg.leg_id,
      placeholderCallControlId: leg.call_control_id,
      callControlAppId,
      fromNumber,
      webhookUrl,
      amdMode: session.amd_mode,
      leadId: leg.lead_id,
      phoneNumber: leg.phone_number,
    });
    dialed++;
  }
  dialerLog('refill_done', { sessionId, claimed: legs.length, dialed });
  return { dialed };
}

async function dialLead(
  supabase: SupabaseClient,
  client: TelnyxClient,
  args: {
    orgId: string;
    sessionId: string;
    legId: string;
    placeholderCallControlId: string;
    callControlAppId: string;
    fromNumber: string;
    webhookUrl: string;
    amdMode: CoreAmdMode;
    leadId: string;
    phoneNumber: string;
  }
): Promise<void> {
  // The call_legs row already exists (claim_next_leads inserted it, placeholder
  // call_control_id and all, under the session lock that closes the overdial race) -- this
  // function only ever dials and overwrites the placeholder, it never inserts.
  const clientState = encodeDialClientState({
    org: args.orgId,
    session: args.sessionId,
    leg: args.legId,
  });

  try {
    const { callControlId } = await client.dial({
      connectionId: args.callControlAppId,
      to: args.phoneNumber,
      from: args.fromNumber,
      webhookUrl: args.webhookUrl,
      clientState,
      timeoutSecs: 25,
      timeLimitSecs: CONTACT_DIAL_TIME_LIMIT_SECS,
      amdMode: toTelnyxAmdMode(args.amdMode),
    });
    const { error: updateError } = await supabase
      .from('call_legs')
      .update({ call_control_id: callControlId })
      .eq('id', args.legId);
    if (updateError) throw new Error(`dialLead update: ${updateError.message}`);
    dialerLog('dial_lead_success', {
      sessionId: args.sessionId,
      legId: args.legId,
      callControlId,
      leadId: args.leadId,
    });
  } catch (err) {
    // Telnyx rejected the dial outright (bad number, misconfigured connection, ...) -- the
    // leg never really started and nothing will ever send a webhook for a call_control_id
    // Telnyx never created. Terminate it now via the normal RPCs (never a raw UPDATE) so it
    // doesn't sit as a phantom 'initiated' leg forever. Outcome is 'no_answer' (retryable),
    // not 'failed' (permanent) -- the same "don't give up on a real prospect" bias as
    // amdDecision's/hangupOutcome's own unknown-value defaults; a dial-time exception could
    // just as easily be a transient config/API problem as a genuinely bad number.
    dialerLog('dial_lead_failed', {
      sessionId: args.sessionId,
      legId: args.legId,
      leadId: args.leadId,
      error: String(err),
    });
    await supabase.rpc('transition_leg', {
      p_call_control_id: args.placeholderCallControlId,
      p_expected_states: ['initiated'],
      p_new_state: 'ended',
      p_fields: {
        outcome: 'no_answer',
        hangup_cause: 'unspecified',
        ended_at: new Date().toISOString(),
      },
    });
    await supabase.rpc('apply_leg_outcome', { p_leg: args.legId });
  }
}

// ---------------------------------------------------------------------------
// Webhook event processing
// ---------------------------------------------------------------------------

export interface RawTelnyxEvent {
  orgId: string;
  eventId: string;
  eventType: string;
  callControlId: string;
  payload: Record<string, unknown>;
  clientState: DialClientState;
}

/** Maps Telnyx's raw event_type + payload to dialer-core's typed union. Field names
 *  (`result`, `hangup_cause`) verified against spec3.json -- see dialer-core.ts's header. */
function mapToDialerEvent(raw: RawTelnyxEvent): TelnyxDialerEvent | null {
  switch (raw.eventType) {
    case 'call.initiated':
      return { eventType: 'call.initiated' };
    case 'call.ringing':
      return { eventType: 'call.ringing' };
    case 'call.answered':
      return { eventType: 'call.answered' };
    case 'call.machine.detection.ended':
      return {
        eventType: 'call.machine.detection.ended',
        result: String(raw.payload.result ?? '') as AmdStandardResult,
      };
    case 'call.machine.premium.detection.ended':
      return {
        eventType: 'call.machine.premium.detection.ended',
        result: String(raw.payload.result ?? '') as AmdPremiumResult,
      };
    case 'call.speak.ended':
      return { eventType: 'call.speak.ended' };
    case 'call.hangup':
      return {
        eventType: 'call.hangup',
        hangupCause: String(raw.payload.hangup_cause ?? 'unspecified') as HangupCause,
      };
    default:
      // call.bridged, call.machine.greeting.ended, etc. -- not part of this leg's state
      // machine. Acked already by the caller; nothing more to do.
      return null;
  }
}

/** Which decision (if any) this event could resolve, so the caller knows whether to run
 *  claim_leg BEFORE calling legTransition (legTransition's own contract: it throws if a
 *  claim decision is reached with no ctx.claim supplied). */
function decisionFor(
  event: TelnyxDialerEvent,
  amdMode: CoreAmdMode
): 'claim' | 'reject' | 'wait' | null {
  if (event.eventType === 'call.answered') return amdDecision(amdMode, undefined);
  if (
    event.eventType === 'call.machine.detection.ended' ||
    event.eventType === 'call.machine.premium.detection.ended'
  ) {
    return amdDecision(amdMode, event.result);
  }
  return null;
}

/** See this file's header for the full reasoning. Only ever matters for a still-ringing/
 *  initiated loser's silent hangup and the session-stop cleanup path -- every other case
 *  (winner's own hangup, AMD-machine hangup, an already-abandoned/dropped loser's hangup)
 *  already short-circuits inside hangupOutcome via the leg's own state, before
 *  hungUpByEngine is ever consulted. */
function hungUpByEngineFor(session: DialSessionRow, leg: CallLegRow): boolean {
  if (session.active_leg_id && session.active_leg_id !== leg.id) return true;
  if (session.state !== 'dialing' && session.state !== 'connecting') return true;
  return false;
}

async function recordWebhookEvent(
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

/** Entry point for telnyx-webhook's inner processing. Dedupes, maps the event, loads the
 *  leg + session, and dispatches. Never throws for an unrecognized/no-op event -- only for
 *  a genuine DB/RPC failure (the webhook's outer handler already acked with 200 before this
 *  runs, per the ack-then-process shape, so a thrown error here is logged, not returned to
 *  Telnyx -- see telnyx-webhook/index.ts). */
export async function processTelnyxDialerEvent(
  supabase: SupabaseClient,
  raw: RawTelnyxEvent
): Promise<void> {
  const isNew = await recordWebhookEvent(supabase, raw);
  if (!isNew) {
    dialerLog('webhook_event_dedup_skip', { eventId: raw.eventId, eventType: raw.eventType });
    return;
  }

  const dialerEvent = mapToDialerEvent(raw);
  if (!dialerEvent) {
    dialerLog('webhook_event_unhandled', { eventType: raw.eventType });
    return;
  }

  const leg = await loadLegByCallControlIdOrClientLeg(
    supabase,
    raw.callControlId,
    raw.clientState.leg
  );
  if (!leg) {
    dialerLog('webhook_event_no_leg', {
      eventType: raw.eventType,
      callControlId: raw.callControlId,
    });
    return;
  }
  if (leg.org_id !== raw.orgId) {
    dialerLog('webhook_event_org_mismatch', { legOrg: leg.org_id, eventOrg: raw.orgId });
    return;
  }
  const session = await loadSession(supabase, leg.session_id);
  if (!session) {
    dialerLog('webhook_event_no_session', { legId: leg.id, sessionId: leg.session_id });
    return;
  }

  if (leg.kind === 'agent') {
    await processAgentLegEvent(supabase, session, leg, dialerEvent, raw.callControlId);
    return;
  }

  await processContactLegEvent(supabase, session, leg, dialerEvent);
}

/** Bounded retry count for `applyLegTransition`'s reload-and-retry on a race loss (TASK-P2-E2
 *  fix-forward item 2). 3 is generous for a single leg's event stream -- a leg only ever
 *  changes state a handful of times total, so a third consecutive race loss almost certainly
 *  means something is genuinely wrong, not just unlucky timing. */
const MAX_LEG_TRANSITION_RACE_RETRIES = 3;

/** Runs `legTransition` against `leg`'s CURRENT state and applies it via `transition_leg`. If
 *  another concurrent resolution of this same leg (webhook redelivery, or `handleWin`
 *  resolving it from the other direction -- see this file's header) wins the race first,
 *  this reloads the leg's now-current row and retries the decision against it, instead of
 *  just dropping the event. Silently dropping used to be safe for a NON-terminal race loss
 *  (the other resolution already covers it) but broke the "every leg reaches a terminal
 *  state" invariant when the dropped event was itself terminal (e.g. this leg's own
 *  call.hangup racing a concurrent AMD/claim decision) -- the leg would stay non-terminal
 *  forever. Returns null for a genuine no-op (the reloaded state means this event no longer
 *  applies at all) or after exhausting the retry budget. */
async function applyLegTransition(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow,
  event: TelnyxDialerEvent,
  claim: 'won' | 'lost' | undefined
): Promise<{ leg: CallLegRow; result: { next: LegState; outcome?: string } } | null> {
  let currentLeg = leg;
  for (let attempt = 1; attempt <= MAX_LEG_TRANSITION_RACE_RETRIES; attempt++) {
    const hungUpByEngine =
      event.eventType === 'call.hangup' ? hungUpByEngineFor(session, currentLeg) : false;
    const result = legTransition(currentLeg.state, event, {
      amdMode: session.amd_mode,
      claim,
      hungUpByEngine,
    });
    if (!result) {
      dialerLog('leg_transition_noop', {
        legId: currentLeg.id,
        current: currentLeg.state,
        eventType: event.eventType,
      });
      return null;
    }

    const fields: Record<string, unknown> = {};
    if (result.outcome) fields.outcome = result.outcome;
    if (event.eventType === 'call.answered') fields.answered_at = new Date().toISOString();
    if (result.next === 'claimed') fields.claimed_at = new Date().toISOString();
    if (event.eventType === 'call.hangup') {
      fields.hangup_cause = event.hangupCause;
      fields.ended_at = new Date().toISOString();
    }

    const { data: applied, error: transitionError } = await supabase.rpc('transition_leg', {
      p_call_control_id: currentLeg.call_control_id,
      p_expected_states: [currentLeg.state],
      p_new_state: result.next,
      p_fields: fields,
    });
    if (transitionError) throw new Error(`transition_leg: ${transitionError.message}`);
    if (applied) {
      dialerLog('leg_transition_applied', {
        legId: currentLeg.id,
        from: currentLeg.state,
        to: result.next,
        outcome: result.outcome,
      });
      return { leg: currentLeg, result };
    }

    dialerLog('leg_transition_race_lost', {
      legId: currentLeg.id,
      current: currentLeg.state,
      next: result.next,
      attempt,
    });
    if (attempt === MAX_LEG_TRANSITION_RACE_RETRIES) break;
    const reloaded = await loadLegByCallControlIdOrClientLeg(
      supabase,
      currentLeg.call_control_id,
      currentLeg.id
    );
    if (!reloaded) {
      dialerLog('leg_transition_race_leg_gone', { legId: currentLeg.id });
      return null;
    }
    currentLeg = reloaded;
  }
  dialerLog('leg_transition_race_exhausted', { legId: currentLeg.id, eventType: event.eventType });
  return null;
}

async function processContactLegEvent(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow,
  event: TelnyxDialerEvent
): Promise<void> {
  let claim: 'won' | 'lost' | undefined;
  const decision = decisionFor(event, session.amd_mode);
  if (decision === 'claim') {
    const { data: won, error } = await supabase.rpc('claim_leg', {
      p_session: session.id,
      p_leg: leg.id,
    });
    if (error) throw new Error(`claim_leg: ${error.message}`);
    claim = won ? 'won' : 'lost';
  }

  if (claim === 'won') {
    // claim_leg's own SQL already sets call_legs.state='claimed' + claimed_at as part of the
    // same atomic win (its own comment: "the winning leg is marked claimed in the same
    // call") -- found live: calling the generic legTransition + transition_leg(expected=[the
    // PRE-claim snapshot state]) path below for the won case always lost that race, since
    // claim_leg's write already landed inside the RPC call just above, before this function
    // ever reaches the transition_leg call. Only `outcome` is still missing; patch it in with
    // expected_states=['claimed'] (what claim_leg just produced), not the stale snapshot.
    const { data: applied, error: transitionError } = await supabase.rpc('transition_leg', {
      p_call_control_id: leg.call_control_id,
      p_expected_states: ['claimed'],
      p_new_state: 'claimed',
      p_fields: { outcome: 'connected' },
    });
    if (transitionError)
      throw new Error(`transition_leg (win outcome): ${transitionError.message}`);
    if (!applied) {
      dialerLog('leg_transition_race_lost', { legId: leg.id, current: 'claimed', next: 'claimed' });
      return;
    }
    dialerLog('leg_transition_applied', {
      legId: leg.id,
      from: leg.state,
      to: 'claimed',
      outcome: 'connected',
    });
    await handleWin(supabase, session, leg);
    return;
  }

  const applied = await applyLegTransition(supabase, session, leg, event, claim);
  if (!applied) return;
  const currentLeg = applied.leg;
  const result = applied.result;

  // Gate on `result.outcome`, not `result.next` -- both the REAL transition into 'abandoned'
  // (the claim/reject decision, which always carries outcome:'abandoned') and the harmless
  // call.speak.ended CONFIRMATION no-op (current already 'abandoned', legTransition returns
  // {next:'abandoned'} with no outcome, "no state change, the engine issues the hangup next")
  // share `next === 'abandoned'`. Checking `next` alone fired sendAbandonMessage a second time
  // on the confirmation event too -- TASK-P2-E2 fix-forward item 6 (eng1's review): every
  // abandoned leg got the "sorry we missed you" message spoken twice.
  //
  // `outcome === 'abandoned'` alone is NOT enough either (caught live re-verifying this fix):
  // hangupOutcome PRESERVES a leg's prior decision through to call.hangup, so the abandoned
  // leg's own eventual call.hangup also carries outcome:'abandoned', but with next:'ended' --
  // checking outcome alone stole that case into this branch instead of the `next === 'ended'`
  // one below, so apply_leg_outcome never ran and the lead's status/attempts never updated.
  // Both conditions together isolate exactly the one moment that should speak: next is still
  // 'abandoned' (leg is live, not yet hung up) AND outcome is freshly set (a real transition,
  // not the speak.ended echo).
  if (result.next === 'abandoned' && result.outcome === 'abandoned') {
    // This leg lost the claim on its OWN call.answered/detection-ended event racing in
    // independently of handleWin (see header). handleWin's own loser resolution already
    // skipped this leg (transition_leg would have returned applied=false there) if it got
    // here first -- so this is the other half of that race, issuing the abandon message.
    await sendAbandonMessage(supabase, session, currentLeg);
  } else if (result.next === 'machine') {
    await hangupLeg(supabase, session.org_id, currentLeg.call_control_id, 'machine_hangup_failed');
  } else if (result.next === 'ended') {
    await supabase.rpc('apply_leg_outcome', { p_leg: currentLeg.id });
    if (currentLeg.id === session.active_leg_id) {
      // The winner just ended -- wrap_up, no more refill until a disposition (or
      // resumeToDialing, for testing) returns the session to dialing.
      await supabase.rpc('transition_session', {
        p_session: session.id,
        p_expected_states: ['on_call', 'connecting'],
        p_new_state: 'wrap_up',
        p_fields: {},
      });
      dialerLog('session_wrap_up', { sessionId: session.id });
    } else if (session.state === 'dialing') {
      await refillSession(supabase, session.org_id, session.id);
    }
  }

  if (event.eventType === 'call.speak.ended' && result.next === 'abandoned') {
    // The abandon message finished playing -- now issue the actual hangup (dialer-core.ts's
    // own header comment: "the engine issues the actual hangup command next").
    await hangupLeg(
      supabase,
      session.org_id,
      currentLeg.call_control_id,
      'speak_ended_hangup_failed'
    );
  }
}

// ---------------------------------------------------------------------------
// Agent leg event processing (TASK-L1)
// ---------------------------------------------------------------------------

/** Every dial_sessions state the agent leg being lost/regained actually matters from -- the
 *  full "active" set minus the two terminal ones. Used both to move INTO paused_agent_lost
 *  (call.hangup) and to allow a same-state agent_leg_id link update (dialAgentLegInternal). */
const AGENT_ACTIVE_SESSION_STATES: SessionState[] = [
  'ready_pending',
  'ready',
  'dialing',
  'connecting',
  'on_call',
  'wrap_up',
  'paused',
];

/** Dispatches an agent leg's own webhook event. The agent leg never runs AMD or a claim
 *  decision -- `agentLegTransition` (dialer-core.ts) is its whole state machine.
 *
 *  Review fix (M2): ignores any event for a leg that is no longer `dial_sessions
 *  .agent_leg_id` -- a stale/duplicate/superseded agent leg's own webhook (redelivery, a
 *  race with Reconnect creating a fresh leg) must never touch a session it no longer speaks
 *  for. `session` is loaded fresh at webhook-dispatch time (`processTelnyxDialerEvent`), so
 *  this is always checked against the CURRENT linkage, not a stale snapshot. */
async function processAgentLegEvent(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow,
  event: TelnyxDialerEvent,
  rawCallControlId: string
): Promise<void> {
  if (leg.id !== session.agent_leg_id) {
    dialerLog('agent_leg_event_stale', {
      legId: leg.id,
      currentAgentLegId: session.agent_leg_id,
      eventType: event.eventType,
    });
    return;
  }
  if (event.eventType === 'call.answered') {
    await handleAgentLegAnswered(supabase, session, leg, rawCallControlId);
    return;
  }
  if (event.eventType === 'call.hangup') {
    await handleAgentLegLost(supabase, session, leg, event.hangupCause);
    return;
  }
  // call.initiated/call.ringing/anything else: no session-visible consequence for the agent
  // leg (contrast with a contact leg, where call.initiated still drives ringing -> claimed
  // ordering allowances in legTransition). agentLegTransition still accepts call.initiated
  // for completeness; nothing downstream needs that intermediate state persisted.
  dialerLog('agent_leg_event_ignored', { legId: leg.id, eventType: event.eventType });
}

/**
 * Review fix (B2): joining/creating the conference around the agent leg used to swallow a
 * failure and cascade to `ready`/`dialing` regardless. Telnyx conferences "expire once every
 * participant has left" -- an agent-lost with no live contact (e.g. a page refresh while
 * still `dialing`) leaves the conference with nobody in it, so a later Reconnect's
 * `joinConference` on that same, now-dead, id fails; swallowing that failure used to still
 * mark the session `ready`/`dialing` with NOTHING actually bridged -- the next contact winner
 * would join a dead conference and the customer would hear silence. Now: a failed join falls
 * back to creating a FRESH conference around the agent leg and persists the new id; only a
 * confirmed conference (created OR joined) lets the caller proceed. Returns null on total
 * failure -- the caller must not cascade to ready/dialing in that case.
 *
 * Review fix (M1 part 2): takes `agentCallControlId` (the raw webhook event's own
 * `call_control_id`) instead of reading `leg.call_control_id` off the DB row -- if this leg
 * was found via `loadLegByCallControlIdOrClientLeg`'s clientState fallback, the DB row can
 * still have the placeholder `pending-agent-*` value (the post-dial UPDATE hasn't landed yet).
 * Telnyx's conference endpoints need the REAL call_control_id it issued, which the webhook
 * event that just fired always carries correctly regardless of that DB race.
 */
async function ensureAgentConference(
  supabase: SupabaseClient,
  client: TelnyxClient,
  session: DialSessionRow,
  agentCallControlId: string
): Promise<string | null> {
  const existingConferenceId = session.conference_id;
  if (existingConferenceId) {
    try {
      await client.joinConference(existingConferenceId, { callControlId: agentCallControlId });
      dialerLog('agent_leg_conference_joined', {
        sessionId: session.id,
        conferenceId: existingConferenceId,
      });
      return existingConferenceId;
    } catch (err) {
      dialerLog('agent_leg_join_existing_conference_failed', {
        sessionId: session.id,
        conferenceId: existingConferenceId,
        error: String(err),
      });
      // Review fix (r2 minor): if a contact is actually claimed/live right now, it is in
      // THIS (now presumably dead) conference -- creating a fresh one would bridge the agent
      // into an empty conference while the customer waits alone in the old one. Fail the
      // attempt instead (the caller hangs up the reconnecting agent leg and leaves the
      // session recoverable) rather than splitting agent and customer across two conferences.
      // Only safe to fall through to a fresh create when there is no live contact to strand.
      if (session.active_leg_id) {
        dialerLog('agent_leg_conference_fallback_skipped_live_contact', {
          sessionId: session.id,
          conferenceId: existingConferenceId,
        });
        return null;
      }
      // Fall through: the existing conference is presumably dead and nothing is live in it.
      // Create a fresh one rather than proceed with a stale id nothing will ever bridge into.
    }
  }
  try {
    const conference = await client.createConference({
      name: `hyperdial-session-${session.id}`,
      callControlId: agentCallControlId,
    });
    if (!conference.id) return null;
    // Same-state field-only update -- expect EXACTLY the current state, not
    // AGENT_ACTIVE_SESSION_STATES (which deliberately excludes 'paused_agent_lost' itself,
    // the very state this runs in during Reconnect's fallback-create path; using that list
    // here made the CAS silently fail whenever this ran from Reconnect -- found by this
    // task's own regression test, not by inspection: conference_id was never actually
    // persisted even though this function still logged/returned success).
    const { data: persisted } = await supabase.rpc('transition_session', {
      p_session: session.id,
      p_expected_states: [session.state],
      p_new_state: session.state,
      p_fields: { conference_id: conference.id },
    });
    if (!persisted) {
      dialerLog('agent_leg_conference_created_but_not_persisted', {
        sessionId: session.id,
        conferenceId: conference.id,
      });
      return null;
    }
    dialerLog('agent_leg_conference_created', {
      sessionId: session.id,
      conferenceId: conference.id,
    });
    return conference.id;
  } catch (err) {
    dialerLog('agent_leg_create_conference_failed', { sessionId: session.id, error: String(err) });
    return null;
  }
}

async function handleAgentLegAnswered(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow,
  rawCallControlId: string
): Promise<void> {
  const nextState = agentLegTransition(leg.state, { eventType: 'call.answered' });
  if (!nextState) {
    dialerLog('agent_leg_transition_noop', { legId: leg.id, current: leg.state });
    return;
  }
  const { data: applied, error } = await supabase.rpc('transition_leg', {
    p_call_control_id: leg.call_control_id,
    p_expected_states: [leg.state],
    p_new_state: nextState,
    p_fields: { answered_at: new Date().toISOString() },
  });
  if (error) throw new Error(`transition_leg (agent answered): ${error.message}`);
  if (!applied) {
    dialerLog('agent_leg_transition_race_lost', { legId: leg.id, current: leg.state });
    return;
  }

  const { client, error: telnyxError } = await getConnectedOrgTelnyxContext(
    supabase,
    session.org_id
  );
  if (telnyxError || !client) {
    dialerLog('agent_leg_answered_no_client', { sessionId: session.id });
    return;
  }

  const conferenceId = await ensureAgentConference(supabase, client, session, rawCallControlId);
  if (!conferenceId) {
    // Never confirmed in ANY conference -- do not cascade to ready/dialing with nothing
    // actually bridged. Hang up this now-orphaned leg and leave the session recoverable:
    // stop it outright if this was the initial Go Ready (nothing else has happened yet), or
    // leave it in paused_agent_lost (Reconnect case) so the intern can just try again.
    dialerLog('agent_leg_no_conference_abort', { sessionId: session.id, legId: leg.id });
    await hangupLeg(
      supabase,
      session.org_id,
      rawCallControlId,
      'agent_leg_no_conference_hangup_failed'
    );
    if (session.state === 'ready_pending') {
      await supabase.rpc('transition_session', {
        p_session: session.id,
        p_expected_states: ['ready_pending'],
        p_new_state: 'stopped',
        p_fields: { ended_at: new Date().toISOString() },
      });
    }
    return;
  }

  // Cascade session state. paused_agent_lost -> ready is Reconnect's own path; ready_pending
  // -> ready is Go Ready's. Either way 'ready' is genuinely observable (a poller/UI can catch
  // it), then this immediately decides what comes next: rejoin an ongoing call (a contact leg
  // is still `claimed` -- the agent dropped mid-call and is reconnecting), return to wrap_up
  // (an undispositioned connected leg is still waiting -- M4: this can be true even if the
  // pre-loss state wasn't literally 'wrap_up' yet, if the customer's own hangup only
  // completed AFTER the agent already dropped), return to a remembered manual `paused`, or
  // resume/start rolling dialing (the ordinary case).
  const fromStates: SessionState[] =
    session.state === 'paused_agent_lost' ? ['paused_agent_lost'] : ['ready_pending'];
  const { data: reachedReady } = await supabase.rpc('transition_session', {
    p_session: session.id,
    p_expected_states: fromStates,
    p_new_state: 'ready',
    p_fields: {},
  });
  if (!reachedReady) {
    // Already past ready_pending/paused_agent_lost (e.g. a duplicate/redelivered
    // call.answered after the cascade below already ran once) -- the conference join above
    // still ran (harmless if already joined), nothing else to do.
    dialerLog('agent_leg_answered_already_progressed', { sessionId: session.id });
    return;
  }
  dialerLog('agent_leg_ready', { sessionId: session.id });

  const reloaded = await loadSession(supabase, session.id);
  if (reloaded?.active_leg_id) {
    await supabase.rpc('transition_session', {
      p_session: session.id,
      p_expected_states: ['ready'],
      p_new_state: 'on_call',
      p_fields: { paused_agent_lost_from: null },
    });
    dialerLog('agent_leg_rejoined_live_call', { sessionId: session.id });
    return;
  }

  const { data: undispositionedLeg } = await supabase
    .from('call_legs')
    .select('id')
    .eq('session_id', session.id)
    .eq('kind', 'contact')
    .eq('outcome', 'connected')
    .is('dispositioned_at', null)
    .limit(1)
    .maybeSingle();
  if (undispositionedLeg) {
    await supabase.rpc('transition_session', {
      p_session: session.id,
      p_expected_states: ['ready'],
      p_new_state: 'wrap_up',
      p_fields: { paused_agent_lost_from: null },
    });
    dialerLog('agent_leg_returned_to_wrap_up', { sessionId: session.id });
    return;
  }

  if (reloaded?.paused_agent_lost_from === 'paused') {
    await supabase.rpc('transition_session', {
      p_session: session.id,
      p_expected_states: ['ready'],
      p_new_state: 'paused',
      p_fields: { paused_agent_lost_from: null },
    });
    dialerLog('agent_leg_returned_to_paused', { sessionId: session.id });
    return;
  }

  const { data: reachedDialing } = await supabase.rpc('transition_session', {
    p_session: session.id,
    p_expected_states: ['ready'],
    p_new_state: 'dialing',
    p_fields: { paused_agent_lost_from: null },
  });
  if (reachedDialing) {
    dialerLog('agent_leg_dialing_started', { sessionId: session.id });
    await refillSession(supabase, session.org_id, session.id);
  }
}

/**
 * Agent leg lost (AUD-5): every state the agent leg being present mattered for collapses to
 * paused_agent_lost, and every active contact leg that is NOT `claimed` gets resolved --
 * `claimed` is the one invariant this task states explicitly (a live, bridged contact is
 * never hung up for an agent-leg problem).
 *
 * Review fix (M3): this used to hang up an already-`answered`/`amd_pending` human SILENTLY --
 * no abandon message, unlike `handleWin`'s own loser-resolution (a real TCPA safe-harbor gap:
 * design's own abandoned-call message exists specifically so a human who picked up hears
 * something before the line goes dead). Also used to unconditionally re-hang-up a leg already
 * `abandoned` from an EARLIER resolution, cutting off its in-progress message mid-playback.
 * Now reuses `loserActions` (dialer-core.ts) -- the exact same speak_then_hangup/hangup split
 * `handleWin` uses -- over only the legs that haven't already been resolved one way or another
 * (`abandoned`/`dropped`/`machine` legs are left alone; their own in-flight
 * speak.ended/hangup sequence finishes undisturbed). No "winner" to exclude here (the one
 * `claimed` leg is already filtered out above), so `loserActions` is called with a winner id
 * that can never match a real leg.
 *
 * Review fix (M4): records which state this session was in right before the loss
 * (`paused_agent_lost_from`) -- Reconnect's cascade (`handleAgentLegAnswered`) reads it back
 * to tell a manually `paused` session apart from one that was actively `dialing`, so
 * reconnecting doesn't override the intern's own Pause (see the migration's header for why
 * the `wrap_up` case is instead caught by a direct undispositioned-leg check, not this field).
 */
async function handleAgentLegLost(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow,
  hangupCause: HangupCause
): Promise<void> {
  const nextState = agentLegTransition(leg.state, { eventType: 'call.hangup', hangupCause });
  if (!nextState) {
    dialerLog('agent_leg_transition_noop', { legId: leg.id, current: leg.state });
    return;
  }
  const { data: applied, error } = await supabase.rpc('transition_leg', {
    p_call_control_id: leg.call_control_id,
    p_expected_states: [leg.state],
    p_new_state: nextState,
    p_fields: { hangup_cause: hangupCause, ended_at: new Date().toISOString() },
  });
  if (error) throw new Error(`transition_leg (agent lost): ${error.message}`);
  if (!applied) {
    dialerLog('agent_leg_transition_race_lost', { legId: leg.id, current: leg.state });
    return;
  }

  const { data: paused } = await supabase.rpc('transition_session', {
    p_session: session.id,
    p_expected_states: AGENT_ACTIVE_SESSION_STATES,
    p_new_state: 'paused_agent_lost',
    p_fields: { paused_agent_lost_from: session.state },
  });
  dialerLog('agent_leg_lost', { sessionId: session.id, pausedSession: Boolean(paused) });
  if (!paused) {
    // Session was already stopped/completed/paused_agent_lost by something else (e.g. the
    // user hit Stop in the same window) -- nothing left to do; stopSession already hangs up
    // every active leg including this one's own contacts.
    return;
  }

  const { client } = await getConnectedOrgTelnyxContext(supabase, session.org_id);
  const campaign = await loadCampaign(supabase, session.campaign_id);
  const activeLegs = await loadActiveLegs(supabase, session.id);
  const stillUnresolvedContactLegs = activeLegs.filter(
    (l) => l.kind === 'contact' && !['claimed', 'abandoned', 'dropped', 'machine'].includes(l.state)
  );
  const coreLegs: DialerLeg[] = stillUnresolvedContactLegs.map((l) => ({
    id: l.id,
    state: l.state,
  }));
  const actions = loserActions(
    coreLegs,
    '__no_winner__',
    campaign?.abandon_message_enabled ?? true
  );
  const orgName = await loadOrgName(supabase, session.org_id);

  for (const action of actions) {
    const contactLeg = stillUnresolvedContactLegs.find((l) => l.id === action.legId);
    if (!contactLeg) continue;
    const nextContactState: LegState =
      action.action === 'speak_then_hangup' ? 'abandoned' : 'dropped';
    const { data: legApplied, error: legError } = await supabase.rpc('transition_leg', {
      p_call_control_id: contactLeg.call_control_id,
      p_expected_states: [contactLeg.state],
      p_new_state: nextContactState,
    });
    if (legError) throw new Error(`transition_leg (agent-lost contact): ${legError.message}`);
    if (!legApplied) {
      // This leg's own event processing already moved it past its snapshot state --
      // whatever it resolved to independently is authoritative, same race-safety shape as
      // handleWin's own loser loop.
      dialerLog('agent_lost_contact_race_skip', { legId: contactLeg.id });
      continue;
    }
    if (!client) {
      dialerLog('agent_lost_contact_no_client', { legId: contactLeg.id });
      continue;
    }
    if (action.action === 'speak_then_hangup') {
      try {
        await client.speak(contactLeg.call_control_id, {
          payload: abandonMessage(orgName),
          voice: DEFAULT_SPEAK_VOICE,
        });
        dialerLog('agent_lost_contact_speak', { legId: contactLeg.id });
      } catch (err) {
        dialerLog('agent_lost_contact_speak_failed', { legId: contactLeg.id, error: String(err) });
      }
    } else {
      try {
        await client.hangup(contactLeg.call_control_id);
        dialerLog('agent_lost_contact_hangup', { legId: contactLeg.id });
      } catch (err) {
        dialerLog('agent_lost_contact_hangup_failed', { legId: contactLeg.id, error: String(err) });
      }
    }
    // outcome/apply_leg_outcome are deliberately NOT finalized here -- the natural
    // call.hangup this just triggered (directly, or after call.speak.ended) flows through
    // the normal processContactLegEvent path, which preserves this abandoned/dropped
    // decision via hangupOutcome and calls apply_leg_outcome then. Same shape as handleWin's
    // own loser loop.
  }
}

async function hangupLeg(
  supabase: SupabaseClient,
  orgId: string,
  callControlId: string,
  failLogStep: string
): Promise<void> {
  const { client } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (!client) return;
  try {
    await client.hangup(callControlId);
  } catch (err) {
    dialerLog(failLogStep, { callControlId, error: String(err) });
  }
}

async function sendAbandonMessage(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow
): Promise<void> {
  const campaign = await loadCampaign(supabase, session.campaign_id);
  const { client } = await getConnectedOrgTelnyxContext(supabase, session.org_id);
  if (!client) return;
  if (campaign?.abandon_message_enabled ?? true) {
    const orgName = await loadOrgName(supabase, session.org_id);
    try {
      await client.speak(leg.call_control_id, {
        payload: abandonMessage(orgName),
        voice: DEFAULT_SPEAK_VOICE,
      });
    } catch (err) {
      dialerLog('abandon_speak_failed', { legId: leg.id, error: String(err) });
    }
  } else {
    await hangupLeg(supabase, session.org_id, leg.call_control_id, 'abandon_hangup_failed');
  }
}

/** Runs once, right after `claim_leg` confirms this leg won. Bridges the winner into the
 *  conference, then proactively resolves every OTHER active leg (both still-ringing and
 *  already-answered) from a snapshot -- see this file's header for why this is safe even
 *  though a losing leg's own event might independently reach the same conclusion. */
async function handleWin(
  supabase: SupabaseClient,
  session: DialSessionRow,
  winnerLeg: CallLegRow
): Promise<void> {
  const { client, callControlAppId, error } = await getConnectedOrgTelnyxContext(
    supabase,
    session.org_id
  );
  if (error || !client || !callControlAppId) {
    dialerLog('handle_win_no_client', { sessionId: session.id });
    return;
  }

  let conferenceId = session.conference_id;
  try {
    if (!conferenceId) {
      const conference = await client.createConference({
        name: `hyperdial-session-${session.id}`,
        callControlId: winnerLeg.call_control_id,
      });
      conferenceId = conference.id;
      if (conferenceId) {
        await supabase.rpc('transition_session', {
          p_session: session.id,
          p_expected_states: ['connecting'],
          p_new_state: 'on_call',
          p_fields: { conference_id: conferenceId },
        });
      }
    } else {
      await client.joinConference(conferenceId, { callControlId: winnerLeg.call_control_id });
      await supabase.rpc('transition_session', {
        p_session: session.id,
        p_expected_states: ['connecting'],
        p_new_state: 'on_call',
        p_fields: {},
      });
    }
    dialerLog('handle_win_conference_ready', {
      sessionId: session.id,
      conferenceId,
      winnerLegId: winnerLeg.id,
    });
  } catch (err) {
    dialerLog('handle_win_conference_failed', { sessionId: session.id, error: String(err) });
  }

  const campaign = await loadCampaign(supabase, session.campaign_id);
  // TASK-L1: loadActiveLegs is kind-agnostic (by design -- stopSession relies on that to hang
  // up the agent leg too). loserActions (dialer-core.ts) predates the agent leg entirely and
  // has no concept of `kind` -- filter to CONTACT legs before computing it, or the agent's own
  // still-'answered' leg gets treated as a losing contact and gets spoken to / hung up here.
  const legs = (await loadActiveLegs(supabase, session.id)).filter((l) => l.kind === 'contact');
  const coreLegs: DialerLeg[] = legs.map((l) => ({ id: l.id, state: l.state }));
  const actions = loserActions(coreLegs, winnerLeg.id, campaign?.abandon_message_enabled ?? true);
  const orgName = await loadOrgName(supabase, session.org_id);

  for (const action of actions) {
    const loserLeg = legs.find((l) => l.id === action.legId);
    if (!loserLeg) continue;
    const nextState: LegState = action.action === 'speak_then_hangup' ? 'abandoned' : 'dropped';
    const { data: applied, error: transitionError } = await supabase.rpc('transition_leg', {
      p_call_control_id: loserLeg.call_control_id,
      p_expected_states: [loserLeg.state],
      p_new_state: nextState,
    });
    if (transitionError) throw new Error(`transition_leg (loser): ${transitionError.message}`);
    if (!applied) {
      // This leg's own event processing already moved it past its snapshot state --
      // whatever it resolved to independently is authoritative, don't fight it.
      dialerLog('handle_win_loser_race_skip', { legId: loserLeg.id });
      continue;
    }
    if (action.action === 'speak_then_hangup') {
      try {
        await client.speak(loserLeg.call_control_id, {
          payload: abandonMessage(orgName),
          voice: DEFAULT_SPEAK_VOICE,
        });
        dialerLog('handle_win_loser_speak', { sessionId: session.id, legId: loserLeg.id });
      } catch (err) {
        dialerLog('handle_win_loser_speak_failed', { legId: loserLeg.id, error: String(err) });
      }
    } else {
      try {
        await client.hangup(loserLeg.call_control_id);
        dialerLog('handle_win_loser_hangup', { sessionId: session.id, legId: loserLeg.id });
      } catch (err) {
        dialerLog('handle_win_loser_hangup_failed', { legId: loserLeg.id, error: String(err) });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Session control (dialer-session-{stop,pause,hangup-live}, and resume for testing)
// ---------------------------------------------------------------------------

export async function stopSession(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<void> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId) return;

  const { client } = await getConnectedOrgTelnyxContext(supabase, orgId);
  const legs = await loadActiveLegs(supabase, sessionId);
  if (client) {
    for (const leg of legs) {
      try {
        await client.hangup(leg.call_control_id);
      } catch (err) {
        dialerLog('stop_session_hangup_failed', { sessionId, legId: leg.id, error: String(err) });
      }
    }
  }

  await supabase.rpc('transition_session', {
    p_session: sessionId,
    p_expected_states: [
      'ready_pending',
      'ready',
      'dialing',
      'connecting',
      'on_call',
      'wrap_up',
      'paused',
      'paused_agent_lost',
    ],
    p_new_state: 'stopped',
    p_fields: { ended_at: new Date().toISOString() },
  });
  dialerLog('stop_session_done', { sessionId, hungUpLegs: legs.length });
}

export async function pauseSession(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<boolean> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId) return false;
  const { data, error } = await supabase.rpc('transition_session', {
    p_session: sessionId,
    p_expected_states: ['dialing', 'ready'],
    p_new_state: 'paused',
    p_fields: {},
  });
  if (error) throw new Error(`pauseSession: ${error.message}`);
  return Boolean(data);
}

/** See this file's header: deliberately not a new HTTP endpoint in this task. Phase 3's
 *  dispositions submission is the real future caller; this task's own acceptance script
 *  calls it directly to exercise the rolling loop across a wrap_up cycle. */
export async function resumeToDialing(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<boolean> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId) return false;
  const { data, error } = await supabase.rpc('transition_session', {
    p_session: sessionId,
    p_expected_states: ['wrap_up', 'paused'],
    p_new_state: 'dialing',
    p_fields: {},
  });
  if (error) throw new Error(`resumeToDialing: ${error.message}`);
  if (data) await refillSession(supabase, orgId, sessionId);
  return Boolean(data);
}

export async function endLiveCall(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<boolean> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId || !session.active_leg_id) return false;
  const { data: leg } = await supabase
    .from('call_legs')
    .select('call_control_id')
    .eq('id', session.active_leg_id)
    .maybeSingle();
  if (!leg) return false;
  const { client } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (!client) return false;
  await client.hangup(leg.call_control_id as string);
  return true;
}

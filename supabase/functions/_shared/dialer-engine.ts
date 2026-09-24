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
 * - No agent leg exists yet (E3 builds the real WebRTC agent leg + joins it to the
 *   conference). `refillCount`'s agent-leg gate is bypassed when
 *   `DIALER_DEV_SKIP_AGENT_GATE=true` (server env, dev/test only) so this task is
 *   testable without E3. Remove the flag entirely once E3 lands; nothing in this file
 *   creates a `kind='agent'` call_legs row.
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
import type { TelnyxClient } from './telnyx-client.ts';

function dialerLog(step: string, meta: Record<string, unknown> = {}): void {
  console.log('[dialer-engine]', step, meta);
}

/** See this file's header. Server-side only, dev/test; removed entirely in E3. */
function devSkipAgentGate(): boolean {
  return (Deno.env.get('DIALER_DEV_SKIP_AGENT_GATE') ?? '') === 'true';
}

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
  'id, org_id, campaign_id, agent_id, state, lines, amd_mode, agent_leg_id, active_leg_id, conference_id';
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

async function agentLegStateFor(
  supabase: SupabaseClient,
  session: DialSessionRow
): Promise<LegState> {
  if (devSkipAgentGate()) return 'answered';
  // No agent leg exists yet in E2 (E3 builds it) -- until then this always reads as "not
  // answered", so refillCount's gate stays shut unless the dev flag is set.
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

// ---------------------------------------------------------------------------
// Starting a session and the rolling refill loop
// ---------------------------------------------------------------------------

export async function startSession(
  supabase: SupabaseClient,
  args: { orgId: string; campaignId: string; agentId: string; lines: number; amdMode: CoreAmdMode }
): Promise<{ sessionId: string }> {
  const { data, error } = await supabase
    .from('dial_sessions')
    .insert({
      org_id: args.orgId,
      campaign_id: args.campaignId,
      agent_id: args.agentId,
      state: 'dialing',
      lines: args.lines,
      amd_mode: args.amdMode,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`startSession: ${error?.message ?? 'insert failed'}`);
  const sessionId = data.id as string;
  dialerLog('session_started', { sessionId, orgId: args.orgId, campaignId: args.campaignId });
  await refillSession(supabase, args.orgId, sessionId);
  return { sessionId };
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
  const n = refillCount(session.state, agentLegState, session.lines, activeLegs.length);
  if (n <= 0) {
    dialerLog('refill_skip_zero', {
      sessionId,
      agentLegState,
      lines: session.lines,
      active: activeLegs.length,
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
  if (leg.kind === 'agent') {
    // No agent legs exist yet in E2 (E3's job) -- defensive no-op if one somehow shows up.
    dialerLog('webhook_event_agent_leg_skip', { legId: leg.id });
    return;
  }

  const session = await loadSession(supabase, leg.session_id);
  if (!session) {
    dialerLog('webhook_event_no_session', { legId: leg.id, sessionId: leg.session_id });
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
  const legs = await loadActiveLegs(supabase, session.id);
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

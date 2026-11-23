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
 *
 * TASK-F-T3 (VMD-1..5, BUG-7), voicemail drop + real AMD modes:
 * - The 'machine' dispatch branch (processContactLegEvent) now DECIDES, once, whether to drop a
 *   voicemail (`resolveVoicemailDropPath`) instead of hanging up unconditionally. Dropping means
 *   NOT hanging up -- the leg stays 'machine' (armed) until its own call.machine.greeting.ended
 *   arrives and actually starts playback (`startVoicemailPlayback`, 'voicemail_dropping'
 *   branch). Not dropping is unchanged from before this task.
 * - `refillSession`'s active-line count now excludes 'voicemail_dropping' legs (VMD-5) -- a
 *   deliberate, bounded exception to "never dial more than `lines` at once", not an oversight.
 *   See decisions.md.
 * - `amd_mode` widened from the old 'off'|'on' to the 4 real Telnyx values (BUG-7); see
 *   dialer-core.ts's own header for the exact vendor-verified mapping and the (important)
 *   constraint that plain 'detect' never gets a greeting-ended signal at all, so voicemail drop
 *   is a no-op under that mode regardless of the campaign's own voicemail_drop_mode.
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
import {
  isRecordingEnabled,
  shouldAnnounceRecordingConsent,
  parseRecordingSavedPayload,
  parseRecordingErrorPayload,
  recordingStoragePath,
} from './recording-core.ts';
import { stateForE164 } from './area-code-state.ts';
import {
  amdModeSupportsVoicemailDrop,
  shouldAttemptVoicemailDrop,
  VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS,
  type VoicemailDropMode,
} from './voicemail-core.ts';
// TASK-T4 review fix-forward (SHOULD): cancel any in-flight transfer the instant its own
// session's active leg ends, rather than waiting on reap_stale_call_transfers' timeout. A
// circular import (transfer-core.ts itself imports agentSipUri from this file) is safe here --
// both bindings are only used inside function bodies, never at module-evaluation time.
import { cancelInFlightTransferForSession } from './transfer-core.ts';
import { awaitDialSlot } from './cps-gate.ts';

function dialerLog(step: string, meta: Record<string, unknown> = {}): void {
  console.log('[dialer-engine]', step, meta);
}

/** TASK-L1: the session-identifying custom SIP header on the agent leg's own dial (belt-and-
 *  suspenders alongside client_state{kind:'agent'} -- see telnyx-client.ts's DialArgs header
 *  comment for the spec citation). Not read anywhere server-side; the browser's incoming-call
 *  handler is the reader (useTelnyxCall.ts). */
const AGENT_SESSION_HEADER_NAME = 'X-Hyperdial-Session';

/** CallRequest.time_limit_secs for every CONTACT dial (BUG-8) -- see telnyx-client.ts's
 *  DialArgs header comment for the spec citation. Exported (TASK-L6) so
 *  dialer-sweeper-core.ts's own hard-timeout check uses this SAME value, not an independently-
 *  maintained copy that could drift out of sync with the actual dial. */
export const CONTACT_DIAL_TIME_LIMIT_SECS = 1800;

/** TASK-S1/BUG-8: the agent leg's own ring timeout and max call length, decided and made
 *  EXPLICIT rather than relying on Telnyx's own defaults (re-verified against the real
 *  CallRequest schema, spec3.json, 2026-09-25 -- `timeout_secs` default 30/min 5/max 600,
 *  `time_limit_secs` default AND max 14400 (4h)):
 *  - `AGENT_DIAL_TIMEOUT_SECS` (45s, longer than `CONTACT_DIAL_TIME_LIMIT_SECS`'s 25s ring
 *    timeout on purpose): the agent leg rings the intern's OWN browser tab (a WebRTC SDK
 *    incoming-call popup), which needs more slack than a phone physically ringing -- the tab
 *    may be backgrounded, the SDK needs a moment to raise the notification, and a human has to
 *    notice and click Accept, none of which apply to a contact's phone. If the agent leg times
 *    out anyway, the existing agent-lost path (`handleAgentLegLost`) already recovers the
 *    session into `paused_agent_lost` with a manual/auto Reconnect -- a longer ring here costs
 *    nothing extra, it only avoids a false "missed" when the intern was right there.
 *  - `AGENT_DIAL_TIME_LIMIT_SECS` (14400s/4h): equal to Telnyx's own default/max, but passed
 *    EXPLICITLY so it can never silently drift if Telnyx ever changes its own default -- this
 *    is a single continuous WebRTC leg held for an entire dialing shift (Go Ready to Stop), not
 *    a single call, so the cap is sized for "longer than any real uninterrupted shift", not a
 *    per-call limit. If a shift genuinely runs past 4h, Telnyx sends `call.hangup` with
 *    `hangup_cause: 'time_limit'`, `handleAgentLegLost` treats it exactly like any other agent-
 *    leg drop (`paused_agent_lost`, Reconnect re-dials a fresh leg), so this is a currently-
 *    latent, self-recovering edge case, not a hard stop. */
export const AGENT_DIAL_TIMEOUT_SECS = 45;
export const AGENT_DIAL_TIME_LIMIT_SECS = 14400;

function webhookBaseUrl(): string {
  return `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-webhook`;
}

/** A real, spec-listed AWS Polly neural voice (spec3.json's own example of the -Neural suffix
 *  pattern for the Speak Request's `voice` field) -- not a made-up "female"/"male" value. */
const DEFAULT_SPEAK_VOICE = 'AWS.Polly.Joanna-Neural';

function abandonMessage(orgName: string | null): string {
  return `Sorry, we missed you${orgName ? ` at ${orgName}` : ''}. We'll try to reach you again soon.`;
}

/** MISSION-4 TASK-T8: spoken once, right after bridge, when `shouldAnnounceRecordingConsent`
 *  says to. Deliberately generic wording (no state-specific legal phrasing) -- this feature
 *  decides WHEN to announce, not what a compliant script must say; see the org setting's own
 *  "not legal advice" comment. MISSION-5 TASK-M5-B2 (EC-17): `mentionMonitoring` appends a
 *  distinct clause about being monitored, not just recorded -- a supervisor silently
 *  listen/whisper/barge-ing in is exactly the kind of third-party presence an all-party-consent
 *  state requires the caller be told about, and "may be recorded" alone does not disclose it. */
function recordingConsentMessage(orgName: string | null, mentionMonitoring: boolean): string {
  const suffix = mentionMonitoring ? 'recorded and monitored' : 'recorded';
  return `This call${orgName ? ` with ${orgName}` : ''} may be ${suffix} for quality purposes.`;
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
  /** TASK-N1: set by refillSession when no dial-able number exists at all (pool exhausted/
   *  resting AND no legacy campaign.caller_id_number_id) -- the ONLY reason value in use today
   *  is 'no_numbers_available'. Not CHECK-constrained (see the migration's own comment); read
   *  only while `state === 'paused'`, cleared on resume/manual-pause so a stale value from a
   *  past pause can never be misread once the session has moved on. */
  pause_reason: string | null;
  /** MISSION-5 TASK-M5-N1 review fix-forward #2 (lead's 2 extra points, re-verified by eng1):
   *  the dedicated, never-client-settable column set only by runTakeoverAction's own
   *  transition_session call -- now the detection signal for takeover-recovery, replacing a
   *  string-equality check on `pause_reason` (which an ordinary agent-typed free-text pause
   *  reason could spoof, and which loadSession never even selected in the first place). Cleared
   *  back to null once a takeover-recovery session actually leaves 'paused' for good. */
  taken_over_by_manager_id: string | null;
}

interface CampaignRow {
  id: string;
  org_id: string;
  name: string;
  abandon_message_enabled: boolean;
  caller_id_number_id: string | null;
  /** TASK-F-T3 (VMD-4). */
  voicemail_drop_mode: VoicemailDropMode;
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
  /** Set on a LOSING contact leg's own call.answered (via applyLegTransition) -- the WINNING
   *  leg's call.answered is handled by the separate claim-win branch in processContactLegEvent,
   *  which never sets it (claim_leg's own `claimed_at` is the winner's equivalent timestamp).
   *  Talk-duration fallback, in order, is `bridged_at ?? answered_at ?? claimed_at`. */
  answered_at: string | null;
  /** Set by claim_leg's own SQL the moment a contact leg wins the race -- see `answered_at`'s
   *  comment for why the winner needs this as its second fallback, not just the first. */
  claimed_at: string | null;
  /** TASK-M1: stamped by `handleWin` right after the winner leg's conference create/join
   *  actually succeeds -- never on a failed join, so this stays null (falls back to
   *  `answered_at`/`claimed_at`) exactly when the leg genuinely never got bridged into live
   *  audio. */
  bridged_at: string | null;
  /** TASK-F-T3 (VMD-2): set once, at machine-detection-ended time, by
   *  `resolveVoicemailDropPath` -- the STORAGE path of the drop file this leg will play once its
   *  greeting-ended webhook arrives, or null if this leg is not dropping a voicemail (the common
   *  case: mode/attempt gating said no, or no drop file exists). `applyLegTransition` re-reads
   *  this fresh (via a normal reload of the leg row on each webhook delivery) to build
   *  `ctx.voicemailDrop` -- a single decision, made once, never re-derived a second time from
   *  campaign/attempt/file lookups that could drift from the first answer. */
  voicemail_drop_path: string | null;
  /** TASK-N1: which pool number this leg actually dialed from -- null for the agent leg (out of
   *  this task's scope, see resolveDialNumberForLeg's own header) and for a leg dialed via the
   *  legacy campaign.caller_id_number_id fallback (that tier has no row to point at). */
  from_number_id: string | null;
}

const SESSION_COLUMNS =
  'id, org_id, campaign_id, agent_id, state, lines, amd_mode, agent_leg_id, active_leg_id, conference_id, paused_agent_lost_from, pause_reason, taken_over_by_manager_id';
const LEG_COLUMNS =
  'id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state, answered_at, claimed_at, bridged_at, voicemail_drop_path, from_number_id';

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
    .select('id, org_id, name, abandon_message_enabled, caller_id_number_id, voicemail_drop_mode')
    .eq('id', campaignId)
    .maybeSingle();
  if (error) throw new Error(`loadCampaign: ${error.message}`);
  return data as CampaignRow | null;
}

/** TASK-H34 (B): contact-leg states where AMD already decided "machine" -- never a losing human.
 *  Side effect: an UNARMED 'machine' leg whose own hangup failed is no longer re-hung-up by a later
 *  win; it waits for the sweeper. A STANDARD-AMD greeting.ended with result `not_sure` (30 s, no beep
 *  heard) still counts as "greeting over" and may drop; only premium results are beep-gated. */
const MACHINE_RESOLVED_STATES: LegState[] = ['machine', 'voicemail_dropping'];

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

/** The campaign's own fixed caller ID. Still used, unchanged, for the agent leg's own dial (see
 *  `dialAgentLegInternal`) -- TASK-N1's pool is scoped to CONTACT-facing dials, where per-number
 *  spam-flagging risk from volume actually accumulates. The agent leg is an internal dial to the
 *  agent's own WebRTC device, never seen by an external network as a "from" number in the sense
 *  CID-1/CID-2 care about, so rotating/capping it would add nothing. Also used, unchanged, as
 *  TASK-N1's own tier-3 legacy fallback for contact dials (see `resolveDialNumberForLeg`). */
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

/**
 * TASK-N1: the agent leg's own dial (see `resolvedFromNumber`'s header for why it's out of the
 * pool's scope entirely -- no cap, no rest, no assignment check) still needs SOME valid E.164
 * value for Telnyx's `from` field, even though nothing external ever sees it. Before this task,
 * that was always `campaign.caller_id_number_id` -- but requiring every campaign to keep a fixed
 * legacy number just so its agent leg can dial defeats the whole point of a pool-only org (one
 * that never sets a legacy number at all). Falls back to ANY phone number the org owns
 * (regardless of status/assignment -- again, this dial is never billed against or rate-limited)
 * so a pool-only org's sessions still start; only a genuinely number-less org (nothing ever
 * purchased) still fails here, which is a real, correct failure (there is nothing at all to
 * dial `from`).
 */
async function agentDialFromNumber(
  supabase: SupabaseClient,
  orgId: string,
  campaign: CampaignRow
): Promise<string | null> {
  const legacyNumber = await resolvedFromNumber(supabase, orgId, campaign);
  if (legacyNumber) return legacyNumber;
  const { data } = await supabase
    .from('user_phone_numbers')
    .select('phone_number')
    .eq('org_id', orgId)
    .limit(1)
    .maybeSingle();
  return (data?.phone_number as string | undefined) ?? null;
}

/**
 * TASK-N1 (CID-1, CID-2, CID-5): picks and atomically reserves the caller-ID number for ONE
 * contact leg's dial, in this priority order (design's own list):
 *   1. An unresting, under-cap number already assigned to this agent.
 *   2. Else an unresting, under-cap unassigned (team pool) number.
 *      Both tiers prefer an area-code match with the contact, then the fewest dials today --
 *      see `private.pick_and_reserve_dial_number` (the migration) for the actual ordering/lock.
 *   3. Else the campaign's own legacy `caller_id_number_id` (uncapped, untracked -- an
 *      intentional escape hatch so an org that hasn't set up a pool, or has fully exhausted one,
 *      keeps dialing rather than stalling; see decisions.md for why this is accepted, not a bug).
 * Returns null only when NONE of the three tiers has anything at all -- refillSession's caller
 * treats that as "truly no number available" and pauses the session (design's own explicit ask:
 * "never fail silently or dial from nothing").
 */
async function resolveDialNumberForLeg(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string,
  contactPhone: string,
  legacyNumber: string | null
): Promise<{ phoneNumber: string; numberId: string | null } | null> {
  const { data: pooledId, error: pickError } = await supabase.rpc('pick_and_reserve_dial_number', {
    p_org_id: orgId,
    p_agent_id: agentId,
    p_contact_phone: contactPhone,
  });
  if (pickError) throw new Error(`pick_and_reserve_dial_number: ${pickError.message}`);
  if (pooledId) {
    const { data: numberRow } = await supabase
      .from('user_phone_numbers')
      .select('phone_number')
      .eq('id', pooledId as string)
      .maybeSingle();
    const phoneNumber = numberRow?.phone_number as string | undefined;
    if (phoneNumber) return { phoneNumber, numberId: pooledId as string };
    // The row vanished between the reserve and this read (should not happen -- reserving locks
    // it) -- fall through to the legacy tier rather than surface a spurious "no number" pause.
  }

  return legacyNumber ? { phoneNumber: legacyNumber, numberId: null } : null;
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
 *  fix on its own.
 *
 *  TASK-T3: exported (was module-private) -- `coaching-core.ts` reuses this UNCHANGED to
 *  resolve a MANAGER's own SIP URI for a live-coaching leg. Nothing about the function itself
 *  changed; it was never agent-specific despite the name (any org member's WebRTC credential
 *  resolves the same way) -- exporting it was preferred over duplicating the credential-lookup
 *  logic in a second file, per this lane's "reuse, don't reinvent" convention. */
export async function agentSipUri(
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
 * The Reconnect button (TASK-L1 spec item 5): valid from 'paused_agent_lost', OR (MISSION-5
 * TASK-M5-N1 review fix-forward, BLOCKER 2) from 'paused' with `taken_over_by_manager_id` set --
 * the agent's "Rejoin dialing" action after a supervisor took their call over. Both dial a FRESH
 * agent leg (the old one is 'ended', or in the takeover case was already detached with
 * `agent_leg_id` cleared to null) into the SAME conference-creation path --
 * processAgentLegEvent's answered branch does the actual join once it answers, and decides
 * on_call-vs-dialing there based on whether a contact leg is still `claimed`. Purely additive:
 * every OTHER state still hits the `not_paused_agent_lost` refusal exactly as before.
 *
 * N1 fix-forward #2 (lead's point 2): detection was originally a string-equality check on
 * `pause_reason` -- an agent could type that exact reserved string into the free-text `reason`
 * field of an ordinary manual pause (`dialer-session-pause`, intentionally not enum-checked) and
 * produce an identical-looking row. The pre-existing M2 guard below (checking the REAL agent leg's
 * own current state) already stopped that spoof from actually double-dialing, but the detection
 * itself is now keyed on the dedicated, never-client-settable `taken_over_by_manager_id` column
 * instead, closing the spoofing vector at the source.
 */
export async function reconnectAgentLeg(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<{ ok: boolean; reason?: string }> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId) return { ok: false, reason: 'not_found' };
  const isTakenOverPaused = session.state === 'paused' && session.taken_over_by_manager_id != null;
  if (session.state !== 'paused_agent_lost' && !isTakenOverPaused) {
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
    const fromNumber = await agentDialFromNumber(supabase, orgId, campaign);
    if (!fromNumber) throw new Error('dialAgentLeg: org has no phone number at all yet');

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
      timeoutSecs: AGENT_DIAL_TIMEOUT_SECS,
      timeLimitSecs: AGENT_DIAL_TIME_LIMIT_SECS,
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

/** MISSION-5 TASK-M5-B3: mirrors reliability-alert-check's/campaign-lines-guard-check's own
 *  `notifyOwnersAndAdmins` verbatim (not yet extracted to `_shared`, same NIT those two already
 *  carry) -- one `notifications` row per active owner/admin. */
async function notifyOwnersAndAdminsOfDailyCap(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string,
  effectiveCap: number
): Promise<void> {
  const { data: members, error } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .in('role', ['owner', 'admin']);
  if (error || !members?.length) return;

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('user_id', agentId)
    .maybeSingle();
  const agentName =
    [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim() || 'An agent';

  await supabase.from('notifications').insert(
    (members as { user_id: string }[]).map((m) => ({
      org_id: orgId,
      user_id: m.user_id,
      type: 'daily_dial_cap_reached',
      title: 'Daily dial cap reached',
      body: `${agentName} hit their daily dial cap of ${effectiveCap} and has been paused. Raise their cap in Settings if this was expected.`,
    }))
  );
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
  // TASK-F-T3 (VMD-5): a leg playing a voicemail drop must never hold up the next batch -- it
  // is excluded from the active-line count the same way an 'ended' leg already is (loadActiveLegs
  // itself only filters out 'ended'). This can transiently push real Telnyx call concurrency
  // above `lines` by however many drops are in flight at once, bounded by the sweeper's own
  // ~90s safety timeout on that state -- a deliberate, documented tradeoff (decisions.md), not
  // an oversight.
  const activeContactLegs = activeLegs.filter(
    (l) => l.kind === 'contact' && l.state !== 'voicemail_dropping'
  ).length;
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

  // TASK-N1: the legacy fixed number is tier 3 (resolveDialNumberForLeg's own header) -- if the
  // campaign still has one set, there is always SOMETHING to dial with, so skip the pool
  // pre-check entirely. Otherwise, refuse to even claim leads unless the pool actually has
  // something available right now -- "never fail silently or dial from nothing" (design's own
  // words): pausing BEFORE claim_next_leads means no lead ever gets marked in_flight for a dial
  // that was never going to happen.
  const legacyNumber = await resolvedFromNumber(supabase, orgId, campaign);
  if (!legacyNumber) {
    const { data: hasNumber, error: hasNumberError } = await supabase.rpc(
      'has_available_dial_number',
      { p_org_id: orgId, p_agent_id: session.agent_id }
    );
    if (hasNumberError) {
      throw new Error(`has_available_dial_number: ${hasNumberError.message}`);
    }
    if (!hasNumber) {
      dialerLog('refill_pause_no_numbers_available', { sessionId, campaignId: campaign.id });
      await supabase.rpc('transition_session', {
        p_session: sessionId,
        p_expected_states: ['dialing'],
        p_new_state: 'paused',
        p_fields: { pause_reason: 'no_numbers_available' },
      });
      return { dialed: 0 };
    }
  }

  // MISSION-5 TASK-M5-B3: per-agent daily dial cap. Same "pause BEFORE claim_next_leads, never
  // fail mid-claim" shape as the numbers-availability check just above -- agent_daily_dial_status
  // (SQL) does the settings lookup + org-timezone-aware count in one round trip, service_role
  // only. `transition_session`'s own CAS means the notification below only ever fires the FIRST
  // time this session crosses into the paused state for this reason (a later refill attempt
  // while already paused finds `p_expected_states: ['dialing']` no longer matches, so the
  // transition -- and the notification gated on it -- both no-op), no separate dedup needed.
  const { data: capStatus, error: capError } = await supabase.rpc('agent_daily_dial_status', {
    p_org: orgId,
    p_agent: session.agent_id,
  });
  if (capError) {
    throw new Error(`agent_daily_dial_status: ${capError.message}`);
  }
  const cap = (capStatus ?? [])[0] as
    { cap_enabled: boolean; effective_cap: number | null; dialed_today: number | null } | undefined;
  if (
    cap?.cap_enabled &&
    cap.effective_cap != null &&
    (cap.dialed_today ?? 0) >= cap.effective_cap
  ) {
    dialerLog('refill_pause_daily_dial_cap_reached', {
      sessionId,
      agentId: session.agent_id,
      effectiveCap: cap.effective_cap,
      dialedToday: cap.dialed_today,
    });
    const { data: justPaused } = await supabase.rpc('transition_session', {
      p_session: sessionId,
      p_expected_states: ['dialing'],
      p_new_state: 'paused',
      p_fields: { pause_reason: 'daily_dial_cap_reached' },
    });
    if (justPaused) {
      await notifyOwnersAndAdminsOfDailyCap(supabase, orgId, session.agent_id, cap.effective_cap);
    }
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
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
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

    const picked = await resolveDialNumberForLeg(
      supabase,
      orgId,
      session.agent_id,
      leg.phone_number,
      legacyNumber
    );
    if (!picked) {
      // TASK-N1: extremely rare race -- the pre-check above (or an earlier leg in THIS same
      // batch) found something, but the pool genuinely ran out between then and this leg's own
      // reserve call (another session's concurrent dial won the last slot). This leg, and every
      // other not-yet-dialed leg already claimed in this batch, never really started (no real
      // Telnyx dial was ever placed) -- release each one back to the front of the queue
      // (`queued`, untouched attempts/next_attempt_at) rather than let claim_next_leads' own
      // `in_flight` stick, or spend a real attempt on a contact that was never actually called.
      dialerLog('refill_pause_no_numbers_mid_batch', {
        sessionId,
        legId: leg.leg_id,
        remaining: legs.length - i,
      });
      for (const stranded of legs.slice(i)) {
        await supabase
          .from('campaign_leads')
          .update({ status: 'queued', updated_at: new Date().toISOString() })
          .eq('id', stranded.lead_id)
          .eq('status', 'in_flight');
        await supabase.from('call_legs').delete().eq('id', stranded.leg_id);
      }
      await supabase.rpc('transition_session', {
        p_session: sessionId,
        p_expected_states: ['dialing'],
        p_new_state: 'paused',
        p_fields: { pause_reason: 'no_numbers_available' },
      });
      break;
    }

    await dialLead(supabase, client, {
      orgId,
      sessionId,
      legId: leg.leg_id,
      placeholderCallControlId: leg.call_control_id,
      callControlAppId,
      fromNumber: picked.phoneNumber,
      fromNumberId: picked.numberId,
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
    /** TASK-N1: the pool number this dial actually reserved, or null when it came from the
     *  legacy campaign.caller_id_number_id fallback tier (nothing to point at). */
    fromNumberId: string | null;
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
    // Keep the org's combined outbound dials within its CPS limit (cps-gate.ts).
    await awaitDialSlot(supabase, args.orgId);
    const { callControlId } = await client.dial({
      connectionId: args.callControlAppId,
      to: args.phoneNumber,
      from: args.fromNumber,
      webhookUrl: args.webhookUrl,
      clientState,
      timeoutSecs: 25,
      timeLimitSecs: CONTACT_DIAL_TIME_LIMIT_SECS,
      // TASK-F-T3/BUG-7: CoreAmdMode (dialer-core.ts) and telnyx-client.ts's own AmdMode are now
      // the identical 4-member union ('off'|'detect'|'detect_words'|'premium') -- no mapping
      // function needed, unlike the old 'off'|'on' -> 'disabled'|'premium' translation.
      amdMode: args.amdMode,
    });
    const { error: updateError } = await supabase
      .from('call_legs')
      .update({ call_control_id: callControlId, from_number_id: args.fromNumberId })
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
    // TASK-N1 fix-forward (eng1 review, finding L): this dial never actually happened, so give
    // back the number_daily_usage increment pick_and_reserve_dial_number already made for it --
    // otherwise repeated Telnyx-side rejections can rest a real number with zero real calls.
    // Legacy-tier dials (fromNumberId null) never went through the pool at all, nothing to undo.
    if (args.fromNumberId) {
      const { error: releaseError } = await supabase.rpc('release_reserved_dial_number', {
        p_org_id: args.orgId,
        p_number_id: args.fromNumberId,
      });
      if (releaseError) {
        dialerLog('dial_lead_release_number_failed', {
          sessionId: args.sessionId,
          legId: args.legId,
          fromNumberId: args.fromNumberId,
          error: releaseError.message,
        });
      }
    }
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
    // TASK-F-T3 (VMD-2): both the standard and premium greeting-ended webhooks normalize to
    // the SAME core event -- see dialer-core.ts's header for why the leg-level decision is
    // identical either way.
    case 'call.machine.greeting.ended':
      return { eventType: 'call.machine.greeting.ended' };
    case 'call.machine.premium.greeting.ended':
      // TASK-H34c: premium results are beep_detected | no_beep_detected | prompt_ended; only a
      // detected beep means "the greeting is over, safe to leave a message".
      return {
        eventType: 'call.machine.greeting.ended',
        beepDetected: String(raw.payload.result ?? '') === 'beep_detected',
      };
    case 'call.playback.ended':
      return { eventType: 'call.playback.ended' };
    case 'call.hangup':
      return {
        eventType: 'call.hangup',
        hangupCause: String(raw.payload.hangup_cause ?? 'unspecified') as HangupCause,
      };
    default:
      // call.bridged, call.playback.started, etc. -- not part of this leg's state machine.
      // Acked already by the caller; nothing more to do.
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

/** TASK-H32: the raw Telnyx detection result to persist on call_legs.amd_result (nothing wrote
 *  it before). Only the two detection-ended events carry one; every other event leaves the
 *  column alone (the key is omitted from transition_leg's p_fields). Observability only: no
 *  claim/reject decision reads this. */
function amdResultFields(event: TelnyxDialerEvent): { amd_result?: string } {
  if (
    event.eventType === 'call.machine.detection.ended' ||
    event.eventType === 'call.machine.premium.detection.ended'
  ) {
    return typeof event.result === 'string' && event.result
      ? { amd_result: event.result.slice(0, 64) }
      : {};
  }
  return {};
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

  // REC-2 (TASK-F-T2): call.recording.saved/error never drive the leg state machine (they're
  // not in mapToDialerEvent's switch at all -- would just be logged as unhandled and dropped),
  // so they're intercepted here, right after the SAME dedup check every other event already
  // gets (satisfies "idempotent on redelivery" for free), before the state-machine dispatch
  // below ever sees them.
  if (raw.eventType === 'call.recording.saved' || raw.eventType === 'call.recording.error') {
    await processRecordingEvent(supabase, raw);
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

/** REC-2/REC-3 (TASK-F-T2): handles `call.recording.saved`/`call.recording.error`, mapped back
 *  to our row via client_state's `leg` (never `callControlId` -- neither event's real payload
 *  carries `call_control_id` at all, see recording-core.ts's header). `call.recording.saved`
 *  fetches the mp3 from Telnyx's own temp URL (valid 10 minutes) and uploads it into the
 *  private `recordings` Storage bucket immediately, synchronously, in this same webhook call --
 *  never throws past this function (a download/upload failure is recorded as
 *  `recording_status='download_failed'`, keeping `recording_telnyx_call_leg_id` for a possible
 *  future manual retry via `GET /recordings?filter[call_leg_id]=`, not retried automatically
 *  here). */
async function processRecordingEvent(supabase: SupabaseClient, raw: RawTelnyxEvent): Promise<void> {
  const leg = await loadLegByCallControlIdOrClientLeg(
    supabase,
    raw.callControlId,
    raw.clientState.leg
  );
  if (!leg) {
    dialerLog('recording_event_no_leg', { eventType: raw.eventType, legId: raw.clientState.leg });
    return;
  }
  if (leg.org_id !== raw.orgId) {
    dialerLog('recording_event_org_mismatch', { legOrg: leg.org_id, eventOrg: raw.orgId });
    return;
  }

  if (raw.eventType === 'call.recording.error') {
    const { reason } = parseRecordingErrorPayload(raw.payload);
    await supabase
      .from('call_legs')
      .update({ recording_status: 'recording_failed' })
      .eq('id', leg.id);
    dialerLog('recording_failed_webhook', { legId: leg.id, reason });
    return;
  }

  const { mp3Url, telnyxCallLegId, durationSeconds } = parseRecordingSavedPayload(raw.payload);
  if (!mp3Url) {
    await supabase
      .from('call_legs')
      .update({
        recording_status: 'download_failed',
        recording_telnyx_call_leg_id: telnyxCallLegId,
        recording_duration_seconds: durationSeconds,
      })
      .eq('id', leg.id);
    dialerLog('recording_saved_no_mp3_url', { legId: leg.id });
    return;
  }

  try {
    const res = await fetch(mp3Url);
    if (!res.ok) throw new Error(`recording download failed: HTTP ${res.status}`);
    const bytes = await res.arrayBuffer();
    const path = recordingStoragePath(leg.org_id, leg.id);
    const { error: uploadError } = await supabase.storage
      .from('recordings')
      .upload(path, bytes, { contentType: 'audio/mpeg', upsert: true });
    if (uploadError) throw new Error(uploadError.message);

    await supabase
      .from('call_legs')
      .update({
        recording_status: 'saved',
        recording_path: path,
        recording_duration_seconds: durationSeconds,
        recording_telnyx_call_leg_id: telnyxCallLegId,
        recording_saved_at: new Date().toISOString(),
      })
      .eq('id', leg.id);
    dialerLog('recording_saved', { legId: leg.id, durationSeconds });
  } catch (err) {
    await supabase
      .from('call_legs')
      .update({
        recording_status: 'download_failed',
        recording_telnyx_call_leg_id: telnyxCallLegId,
        recording_duration_seconds: durationSeconds,
      })
      .eq('id', leg.id);
    dialerLog('recording_download_failed', { legId: leg.id, error: String(err) });
  }
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
      // TASK-F-T3: re-read fresh on every retry attempt from the SAME leg reload this loop
      // already does on a race loss -- never a second independent decision (see this leg row
      // field's own header comment on CallLegRow).
      voicemailDrop: currentLeg.voicemail_drop_path != null,
    });
    if (!result) {
      dialerLog('leg_transition_noop', {
        legId: currentLeg.id,
        current: currentLeg.state,
        eventType: event.eventType,
      });
      return null;
    }

    const fields: Record<string, unknown> = { ...amdResultFields(event) };
    if (result.outcome) fields.outcome = result.outcome;
    if (event.eventType === 'call.answered') fields.answered_at = new Date().toISOString();
    if (result.next === 'claimed') fields.claimed_at = new Date().toISOString();
    if (event.eventType === 'call.hangup') {
      fields.hangup_cause = event.hangupCause;
      const endedAt = new Date();
      fields.ended_at = endedAt.toISOString();
      // TASK-M1: talk duration is bridge-to-hangup, not answer-to-hangup -- a losing/abandoned/
      // machine leg was never bridged and keeps duration_seconds null (hangupOutcome only
      // returns 'connected' for a leg that reached 'claimed', dialer-core.ts). Falls back to
      // answered_at when the winner's own conference create/join failed (handleWin caught the
      // error and never stamped bridged_at) -- still a real, if imprecise, talk duration rather
      // than leaving a genuinely-connected call's Talk Time at zero.
      if (result.outcome === 'connected') {
        const bridgeStart =
          currentLeg.bridged_at ?? currentLeg.answered_at ?? currentLeg.claimed_at;
        if (bridgeStart) {
          fields.duration_seconds = Math.max(
            0,
            Math.round((endedAt.getTime() - new Date(bridgeStart).getTime()) / 1000)
          );
        }
      }
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

/** TASK-H34c. Two cases legTransition cannot express because they need the engine's own lookups.
 *  Returns true when the event was fully handled here.
 *  1. A premium greeting-ended that is not `beep_detected` on an ARMED machine leg: no voicemail
 *     is left (a message over the greeting is worse than none) -- plain hangup, outcome 'machine'.
 *  2. A beep-detected greeting-ended that arrives while the leg is NOT yet 'machine' (Telnyx sends only
 *     greeting.ended when the beep comes before detection.ended): it is a machine. Drop if a drop
 *     exists, else plain hangup. Only from a pre-decision state, via transition_leg's expected-state
 *     check, so a leg that was claimed/won is never touched. */
async function handleGreetingEndedSpecialCases(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow,
  event: Extract<TelnyxDialerEvent, { eventType: 'call.machine.greeting.ended' }>
): Promise<boolean> {
  if (leg.state === 'machine') {
    if (event.beepDetected === false && leg.voicemail_drop_path) {
      dialerLog('voicemail_drop_skipped_no_beep', { legId: leg.id });
      await hangupLeg(supabase, session.org_id, leg.call_control_id, 'machine_hangup_failed');
      return true;
    }
    return false;
  }
  if (event.beepDetected === false) return false;
  if (!['initiated', 'ringing', 'answered', 'amd_pending'].includes(leg.state)) return false;
  if (session.amd_mode === 'off' || session.amd_mode === 'detect') return false;

  const dropPath = await resolveVoicemailDropPath(supabase, session, leg);
  if (dropPath) {
    // Written BEFORE the transition on purpose (transition_leg cannot carry this column, and writing
    // it after leaves a crash window where a leg is 'voicemail_dropping' with no path, which
    // startVoicemailPlayback ignores until the sweeper reaps it). If the transition then loses the
    // race (claimed/abandoned), the leg keeps an unused path: nothing reads it outside 'machine'.
    await supabase.from('call_legs').update({ voicemail_drop_path: dropPath }).eq('id', leg.id);
  }
  const next: LegState = dropPath ? 'voicemail_dropping' : 'machine';
  const { data: applied, error } = await supabase.rpc('transition_leg', {
    p_call_control_id: leg.call_control_id,
    p_expected_states: [leg.state],
    p_new_state: next,
    p_fields: {},
  });
  if (error) throw new Error(`transition_leg (early beep): ${error.message}`);
  if (!applied) {
    // Claimed or moved by another event first: whatever it resolved to is authoritative.
    dialerLog('early_beep_race_skip', { legId: leg.id, state: leg.state });
    return true;
  }
  dialerLog('early_beep_machine', { legId: leg.id, from: leg.state, drop: Boolean(dropPath) });
  if (dropPath) {
    if (session.state === 'dialing') await refillSession(supabase, session.org_id, session.id);
    await startVoicemailPlayback(supabase, session, { ...leg, voicemail_drop_path: dropPath });
  } else {
    await hangupLeg(supabase, session.org_id, leg.call_control_id, 'machine_hangup_failed');
  }
  return true;
}

async function processContactLegEvent(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow,
  event: TelnyxDialerEvent
): Promise<void> {
  if (event.eventType === 'call.machine.greeting.ended') {
    if (await handleGreetingEndedSpecialCases(supabase, session, leg, event)) return;
  }

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
      p_fields: { outcome: 'connected', ...amdResultFields(event) },
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
  if (!applied) {
    // TASK-H34c: a detection result that reaches a leg which already left the state machine (it lost
    // the race, was dropped, or ended) is still worth keeping. State untouched; first value wins.
    const late = amdResultFields(event);
    if (late.amd_result) {
      await supabase
        .from('call_legs')
        .update({ amd_result: late.amd_result })
        .eq('id', leg.id)
        .is('amd_result', null);
      dialerLog('amd_result_late', { legId: leg.id, state: leg.state });
    }
    return;
  }
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
    // TASK-F-T3 (VMD-2/VMD-4): decide ONCE whether this leg should drop a voicemail. Dropping
    // means NOT hanging up here -- the leg stays 'machine' (armed, `voicemail_drop_path` set)
    // until its own call.machine.greeting.ended arrives (below) actually starts the playback.
    // Not dropping is exactly today's behavior, unchanged: hang up immediately.
    const dropPath = await resolveVoicemailDropPath(supabase, session, currentLeg);
    if (dropPath) {
      await supabase
        .from('call_legs')
        .update({ voicemail_drop_path: dropPath })
        .eq('id', currentLeg.id);
      dialerLog('voicemail_drop_armed', { legId: currentLeg.id, dropPath });
    } else {
      await hangupLeg(
        supabase,
        session.org_id,
        currentLeg.call_control_id,
        'machine_hangup_failed'
      );
    }
  } else if (result.next === 'voicemail_dropping') {
    // VMD-5: this leg no longer counts as an active dialing line (refillSession's own active-
    // count filter excludes 'voicemail_dropping') -- backfill its slot right away rather than
    // waiting for some OTHER leg to end and trigger the next refill incidentally.
    if (session.state === 'dialing') {
      await refillSession(supabase, session.org_id, session.id);
    }
    await startVoicemailPlayback(supabase, session, currentLeg);
  } else if (result.next === 'ended') {
    await supabase.rpc('apply_leg_outcome', { p_leg: currentLeg.id });
    if (currentLeg.id === session.active_leg_id) {
      // The winner just ended -- wrap_up, no more refill until a disposition (or
      // resumeToDialing, for testing) returns the session to dialing.
      // TASK-T4 review fix-forward (SHOULD): covers "the customer leg ends" mid-transfer-dial
      // (the agent-hangup case is already covered synchronously in endLiveCall above -- this
      // call is a harmless no-op by then, since cancelInFlightTransferForSession only matches a
      // still-'dialing'/'connected' row). No client carried into this webhook branch otherwise
      // (same reason hangupLeg/sendAbandonMessage each fetch their own, above) -- a failed
      // lookup here just means the transfer-cancel step no-ops, same fail-open spirit.
      const { client: transferCancelClient } = await getConnectedOrgTelnyxContext(
        supabase,
        session.org_id
      );
      if (transferCancelClient) {
        await cancelInFlightTransferForSession(
          supabase,
          transferCancelClient,
          session.org_id,
          session.id,
          'session_ended'
        );
      }
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

  if (event.eventType === 'call.playback.ended' && result.next === 'voicemail_dropping') {
    // VMD-2: the voicemail drop finished playing -- same "confirmation event issues the actual
    // hangup next" shape as call.speak.ended above. The resulting call.hangup preserves
    // 'voicemail_left' via hangupOutcome's own preserve-branch (dialer-core.ts).
    await hangupLeg(
      supabase,
      session.org_id,
      currentLeg.call_control_id,
      'voicemail_playback_ended_hangup_failed'
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

  // MISSION-5 TASK-M5-N1 review fix-forward (BLOCKER 2): a THIRD possible entry state, on top of
  // the pre-existing paused_agent_lost/ready_pending pair -- 'paused' with
  // `taken_over_by_manager_id` set (reconnectAgentLeg's own new branch). Captured once, from the
  // ORIGINAL session object (before this cascade changes anything). N1 fix-forward #2 (lead's
  // point 2): keyed on the dedicated `taken_over_by_manager_id` column, not a `pause_reason`
  // string match -- see reconnectAgentLeg's own header for why.
  const isTakeoverRecovery = session.state === 'paused' && session.taken_over_by_manager_id != null;

  // Cascade session state. paused_agent_lost -> ready is Reconnect's own path; ready_pending
  // -> ready is Go Ready's; a taken-over 'paused' -> ready is this fix-forward's own new path.
  // Either way 'ready' is genuinely observable (a poller/UI can catch it), then this immediately
  // decides what comes next: rejoin an ongoing call (a contact leg is still `claimed` -- the
  // agent dropped mid-call and is reconnecting), return to wrap_up (an undispositioned connected
  // leg is still waiting -- M4: this can be true even if the pre-loss state wasn't literally
  // 'wrap_up' yet, if the customer's own hangup only completed AFTER the agent already dropped),
  // return to a remembered manual `paused`, or resume/start rolling dialing (the ordinary case).
  const fromStates: SessionState[] = isTakeoverRecovery
    ? ['paused']
    : session.state === 'paused_agent_lost'
      ? ['paused_agent_lost']
      : ['ready_pending'];
  const { data: reachedReady } = await supabase.rpc('transition_session', {
    p_session: session.id,
    p_expected_states: fromStates,
    p_new_state: 'ready',
    p_fields: {},
  });
  if (!reachedReady) {
    // Already past ready_pending/paused_agent_lost/taken-over-paused (e.g. a duplicate/
    // redelivered call.answered after the cascade below already ran once) -- the conference
    // join above still ran (harmless if already joined), nothing else to do.
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
      // N1 fix-forward #2 (lead's point 1): clear both takeover-recovery breadcrumbs explicitly
      // -- transition_session leaves an omitted key completely unchanged, so without this a
      // session that went through a takeover-and-Rejoin would carry `pause_reason`/
      // `taken_over_by_manager_id` forward into `on_call` and every state reached after it.
      p_fields: {
        paused_agent_lost_from: null,
        pause_reason: null,
        taken_over_by_manager_id: null,
      },
    });
    dialerLog('agent_leg_rejoined_live_call', { sessionId: session.id });
    return;
  }

  // Skipped for a taken-over recovery: the session's own state-machine invariants mean the ONLY
  // connected+undispositioned contact leg this query could find here is the very leg that was
  // just taken over (a session can only reach `on_call` again once any earlier leg is already
  // dispositioned) -- and that leg is no longer this agent's to wrap up (dialer-session-
  // disposition's own manager-branch review fix-forward excludes the original agent from
  // dispositioning it once a takeover has happened). Falling into `wrap_up` here would strand the
  // rejoining agent on a call they can no longer see/hear or submit a disposition for, with no
  // way out of that state -- go straight to the ordinary dialing default instead.
  if (!isTakeoverRecovery) {
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
  }

  if (reloaded?.paused_agent_lost_from === 'paused') {
    // N1 fix-forward #2 (lead's point 1, reverify-eng1.md): this restore-to-paused branch must
    // explicitly clear a STALE takeover breadcrumb for ANY session reaching it, not only ones
    // still mid-recovery -- this is the exact branch eng1's re-verify found reachable with NO
    // malicious input at all (takeover -> successful Rejoin -> agent's leg drops again for an
    // unrelated reason while still 'paused'-flavored -> restores here with the stale marker
    // still attached to an otherwise completely ordinary paused session).
    //
    // Gated on `reloaded.taken_over_by_manager_id`, NOT unconditional: `pause_reason` on this
    // same column also carries an entirely legitimate value here in the ordinary case -- a
    // manually-paused agent's own free-text reason (dialer-session-pause/pauseSession), which
    // `handleAgentLegLost`'s own paused_agent_lost transition never touches and which this
    // restore is specifically here to bring back. Clearing it unconditionally would silently
    // erase that real reason on every ordinary manual-pause-then-dropped-leg reconnect --
    // trading one stale-data bug for another. Only a takeover ever sets
    // `taken_over_by_manager_id` (runTakeoverAction, alongside the reserved `pause_reason`
    // string) and only a takeover's own recovery cascade can leave it stale here, so checking
    // that column is what distinguishes "this pause_reason is a leftover takeover marker" from
    // "this pause_reason is the agent's real reason for being paused."
    const wasStaleTakeover = reloaded?.taken_over_by_manager_id != null;
    await supabase.rpc('transition_session', {
      p_session: session.id,
      p_expected_states: ['ready'],
      p_new_state: 'paused',
      p_fields: wasStaleTakeover
        ? { paused_agent_lost_from: null, pause_reason: null, taken_over_by_manager_id: null }
        : { paused_agent_lost_from: null },
    });
    dialerLog('agent_leg_returned_to_paused', { sessionId: session.id });
    return;
  }

  const { data: reachedDialing } = await supabase.rpc('transition_session', {
    p_session: session.id,
    p_expected_states: ['ready'],
    p_new_state: 'dialing',
    // N1 fix-forward #2 (lead's point 1): same clearing as the on_call/paused branches above --
    // the ordinary "dialing" default must not carry a stale takeover breadcrumb forward either.
    p_fields: { paused_agent_lost_from: null, pause_reason: null, taken_over_by_manager_id: null },
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
    (l) =>
      l.kind === 'contact' &&
      !['claimed', 'abandoned', 'dropped', ...MACHINE_RESOLVED_STATES].includes(l.state)
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

/** TASK-F-T3 (VMD-4): the drop-file lookup half of `resolveVoicemailDropPath` -- user-specific
 *  file for the dialing agent, else the org default (`user_id is null`), else null (no file at
 *  all, regardless of what the mode/attempt gating decided). */
async function loadVoicemailDropPath(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string
): Promise<string | null> {
  const { data: userRow } = await supabase
    .from('voicemail_drop_settings')
    .select('storage_path')
    .eq('org_id', orgId)
    .eq('user_id', agentId)
    .maybeSingle();
  if (userRow?.storage_path) return userRow.storage_path as string;
  const { data: orgRow } = await supabase
    .from('voicemail_drop_settings')
    .select('storage_path')
    .eq('org_id', orgId)
    .is('user_id', null)
    .maybeSingle();
  return (orgRow?.storage_path as string | undefined) ?? null;
}

/** TASK-F-T3 (VMD-2/VMD-4): decides, ONCE, at machine-detection-ended time, whether this leg
 *  should drop a voicemail -- and if so, which file. Never throws; any lookup failure here just
 *  means "don't drop" (the caller falls back to today's plain hangup) -- same fail-safe bias as
 *  `maybeStartRecording` below. `campaign.voicemail_drop_mode`/`amdModeSupportsVoicemailDrop`
 *  are both checked BEFORE the `campaign_leads` lookup, so a campaign that never drops voicemails
 *  (or an amd_mode that can't -- see voicemail-core.ts's own header) never pays for that extra
 *  query at all. */
async function resolveVoicemailDropPath(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow
): Promise<string | null> {
  try {
    if (!amdModeSupportsVoicemailDrop(session.amd_mode)) return null;
    const campaign = await loadCampaign(supabase, session.campaign_id);
    if (!campaign || campaign.voicemail_drop_mode === 'never') return null;
    if (!leg.lead_id) return null;
    const { data: leadRow, error: leadError } = await supabase
      .from('campaign_leads')
      .select('attempts')
      .eq('id', leg.lead_id)
      .maybeSingle();
    if (leadError) throw new Error(leadError.message);
    // campaign_leads.attempts is only ever incremented by apply_leg_outcome, which runs at
    // call.hangup -- still far in this leg's future at machine-detection-ended time, so this
    // read genuinely reflects "attempts completed before THIS dial", never a stale snapshot.
    const attemptsSoFar = (leadRow?.attempts as number | undefined) ?? 0;
    if (!shouldAttemptVoicemailDrop(campaign.voicemail_drop_mode, attemptsSoFar)) return null;
    return await loadVoicemailDropPath(supabase, session.org_id, session.agent_id);
  } catch (err) {
    dialerLog('voicemail_drop_resolve_failed', { legId: leg.id, error: String(err) });
    return null;
  }
}

/** VMD-2: mints a fresh, short-TTL signed URL for this leg's already-armed drop path
 *  (`leg.voicemail_drop_path`, resolved once at machine-detection-ended time -- see
 *  `resolveVoicemailDropPath`) and issues `playback_start`. Never blocks/throws past this
 *  function -- a failure here just leaves the leg sitting in 'voicemail_dropping' until the
 *  sweeper's own ~90s safety timeout reaps it (documented NOT-done: no retry here, matching
 *  `maybeStartRecording`'s own fail-open bias for the exact same reason -- a voicemail drop
 *  failing must never be allowed to strand the leg, and it's just one contact, not the live
 *  call). `audio_type` is derived from the stored path's own extension, not assumed -- see
 *  voicemail-core.ts's header for why a signed Storage URL can't be trusted to carry one. */
async function startVoicemailPlayback(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow
): Promise<void> {
  const path = leg.voicemail_drop_path;
  if (!path) return;
  try {
    const { client } = await getConnectedOrgTelnyxContext(supabase, session.org_id);
    if (!client) {
      await abortVoicemailDrop(supabase, session, leg, 'no_client');
      return;
    }
    const { data: signed, error: signError } = await supabase.storage
      .from('voicemail-drops')
      .createSignedUrl(path, VOICEMAIL_DROP_SIGNED_URL_TTL_SECONDS);
    if (signError || !signed?.signedUrl) {
      throw new Error(signError?.message ?? 'createSignedUrl returned no signedUrl');
    }
    const clientState = encodeDialClientState({
      org: session.org_id,
      session: session.id,
      leg: leg.id,
      kind: 'contact',
    });
    await client.playbackStart(leg.call_control_id, {
      audioUrl: signed.signedUrl,
      audioType: path.endsWith('.wav') ? 'wav' : 'mp3',
      clientState,
    });
    await supabase
      .from('call_legs')
      .update({ voicemail_drop_started_at: new Date().toISOString() })
      .eq('id', leg.id);
    dialerLog('voicemail_playback_started', { legId: leg.id, sessionId: session.id });
  } catch (err) {
    dialerLog('voicemail_playback_failed', { legId: leg.id, error: String(err) });
    await abortVoicemailDrop(supabase, session, leg, 'playback_failed');
  }
}

/** TASK-H34 (B): the drop could not start (no Telnyx client, signing failed, playback_start
 *  rejected). Before: the leg sat in 'voicemail_dropping' with the call still live until the
 *  voicemail hung up or the ~90 s sweeper, and was then recorded as 'voicemail_left' though nothing
 *  was left. Now: put it back to 'machine' and hang up like the no-drop path, so the outcome is
 *  the truthful 'machine'. Never throws. */
async function abortVoicemailDrop(
  supabase: SupabaseClient,
  session: DialSessionRow,
  leg: CallLegRow,
  reason: string
): Promise<void> {
  try {
    const { data: reverted } = await supabase.rpc('transition_leg', {
      p_call_control_id: leg.call_control_id,
      p_expected_states: ['voicemail_dropping'],
      p_new_state: 'machine',
      p_fields: {},
    });
    dialerLog('voicemail_drop_aborted', { legId: leg.id, reason, reverted: Boolean(reverted) });
    if (reverted) {
      await hangupLeg(
        supabase,
        session.org_id,
        leg.call_control_id,
        'voicemail_drop_abort_hangup_failed'
      );
    }
  } catch (err) {
    dialerLog('voicemail_drop_abort_failed', { legId: leg.id, error: String(err) });
  }
}

/** Runs once, right after `claim_leg` confirms this leg won. Bridges the winner into the
 *  conference, then proactively resolves every OTHER active leg (both still-ringing and
 *  already-answered) from a snapshot -- see this file's header for why this is safe even
 *  though a losing leg's own event might independently reach the same conclusion. */
/** REC-1 (TASK-F-T2): starts recording on the WINNING contact leg only, right after it's
 *  actually bridged. Never blocks or fails the bridge -- every failure (org opted out, no
 *  recording-settings row, or the Telnyx command itself throwing) is caught and logged, never
 *  rethrown. `channels: 'dual'` on a call-level (not conference-level) record_start already
 *  captures the whole bridge from this one participant leg's perspective (spec3.json's
 *  StartRecordingRequest: "final audio file will be stereo recorded with the first leg on
 *  channel A, and the rest on channel B") -- no conference-level record_start needed, and it
 *  would only complicate mapping the resulting webhook back to a single leg for no benefit.
 *  See decisions.md for the full writeup. */
async function maybeStartRecording(
  supabase: SupabaseClient,
  client: TelnyxClient,
  session: DialSessionRow,
  winnerLeg: CallLegRow
): Promise<void> {
  try {
    const { data: settings, error: settingsError } = await supabase
      .from('org_recording_settings')
      .select('recording_enabled')
      .eq('org_id', session.org_id)
      .maybeSingle();
    if (settingsError) throw new Error(settingsError.message);
    if (!isRecordingEnabled(settings)) {
      dialerLog('recording_skipped_disabled', { sessionId: session.id, legId: winnerLeg.id });
      return;
    }

    const clientState = encodeDialClientState({
      org: session.org_id,
      session: session.id,
      leg: winnerLeg.id,
      kind: 'contact',
    });
    await client.recordStart(winnerLeg.call_control_id, {
      format: 'mp3',
      channels: 'dual',
      clientState,
    });
    await supabase
      .from('call_legs')
      .update({ recording_status: 'recording' })
      .eq('id', winnerLeg.id);
    dialerLog('recording_started', { sessionId: session.id, legId: winnerLeg.id });
  } catch (err) {
    dialerLog('recording_start_failed', {
      sessionId: session.id,
      legId: winnerLeg.id,
      error: String(err),
    });
  }
}

/** MISSION-4 TASK-T8 (recording consent notice): spoken to the winner leg right after it's
 *  actually bridged (same "only once actually bridged" gating as `maybeStartRecording`, which
 *  this always runs after -- so a consent notice, if any, is itself part of the recording it
 *  announces). Best-effort, non-blocking (mirrors `sendAbandonMessage`'s own `try`/`catch` +
 *  `dialerLog`-and-continue shape) -- a failed lookup or a Telnyx error here must never affect
 *  the live call itself. */
async function maybeAnnounceRecordingConsent(
  supabase: SupabaseClient,
  client: TelnyxClient,
  session: DialSessionRow,
  winnerLeg: CallLegRow
): Promise<void> {
  try {
    const { data: settings, error: settingsError } = await supabase
      .from('org_recording_settings')
      .select('announce_recording_mode, all_party_consent_states, mention_monitoring')
      .eq('org_id', session.org_id)
      .maybeSingle();
    if (settingsError) throw new Error(settingsError.message);

    let contactState: string | null = null;
    if (winnerLeg.contact_id) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('phone_number')
        .eq('id', winnerLeg.contact_id)
        .maybeSingle();
      contactState = stateForE164((contact?.phone_number as string | undefined) ?? null);
    }

    if (!shouldAnnounceRecordingConsent(settings, contactState)) {
      return;
    }

    const orgName = await loadOrgName(supabase, session.org_id);
    await client.speak(winnerLeg.call_control_id, {
      payload: recordingConsentMessage(orgName, Boolean(settings?.mention_monitoring)),
      voice: DEFAULT_SPEAK_VOICE,
    });
    dialerLog('recording_consent_announced', {
      sessionId: session.id,
      legId: winnerLeg.id,
      contactState,
    });
  } catch (err) {
    dialerLog('recording_consent_announce_failed', {
      sessionId: session.id,
      legId: winnerLeg.id,
      error: String(err),
    });
  }
}

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
    // TASK-M1: only stamped once the create/join actually succeeded above (this line is
    // unreached on a thrown error) -- a leg that never really got bridged into live audio
    // falls back to answered_at for its talk-duration calc instead of lying about a bridge
    // time. `conferenceId` can still be falsy here if createConference succeeded but Telnyx
    // returned no id (existing edge case, unrelated to this task) -- guard on it explicitly
    // rather than stamping a bridge that has no conference behind it.
    if (conferenceId) {
      await supabase.rpc('transition_leg', {
        p_call_control_id: winnerLeg.call_control_id,
        p_expected_states: ['claimed'],
        p_new_state: 'claimed',
        p_fields: { bridged_at: new Date().toISOString() },
      });
      // REC-1: only ever the winner, only once actually bridged -- see maybeStartRecording's
      // own header for why this can never fail/block the call itself.
      await maybeStartRecording(supabase, client, session, winnerLeg);
      // MISSION-4 TASK-T8: runs AFTER recording starts, so the announcement (if any) is itself
      // part of the recording it's disclosing -- see maybeAnnounceRecordingConsent's own header.
      await maybeAnnounceRecordingConsent(supabase, client, session, winnerLeg);
    }
  } catch (err) {
    dialerLog('handle_win_conference_failed', { sessionId: session.id, error: String(err) });
  }

  const campaign = await loadCampaign(supabase, session.campaign_id);
  // TASK-L1: loadActiveLegs is kind-agnostic (by design -- stopSession relies on that to hang
  // up the agent leg too). loserActions (dialer-core.ts) predates the agent leg entirely and
  // has no concept of `kind` -- filter to CONTACT legs before computing it, or the agent's own
  // still-'answered' leg gets treated as a losing contact and gets spoken to / hung up here.
  // TASK-H34 (B): a leg already resolved as a machine ('machine', possibly armed to drop a
  // voicemail) or mid-drop ('voicemail_dropping') is NOT a losing human. Since TASK-F-T3 those legs
  // stay up for the whole greeting + playback, so a human win in the same session would
  // otherwise hang the drop up mid-message and relabel the leg 'dropped'.
  const legs = (await loadActiveLegs(supabase, session.id)).filter(
    (l) => l.kind === 'contact' && !MACHINE_RESOLVED_STATES.includes(l.state)
  );
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

/**
 * BUG-11: stopping a session with a live human bridged to the agent must not silently hang up
 * on them. `ParallelDialerUI` shows a confirm dialog whenever `sessionState === 'on_call'` and
 * only ever sends `force: true` once the intern has explicitly picked "Hang up and stop" (or
 * there was nothing live to confirm in the first place, in which case `force` is irrelevant --
 * the check below is a no-op when no leg is `claimed`). This server-side check is what actually
 * closes the gap for a STALE client build that predates the confirm dialog and never sends
 * `force` at all: it gets refused (`live_call_in_progress`) instead of silently hanging up a
 * live prospect, and it also closes the narrow race where the session goes `on_call` in the
 * moment between the UI's last poll and a stop click that (per the client's own stale view)
 * didn't need to confirm anything.
 *
 * Returns `{ ok: boolean; reason?: string }` (same convention as `reconnectAgentLeg`) rather
 * than throwing, since "refused, here's why" is an expected outcome here, not a failure.
 */
export async function stopSession(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string,
  force = false,
  // MISSION-5 TASK-M5-B2: remoteActorId is set ONLY by an owner/admin acting on a DIFFERENT
  // member's session (dialer-session-stop/index.ts decides this, not this function) -- it tags
  // the resulting stop as manager-initiated (pause_reason: 'remote_end_by_manager', read by the
  // client to show "ended by a manager" instead of the ordinary self-stop toast) and, when
  // `defer` is also true and a live call IS in progress, defers the actual stop instead of
  // refusing: writes remote_stop_requested_at/_by (no state change yet) so submit_disposition's
  // own wrap_up branch ends the session the moment the in-progress call's disposition is saved,
  // rather than resuming it -- "a live call is allowed to finish".
  opts?: { defer?: boolean; remoteActorId?: string }
): Promise<{ ok: boolean; reason?: string; deferred?: boolean }> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId) return { ok: false, reason: 'not_found' };

  const legs = await loadActiveLegs(supabase, sessionId);
  if (!force && legs.some((leg) => leg.kind === 'contact' && leg.state === 'claimed')) {
    if (opts?.defer && opts.remoteActorId) {
      await supabase
        .from('dial_sessions')
        .update({
          remote_stop_requested_at: new Date().toISOString(),
          remote_stop_requested_by: opts.remoteActorId,
        })
        .eq('id', sessionId);
      return { ok: false, reason: 'live_call_in_progress', deferred: true };
    }
    return { ok: false, reason: 'live_call_in_progress' };
  }

  const { client } = await getConnectedOrgTelnyxContext(supabase, orgId);
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
    p_fields: opts?.remoteActorId
      ? { ended_at: new Date().toISOString(), pause_reason: 'remote_end_by_manager' }
      : { ended_at: new Date().toISOString() },
  });
  dialerLog('stop_session_done', { sessionId, hungUpLegs: legs.length });
  return { ok: true };
}

export async function pauseSession(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string,
  // TASK-I1: an inbound call bridging into this session (INB-1/INB-3's "pause the batch
  // dialing... then connect the inbound caller") passes 'inbound_call' here so the UI can show
  // something more specific than a bare pause -- every existing call site keeps passing nothing,
  // which stays the N1 behavior (explicitly clear any stale auto-pause reason).
  reason: string | null = null
): Promise<boolean> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId) return false;
  const { data, error } = await supabase.rpc('transition_session', {
    p_session: sessionId,
    // MISSION-5 TASK-M5-B2: widened to also cover 'ready_pending' -- an owner/admin's remote
    // pause (dialer-session-pause/index.ts now permits this, see that file's own header) can
    // click fast enough to catch that transient boot-up window in a way the agent's own Pause
    // button never could (haltIntakeForOffboarding, A3, already had to widen its own equivalent
    // list for the exact same reason).
    p_expected_states: ['ready_pending', 'dialing', 'ready'],
    p_new_state: 'paused',
    p_fields: { pause_reason: reason },
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
    p_fields: { pause_reason: null },
  });
  if (error) throw new Error(`resumeToDialing: ${error.message}`);
  if (data) await refillSession(supabase, orgId, sessionId);
  return Boolean(data);
}

/**
 * MISSION-5 TASK-M5-A3: the disable/remove cascade's "stops taking new batches immediately"
 * half. Unlike `pauseSession`/`stopSession` (both take a `sessionId` the caller already knows --
 * the agent's own browser, mid-session), this is ADMIN-initiated against a different user's
 * session, found by `agent_id` (there is at most one non-terminal row per agent --
 * `dial_sessions_one_active_per_agent`), and needs to also catch `ready_pending` -- the
 * transient boot-up state between `startSession`'s insert and the engine's own first
 * confirmation, which `pauseSession`'s own expected-state list (`['dialing', 'ready']`) never
 * needed to cover since its only real caller (the agent's own Pause button) can't click it that
 * fast.
 *
 * `refillSession` only ever dials while `state === 'dialing'` (checked at its own top), so moving
 * the session out of `ready_pending`/`ready`/`dialing` is sufficient to stop new batches from
 * being claimed. `on_call`/`wrap_up` are deliberately left alone -- a live call is allowed to
 * finish -- and they can never transition back to `dialing` on their own after this point: the
 * only path back (`resumeToDialing`, via `dialer-session-resume`) requires the member's own
 * authenticated call, and `requireOrgRole`/`requireTelnyxOrgRole` both already refuse a
 * non-`'active'` `org_members.status` before any handler runs.
 *
 * Returns `null` if the agent has no non-terminal session at all (nothing to do -- a common
 * case, most members aren't mid-shift when disabled/removed).
 */
export async function haltIntakeForOffboarding(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string
): Promise<{ sessionId: string; halted: boolean } | null> {
  const { data, error } = await supabase
    .from('dial_sessions')
    .select('id, state')
    .eq('org_id', orgId)
    .eq('agent_id', agentId)
    .neq('state', 'stopped')
    .neq('state', 'completed')
    .maybeSingle();
  if (error) throw new Error(`haltIntakeForOffboarding: ${error.message}`);
  if (!data) return null;

  if (!['ready_pending', 'ready', 'dialing'].includes(data.state)) {
    return { sessionId: data.id, halted: false };
  }

  const { data: ok, error: transErr } = await supabase.rpc('transition_session', {
    p_session: data.id,
    p_expected_states: ['ready_pending', 'ready', 'dialing'],
    p_new_state: 'paused',
    p_fields: { pause_reason: 'Member offboarded' },
  });
  if (transErr) throw new Error(`haltIntakeForOffboarding: ${transErr.message}`);
  return { sessionId: data.id, halted: Boolean(ok) };
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
    .select('call_control_id, recording_status, recording_paused_at, recording_paused_spans')
    .eq('id', session.active_leg_id)
    .maybeSingle();
  if (!leg) return false;
  const { client } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (!client) return false;
  // TASK-T4 review fix-forward (SHOULD): the agent explicitly hung up -- cancel any transfer
  // still 'dialing'/'connected' for this session BEFORE hanging up the prospect leg, so the
  // target's ring stops and (for a connected warm transfer) the agent is already moved back to
  // the main conference. Best-effort, never throws -- a failure here must never block the
  // hangup itself. Reuses the client already fetched above, no second Telnyx-context lookup.
  await cancelInFlightTransferForSession(supabase, client, orgId, sessionId, 'agent_hangup');
  // TASK-T8 review fix-forward (SHOULD): the agent can hang up while recording is paused
  // (no Resume click) -- close the still-open span now, at the call end, rather than leaving
  // `recording_paused_at` set with no matching `recording_paused_spans` entry forever. Same
  // read-then-append shape as `resumeRecording`; best-effort so a failure here never blocks the
  // hangup itself.
  await closeOpenPausedRecordingSpan(supabase, session.active_leg_id, leg);
  await client.hangup(leg.call_control_id as string);
  return true;
}

/** Shared by `endLiveCall`'s hangup-while-paused case: closes the currently-open
 *  `recording_paused_at` span into `recording_paused_spans`, if one is open. A no-op when the
 *  leg isn't `'paused'` (the normal case). Never throws -- called from the hangup path, which
 *  must complete regardless. */
async function closeOpenPausedRecordingSpan(
  supabase: SupabaseClient,
  legId: string,
  leg: {
    recording_status?: string | null;
    recording_paused_at?: string | null;
    recording_paused_spans?: unknown;
  }
): Promise<void> {
  try {
    if (leg.recording_status !== 'paused' || !leg.recording_paused_at) return;
    const spans = Array.isArray(leg.recording_paused_spans) ? leg.recording_paused_spans : [];
    const nextSpans = [
      ...spans,
      { paused_at: leg.recording_paused_at, resumed_at: new Date().toISOString() },
    ];
    await supabase
      .from('call_legs')
      .update({ recording_paused_at: null, recording_paused_spans: nextSpans })
      .eq('id', legId);
  } catch (err) {
    dialerLog('recording_paused_span_close_failed', { legId, error: String(err) });
  }
}

/** MISSION-4 TASK-T8: pauses the currently-recording winner leg's own recording. Only acts on a
 *  leg whose `recording_status` is actually `'recording'` right now -- a stale double-click (the
 *  UI already disables the button once paused, but this is the server-side guard, not just a UI
 *  nicety) is a safe no-op. No CAS/race protection needed beyond that single read-then-act check
 *  -- unlike `transition_leg`/`transition_session` (which race real Telnyx webhooks arriving
 *  concurrently), this is a single agent's own button click, handled by one edge-function
 *  invocation at a time; there is no second writer to lose a race against. */
export async function pauseRecording(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<boolean> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId || !session.active_leg_id) return false;
  const { data: leg } = await supabase
    .from('call_legs')
    .select('call_control_id, recording_status')
    .eq('id', session.active_leg_id)
    .maybeSingle();
  if (!leg || leg.recording_status !== 'recording') return false;
  const { client } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (!client) return false;
  await client.recordPause(leg.call_control_id as string);
  await supabase
    .from('call_legs')
    .update({ recording_status: 'paused', recording_paused_at: new Date().toISOString() })
    .eq('id', session.active_leg_id);
  return true;
}

/** MISSION-4 TASK-T8: resumes a paused winner-leg recording, and closes the just-finished pause
 *  span into `recording_paused_spans` (REC's own "the recording's metadata notes the paused
 *  spans" ask) -- read-then-append rather than a jsonb `||` expression, since this is a single
 *  agent-initiated action (no concurrent writer to race, see `pauseRecording`'s own comment) and
 *  reads far more plainly. */
export async function resumeRecording(
  supabase: SupabaseClient,
  orgId: string,
  sessionId: string
): Promise<boolean> {
  const session = await loadSession(supabase, sessionId);
  if (!session || session.org_id !== orgId || !session.active_leg_id) return false;
  const { data: leg } = await supabase
    .from('call_legs')
    .select('call_control_id, recording_status, recording_paused_at, recording_paused_spans')
    .eq('id', session.active_leg_id)
    .maybeSingle();
  if (!leg || leg.recording_status !== 'paused') return false;
  const { client } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (!client) return false;
  await client.recordResume(leg.call_control_id as string);
  const pausedAt = leg.recording_paused_at as string | null;
  const spans = Array.isArray(leg.recording_paused_spans)
    ? (leg.recording_paused_spans as unknown[])
    : [];
  const nextSpans = pausedAt
    ? [...spans, { paused_at: pausedAt, resumed_at: new Date().toISOString() }]
    : spans;
  await supabase
    .from('call_legs')
    .update({
      recording_status: 'recording',
      recording_paused_at: null,
      recording_paused_spans: nextSpans,
    })
    .eq('id', session.active_leg_id);
  return true;
}

/**
 * Pure decision logic for the Phase 2 dial engine (design §4.1-4.6). No fetch, no DB,
 * no Deno.env -- every function here is a total, deterministic mapping from inputs to
 * a decision, so E1's SQL and E2's engine can both be tested against the exact same
 * rules instead of re-implementing them.
 *
 * Event names, AMD result enums and hangup_cause values were verified 2026-09-23/24
 * against Telnyx's published OpenAPI spec (the developers.telnyx.com API-reference
 * pages 404 through automated fetch; the spec is Telnyx's own primary source):
 *   https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json
 * Schemas checked: CallInitiatedEvent, CallAnsweredEvent, CallHangupEvent,
 * CallMachineDetectionEndedEvent, CallMachinePremiumDetectionEndedEvent,
 * CallSpeakEndedEvent, CallBridgedEvent.
 *
 * Two corrections versus this task's own spec text, found during that verification:
 * - There is no `call.ringing` webhook event in the current spec (zero matches for
 *   "ring" in any event_type enum). The task spec already hedged this ("if emitted").
 *   `legTransition` still accepts it, for forward compatibility, but it is currently
 *   unreachable in production -- telnyx-webhook will never receive it.
 * - The premium AMD "fax" result is actually `fax_detected` in the enum
 *   (CallMachinePremiumDetectionEnded.result), not "fax" as the task spec assumed.
 *   Standard (non-premium) detection's result enum is only `human | machine |
 *   not_sure` -- `human_residence`/`human_business`/`silence`/`fax_detected` are
 *   premium-only, consistent with design §4.5 ("on" mode always uses premium).
 *
 * TASK-F-T3 (VMD-1..5, BUG-7), voicemail drop + real AMD modes -- re-verified against
 * spec3.json/webhook-events.json 2026-09-25:
 * - `AmdMode` widens from the old boolean-ish 'off'|'on' ('on' always meant premium) to the 4
 *   real Telnyx values this build now offers a campaign: 'off'|'detect'|'detect_words'|
 *   'premium'. `amdDecision`'s own claim/reject logic needed NO change -- it already only
 *   branches on `mode === 'off'` vs. not, never on which non-off mode.
 * - Critical vendor constraint, not a design choice: plain `detect` NEVER emits
 *   `call.machine.greeting.ended` (spec3.json's own field description: only `greeting_end`,
 *   `detect_words` and `detect_beep` do, for standard detection; premium's greeting-ended is
 *   separately beep-gated). A voicemail drop has no reliable "safe to play now" signal under
 *   plain `detect` -- dialer-engine.ts's drop-decision helper (voicemail-core.ts) returns "no
 *   drop" for `detect` regardless of the campaign's own voicemail_drop_mode. See decisions.md.
 * - New leg state `voicemail_dropping` (between 'machine' and 'ended') and outcome
 *   'voicemail_left', added the same way TASK-F-T2 added `call.recording.*` handling --
 *   except this one DOES drive the leg state machine (recording is metadata-only; a voicemail
 *   drop controls real leg lifecycle/timing), so it lives in `legTransition` itself, not a
 *   side-channel intercept in dialer-engine.ts.
 * - `call.machine.greeting.ended` here is a NORMALIZED core event: dialer-engine.ts's
 *   mapToDialerEvent maps BOTH the standard and premium raw greeting-ended webhooks to it --
 *   the leg-level decision is identical either way, only the raw event_type differs.
 */

// ---------------------------------------------------------------------------
// Types and const arrays (design §4.4). Exported as `as const` arrays so E1's SQL
// CHECK constraints can copy the exact string values.
// ---------------------------------------------------------------------------

export const SESSION_STATES = [
  'ready_pending',
  'ready',
  'dialing',
  'connecting',
  'on_call',
  'wrap_up',
  'paused',
  'paused_agent_lost',
  'stopped',
  'completed',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const LEG_STATES = [
  'initiated',
  'ringing',
  'answered',
  'amd_pending',
  'claimed',
  'dropped',
  'abandoned',
  'machine',
  'voicemail_dropping',
  'ended',
] as const;
export type LegState = (typeof LEG_STATES)[number];

export const LEG_OUTCOMES = [
  'no_answer',
  'busy',
  'machine',
  'dropped',
  'abandoned',
  'failed',
  'connected',
  'voicemail_left',
] as const;
export type LegOutcome = (typeof LEG_OUTCOMES)[number];

/** TASK-F-T3/BUG-7: widened from the old boolean-ish 'off'|'on' ('on' always meant premium) to
 *  the 4 real Telnyx `answering_machine_detection` values this build actually offers a campaign
 *  ('disabled' is never surfaced -- 'off' means "don't send AMD at all", a distinct dial-time
 *  choice, not a 5th detection tier). Verified against spec3.json's CallRequest schema
 *  (2026-09-25): the full enum is `premium | detect | detect_beep | detect_words | greeting_end |
 *  disabled` -- `detect_beep`/`greeting_end` are not exposed here (no task requirement asked for
 *  them, and both are narrower special cases of `detect_words` for this build's purposes). */
export const AMD_MODES = ['off', 'detect', 'detect_words', 'premium'] as const;
export type AmdMode = (typeof AMD_MODES)[number];

/** call.machine.detection.ended (standard AMD) result enum, per spec3.json. */
export type AmdStandardResult = 'human' | 'machine' | 'not_sure';

/** call.machine.premium.detection.ended (premium AMD) result enum, per spec3.json. */
export type AmdPremiumResult =
  'human_residence' | 'human_business' | 'machine' | 'silence' | 'fax_detected' | 'not_sure';

/** call.hangup's hangup_cause enum, per spec3.json (CallHangup.hangup_cause). */
export type HangupCause =
  | 'call_rejected'
  | 'normal_clearing'
  | 'originator_cancel'
  | 'timeout'
  | 'time_limit'
  | 'user_busy'
  | 'not_found'
  | 'no_answer'
  | 'unspecified';

// ---------------------------------------------------------------------------
// legTransition
// ---------------------------------------------------------------------------

export type TelnyxDialerEvent =
  | { eventType: 'call.initiated' }
  | { eventType: 'call.ringing' }
  | { eventType: 'call.answered' }
  | { eventType: 'call.machine.detection.ended'; result: AmdStandardResult }
  | { eventType: 'call.machine.premium.detection.ended'; result: AmdPremiumResult }
  | { eventType: 'call.hangup'; hangupCause: HangupCause }
  | { eventType: 'call.speak.ended' }
  /** TASK-F-T3 (VMD-2): the engine normalizes BOTH `call.machine.greeting.ended` (standard --
   *  only ever emitted for `detect_words`/`detect_beep`/`greeting_end` modes, per spec3.json's
   *  own `answering_machine_detection` description) and `call.machine.premium.greeting.ended`
   *  (premium -- only emitted when a beep is actually detected) into this ONE core event before
   *  calling legTransition -- the leg-level decision ("greeting's over, safe to play the drop
   *  now") is identical either way; only dialer-engine.ts's mapToDialerEvent needs to know which
   *  raw webhook it came from. */
  | {
      eventType: 'call.machine.greeting.ended';
      /** TASK-H34c: false when a PREMIUM greeting-ended carries any result other than
       *  `beep_detected` (`no_beep_detected` fires at the AMD timeout, possibly mid-greeting, so a drop
       *  would play over the owner's greeting). Undefined/true = safe to play (standard AMD's own
       *  greeting-ended, or a detected beep). Set only by dialer-engine.ts's mapToDialerEvent. */
      beepDetected?: boolean;
    }
  /** VMD-2/VMD-5: confirms the voicemail drop audio finished playing on a machine leg -- same
   *  "no state change, the engine issues the actual hangup command next" shape as
   *  call.speak.ended's own abandoned-message confirmation. */
  | { eventType: 'call.playback.ended' };

export interface LegTransitionCtx {
  amdMode: AmdMode;
  /**
   * Which leg wins the single-winner claim (design §4.3's atomic Postgres UPDATE),
   * decided by the caller *before* calling legTransition. Required exactly when a
   * claim decision is being finalized (amdDecision resolves to 'claim'): the
   * amd-off `call.answered` path, and the amd-on detection-ended path when the
   * result says human. Ignored otherwise. legTransition throws if a claim decision
   * is reached with no `claim` supplied -- that's a caller contract violation, not
   * an out-of-order/duplicate event (which returns null instead).
   */
  claim?: 'won' | 'lost';
  /**
   * call.hangup only: true when the engine itself issued the hangup (another leg
   * already won the race, or AMD rejected this leg) rather than a natural
   * Telnyx-side hangup. Defaults to false (a natural hangup) when omitted.
   */
  hungUpByEngine?: boolean;
  /**
   * TASK-F-T3 (VMD-2): call.machine.greeting.ended only. Decided by the caller BEFORE calling
   * legTransition -- exactly the same "caller decides, legTransition just applies it" shape as
   * `claim` -- from whether this leg already has a voicemail-drop file armed (dialer-engine.ts
   * persists that decision onto the leg row the moment call.machine.detection(.premium).ended
   * resolves to 'machine', so this ctx flag is a fresh re-read of that same row, not a second
   * independent decision that could drift from the first one). true -> move to
   * 'voicemail_dropping' (about to play the drop). Not set/false -> this event is a no-op here;
   * the leg was either already hung up immediately at machine-detection time (the common case),
   * or is in some other state this event doesn't apply to.
   */
  voicemailDrop?: boolean;
}

export type LegTransitionResult = { next: LegState; outcome?: LegOutcome } | null;

function resolveClaimDecision(
  decision: AmdDecision,
  ctx: LegTransitionCtx,
  pendingState: LegState
): LegTransitionResult {
  if (decision === 'wait') return { next: pendingState };
  if (decision === 'reject') return { next: 'machine', outcome: 'machine' };
  // decision === 'claim'
  if (ctx.claim === undefined) {
    throw new Error(
      'legTransition: an AMD/answer decision resolved to "claim" but ctx.claim was not supplied'
    );
  }
  return ctx.claim === 'won'
    ? { next: 'claimed', outcome: 'connected' }
    : { next: 'abandoned', outcome: 'abandoned' };
}

/**
 * Maps (current leg state, Telnyx event, context) to the next leg state and, when
 * the transition is terminal for a decision, its outcome. Returns null when the
 * event is out-of-order or a duplicate for the current state -- callers treat that
 * as a no-op, which is what makes webhook redelivery safe (design §4.4).
 */
export function legTransition(
  current: LegState,
  event: TelnyxDialerEvent,
  ctx: LegTransitionCtx
): LegTransitionResult {
  switch (event.eventType) {
    case 'call.initiated':
      return current === 'initiated' ? { next: 'ringing' } : null;

    case 'call.ringing':
      // Not emitted by the current Telnyx Call Control API -- see the header comment.
      // Kept for forward compatibility; currently unreachable in production.
      return current === 'initiated' ? { next: 'ringing' } : null;

    case 'call.answered': {
      // Accepts 'initiated' as well as 'ringing': webhook delivery order isn't
      // guaranteed, so call.answered can arrive before call.initiated's own
      // ringing transition has been applied (TASK-P2-E2, E0's 04 verify). Without
      // this, an out-of-order call.answered was silently dropped (returned null)
      // and a live human was never claimed until the sweeper timed the leg out.
      if (current !== 'ringing' && current !== 'initiated') return null;
      const decision = amdDecision(ctx.amdMode, undefined);
      return resolveClaimDecision(decision, ctx, 'amd_pending');
    }

    case 'call.machine.detection.ended':
    case 'call.machine.premium.detection.ended': {
      // Same out-of-order allowance as call.answered above: AMD only ever fires
      // after a real answer, so a detection-ended event arriving before this
      // leg's own call.answered was processed still means the call was in fact
      // answered -- accept it from 'ringing'/'initiated' too, not just the normal
      // 'amd_pending' (reached after call.answered already ran).
      if (ctx.amdMode === 'off') return null;
      if (current !== 'amd_pending' && current !== 'ringing' && current !== 'initiated') {
        return null;
      }
      const decision = amdDecision(ctx.amdMode, event.result);
      return resolveClaimDecision(decision, ctx, 'amd_pending');
    }

    case 'call.speak.ended':
      // Confirms the "sorry we missed you" message (loserActions) finished playing to
      // an abandoned answered loser. No state change -- the engine issues the actual
      // hangup command next, and call.hangup (below) closes the leg out.
      return current === 'abandoned' ? { next: 'abandoned' } : null;

    case 'call.machine.greeting.ended':
      // Only ever reachable from 'machine' (this leg's own AMD already rejected it as a
      // machine). ctx.voicemailDrop === false/undefined means the not-dropping case --
      // dialer-engine.ts already issued the hangup immediately at machine-detection time for
      // that case, so a genuinely LATE arrival of this event here almost always finds the leg
      // no longer 'machine' at all (returns null below); this branch is defensive, not the
      // normal path for "not dropping".
      if (current !== 'machine' || !ctx.voicemailDrop || event.beepDetected === false) return null;
      return { next: 'voicemail_dropping' };

    case 'call.playback.ended':
      // Same no-op-confirmation shape as call.speak.ended above: the engine issues the actual
      // hangup command next (see dialer-engine.ts's processContactLegEvent).
      return current === 'voicemail_dropping' ? { next: 'voicemail_dropping' } : null;

    case 'call.hangup': {
      if (current === 'ended') return null;
      return {
        next: 'ended',
        outcome: hangupOutcome({
          state: current,
          hangupCause: event.hangupCause,
          hungUpByEngine: ctx.hungUpByEngine ?? false,
        }),
      };
    }
  }
}

// ---------------------------------------------------------------------------
// agentLegTransition (TASK-L1)
// ---------------------------------------------------------------------------

/** The agent leg never runs AMD or a single-winner claim -- it only ever answers or hangs
 *  up, so it gets its own tiny state machine instead of sharing legTransition's
 *  claim/AMD-aware one. */
export type AgentLegEvent =
  | { eventType: 'call.initiated' }
  | { eventType: 'call.answered' }
  | { eventType: 'call.hangup'; hangupCause: HangupCause };

/**
 * Maps (current agent-leg state, event) to the next state, or null for an out-of-order/
 * duplicate event (same no-op convention as legTransition -- safe under webhook redelivery).
 * The agent leg has no `outcome` column value that means anything (apply_leg_outcome is a
 * lead/campaign_leads concept) -- callers pass a fixed bookkeeping value at the DB layer, not
 * one derived here.
 */
export function agentLegTransition(current: LegState, event: AgentLegEvent): LegState | null {
  switch (event.eventType) {
    case 'call.initiated':
      return current === 'initiated' ? 'ringing' : null;
    case 'call.answered':
      return current === 'initiated' || current === 'ringing' ? 'answered' : null;
    case 'call.hangup':
      return current === 'ended' ? null : 'ended';
  }
}

// ---------------------------------------------------------------------------
// amdDecision
// ---------------------------------------------------------------------------

export type AmdDecision = 'claim' | 'reject' | 'wait';

/**
 * off -> always claim (on call.answered, with no AMD result to evaluate).
 * on, no result yet -> wait (the detection-ended event hasn't arrived).
 * on, with a result -> claim for human/human_residence/human_business/not_sure/silence,
 * reject for machine/fax_detected only. TASK-H19: 'silence' claims -- a person who answers and
 * says nothing must reach the intern, a dropped real prospect costs more than a wasted bridge. An unrecognized result value claims:
 * a false "machine" drops a real prospect, so the default favors not giving up on
 * one, mirroring hangupOutcome's own default bias below.
 */
export function amdDecision(
  mode: AmdMode,
  result?: AmdStandardResult | AmdPremiumResult | string
): AmdDecision {
  if (mode === 'off') return 'claim';
  if (result === undefined) return 'wait';
  switch (result) {
    case 'human':
    case 'human_residence':
    case 'human_business':
    case 'not_sure':
    case 'silence':
      return 'claim';
    case 'machine':
    case 'fax_detected':
      return 'reject';
    default:
      return 'claim';
  }
}

// ---------------------------------------------------------------------------
// hangupOutcome
// ---------------------------------------------------------------------------

export interface HangupLegHistory {
  /** The leg's state immediately before this call.hangup event. */
  state: LegState;
  hangupCause: HangupCause;
  hungUpByEngine: boolean;
}

/**
 * Finalizes a leg's outcome at call.hangup. If the leg already reached a
 * claim/reject decision (claimed/machine/dropped/abandoned), that decision's
 * outcome is preserved -- call.hangup only closes the leg out, it never overrides
 * an outcome already reached. Otherwise (still initiated/ringing/answered/
 * amd_pending -- no decision was ever reached):
 * - hung up by the engine itself (another leg won, or an AMD reject already in
 *   flight when the hangup command raced ahead of the detection-ended webhook):
 *   'dropped' if never answered, 'abandoned' if it was.
 * - a natural Telnyx-side hangup: hangup_cause maps to busy/no_answer directly, or
 *   to 'failed' for the two causes that mean the number itself is bad
 *   (call_rejected, not_found). Every other, more ambiguous pre-answer cause
 *   defaults to 'no_answer' (retried) rather than 'failed' (exhausted) -- same bias
 *   toward not giving up on a real prospect as amdDecision's unknown-result default.
 */
export function hangupOutcome(leg: HangupLegHistory): LegOutcome {
  if (leg.state === 'claimed') return 'connected';
  if (leg.state === 'machine') return 'machine';
  if (leg.state === 'dropped') return 'dropped';
  if (leg.state === 'abandoned') return 'abandoned';
  if (leg.state === 'voicemail_dropping') return 'voicemail_left';

  if (leg.hungUpByEngine) {
    return leg.state === 'ringing' || leg.state === 'initiated' ? 'dropped' : 'abandoned';
  }

  switch (leg.hangupCause) {
    case 'user_busy':
      return 'busy';
    case 'no_answer':
      return 'no_answer';
    case 'call_rejected':
    case 'not_found':
      return 'failed';
    default:
      return 'no_answer';
  }
}

// ---------------------------------------------------------------------------
// refillCount
// ---------------------------------------------------------------------------

/**
 * How many new legs to dial right now. Zero unless the session is 'dialing' AND
 * the agent leg is 'answered' -- both are checked explicitly (not folded into a
 * single richer session state) because design §4.1 makes this exact pairing a
 * safety invariant ("the engine refuses to dial unless the agent leg is
 * answered"), not just an implied precondition of reaching 'dialing'. A session
 * can be read as still 'dialing' in the instant after the agent leg drops and
 * before 'paused_agent_lost' lands.
 */
export function refillCount(
  sessionState: SessionState,
  agentLegState: LegState,
  lines: number,
  activeLegs: number
): number {
  if (sessionState !== 'dialing' || agentLegState !== 'answered') return 0;
  return Math.max(0, lines - activeLegs);
}

// ---------------------------------------------------------------------------
// loserActions
// ---------------------------------------------------------------------------

export interface DialerLeg {
  id: string;
  state: LegState;
}

export type LoserAction = 'speak_then_hangup' | 'hangup';

/**
 * Every leg except the winner gets an action: 'speak_then_hangup' for a leg that
 * was already answered by a human when it lost (design §4.6's abandoned-call
 * message), but only when the campaign has the message enabled; plain 'hangup'
 * for every other loser (still ringing, or the message is disabled).
 */
export function loserActions(
  legs: DialerLeg[],
  winnerId: string,
  abandonMessageEnabled: boolean
): { legId: string; action: LoserAction }[] {
  return legs
    .filter((leg) => leg.id !== winnerId)
    .map((leg) => {
      const wasAnswered = leg.state === 'answered' || leg.state === 'amd_pending';
      return {
        legId: leg.id,
        action: wasAnswered && abandonMessageEnabled ? 'speak_then_hangup' : 'hangup',
      };
    });
}

// ---------------------------------------------------------------------------
// leadOutcomeUpdate
// ---------------------------------------------------------------------------

export interface LeadOutcomeInput {
  /** Current lead status, e.g. 'in_flight'. Passed through unchanged for 'connected'. */
  status: string;
  attempts: number;
}

export interface LeadOutcomeCampaignConfig {
  /** Default 3, per design §4.2. */
  maxAttempts?: number;
  /** Default 2h, per design §4.2. */
  retryIntervalMs?: number;
}

export interface LeadOutcomeUpdate {
  status: 'queued' | 'exhausted' | string;
  attempts: number;
  next_attempt_at: string | null;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2h
const DROPPED_OR_ABANDONED_RETRY_INTERVAL_MS = 15 * 60 * 1000; // 15min

/**
 * Design §4.2's outcome table. `dropped` does not increment attempts ("the person
 * was rung only because of our parallelism"); `abandoned` does, at the same
 * short 15-minute retry as `dropped` (its "high priority" is achieved purely by
 * that short interval sorting ahead of normal retries under `ORDER BY attempts
 * ASC, next_attempt_at ASC, position ASC` -- no separate priority column exists,
 * or is needed). `failed` exhausts unconditionally. `connected` leaves `status` to
 * the disposition step and only bumps attempts. Every attempts-incrementing branch
 * re-checks `attempts >= maxAttempts` and exhausts instead of requeuing when true.
 */
export function leadOutcomeUpdate(
  outcome: LegOutcome,
  lead: LeadOutcomeInput,
  campaign: LeadOutcomeCampaignConfig,
  now: Date
): LeadOutcomeUpdate {
  const maxAttempts = campaign.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const retryIntervalMs = campaign.retryIntervalMs ?? DEFAULT_RETRY_INTERVAL_MS;

  const queuedOrExhausted = (attempts: number, delayMs: number): LeadOutcomeUpdate =>
    attempts >= maxAttempts
      ? { status: 'exhausted', attempts, next_attempt_at: null }
      : {
          status: 'queued',
          attempts,
          next_attempt_at: new Date(now.getTime() + delayMs).toISOString(),
        };

  switch (outcome) {
    case 'no_answer':
    case 'busy':
    case 'machine':
    case 'voicemail_left':
      return queuedOrExhausted(lead.attempts + 1, retryIntervalMs);
    case 'dropped':
      return queuedOrExhausted(lead.attempts, DROPPED_OR_ABANDONED_RETRY_INTERVAL_MS);
    case 'abandoned':
      return queuedOrExhausted(lead.attempts + 1, DROPPED_OR_ABANDONED_RETRY_INTERVAL_MS);
    case 'failed':
      return { status: 'exhausted', attempts: lead.attempts, next_attempt_at: null };
    case 'connected':
      return { status: lead.status, attempts: lead.attempts + 1, next_attempt_at: null };
  }
}

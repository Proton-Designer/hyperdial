/**
 * Pure logic for TASK-I1 (inbound callback routing, INB-1..4 + CID-6): who an inbound call
 * should ring next, and in what order. No Telnyx/DB I/O here -- that's inbound-engine.ts, same
 * split as dialer-core.ts/dialer-engine.ts.
 *
 * The step order is recomputed fresh every time (from the ORIGINAL, unchanging inputs: whether
 * an intern is assigned, whether the org has a shared destination, etc.) rather than persisted
 * as a plan -- `inbound_calls.state` already records which step is CURRENT, so "what's next"
 * is just "the entry after this one in a freshly recomputed list." Nothing about the inputs
 * changes mid-call (an intern going offline mid-ring doesn't retroactively change earlier
 * decisions), so recomputation is deterministic and always agrees with itself.
 */

export type InboundStep =
  'bridging_session' | 'ringing_intern' | 'ringing_cell' | 'ringing_shared' | 'voicemail';

/** INB-3: "if they're busy or offline or it isn't answered in ~20s". */
export const INBOUND_RING_TIMEOUT_SECS = 20;

/** "was seen in the app in the last 2 min" -- the online half of the busy/online/offline check
 *  when there's no active dial_session to read state from directly. */
export const INBOUND_PRESENCE_WINDOW_MS = 2 * 60 * 1000;

export interface DialSessionSnapshot {
  id: string;
  state: string;
}

/** No dial_session in on_call/connecting/wrap_up -- the task's own literal definition of
 *  "free." A session that HAS an active_leg_id in some other state shouldn't exist per the
 *  state machine's own invariants, so state alone is sufficient here. */
export function isAgentBusyOnACall(session: DialSessionSnapshot | null): boolean {
  if (!session) return false;
  return (
    session.state === 'on_call' || session.state === 'connecting' || session.state === 'wrap_up'
  );
}

/** A session in ready/dialing/paused is one whose conference already has the agent's own
 *  WebRTC leg in it and nobody else -- "join it like a winner" is safe. `ready_pending` (agent
 *  leg not even up yet) and `paused_agent_lost` (agent's own leg is gone) are deliberately
 *  excluded: there is no live agent leg in that conference to bridge the caller to. */
export function isAgentInJoinableSession(session: DialSessionSnapshot | null): boolean {
  if (!session) return false;
  return session.state === 'ready' || session.state === 'dialing' || session.state === 'paused';
}

export function isAgentOnline(lastSeenAt: string | null, nowMs: number = Date.now()): boolean {
  if (!lastSeenAt) return false;
  const seenAt = new Date(lastSeenAt).getTime();
  if (Number.isNaN(seenAt)) return false;
  return nowMs - seenAt <= INBOUND_PRESENCE_WINDOW_MS;
}

export interface InboundRoutingInputs {
  /** false for a team-pool number (assigned_user_id null) -- INB-1's own "goes to the org's
   *  shared destination" rule, skipping the intern-ringing steps entirely. */
  hasAssignedIntern: boolean;
  internBusyOnACall: boolean;
  /** Set only when the intern has a session AND it's joinable (see isAgentInJoinableSession) --
   *  callers compute this from the same session row as internBusyOnACall so the two can never
   *  disagree about which session they're describing. */
  joinableSessionId: string | null;
  internOnline: boolean;
  hasForwardNumber: boolean;
  hasSharedDestination: boolean;
}

/** The ordered fallback chain for ONE inbound call, computed once from inputs that don't change
 *  during the call. 'voicemail' is always last and always present -- INB-3's chain has no exit
 *  that isn't voicemail or an actual answer. */
export function planInboundSteps(inputs: InboundRoutingInputs): InboundStep[] {
  const steps: InboundStep[] = [];
  if (inputs.hasAssignedIntern && !inputs.internBusyOnACall) {
    if (inputs.joinableSessionId) {
      steps.push('bridging_session');
    } else if (inputs.internOnline) {
      steps.push('ringing_intern');
    }
  }
  if (inputs.hasForwardNumber) steps.push('ringing_cell');
  if (inputs.hasSharedDestination) steps.push('ringing_shared');
  steps.push('voicemail');
  return steps;
}

/** The step immediately after `current` in a freshly recomputed plan -- null once `current` was
 *  the last one (voicemail exhausted: caller hung up before or during it, INB-4's 'missed'). */
export function nextInboundStep(
  current: InboundStep,
  inputs: InboundRoutingInputs
): InboundStep | null {
  const plan = planInboundSteps(inputs);
  const index = plan.indexOf(current);
  if (index === -1 || index === plan.length - 1) return null;
  return plan[index + 1];
}

/** INB-4's exact 4-value outcome, derived from which step the call was on when it ended and
 *  whether that step actually connected. */
export function outcomeForEndedCall(args: {
  lastStep: InboundStep;
  connected: boolean;
}): 'answered_by_agent' | 'forwarded' | 'voicemail' | 'missed' {
  if (args.lastStep === 'voicemail') return args.connected ? 'voicemail' : 'missed';
  if (!args.connected) return 'missed';
  return args.lastStep === 'bridging_session' || args.lastStep === 'ringing_intern'
    ? 'answered_by_agent'
    : 'forwarded';
}

/** CID-1's own NANP-only area-code note (private.pick_and_reserve_dial_number, 20260925070000)
 *  applies here too, for matching the caller's own number against contacts.phone_number -- but
 *  this is a plain equality match (no area-code preference concept for inbound), so no NANP
 *  scoping is needed; kept here only as a shared "is this a usable E.164" guard so a malformed
 *  `from` never gets treated as a matchable contact.
 */
export function isPlausibleE164(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
}

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
  /** Review fix (eng1 review-eng1.md finding #4): needed to tell "paused, empty conference,
   *  safe to join" apart from "paused BECAUSE a prior inbound call is already bridged into it"
   *  -- both look identical as a bare `state`. */
  pauseReason: string | null;
}

/** No dial_session in on_call/connecting/wrap_up -- the task's own literal definition of
 *  "free." A session that HAS an active_leg_id in some other state shouldn't exist per the
 *  state machine's own invariants, so state alone is sufficient here.
 *
 *  Review fix (eng1 review-eng1.md finding #4): a session `'paused'` because a PRIOR inbound
 *  call is already bridged into it (`pauseSession(..., 'inbound_call')`) is ALSO busy in every
 *  practical sense -- the intern's WebRTC leg is occupied with that caller -- even though its
 *  bare `state` isn't one of the three outbound-call-shaped busy states. Without this, a second
 *  inbound call for the same intern would see `internBusyOnACall = false` and try
 *  `'ringing_intern'` (transferring a SECOND invite at an already-occupied WebRTC client) instead
 *  of going straight down the busy fallback chain (cell -> shared -> voicemail) as intended. */
export function isAgentBusyOnACall(session: DialSessionSnapshot | null): boolean {
  if (!session) return false;
  if (
    session.state === 'on_call' ||
    session.state === 'connecting' ||
    session.state === 'wrap_up'
  ) {
    return true;
  }
  return session.state === 'paused' && session.pauseReason === 'inbound_call';
}

/** A session in ready/dialing/paused is one whose conference already has the agent's own
 *  WebRTC leg in it -- "join it like a winner" is safe, PROVIDED it's not already hosting a
 *  bridged caller from an EARLIER inbound call. `ready_pending` (agent leg not even up yet) and
 *  `paused_agent_lost` (agent's own leg is gone) are deliberately excluded: there is no live
 *  agent leg in that conference to bridge the caller to.
 *
 *  Review fix (eng1 review-eng1.md finding #4): `'paused'` alone is ambiguous -- a session is
 *  ALSO paused (same state string) for the entire duration a prior inbound caller is bridged
 *  into it (`pauseSession(..., 'inbound_call')`, inbound-engine.ts's `enterStep`), which is NOT
 *  an empty, safe-to-join conference. Without this check, a second inbound call for the same
 *  intern while the first one is still live would ALSO be routed to `bridging_session` and
 *  joined into the SAME conference -- two unrelated callers bridged together. `'paused'` is
 *  joinable only when `pauseReason` is anything OTHER than `'inbound_call'` (a manual pause, or
 *  none at all). */
export function isAgentInJoinableSession(session: DialSessionSnapshot | null): boolean {
  if (!session) return false;
  if (session.state === 'ready' || session.state === 'dialing') return true;
  return session.state === 'paused' && session.pauseReason !== 'inbound_call';
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

/** Fixed priority order for `nextInboundStep` below -- never derived from a freshly recomputed
 *  plan's own array position (see that function's own header comment for why). */
const STEP_PRIORITY: Record<InboundStep, number> = {
  bridging_session: 0,
  ringing_intern: 1,
  ringing_cell: 2,
  ringing_shared: 3,
  voicemail: 4,
};

/** The next step to try, ranked strictly AFTER `current` -- never "the entry after `current`'s
 *  own position in a freshly recomputed plan," which silently dead-ends (review fix, eng1
 *  review-eng1.md finding #3: `buildRoutingInputs` re-reads live inputs on every call, so if
 *  they changed enough that `current` no longer appears in the fresh plan at all -- e.g. the
 *  intern started a NEW dial session mid-ring, so 'ringing_intern' drops out in favor of
 *  'bridging_session' -- `indexOf` returned -1 and the caller silently hung up on the caller
 *  with no Telnyx command at all: real dead air). Ranking by a FIXED priority order instead and
 *  taking the first step in the fresh plan whose rank exceeds `current`'s own rank means this
 *  only ever returns null when `current` was already `'voicemail'` (rank 4, nothing outranks
 *  it) -- `planInboundSteps` always includes `'voicemail'` unconditionally, so there is always a
 *  real next step to advance to unless the chain was already exhausted. */
export function nextInboundStep(
  current: InboundStep,
  inputs: InboundRoutingInputs
): InboundStep | null {
  const plan = planInboundSteps(inputs);
  const currentRank = STEP_PRIORITY[current];
  return plan.find((step) => STEP_PRIORITY[step] > currentRank) ?? null;
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

/** TASK-H36: turns what a person typed ("(830) 563-5638", "8305635638", "1 830 563 5638",
 *  "+18305635638") into E.164, or null when it can't be done safely. A bare 10-digit or
 *  1-prefixed 11-digit number is read as NANP (+1) -- the same US/Canada default the rest of the
 *  product assumes; any other number must already carry its own "+" and country code. A stored
 *  forward number that is not E.164 makes Telnyx reject the transfer (422 code 10016), which is
 *  what stranded 14 inbound calls in 'ringing_cell'. */
export function normalizeToE164(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/[^\d\s().+-]/.test(trimmed)) return null;
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (hasPlus) return isPlausibleE164(`+${digits}`) ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1') && /^[2-9]/.test(digits.slice(1))) {
    return `+${digits}`;
  }
  return null;
}

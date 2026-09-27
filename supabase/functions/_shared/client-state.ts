/**
 * client_state for the rewritten dial engine (design §3/§4): `{org, session, leg}`,
 * round-tripped through Telnyx as base64 JSON on every leg. This is a distinct shape
 * from the legacy `DecodedClientState` in `dialer-engine.ts` (userId/sessionId/
 * contactId/campaignId/batchIndex) — that module is untouched by this task.
 *
 * `kind` (TASK-L1): distinguishes the agent's own leg from a contact leg. Optional and
 * defaults to 'contact' on decode -- every client_state encoded before this task (still live
 * on in-flight contact legs at deploy time) has no `kind` key at all, and must keep decoding
 * the same way it always did. `webrtc.ts`'s incoming-call auto-answer gate is the reader that
 * actually needs to tell the two apart (it must never auto-answer a contact leg's own
 * notification, which never happens today, but stay correct if that ever changes) --
 * `dialer-engine.ts`'s webhook dispatch already tells legs apart via `call_legs.kind`
 * (persisted, authoritative) and does not need this field at all.
 */

export type DialClientStateKind = 'agent' | 'contact';

export interface DialClientState {
  org: string;
  session: string;
  leg: string;
  kind: DialClientStateKind;
}

/**
 * TASK-T3 (live coaching): a distinct shape from both `DialClientState` and `InboundClientState`
 * -- a coaching leg is never dialed by the dial engine or the inbound-routing engine, it's a
 * MANAGER's own SIP leg dialed by `coaching-core.ts` to join another agent's already-live
 * conference as a Telnyx supervisor. `coaching` is `coaching_sessions.id` -- the webhook handler
 * (`processTelnyxCoachingEvent`) looks the row up by this id, never by session/leg the way the
 * other two shapes do, since a coaching leg has no `call_legs` row of its own at all (deliberate
 * -- see coaching-core.ts's header for why keeping it OUT of call_legs entirely is what makes
 * this feature provably unable to affect the dial loop's own kind-agnostic code paths).
 */
export type CoachingMode = 'listen' | 'whisper' | 'barge';

export interface CoachingClientState {
  org: string;
  coaching: string;
  kind: 'coaching';
  /** Round-tripped purely for the browser's own banner display (CoachingBanner.tsx) -- the DB
   *  row (coaching_sessions.mode) stays authoritative for every server-side decision; nothing
   *  here is ever trusted for anything but what label to show. */
  mode: CoachingMode;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const COACHING_MODES: CoachingMode[] = ['listen', 'whisper', 'barge'];

/** Throws on invalid input -- same contract as encodeDialClientState/encodeInboundClientState. */
export function encodeCoachingClientState(state: Omit<CoachingClientState, 'kind'>): string {
  if (!isNonEmptyString(state.org) || !isNonEmptyString(state.coaching)) {
    throw new Error('encodeCoachingClientState: org and coaching are required non-empty strings');
  }
  if (!COACHING_MODES.includes(state.mode)) {
    throw new Error(`encodeCoachingClientState: invalid mode '${state.mode}'`);
  }
  return btoa(
    JSON.stringify({ org: state.org, coaching: state.coaching, kind: 'coaching', mode: state.mode })
  );
}

/** Never throws -- untrusted input from a webhook. Returns null on anything malformed, or on a
 *  well-formed DialClientState/InboundClientState (both decode to objects with no `coaching`
 *  key), so a single client_state value can be tried against all three decoders safely. */
export function decodeCoachingClientState(
  value: string | null | undefined
): CoachingClientState | null {
  if (!value) return null;
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(atob(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    decoded.kind !== 'coaching' ||
    !isNonEmptyString(decoded.org) ||
    !isNonEmptyString(decoded.coaching)
  ) {
    return null;
  }
  const mode: CoachingMode = COACHING_MODES.includes(decoded.mode as CoachingMode)
    ? (decoded.mode as CoachingMode)
    : 'listen';
  return { org: decoded.org, coaching: decoded.coaching, kind: 'coaching', mode };
}

/** Throws on invalid input — callers build this from trusted, already-validated IDs.
 *  `kind` defaults to 'contact' (every call site before TASK-L1 dialed a contact). */
export function encodeDialClientState(
  state: Omit<DialClientState, 'kind'> & { kind?: DialClientStateKind }
): string {
  if (
    !isNonEmptyString(state.org) ||
    !isNonEmptyString(state.session) ||
    !isNonEmptyString(state.leg)
  ) {
    throw new Error('encodeDialClientState: org, session and leg are required non-empty strings');
  }
  return btoa(
    JSON.stringify({
      org: state.org,
      session: state.session,
      leg: state.leg,
      kind: state.kind ?? 'contact',
    })
  );
}

/** Never throws — untrusted input from a webhook. Returns null on anything malformed. */
export function decodeDialClientState(value: string | null | undefined): DialClientState | null {
  if (!value) return null;
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(atob(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    !isNonEmptyString(decoded.org) ||
    !isNonEmptyString(decoded.session) ||
    !isNonEmptyString(decoded.leg)
  ) {
    return null;
  }
  const kind: DialClientStateKind = decoded.kind === 'agent' ? 'agent' : 'contact';
  return { org: decoded.org, session: decoded.session, leg: decoded.leg, kind };
}

/**
 * client_state for TASK-I1 (inbound routing): `{org, inbound, step}` -- a distinct shape from
 * `DialClientState`, so the webhook entry point tries both decoders and treats a match on
 * either as "ours" (see telnyx-webhook/index.ts). A genuinely fresh inbound call's own FIRST
 * `call.initiated` carries no client_state at all (nothing has set one yet) -- that case is
 * recognized by `direction === 'incoming'` + no decodable state of either shape, not by this
 * decoder.
 *
 * `step` says which command produced the leg this state is riding on:
 * - 'intern'/'cell'/'shared': a `transfer`'s `target_leg_client_state` -- these ride on Leg B,
 *   a BRAND NEW call_control_id distinct from the original inbound leg's.
 * - 'voicemail': the ORIGINAL inbound leg's own `client_state`, set by the `answer` call right
 *   before entering the voicemail sub-flow (speak/record_start all act on that same leg).
 */
export type InboundCallStep = 'intern' | 'cell' | 'shared' | 'voicemail';

export interface InboundClientState {
  org: string;
  inbound: string;
  step: InboundCallStep;
}

const INBOUND_CALL_STEPS: InboundCallStep[] = ['intern', 'cell', 'shared', 'voicemail'];

export function encodeInboundClientState(state: InboundClientState): string {
  if (!isNonEmptyString(state.org) || !isNonEmptyString(state.inbound)) {
    throw new Error('encodeInboundClientState: org and inbound are required non-empty strings');
  }
  if (!INBOUND_CALL_STEPS.includes(state.step)) {
    throw new Error(`encodeInboundClientState: invalid step '${state.step}'`);
  }
  return btoa(JSON.stringify({ org: state.org, inbound: state.inbound, step: state.step }));
}

/** Never throws — untrusted input from a webhook. Returns null on anything malformed. */
export function decodeInboundClientState(
  value: string | null | undefined
): InboundClientState | null {
  if (!value) return null;
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(atob(value)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (
    !isNonEmptyString(decoded.org) ||
    !isNonEmptyString(decoded.inbound) ||
    !INBOUND_CALL_STEPS.includes(decoded.step as InboundCallStep)
  ) {
    return null;
  }
  return {
    org: decoded.org,
    inbound: decoded.inbound,
    step: decoded.step as InboundCallStep,
  };
}

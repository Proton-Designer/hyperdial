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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
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

/**
 * client_state for the rewritten dial engine (design §3/§4): `{org, session, leg}`,
 * round-tripped through Telnyx as base64 JSON on every leg. This is a distinct shape
 * from the legacy `DecodedClientState` in `dialer-engine.ts` (userId/sessionId/
 * contactId/campaignId/batchIndex) — that module is untouched by this task.
 */

export interface DialClientState {
  org: string;
  session: string;
  leg: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Throws on invalid input — callers build this from trusted, already-validated IDs. */
export function encodeDialClientState(state: DialClientState): string {
  if (
    !isNonEmptyString(state.org) ||
    !isNonEmptyString(state.session) ||
    !isNonEmptyString(state.leg)
  ) {
    throw new Error('encodeDialClientState: org, session and leg are required non-empty strings');
  }
  return btoa(JSON.stringify({ org: state.org, session: state.session, leg: state.leg }));
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
  return { org: decoded.org, session: decoded.session, leg: decoded.leg };
}

/** TASK-I1 review fix (eng1 finding #2): exponential backoff for the Dialer's WebRTC
 *  connect-outside-sessions effect. Extracted as pure functions (no test runner exists for the
 *  web client -- CLAUDE.md's own "no automated tests" note -- so these are exercised by
 *  `?dev_webrtc_retry=1`'s harness, not a unit test) so the delay math and the "stop retrying
 *  entirely" classification are each independently reasoned about instead of buried inside the
 *  effect's own closure. */

export const WEBRTC_RETRY_BASE_MS = 5_000;
export const WEBRTC_RETRY_MAX_MS = 5 * 60_000;

/** Doubles the delay, capped at WEBRTC_RETRY_MAX_MS -- 5s, 10s, 20s, ..., capping at 5min. */
export function nextWebrtcRetryDelayMs(currentDelayMs: number): number {
  return Math.min(currentDelayMs * 2, WEBRTC_RETRY_MAX_MS);
}

/** A definitive "the org has no Telnyx connection" response (getConnectedOrgTelnyxContext's own
 *  400 message, telnyx-org-context.ts) is not a transient failure -- retrying it on a timer
 *  just re-runs the same rejection forever until the org actually connects Telnyx, which is a
 *  separate action (Settings), not something that resolves itself. Stop the retry loop entirely
 *  rather than backing off; the org-Telnyx-status check that gates the effect in the first place
 *  covers the common case, this covers the race where it disconnects mid-session. */
export function isDefinitiveTelnyxNotConnectedError(message: string): boolean {
  return /not connected/i.test(message);
}

export const LOGIN_REFUSED_MESSAGE =
  'Telnyx refused your phone line login. An admin needs to check that the HyperDial connection is turned on in Telnyx (Connections), then reload.';

/** TASK-H30: the Telnyx SDK emits `telnyx.error` with a plain object (`{error:{code,name,message}}`), not an Error.
 *  Turns whatever arrives into a real Error with a readable message; the original stays on `cause`. Reads defensively. */
export function telnyxErrorToError(raw: unknown): Error {
  if (raw instanceof Error) return raw;
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const inner = (o.error && typeof o.error === 'object' ? o.error : o) as Record<string, unknown>;
  const code =
    typeof inner.code === 'number' || typeof inner.code === 'string' ? String(inner.code) : '';
  const name = typeof inner.name === 'string' ? inner.name : '';
  const message =
    typeof inner.message === 'string' ? inner.message : typeof raw === 'string' ? raw : '';
  if (code === '46001' || code === '-32001' || name === 'LOGIN_FAILED') {
    const e = new Error(LOGIN_REFUSED_MESSAGE, { cause: raw });
    e.name = 'TelnyxLoginRefused';
    return e;
  }
  const detail = [code || name, message].filter(Boolean).join(': ');
  return new Error(
    `Couldn't connect your phone line${detail ? ` (${detail})` : ''}. Check your internet and try again.`,
    {
      cause: raw,
    }
  );
}

/** Login refused is not transient: retrying on a timer never fixes it. */
export function isTelnyxLoginRefused(e: unknown): boolean {
  return e instanceof Error && e.name === 'TelnyxLoginRefused';
}

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

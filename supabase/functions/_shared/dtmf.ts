/** TASK-H11: validation + authorisation for sending keypad tones to the live contact leg. Pure, so the
 *  decisions are unit-tested without Telnyx or a database. */

export const MAX_DTMF_DIGITS = 16;

/** Keypad keys only: 0-9 * #. Telnyx also accepts A-D and w/W pauses; the dialing-screen keypad never needs them. */
export function parseDtmfDigits(raw: unknown): { digits: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'digits is required' };
  const digits = raw.trim();
  if (digits.length === 0) return { error: 'digits is required' };
  if (digits.length > MAX_DTMF_DIGITS) {
    return { error: `at most ${MAX_DTMF_DIGITS} digits at a time` };
  }
  if (!/^[0-9*#]+$/.test(digits)) return { error: 'digits may only be 0-9, * and #' };
  return { digits };
}

export interface DtmfTargetInput {
  sessionOrgId: string | null;
  callerOrgId: string;
  sessionAgentId: string | null;
  callerUserId: string;
  activeLegId: string | null;
  leg: {
    id: string;
    org_id: string;
    session_id: string;
    kind: string;
    state: string;
    call_control_id: string | null;
  } | null;
  sessionId: string;
}

/** Live states a contact leg can be in while a person is (or may be) on the line: answered but not yet
 *  bridged, or claimed (bridged to the agent). Anything else (ringing, ended, dropped...) has nobody to
 *  press keys for. */
const DTMF_LEG_STATES = ['answered', 'amd_pending', 'claimed'];

/** Returns the call_control_id to send to, or a status + message to answer with. Only the session's own
 *  agent may send, whatever their role, and only on the session's current contact leg. */
export function resolveDtmfTarget(
  i: DtmfTargetInput
): { callControlId: string } | { status: number; error: string } {
  if (!i.sessionOrgId || i.sessionOrgId !== i.callerOrgId) {
    return { status: 404, error: 'Session not found' };
  }
  if (i.sessionAgentId !== i.callerUserId) return { status: 403, error: 'Not your session' };
  if (!i.activeLegId || !i.leg || i.leg.id !== i.activeLegId) {
    return { status: 400, error: 'No live call' };
  }
  if (
    i.leg.org_id !== i.callerOrgId ||
    i.leg.session_id !== i.sessionId ||
    i.leg.kind !== 'contact' ||
    !DTMF_LEG_STATES.includes(i.leg.state) ||
    !i.leg.call_control_id
  ) {
    return { status: 400, error: 'No live call' };
  }
  return { callControlId: i.leg.call_control_id };
}

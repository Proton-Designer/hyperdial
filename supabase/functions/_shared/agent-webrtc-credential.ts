/**
 * TASK-L1 review fix (B1): the org member's WebRTC on-demand credential, get-or-create,
 * extracted from `telnyx-webrtc-credentials/index.ts` (TASK-P1-06's own get-or-create-by-
 * stored-id-then-find-by-name-then-create shape) so `dialer-engine.ts`'s `agentSipUri` can
 * call the SAME logic instead of just reading `org_members.telnyx_credential_id` and throwing
 * `AGENT_NOT_REGISTERED` if it's still null.
 *
 * Why this was a real bug, not just a missing nice-to-have: `org_members.telnyx_credential_id`
 * was ONLY ever set by the browser's own `getWebrtcCredentials` call (which runs
 * `telnyx-webrtc-credentials/index.ts`) -- but `dialer-session-start` dials the agent's SIP URI
 * ("Go Ready") as part of the SAME synchronous call that creates the session, and the browser
 * only starts trying to connect its WebRTC client AFTER it learns a session exists (i.e. after
 * `dialer-session-start` has already returned). So a first-time member's very first Start
 * always hit `AGENT_NOT_REGISTERED` -- there was no possible ordering where the credential
 * already existed. Making the SERVER side get-or-create the same credential (reusing it if the
 * browser happens to have already connected, creating it if not) removes that ordering
 * dependency entirely. The browser still needs to actually be listening for the auto-answer to
 * work in practice (a separate, disclosed pre-flight/timing concern), but the credential and
 * the dial itself no longer depend on it.
 */
import type { TelnyxClient } from './telnyx-client.ts';
import type { getSupabaseAdmin } from './telnyx-org-context.ts';

export function memberCredentialName(orgId: string, userId: string): string {
  return `hyperdial-member-${orgId}-${userId}`;
}

export async function getOrCreateMemberCredentialId(
  client: TelnyxClient,
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orgId: string,
  userId: string,
  connectionId: string
): Promise<string> {
  const { data: member, error: memberError } = await supabase
    .from('org_members')
    .select('telnyx_credential_id')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .maybeSingle();
  if (memberError) {
    throw new Error(`org_members lookup failed: ${memberError.message}`);
  }

  const storedId: string | null = member?.telnyx_credential_id ?? null;
  let credentialId = storedId;

  if (credentialId) {
    try {
      await client.getTelephonyCredential(credentialId);
    } catch {
      // Stale id (deleted on Telnyx's side, or from a stale/wrong environment) -- fall
      // through to find-or-create instead of failing the whole request.
      credentialId = null;
    }
  }

  if (!credentialId) {
    const name = memberCredentialName(orgId, userId);
    const found = await client.findTelephonyCredentialByName(name);
    credentialId = typeof found?.id === 'string' ? found.id : null;

    if (!credentialId) {
      const created = await client.createTelephonyCredential({ connectionId, name });
      credentialId = typeof created.id === 'string' ? created.id : null;
      if (!credentialId) {
        throw new Error('Telnyx did not return an id for the telephony credential');
      }
    }
  }

  if (credentialId !== storedId) {
    const { error: updateError } = await supabase
      .from('org_members')
      .update({ telnyx_credential_id: credentialId })
      .eq('org_id', orgId)
      .eq('user_id', userId);
    if (updateError) {
      console.error(
        '[agent-webrtc-credential] failed to persist telnyx_credential_id',
        updateError.message
      );
      // Not fatal to this call (the caller still gets a working credential id) -- but the
      // next call will re-find-or-create rather than reuse, same window
      // telnyx-provision.ts documents for the org-level resources.
    }
  }

  return credentialId;
}

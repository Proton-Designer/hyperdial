/**
 * Mint a WebRTC login token for the calling agent (TASK-P1-06). Fixes the credential
 * leak this task exists for: the old version called `telephonyCredentials.create` on
 * every single invocation and never stored/reused the result, so every page load or
 * reconnect minted a brand-new, never-cleaned-up Telnyx credential.
 *
 * Get-or-create, stable per (org, member): `org_members.telnyx_credential_id` is the
 * persisted id. Same idempotent-provisioning-with-fallback shape as
 * `_shared/telnyx-provision.ts` (reuse the stored id; if it's gone or was never
 * persisted, fall back to a Telnyx-side find-by-name lookup before creating) --
 * "idempotent because we're the only writer of our own bookkeeping" only holds if the
 * bookkeeping write itself can't fail after the side effect it's supposed to record
 * (LANE-eng2.md, TASK-P1-05 fix), so the same defense applies here even though the
 * failure window is per-member rather than per-org.
 *
 * `getOrCreateMemberCredentialId` moved to `_shared/agent-webrtc-credential.ts` (TASK-L1
 * review fix B1) so `dialer-engine.ts`'s `agentSipUri` can create the same credential
 * server-side instead of requiring the browser to have called this endpoint first.
 */
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  requireTelnyxOrgRole,
  getSupabaseAdmin,
  getConnectedOrgTelnyxContext,
} from '../_shared/telnyx-org-context.ts';
import { getOrCreateMemberCredentialId } from '../_shared/agent-webrtc-credential.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  const {
    user,
    orgId,
    error: roleError,
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent']);
  if (roleError) return roleError;

  const supabase = getSupabaseAdmin();
  const {
    client,
    credentialConnectionId,
    error: telnyxError,
  } = await getConnectedOrgTelnyxContext(supabase, orgId);
  if (telnyxError) return telnyxError;
  if (!credentialConnectionId) {
    return jsonResponse(
      { error: 'Telnyx is connected but has no WebRTC credential connection on record.' },
      500
    );
  }

  try {
    const credentialId = await getOrCreateMemberCredentialId(
      client,
      supabase,
      orgId,
      user.id,
      credentialConnectionId
    );
    const { token } = await client.mintCredentialToken(credentialId);
    if (!token) {
      return jsonResponse({ error: 'Failed to get a WebRTC token from Telnyx.' }, 500);
    }
    return jsonResponse({ token });
  } catch (err) {
    console.error('[telnyx-webrtc-credentials] error', err);
    const message = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: message }, 500);
  }
});

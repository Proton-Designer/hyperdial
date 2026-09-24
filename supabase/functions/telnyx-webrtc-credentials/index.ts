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
 */
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import {
  requireTelnyxOrgRole,
  getSupabaseAdmin,
  getConnectedOrgTelnyxContext,
} from '../_shared/telnyx-org-context.ts';
import type { TelnyxClient } from '../_shared/telnyx-client.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function memberCredentialName(orgId: string, userId: string): string {
  return `hyperdial-member-${orgId}-${userId}`;
}

async function getOrCreateMemberCredentialId(
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
        '[telnyx-webrtc-credentials] failed to persist telnyx_credential_id',
        updateError.message
      );
      // Not fatal to this request (the caller still gets a working token) -- but the next
      // call will re-find-or-create rather than reuse, same window telnyx-provision.ts
      // documents for the org-level resources.
    }
  }

  return credentialId;
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

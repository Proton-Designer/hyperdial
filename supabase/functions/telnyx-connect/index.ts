/**
 * "Connect Telnyx" (design §3), owner-only. Validates the org's Telnyx API key,
 * provisions (or reuses) the outbound voice profile / Call Control Application /
 * credential connection, and only then persists anything: the key goes into Vault
 * via `private.set_org_telnyx_key`, and the resource ids + pasted webhook public key
 * land in `org_telephony`. A bad key or a Telnyx-side failure leaves no partial state.
 *
 * Not wired through `_shared/auth.ts`'s `requireOrgRole` (TASK-P1-02): that task is
 * explicitly scoped to eng1's own functions and excludes `telnyx-*`/`dialer-*`, so
 * this function does its own minimal owner check directly against `org_members`.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/auth.ts';
import { createTelnyxClient } from '../_shared/telnyx-client.ts';
import { provisionTelnyxOrg } from '../_shared/telnyx-provision.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

async function assertOrgOwner(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orgId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle();
  if (error) {
    console.error('[telnyx-connect] org_members lookup failed', error.message);
    return false;
  }
  return data?.role === 'owner';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, error: authError } = await getUserFromRequest(req);
  if (authError) return authError;

  let body: { orgId?: string; apiKey?: string; webhookPublicKey?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { orgId, apiKey, webhookPublicKey } = body;
  if (!orgId || !apiKey || !webhookPublicKey) {
    return jsonResponse({ error: 'orgId, apiKey and webhookPublicKey are all required' }, 400);
  }

  const supabase = getSupabaseAdmin();

  const isOwner = await assertOrgOwner(supabase, orgId, user.id);
  if (!isOwner) {
    return jsonResponse({ error: 'Only the org owner can connect Telnyx' }, 403);
  }

  const { data: existingRow, error: existingError } = await supabase
    .from('org_telephony')
    .select('outbound_voice_profile_id, call_control_app_id, credential_connection_id')
    .eq('org_id', orgId)
    .maybeSingle();
  if (existingError) {
    console.error('[telnyx-connect] org_telephony lookup failed', existingError.message);
    return jsonResponse({ error: 'Failed to read existing telephony state' }, 500);
  }

  const webhookBaseUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/telnyx-webhook`;
  const client = createTelnyxClient(apiKey);

  let provisioned;
  try {
    provisioned = await provisionTelnyxOrg(client, {
      orgId,
      webhookBaseUrl,
      existing: {
        outboundVoiceProfileId: existingRow?.outbound_voice_profile_id ?? null,
        callControlApplicationId: existingRow?.call_control_app_id ?? null,
        credentialConnectionId: existingRow?.credential_connection_id ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[telnyx-connect] provisioning failed', message);
    const isBadKey = message.includes('(401)') || message.includes('(403)');
    return jsonResponse(
      {
        error: isBadKey ? 'Telnyx rejected this API key' : `Telnyx provisioning failed: ${message}`,
      },
      isBadKey ? 401 : 502
    );
  }

  const { error: setKeyError } = await supabase.rpc('set_org_telnyx_key', {
    p_org: orgId,
    p_key: apiKey,
  });
  if (setKeyError) {
    console.error('[telnyx-connect] set_org_telnyx_key failed', setKeyError.message);
    return jsonResponse({ error: 'Failed to store the Telnyx key' }, 500);
  }

  const { error: updateError } = await supabase
    .from('org_telephony')
    .update({
      webhook_public_key: webhookPublicKey,
      call_control_app_id: provisioned.callControlApplicationId,
      credential_connection_id: provisioned.credentialConnectionId,
      outbound_voice_profile_id: provisioned.outboundVoiceProfileId,
      status: 'connected',
      verified_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('org_id', orgId);
  if (updateError) {
    console.error('[telnyx-connect] org_telephony update failed', updateError.message);
    return jsonResponse({ error: 'Provisioned in Telnyx but failed to save the result' }, 500);
  }

  return jsonResponse({
    status: 'connected',
    callControlApplicationId: provisioned.callControlApplicationId,
    credentialConnectionId: provisioned.credentialConnectionId,
    outboundVoiceProfileId: provisioned.outboundVoiceProfileId,
    created: provisioned.created,
  });
});

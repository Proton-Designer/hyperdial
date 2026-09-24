/**
 * "Connect GHL" (design §6), owner-only. Validates the org's GHL Private Integration
 * Token against the LeadConnector API by fetching the location it claims (confirms both
 * that the token is live and that it actually resolves to the locationId the owner
 * pasted in), and only then persists anything: the token goes into Vault via
 * `set_org_ghl_token`, and `org_integrations` records the location id/name and status.
 * A bad token or a locationId/token mismatch leaves no partial state.
 *
 * Not wired through `_shared/auth.ts`'s `requireOrgRole`, same reasoning as
 * `telnyx-connect`: this function does its own minimal owner check directly against
 * `org_members` rather than depend on TASK-P1-02's scope.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/auth.ts';
import { createGhlClient } from '../_shared/ghl-client.ts';

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
    console.error('[ghl-connect] org_members lookup failed', error.message);
    return false;
  }
  return data?.role === 'owner';
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, error: authError } = await getUserFromRequest(req);
  if (authError) return authError;

  let body: { orgId?: string; token?: string; locationId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const { orgId, token, locationId } = body;
  if (!orgId || !token || !locationId) {
    return jsonResponse({ error: 'orgId, token and locationId are all required' }, 400);
  }

  const supabase = getSupabaseAdmin();

  const isOwner = await assertOrgOwner(supabase, orgId, user.id);
  if (!isOwner) {
    return jsonResponse({ error: 'Only the org owner can connect GHL' }, 403);
  }

  const client = createGhlClient(token);
  let location;
  try {
    location = await client.getLocation(locationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ghl-connect] getLocation failed', message);
    const isBadToken = message.includes('(401)') || message.includes('(403)');
    const isBadLocation = message.includes('(404)');
    return jsonResponse(
      {
        error: isBadToken
          ? 'GHL rejected this token'
          : isBadLocation
            ? 'GHL rejected this location id -- check it was copied from the correct sub-account'
            : `GHL request failed: ${message}`,
      },
      isBadToken ? 401 : isBadLocation ? 400 : 502
    );
  }

  const { error: setTokenError } = await supabase.rpc('set_org_ghl_token', {
    p_org: orgId,
    p_token: token,
    p_location_id: location.id,
  });
  if (setTokenError) {
    console.error('[ghl-connect] set_org_ghl_token failed', setTokenError.message);
    return jsonResponse({ error: 'Failed to store the GHL token' }, 500);
  }

  return jsonResponse({
    status: 'connected',
    locationId: location.id,
    locationName: location.name,
  });
});

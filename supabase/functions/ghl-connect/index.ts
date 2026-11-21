/**
 * "Connect GHL" (design §6), owner or admin. Validates the org's GHL Private Integration
 * Token against the LeadConnector API by fetching the location it claims (confirms both
 * that the token is live and that it actually resolves to the locationId the owner
 * pasted in), and only then persists anything: the token goes into Vault via
 * `set_org_ghl_token`, and `org_integrations` records the location id/name and status.
 * A bad token or a locationId/token mismatch leaves no partial state.
 *
 * Not wired through `_shared/auth.ts`'s `requireOrgRole`, same reasoning as
 * `telnyx-connect`: this function does its own minimal role check directly against
 * `org_members` rather than depend on TASK-P1-02's scope. Owners and admins may connect (user order
 * 2026-10-21; it was owner-only).
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/auth.ts';
import { createGhlClient } from '../_shared/ghl-client.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { syncOrgTagsToGhl } from '../_shared/ghl-tags-io.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

async function assertOrgOwnerOrAdmin(
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
  return data?.role === 'owner' || data?.role === 'admin';
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

  const canConnect = await assertOrgOwnerOrAdmin(supabase, orgId, user.id);
  if (!canConnect) {
    return jsonResponse({ error: 'Only an owner or admin can connect GHL' }, 403);
  }

  const client = createGhlClient(token);
  let location;
  try {
    location = await client.getLocation(locationId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ghl-connect] getLocation failed', message);
    const isBadToken = message.includes('(401)') || message.includes('(403)');
    // GHL answers 401 "The token is not authorized for this scope." when the token is valid but the Private
    // Integration lacks a permission; say which one instead of calling the token bad.
    const isMissingScope = isBadToken && /not authorized for this scope/i.test(message);
    const isBadLocation = message.includes('(404)');
    return jsonResponse(
      {
        error: isMissingScope
          ? 'Your GHL token is missing the "View Locations" permission. In GoHighLevel open Settings → Private Integrations, edit this integration, add View Locations (plus View/Edit Contacts, Tags, Custom Fields and Opportunities, and View Users), save, then connect again.'
          : isBadToken
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

  await logOrgAction(supabase, {
    orgId,
    actorUserId: user.id,
    action: 'ghl.connect',
    targetType: 'org_integrations',
    targetId: orgId,
    details: { locationId: location.id, locationName: location.name },
  });

  // TASK-G28: create every configured tag (exclude / DNC / paused / disposition) in the location. Never blocks the connect.
  const tagSync = await syncOrgTagsToGhl(supabase, {
    orgId,
    token,
    locationId: location.id,
    apiBase: Deno.env.get('GHL_API_BASE') || undefined,
  });
  if (tagSync.listError || tagSync.failed.length > 0) {
    console.warn('[ghl-connect] tag sync incomplete', tagSync.listError, tagSync.failed);
  }

  return jsonResponse({
    status: 'connected',
    locationId: location.id,
    locationName: location.name,
    tagSync,
  });
});

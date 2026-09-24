/**
 * "Disconnect GHL" (design §6), owner-only. Marks the org disconnected without deleting
 * the stored token or the org_integrations row: reconnecting with a new (or the same)
 * token via `ghl-connect` reuses the same Vault secret id through `set_org_ghl_token`'s
 * existing-secret path, rather than leaving an orphaned secret behind. Same shape as
 * `telnyx-disconnect`. `enqueue_crm_job` already no-ops for a disconnected org (status
 * <> 'connected'), so nothing else needs to change when this flips.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/auth.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, error: authError } = await getUserFromRequest(req);
  if (authError) return authError;

  let body: { orgId?: string };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const { orgId } = body;
  if (!orgId) return jsonResponse({ error: 'orgId is required' }, 400);

  const supabase = getSupabaseAdmin();

  const { data: membership, error: membershipError } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();
  if (membershipError) {
    console.error('[ghl-disconnect] org_members lookup failed', membershipError.message);
    return jsonResponse({ error: 'Failed to verify ownership' }, 500);
  }
  if (membership?.role !== 'owner') {
    return jsonResponse({ error: 'Only the org owner can disconnect GHL' }, 403);
  }

  const { error: updateError } = await supabase
    .from('org_integrations')
    .update({ status: 'disconnected', updated_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .eq('provider', 'ghl');
  if (updateError) {
    console.error('[ghl-disconnect] update failed', updateError.message);
    return jsonResponse({ error: 'Failed to disconnect' }, 500);
  }

  return jsonResponse({ status: 'disconnected' });
});

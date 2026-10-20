/**
 * TASK-G17: owner/admin "GoHighLevel field coverage" check. POST {} -> which of the fields HyperDial
 * pushes (provider contact + intern contact) exist in this org's GHL, with counts. Read-only: lists the
 * location's contact custom-field definitions once and never creates anything in GHL.
 *
 * Auth mirrors ghl-reconcile-settings: requireOrgRole owner/admin, org from the caller's membership
 * (the body is ignored), service-role reads. Not exposed to interns.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { classifyFieldCoverage, fetchCoverageDefs } from '../_shared/ghl-field-coverage.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  try {
    const { data: integration, error: integrationError } = await supabase
      .from('org_integrations')
      .select('status, location_id, ghl_field_mapping')
      .eq('org_id', orgId)
      .eq('provider', 'ghl')
      .maybeSingle();
    if (integrationError) throw new Error(integrationError.message);
    if (!integration || integration.status !== 'connected' || !integration.location_id) {
      return jsonResponse({ error: 'GoHighLevel is not connected' }, 400);
    }
    const { data: token, error: tokenError } = await supabase.rpc('get_org_ghl_token', {
      p_org: orgId,
    });
    if (tokenError || !token) {
      console.error('[ghl-field-coverage] get_org_ghl_token failed', tokenError?.message);
      return jsonResponse({ error: 'Failed to retrieve the GHL token' }, 502);
    }
    let defs;
    try {
      defs = await fetchCoverageDefs(
        token as string,
        integration.location_id as string,
        Deno.env.get('GHL_API_BASE') || undefined
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ghl-field-coverage] field list failed', message);
      return jsonResponse({ error: `GHL request failed: ${message}` }, 502);
    }
    return jsonResponse(
      classifyFieldCoverage(integration.ghl_field_mapping as Record<string, string> | null, defs)
    );
  } catch (err) {
    console.error('[ghl-field-coverage] failed', err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

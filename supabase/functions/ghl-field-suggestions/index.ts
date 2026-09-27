/**
 * MISSION-4 TASK-T1 (GHL-6): "map GHL custom fields ... sensible defaults by field name." Owner/
 * admin. Fetches the connected location's real custom field definitions
 * (`listContactCustomFieldDefs`) and returns both the raw list (id + name, for the Settings field-
 * mapping editor to show what's actually available) and a suggested targetKey -> fieldId mapping
 * (`_shared/ghl-field-mapping.ts`'s pure exact-name matcher) for any target key the org hasn't
 * already configured. Read-only -- saving still goes through ghl-update-pull-settings.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { createGhlClient } from '../_shared/ghl-client.ts';
import { suggestGhlFieldMapping } from '../_shared/ghl-field-mapping.ts';

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

  const { orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  const supabase = getSupabaseAdmin();

  const { data: integration, error: integrationError } = await supabase
    .from('org_integrations')
    .select('status, location_id, ghl_field_mapping')
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (integrationError) {
    console.error(
      '[ghl-field-suggestions] org_integrations lookup failed',
      integrationError.message
    );
    return jsonResponse({ error: 'Failed to look up the GHL connection' }, 500);
  }
  if (!integration || integration.status !== 'connected' || !integration.location_id) {
    return jsonResponse({ error: 'GHL is not connected for this org' }, 400);
  }

  const { data: token, error: tokenError } = await supabase.rpc('get_org_ghl_token', {
    p_org: orgId,
  });
  if (tokenError || !token) {
    console.error('[ghl-field-suggestions] get_org_ghl_token failed', tokenError?.message);
    return jsonResponse({ error: 'Failed to retrieve the GHL token' }, 502);
  }

  const client = createGhlClient(token as string, {
    apiBase: Deno.env.get('GHL_API_BASE') || undefined,
  });

  let fields;
  try {
    fields = await client.listContactCustomFieldDefs(integration.location_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ghl-field-suggestions] listContactCustomFieldDefs failed', message);
    return jsonResponse({ error: `GHL request failed: ${message}` }, 502);
  }

  const existingMapping = (integration.ghl_field_mapping as Record<string, string> | null) ?? {};
  const suggested = suggestGhlFieldMapping(fields);
  // Never overwrite a target key the org already configured -- suggestions only ever fill in
  // what's currently unset.
  for (const key of Object.keys(existingMapping)) delete suggested[key];

  return jsonResponse({ fields, suggestedMapping: suggested, currentMapping: existingMapping });
});

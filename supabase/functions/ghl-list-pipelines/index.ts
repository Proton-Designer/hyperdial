/**
 * MISSION-4 TASK-T1 (GHL-4): lists the connected location's pipelines/stages, flattened, for the
 * Settings -> Integrations -> GHL "Add stage mapping" picker (an admin needs real stage names to
 * pick from, not to paste an opaque GHL stage id). Owner/admin, read-only.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
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

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  const supabase = getSupabaseAdmin();

  const { data: integration, error: integrationError } = await supabase
    .from('org_integrations')
    .select('status, location_id')
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (integrationError) {
    console.error('[ghl-list-pipelines] org_integrations lookup failed', integrationError.message);
    return jsonResponse({ error: 'Failed to look up the GHL connection' }, 500);
  }
  if (!integration || integration.status !== 'connected' || !integration.location_id) {
    return jsonResponse({ error: 'GHL is not connected for this org' }, 400);
  }

  const { data: token, error: tokenError } = await supabase.rpc('get_org_ghl_token', {
    p_org: orgId,
  });
  if (tokenError || !token) {
    console.error('[ghl-list-pipelines] get_org_ghl_token failed', tokenError?.message);
    return jsonResponse({ error: 'Failed to retrieve the GHL token' }, 502);
  }

  const client = createGhlClient(token as string, {
    apiBase: Deno.env.get('GHL_API_BASE') || undefined,
  });

  let pipelines;
  try {
    pipelines = await client.getPipelines(integration.location_id);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ghl-list-pipelines] getPipelines failed', message);
    return jsonResponse({ error: `GHL request failed: ${message}` }, 502);
  }

  const stages = pipelines.flatMap((p) =>
    (p.stages ?? []).map((s) => ({
      pipelineId: p.id,
      pipelineName: p.name,
      stageId: s.id,
      stageName: s.name,
    }))
  );

  return jsonResponse({ stages });
});

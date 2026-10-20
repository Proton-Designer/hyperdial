/**
 * TASK-G17: owner/admin "GoHighLevel field coverage" check. POST {} -> which of the fields HyperDial
 * pushes (provider contact + intern contact) exist in this org's GHL, with counts. Read-only: lists the
 * location's contact custom-field definitions once and never creates anything in GHL.
 *
 * TASK-G29: POST { action: 'create_missing' } creates every missing catalog field in GHL (ghl-field-create.ts),
 * maps the provider ones, and answers { coverage, result, mappingError }. Same owner/admin gate.
 *
 * Auth mirrors ghl-reconcile-settings: requireOrgRole owner/admin, org from the caller's membership
 * (the body is ignored), service-role reads. Not exposed to interns.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import {
  createGhlRateLimiter,
  GHL_PULL_RATE_LIMIT_MAX_PER_WINDOW,
} from '../_shared/ghl-rate-limit.ts';
import { classifyFieldCoverage, fetchCoverageDefs } from '../_shared/ghl-field-coverage.ts';
import { runCreateMissing } from '../_shared/ghl-field-create.ts';
import { logOrgAction } from '../_shared/audit.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  );
  try {
    const { data: integration, error: integrationError } = await supabase
      .from('org_integrations')
      .select('status, location_id, ghl_field_mapping, ghl_pull_enabled')
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
    const apiBase = Deno.env.get('GHL_API_BASE') || undefined;
    const limiter = createGhlRateLimiter({ maxPerWindow: GHL_PULL_RATE_LIMIT_MAX_PER_WINDOW });
    const loadDefs = () =>
      fetchCoverageDefs(
        token as string,
        integration.location_id as string,
        apiBase,
        fetch,
        limiter
      );

    let action: unknown = 'get';
    try {
      action = ((await req.json()) as { action?: unknown } | null)?.action ?? 'get';
    } catch {
      // POST {} / empty body = the read-only check
    }
    if (action === 'create_missing') {
      let out;
      try {
        out = await runCreateMissing({
          mapping: (integration.ghl_field_mapping as Record<string, string> | null) ?? {},
          loadDefs,
          io: {
            token: token as string,
            locationId: integration.location_id as string,
            apiBase,
            limiter,
          },
          saveMapping: async (mapping) => {
            const { error } = await supabase.rpc('set_org_ghl_pull_settings', {
              p_org: orgId,
              p_pull_enabled: integration.ghl_pull_enabled === true,
              p_field_mapping: mapping,
            });
            if (error) throw new Error(error.message);
          },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[ghl-field-coverage] create_missing failed', message);
        return jsonResponse({ error: `GHL request failed: ${message}` }, 502);
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'ghl.create_missing_fields',
        targetType: 'org_integrations',
        targetId: orgId,
        details: {
          created: out.result.created.map((c) => c.key),
          mapped: out.result.mapped.map((c) => c.key),
          failed: out.result.failed.map((f) => f.key),
          stopped: out.result.stopped,
        },
      });
      return jsonResponse(out);
    }

    let defs;
    try {
      defs = await loadDefs();
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

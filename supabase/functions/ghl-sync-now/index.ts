/**
 * MISSION-4 TASK-T1 (GHL-5): the on-demand "Sync now" button on Campaigns. Owner/admin only
 * (same permission matrix as ghl-import). Runs every one of the caller's org's configured
 * `org_ghl_campaign_mappings` right now, via the SAME `_shared/ghl-pull-run.ts` core the 5-minute
 * cron worker (`ghl-pull-worker`) uses -- unlike the cron path, this runs regardless of
 * `ghl_pull_enabled` (a manual trigger is an explicit, deliberate action, not the automatic
 * behaviour that setting gates) and returns the result synchronously for the UI to show.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { createGhlClient } from '../_shared/ghl-client.ts';
import { createGhlRateLimiter, withGhlRateLimit } from '../_shared/ghl-rate-limit.ts';
import { runGhlPullForOrg, type GhlCampaignMappingRow } from '../_shared/ghl-pull-run.ts';
import type { GhlImportEnrichment } from '../_shared/ghl-import.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

/** Same enrichment-building logic as ghl-pull-worker/index.ts (kept as a second copy, not a
 *  shared export, since it's a thin composition of three already-shared lookups -- see that
 *  file's own header for why the two entry points stay separate glue around shared core
 *  modules). */
async function buildEnrichment(
  supabase: SupabaseClient,
  client: ReturnType<typeof createGhlClient>,
  orgId: string,
  locationId: string,
  fieldMapping: Record<string, string> | null
): Promise<GhlImportEnrichment> {
  const fieldMappingByGhlFieldId: Record<string, string> = {};
  for (const [targetKey, ghlFieldId] of Object.entries(fieldMapping ?? {})) {
    if (typeof ghlFieldId === 'string' && ghlFieldId)
      fieldMappingByGhlFieldId[ghlFieldId] = targetKey;
  }

  const orgMemberIdByGhlUserId: Record<string, string> = {};
  const { data: members } = await supabase
    .from('org_members')
    .select('user_id, ghl_user_id')
    .eq('org_id', orgId)
    .not('ghl_user_id', 'is', null);
  for (const m of (members ?? []) as { user_id: string; ghl_user_id: string }[]) {
    orgMemberIdByGhlUserId[m.ghl_user_id] = m.user_id;
  }

  const stageNameByPipelineStageId: Record<string, string> = {};
  try {
    const pipelines = await client.getPipelines(locationId);
    for (const p of pipelines) {
      for (const s of p.stages ?? []) {
        if (s.id && s.name) stageNameByPipelineStageId[s.id] = s.name;
      }
    }
  } catch (err) {
    console.warn(`[ghl-sync-now] getPipelines failed for org ${orgId}`, err);
  }

  return { fieldMappingByGhlFieldId, orgMemberIdByGhlUserId, stageNameByPipelineStageId };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  const supabase = getSupabaseAdmin();

  const { data: integration, error: integrationError } = await supabase
    .from('org_integrations')
    .select(
      'status, location_id, ghl_dnc_tags, ghl_paused_tags, ghl_field_mapping, ghl_pull_cursor'
    )
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (integrationError) {
    console.error('[ghl-sync-now] org_integrations lookup failed', integrationError.message);
    return jsonResponse({ error: 'Failed to look up the GHL connection' }, 500);
  }
  if (!integration || integration.status !== 'connected' || !integration.location_id) {
    return jsonResponse({ error: 'GHL is not connected for this org' }, 400);
  }

  const { data: mappingRows, error: mappingsError } = await supabase
    .from('org_ghl_campaign_mappings')
    .select('id, match_type, tag, pipeline_id, pipeline_stage_id, campaign_id, ghl_pull_cursor')
    .eq('org_id', orgId);
  if (mappingsError) {
    console.error('[ghl-sync-now] mapping lookup failed', mappingsError.message);
    return jsonResponse({ error: 'Failed to look up the GHL campaign mappings' }, 500);
  }
  const mappings = (mappingRows ?? []) as GhlCampaignMappingRow[];
  if (mappings.length === 0) {
    return jsonResponse(
      {
        error:
          'No tag/stage -> campaign mappings are configured yet (Settings -> Integrations -> GHL).',
      },
      400
    );
  }

  const { data: token, error: tokenError } = await supabase.rpc('get_org_ghl_token', {
    p_org: orgId,
  });
  if (tokenError || !token) {
    console.error('[ghl-sync-now] get_org_ghl_token failed', tokenError?.message);
    return jsonResponse({ error: 'Failed to retrieve the GHL token' }, 502);
  }

  const rawClient = createGhlClient(token as string, {
    apiBase: Deno.env.get('GHL_API_BASE') || undefined,
  });
  const client = withGhlRateLimit(rawClient, createGhlRateLimiter());

  const enrichment = await buildEnrichment(
    supabase,
    client,
    orgId,
    integration.location_id,
    integration.ghl_field_mapping
  );

  let orgResult;
  try {
    orgResult = await runGhlPullForOrg(supabase, client, {
      orgId,
      locationId: integration.location_id,
      mappings,
      dncTags: (integration.ghl_dnc_tags as string[] | null) ?? undefined,
      pausedTags: (integration.ghl_paused_tags as string[] | null) ?? undefined,
      enrichment,
      // A manual sync always processes everything the mappings match, ignoring each mapping's own
      // incremental cursor -- the whole point of clicking the button is "check right now," not
      // "only what changed since the last automatic tick."
      forceFullSync: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ghl-sync-now] pull failed', message);
    return jsonResponse({ error: `GHL sync failed: ${message}` }, 502);
  }

  const anyMappingFailed = orgResult.results.some((r) => r.error);
  await supabase.rpc('record_ghl_pull_result', {
    p_org: orgId,
    p_cursor: orgResult.maxDateUpdatedIso,
    p_status: anyMappingFailed ? 'error' : 'ok',
    p_counts: {
      created: orgResult.totalCreated,
      updated: orgResult.totalUpdated,
      mappings: orgResult.results,
    },
  });

  return jsonResponse({
    created: orgResult.totalCreated,
    updated: orgResult.totalUpdated,
    mappings: orgResult.results,
  });
});

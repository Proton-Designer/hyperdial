/**
 * MISSION-4 TASK-T1 (GHL-5): the 5-minute scheduled GHL pull. Triggered by pg_cron/pg_net
 * (`private.trigger_ghl_pull_worker`, `20260926080000_ghl_pull_complete.sql`) with a shared
 * secret header, not a user JWT -- same shape as ghl-sync-worker/spend-alert-check/
 * dialer-sweeper/recording-retention.
 *
 * Loops every org with a CONNECTED GHL integration AND `ghl_pull_enabled = true` (disabled by
 * default, per the mission's own "new automatic behaviour ships DISABLED by default" rule), runs
 * every one of that org's `org_ghl_campaign_mappings` via `_shared/ghl-pull-run.ts`, then records
 * the outcome (advanced cursor, status, counts) via `record_ghl_pull_result`. One org's failure
 * (a revoked token, GHL down) is isolated -- every other enabled org still gets its run this
 * tick, same "isolate one failure" principle `runGhlPullForOrg` itself applies one level down
 * (one mapping failing doesn't stop the rest of that org's mappings).
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
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

/** Same constant-time comparison as ghl-sync-worker/recording-retention/dialer-sweeper/
 *  spend-alert-check. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

interface PullEnabledOrgRow {
  org_id: string;
  location_id: string;
  ghl_dnc_tags: string[] | null;
  ghl_paused_tags: string[] | null;
  ghl_field_mapping: Record<string, string> | null;
  ghl_pull_cursor: string | null;
}

/** Builds the run-wide enrichment maps for one org: custom-field-id -> target key (the org's
 *  own `ghl_field_mapping` is already target-key -> field-id, so this inverts it), GHL user id ->
 *  org member id (from `org_members.ghl_user_id`), and pipeline-stage id -> name (one
 *  `getPipelines` call, not one per contact). Any of the three can come back empty -- an org
 *  that never configured a field mapping, has no members with a GHL user id set, or has no
 *  pipelines at all still gets a normal pull, just with less enrichment applied. */
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
    console.warn(`[ghl-pull-worker] getPipelines failed for org ${orgId}`, err);
  }

  return { fieldMappingByGhlFieldId, orgMemberIdByGhlUserId, stageNameByPipelineStageId };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('GHL_PULL_WORKER_SECRET');
  const providedSecret = req.headers.get('X-Cron-Secret');
  // Fail closed: an unset expectedSecret never means "allow everything" (known-issues #0's
  // Telnyx-webhook lesson applies here too).
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabase = getSupabaseAdmin();

  const { data: orgs, error: orgsError } = await supabase
    .from('org_integrations')
    .select(
      'org_id, location_id, ghl_dnc_tags, ghl_paused_tags, ghl_field_mapping, ghl_pull_cursor'
    )
    .eq('provider', 'ghl')
    .eq('status', 'connected')
    .eq('ghl_pull_enabled', true);
  if (orgsError) {
    console.error('[ghl-pull-worker] org_integrations lookup failed', orgsError.message);
    return jsonResponse({ error: orgsError.message }, 500);
  }

  const results: Record<string, unknown>[] = [];

  for (const org of (orgs ?? []) as PullEnabledOrgRow[]) {
    try {
      const { data: token } = await supabase.rpc('get_org_ghl_token', { p_org: org.org_id });
      if (!token) {
        results.push({ orgId: org.org_id, error: 'no GHL token' });
        continue;
      }
      const { data: mappingRows } = await supabase
        .from('org_ghl_campaign_mappings')
        .select('id, match_type, tag, pipeline_id, pipeline_stage_id, campaign_id, ghl_pull_cursor')
        .eq('org_id', org.org_id);
      const mappings = (mappingRows ?? []) as GhlCampaignMappingRow[];
      if (mappings.length === 0) {
        results.push({ orgId: org.org_id, mappings: 0 });
        continue;
      }

      const rawClient = createGhlClient(token as string, {
        apiBase: Deno.env.get('GHL_API_BASE') || undefined,
      });
      const client = withGhlRateLimit(rawClient, createGhlRateLimiter());
      const enrichment = await buildEnrichment(
        supabase,
        client,
        org.org_id,
        org.location_id,
        org.ghl_field_mapping
      );

      const orgResult = await runGhlPullForOrg(supabase, client, {
        orgId: org.org_id,
        locationId: org.location_id,
        mappings,
        dncTags: org.ghl_dnc_tags ?? undefined,
        pausedTags: org.ghl_paused_tags ?? undefined,
        enrichment,
        // Review fix-forward (audit/T1/review-eng2.md #3): each mapping now carries its OWN
        // cursor (mappingRows above includes ghl_pull_cursor) -- the org-level
        // org_integrations.ghl_pull_cursor below is informational bookkeeping only, no longer
        // used to filter.
      });

      const anyMappingFailed = orgResult.results.some((r) => r.error);
      await supabase.rpc('record_ghl_pull_result', {
        p_org: org.org_id,
        p_cursor: orgResult.maxDateUpdatedIso,
        p_status: anyMappingFailed ? 'error' : 'ok',
        p_counts: {
          created: orgResult.totalCreated,
          updated: orgResult.totalUpdated,
          mappings: orgResult.results,
        },
      });
      results.push({
        orgId: org.org_id,
        created: orgResult.totalCreated,
        updated: orgResult.totalUpdated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ghl-pull-worker] org ${org.org_id} failed`, message);
      await supabase.rpc('record_ghl_pull_result', {
        p_org: org.org_id,
        p_cursor: null,
        p_status: 'error',
        p_counts: { error: message },
      });
      results.push({ orgId: org.org_id, error: message });
    }
  }

  return jsonResponse({ orgsProcessed: results.length, results });
});

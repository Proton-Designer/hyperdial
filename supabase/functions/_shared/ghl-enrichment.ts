/**
 * TASK-H16: the run-wide enrichment maps for one org (custom-field map, GHL user -> org member, stage names), moved
 * out of ghl-pull-worker/index.ts so the webhook intake builds them exactly like the 5-minute pull does.
 */
import type { GhlClient } from './ghl-client.ts';
import type { GhlImportEnrichment } from './ghl-import.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

/** Builds the run-wide enrichment maps for one org: custom-field-id -> target key (the org's
 *  own `ghl_field_mapping` is already target-key -> field-id, so this inverts it), GHL user id ->
 *  org member id (from `org_members.ghl_user_id`), and pipeline-stage id -> name (one
 *  `getPipelines` call, not one per contact). Any of the three can come back empty -- an org
 *  that never configured a field mapping, has no members with a GHL user id set, or has no
 *  pipelines at all still gets a normal pull, just with less enrichment applied. */
export async function buildGhlImportEnrichment(
  supabase: SupabaseAny,
  client: GhlClient,
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
    console.warn(`[ghl-enrichment] getPipelines failed for org ${orgId}`, err);
  }

  return { fieldMappingByGhlFieldId, orgMemberIdByGhlUserId, stageNameByPipelineStageId };
}

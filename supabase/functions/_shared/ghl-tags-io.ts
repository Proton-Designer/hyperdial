/**
 * TASK-G28: the DB + GHL wiring around ghl-tags.ts, shared by ghl-connect, ghl-reconcile-settings,
 * ghl-update-blocked-tags and the ghl-tags endpoint.
 */
import { createGhlClient } from './ghl-client.ts';
import {
  createGhlRateLimiter,
  GHL_PUSH_RATE_LIMIT_MAX_PER_WINDOW,
  withGhlRateLimit,
} from './ghl-rate-limit.ts';
import { ensureGhlTags, uniqueTags, type EnsureTagsResult } from './ghl-tags.ts';

// deno-lint-ignore no-explicit-any
type SupabaseAny = any;

/** Every tag the org's configuration reads or writes: exclude + DNC + paused + each disposition's ghl_tag. */
export async function collectOrgTags(supabase: SupabaseAny, orgId: string): Promise<string[]> {
  const { data: integration, error } = await supabase
    .from('org_integrations')
    .select('ghl_exclude_tags, ghl_dnc_tags, ghl_paused_tags')
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (error) throw new Error(error.message);
  const { data: dispositions, error: dispError } = await supabase
    .from('dispositions')
    .select('ghl_tag')
    .eq('org_id', orgId)
    .not('ghl_tag', 'is', null);
  if (dispError) throw new Error(dispError.message);
  return uniqueTags(
    integration?.ghl_exclude_tags as string[] | null,
    integration?.ghl_dnc_tags as string[] | null,
    integration?.ghl_paused_tags as string[] | null,
    ((dispositions ?? []) as { ghl_tag: string | null }[]).map((d) => d.ghl_tag)
  );
}

/** Creates the org's missing tags in its GHL location. Never throws: a problem comes back in the result. */
export async function syncOrgTagsToGhl(
  supabase: SupabaseAny,
  args: { orgId: string; token: string; locationId: string; apiBase?: string }
): Promise<EnsureTagsResult> {
  try {
    const wanted = await collectOrgTags(supabase, args.orgId);
    const client = withGhlRateLimit(
      createGhlClient(args.token, { apiBase: args.apiBase }),
      createGhlRateLimiter({ maxPerWindow: GHL_PUSH_RATE_LIMIT_MAX_PER_WINDOW })
    );
    return await ensureGhlTags(client, args.locationId, wanted);
  } catch (err) {
    return {
      existing: [],
      created: [],
      failed: [],
      listError: err instanceof Error ? err.message : String(err),
    };
  }
}

/** The org's GHL token + location, or null when GHL is not connected (or the token cannot be read). */
export async function getOrgGhlAccess(
  supabase: SupabaseAny,
  orgId: string
): Promise<{ token: string; locationId: string } | null> {
  const { data: integration } = await supabase
    .from('org_integrations')
    .select('status, location_id')
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (!integration || integration.status !== 'connected' || !integration.location_id) return null;
  const { data: token, error } = await supabase.rpc('get_org_ghl_token', { p_org: orgId });
  if (error || !token) return null;
  return { token: token as string, locationId: integration.location_id as string };
}

/** Same as syncOrgTagsToGhl, looking the token/location up first. null = GHL not connected. */
export async function syncOrgTagsForOrg(
  supabase: SupabaseAny,
  orgId: string,
  apiBase?: string
): Promise<EnsureTagsResult | null> {
  const access = await getOrgGhlAccess(supabase, orgId);
  if (!access) return null;
  return syncOrgTagsToGhl(supabase, { orgId, ...access, apiBase });
}

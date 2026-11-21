/**
 * TASK-G12: owner/admin "Remove from call lists" (GHL -> HyperDial reconcile, TASK-G08) settings.
 * POST { action: 'get' } -> current settings + last run; POST { action: 'set', enabled, excludeTags,
 * excludeStageIds } -> saves through public.set_org_ghl_reconcile_settings (service_role only) and
 * returns the same shape.
 *
 * Who can read what: BOTH actions are owner/admin only (requireOrgRole) and read org_integrations
 * with the service role. Deliberately NOT exposed through the org_integrations_status view, which
 * every org member can select -- an intern has no business reading these lists or the run counts.
 * The org always comes from the caller's membership, never from the request body.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { syncOrgTagsForOrg } from '../_shared/ghl-tags-io.ts';
import { parseReconcileSettingsBody } from '../_shared/ghl-reconcile-settings.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

type AdminClient = ReturnType<typeof getSupabaseAdmin>;

async function readSettings(supabase: AdminClient, orgId: string) {
  const { data, error } = await supabase
    .from('org_integrations')
    .select(
      'ghl_reconcile_enabled, ghl_exclude_tags, ghl_exclude_stage_ids, ghl_last_reconcile_at, ghl_last_reconcile_counts'
    )
    .eq('org_id', orgId)
    .eq('provider', 'ghl')
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    enabled: data.ghl_reconcile_enabled === true,
    excludeTags: (data.ghl_exclude_tags as string[] | null) ?? [],
    excludeStageIds: (data.ghl_exclude_stage_ids as string[] | null) ?? [],
    lastReconcileAt: (data.ghl_last_reconcile_at as string | null) ?? null,
    lastReconcileCounts: (data.ghl_last_reconcile_counts as Record<string, unknown> | null) ?? null,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }
  const parsed = parseReconcileSettingsBody(raw);
  if (!parsed.ok) return jsonResponse({ error: parsed.error }, 400);

  const supabase = getSupabaseAdmin();
  try {
    if (parsed.value.action === 'set') {
      const { enabled, excludeTags, excludeStageIds } = parsed.value;
      const { error: rpcError } = await supabase.rpc('set_org_ghl_reconcile_settings', {
        p_org: orgId,
        p_enabled: enabled,
        p_exclude_tags: excludeTags,
        p_exclude_stage_ids: excludeStageIds,
      });
      if (rpcError) {
        console.error('[ghl-reconcile-settings] rpc failed', rpcError.message);
        // the RPC raises when the org has no GHL integration row yet: a client mistake (connect first)
        const status = rpcError.message.includes('has no GHL integration') ? 400 : 500;
        return jsonResponse({ error: rpcError.message }, status);
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'ghl.update_reconcile_settings',
        targetType: 'org_integrations',
        targetId: orgId,
        details: { enabled, excludeTags, excludeStageIds },
      });
    }
    const settings = await readSettings(supabase, orgId);
    if (!settings) return jsonResponse({ error: 'GoHighLevel is not connected' }, 400);
    if (parsed.value.action === 'set') {
      // TASK-G28: make sure the saved exclude tags exist in GHL; a problem is reported, never blocks the save
      const tagSync = await syncOrgTagsForOrg(
        supabase,
        orgId,
        Deno.env.get('GHL_API_BASE') || undefined
      );
      return jsonResponse({ ...settings, tagSync });
    }
    return jsonResponse(settings);
  } catch (err) {
    console.error('[ghl-reconcile-settings] failed', err);
    return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

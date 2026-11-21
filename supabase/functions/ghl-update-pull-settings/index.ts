/**
 * MISSION-4 TASK-T1 (GHL-5/6): "Edit GHL pull settings" (auto-pull enabled toggle + the custom
 * field mapping), owner/admin -- same permission tier as ghl-update-blocked-tags, which this
 * mirrors closely. Writes straight to org_integrations.ghl_pull_enabled/ghl_field_mapping via the
 * private.set_org_ghl_pull_settings RPC (20260926080000) -- the table itself has zero client
 * policies, so this is the only path to change them short of a service-role script.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

/** A plain object of string -> string, capped at a sane size -- same "don't let a pasted mistake
 *  balloon a config column forever" reasoning as ghl-update-blocked-tags' own cleanTagList. */
function cleanFieldMapping(input: unknown): Record<string, string> | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > 100) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let body: { pullEnabled?: unknown; fieldMapping?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  if (typeof body.pullEnabled !== 'boolean') {
    return jsonResponse({ error: 'pullEnabled must be a boolean' }, 400);
  }
  const fieldMapping = cleanFieldMapping(body.fieldMapping ?? {});
  if (fieldMapping === null) {
    return jsonResponse({ error: 'fieldMapping must be a plain object of string -> string' }, 400);
  }

  const supabase = getSupabaseAdmin();
  const { error: rpcError } = await supabase.rpc('set_org_ghl_pull_settings', {
    p_org: orgId,
    p_pull_enabled: body.pullEnabled,
    p_field_mapping: fieldMapping,
  });
  if (rpcError) {
    console.error('[ghl-update-pull-settings] rpc failed', rpcError.message);
    const status = rpcError.message.includes('has no GHL integration') ? 400 : 500;
    return jsonResponse({ error: rpcError.message }, status);
  }

  await logOrgAction(supabase, {
    orgId,
    actorUserId: user.id,
    action: 'ghl.update_pull_settings',
    targetType: 'org_integrations',
    targetId: orgId,
    details: { pullEnabled: body.pullEnabled, fieldMapping },
  });

  return jsonResponse({ pullEnabled: body.pullEnabled, fieldMapping });
});

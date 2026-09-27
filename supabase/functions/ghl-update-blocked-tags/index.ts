/**
 * "Edit blocked GHL tags" (TASK-G7, GHL-7), owner/admin -- same permission tier as ghl-import
 * (which reads these lists) and connectGhl/disconnectGhl is owner-only, but this task's own file
 * explicitly says owner/admin can edit the lists, so this mirrors requireOrgRole's usage
 * elsewhere in this lane, not ghl-connect/ghl-disconnect's owner-only check. Writes straight to
 * org_integrations.ghl_dnc_tags/ghl_paused_tags via the private.set_org_ghl_blocked_tags RPC
 * (20260925080000) -- the table itself has zero client policies (see that migration's header),
 * so this is the only path to change them short of a service-role script.
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

/** Trims every entry, drops blanks and exact (case-insensitive) duplicates, and caps the list at
 *  a sane size -- an unbounded list pasted in by mistake (e.g. a whole CSV column) would make
 *  every future import page slower for no benefit, and a blank entry would match every GHL
 *  contact if it were ever compared with a blank-trimmed tag (it never is, since GHL tags are
 *  never blank strings in practice, but there's no reason to allow it in). */
function cleanTagList(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 50) break;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let body: { dncTags?: unknown; pausedTags?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const dncTags = cleanTagList(body.dncTags);
  const pausedTags = cleanTagList(body.pausedTags);
  if (dncTags === null || pausedTags === null) {
    return jsonResponse({ error: 'dncTags and pausedTags must both be arrays of strings' }, 400);
  }
  if (dncTags.length === 0 || pausedTags.length === 0) {
    return jsonResponse({ error: 'Each list needs at least one tag' }, 400);
  }

  const supabase = getSupabaseAdmin();
  const { error: rpcError } = await supabase.rpc('set_org_ghl_blocked_tags', {
    p_org: orgId,
    p_dnc_tags: dncTags,
    p_paused_tags: pausedTags,
  });
  if (rpcError) {
    console.error('[ghl-update-blocked-tags] rpc failed', rpcError.message);
    // set_org_ghl_blocked_tags raises when the org has no GHL integration row yet -- surface that
    // as a 400 (a real client mistake: connect first), not a 500.
    const status = rpcError.message.includes('has no GHL integration') ? 400 : 500;
    return jsonResponse({ error: rpcError.message }, status);
  }

  await logOrgAction(supabase, {
    orgId,
    actorUserId: user.id,
    action: 'ghl.update_blocked_tags',
    targetType: 'org_integrations',
    targetId: orgId,
    details: { dncTags, pausedTags },
  });

  return jsonResponse({ dncTags, pausedTags });
});

/**
 * List the org's purchased numbers (TASK-P1-06). Pure DB read against `user_phone_numbers`
 * -- no Telnyx call, so this works even if the org's Telnyx connection later goes
 * `disconnected`. Any active org member can see the org's shared number pool
 * (`user_phone_numbers`' own RLS already scopes SELECT to org members; this uses the
 * service-role client so the org filter below is load-bearing, not just RLS).
 */
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole, getSupabaseAdmin } from '../_shared/telnyx-org-context.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  const { orgId, error: roleError } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent']);
  if (roleError) return roleError;

  const supabase = getSupabaseAdmin();
  const { data: numbers, error: dbError } = await supabase
    .from('user_phone_numbers')
    .select('id, telnyx_phone_number_id, phone_number, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (dbError) {
    console.error('[telnyx-list-numbers] query failed', dbError.message);
    return jsonResponse({ error: dbError.message }, 500);
  }

  return jsonResponse({ numbers: numbers ?? [] });
});

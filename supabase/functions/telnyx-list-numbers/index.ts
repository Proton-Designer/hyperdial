/**
 * List the org's purchased numbers (TASK-P1-06; TASK-N1 widens the response with pool
 * metadata). Pure DB read against `user_phone_numbers` -- no Telnyx call, so this works even if
 * the org's Telnyx connection later goes `disconnected`. Any active org member can see the org's
 * shared number pool (`user_phone_numbers`' own RLS already scopes SELECT to org members; this
 * uses the service-role client so the org filter below is load-bearing, not just RLS).
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
    .select(
      'id, telnyx_phone_number_id, phone_number, created_at, assigned_user_id, status, resting_until, daily_cap'
    )
    .eq('org_id', orgId)
    .order('created_at', { ascending: false });
  if (dbError) {
    console.error('[telnyx-list-numbers] query failed', dbError.message);
    return jsonResponse({ error: dbError.message }, 500);
  }

  // TASK-N1: today's dial count per number, so the UI can show "dials today / cap" without a
  // second round trip. UTC calendar day -- same boundary private.pick_and_reserve_dial_number
  // itself uses (see the migration's own comment on why there's no per-org tz to read instead).
  const today = new Date().toISOString().slice(0, 10);
  const { data: usage, error: usageError } = await supabase
    .from('number_daily_usage')
    .select('number_id, dials')
    .eq('org_id', orgId)
    .eq('day', today);
  if (usageError) {
    console.error('[telnyx-list-numbers] usage query failed', usageError.message);
    return jsonResponse({ error: usageError.message }, 500);
  }
  const dialsByNumber = new Map(
    (usage ?? []).map((u) => [u.number_id as string, u.dials as number])
  );

  const enriched = (numbers ?? []).map((n) => ({
    ...n,
    dials_today: dialsByNumber.get(n.id as string) ?? 0,
  }));

  return jsonResponse({ numbers: enriched });
});

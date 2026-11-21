/**
 * MISSION-4 TASK-S2 (part 1): watches every campaign currently dialing above 7 lines with its
 * high-lines drop-rate guard on, and auto-reduces any whose recent (T8-style) drop rate exceeds
 * 3% back to 7 lines. Triggered by pg_cron/pg_net (`private.trigger_high_lines_guard_check`,
 * `20260926070005_high_lines_drop_guard.sql`) with a shared secret header, not a user JWT --
 * same shape as reliability-alert-check/spend-alert-check/recording-retention/dialer-sweeper.
 *
 * The SQL RPC (check_high_lines_drop_rate_guard) decides + reduces atomically in one statement,
 * so two overlapping cron runs can never double-trip the same campaign. This function's own job
 * is just: call it, and notify the org's owners/admins for whatever it reduced.
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

/** Same constant-time comparison as spend-alert-check/recording-retention/dialer-sweeper/
 *  reliability-alert-check/number-health-check. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

/** Mirrors reliability-alert-check's own `notifyOwnersAndAdmins` verbatim -- a third small usage
 *  of the same "fan out one notifications row per active owner/admin" shape; not yet worth
 *  extracting to `_shared` (NIT, follow-up). */
async function notifyOwnersAndAdmins(
  supabase: SupabaseClient,
  orgId: string,
  type: string,
  title: string,
  body: string
): Promise<void> {
  const { data: members, error } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .in('role', ['owner', 'admin']);
  if (error || !members?.length) return;

  await supabase.from('notifications').insert(
    members.map((m: { user_id: string }) => ({
      org_id: orgId,
      user_id: m.user_id,
      type,
      title,
      body,
    }))
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const expectedSecret = Deno.env.get('HIGH_LINES_GUARD_SECRET');
  const providedSecret = req.headers.get('X-Cron-Secret');
  // Fail closed: an unset expectedSecret never means "allow everything" (known-issues #0's
  // telnyx-webhook lesson, applied the same way every other cron-worker function already does).
  if (!expectedSecret || !providedSecret || !secretsMatch(providedSecret, expectedSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const supabase = getSupabaseAdmin();

  const { data: rows, error } = await supabase.rpc('check_high_lines_drop_rate_guard');
  if (error) {
    console.error(
      '[campaign-lines-guard-check] check_high_lines_drop_rate_guard failed',
      error.message
    );
    return jsonResponse({ error: error.message }, 500);
  }

  let reduced = 0;
  for (const row of (rows ?? []) as Array<{
    campaign_id: string;
    org_id: string;
    campaign_name: string;
    lines_before: number;
    human_answers: number;
    dropped: number;
    drop_rate_pct: number;
  }>) {
    await notifyOwnersAndAdmins(
      supabase,
      row.org_id,
      'high_lines_guard_tripped',
      'Lines auto-reduced for high drop rate',
      `"${row.campaign_name}" was reduced from ${row.lines_before} lines back to 7: its drop ` +
        `rate hit ${row.drop_rate_pct}% (${row.dropped}/${row.human_answers} human answers) ` +
        `over the last hour. The high-lines guard is off again -- re-enable it in Campaign ` +
        `settings after reviewing what happened.`
    );
    reduced++;
  }

  return jsonResponse({ reduced });
});

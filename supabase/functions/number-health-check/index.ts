/**
 * TASK-T9 (Mission 4, CID-4): caller-ID health check -- flags a number whose 30-day human-answer
 * rate is well below the pool median (thresholds documented in
 * `20260926080600_number_health.sql`'s own header). Two entry paths into the SAME
 * `check_number_health` RPC:
 *
 * 1. Cron (weekly, `private.trigger_number_health_check`): a shared-secret header, no user JWT --
 *    same shape as reliability-alert-check/spend-alert-check/dialer-sweeper/ghl-sync-worker. Runs
 *    with `p_org_id = null`, which only ever processes orgs with `health_alerts_enabled = true`
 *    (disabled by default, per CLAUDE.md's own "new automatic behaviour ships disabled" rule).
 * 2. On-demand (a real user JWT, owner/admin only via `requireOrgRole`): runs for THAT caller's
 *    own org specifically, regardless of its `health_alerts_enabled` flag -- an explicit,
 *    user-initiated check is not "new automatic behaviour," so it isn't gated by the same opt-in
 *    the weekly sweep respects (see the migration's own comment on `check_number_health`).
 *
 * Delivery: the existing generic `notifications` table (same "fan out one row per active
 * owner/admin" shape as reliability-alert-check's own `notifyOwnersAndAdmins`) for BOTH paths --
 * an on-demand check that finds something still tells every owner/admin, not just the one who
 * clicked the button. The on-demand path additionally returns the flagged list directly in the
 * response for immediate UI feedback (NumberHealthPanel.tsx).
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { timingSafeEqual } from 'jsr:@std/crypto@1/timing-safe-equal';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

/** Same constant-time comparison as reliability-alert-check/spend-alert-check/dialer-sweeper. */
function secretsMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.length !== bBytes.length) return false;
  return timingSafeEqual(aBytes, bBytes);
}

interface FlaggedRow {
  number_id: string;
  org_id: string;
  phone_number: string;
  sample_dials: number;
  human_answer_rate: number;
  pool_median_rate: number;
}

/** Mirrors reliability-alert-check's own `notifyOwnersAndAdmins` verbatim -- a third, small usage
 *  of the same "fan out one notifications row per active owner/admin" shape; not yet worth
 *  extracting to `_shared` for three call sites. */
async function notifyOwnersAndAdmins(
  supabase: SupabaseClient,
  orgId: string,
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
      type: 'number_health_flagged',
      title,
      body,
    }))
  );
}

async function alertFlaggedRows(supabase: SupabaseClient, rows: FlaggedRow[]): Promise<void> {
  const byOrg = new Map<string, FlaggedRow[]>();
  for (const row of rows) {
    const list = byOrg.get(row.org_id) ?? [];
    list.push(row);
    byOrg.set(row.org_id, list);
  }
  for (const [orgId, orgRows] of byOrg) {
    const summary = orgRows
      .map(
        (r) =>
          `${r.phone_number}: ${Math.round(r.human_answer_rate * 100)}% answer rate ` +
          `(pool median ${Math.round(r.pool_median_rate * 100)}%, ${r.sample_dials} dials)`
      )
      .join('; ');
    await notifyOwnersAndAdmins(
      supabase,
      orgId,
      orgRows.length === 1
        ? 'A caller-ID number was flagged'
        : `${orgRows.length} caller-ID numbers were flagged`,
      `${summary}. Flagged numbers are automatically rested and excluded from dialing until reactivated.`
    );
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const cronSecret = req.headers.get('X-Cron-Secret');
  const expectedSecret = Deno.env.get('NUMBER_HEALTH_CHECK_SECRET');

  if (cronSecret) {
    // Fail closed: an unset expectedSecret never means "allow everything" (known-issues #0's
    // telnyx-webhook lesson, applied the same way every other cron-worker function already does).
    if (!expectedSecret || !secretsMatch(cronSecret, expectedSecret)) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const supabase = getSupabaseAdmin();
    const { data: flagged, error } = await supabase.rpc('check_number_health', { p_org_id: null });
    if (error) {
      console.error('[number-health-check] check_number_health failed (cron)', error.message);
      return jsonResponse({ error: error.message }, 500);
    }
    const rows = (flagged ?? []) as FlaggedRow[];
    await alertFlaggedRows(supabase, rows);
    return jsonResponse({ flaggedCount: rows.length });
  }

  // On-demand path: owner/admin only, scoped to the caller's own org.
  const { orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  const supabase = getSupabaseAdmin();
  const { data: flagged, error } = await supabase.rpc('check_number_health', { p_org_id: orgId });
  if (error) {
    console.error('[number-health-check] check_number_health failed (on-demand)', error.message);
    return jsonResponse({ error: error.message }, 500);
  }
  const rows = (flagged ?? []) as FlaggedRow[];
  await alertFlaggedRows(supabase, rows);

  return jsonResponse({
    flagged: rows.map((r) => ({
      numberId: r.number_id,
      phoneNumber: r.phone_number,
      sampleDials: r.sample_dials,
      humanAnswerRate: r.human_answer_rate,
      poolMedianRate: r.pool_median_rate,
    })),
  });
});

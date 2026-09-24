import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';

/**
 * TASK-P4-P1: reads `call_leg_analytics` (a real dial-session-backed view, TASK-P2-E2/E1's
 * call_legs + TASK-P3-E1's dispositions) instead of `call_events`, which nothing in this repo
 * writes (CLAUDE.md's own known-issue -- see .brain/domains/analytics.md). Response shape is
 * UNCHANGED from before this task (Dashboard.tsx needs no changes for this endpoint).
 */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  // This is the caller's own personal daily widget, not the org-wide "team stats"
  // capability (that's team-performance) -- every role can see their own numbers.
  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin', 'agent']);
  if (authError) return authError;

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const userId = user.id;

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date(todayStart);
    todayEnd.setUTCDate(todayEnd.getUTCDate() + 1);
    const todayStartStr = todayStart.toISOString();
    const todayEndStr = todayEnd.toISOString();

    const { data: legsToday, error: legsError } = await supabase
      .from('call_leg_analytics')
      .select('is_connected, duration_seconds')
      .eq('org_id', orgId)
      .eq('agent_id', userId)
      .gte('created_at', todayStartStr)
      .lt('created_at', todayEndStr);
    if (legsError) return jsonResponse(500, { error: legsError.message });

    const list = legsToday ?? [];
    const callsToday = list.length;
    const connectedCount = list.filter((r) => r.is_connected).length;
    const connectRate = callsToday > 0 ? Math.round((connectedCount / callsToday) * 1000) / 10 : 0;
    const talkTimeSeconds = list
      .filter((r) => r.is_connected)
      .reduce(
        (sum: number, r: { duration_seconds: number | null }) => sum + (r.duration_seconds ?? 0),
        0
      );

    const hours = Math.floor(talkTimeSeconds / 3600);
    const mins = Math.floor((talkTimeSeconds % 3600) / 60);
    const talkTimeFormatted = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    return jsonResponse(200, {
      callsToday,
      connectRate,
      talkTimeFormatted,
      talkTimeSeconds,
    });
  } catch (err) {
    console.error('dashboard-stats error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

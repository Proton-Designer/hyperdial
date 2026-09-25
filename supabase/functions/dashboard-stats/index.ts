import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { computeConversationsPerHour, isConversation } from '../_shared/analytics-core.ts';

/**
 * TASK-P4-P1: reads `call_leg_analytics` (a real dial-session-backed view, TASK-P2-E2/E1's
 * call_legs + TASK-P3-E1's dispositions) instead of `call_events`, which nothing in this repo
 * writes (CLAUDE.md's own known-issue -- see .brain/domains/analytics.md).
 *
 * TASK-M1 adds conversationsToday/dialingHoursToday/conversationsPerHour ("Conversations / hr",
 * replacing the ambiguous "Revenue Pipeline" card) on top of the SAME scoping this endpoint
 * already used for every existing field: every role's own numbers (agent_id = the caller), not
 * an org-wide rollup for owner/admin -- this is the personal daily widget, org-wide totals are
 * team-performance's job. Definitions live in .brain/domains/analytics.md.
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
      .select('is_connected, duration_seconds, is_win')
      .eq('org_id', orgId)
      .eq('agent_id', userId)
      .gte('created_at', todayStartStr)
      .lt('created_at', todayEndStr);
    if (legsError) return jsonResponse(500, { error: legsError.message });

    const list = legsToday ?? [];
    const callsToday = list.length;
    // TASK-F-P1 (Wins): a "win" (dispositions.is_win) among today's own legs -- same today+
    // per-agent scoping as every other card on this personal daily widget, not an org-wide count.
    const winsToday = list.filter((r: { is_win: boolean }) => r.is_win).length;
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

    // "Conversation" (.brain/domains/analytics.md): a connected leg with duration_seconds >= 30.
    // Reuses the SAME today-scoped, per-agent rowset the other cards above already fetched --
    // no second query needed. isConversation/computeConversationsPerHour are pure and unit
    // tested directly (analytics-core.test.ts) since this index.ts has no test file of its own.
    const conversationsToday = list.filter(isConversation).length;

    const { data: dialingHoursRaw, error: dialingHoursError } = await supabase.rpc(
      'dialing_hours_today',
      { p_org_id: orgId, p_agent_id: userId }
    );
    if (dialingHoursError) return jsonResponse(500, { error: dialingHoursError.message });
    const dialingHoursToday = Number(dialingHoursRaw ?? 0);
    const conversationsPerHour = computeConversationsPerHour(conversationsToday, dialingHoursToday);

    return jsonResponse(200, {
      callsToday,
      connectRate,
      talkTimeFormatted,
      talkTimeSeconds,
      conversationsToday,
      dialingHoursToday: Math.round(dialingHoursToday * 10) / 10,
      conversationsPerHour,
      winsToday,
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

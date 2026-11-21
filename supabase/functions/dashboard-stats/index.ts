import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import {
  computeConversationsPerHour,
  isConversation,
  localDayBoundsUtc,
} from '../_shared/analytics-core.ts';

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
 *
 * MISSION-5 TASK-M5-A4: "today" used to be a hardcoded UTC-midnight boundary (`setUTCHours(0,0,
 * 0,0)`) -- never matched any real org's actual calendar day, and was already inconsistent with
 * `dialing_hours_today`'s own separate (also-hardcoded, now fixed) America/Chicago boundary.
 * Both now read the org's real `org_timezone_settings.timezone`. `callbacksToday` is new --
 * "my callbacks today" (A4's own agent self-view requirement) -- via `call_leg_analytics`'
 * newly-added `disposition_lead_effect` column, same today+per-agent-scoped rowset as every
 * other card here, no second query needed.
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

    const { data: tzRow } = await supabase
      .from('org_timezone_settings')
      .select('timezone')
      .eq('org_id', orgId)
      .maybeSingle();
    const orgTz = (tzRow?.timezone as string | undefined) ?? 'America/Chicago';
    const { start: todayStart, end: todayEnd } = localDayBoundsUtc(orgTz);
    const todayStartStr = todayStart.toISOString();
    const todayEndStr = todayEnd.toISOString();

    const { data: legsToday, error: legsError } = await supabase
      .from('call_leg_analytics')
      .select('is_connected, duration_seconds, is_win, disposition_lead_effect')
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
    // MISSION-5 TASK-M5-A4: "my callbacks today" -- reuses the SAME today+per-agent rowset above.
    const callbacksToday = list.filter(
      (r: { disposition_lead_effect: string | null }) => r.disposition_lead_effect === 'callback'
    ).length;
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
      callbacksToday,
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

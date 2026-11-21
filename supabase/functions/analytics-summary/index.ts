import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';

/**
 * TASK-P4-P1: the real backend for the Analytics screen (design §8 Phase 4), replacing
 * apps/web/src/components/Analytics.tsx's hardcoded mock data entirely. Reads
 * `call_leg_analytics`/`dial_session_hours` (call_legs/dial_sessions/dispositions-backed views,
 * TASK-P2-E1/E2 + TASK-P3-E1) -- never `call_events`, which nothing writes.
 *
 * Design §2 permission matrix, same as team-performance: owner/admin see the whole org,
 * an agent sees only their own numbers (agentPerformance returns a single-row array for an
 * agent, not a leaderboard of teammates).
 */

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const OUTCOME_LABEL: Record<string, string> = {
  no_answer: 'No answer',
  busy: 'Busy',
  machine: 'Voicemail',
  dropped: 'Dropped',
  abandoned: 'Abandoned',
  failed: 'Failed',
  connected: 'Connected (no disposition yet)',
};

function getDateRange(
  range: string,
  customStart?: string,
  customEnd?: string
): { start: Date; end: Date } {
  const end = new Date();
  end.setUTCHours(23, 59, 59, 999);
  const start = new Date();
  if (range === '30d') {
    start.setUTCDate(start.getUTCDate() - 29);
    start.setUTCHours(0, 0, 0, 0);
  } else if (range === 'custom' && customStart && customEnd) {
    start.setTime(new Date(customStart).getTime());
    start.setUTCHours(0, 0, 0, 0);
    end.setTime(new Date(customEnd).getTime());
    end.setUTCHours(23, 59, 59, 999);
  } else {
    start.setUTCDate(start.getUTCDate() - 6);
    start.setUTCHours(0, 0, 0, 0);
  }
  return { start, end };
}

/** The immediately-preceding period of equal length, for a "+X% vs. last period" delta --
 *  e.g. for a 7-day range, the 7 days right before it. */
function getPreviousRange(start: Date, end: Date): { start: Date; end: Date } {
  const spanMs = end.getTime() - start.getTime();
  const prevEnd = new Date(start.getTime() - 1);
  const prevStart = new Date(prevEnd.getTime() - spanMs);
  return { start: prevStart, end: prevEnd };
}

interface LegRow {
  created_at: string;
  agent_id: string;
  is_connected: boolean;
  outcome: string | null;
  duration_seconds: number | null;
  disposition_label: string | null;
}

interface Totals {
  totalCalls: number;
  connectRate: number;
  talkTimeSeconds: number;
  conversationsPerAgentHour: number | null;
}

function computeTotals(legs: LegRow[], agentHours: number): Totals {
  const totalCalls = legs.length;
  const connected = legs.filter((l) => l.is_connected);
  const connectRate = totalCalls > 0 ? Math.round((connected.length / totalCalls) * 1000) / 10 : 0;
  const talkTimeSeconds = connected.reduce((sum, l) => sum + (l.duration_seconds ?? 0), 0);
  const conversationsPerAgentHour =
    agentHours > 0 ? Math.round((connected.length / agentHours) * 100) / 100 : null;
  return { totalCalls, connectRate, talkTimeSeconds, conversationsPerAgentHour };
}

function pctChange(current: number, previous: number): number | null {
  if (previous === 0) return current > 0 ? null : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function formatTalkTime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const mins = Math.floor((totalSeconds % 3600) / 60);
  return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

async function loadLegs(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string | null,
  start: Date,
  end: Date
): Promise<LegRow[]> {
  let query = supabase
    .from('call_leg_analytics')
    .select('created_at, agent_id, is_connected, outcome, duration_seconds, disposition_label')
    .eq('org_id', orgId)
    .gte('created_at', start.toISOString())
    .lte('created_at', end.toISOString());
  if (agentId) query = query.eq('agent_id', agentId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as LegRow[];
}

async function loadAgentHours(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string | null,
  start: Date,
  end: Date
): Promise<number> {
  let query = supabase
    .from('dial_session_hours')
    .select('session_hours')
    .eq('org_id', orgId)
    .not('session_hours', 'is', null)
    .gte('started_at', start.toISOString())
    .lte('started_at', end.toISOString());
  if (agentId) query = query.eq('agent_id', agentId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).reduce(
    (sum: number, r: { session_hours: number }) => sum + r.session_hours,
    0
  );
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  const {
    user,
    orgId,
    role,
    error: authError,
  } = await requireOrgRole(req, ['owner', 'admin', 'agent']);
  if (authError) return authError;

  try {
    const url = new URL(req.url);
    const range = url.searchParams.get('range') || '7d';
    const customStart = url.searchParams.get('custom_start') || undefined;
    const customEnd = url.searchParams.get('custom_end') || undefined;
    const { start, end } = getDateRange(range, customStart, customEnd);
    const { start: prevStart, end: prevEnd } = getPreviousRange(start, end);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    // Own-only for an agent (design §2), whole org for owner/admin -- same split as
    // team-performance.
    const agentFilter = role === 'agent' ? user.id : null;

    const [legs, prevLegs, agentHours, prevAgentHours] = await Promise.all([
      loadLegs(supabase, orgId, agentFilter, start, end),
      loadLegs(supabase, orgId, agentFilter, prevStart, prevEnd),
      loadAgentHours(supabase, orgId, agentFilter, start, end),
      loadAgentHours(supabase, orgId, agentFilter, prevStart, prevEnd),
    ]);

    const totals = computeTotals(legs, agentHours);
    const prevTotals = computeTotals(prevLegs, prevAgentHours);

    // Call volume chart: one bucket per day in range, zero-filled so gaps render instead of
    // disappearing (same discipline as team-performance's own byDay loop).
    const byDay: Record<string, { calls: number; connections: number; voicemails: number }> = {};
    const cursor = new Date(start);
    while (cursor <= end) {
      byDay[cursor.toISOString().slice(0, 10)] = { calls: 0, connections: 0, voicemails: 0 };
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    for (const leg of legs) {
      const d = leg.created_at.slice(0, 10);
      if (!byDay[d]) byDay[d] = { calls: 0, connections: 0, voicemails: 0 };
      byDay[d].calls += 1;
      if (leg.is_connected) byDay[d].connections += 1;
      // "Voicemail" here means AMD detected an answering machine on the call itself
      // (call_legs.outcome = 'machine') -- available for every leg regardless of whether it's
      // ever been dispositioned, unlike a disposition-key-based definition would be (the
      // mandatory wrap-up form doesn't exist yet, E4).
      if (leg.outcome === 'machine') byDay[d].voicemails += 1;
    }
    const sortedDates = Object.keys(byDay).sort();
    const callVolumeData = sortedDates.map((dateStr) => {
      const d = new Date(dateStr + 'T12:00:00Z');
      return { day: DAY_NAMES[d.getUTCDay()], date: dateStr, ...byDay[dateStr] };
    });

    // Disposition breakdown: legs that have been dispositioned group by the disposition's own
    // label; everything else falls back to its raw outcome (or "In progress" if even that's
    // still null) -- honest about the mandatory wrap-up form not existing yet, not silently
    // dropping undispositioned legs from the chart.
    const breakdownCounts = new Map<string, number>();
    for (const leg of legs) {
      const label =
        leg.disposition_label ??
        (leg.outcome ? (OUTCOME_LABEL[leg.outcome] ?? leg.outcome) : 'In progress');
      breakdownCounts.set(label, (breakdownCounts.get(label) ?? 0) + 1);
    }
    const dispositionBreakdown = Array.from(breakdownCounts.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);

    // Agent performance leaderboard: org-wide for owner/admin, a single self-row for an agent.
    const byAgent = new Map<string, { calls: number; connections: number }>();
    for (const leg of legs) {
      const row = byAgent.get(leg.agent_id) ?? { calls: 0, connections: 0 };
      row.calls += 1;
      if (leg.is_connected) row.connections += 1;
      byAgent.set(leg.agent_id, row);
    }
    const agentIds = Array.from(byAgent.keys());
    const { data: profiles } = agentIds.length
      ? await supabase
          .from('profiles')
          .select('user_id, first_name, last_name')
          .in('user_id', agentIds)
      : { data: [] as { user_id: string; first_name: string | null; last_name: string | null }[] };
    const nameById = new Map(
      (profiles ?? []).map((p) => [
        p.user_id,
        `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || 'Agent',
      ])
    );
    const agentPerformance = agentIds
      .map((id) => {
        const row = byAgent.get(id)!;
        return {
          agentId: id,
          name: nameById.get(id) ?? 'Agent',
          calls: row.calls,
          connections: row.connections,
          rate: row.calls > 0 ? Math.round((row.connections / row.calls) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => b.calls - a.calls);

    return jsonResponse(200, {
      range: { start: start.toISOString(), end: end.toISOString() },
      totals: {
        totalCalls: totals.totalCalls,
        totalCallsChangePct: pctChange(totals.totalCalls, prevTotals.totalCalls),
        connectRate: totals.connectRate,
        connectRateChangePct: pctChange(totals.connectRate, prevTotals.connectRate),
        talkTimeSeconds: totals.talkTimeSeconds,
        talkTimeFormatted: formatTalkTime(totals.talkTimeSeconds),
        talkTimeChangePct: pctChange(totals.talkTimeSeconds, prevTotals.talkTimeSeconds),
        conversationsPerAgentHour: totals.conversationsPerAgentHour,
        conversationsPerAgentHourChangePct:
          totals.conversationsPerAgentHour !== null && prevTotals.conversationsPerAgentHour !== null
            ? pctChange(totals.conversationsPerAgentHour, prevTotals.conversationsPerAgentHour)
            : null,
      },
      callVolumeData,
      dispositionBreakdown,
      agentPerformance,
    });
  } catch (err) {
    console.error('analytics-summary error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});

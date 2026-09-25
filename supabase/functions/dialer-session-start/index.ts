import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { startSession } from '../_shared/dialer-engine.ts';
import { readJsonBody } from '../_shared/http-json.ts';

/**
 * Starts a rolling-refill dial session for a campaign (TASK-P2-E2). Rewritten from the
 * legacy Redis/dialer_sessions engine to the org-scoped dial_sessions/call_legs schema --
 * see _shared/dialer-engine.ts's header for the full design.
 *
 * Behavior change from the legacy function: no `fromNumber`/`agentCallControlId`/
 * `agentCallbackNumber` request fields anymore. The caller ID now comes from the
 * campaign's own `caller_id_number_id` (added TASK-P2-P1) -- a campaign, not a per-session
 * choice.
 *
 * TASK-L1: `startSession` now dials the real agent WebRTC leg ("Go Ready") instead of
 * dialing contacts immediately -- the session starts 'ready_pending' and only reaches
 * 'dialing' once the agent leg answers (see dialer-engine.ts's header). The active-session
 * check below is now per-AGENT, not per-campaign (SEC-8: an agent has exactly one SIP
 * endpoint, so they can only ever be in one session at a time, regardless of campaign) --
 * backed by a live partial unique index (`dial_sessions_one_active_per_agent`,
 * `20260925005000`); the catch block maps its violation (surfaced as
 * `ACTIVE_SESSION_EXISTS_FOR_AGENT` from startSession) to the same 409 shape as this
 * proactive check, closing the check-then-insert race.
 */

const VALID_AMD_MODES = ['off', 'detect', 'detect_words', 'premium'] as const;
type AmdModeOverride = (typeof VALID_AMD_MODES)[number];

interface StartBody {
  campaignId?: string;
  /** Overrides the campaign's own default `lines` (1-7) for this session only. */
  lines?: number;
  /** Overrides the campaign's own default `amd_mode` for this session only (BUG-7). */
  amdMode?: AmdModeOverride;
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const {
    user,
    orgId,
    role,
    error: authError,
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent']);
  if (authError) return authError;

  const { body, errorResponse } = await readJsonBody<StartBody>(req);
  if (errorResponse) return errorResponse;

  try {
    const campaignId = body.campaignId?.trim();
    if (!campaignId) return jsonResponse(400, { error: 'campaignId is required' });

    const linesOverride =
      body.lines !== undefined ? Math.max(1, Math.min(7, Math.trunc(body.lines))) : undefined;
    const amdModeOverride = VALID_AMD_MODES.includes(body.amdMode as AmdModeOverride)
      ? body.amdMode
      : undefined;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: campaign, error: campaignError } = await supabase
      .from('campaigns')
      .select('id, lines, amd_mode, caller_id_number_id, status, deleted_at')
      .eq('id', campaignId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (campaignError) return jsonResponse(500, { error: campaignError.message });
    if (!campaign) return jsonResponse(404, { error: 'Campaign not found' });
    // dial_sessions_require_active_campaign (20260924001500) enforces this same rule at the
    // DB level via a BEFORE INSERT trigger -- checked here too so a normal case (not a race)
    // gets a clean, specific 4xx instead of parsing the trigger's raised exception text. The
    // catch block below still maps that trigger's rejection to a 4xx as defense in depth for
    // the TOCTOU window between this check and the actual insert (e.g. another request
    // deletes/pauses the campaign in between).
    if (campaign.deleted_at) {
      return jsonResponse(400, {
        error: 'This campaign has been deleted, so a dial session cannot be started.',
        code: 'CAMPAIGN_NOT_ACTIVE',
      });
    }
    if (campaign.status !== 'active') {
      return jsonResponse(400, {
        error: `This campaign is ${campaign.status}, so a dial session cannot be started.`,
        code: 'CAMPAIGN_NOT_ACTIVE',
      });
    }
    // TASK-N1: a pool-only org (no legacy campaign.caller_id_number_id ever set) must still be
    // able to Go Ready -- the agent leg's own dial (agentDialFromNumber, dialer-engine.ts) falls
    // back to ANY org-owned number when the legacy field is empty, so the only real requirement
    // is that the org owns at least one phone number at all, not that THIS campaign has a fixed
    // one. A campaign with its own caller_id_number_id set skips this extra check entirely.
    if (!campaign.caller_id_number_id) {
      const { count: numberCount, error: numberCountError } = await supabase
        .from('user_phone_numbers')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId);
      if (numberCountError) return jsonResponse(500, { error: numberCountError.message });
      if (!numberCount) {
        return jsonResponse(400, {
          error: 'This org has no phone numbers yet. Buy one in Settings first.',
          code: 'MISSING_CALLER_ID',
        });
      }
    }

    // Review fix (L1 round-3 review-notes-r3.md, MAJOR 1): owners/admins may start any org
    // campaign (unchanged), but an agent must actually be assigned to it -- the Dialer's own
    // campaign list (listMyCampaignAssignments) already filters to this, but nothing enforced
    // it server-side, so a crafted request could start dialing on an unassigned campaign.
    if (role === 'agent') {
      const { data: assignment, error: assignmentError } = await supabase
        .from('campaign_agents')
        .select('campaign_id')
        .eq('campaign_id', campaignId)
        .eq('user_id', user.id)
        .maybeSingle();
      if (assignmentError) return jsonResponse(500, { error: assignmentError.message });
      if (!assignment) {
        return jsonResponse(403, {
          error: 'You are not assigned to this campaign.',
          code: 'NOT_ASSIGNED_TO_CAMPAIGN',
        });
      }
    }

    // Per-agent, not per-campaign (SEC-8) -- see this file's header. `dial_sessions_one_active_
    // per_agent` (live) enforces this for real; this is the fast, clean-error proactive path.
    const { data: existing, error: existingError } = await supabase
      .from('dial_sessions')
      .select('id')
      .eq('agent_id', user.id)
      .in('state', [
        'ready_pending',
        'ready',
        'dialing',
        'connecting',
        'on_call',
        'wrap_up',
        'paused',
        'paused_agent_lost',
      ])
      .maybeSingle();
    if (existingError) return jsonResponse(500, { error: existingError.message });
    if (existing) {
      return jsonResponse(409, {
        error:
          'You already have an active dialer session. Stop or reconnect it before starting another.',
        code: 'ACTIVE_SESSION_EXISTS',
        existingSessionId: existing.id,
      });
    }

    const { sessionId } = await startSession(supabase, {
      orgId,
      campaignId,
      agentId: user.id,
      lines: linesOverride ?? (campaign.lines as number),
      amdMode: amdModeOverride ?? (campaign.amd_mode as AmdModeOverride),
    });

    return jsonResponse(200, { sessionId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // dial_sessions_require_active_campaign (20260924001500): the proactive checks above
    // catch the normal case; this is the TOCTOU fallback (the campaign was deleted/paused by
    // another request between that SELECT and this INSERT).
    if (
      msg.includes('cannot start a dial session for a deleted campaign') ||
      msg.includes('cannot start a dial session for a') ||
      msg.includes('does not reference an existing campaign')
    ) {
      return jsonResponse(400, {
        error: 'This campaign is no longer active, so a dial session cannot be started.',
        code: 'CAMPAIGN_NOT_ACTIVE',
      });
    }
    // SEC-8 TOCTOU fallback: another request inserted a session for this same agent between
    // the proactive check above and this INSERT. startSession (dialer-engine.ts) maps the live
    // partial unique index's violation (detected by Postgres SQLSTATE 23505, review fix m2)
    // to this exact message.
    if (msg.includes('ACTIVE_SESSION_EXISTS_FOR_AGENT')) {
      // Review fix (m2): look up the id of the session that won the race so the client's
      // ActiveSessionExistsError actually gets thrown (api.ts only throws it when
      // existingSessionId is present) -- the proactive check above already does this same
      // lookup for the common case; this is just that same query for the rare TOCTOU one.
      // `supabase` itself is block-scoped inside the try above, so a fresh client is needed.
      const supabaseForLookup = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
      );
      const { data: winner } = await supabaseForLookup
        .from('dial_sessions')
        .select('id')
        .eq('agent_id', user.id)
        .in('state', [
          'ready_pending',
          'ready',
          'dialing',
          'connecting',
          'on_call',
          'wrap_up',
          'paused',
          'paused_agent_lost',
        ])
        .maybeSingle();
      return jsonResponse(409, {
        error:
          'You already have an active dialer session. Stop or reconnect it before starting another.',
        code: 'ACTIVE_SESSION_EXISTS',
        existingSessionId: winner?.id,
      });
    }
    console.error('dialer-session-start error:', err);
    return jsonResponse(500, { error: msg });
  }
});

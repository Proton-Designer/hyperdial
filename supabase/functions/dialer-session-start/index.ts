import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { startSession } from '../_shared/dialer-engine.ts';

/**
 * Starts a rolling-refill dial session for a campaign (TASK-P2-E2). Rewritten from the
 * legacy Redis/dialer_sessions engine to the org-scoped dial_sessions/call_legs schema --
 * see _shared/dialer-engine.ts's header for the full design.
 *
 * Behavior change from the legacy function: no `fromNumber`/`agentCallControlId`/
 * `agentCallbackNumber` request fields anymore. The caller ID now comes from the
 * campaign's own `caller_id_number_id` (added TASK-P2-P1) -- a campaign, not a per-session
 * choice -- and there is no agent leg yet at all (E3 builds the real WebRTC agent leg;
 * until then DIALER_DEV_SKIP_AGENT_GATE=true is required server-side for dialing to
 * actually start, since refillCount refuses to dial without an answered agent leg).
 */

interface StartBody {
  campaignId?: string;
  /** Overrides the campaign's own default `lines` (1-7) for this session only. */
  lines?: number;
  /** Overrides the campaign's own default `amd_mode` for this session only. */
  amdMode?: 'off' | 'on';
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
    error: authError,
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent']);
  if (authError) return authError;

  try {
    const body = (await req.json()) as StartBody;
    const campaignId = body.campaignId?.trim();
    if (!campaignId) return jsonResponse(400, { error: 'campaignId is required' });

    const linesOverride =
      body.lines !== undefined ? Math.max(1, Math.min(7, Math.trunc(body.lines))) : undefined;
    const amdModeOverride =
      body.amdMode === 'on' || body.amdMode === 'off' ? body.amdMode : undefined;

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
    if (!campaign.caller_id_number_id) {
      return jsonResponse(400, {
        error:
          'This campaign has no caller ID number set. Choose one in the campaign settings first.',
        code: 'MISSING_CALLER_ID',
      });
    }

    const { data: existing, error: existingError } = await supabase
      .from('dial_sessions')
      .select('id')
      .eq('campaign_id', campaignId)
      .eq('agent_id', user.id)
      .in('state', [
        'ready_pending',
        'ready',
        'dialing',
        'connecting',
        'on_call',
        'wrap_up',
        'paused',
      ])
      .maybeSingle();
    if (existingError) return jsonResponse(500, { error: existingError.message });
    if (existing) {
      return jsonResponse(409, {
        error: 'An active dialer session already exists for this campaign.',
        code: 'ACTIVE_SESSION_EXISTS',
        existingSessionId: existing.id,
      });
    }

    const { sessionId } = await startSession(supabase, {
      orgId,
      campaignId,
      agentId: user.id,
      lines: linesOverride ?? (campaign.lines as number),
      amdMode: amdModeOverride ?? (campaign.amd_mode as 'off' | 'on'),
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
    console.error('dialer-session-start error:', err);
    return jsonResponse(500, { error: msg });
  }
});

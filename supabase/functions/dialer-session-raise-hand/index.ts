import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { readJsonBody } from '../_shared/http-json.ts';

/**
 * MISSION-5 TASK-M5-B2: the agent's own "raise hand" button (Dialer.tsx, hotkey R) -- flags
 * `dial_sessions.raised_hand_at` (read by `team_live_board`, the live-board flag) and notifies
 * every active owner/admin, same `notifications`-table shape
 * `notifyOwnersAndAdminsOfDailyCap` (dialer-engine.ts) already uses. Deliberately NOT routed
 * through `transition_session` -- raising/clearing a hand never changes `dial_sessions.state`,
 * and that function's own field list is for state-transition fields, not orthogonal metadata
 * (see the migration's own column comment on `raised_hand_at`).
 *
 * Auto-clear is NOT this endpoint's job: `transition_session` clears it the instant the call
 * ends (on_call -> anything else) and `runStartCoachingAction` clears it the instant a manager
 * actually starts coaching this target -- both at their own single choke points. This endpoint
 * only ever WRITES `now()` (raise) or lets the agent explicitly clear it early (their own
 * "never mind" case, e.g. the issue resolved itself).
 */

interface RaiseHandBody {
  sessionId?: string;
  /** true = raise (default), false = the agent's own explicit clear. */
  raised?: boolean;
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function notifyOwnersAndAdminsOfRaisedHand(
  supabase: SupabaseClient,
  orgId: string,
  agentId: string,
  targetSessionId: string
): Promise<void> {
  const { data: members, error } = await supabase
    .from('org_members')
    .select('user_id')
    .eq('org_id', orgId)
    .eq('status', 'active')
    .in('role', ['owner', 'admin']);
  if (error || !members?.length) return;

  const { data: profile } = await supabase
    .from('profiles')
    .select('first_name, last_name')
    .eq('user_id', agentId)
    .maybeSingle();
  const agentName =
    [profile?.first_name, profile?.last_name].filter(Boolean).join(' ').trim() || 'An agent';

  await supabase.from('notifications').insert(
    (members as { user_id: string }[]).map((m) => ({
      org_id: orgId,
      user_id: m.user_id,
      type: 'agent_raised_hand',
      title: `${agentName} raised their hand`,
      body: `${agentName} could use help on their current call. Open Team to listen in.`,
      data: { targetUserId: agentId, targetSessionId, action: 'listen' },
    }))
  );
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

  const { body, errorResponse } = await readJsonBody<RaiseHandBody>(req);
  if (errorResponse) return errorResponse;

  try {
    const sessionId = body.sessionId?.trim();
    if (!sessionId) return jsonResponse(400, { error: 'sessionId is required' });
    const raised = body.raised !== false;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: session, error: sessionError } = await supabase
      .from('dial_sessions')
      .select('id, org_id, agent_id')
      .eq('id', sessionId)
      .maybeSingle();
    if (sessionError) return jsonResponse(500, { error: sessionError.message });
    if (!session || session.org_id !== orgId)
      return jsonResponse(404, { error: 'Session not found' });
    // Raise-hand is always self-service -- there is no "raise someone else's hand" use case,
    // unlike pause/stop/hangup-live, which an owner/admin may act on remotely.
    if (session.agent_id !== user.id) {
      return jsonResponse(403, { error: 'Not your session' });
    }

    const { error: updateError } = await supabase
      .from('dial_sessions')
      .update({ raised_hand_at: raised ? new Date().toISOString() : null })
      .eq('id', sessionId);
    if (updateError) return jsonResponse(500, { error: updateError.message });

    if (raised) {
      await notifyOwnersAndAdminsOfRaisedHand(supabase, orgId, session.agent_id, sessionId);
    }

    return jsonResponse(200, { raisedHand: raised });
  } catch (err) {
    console.error('dialer-session-raise-hand error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});

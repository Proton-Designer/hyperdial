import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { refillSession } from '../_shared/dialer-engine.ts';
import { readJsonBody } from '../_shared/http-json.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { isSessionTakenOver, isLegTakenOverByManager } from '../_shared/coaching-core.ts';

/**
 * Submits a wrap-up disposition for a call leg (TASK-P3-E1, design §5). The mandatory wrap-up
 * form itself lives in apps/web/src/components/dialer/** (eng2/E4's territory, not built yet) --
 * this is the backend endpoint it will call. Same "ownership check in TS, then a service-role
 * RPC does the atomic write" shape as dialer-session-hangup-live: this function resolves the
 * leg's session and checks the caller is that session's own agent (or admin+) BEFORE calling
 * `submit_disposition`, which re-checks the same thing itself as defense in depth.
 *
 * MISSION-5 TASK-M5-N1 (call takeover): `manager` is now also let through the role gate, but ONLY
 * for a leg they personally took over (a `coaching_sessions` row with `manager_id = caller` and
 * `taken_over_at is not null` targeting this leg's session) -- NOT a general pod-scoped grant to
 * disposition any of their agents' other calls, which is out of scope for this task and would be
 * a real authorization widening nobody asked for. `submit_disposition`'s own SQL re-check needs no
 * change: it only restricts `role = 'agent'`, so a manager caller already passes it once the TS
 * layer lets them through -- and its own trailing `transition_session(..., ['wrap_up'], ...)` call
 * is a harmless no-op CAS-miss for a takeover leg's session, which is never in `wrap_up` (it went
 * straight from `on_call` to `paused` at takeover time, per that task's own "skip wrap-up"
 * instruction) -- confirmed by reading the RPC body, not assumed.
 *
 * `submit_disposition` (the SQL RPC) does everything transactional: writes the leg's disposition
 * fields, applies the lead effect (including DNC propagation across every campaign_leads row for
 * the contact), enqueues the GHL push job, and moves the session wrap_up -> dialing. Only the
 * refill itself needs this Deno process: `refillSession` is TS, exported from
 * _shared/dialer-engine.ts (eng2's file -- called, never edited, per the lead's standing
 * constraint on this task). Calling it unconditionally after a successful submit is safe --
 * refillSession itself no-ops unless the session is actually 'dialing'.
 */

interface SubmitDispositionBody {
  legId?: string;
  dispositionKey?: string;
  notes?: string;
  callbackAt?: string;
  /** TASK-F-P1 (DSP-1/DSP-4): only actually required server-side when the chosen disposition's
   *  `required_fields` names them -- submit_disposition itself validates that, not this layer. */
  licenseNumber?: string;
  zips?: string[];
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
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent', 'manager']);
  if (authError) return authError;

  const { body, errorResponse } = await readJsonBody<SubmitDispositionBody>(req);
  if (errorResponse) return errorResponse;

  try {
    const legId = body.legId?.trim();
    const dispositionKey = body.dispositionKey?.trim();
    if (!legId || !dispositionKey) {
      return jsonResponse(400, { error: 'legId and dispositionKey are required' });
    }
    const notes = body.notes?.trim() || null;
    let callbackAt: string | null = null;
    if (body.callbackAt) {
      const parsed = new Date(body.callbackAt);
      if (Number.isNaN(parsed.getTime())) {
        return jsonResponse(400, { error: 'callbackAt is not a valid date' });
      }
      callbackAt = parsed.toISOString();
    }
    const licenseNumber = body.licenseNumber?.trim() || null;
    const zips =
      Array.isArray(body.zips) && body.zips.length > 0
        ? body.zips.map((z) => z.trim()).filter(Boolean)
        : null;

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    );

    const { data: leg, error: legError } = await supabase
      .from('call_legs')
      .select('id, org_id, session_id')
      .eq('id', legId)
      .maybeSingle();
    if (legError) return jsonResponse(500, { error: legError.message });
    if (!leg || leg.org_id !== orgId) return jsonResponse(404, { error: 'Call leg not found' });

    const { data: session, error: sessionError } = await supabase
      .from('dial_sessions')
      .select('id, org_id, agent_id')
      .eq('id', leg.session_id)
      .maybeSingle();
    if (sessionError) return jsonResponse(500, { error: sessionError.message });
    if (!session || session.org_id !== orgId) {
      return jsonResponse(404, { error: 'Dial session not found for this leg' });
    }
    if (role === 'agent') {
      if (session.agent_id !== user.id) {
        return jsonResponse(403, { error: 'Not your session' });
      }
      // MISSION-5 TASK-M5-N1 review fix-forward (SHOULD), LEG-scoped as of fix-forward #2 (the
      // lead's own BLOCKER): once a supervisor has taken THIS LEG over, the original agent is no
      // longer on it at all -- excluded from dispositioning it too. Without this, whichever of
      // the agent/supervisor submits first silently wins a race neither party is told about
      // (submit_disposition's own idempotency guard prevents a double-write, but not a
      // wrong-guess-wins outcome). Scoped to `legId`, not just `session.id` -- otherwise a
      // takeover on one leg would wrongly block the agent from dispositioning every LATER leg of
      // the same session too, once they've successfully Rejoined and gone back to dialing.
      if (await isSessionTakenOver(supabase, session.id, legId)) {
        return jsonResponse(403, {
          error: 'This call was taken over by a supervisor -- they submit its disposition.',
          code: 'TAKEN_OVER',
        });
      }
    }
    if (role === 'manager') {
      // MISSION-5 TASK-M5-N1: a manager may disposition this leg ONLY if they personally took
      // over the call it belongs to -- not a general pod-scope grant (see this file's own header
      // comment). LEG-scoped as of fix-forward #2 (the lead's own BLOCKER): `isLegTakenOverByManager`
      // matches on `taken_over_leg_id`, not just `target_session_id` -- otherwise a manager who
      // took over one call would wrongly be able to disposition every LATER leg of the same
      // session too, after the agent's successful Rejoin. Extracted into coaching-core.ts (see
      // its own header) so this exact check is exercised by deno tests, not just code review.
      if (!(await isLegTakenOverByManager(supabase, session.id, legId, user.id))) {
        return jsonResponse(403, { error: 'Not your session' });
      }
    }

    const { data, error: rpcError } = await supabase
      .rpc('submit_disposition', {
        p_leg: legId,
        p_org: orgId,
        p_caller_user_id: user.id,
        p_disposition: dispositionKey,
        p_notes: notes,
        p_callback_at: callbackAt,
        p_license_number: licenseNumber,
        p_zips: zips,
      })
      .single();
    if (rpcError) {
      return jsonResponse(400, { error: rpcError.message });
    }

    const sessionId = (data as { session_id: string }).session_id;
    const alreadySubmitted = (data as { already_submitted: boolean }).already_submitted;
    // MISSION-5 TASK-M5-B2: true only when a manager's earlier "end session" request (deferred
    // because a live call was in progress -- dialer-session-stop's own `defer:true`) actually
    // took effect just now, at THIS disposition submission. Audit-logged here, not inside
    // submit_disposition itself, because the SQL side has no Edge-Function-side logOrgAction to
    // call -- same split every other cross-boundary audit event in this codebase already uses.
    const remoteStopApplied = (data as { remote_stop_applied: boolean }).remote_stop_applied;
    const remoteStopRequestedBy = (data as { remote_stop_requested_by: string | null })
      .remote_stop_requested_by;

    const { dialed } = await refillSession(supabase, orgId, sessionId);

    if (remoteStopApplied && remoteStopRequestedBy) {
      await logOrgAction(supabase, {
        orgId,
        actorUserId: remoteStopRequestedBy,
        action: 'session.remote_end',
        targetType: 'dial_session',
        targetId: sessionId,
        details: { agentId: session.agent_id, deferred: true, reason: 'deferred_until_call_ended' },
      });
    }

    return jsonResponse(200, { ok: true, sessionId, alreadySubmitted, dialed });
  } catch (err) {
    console.error('dialer-session-disposition error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { pauseRecording, resumeRecording } from '../_shared/dialer-engine.ts';
import { readJsonBody } from '../_shared/http-json.ts';

interface RecordingActionBody {
  sessionId?: string;
  action?: 'pause' | 'resume';
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/** MISSION-4 TASK-T8: pauses/resumes the currently-recording winner leg's recording for a live
 *  session -- the intern-facing "Pause/Resume recording" button during a call. Same
 *  "commands only, state changes recorded synchronously" shape as `dialer-session-hangup-live`
 *  (no webhook is associated with either Telnyx command, per spec3.json). */
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

  const { body, errorResponse } = await readJsonBody<RecordingActionBody>(req);
  if (errorResponse) return errorResponse;

  const sessionId = body.sessionId?.trim();
  if (!sessionId) return jsonResponse(400, { error: 'sessionId is required' });
  if (body.action !== 'pause' && body.action !== 'resume') {
    return jsonResponse(400, { error: 'action must be "pause" or "resume"' });
  }

  try {
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
    if (!session || session.org_id !== orgId) {
      return jsonResponse(404, { error: 'Session not found' });
    }
    if (role === 'agent' && session.agent_id !== user.id) {
      return jsonResponse(403, { error: 'Not your session' });
    }

    const ok =
      body.action === 'pause'
        ? await pauseRecording(supabase, orgId, sessionId)
        : await resumeRecording(supabase, orgId, sessionId);
    if (!ok) {
      return jsonResponse(400, {
        error:
          body.action === 'pause'
            ? 'No active recording to pause'
            : 'No paused recording to resume',
      });
    }

    return jsonResponse(200, { ok: true });
  } catch (err) {
    console.error('dialer-session-recording error:', err);
    return jsonResponse(500, { error: String(err) });
  }
});

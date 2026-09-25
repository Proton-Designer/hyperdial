/**
 * REC-4 (TASK-F-T2): mints a short-lived signed URL for a call leg's recording. This is the
 * ONLY read path for the private `recordings` Storage bucket -- no direct client access exists
 * (no storage.objects policy grants one, see 20260925040000_call_recording.sql's header), so a
 * signed URL from this function, service-role, with its own explicit auth check below, is the
 * sole way a recording ever reaches a browser.
 *
 * Auth (mirrors call_legs' own RLS exactly, 20260924000700_dialer_schema.sql): owner/admin see
 * any leg in the org; an agent only a leg whose session is their own. Anything else (wrong org,
 * no recording yet, unknown leg) is a plain 404 -- never a 403 that would confirm a leg id
 * exists in another org.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireTelnyxOrgRole } from '../_shared/telnyx-org-context.ts';
import { readJsonBody } from '../_shared/http-json.ts';
import { canAccessRecording } from '../_shared/recording-core.ts';

// 10 minutes, matching the task's own spec and Telnyx's own recording_urls TTL (so the app
// link's own signed URL feels consistent with the source, even though they're unrelated URLs).
const SIGNED_URL_TTL_SECONDS = 600;

interface RecordingUrlBody {
  callLegId?: string;
}

function jsonResponse(status: number, payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  const {
    user,
    orgId,
    role,
    error: authError,
  } = await requireTelnyxOrgRole(req, ['owner', 'admin', 'agent']);
  if (authError) return authError;

  const { body, errorResponse } = await readJsonBody<RecordingUrlBody>(req);
  if (errorResponse) return errorResponse;

  const callLegId = body.callLegId?.trim();
  if (!callLegId) return jsonResponse(400, { error: 'callLegId is required' });

  const supabase = getSupabaseAdmin();

  const { data: leg, error: legError } = await supabase
    .from('call_legs')
    .select('id, org_id, session_id, recording_path, recording_status')
    .eq('id', callLegId)
    .maybeSingle();
  if (legError) return jsonResponse(500, { error: legError.message });
  if (!leg) return jsonResponse(404, { error: 'Recording not found' });

  const { data: session, error: sessionError } = await supabase
    .from('dial_sessions')
    .select('agent_id')
    .eq('id', leg.session_id)
    .maybeSingle();
  if (sessionError) return jsonResponse(500, { error: sessionError.message });

  const allowed = canAccessRecording({
    role,
    callerUserId: user.id,
    legOrgId: leg.org_id,
    callerOrgId: orgId,
    sessionAgentId: session?.agent_id ?? null,
  });
  if (!allowed) return jsonResponse(404, { error: 'Recording not found' });

  if (!leg.recording_path) {
    // Covers both "never recorded" and "still processing" (call.recording.saved hasn't landed
    // yet) -- same 404, since the caller (WrapUpModal) treats "not there yet" and "never will
    // be" identically: keep polling lightly, don't block on it.
    return jsonResponse(404, { error: 'Recording not available yet' });
  }

  const { data: signed, error: signError } = await supabase.storage
    .from('recordings')
    .createSignedUrl(leg.recording_path, SIGNED_URL_TTL_SECONDS);
  if (signError || !signed?.signedUrl) {
    console.error('[recording-url] createSignedUrl failed', signError?.message);
    return jsonResponse(500, { error: 'Failed to create signed URL' });
  }

  return jsonResponse(200, { url: signed.signedUrl, expiresInSeconds: SIGNED_URL_TTL_SECONDS });
});

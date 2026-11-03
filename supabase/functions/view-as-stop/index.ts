/**
 * TASK-H21: POST {} with the VIEW-AS token ends that session (Exit). POST { sessionId } with the viewer's own normal token ends
 * one of the viewer's sessions from another tab. Idempotent. Deletes the GoTrue session, marks view_as_sessions, audits
 * view_as.stop. Response: { ended: true, alreadyEnded: boolean } -- apps/web/src/lib/api.ts stopViewAs.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { jwtSessionId, lookupViewAsSession } from '../_shared/view-as-guard.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const { user, error: authError } = await getUserFromRequest(req);
  if (authError) return authError;

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    {
      auth: { persistSession: false, autoRefreshToken: false },
    }
  );

  let body: { sessionId?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const ownSession = jwtSessionId((req.headers.get('Authorization') ?? '').replace('Bearer ', ''));
  let sessionId: string | null = null;
  if (ownSession) {
    const own = await lookupViewAsSession(admin, ownSession).catch(() => null);
    if (own) sessionId = ownSession; // the caller IS the view-as session: it can only end itself
  }
  if (!sessionId) {
    const asked = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!UUID_RE.test(asked)) return json({ error: 'sessionId is required' }, 400);
    const { data: row, error } = await admin
      .from('view_as_sessions')
      .select('viewer_id')
      .eq('session_id', asked)
      .maybeSingle();
    if (error) return json({ error: 'Could not end the view' }, 500);
    // not yours (or not there): same answer, so a session id cannot be probed
    if (!row || row.viewer_id !== user.id) return json({ error: 'View session not found' }, 404);
    sessionId = asked;
  }

  const { data, error } = await admin.rpc('view_as_end', {
    p_session_id: sessionId,
    p_reason: 'exit',
  });
  if (error) {
    console.error('[view-as-stop] view_as_end failed', error.message);
    return json({ error: 'Could not end the view' }, 500);
  }
  const ended = (data ?? [])[0] as
    { org_id: string; viewer_id: string; target_id: string; was_open: boolean } | undefined;
  if (ended?.was_open) {
    await logOrgAction(admin, {
      orgId: ended.org_id,
      actorUserId: ended.viewer_id,
      action: 'view_as.stop',
      targetType: 'user',
      targetId: ended.target_id,
      details: { session_id: sessionId },
    });
  }
  return json({ ended: true, alreadyEnded: !ended?.was_open });
});

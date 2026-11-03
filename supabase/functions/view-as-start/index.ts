/**
 * TASK-H21: POST { targetUserId } -> a real, read-only GoTrue session for that agent. Owner/admin only. Target must be an ACTIVE
 * 'agent' of the caller's active org and a member of NO other org (a GoTrue token is global to the user). The session is
 * minted with admin.generateLink (no email is sent) + verifyOtp; its session_id is recorded in view_as_sessions BEFORE the
 * tokens leave this function, so the guard (_shared/view-as-guard.ts) and db_pre_request already know it. Audited as
 * view_as.start. Fails closed: any step after the mint that fails revokes the session.
 * Response: { accessToken, refreshToken, expiresAt, sessionId, orgId, target: { userId, name } } -- apps/web/src/lib/api.ts startViewAs.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { jwtSessionId } from '../_shared/view-as-guard.ts';
import { checkViewAsTarget, type TargetMembership } from '../_shared/view-as-core.ts';

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

  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let body: { targetUserId?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }
  const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId.trim() : '';
  if (!UUID_RE.test(targetUserId)) return json({ error: 'targetUserId is required' }, 400);

  const url = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: memberships, error: mErr } = await admin
    .from('org_members')
    .select('org_id, role, status')
    .eq('user_id', targetUserId);
  if (mErr) {
    console.error('[view-as-start] membership lookup failed', mErr.message);
    return json({ error: 'Could not check that account' }, 500);
  }
  const verdict = checkViewAsTarget({
    viewerId: user.id,
    targetId: targetUserId,
    orgId,
    memberships: (memberships ?? []) as TargetMembership[],
  });
  if (!verdict.ok) return json({ error: verdict.message, code: verdict.code }, verdict.status);

  // Sessions a closed tab left open for this same pair.
  const { data: stale } = await admin.rpc('view_as_close_stale', {
    p_viewer: user.id,
    p_target: targetUserId,
  });
  for (const s of (stale ?? []) as Array<{ session_id: string; org_id: string }>) {
    await logOrgAction(admin, {
      orgId: s.org_id,
      actorUserId: user.id,
      action: 'view_as.ended_stale',
      targetType: 'user',
      targetId: targetUserId,
      details: { session_id: s.session_id },
    });
  }

  const { data: target, error: uErr } = await admin.auth.admin.getUserById(targetUserId);
  const email = target?.user?.email;
  if (uErr || !email) return json({ error: 'That account has no email to sign in with' }, 422);

  const { data: link, error: lErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  const tokenHash = link?.properties?.hashed_token;
  if (lErr || !tokenHash) {
    console.error('[view-as-start] generateLink failed', lErr?.message);
    return json({ error: 'Could not open a view for that account' }, 502);
  }

  const anon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: verified, error: vErr } = await anon.auth.verifyOtp({
    token_hash: tokenHash,
    type: 'magiclink',
  });
  const session = verified?.session;
  const sessionId = session ? jwtSessionId(session.access_token) : null;
  if (vErr || !session || !sessionId) {
    console.error('[view-as-start] verifyOtp failed', vErr?.message);
    // a session may exist without a readable id: nothing registered, so end nothing we cannot name
    return json({ error: 'Could not open a view for that account' }, 502);
  }

  // From here the session exists: any failure must end it.
  const revoke = async () => {
    await admin.rpc('view_as_end', { p_session_id: sessionId, p_reason: 'start_failed' });
    // no registry row (the insert itself failed): view_as_end found nothing, so delete the GoTrue session directly
    await admin.auth.admin.signOut(session.access_token, 'local').catch(() => {});
  };

  const { error: insErr } = await admin.from('view_as_sessions').insert({
    session_id: sessionId,
    org_id: orgId,
    viewer_id: user.id,
    target_id: targetUserId,
  });
  if (insErr) {
    console.error('[view-as-start] registry insert failed', insErr.message);
    await revoke();
    return json({ error: 'Could not open a view for that account' }, 500);
  }

  const { error: auditErr } = await admin.from('org_audit_log').insert({
    org_id: orgId,
    actor_user_id: user.id,
    action: 'view_as.start',
    target_type: 'user',
    target_id: targetUserId,
    details: { session_id: sessionId },
  });
  if (auditErr) {
    console.error('[view-as-start] audit insert failed', auditErr.message);
    await revoke();
    return json({ error: 'Could not record the view. Nothing was opened.' }, 500);
  }

  const { data: profile } = await admin
    .from('profiles')
    .select('first_name, last_name')
    .eq('user_id', targetUserId)
    .maybeSingle();
  const name = `${profile?.first_name ?? ''} ${profile?.last_name ?? ''}`.trim() || email;

  return json({
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    expiresAt: session.expires_at ?? null,
    sessionId,
    orgId,
    target: { userId: targetUserId, name },
  });
});

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';
import {
  deriveInvitePreview,
  checkInviteAcceptable,
  resolveMembershipConflict,
} from '../_shared/invite-core.ts';

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

interface InviteRow {
  id: string;
  org_id: string;
  email: string;
  role: 'owner' | 'admin' | 'agent';
  expires_at: string;
  accepted_at: string | null;
  revoked_at?: string | null;
  campaign_ids?: string[];
  orgs: { name: string } | { name: string }[] | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (req.method === 'GET') {
    // Unauthenticated preview: the invite landing page needs to show "you've been invited to
    // <org> as <role>" before the visitor has signed up or signed in at all. Reveals only what
    // the token itself already implies possession of -- never the token, another invite, or
    // anything about the org beyond its name.
    const url = new URL(req.url);
    const token = url.searchParams.get('token')?.trim();
    if (!token) return jsonError(400, 'Missing token');
    const tokenHash = await hashToken(token);

    const { data: invite } = await supabase
      .from('org_invites')
      .select('email, role, expires_at, accepted_at, revoked_at, orgs(name)')
      .eq('token_hash', tokenHash)
      .maybeSingle<InviteRow>();

    if (!invite) {
      return new Response(JSON.stringify({ valid: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const { valid, reason } = deriveInvitePreview(invite);
    const orgName = Array.isArray(invite.orgs) ? invite.orgs[0]?.name : invite.orgs?.name;
    return new Response(
      JSON.stringify({
        valid,
        email: invite.email,
        role: invite.role,
        orgName: orgName ?? null,
        reason,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  // Accepting requires a real signed-in session -- either an existing user (already had an
  // account, signing in) or a brand-new one who just signed up with this token in
  // raw_user_meta_data.invite_token (the on_auth_user_created trigger contract from
  // TASK-P1-01: that path creates only a profile, no org/membership -- this endpoint does the
  // rest). Not requireOrgRole: the caller has no org yet, that's the whole point.
  const { user, error: authError } = await getUserFromRequest(req);
  if (authError) return authError;

  let body: { token?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }
  const token = body.token?.trim();
  if (!token) return jsonError(400, 'Missing token');
  const tokenHash = await hashToken(token);

  const { data: invite, error: fetchError } = await supabase
    .from('org_invites')
    .select('id, org_id, email, role, expires_at, accepted_at, revoked_at, campaign_ids')
    .eq('token_hash', tokenHash)
    .maybeSingle<InviteRow>();
  if (fetchError) {
    console.error('org-invite-accept fetch error:', fetchError.message);
    return jsonError(500, 'Failed to look up invite');
  }
  if (!invite) return jsonError(404, 'Invite not found');
  const rejectReason = checkInviteAcceptable(invite);
  if (rejectReason) return jsonError(400, rejectReason);
  // The accepting account's email must match the invited email -- otherwise a forwarded invite
  // link would let anyone who intercepts it join under their own identity instead of the
  // invited one. Case-insensitive: email addresses are conventionally compared that way and
  // Supabase Auth itself lowercases on signup.
  const accountEmail = (user as { email?: string }).email?.trim().toLowerCase();
  if (!accountEmail || accountEmail !== invite.email.toLowerCase()) {
    return jsonError(403, 'This invite was sent to a different email address');
  }

  const { error: memberError } = await supabase
    .from('org_members')
    .insert({ org_id: invite.org_id, user_id: user.id, role: invite.role, status: 'active' })
    .select()
    .single();
  if (memberError) {
    // 23505 (PK violation on (org_id, user_id)) means an org_members row for this user ALREADY
    // exists -- the old code treated this as unconditionally idempotent, but a soft-removed or
    // disabled member's row still occupies that PK forever (A3's soft-remove design), so the OLD
    // status (fix-A3, eng2 review BLOCKER 2) silently stuck around while this endpoint reported
    // success: the invitee got a 200, the invite was marked accepted, profiles.active_org_id was
    // pointed at this org -- but requireOrgRole's own `status = 'active'` filter 401/403'd their
    // very next request, with no error anywhere telling anyone what happened.
    if (memberError.code !== '23505') {
      console.error('org-invite-accept membership insert error:', memberError.message);
      return jsonError(500, 'Failed to add org membership');
    }

    const { data: existing, error: existingError } = await supabase
      .from('org_members')
      .select('status')
      .eq('org_id', invite.org_id)
      .eq('user_id', user.id)
      .maybeSingle<{ status: 'active' | 'disabled' | 'removed' }>();
    if (existingError || !existing) {
      console.error(
        'org-invite-accept: could not look up existing membership after 23505:',
        existingError?.message
      );
      return jsonError(500, 'Failed to add org membership');
    }

    // The actual decision (reject / reactivate / no-op) is pure logic, tested directly
    // (invite-core.test.ts) since this index.ts has no test file of its own.
    const resolution = resolveMembershipConflict(existing.status, invite.role);

    if (resolution.action === 'reject_disabled') {
      // A DISABLED member is a live, deliberate admin decision -- accepting a new invite link
      // must not be a silent way to bypass it. `enable` (org-members/index.ts) is the one
      // intended path back; this invite stays unaccepted (accepted_at is set further below,
      // never reached here) so the SAME link still works once an admin re-enables them.
      return jsonError(
        403,
        'Your account was disabled in this organization. Ask an owner or admin to re-enable you before accepting a new invite.'
      );
    }

    if (resolution.action === 'reactivate') {
      // 'removed' -- BLOCKER 1's own fix (org_member_emails now excludes 'removed' from
      // already_member) makes them re-invitable again once Restore's 72h window has lapsed;
      // accepting that fresh invite is the intended second path back in. Reactivate with the
      // INVITE's own role (an owner may deliberately bring a returning agent back as a different
      // role), symmetric with the explicit `restore` action in org-members/index.ts, and
      // audit-logged the same way every other membership-status change already is.
      const { error: reactivateError } = await supabase
        .from('org_members')
        .update({ status: 'active', role: resolution.role, removed_at: null })
        .eq('org_id', invite.org_id)
        .eq('user_id', user.id);
      if (reactivateError) {
        console.error('org-invite-accept reactivate error:', reactivateError.message);
        return jsonError(500, 'Failed to add org membership');
      }
      await logOrgAction(supabase, {
        orgId: invite.org_id,
        actorUserId: user.id,
        action: 'member.reactivate_via_invite',
        targetType: 'org_member',
        targetId: user.id,
        details: { previousStatus: existing.status, role: resolution.role },
      });
    }
    // resolution.action === 'noop' -- a genuinely idempotent retry (e.g. a double-submitted
    // request); nothing further to do, same as the old behavior.
  }

  const { error: profileError } = await supabase
    .from('profiles')
    .update({ active_org_id: invite.org_id, updated_at: new Date().toISOString() })
    .eq('user_id', user.id);
  if (profileError) {
    console.error('org-invite-accept profile update error:', profileError.message);
    return jsonError(500, 'Failed to activate org membership');
  }

  await supabase
    .from('org_invites')
    .update({ accepted_at: new Date().toISOString() })
    .eq('id', invite.id);

  // TASK-A2: auto-join campaigns picked at invite time. Best-effort per campaign, not
  // all-or-nothing -- membership itself (above) has already succeeded and must not be undone by
  // a single bad campaign id slipping through (validCampaignIds already checks this at CREATE
  // time, so this is a defense-in-depth backstop, not the primary guard). The pre-existing
  // check_campaign_agent_org trigger (20260924000200) still rejects a cross-org id regardless.
  const campaignIds = invite.campaign_ids ?? [];
  if (campaignIds.length > 0) {
    const { error: campaignAgentsError } = await supabase.from('campaign_agents').insert(
      campaignIds.map((campaignId) => ({
        campaign_id: campaignId,
        user_id: user.id,
        org_id: invite.org_id,
      }))
    );
    if (campaignAgentsError) {
      console.error('org-invite-accept campaign_agents insert error:', campaignAgentsError.message);
    }
  }

  await logOrgAction(supabase, {
    orgId: invite.org_id,
    actorUserId: user.id,
    action: 'invite.accept',
    targetType: 'org_invite',
    targetId: invite.id,
    details: { role: invite.role, campaignIds },
  });

  return new Response(JSON.stringify({ orgId: invite.org_id, role: invite.role }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

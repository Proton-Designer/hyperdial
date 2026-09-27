import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { deriveInvitePreview, checkInviteAcceptable } from '../_shared/invite-core.ts';

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
    // Most likely already a member (PK violation) -- treat as idempotent rather than fail the
    // whole accept, since the invite may have been double-submitted (e.g. a retried request).
    if (memberError.code !== '23505') {
      console.error('org-invite-accept membership insert error:', memberError.message);
      return jsonError(500, 'Failed to add org membership');
    }
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

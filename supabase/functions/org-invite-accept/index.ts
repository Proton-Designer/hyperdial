import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { getUserFromRequest } from '../_shared/auth.ts';

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
      .select('email, role, expires_at, accepted_at, orgs(name)')
      .eq('token_hash', tokenHash)
      .maybeSingle<InviteRow>();

    if (!invite) {
      return new Response(JSON.stringify({ valid: false }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const expired = new Date(invite.expires_at).getTime() < Date.now();
    const valid = !invite.accepted_at && !expired;
    const orgName = Array.isArray(invite.orgs) ? invite.orgs[0]?.name : invite.orgs?.name;
    return new Response(
      JSON.stringify({
        valid,
        email: invite.email,
        role: invite.role,
        orgName: orgName ?? null,
        reason: invite.accepted_at ? 'accepted' : expired ? 'expired' : null,
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
    .select('id, org_id, email, role, expires_at, accepted_at')
    .eq('token_hash', tokenHash)
    .maybeSingle<InviteRow>();
  if (fetchError) {
    console.error('org-invite-accept fetch error:', fetchError.message);
    return jsonError(500, 'Failed to look up invite');
  }
  if (!invite) return jsonError(404, 'Invite not found');
  if (invite.accepted_at) return jsonError(400, 'This invite has already been used');
  if (new Date(invite.expires_at).getTime() < Date.now()) {
    return jsonError(400, 'This invite has expired');
  }
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

  return new Response(JSON.stringify({ orgId: invite.org_id, role: invite.role }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

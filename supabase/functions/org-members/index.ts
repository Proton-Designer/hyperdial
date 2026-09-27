import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole, type OrgRole } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface MemberRow {
  user_id: string;
  role: OrgRole;
  status: 'active' | 'disabled';
  created_at: string;
  ghl_user_id: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (req.method === 'GET') {
    // Design §2: any org member can see the roster (matches org_members' own SELECT RLS --
    // "org members can view roster", not role-gated).
    const { orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin', 'agent']);
    if (authError) return authError;

    const { data: members, error } = await supabase
      .from('org_members')
      .select('user_id, role, status, created_at, ghl_user_id')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true });
    if (error) {
      console.error('org-members list error:', error.message);
      return jsonError(500, 'Failed to list members');
    }

    const { data: profiles } = await supabase
      .from('profiles')
      .select('user_id, first_name, last_name')
      .in(
        'user_id',
        (members ?? []).map((m: MemberRow) => m.user_id)
      );
    const profileMap = new Map(
      (profiles ?? []).map(
        (p: { user_id: string; first_name: string | null; last_name: string | null }) => [
          p.user_id,
          p,
        ]
      )
    );

    // auth.users isn't exposed via PostgREST -- the admin API is the only way to attach an
    // email to each roster row. Fine at the roster sizes Stage 1 teams run (a handful to a few
    // dozen); revisit with a single admin.listUsers() page-scan if that stops being true.
    const results = await Promise.all(
      (members ?? []).map(async (m: MemberRow) => {
        const profile = profileMap.get(m.user_id);
        let email: string | null = null;
        try {
          const { data } = await supabase.auth.admin.getUserById(m.user_id);
          email = data.user?.email ?? null;
        } catch (err) {
          console.error('org-members email lookup failed for', m.user_id, err);
        }
        return {
          user_id: m.user_id,
          role: m.role,
          status: m.status,
          created_at: m.created_at,
          first_name: profile?.first_name ?? null,
          last_name: profile?.last_name ?? null,
          email,
          ghl_user_id: m.ghl_user_id,
        };
      })
    );

    return new Response(JSON.stringify({ members: results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  // Design §2: "Invite/remove/change role of members" is owner/admin only.
  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let body: { action?: string; user_id?: string; role?: string; ghl_user_id?: string | null };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }
  const targetUserId = body.user_id?.trim();
  if (!targetUserId) return jsonError(400, 'Missing user_id');

  const { data: target, error: targetError } = await supabase
    .from('org_members')
    .select('role, status')
    .eq('org_id', orgId)
    .eq('user_id', targetUserId)
    .maybeSingle();
  if (targetError) {
    console.error('org-members target lookup error:', targetError.message);
    return jsonError(500, 'Failed to look up member');
  }
  if (!target) return jsonError(404, 'Member not found in this org');

  // The owner row is untouchable through this endpoint for role change/disable/remove -- matches
  // org_members' own RLS ("...and role <> 'owner'") and the invariant that ownership transfer is
  // a separate, not-yet-built owner-only path. MISSION-4 TASK-T1 (GHL-8)'s own set_ghl_user_id is
  // exempt: mapping the owner's own account to a GHL user id is ordinary per-member config, not a
  // role/access change.
  if (target.role === 'owner' && body.action !== 'set_ghl_user_id') {
    return jsonError(403, "The org owner can't be changed, disabled, or removed here");
  }

  switch (body.action) {
    case 'change_role': {
      if (body.role !== 'admin' && body.role !== 'agent') {
        return jsonError(400, "role must be 'admin' or 'agent'");
      }
      const { error } = await supabase
        .from('org_members')
        .update({ role: body.role })
        .eq('org_id', orgId)
        .eq('user_id', targetUserId);
      if (error) {
        console.error('org-members change_role error:', error.message);
        return jsonError(500, 'Failed to change role');
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.role_change',
        targetType: 'org_member',
        targetId: targetUserId,
        details: { from: target.role, to: body.role },
      });
      break;
    }
    case 'disable': {
      const { error } = await supabase
        .from('org_members')
        .update({ status: 'disabled' })
        .eq('org_id', orgId)
        .eq('user_id', targetUserId);
      if (error) {
        console.error('org-members disable error:', error.message);
        return jsonError(500, 'Failed to disable member');
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.disable',
        targetType: 'org_member',
        targetId: targetUserId,
        details: { role: target.role },
      });
      break;
    }
    case 'enable': {
      const { error } = await supabase
        .from('org_members')
        .update({ status: 'active' })
        .eq('org_id', orgId)
        .eq('user_id', targetUserId);
      if (error) {
        console.error('org-members enable error:', error.message);
        return jsonError(500, 'Failed to enable member');
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.enable',
        targetType: 'org_member',
        targetId: targetUserId,
        details: { role: target.role },
      });
      break;
    }
    case 'remove': {
      const { error } = await supabase
        .from('org_members')
        .delete()
        .eq('org_id', orgId)
        .eq('user_id', targetUserId);
      if (error) {
        console.error('org-members remove error:', error.message);
        return jsonError(500, 'Failed to remove member');
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.remove',
        targetType: 'org_member',
        targetId: targetUserId,
        details: { role: target.role },
      });
      break;
    }
    // MISSION-4 TASK-T1 (GHL-8): "the contact's assigned intern comes from GHL's assignedTo,
    // mapped via each member's GHL user id, which owner/admin can set per member." An empty/null
    // value clears the mapping (undoing a mistaken assignment); org_members_org_ghl_user_id_key
    // (20260926080000) is per-org and ignores nulls, so this only ever conflicts with ANOTHER
    // member of the SAME org already mapped to the same GHL user id.
    case 'set_ghl_user_id': {
      const raw = typeof body.ghl_user_id === 'string' ? body.ghl_user_id.trim() : null;
      const { error } = await supabase
        .from('org_members')
        .update({ ghl_user_id: raw || null })
        .eq('org_id', orgId)
        .eq('user_id', targetUserId);
      if (error) {
        console.error('org-members set_ghl_user_id error:', error.message);
        const status = error.code === '23505' ? 409 : 500;
        const message =
          error.code === '23505'
            ? 'Another member is already mapped to that GHL user id'
            : 'Failed to set the GHL user id';
        return jsonError(status, message);
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.set_ghl_user_id',
        targetType: 'org_member',
        targetId: targetUserId,
        details: { ghl_user_id: raw || null },
      });
      break;
    }
    default:
      return jsonError(
        400,
        "action must be one of 'change_role', 'disable', 'enable', 'remove', 'set_ghl_user_id'"
      );
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

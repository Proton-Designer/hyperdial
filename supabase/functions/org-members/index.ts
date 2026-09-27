import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole, type OrgRole } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { haltIntakeForOffboarding } from '../_shared/dialer-engine.ts';
import { endActiveCoachingSessionsForManager } from '../_shared/coaching-core.ts';
import { getConnectedOrgTelnyxContext } from '../_shared/telnyx-org-context.ts';

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

interface MemberRow {
  user_id: string;
  role: OrgRole;
  status: 'active' | 'disabled' | 'removed';
  created_at: string;
  ghl_user_id: string | null;
  removed_at: string | null;
  pod_id: string | null;
}

// MISSION-5 TASK-M5-A3: soft-removed members are only restorable for this long -- matches the
// column comment on org_members.removed_at (20260927080002). Enforced here, not in SQL: it's a
// plain UPDATE through the pre-existing RLS on this table, no new SQL needed for the check.
const RESTORE_WINDOW_MS = 72 * 60 * 60 * 1000;

/** MISSION-5 TASK-M5-A3: "only the owner can change, disable or remove ANOTHER admin" (self is a
 *  separate path below) + "nobody can demote/disable/remove the org down to zero active
 *  owner/admin" -- both checked against the CURRENT (pre-action) roster, excluding the target
 *  row itself, since the action under consideration is exactly what would remove its coverage. */
async function activeOwnerAdminCountExcluding(
  supabase: SupabaseClient,
  orgId: string,
  excludeUserId: string
): Promise<number> {
  const { count, error } = await supabase
    .from('org_members')
    .select('user_id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .eq('status', 'active')
    .in('role', ['owner', 'admin'])
    .neq('user_id', excludeUserId);
  if (error) throw new Error(`activeOwnerAdminCountExcluding: ${error.message}`);
  return count ?? 0;
}

/** Guards `change_role` (demote), `disable`, and `remove` against an admin target. Returns an
 *  error Response to send back, or null to proceed. `callerRole`/`callerUserId` are the ACTOR
 *  (already resolved by requireOrgRole), `target` is the row being acted on before the change. */
async function checkAdminGuard(
  supabase: SupabaseClient,
  orgId: string,
  callerRole: OrgRole,
  callerUserId: string,
  targetUserId: string,
  target: { role: OrgRole; status: string }
): Promise<Response | null> {
  if (target.role !== 'admin') return null; // only admin targets are guarded (owner is already
  // fully blocked earlier; demoting/disabling/removing a plain agent never affects the
  // owner/admin count).

  const isSelf = targetUserId === callerUserId;
  if (!isSelf && callerRole !== 'owner') {
    return jsonError(403, 'Only the org owner can change, disable, or remove another admin');
  }

  if (target.status === 'active') {
    const remaining = await activeOwnerAdminCountExcluding(supabase, orgId, targetUserId);
    if (remaining === 0) {
      return jsonError(
        409,
        "Can't leave the org with no active owner or admin -- promote someone else first"
      );
    }
  }
  return null;
}

/** MISSION-5 TASK-M5-A3: the disable/remove cascade. Halts new-batch dialing (a live call is
 *  allowed to finish -- see haltIntakeForOffboarding's own comment) and releases every number
 *  currently assigned to this member back to the pool (`assigned_user_id = null`, same meaning
 *  as an org admin manually unassigning one via the Number Pool UI). Best-effort on the session
 *  halt (logged, never blocks the member-row update) -- a stale or already-terminal session is
 *  not a reason to fail the actual disable/remove action the admin asked for. */
async function cascadeOffboard(
  supabase: SupabaseClient,
  orgId: string,
  targetUserId: string
): Promise<{ sessionHalted: boolean; numbersReleased: number; coachingEnded: number }> {
  let sessionHalted = false;
  try {
    const result = await haltIntakeForOffboarding(supabase, orgId, targetUserId);
    sessionHalted = result?.halted ?? false;
  } catch (err) {
    console.error('org-members cascadeOffboard: session halt failed', String(err));
  }

  const { data: releasedNumbers, error: releaseError } = await supabase
    .from('user_phone_numbers')
    .update({ assigned_user_id: null })
    .eq('org_id', orgId)
    .eq('assigned_user_id', targetUserId)
    .select('id');
  if (releaseError) {
    console.error('org-members cascadeOffboard: number release failed', releaseError.message);
  }

  // MISSION-5 TASK-M5-B2 (EC-8: "coaching ends cleanly if ... the coach is disabled/removed").
  // Best-effort, never blocks the actual disable/remove: a real Telnyx client is fetched only if
  // needed (getConnectedOrgTelnyxContext can itself fail for a disconnected org, which must not
  // fail this whole cascade -- the coaching row still gets marked ended either way, just without
  // a live hangup, same "our bookkeeping already reads ended regardless" shape
  // hangUpReapedCoachingSessions already established).
  let coachingEnded = 0;
  try {
    const telnyx = await getConnectedOrgTelnyxContext(supabase, orgId);
    coachingEnded = await endActiveCoachingSessionsForManager(
      supabase,
      telnyx.client,
      targetUserId,
      'coach_offboarded'
    );
  } catch (err) {
    console.error('org-members cascadeOffboard: coaching end failed', String(err));
  }

  return { sessionHalted, numbersReleased: releasedNumbers?.length ?? 0, coachingEnded };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  if (req.method === 'GET') {
    // Design §2: any org member can see the roster (matches org_members' own SELECT RLS --
    // "org members can view roster", not role-gated).
    const {
      orgId,
      role: callerRole,
      user: caller,
      error: authError,
    } = await requireOrgRole(req, ['owner', 'admin', 'agent', 'manager']);
    if (authError) return authError;

    // MISSION-5 TASK-M5-A3: "hidden from the roster by default" -- a removed member only shows
    // up when the caller explicitly asks for it (the Settings UI's "Show removed" toggle, which
    // is how an owner/admin gets to the Restore button within the 72h window).
    const showRemoved = new URL(req.url).searchParams.get('include_removed') === 'true';

    let query = supabase
      .from('org_members')
      .select('user_id, role, status, created_at, ghl_user_id, removed_at, pod_id')
      .eq('org_id', orgId)
      .order('created_at', { ascending: true });
    if (!showRemoved) {
      query = query.neq('status', 'removed');
    }
    let { data: members, error } = await query;
    if (error) {
      console.error('org-members list error:', error.message);
      return jsonError(500, 'Failed to list members');
    }

    // MISSION-5 TASK-M5-A5: a manager only sees the roster rows for agents in their own managed
    // pods (plus their own row) -- server-enforced here since this endpoint's response, not
    // org_members' table-level RLS, is what the roster UI actually reads.
    if (callerRole === 'manager') {
      const { data: podRows } = await supabase
        .from('org_manager_pods')
        .select('pod_id')
        .eq('org_id', orgId)
        .eq('manager_user_id', caller.id);
      const managerPodIds = new Set((podRows ?? []).map((r: { pod_id: string }) => r.pod_id));
      members = (members ?? []).filter(
        (m: MemberRow) => m.user_id === caller.id || (m.pod_id && managerPodIds.has(m.pod_id))
      );
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

    // TASK-A2 (closes TM-X1): one query for every member's email instead of one
    // auth.admin.getUserById GoTrue Admin API round trip PER member -- a 50-member roster used to
    // be 50 sequential calls. `org_member_emails` reads auth.users directly, scoped to this org,
    // via a SECURITY DEFINER function (`20260927080001_org_invites_v2.sql`).
    const { data: emailRows, error: emailError } = await supabase.rpc('org_member_emails', {
      p_org: orgId,
    });
    if (emailError) {
      console.error('org-members email lookup failed:', emailError.message);
    }
    const emailMap = new Map(
      ((emailRows ?? []) as { user_id: string; email: string | null }[]).map((r) => [
        r.user_id,
        r.email,
      ])
    );

    const results = (members ?? []).map((m: MemberRow) => {
      const profile = profileMap.get(m.user_id);
      return {
        user_id: m.user_id,
        role: m.role,
        status: m.status,
        created_at: m.created_at,
        first_name: profile?.first_name ?? null,
        last_name: profile?.last_name ?? null,
        email: emailMap.get(m.user_id) ?? null,
        ghl_user_id: m.ghl_user_id,
        pod_id: m.pod_id,
        removed_at: m.removed_at,
        restorable_until:
          m.status === 'removed' && m.removed_at
            ? new Date(new Date(m.removed_at).getTime() + RESTORE_WINDOW_MS).toISOString()
            : null,
      };
    });

    return new Response(JSON.stringify({ members: results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  // Design §2: "Invite/remove/change role of members" is owner/admin only.
  const {
    user,
    orgId,
    role: callerRole,
    error: authError,
  } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let body: {
    action?: string;
    user_id?: string;
    role?: string;
    ghl_user_id?: string | null;
    pod_id?: string | null;
    pod_ids?: string[];
  };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }
  const targetUserId = body.user_id?.trim();
  if (!targetUserId) return jsonError(400, 'Missing user_id');

  // MISSION-5 TASK-M5-A3: read-only, no target-row mutation guard needed -- what an offboarding
  // wizard shows before the admin commits to disable/remove. Leads/callbacks queried by
  // `assigned_agent_id` (however they got assigned: TASK-T6's slice assignment, or
  // submit_disposition's own callback-ownership write) is "what they hold" regardless of
  // mechanism.
  if (body.action === 'offboard_preview') {
    const [{ data: leadRows, error: leadErr }, { data: numberRows }, { data: campaignRows }] =
      await Promise.all([
        supabase
          .from('campaign_leads')
          .select('campaign_id, status, campaigns!inner(name, org_id)')
          .eq('assigned_agent_id', targetUserId)
          .eq('campaigns.org_id', orgId)
          .in('status', ['queued', 'callback']),
        supabase
          .from('user_phone_numbers')
          .select('id, phone_number')
          .eq('org_id', orgId)
          .eq('assigned_user_id', targetUserId),
        supabase
          .from('campaign_agents')
          .select('campaign_id, campaigns!inner(name, org_id)')
          .eq('user_id', targetUserId)
          .eq('campaigns.org_id', orgId),
      ]);
    if (leadErr) {
      console.error('org-members offboard_preview error:', leadErr.message);
      return jsonError(500, 'Failed to load offboard preview');
    }
    type LeadPreviewRow = {
      campaign_id: string;
      status: 'queued' | 'callback';
      campaigns: { name: string };
    };
    const byCampaign = new Map<
      string,
      { campaign_id: string; campaign_name: string; queued_leads: number; callbacks: number }
    >();
    for (const row of (leadRows ?? []) as unknown as LeadPreviewRow[]) {
      const entry = byCampaign.get(row.campaign_id) ?? {
        campaign_id: row.campaign_id,
        campaign_name: row.campaigns.name,
        queued_leads: 0,
        callbacks: 0,
      };
      if (row.status === 'queued') entry.queued_leads += 1;
      else entry.callbacks += 1;
      byCampaign.set(row.campaign_id, entry);
    }
    return new Response(
      JSON.stringify({
        held_leads: Array.from(byCampaign.values()),
        numbers: (numberRows ?? []).map((n: { id: string; phone_number: string }) => ({
          id: n.id,
          phone_number: n.phone_number,
        })),
        campaigns: ((campaignRows ?? []) as unknown as { campaigns: { name: string } }[]).map(
          (c) => c.campaigns.name
        ),
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const { data: target, error: targetError } = await supabase
    .from('org_members')
    .select('role, status, removed_at')
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
      if (body.role !== 'admin' && body.role !== 'agent' && body.role !== 'manager') {
        return jsonError(400, "role must be 'admin', 'agent', or 'manager'");
      }
      if (body.role !== 'admin') {
        const guardError = await checkAdminGuard(
          supabase,
          orgId,
          callerRole,
          user.id,
          targetUserId,
          target
        );
        if (guardError) return guardError;
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
      // Review fix (A5 NIT): org_manager_pods has no role check of its own (see
      // 'set_manager_pods' above) -- demoting a manager away from that role must clear their
      // scope rows here, or a later re-promotion would silently resurrect a stale pod scope
      // nobody chose. Best-effort: a cleanup failure never fails the role change itself, same
      // as cascadeOffboard's own best-effort pattern in this file.
      if (target.role === 'manager' && body.role !== 'manager') {
        const { error: podScopeError } = await supabase
          .from('org_manager_pods')
          .delete()
          .eq('org_id', orgId)
          .eq('manager_user_id', targetUserId);
        if (podScopeError) {
          console.error(
            'org-members change_role: manager pod-scope cleanup failed',
            podScopeError.message
          );
        } else {
          await logOrgAction(supabase, {
            orgId,
            actorUserId: user.id,
            action: 'member.set_manager_pods',
            targetType: 'org_member',
            targetId: targetUserId,
            details: { pod_ids: [], reason: 'role_change_away_from_manager' },
          });
        }
      }
      break;
    }
    case 'disable': {
      const guardError = await checkAdminGuard(
        supabase,
        orgId,
        callerRole,
        user.id,
        targetUserId,
        target
      );
      if (guardError) return guardError;
      const { error } = await supabase
        .from('org_members')
        .update({ status: 'disabled' })
        .eq('org_id', orgId)
        .eq('user_id', targetUserId);
      if (error) {
        console.error('org-members disable error:', error.message);
        return jsonError(500, 'Failed to disable member');
      }
      const cascade = await cascadeOffboard(supabase, orgId, targetUserId);
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.disable',
        targetType: 'org_member',
        targetId: targetUserId,
        details: { role: target.role, ...cascade },
      });
      break;
    }
    case 'enable': {
      const { error } = await supabase
        .from('org_members')
        .update({ status: 'active', removed_at: null })
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
    // MISSION-5 TASK-M5-A3: soft-remove, not `.delete()` -- history (team_daily_stats,
    // dispositions, recordings) needs this row and the profiles row it joins to for the person's
    // name to keep showing up. Queued leads/callbacks are NOT auto-released here -- the
    // offboarding wizard's "release queued leads to the pool" is its own explicit step (action
    // 'release_queued_leads' below), callable before or after this action, so an admin who's
    // still deciding where leads should go isn't forced into it by clicking Remove.
    case 'remove': {
      const guardError = await checkAdminGuard(
        supabase,
        orgId,
        callerRole,
        user.id,
        targetUserId,
        target
      );
      if (guardError) return guardError;

      const { error } = await supabase
        .from('org_members')
        .update({ status: 'removed', removed_at: new Date().toISOString() })
        .eq('org_id', orgId)
        .eq('user_id', targetUserId);
      if (error) {
        console.error('org-members remove error:', error.message);
        return jsonError(500, 'Failed to remove member');
      }
      const cascade = await cascadeOffboard(supabase, orgId, targetUserId);
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.remove',
        targetType: 'org_member',
        targetId: targetUserId,
        details: { role: target.role, ...cascade },
      });
      break;
    }
    // MISSION-5 TASK-M5-A3: the offboarding wizard's "release queued leads to the pool" step --
    // a distinct action from disable/remove (see those cases' own comments), callable against
    // any member (not gated on their current status) since an admin may want to redistribute a
    // still-active member's slice too. Due/future callbacks are intentionally not touched here
    // (B3's job); `release_agent_queued_leads` is scoped to `status = 'queued'` only.
    case 'release_queued_leads': {
      const { data: releasedCount, error } = await supabase.rpc('release_agent_queued_leads', {
        p_org: orgId,
        p_agent: targetUserId,
      });
      if (error) {
        console.error('org-members release_queued_leads error:', error.message);
        return jsonError(500, 'Failed to release queued leads');
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.release_queued_leads',
        targetType: 'org_member',
        targetId: targetUserId,
        details: { queuedLeadsReleased: releasedCount ?? 0 },
      });
      return new Response(JSON.stringify({ ok: true, released: releasedCount ?? 0 }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    // MISSION-5 TASK-M5-A3: restorable only within RESTORE_WINDOW_MS of removed_at -- after that
    // this 403s and the member stays 'removed' permanently (the row itself is never deleted
    // either way, so history is unaffected regardless of whether this ever gets called).
    case 'restore': {
      if (target.status !== 'removed') {
        return jsonError(400, 'Member is not in a removed state');
      }
      const removedAt = target.removed_at ? new Date(target.removed_at).getTime() : 0;
      if (Date.now() - removedAt > RESTORE_WINDOW_MS) {
        return jsonError(410, 'The 72-hour restore window for this member has passed');
      }
      const { error } = await supabase
        .from('org_members')
        .update({ status: 'active', removed_at: null })
        .eq('org_id', orgId)
        .eq('user_id', targetUserId);
      if (error) {
        console.error('org-members restore error:', error.message);
        return jsonError(500, 'Failed to restore member');
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.restore',
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
    // MISSION-5 TASK-M5-A5: which single pod this member belongs to (an agent's or manager's
    // OWN roster placement -- distinct from a manager's SCOPE, see 'set_manager_pods' below and
    // this task's own migration header). Owner/admin only (this whole POST handler already is).
    case 'set_pod': {
      const podId = typeof body.pod_id === 'string' && body.pod_id ? body.pod_id : null;
      if (podId) {
        const { data: pod, error: podLookupError } = await supabase
          .from('org_pods')
          .select('id')
          .eq('id', podId)
          .eq('org_id', orgId)
          .maybeSingle();
        if (podLookupError) {
          console.error('org-members set_pod lookup error:', podLookupError.message);
          return jsonError(500, 'Failed to look up pod');
        }
        if (!pod) return jsonError(400, 'Pod does not belong to this org');
      }
      const { error } = await supabase
        .from('org_members')
        .update({ pod_id: podId })
        .eq('org_id', orgId)
        .eq('user_id', targetUserId);
      if (error) {
        console.error('org-members set_pod error:', error.message);
        return jsonError(500, 'Failed to set pod');
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.set_pod',
        targetType: 'org_member',
        targetId: targetUserId,
        details: { pod_id: podId },
      });
      break;
    }
    // MISSION-5 TASK-M5-A5: replaces the FULL set of pods a manager may supervise (a manager may
    // be limited to "one or more pods" -- many-to-many, org_manager_pods, see the migration
    // header for why this is a separate relationship from org_members.pod_id above). Only
    // meaningful for a 'manager'-role target; rejected for anyone else so a stray call can't
    // silently seed rows a role change would leave orphaned (org_manager_pods has no role check
    // of its own -- it's just a scope table -- so this endpoint is the one place that invariant
    // is enforced).
    case 'set_manager_pods': {
      if (target.role !== 'manager') {
        return jsonError(400, 'set_manager_pods only applies to a member with role manager');
      }
      const podIds = Array.isArray(body.pod_ids)
        ? Array.from(new Set(body.pod_ids.filter((id): id is string => typeof id === 'string')))
        : [];
      if (podIds.length > 0) {
        const { data: pods, error: podsError } = await supabase
          .from('org_pods')
          .select('id')
          .eq('org_id', orgId)
          .in('id', podIds);
        if (podsError) {
          console.error('org-members set_manager_pods lookup error:', podsError.message);
          return jsonError(500, 'Failed to look up pods');
        }
        if ((pods ?? []).length !== podIds.length) {
          return jsonError(400, 'One or more pod_ids do not belong to this org');
        }
      }
      const { error: deleteError } = await supabase
        .from('org_manager_pods')
        .delete()
        .eq('org_id', orgId)
        .eq('manager_user_id', targetUserId);
      if (deleteError) {
        console.error('org-members set_manager_pods delete error:', deleteError.message);
        return jsonError(500, 'Failed to update manager pod scope');
      }
      if (podIds.length > 0) {
        const { error: insertError } = await supabase.from('org_manager_pods').insert(
          podIds.map((podId) => ({
            org_id: orgId,
            manager_user_id: targetUserId,
            pod_id: podId,
          }))
        );
        if (insertError) {
          console.error('org-members set_manager_pods insert error:', insertError.message);
          return jsonError(500, 'Failed to update manager pod scope');
        }
      }
      await logOrgAction(supabase, {
        orgId,
        actorUserId: user.id,
        action: 'member.set_manager_pods',
        targetType: 'org_member',
        targetId: targetUserId,
        details: { pod_ids: podIds },
      });
      break;
    }
    default:
      return jsonError(
        400,
        "action must be one of 'change_role', 'disable', 'enable', 'remove', 'restore', " +
          "'release_queued_leads', 'set_ghl_user_id', 'set_pod', 'set_manager_pods', " +
          "'offboard_preview'"
      );
  }

  return new Response(JSON.stringify({ ok: true }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from './cors.ts';
import { checkViewAs } from './view-as-guard.ts';

// MISSION-5 TASK-M5-A5: 'manager' added. requireOrgRole is a generic gate -- widening this type
// alone grants nothing; a call site only admits a manager when it explicitly lists 'manager' in
// its own `roles` array (every existing call site keeps rejecting it by default, fail-closed).
export type OrgRole = 'owner' | 'admin' | 'agent' | 'manager';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getUserFromRequest(
  req: Request
): Promise<{ user: { id: string }; error: Response | null }> {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return {
      user: { id: '' },
      error: new Response(
        JSON.stringify({ error: 'Missing or invalid Authorization header. Please sign in.' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      ),
    };
  }

  const token = authHeader.replace('Bearer ', '');
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(token);

  if (error || !user) {
    return {
      user: { id: '' },
      error: new Response(
        JSON.stringify({
          error: error?.message || 'Invalid or expired token. Please sign in again.',
        }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      ),
    };
  }

  // TASK-H21: a "view as intern" session is restricted to an allowlist of read-only functions (default deny).
  const viewAsBlock = await checkViewAs(supabase, token, req);
  if (viewAsBlock) return { user: { id: '' }, error: viewAsBlock };

  return { user, error: null };
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export type RequireOrgRoleResult =
  | { user: { id: string }; orgId: string; role: OrgRole; error: null }
  | { user: null; orgId: null; role: null; error: Response };

/**
 * Resolves the caller's org and role, then enforces membership in `roles`
 * (TASK-P1-02, design §2). The org comes from the `X-Org-Id` header when
 * present -- validated against real membership, a header claiming an org the
 * caller doesn't belong to is rejected, never trusted -- falling back to
 * `profiles.active_org_id` when the header is absent.
 *
 * Queries `org_members` directly with a service-role client rather than
 * through `private.is_org_member`/`has_org_role`: those SECURITY DEFINER
 * helpers are unreachable from a service-role Edge Function today (`private`
 * isn't in config.toml's exposed PostgREST schemas, and `service_role` was
 * never granted USAGE on it either -- see TASK-P1-05's review). A
 * service-role client already bypasses `org_members`' RLS, so no helper is
 * needed here regardless.
 */
export async function requireOrgRole(
  req: Request,
  roles: OrgRole[]
): Promise<RequireOrgRoleResult> {
  const { user, error: authError } = await getUserFromRequest(req);
  if (authError) {
    return { user: null, orgId: null, role: null, error: authError };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  let orgId = req.headers.get('X-Org-Id')?.trim() || null;

  if (!orgId) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('active_org_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (profileError) {
      console.error('requireOrgRole: profile lookup failed', profileError.message);
      return {
        user: null,
        orgId: null,
        role: null,
        error: jsonError(500, 'Failed to resolve org context'),
      };
    }
    orgId = profile?.active_org_id ?? null;
  }

  if (!orgId) {
    return { user: null, orgId: null, role: null, error: jsonError(400, 'No org selected') };
  }
  // A malformed X-Org-Id used to reach the org_members query below, where Postgres's own "invalid
  // input syntax for type uuid" surfaced as membershipError -> a 500, not a 400. profiles.active_org_id
  // is always a real uuid (it's a DB column), so this only ever rejects a bad header value.
  if (!UUID_RE.test(orgId)) {
    return { user: null, orgId: null, role: null, error: jsonError(400, 'Invalid org id') };
  }

  const { data: membership, error: membershipError } = await supabase
    .from('org_members')
    .select('role')
    .eq('org_id', orgId)
    .eq('user_id', user.id)
    .eq('status', 'active')
    .maybeSingle();
  if (membershipError) {
    console.error('requireOrgRole: membership lookup failed', membershipError.message);
    return {
      user: null,
      orgId: null,
      role: null,
      error: jsonError(500, 'Failed to verify org membership'),
    };
  }
  if (!membership) {
    return {
      user: null,
      orgId: null,
      role: null,
      error: jsonError(403, 'Not a member of this org'),
    };
  }

  const role = membership.role as OrgRole;
  if (!roles.includes(role)) {
    return { user: null, orgId: null, role: null, error: jsonError(403, 'Insufficient role') };
  }

  return { user, orgId, role, error: null };
}

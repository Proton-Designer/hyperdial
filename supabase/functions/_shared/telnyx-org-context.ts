/**
 * Org + role resolution and a connected-Telnyx-client lookup for `telnyx-*` edge
 * functions. TASK-P1-02 explicitly excludes `telnyx-*`/`dialer-*` from
 * `_shared/auth.ts`'s `requireOrgRole` (that task's own scope note), so this is an
 * independent copy of the same shape for this lane rather than a shared import
 * across lanes: same org resolution (`X-Org-Id` header, validated against real
 * membership, falling back to `profiles.active_org_id`) and the same
 * `{user, orgId, role, error}` result contract, so callers reason about it identically.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders } from './cors.ts';
import { getUserFromRequest } from './auth.ts';
import { createTelnyxClient, type TelnyxClient } from './telnyx-client.ts';

export type OrgRole = 'owner' | 'admin' | 'agent';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

export type RequireTelnyxOrgRoleResult =
  | { user: { id: string }; orgId: string; role: OrgRole; error: null }
  | { user: null; orgId: null; role: null; error: Response };

/** Same resolution + role-enforcement shape as `_shared/auth.ts`'s `requireOrgRole`. */
export async function requireTelnyxOrgRole(
  req: Request,
  roles: OrgRole[]
): Promise<RequireTelnyxOrgRoleResult> {
  const { user, error: authError } = await getUserFromRequest(req);
  if (authError) {
    return { user: null, orgId: null, role: null, error: authError };
  }

  const supabase = getSupabaseAdmin();

  let orgId = req.headers.get('X-Org-Id')?.trim() || null;

  if (!orgId) {
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('active_org_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (profileError) {
      console.error('requireTelnyxOrgRole: profile lookup failed', profileError.message);
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
    console.error('requireTelnyxOrgRole: membership lookup failed', membershipError.message);
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

export interface ConnectedOrgTelnyxContext {
  client: TelnyxClient;
  callControlAppId: string | null;
  credentialConnectionId: string | null;
  error: null;
}
export interface ConnectedOrgTelnyxContextError {
  client: null;
  callControlAppId: null;
  credentialConnectionId: null;
  error: Response;
}

/**
 * Builds a `TelnyxClient` from the org's own BYO key (design §3) -- never an env var.
 * Fails with a clear, actionable 400 if the org hasn't connected Telnyx yet (or was
 * disconnected), same "no silent partial state" spirit as `enqueue_crm_job`'s
 * no-op-when-disconnected, except this always needs a real client to do its job, so it
 * surfaces the gap as an error rather than silently no-opping.
 */
export async function getConnectedOrgTelnyxContext(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orgId: string
): Promise<ConnectedOrgTelnyxContext | ConnectedOrgTelnyxContextError> {
  const { data: telephony, error: telephonyError } = await supabase
    .from('org_telephony')
    .select('status, call_control_app_id, credential_connection_id')
    .eq('org_id', orgId)
    .maybeSingle();
  if (telephonyError) {
    console.error(
      'getConnectedOrgTelnyxContext: org_telephony lookup failed',
      telephonyError.message
    );
    return {
      client: null,
      callControlAppId: null,
      credentialConnectionId: null,
      error: jsonError(500, 'Failed to read Telnyx connection state'),
    };
  }
  if (!telephony || telephony.status !== 'connected') {
    return {
      client: null,
      callControlAppId: null,
      credentialConnectionId: null,
      error: jsonError(400, 'Telnyx is not connected for this org. Connect it in Settings first.'),
    };
  }

  const { data: apiKey, error: keyError } = await supabase.rpc('get_org_telnyx_key', {
    p_org: orgId,
  });
  if (keyError || !apiKey) {
    console.error('getConnectedOrgTelnyxContext: get_org_telnyx_key failed', keyError?.message);
    return {
      client: null,
      callControlAppId: null,
      credentialConnectionId: null,
      error: jsonError(500, 'Failed to read the stored Telnyx key'),
    };
  }

  return {
    client: createTelnyxClient(apiKey as string),
    callControlAppId: telephony.call_control_app_id ?? null,
    credentialConnectionId: telephony.credential_connection_id ?? null,
    error: null,
  };
}

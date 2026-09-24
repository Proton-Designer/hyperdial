import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url, no padding -- safe to drop straight into a query string.
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  // Design §2 permission matrix: "Invite/remove/change role of members" is owner/admin only.
  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let body: { email?: string; role?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }

  const email = body.email?.trim().toLowerCase();
  const role = body.role;
  if (!email || !email.includes('@')) {
    return jsonError(400, 'A valid email is required');
  }
  // Never 'owner': an invite can only ever grant admin or agent. Ownership transfer is a
  // separate, not-yet-built owner-only path (see 20260924000600's migration comment) -- this
  // mirrors the DB-level WITH CHECK, but the service-role client used below bypasses RLS
  // entirely, so this app-level check is the actual enforcement for this endpoint.
  if (role !== 'admin' && role !== 'agent') {
    return jsonError(400, "role must be 'admin' or 'agent'");
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  const token = generateToken();
  const tokenHash = await hashToken(token);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

  const { data: invite, error } = await supabase
    .from('org_invites')
    .insert({
      org_id: orgId,
      email,
      role,
      token_hash: tokenHash,
      invited_by: user.id,
      expires_at: expiresAt,
    })
    .select('id, expires_at')
    .single();

  if (error) {
    console.error('org-invite-create insert error:', error.message);
    return jsonError(500, 'Failed to create invite');
  }

  // The raw token is returned exactly once -- only token_hash is ever persisted, so this
  // response is the only place a caller can retrieve a usable invite link.
  return new Response(
    JSON.stringify({ inviteId: invite.id, token, expiresAt: invite.expires_at }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
});

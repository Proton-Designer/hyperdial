/**
 * MISSION-5 TASK-A2: invites v2. GET lists the org's invites (pending/accepted/expired/revoked,
 * derived -- there is no stored `status` column, see the row-shaping below) for the Settings ->
 * Team "Pending invites" table. POST is now action-based (`create` / `resend` / `revoke`), same
 * convention as `org-members`'s own POST.
 *
 * `create` is bulk: many emails in one call, one result per email (`sent` / `already_member` /
 * `already_invited` / `invalid`) -- never a single all-or-nothing failure for the whole paste.
 * Duplicate-email detection reuses `org_member_emails` (TASK-A2's own batched lookup, see its
 * migration header) instead of a GoTrue Admin API call per pasted address.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { corsHeaders, corsPreflightResponse } from '../_shared/cors.ts';
import { requireOrgRole } from '../_shared/auth.ts';
import { logOrgAction } from '../_shared/audit.ts';
import { isInviteLive } from '../_shared/invite-core.ts';

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EMAILS_PER_BATCH = 100;

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function getSupabaseAdmin() {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
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

interface InviteRow {
  id: string;
  email: string;
  role: 'owner' | 'admin' | 'agent' | 'manager';
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  revoked_at: string | null;
  campaign_ids: string[];
  created_at: string;
}

function inviteStatus(row: Pick<InviteRow, 'accepted_at' | 'revoked_at' | 'expires_at'>): string {
  if (row.accepted_at) return 'accepted';
  if (row.revoked_at) return 'revoked';
  if (new Date(row.expires_at).getTime() < Date.now()) return 'expired';
  return 'pending';
}

/** Validates campaigns belong to this org, up front, so a bad id fails the WHOLE create with a
 *  clear 400 rather than silently no-op-ing at accept time (`check_campaign_agent_org`'s own
 *  trigger only fires later, on accept, and would otherwise turn a client mistake here into a
 *  confusing failure days later when someone actually accepts the invite). */
async function validCampaignIds(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  orgId: string,
  campaignIds: string[]
): Promise<boolean> {
  if (campaignIds.length === 0) return true;
  const { data, error } = await supabase
    .from('campaigns')
    .select('id')
    .eq('org_id', orgId)
    .in('id', campaignIds);
  if (error) {
    console.error('org-invite-create validCampaignIds error:', error.message);
    return false;
  }
  return (data ?? []).length === campaignIds.length;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return corsPreflightResponse();
  const supabase = getSupabaseAdmin();

  if (req.method === 'GET') {
    const { orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
    if (authError) return authError;

    const { data: invites, error } = await supabase
      .from('org_invites')
      .select(
        'id, email, role, invited_by, expires_at, accepted_at, revoked_at, campaign_ids, created_at'
      )
      .eq('org_id', orgId)
      .order('created_at', { ascending: false });
    if (error) {
      console.error('org-invite-create list error:', error.message);
      return jsonError(500, 'Failed to list invites');
    }

    const inviterIds = Array.from(new Set((invites ?? []).map((i: InviteRow) => i.invited_by)));
    const { data: profiles } = inviterIds.length
      ? await supabase
          .from('profiles')
          .select('user_id, first_name, last_name')
          .in('user_id', inviterIds)
      : { data: [] as { user_id: string; first_name: string | null; last_name: string | null }[] };
    const nameMap = new Map(
      (profiles ?? []).map(
        (p: { user_id: string; first_name: string | null; last_name: string | null }) => [
          p.user_id,
          [p.first_name, p.last_name].filter(Boolean).join(' ') || null,
        ]
      )
    );

    const results = (invites ?? []).map((i: InviteRow) => ({
      id: i.id,
      email: i.email,
      role: i.role,
      invitedByName: nameMap.get(i.invited_by) ?? null,
      campaignIds: i.campaign_ids,
      status: inviteStatus(i),
      createdAt: i.created_at,
      expiresAt: i.expires_at,
    }));

    return new Response(JSON.stringify({ invites: results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (req.method !== 'POST') return jsonError(405, 'Method not allowed');

  const { user, orgId, error: authError } = await requireOrgRole(req, ['owner', 'admin']);
  if (authError) return authError;

  let body: {
    action?: string;
    emails?: unknown;
    role?: string;
    campaignIds?: unknown;
    inviteId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, 'Invalid JSON body');
  }

  if (body.action === 'revoke') {
    const inviteId = body.inviteId?.trim();
    if (!inviteId) return jsonError(400, 'Missing inviteId');
    const { data: existing } = await supabase
      .from('org_invites')
      .select('id, email, accepted_at, revoked_at')
      .eq('id', inviteId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (!existing) return jsonError(404, 'Invite not found');
    if (existing.accepted_at) return jsonError(400, 'This invite was already accepted');
    if (existing.revoked_at) return jsonError(400, 'This invite was already revoked');

    const { error } = await supabase
      .from('org_invites')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', inviteId);
    if (error) {
      console.error('org-invite-create revoke error:', error.message);
      return jsonError(500, 'Failed to revoke invite');
    }
    await logOrgAction(supabase, {
      orgId,
      actorUserId: user.id,
      action: 'invite.revoke',
      targetType: 'org_invite',
      targetId: inviteId,
      details: { email: existing.email },
    });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (body.action === 'resend') {
    const inviteId = body.inviteId?.trim();
    if (!inviteId) return jsonError(400, 'Missing inviteId');
    const { data: existing } = await supabase
      .from('org_invites')
      .select('id, email, role, campaign_ids, accepted_at, revoked_at, expires_at')
      .eq('id', inviteId)
      .eq('org_id', orgId)
      .maybeSingle();
    if (!existing) return jsonError(404, 'Invite not found');
    if (existing.accepted_at) return jsonError(400, 'This invite was already accepted');
    if (existing.revoked_at) return jsonError(400, 'This invite was already revoked');

    // Old dies, new is born -- in that order, so the partial unique index never sees two live
    // rows for this email at once even momentarily.
    const { error: revokeError } = await supabase
      .from('org_invites')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', inviteId);
    if (revokeError) {
      console.error('org-invite-create resend (revoke old) error:', revokeError.message);
      return jsonError(500, 'Failed to resend invite');
    }

    const token = generateToken();
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
    const { data: created, error: insertError } = await supabase
      .from('org_invites')
      .insert({
        org_id: orgId,
        email: existing.email,
        role: existing.role,
        token_hash: tokenHash,
        invited_by: user.id,
        expires_at: expiresAt,
        campaign_ids: existing.campaign_ids,
      })
      .select('id, expires_at')
      .single();
    if (insertError || !created) {
      console.error('org-invite-create resend (insert new) error:', insertError?.message);
      // The old row is already revoked and can't be un-revoked from here -- surface this plainly
      // rather than pretend the resend half-succeeded silently. A retry (Resend again is not
      // available on an already-revoked row) means: revoke succeeded, tell an admin to send a
      // brand-new invite instead.
      return jsonError(
        500,
        'Failed to issue a new invite token -- the old link is now dead; send a new invite instead'
      );
    }

    await logOrgAction(supabase, {
      orgId,
      actorUserId: user.id,
      action: 'invite.resend',
      targetType: 'org_invite',
      targetId: created.id,
      details: { email: existing.email, oldInviteId: inviteId },
    });

    return new Response(
      JSON.stringify({ inviteId: created.id, token, expiresAt: created.expires_at }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  if (body.action && body.action !== 'create') {
    return jsonError(400, "action must be one of 'create', 'resend', 'revoke'");
  }

  // 'create' (also the default when action is omitted, for any external caller still on the
  // pre-A2 single-email contract -- though this repo's own client always sends it explicitly now).
  const rawEmails = Array.isArray(body.emails) ? body.emails : [];
  if (rawEmails.length === 0) return jsonError(400, 'At least one email is required');
  if (rawEmails.length > MAX_EMAILS_PER_BATCH) {
    return jsonError(400, `At most ${MAX_EMAILS_PER_BATCH} emails per batch`);
  }
  const role = body.role;
  if (role !== 'admin' && role !== 'agent' && role !== 'manager') {
    return jsonError(400, "role must be 'admin', 'agent', or 'manager'");
  }
  const campaignIds = Array.isArray(body.campaignIds)
    ? body.campaignIds.filter((id): id is string => typeof id === 'string')
    : [];
  if (!(await validCampaignIds(supabase, orgId, campaignIds))) {
    return jsonError(400, 'One or more campaignIds do not belong to this org');
  }

  // Normalize + de-dupe the pasted batch itself (case-insensitive) before touching the DB at all --
  // "seen this batch" state below also updates as each email resolves to 'sent', so a duplicate
  // pasted twice in the SAME batch reports its second occurrence as 'already_invited', not a raw
  // partial-unique-index violation from racing itself.
  const seenThisBatch = new Set<string>();
  const emails: string[] = [];
  for (const raw of rawEmails) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    emails.push(trimmed);
  }

  const { data: memberRows } = await supabase.rpc('org_member_emails', { p_org: orgId });
  const memberEmails = new Set(
    ((memberRows ?? []) as { user_id: string; email: string | null }[])
      .map((m) => m.email?.toLowerCase())
      .filter((e): e is string => !!e)
  );

  // MISSION-5 TASK-M5-A2 fix-forward (eng2 review BLOCKER 2): this must exclude an EXPIRED row
  // too, or `already_invited` fires below before the per-email loop's own auto-revoke-expired
  // block ever gets a chance to run -- that block's query matches the exact same predicate PLUS
  // `expires_at < now()`, so by the time it could run, this set having already proven no match
  // means it never does. Net effect before this fix: an email whose only invite expired became
  // permanently un-invitable through the UI. `isInviteLive` (`_shared/invite-core.ts`) is the
  // SAME "is this row currently live" definition `checkInviteAcceptable` already uses for
  // accept -- filtered here in JS (not a DB-level `.gte`) so this set can never drift out of sync
  // with that definition if it ever changes.
  const { data: liveInvites } = await supabase
    .from('org_invites')
    .select('email, accepted_at, revoked_at, expires_at')
    .eq('org_id', orgId)
    .is('accepted_at', null)
    .is('revoked_at', null);
  const liveInvitedEmails = new Set(
    (
      (liveInvites ?? []) as {
        email: string;
        accepted_at: string | null;
        revoked_at: string | null;
        expires_at: string;
      }[]
    )
      .filter(isInviteLive)
      .map((i) => i.email.toLowerCase())
  );

  const results: {
    email: string;
    status: 'sent' | 'already_member' | 'already_invited' | 'invalid';
    inviteId?: string;
    token?: string;
    expiresAt?: string;
  }[] = [];

  for (const email of emails) {
    const key = email.toLowerCase();
    if (!key.includes('@') || key.startsWith('@') || key.endsWith('@')) {
      results.push({ email, status: 'invalid' });
      continue;
    }
    if (memberEmails.has(key)) {
      results.push({ email, status: 'already_member' });
      continue;
    }
    if (seenThisBatch.has(key) || liveInvitedEmails.has(key)) {
      results.push({ email, status: 'already_invited' });
      continue;
    }

    // A LIVE row for this email that's actually expired doesn't show up in liveInvitedEmails'
    // exclusion above (it's still accepted_at/revoked_at both null) -- auto-revoke it here so the
    // fresh insert below never collides with the partial unique index, per this migration's own
    // "expired never blocks a new invite" rule.
    await supabase
      .from('org_invites')
      .update({ revoked_at: new Date().toISOString() })
      .eq('org_id', orgId)
      .ilike('email', key)
      .is('accepted_at', null)
      .is('revoked_at', null)
      .lt('expires_at', new Date().toISOString());

    const token = generateToken();
    const tokenHash = await hashToken(token);
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();

    // MISSION-5 TASK-M5-A2 fix-forward (NIT): store lower/trimmed, matching the requirement's own
    // wording and every comparison above (`key`) that already normalizes this way -- otherwise
    // the same person invited twice can show up with visually-inconsistent casing in the Pending
    // list, and the stored value silently disagrees with the partial index's own `lower(email)`.
    const { data: invite, error } = await supabase
      .from('org_invites')
      .insert({
        org_id: orgId,
        email: key,
        role,
        token_hash: tokenHash,
        invited_by: user.id,
        expires_at: expiresAt,
        campaign_ids: campaignIds,
      })
      .select('id, expires_at')
      .single();

    if (error || !invite) {
      // Most likely the partial unique index (a genuinely live, non-expired invite already
      // exists) -- report it as already_invited rather than a raw 500 for this one email; every
      // other email in the batch still gets processed.
      console.error('org-invite-create bulk insert error for', email, error?.message);
      results.push({ email, status: 'already_invited' });
      continue;
    }

    seenThisBatch.add(key);
    results.push({
      email: key,
      status: 'sent',
      inviteId: invite.id,
      token,
      expiresAt: invite.expires_at,
    });
    await logOrgAction(supabase, {
      orgId,
      actorUserId: user.id,
      action: 'invite.create',
      targetType: 'org_invite',
      targetId: invite.id,
      details: { email: key, role, campaignIds },
    });
  }

  return new Response(JSON.stringify({ results }), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});

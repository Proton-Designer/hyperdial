-- MISSION-5 TASK-A2: invites v2 (bulk, pending list, resend/revoke, one-live-invite-per-email) +
-- a batched org-member email lookup (closes TM-X1: org-members' roster GET used to do one
-- auth.admin.getUserById GoTrue Admin API call PER member -- a 50-member org is 50 sequential
-- round trips; this reuses the same fix for the bulk-invite duplicate-email check too).

alter table public.org_invites
  add column revoked_at timestamptz,
  add column campaign_ids uuid[] not null default '{}'::uuid[];

comment on column public.org_invites.revoked_at is
  'TASK-A2: set by an explicit Revoke, or automatically when a fresh create/resend supersedes an
   already-EXPIRED row for the same email (see org-invite-create''s own logic) -- never set on an
   accepted invite.';
comment on column public.org_invites.campaign_ids is
  'TASK-A2: campaigns to auto-join via campaign_agents on accept (ADM-4''s existing per-org
   picker, reused at invite time). The pre-existing check_campaign_agent_org trigger on
   campaign_agents (20260924000200) already rejects a cross-org id at insert time -- not
   re-validated here.';

-- "One live invite per (org, email)" -- an accepted/expired/revoked invite never blocks a new
-- one. Expiry can't appear in a partial index predicate (now() isn't immutable), so "live" here
-- is deliberately just accepted_at is null and revoked_at is null -- org-invite-create's own
-- create/resend logic auto-revokes an already-EXPIRED row for that email before inserting a new
-- one (see its own header), so the expiry case is handled at the call site, not by this index.
create unique index org_invites_org_email_live_key
  on public.org_invites (org_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- ---- Batched org-member email lookup (TM-X1) ----------------------------------------------------
-- `public.` (not `private.`): `private` isn't in config.toml's exposed PostgREST schemas, and this
-- is called via supabase.rpc() from a service-role Edge Function client -- same reason
-- assign_campaign_leads/team_daily_stats/team_live_board are all `public.` (see TASK-P1-05's own
-- review finding, still the live lesson). Locked down the same way as org_mtd_billed_seconds
-- (20260925080200): revoked from authenticated too, not just public/anon -- this returns raw
-- emails with no row-level filter beyond the p_org join and no role check of its own, so only
-- postgres/service_role (which already does its own requireOrgRole check before calling it) may
-- call it, never a signed-in client directly.
create function public.org_member_emails(p_org uuid)
returns table (user_id uuid, email text)
language sql
security definer
stable
set search_path = ''
as $$
  select au.id, au.email
  from auth.users au
  join public.org_members om on om.user_id = au.id
  where om.org_id = p_org;
$$;

revoke all on function public.org_member_emails(uuid) from public, anon, authenticated;

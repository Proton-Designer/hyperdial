-- TASK-L4: invite-only signup (ADM-3). Closes the open self-signup path that
-- 20260924000100_create_org_tenancy_tables.sql's on_auth_user_created trigger left in place
-- ("when absent [no invite_token], this trigger runs the normal self-serve path"). From this
-- migration forward, ANY signup without a valid, unexpired, unaccepted org_invites token is
-- rejected by the trigger itself -- including a brand-new company's first/owner signup. This is
-- a deliberate product decision (LAUNCH-PLAN.md, TASK-L4): the org that will use this
-- deployment is invited/created once by hand, then everyone else joins via org-invite-create's
-- invite links. Do NOT use Supabase Auth's "disable signup" project setting for this -- it would
-- also block invitees, since GoTrue checks it before an invite's signup call ever reaches this
-- trigger.
--
-- Deliberately NOT using the Auth "disable signup" setting instead of this trigger, and NOT
-- adding a carve-out for the first/owner signup -- both would reopen exactly the hole this
-- migration closes. USER DECISION (task log, 2026-09-24 18:13): the user creates the
-- MyHomeBase org through the app's still-open self-signup BEFORE the lead deploys this
-- migration to live -- sequencing is the lead's job to hold, not this code's.
--
-- private.ensure_org_for_user (self-serve org creation) is left in place, unused by this
-- trigger from here on -- 20260924000200_add_org_id_and_backfill.sql's one-time backfill also
-- calls it and must keep working if that migration is ever replayed against a fresh database.

-- token_hash is sha256(raw token) hex, same as org-invite-create/org-invite-accept compute it
-- (crypto.subtle.digest('SHA-256', ...) -> hex). pgcrypto's digest() matches that exactly.
create extension if not exists pgcrypto with schema extensions;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_invite record;
begin
  v_token := new.raw_user_meta_data ->> 'invite_token';

  if v_token is null or btrim(v_token) = '' then
    raise exception 'Sign-up is invite-only. Ask your team owner or admin for an invite link.';
  end if;

  select id, email, expires_at, accepted_at
    into v_invite
    from public.org_invites
   where token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex');

  -- A zero-row SELECT INTO leaves an untyped `record` variable unassigned -- referencing any of
  -- its fields (even just `v_invite.id`) before this FOUND check would itself raise "record
  -- v_invite is not assigned yet", masking the real "invite not found" case as a different error.
  if not found then
    raise exception 'This invite link is not valid.';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'This invite has already been used.';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'This invite has expired. Ask your team to send a new one.';
  end if;
  -- Same guard org-invite-accept applies post-signup (case-insensitive, GoTrue itself lowercases
  -- on signup) -- enforcing it here too means a mismatched signup fails atomically instead of
  -- creating an orphaned auth.users/profiles row that accept would then also reject.
  if lower(new.email) is distinct from lower(v_invite.email) then
    raise exception 'This invite was sent to a different email address.';
  end if;

  -- Unchanged from before: create only the profile. org-invite-accept inserts the org_members
  -- row for the invited org/role and sets profiles.active_org_id once the invite is verified
  -- again (its own independent check, defense in depth -- this trigger being satisfied doesn't
  -- skip that).
  insert into public.profiles (user_id, first_name, last_name)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'first_name', ''),
    nullif(new.raw_user_meta_data ->> 'last_name', '')
  )
  on conflict (user_id) do nothing;

  return new;
end;
$$;

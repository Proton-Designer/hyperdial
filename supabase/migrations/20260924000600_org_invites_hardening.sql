-- RLS hardening for TASK-P1-03 (invite/team UI), requested during TASK-P1-01's verify pass
-- (see this task's log). Four independent fixes:
--   1. org_invites INSERT/UPDATE must reject role = 'owner' -- an invite can never grant
--      ownership; ownership transfer is a separate, not-yet-built owner-only path (see the
--      org_members policy comment in 20260924000100).
--   2. profiles.active_org_id may only be set to an org the user actually belongs to -- without
--      this, a compromised or buggy client could point active_org_id at an arbitrary org and ride
--      requireOrgRole's X-Org-Id fallback into a membership check that (correctly) still denies
--      access, but the profile row itself would silently carry a bogus value.
--   3. Org co-members can read each other's first/last name (for the Team tab roster) through a
--      SECURITY DEFINER helper, not an inline subquery on org_members (same rule as every other
--      cross-table policy in this schema -- see 20260924000300's header comment).
--   4. private.ensure_org_for_user is revoked from public/authenticated: it is only ever meant to
--      run from the on_auth_user_created trigger, which is itself SECURITY DEFINER and therefore
--      calls it as the owning role regardless of this grant. Leaving EXECUTE open to authenticated
--      let any signed-in user call it directly via .rpc() and mutate their own org_id/profile
--      outside the invite-accept contract.

-- 1. org_invites: role can never be 'owner' ---------------------------------

drop policy "owner or admin can create invites" on public.org_invites;
drop policy "owner or admin can update invites" on public.org_invites;

create policy "owner or admin can create invites"
  on public.org_invites for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']) and role <> 'owner');

create policy "owner or admin can update invites"
  on public.org_invites for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']) and role <> 'owner');

-- 2. profiles.active_org_id: must be a real membership ----------------------

drop policy "users can update own profile" on public.profiles;

create policy "users can update own profile"
  on public.profiles for update
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (active_org_id is null or private.is_org_member(active_org_id))
  );

-- 3. Co-members can read each other's profile (team roster) -----------------

create function private.shares_org_with(p_user_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.org_members mine
    join public.org_members theirs
      on theirs.org_id = mine.org_id
     and theirs.user_id = p_user_id
     and theirs.status = 'active'
    where mine.user_id = auth.uid()
      and mine.status = 'active'
  );
$$;

grant execute on function private.shares_org_with(uuid) to authenticated;

create policy "org co-members can view teammate profiles"
  on public.profiles for select
  using (private.shares_org_with(user_id));

-- 4. Lock down the signup-trigger-only helper --------------------------------

revoke execute on function private.ensure_org_for_user(uuid) from public, authenticated;

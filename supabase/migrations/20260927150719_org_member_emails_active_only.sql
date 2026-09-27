-- MISSION-5 TASK-M5-A3 fix-forward (eng2 review, BLOCKER 1, audit/M5-A3/review-eng2.md):
-- `org_member_emails` had no status filter at all -- it matched a 'removed' (or 'disabled')
-- member's email exactly the same as an 'active' one. Since `remove` never deletes the
-- `org_members` row (soft-remove, PK (org_id, user_id) still occupied forever), org-invite-
-- create's bulk-create loop reported `already_member` for that email PERMANENTLY, not just
-- during the 72h Restore window -- both paths back into the org (Restore, then re-invite) were
-- closed once the window lapsed, contradicting the migration's own "restorable for 72h, then
-- permanent" comment (20260927080002:30-38), which meant "the Restore button goes away", not
-- "this person can never be a member of this org again".
--
-- Fix: filter to `status = 'active'` (not `status != 'removed'`) -- matches every other place
-- this codebase already decides "is this person actually a member for this purpose"
-- (private.is_org_member/has_org_role, requireOrgRole, team_live_board's own `members` CTE) --
-- this was the one place that didn't. A 'disabled' member's email is now also re-invitable
-- (BLOCKER 2's own fix-forward, org-invite-accept/index.ts, refuses to silently reactivate a
-- disabled member via accept -- an admin still has to explicitly `enable` them first; this
-- migration only changes whether a FRESH invite can be CREATED for that email, not what
-- accepting one does).
--
-- Same signature/return type -- create or replace is enough, no drop+recreate needed.

create or replace function public.org_member_emails(p_org uuid)
returns table (user_id uuid, email text)
language sql
security definer
stable
set search_path = ''
as $$
  select au.id, au.email
  from auth.users au
  join public.org_members om on om.user_id = au.id
  where om.org_id = p_org
    and om.status = 'active';
$$;

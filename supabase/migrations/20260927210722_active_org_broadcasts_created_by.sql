-- MISSION-5 follow-up (eng2 review of TeamGoalsAndBroadcastPanel, 74e26af): the manage-broadcasts
-- list needs to tell "my own pod_id-null broadcast" (a manager may delete it) from "someone
-- else's" (delete_org_broadcast rejects it: "only the poster or an owner/admin ...") so the UI
-- can hide/disable Delete exactly where the server would reject it, instead of a manager hitting
-- a confusing failed round-trip on a broadcast they can plainly see. `created_by` already exists
-- on org_broadcasts (every writer sets it) -- this just widens the read RPC to expose it. Additive
-- only: existing callers that don't destructure the new column are unaffected.

-- The OUT columns change, so create or replace alone fails with 42P13 (lead dry-run): drop first.
drop function if exists public.active_org_broadcasts(uuid);

create or replace function public.active_org_broadcasts(p_org uuid)
returns table (
  id uuid,
  message text,
  pod_id uuid,
  created_at timestamptz,
  expires_at timestamptz,
  created_by uuid
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_pod_id uuid;
begin
  if not private.is_org_member(p_org) then
    return;
  end if;

  select m.pod_id into v_pod_id
  from public.org_members m
  where m.org_id = p_org and m.user_id = v_caller;

  return query
  select b.id, b.message, b.pod_id, b.created_at, b.expires_at, b.created_by
  from public.org_broadcasts b
  where b.org_id = p_org
    and (b.expires_at is null or b.expires_at > now())
    and (
      b.pod_id is null
      or b.pod_id = v_pod_id
      or b.created_by = v_caller
      or exists (
        select 1 from public.org_manager_pods mp
        where mp.org_id = p_org and mp.manager_user_id = v_caller and mp.pod_id = b.pod_id
      )
    )
    and not exists (
      select 1 from public.org_broadcast_dismissals d
      where d.broadcast_id = b.id and d.user_id = v_caller
    )
  order by b.created_at desc;
end;
$$;

revoke all on function public.active_org_broadcasts(uuid) from public, anon;
grant execute on function public.active_org_broadcasts(uuid) to authenticated;

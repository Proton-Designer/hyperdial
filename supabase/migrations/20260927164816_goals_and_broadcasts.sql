-- MISSION-5 TASK-M5-A6: daily goals (org/pod/agent, most-specific-wins) + team broadcasts.
--
-- Goals: `org_goals` holds the CURRENT standing daily target per (scope, metric) -- not a
-- historical log, an upsert-in-place row per scope-key+metric (a partial unique index per scope
-- tier enforces "one row per org-level metric", "one row per pod+metric", "one row per
-- agent+metric"). All writes go through `set_org_goal`/`delete_org_goal` (SECURITY DEFINER, no
-- client insert/update/delete policy at all -- same convention as org_audit_log's own writer gate,
-- 20260927080000) because the manager-tier pod-scope check on a WRITE is easier to express as
-- plpgsql than as a single RLS WITH CHECK expression. Reads are two-tier: `my_goal_targets`
-- resolves the CALLER's own effective target per metric (any org member, self-view, same trust
-- model as `agent_self_stats`); `team_goal_targets` resolves every pod-scoped agent's effective
-- target for the Team page (owner/admin/manager, same role gate + `is_agent_in_callers_pod_scope`
-- composition as `team_daily_stats`/`team_live_board`). Actual counts for both surfaces come from
-- the EXISTING `agent_self_stats`/`team_daily_stats` RPCs (today's window) -- this migration adds
-- no new aggregation over call_legs/dial_sessions, only the target side.
--
-- Broadcasts: `org_broadcasts` (org-wide when pod_id is null, else one pod) + a per-viewer
-- `org_broadcast_dismissals` join table. Posting/removing go through `create_org_broadcast`/
-- `delete_org_broadcast` (SECURITY DEFINER, same pod-scope-on-write pattern as goals); dismissing
-- is a plain client-side insert into `org_broadcast_dismissals` (RLS: a caller may only touch
-- their OWN dismissal rows -- no privileged check needed, so no RPC required). `active_org_
-- broadcasts` is the one read path agents use (Dialer): pre-filtered to non-expired, pod-visible-
-- to-caller, not-yet-dismissed rows, so the client never has to reconstruct that logic itself.

-- =================================================================================================
-- 1. org_goals
-- =================================================================================================

create table public.org_goals (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  scope text not null check (scope in ('org', 'pod', 'agent')),
  pod_id uuid references public.org_pods(id) on delete cascade,
  agent_user_id uuid references auth.users(id) on delete cascade,
  metric text not null check (metric in ('dials', 'conversations', 'wins', 'talk_minutes')),
  target_value int not null check (target_value > 0),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint org_goals_scope_key_shape check (
    (scope = 'org' and pod_id is null and agent_user_id is null)
    or (scope = 'pod' and pod_id is not null and agent_user_id is null)
    or (scope = 'agent' and pod_id is null and agent_user_id is not null)
  )
);

-- One standing row per scope-key+metric -- `set_org_goal` upserts against these.
create unique index org_goals_org_metric_uq on public.org_goals(org_id, metric) where scope = 'org';
create unique index org_goals_pod_metric_uq on public.org_goals(org_id, pod_id, metric) where scope = 'pod';
create unique index org_goals_agent_metric_uq on public.org_goals(org_id, agent_user_id, metric) where scope = 'agent';

alter table public.org_goals enable row level security;

-- Owner/admin see every goal; a manager sees org-wide goals (context) plus pod/agent goals inside
-- their OWN supervision scope; any agent may see their own agent-level row directly (a convenience
-- for a future "your goal" readout -- `my_goal_targets` is still the primary read path since it
-- resolves most-specific-wins server-side).
create policy "owner/admin see all goals, manager sees their scope, an agent sees their own row"
  on public.org_goals for select
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (
      private.has_org_role(org_id, array['manager'])
      and (
        scope = 'org'
        or (scope = 'pod' and exists (
          select 1 from public.org_manager_pods mp
          where mp.org_id = org_goals.org_id and mp.manager_user_id = auth.uid() and mp.pod_id = org_goals.pod_id
        ))
        or (scope = 'agent' and private.is_agent_in_callers_pod_scope(org_id, agent_user_id))
      )
    )
    or (scope = 'agent' and agent_user_id = auth.uid())
  );

-- No insert/update/delete policy for any client role -- see header (`set_org_goal`/
-- `delete_org_goal` are the only writers, same lockdown as `org_audit_log`).

revoke all on public.org_goals from anon;

-- =================================================================================================
-- 2. set_org_goal / delete_org_goal
-- =================================================================================================

create function public.set_org_goal(
  p_org uuid,
  p_scope text,
  p_pod_id uuid,
  p_agent_user_id uuid,
  p_metric text,
  p_target int
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_is_owner_admin boolean;
  v_is_manager boolean;
  v_goal_id uuid;
begin
  v_is_owner_admin := private.has_org_role(p_org, array['owner', 'admin']);
  v_is_manager := private.has_org_role(p_org, array['manager']);
  if not v_is_owner_admin and not v_is_manager then
    raise exception 'only an owner, admin, or manager can set goals';
  end if;

  if p_scope not in ('org', 'pod', 'agent') then
    raise exception 'invalid scope';
  end if;
  if p_metric not in ('dials', 'conversations', 'wins', 'talk_minutes') then
    raise exception 'invalid metric';
  end if;
  if p_target is null or p_target <= 0 then
    raise exception 'target must be a positive whole number';
  end if;

  if p_scope = 'org' then
    if p_pod_id is not null or p_agent_user_id is not null then
      raise exception 'an org-level goal must not set a pod or agent';
    end if;
    if not v_is_owner_admin then
      raise exception 'only an owner or admin can set an org-wide goal';
    end if;

    insert into public.org_goals (org_id, scope, metric, target_value, created_by)
    values (p_org, 'org', p_metric, p_target, auth.uid())
    on conflict (org_id, metric) where scope = 'org'
    do update set target_value = excluded.target_value, updated_at = now()
    returning id into v_goal_id;

  elsif p_scope = 'pod' then
    if p_pod_id is null or p_agent_user_id is not null then
      raise exception 'a pod-level goal must set a pod and no agent';
    end if;
    if not exists (select 1 from public.org_pods where id = p_pod_id and org_id = p_org) then
      raise exception 'pod not found';
    end if;
    if not v_is_owner_admin and not exists (
      select 1 from public.org_manager_pods
      where org_id = p_org and manager_user_id = auth.uid() and pod_id = p_pod_id
    ) then
      raise exception 'that pod is outside your managed pods';
    end if;

    insert into public.org_goals (org_id, scope, pod_id, metric, target_value, created_by)
    values (p_org, 'pod', p_pod_id, p_metric, p_target, auth.uid())
    on conflict (org_id, pod_id, metric) where scope = 'pod'
    do update set target_value = excluded.target_value, updated_at = now()
    returning id into v_goal_id;

  else -- agent
    if p_agent_user_id is null or p_pod_id is not null then
      raise exception 'an agent-level goal must set an agent and no pod';
    end if;
    if not exists (
      select 1 from public.org_members
      where org_id = p_org and user_id = p_agent_user_id and status = 'active'
    ) then
      raise exception 'agent not found in this org';
    end if;
    if not v_is_owner_admin and not private.is_agent_in_callers_pod_scope(p_org, p_agent_user_id) then
      raise exception 'that agent is outside your managed pods';
    end if;

    insert into public.org_goals (org_id, scope, agent_user_id, metric, target_value, created_by)
    values (p_org, 'agent', p_agent_user_id, p_metric, p_target, auth.uid())
    on conflict (org_id, agent_user_id, metric) where scope = 'agent'
    do update set target_value = excluded.target_value, updated_at = now()
    returning id into v_goal_id;
  end if;

  perform private.log_org_action(
    p_org, 'goal.set', 'org_goal', v_goal_id,
    jsonb_build_object('scope', p_scope, 'pod_id', p_pod_id, 'agent_user_id', p_agent_user_id,
      'metric', p_metric, 'target', p_target)
  );

  return v_goal_id;
end;
$$;

revoke all on function public.set_org_goal(uuid, text, uuid, uuid, text, int) from public, anon;
grant execute on function public.set_org_goal(uuid, text, uuid, uuid, text, int) to authenticated;

create function public.delete_org_goal(p_org uuid, p_goal_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text;
  v_pod_id uuid;
  v_agent_user_id uuid;
  v_is_owner_admin boolean;
begin
  select scope, pod_id, agent_user_id into v_scope, v_pod_id, v_agent_user_id
  from public.org_goals
  where id = p_goal_id and org_id = p_org;

  if v_scope is null then
    raise exception 'goal not found';
  end if;

  v_is_owner_admin := private.has_org_role(p_org, array['owner', 'admin']);
  if not v_is_owner_admin then
    if not private.has_org_role(p_org, array['manager']) then
      raise exception 'only an owner, admin, or manager can remove a goal';
    end if;
    if v_scope = 'org' then
      raise exception 'only an owner or admin can remove an org-wide goal';
    end if;
    if v_scope = 'pod' and not exists (
      select 1 from public.org_manager_pods
      where org_id = p_org and manager_user_id = auth.uid() and pod_id = v_pod_id
    ) then
      raise exception 'that pod is outside your managed pods';
    end if;
    if v_scope = 'agent' and not private.is_agent_in_callers_pod_scope(p_org, v_agent_user_id) then
      raise exception 'that agent is outside your managed pods';
    end if;
  end if;

  delete from public.org_goals where id = p_goal_id and org_id = p_org;

  perform private.log_org_action(p_org, 'goal.delete', 'org_goal', p_goal_id, '{}'::jsonb);
end;
$$;

revoke all on function public.delete_org_goal(uuid, uuid) from public, anon;
grant execute on function public.delete_org_goal(uuid, uuid) to authenticated;

-- =================================================================================================
-- 3. my_goal_targets / team_goal_targets: resolve most-specific-wins (agent > pod > org) per
--    metric. Actual counts still come from `agent_self_stats`/`team_daily_stats` -- these two
--    return ONLY the target side, joined by agent_id client-side (same separate-RPCs-joined-by-
--    agent_id shape as team_live_board/team_daily_stats/agent_time_in_state already use).
-- =================================================================================================

create function public.my_goal_targets(p_org uuid)
returns table (
  dials_goal int,
  conversations_goal int,
  wins_goal int,
  talk_minutes_goal int
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
  with metrics(metric) as (
    values ('dials'), ('conversations'), ('wins'), ('talk_minutes')
  ),
  resolved as (
    select
      me.metric,
      coalesce(
        max(g.target_value) filter (where g.scope = 'agent'),
        max(g.target_value) filter (where g.scope = 'pod'),
        max(g.target_value) filter (where g.scope = 'org')
      ) as target
    from metrics me
    left join public.org_goals g
      on g.org_id = p_org
      and g.metric = me.metric
      and (
        (g.scope = 'agent' and g.agent_user_id = v_caller)
        or (g.scope = 'pod' and v_pod_id is not null and g.pod_id = v_pod_id)
        or (g.scope = 'org')
      )
    group by me.metric
  )
  select
    max(target) filter (where metric = 'dials'),
    max(target) filter (where metric = 'conversations'),
    max(target) filter (where metric = 'wins'),
    max(target) filter (where metric = 'talk_minutes')
  from resolved;
end;
$$;

revoke all on function public.my_goal_targets(uuid) from public, anon;
grant execute on function public.my_goal_targets(uuid) to authenticated;

create function public.team_goal_targets(p_org uuid)
returns table (
  agent_id uuid,
  dials_goal int,
  conversations_goal int,
  wins_goal int,
  talk_minutes_goal int
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    return;
  end if;

  return query
  with members as (
    select m.user_id, m.pod_id
    from public.org_members m
    where m.org_id = p_org and m.status = 'active'
      and private.is_agent_in_callers_pod_scope(p_org, m.user_id)
  ),
  metrics(metric) as (
    values ('dials'), ('conversations'), ('wins'), ('talk_minutes')
  ),
  per_agent_metric as (
    select
      mem.user_id as agent_id,
      me.metric,
      coalesce(
        max(g.target_value) filter (where g.scope = 'agent'),
        max(g.target_value) filter (where g.scope = 'pod'),
        max(g.target_value) filter (where g.scope = 'org')
      ) as target
    from members mem
    cross join metrics me
    left join public.org_goals g
      on g.org_id = p_org
      and g.metric = me.metric
      and (
        (g.scope = 'agent' and g.agent_user_id = mem.user_id)
        or (g.scope = 'pod' and mem.pod_id is not null and g.pod_id = mem.pod_id)
        or (g.scope = 'org')
      )
    group by mem.user_id, me.metric
  )
  select
    pam.agent_id,
    max(pam.target) filter (where pam.metric = 'dials'),
    max(pam.target) filter (where pam.metric = 'conversations'),
    max(pam.target) filter (where pam.metric = 'wins'),
    max(pam.target) filter (where pam.metric = 'talk_minutes')
  from per_agent_metric pam
  group by pam.agent_id;
end;
$$;

revoke all on function public.team_goal_targets(uuid) from public, anon;
grant execute on function public.team_goal_targets(uuid) to authenticated;

-- =================================================================================================
-- 4. org_broadcasts + org_broadcast_dismissals
-- =================================================================================================

create table public.org_broadcasts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  pod_id uuid references public.org_pods(id) on delete cascade, -- null = everyone
  message text not null check (char_length(message) between 1 and 1000),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index org_broadcasts_org_created_idx on public.org_broadcasts(org_id, created_at desc);
create index org_broadcasts_pod_idx on public.org_broadcasts(org_id, pod_id);

alter table public.org_broadcasts enable row level security;

-- Fix-forward (fix-A6, live dry-run 31/32, real failure): the original policy only matched a
-- manager's ROSTER pod (org_members.pod_id) -- a manager's actual SCOPE (which pod(s) they may
-- post to/manage) is org_manager_pods, a separate relationship (same distinction org_goals'
-- policy already got right from the start, see its own header). A manager posting to a pod they
-- supervise but aren't a roster member of couldn't see their own just-created broadcast. Added:
-- created_by = auth.uid() (a poster can always see their own post, any pod) and the
-- org_manager_pods branch (mirrors org_goals' policy exactly).
create policy "org members see broadcasts for everyone or their own pod; owner/admin see all"
  on public.org_broadcasts for select
  using (
    private.is_org_member(org_id)
    and (
      pod_id is null
      or private.has_org_role(org_id, array['owner', 'admin'])
      or created_by = auth.uid()
      or exists (
        select 1 from public.org_members m
        where m.org_id = org_broadcasts.org_id and m.user_id = auth.uid() and m.pod_id = org_broadcasts.pod_id
      )
      or exists (
        select 1 from public.org_manager_pods mp
        where mp.org_id = org_broadcasts.org_id and mp.manager_user_id = auth.uid() and mp.pod_id = org_broadcasts.pod_id
      )
    )
  );

-- No insert/update/delete policy -- `create_org_broadcast`/`delete_org_broadcast` are the only
-- writers (same pod-scope-on-write reasoning as org_goals above).

revoke all on public.org_broadcasts from anon;

create table public.org_broadcast_dismissals (
  broadcast_id uuid not null references public.org_broadcasts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  dismissed_at timestamptz not null default now(),
  primary key (broadcast_id, user_id)
);

create index org_broadcast_dismissals_user_idx on public.org_broadcast_dismissals(user_id);

alter table public.org_broadcast_dismissals enable row level security;

-- A caller manages only their OWN dismissal rows -- no privileged check needed (dismissing a
-- broadcast_id you can't otherwise see is harmless: it's just a row nobody ever reads back for
-- you), so this is a plain client insert, no RPC required.
create policy "a user manages their own dismissals"
  on public.org_broadcast_dismissals for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

revoke all on public.org_broadcast_dismissals from anon;

-- =================================================================================================
-- 5. create_org_broadcast / delete_org_broadcast / active_org_broadcasts
-- =================================================================================================

create function public.create_org_broadcast(
  p_org uuid,
  p_pod_id uuid,
  p_message text,
  p_expires_at timestamptz default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_message text := btrim(coalesce(p_message, ''));
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    raise exception 'only an owner, admin, or manager can post a broadcast';
  end if;

  if char_length(v_message) = 0 then
    raise exception 'message is required';
  end if;
  if char_length(v_message) > 1000 then
    raise exception 'message is too long';
  end if;
  if p_expires_at is not null and p_expires_at <= now() then
    raise exception 'expiry must be in the future';
  end if;

  if p_pod_id is not null then
    if not exists (select 1 from public.org_pods where id = p_pod_id and org_id = p_org) then
      raise exception 'pod not found';
    end if;
    if not private.has_org_role(p_org, array['owner', 'admin']) and not exists (
      select 1 from public.org_manager_pods
      where org_id = p_org and manager_user_id = auth.uid() and pod_id = p_pod_id
    ) then
      raise exception 'that pod is outside your managed pods';
    end if;
  end if;

  insert into public.org_broadcasts (org_id, pod_id, message, expires_at, created_by)
  values (p_org, p_pod_id, v_message, p_expires_at, auth.uid())
  returning id into v_id;

  perform private.log_org_action(
    p_org, 'broadcast.create', 'org_broadcast', v_id,
    jsonb_build_object('pod_id', p_pod_id, 'message', v_message, 'expires_at', p_expires_at)
  );

  return v_id;
end;
$$;

revoke all on function public.create_org_broadcast(uuid, uuid, text, timestamptz) from public, anon;
grant execute on function public.create_org_broadcast(uuid, uuid, text, timestamptz) to authenticated;

create function public.delete_org_broadcast(p_org uuid, p_broadcast_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_created_by uuid;
  v_found boolean;
begin
  select true, created_by into v_found, v_created_by
  from public.org_broadcasts
  where id = p_broadcast_id and org_id = p_org;

  if v_found is null then
    raise exception 'broadcast not found';
  end if;

  if not private.has_org_role(p_org, array['owner', 'admin'])
     and v_created_by is distinct from auth.uid() then
    raise exception 'only the poster or an owner/admin can remove this broadcast';
  end if;

  delete from public.org_broadcasts where id = p_broadcast_id and org_id = p_org;

  perform private.log_org_action(p_org, 'broadcast.delete', 'org_broadcast', p_broadcast_id, '{}'::jsonb);
end;
$$;

revoke all on function public.delete_org_broadcast(uuid, uuid) from public, anon;
grant execute on function public.delete_org_broadcast(uuid, uuid) to authenticated;

create function public.active_org_broadcasts(p_org uuid)
returns table (
  id uuid,
  message text,
  pod_id uuid,
  created_at timestamptz,
  expires_at timestamptz
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
  select b.id, b.message, b.pod_id, b.created_at, b.expires_at
  from public.org_broadcasts b
  where b.org_id = p_org
    and (b.expires_at is null or b.expires_at > now())
    and (
      b.pod_id is null
      or b.pod_id = v_pod_id
      or b.created_by = v_caller
      -- fix-A6: same org_manager_pods gap as the table's own SELECT policy -- a manager viewing
      -- their own feed should also see a broadcast targeting a pod they supervise, even when
      -- they aren't a roster member of it (mem.pod_id above only covers roster membership).
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

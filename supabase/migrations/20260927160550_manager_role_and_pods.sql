-- MISSION-5 TASK-M5-A5: manager role + pods, server-enforced scope.
--
-- A manager can see the Team page, coach, assign leads, see reports and the audit log for their
-- own scope; they cannot buy numbers, change billing/spend, change roles, or edit org settings
-- (those stay owner/admin-only everywhere -- this migration never widens any of THOSE checks).
--
-- Two distinct relationships, on purpose (see RESUME_PLAN-eng1.md's own open question, resolved
-- here): `org_members.pod_id` is the single pod an AGENT (or manager) belongs to as a member of
-- the roster -- zero or one, the task never asks for multi-pod membership for an agent. A
-- manager's OWN scope ("a manager may be limited to one or more pods") is a SEPARATE many-to-many
-- relationship, `org_manager_pods` -- which pods a given manager may see/act on, independent of
-- which single pod (if any) that manager's own `org_members` row happens to sit in.
--
-- Scope is enforced through one new helper, `private.is_agent_in_callers_pod_scope(org, agent)`:
-- true unconditionally for an owner/admin caller (full visibility, unchanged), true for a manager
-- caller when the target agent's `pod_id` is one of the manager's own rows in `org_manager_pods`,
-- false otherwise (including for a plain agent caller -- callers already fall back to an explicit
-- own-row check where that's the intended behavior, e.g. agent_time_in_state's self-view path;
-- this helper's job is ONLY the owner/admin/manager tiers). Layered into every touch point the
-- task names that lives in THIS lane: team_live_board, team_daily_stats, agent_time_in_state
-- (mine, A4), assign_campaign_leads (eng2's B3 RPC -- widened here via a further `create or
-- replace` on the SAME signature, not by touching B3's own migration file), org-audit-log and
-- org-members' roster GET (both edge functions, this file only does the SQL half).
--
-- Explicitly NOT touched here (deferred, coordinate once landed -- see RESUME_PLAN/LANE):
-- coaching-core.ts and remote pause/stop (dialer-engine.ts) are eng2's ACTIVE, uncommitted B2 WIP
-- (TASK-M5-B2, "remote actions: owner/admin; manager after A5") -- B2's own task file already
-- says "manager after A5", i.e. B2 ships owner/admin-only first and picks up manager+pod scoping
-- in a follow-up once B2 lands, the same non-destructive layering convention as everything else
-- in this file. Coaching/remote-pause manager scoping is NOT part of this migration.

-- =================================================================================================
-- 1. org_pods + org_members.pod_id + org_manager_pods
-- =================================================================================================

create table public.org_pods (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now(),
  unique (org_id, name)
);

alter table public.org_pods enable row level security;

create policy "org members can view pods"
  on public.org_pods for select
  using (private.is_org_member(org_id));

create policy "owner or admin can manage pods"
  on public.org_pods for all
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.org_pods from anon;

alter table public.org_members add column pod_id uuid references public.org_pods(id) on delete set null;
create index idx_org_members_pod_id on public.org_members(pod_id);

-- A manager's own scope: which pods they may see/act on. Many-to-many on purpose (see header) --
-- an agent's own `org_members.pod_id` above is a DIFFERENT, single-valued relationship.
create table public.org_manager_pods (
  org_id uuid not null references public.orgs(id) on delete cascade,
  manager_user_id uuid not null references auth.users(id) on delete cascade,
  pod_id uuid not null references public.org_pods(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (manager_user_id, pod_id)
);

create index idx_org_manager_pods_org_pod on public.org_manager_pods(org_id, pod_id);

alter table public.org_manager_pods enable row level security;

-- A manager may read their OWN scope (Team.tsx needs this to render "your pods"); owner/admin see
-- every manager's scope (Settings -> Team's pod-management UI).
create policy "a manager can view their own pod scope, owner/admin see all"
  on public.org_manager_pods for select
  using (
    manager_user_id = auth.uid()
    or private.has_org_role(org_id, array['owner', 'admin'])
  );

create policy "owner or admin can manage manager pod scope"
  on public.org_manager_pods for all
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.org_manager_pods from anon;

-- =================================================================================================
-- 2. role = 'manager' (org_members + org_invites)
-- =================================================================================================

alter table public.org_members drop constraint org_members_role_check;
alter table public.org_members add constraint org_members_role_check
  check (role in ('owner', 'admin', 'agent', 'manager'));

alter table public.org_invites drop constraint org_invites_role_check;
alter table public.org_invites add constraint org_invites_role_check
  check (role in ('owner', 'admin', 'agent', 'manager'));

-- =================================================================================================
-- 3. private.is_agent_in_callers_pod_scope: the one new RLS/RPC scoping primitive every touch
--    point below composes with. See header for the exact semantics.
-- =================================================================================================

create function private.is_agent_in_callers_pod_scope(org uuid, agent uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    private.has_org_role(org, array['owner', 'admin'])
    or exists (
      select 1
      from public.org_members m
      join public.org_manager_pods mp
        on mp.org_id = m.org_id and mp.pod_id = m.pod_id
      where m.org_id = org
        and m.user_id = agent
        and m.status = 'active'
        and mp.manager_user_id = auth.uid()
    );
$$;

grant execute on function private.is_agent_in_callers_pod_scope(uuid, uuid) to authenticated;

-- =================================================================================================
-- 4. team_live_board: widen the role gate to include 'manager'; pod-scope the `members` CTE;
--    add pod_id/pod_name to the output. STARTS FROM eng2's B2 shape (uncommitted at the time of
--    writing, 20260927151747_supervisor_controls.sql), which already added session_id and
--    raised_hand_at ahead of this migration in replay order -- rewriting from the OLDER A4 body
--    would silently drop those two columns the moment B2 lands. (Lead heads-up, R-037: read B2's
--    in-tree file, never edit it -- this is exactly that read, not a touch of their migration.)
--    Return-type change either way -- DROP + recreate, grants repeated verbatim.
-- =================================================================================================

drop function public.team_live_board(uuid);

create function public.team_live_board(p_org uuid)
returns table (
  agent_id uuid,
  name text,
  role text,
  status text,
  lines smallint,
  contact_name text,
  state_since timestamptz,
  session_started_at timestamptz,
  calls_today integer,
  conversations_today integer,
  pause_reason text,
  campaign_id uuid,
  campaign_name text,
  session_id uuid,
  raised_hand_at timestamptz,
  pod_id uuid,
  pod_name text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_today_start timestamptz;
  v_today_end timestamptz;
  v_tz text;
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    return;
  end if;

  select coalesce(ots.timezone, 'America/Chicago') into v_tz
  from public.org_timezone_settings ots
  where ots.org_id = p_org;
  v_tz := coalesce(v_tz, 'America/Chicago');

  v_today_start := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  v_today_end := v_today_start + interval '1 day';

  return query
  with members as (
    select
      m.user_id,
      m.role as member_role,
      m.pod_id,
      coalesce(
        nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
        u.email,
        'Member'
      ) as full_name
    from public.org_members m
    left join public.profiles p on p.user_id = m.user_id
    left join auth.users u on u.id = m.user_id
    where m.org_id = p_org
      and m.status = 'active'
      -- MISSION-5 TASK-M5-A5: owner/admin unchanged (helper always true for them); a manager
      -- caller only sees agents in their own managed pods.
      and private.is_agent_in_callers_pod_scope(p_org, m.user_id)
  ),
  current_session as (
    select distinct on (ds.agent_id)
      ds.id, ds.agent_id, ds.state, ds.lines, ds.started_at, ds.updated_at, ds.active_leg_id,
      ds.pause_reason, ds.campaign_id, ds.raised_hand_at
    from public.dial_sessions ds
    where ds.org_id = p_org
      and ds.state not in ('stopped', 'completed')
    order by ds.agent_id, ds.started_at desc
  ),
  today_legs as (
    select
      ds.agent_id,
      count(*) as calls_today,
      count(*) filter (where cl.outcome = 'connected' and cl.duration_seconds >= 30) as conversations_today
    from public.call_legs cl
    join public.dial_sessions ds on ds.id = cl.session_id
    where cl.org_id = p_org
      and cl.kind = 'contact'
      and cl.created_at >= v_today_start
      and cl.created_at < v_today_end
    group by ds.agent_id
  )
  select
    mem.user_id,
    mem.full_name,
    mem.member_role,
    case
      when cs.agent_id is null then 'offline'
      when cs.state in ('ready_pending', 'ready') then 'ready'
      when cs.state in ('dialing', 'connecting') then 'dialing'
      when cs.state = 'on_call' then 'on_call'
      when cs.state = 'wrap_up' then 'wrap_up'
      when cs.state in ('paused', 'paused_agent_lost') then 'paused'
      else 'offline'
    end,
    cs.lines,
    nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
    cs.updated_at,
    cs.started_at,
    coalesce(tl.calls_today, 0)::int,
    coalesce(tl.conversations_today, 0)::int,
    case when cs.state in ('paused', 'paused_agent_lost') then cs.pause_reason else null end,
    cs.campaign_id,
    camp.name,
    cs.id,
    cs.raised_hand_at,
    mem.pod_id,
    pod.name
  from members mem
  left join current_session cs on cs.agent_id = mem.user_id
  left join public.call_legs al on al.id = cs.active_leg_id
  left join public.contacts c on c.id = al.contact_id
  left join public.campaigns camp on camp.id = cs.campaign_id
  left join public.org_pods pod on pod.id = mem.pod_id
  left join today_legs tl on tl.agent_id = mem.user_id
  order by mem.full_name;
end;
$$;

revoke all on function public.team_live_board(uuid) from public, anon;
grant execute on function public.team_live_board(uuid) to authenticated;

-- =================================================================================================
-- 5. team_daily_stats: widen the role gate; pod-scope the `members` CTE. Same signature/return
--    type as before -- `create or replace` is enough, no drop+recreate needed.
-- =================================================================================================

create or replace function public.team_daily_stats(p_org uuid, p_start timestamptz, p_end timestamptz)
returns table (
  agent_id uuid,
  name text,
  role text,
  dials integer,
  connects integer,
  connect_rate numeric,
  conversations integer,
  conversations_per_hr numeric,
  wins integer,
  callbacks_set integer,
  talk_time_seconds integer,
  dialing_hours numeric
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
    select
      m.user_id,
      m.role as member_role,
      coalesce(
        nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
        u.email,
        'Member'
      ) as full_name
    from public.org_members m
    left join public.profiles p on p.user_id = m.user_id
    left join auth.users u on u.id = m.user_id
    where m.org_id = p_org
      and private.is_agent_in_callers_pod_scope(p_org, m.user_id)
      and (
        m.status = 'active'
        or exists (
          select 1 from public.dial_sessions ds2
          where ds2.org_id = p_org
            and ds2.agent_id = m.user_id
            and ds2.started_at < p_end
            and coalesce(ds2.ended_at, now()) > p_start
        )
      )
  ),
  legs as (
    select ds.agent_id, cl.outcome, cl.duration_seconds, cl.disposition_id
    from public.call_legs cl
    join public.dial_sessions ds on ds.id = cl.session_id
    where cl.org_id = p_org
      and cl.kind = 'contact'
      and cl.created_at >= p_start
      and cl.created_at < p_end
  ),
  agg as (
    select
      l.agent_id,
      count(*) as dials,
      count(*) filter (where l.outcome = 'connected') as connects,
      count(*) filter (where l.outcome = 'connected' and l.duration_seconds >= 30) as conversations,
      coalesce(sum(l.duration_seconds) filter (where l.outcome = 'connected'), 0) as talk_time_seconds,
      count(*) filter (where d.is_win) as wins,
      count(*) filter (where d.lead_effect = 'callback') as callbacks_set
    from legs l
    left join public.dispositions d on d.id = l.disposition_id
    group by l.agent_id
  ),
  hours as (
    select
      ds.agent_id,
      coalesce(sum(
        extract(epoch from (
          least(coalesce(ds.ended_at, now()), p_end) - greatest(ds.started_at, p_start)
        )) / 3600.0
      ), 0) as dialing_hours
    from public.dial_sessions ds
    where ds.org_id = p_org
      and ds.started_at < p_end
      and coalesce(ds.ended_at, now()) > p_start
    group by ds.agent_id
  )
  select
    mem.user_id,
    mem.full_name,
    mem.member_role,
    coalesce(a.dials, 0)::int,
    coalesce(a.connects, 0)::int,
    case when coalesce(a.dials, 0) > 0
      then round((coalesce(a.connects, 0)::numeric / a.dials) * 1000) / 10
      else 0
    end,
    coalesce(a.conversations, 0)::int,
    case when coalesce(h.dialing_hours, 0) >= 0.1
      then round((coalesce(a.conversations, 0)::numeric / h.dialing_hours) * 100) / 100
      else null
    end,
    coalesce(a.wins, 0)::int,
    coalesce(a.callbacks_set, 0)::int,
    coalesce(a.talk_time_seconds, 0)::int,
    round(coalesce(h.dialing_hours, 0)::numeric, 2)
  from members mem
  left join agg a on a.agent_id = mem.user_id
  left join hours h on h.agent_id = mem.user_id
  order by mem.full_name;
end;
$$;

-- =================================================================================================
-- 6. agent_time_in_state: widen the role gate to include 'manager'; pod-scope the `events` CTE,
--    composed with the existing agent-self-view path (unchanged). Same signature/return type.
-- =================================================================================================

create or replace function public.agent_time_in_state(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_agent uuid default null,
  p_tz text default 'America/Chicago'
)
returns table (
  agent_id uuid,
  day date,
  state text,
  reason text,
  seconds bigint
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    -- Unchanged from A4/fix-A4(privacy): an agent may query ONLY their own rows, p_agent must be
    -- exactly their own auth.uid() -- never null, never someone else's -- or this fails closed.
    if not private.has_org_role(p_org, array['agent'])
      or p_agent is null
      or p_agent is distinct from auth.uid()
    then
      return;
    end if;
  end if;

  return query
  with events as (
    select
      e.agent_id,
      e.state,
      e.reason,
      least(coalesce(e.ended_at, now()), p_to) as clipped_end,
      greatest(e.started_at, p_from) as clipped_start
    from public.agent_state_events e
    where e.org_id = p_org
      and (p_agent is null or e.agent_id = p_agent)
      and e.state not in ('stopped', 'completed')
      and e.started_at < p_to
      and coalesce(e.ended_at, now()) > p_from
      -- MISSION-5 TASK-M5-A5: row-level pod scope, defense-in-depth on top of the entrance guard
      -- above. `is_agent_in_callers_pod_scope` is unconditionally true for owner/admin and false
      -- for a plain agent caller (they're not a manager, no org_manager_pods row can ever match
      -- them) -- the explicit self-view OR-clause is what actually admits an agent's own rows.
      and (
        private.is_agent_in_callers_pod_scope(p_org, e.agent_id)
        or (private.has_org_role(p_org, array['agent']) and e.agent_id = auth.uid())
      )
  ),
  spanned_days as (
    select
      ev.agent_id, ev.state, ev.reason, ev.clipped_start, ev.clipped_end,
      d.day_start
    from events ev
    cross join lateral generate_series(
      date_trunc('day', ev.clipped_start at time zone p_tz),
      date_trunc('day', ev.clipped_end at time zone p_tz),
      interval '1 day'
    ) as d(day_start)
  )
  select
    sd.agent_id,
    (sd.day_start)::date as day,
    sd.state,
    sd.reason,
    sum(
      extract(epoch from (
        least(sd.clipped_end, (sd.day_start + interval '1 day') at time zone p_tz)
        - greatest(sd.clipped_start, sd.day_start at time zone p_tz)
      ))
    )::bigint as seconds
  from spanned_days sd
  group by sd.agent_id, (sd.day_start)::date, sd.state, sd.reason
  having sum(
      extract(epoch from (
        least(sd.clipped_end, (sd.day_start + interval '1 day') at time zone p_tz)
        - greatest(sd.clipped_start, sd.day_start at time zone p_tz)
      ))
    ) > 0
  order by 1, 2, 3;
end;
$$;

-- =================================================================================================
-- 7. assign_campaign_leads (eng2's B3 RPC, 20260927144500): widen the role gate to include
--    'manager', pod-scoping BOTH the target agent (p_agent_id) and, for mode=by_current_agent,
--    the source agent (p_filter.from_agent_id) -- a manager can only move leads between agents in
--    their own managed pods, never in or out of a pod they don't supervise. Layered via a further
--    `create or replace` on the SAME signature in MY OWN migration, per this lane's standing
--    non-destructive-layering convention -- eng2's own migration file is never touched.
-- =================================================================================================

create or replace function public.assign_campaign_leads(
  p_campaign_id uuid,
  p_agent_id uuid,
  p_filter jsonb default '{"mode": "all"}'::jsonb
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_mode text;
  v_count int;
  v_from_agent_id uuid;
  v_is_owner_admin boolean;
begin
  select org_id into v_org_id from public.campaigns where id = p_campaign_id;
  if v_org_id is null then
    raise exception 'campaign not found';
  end if;

  v_is_owner_admin := private.has_org_role(v_org_id, array['owner', 'admin']);
  if not v_is_owner_admin and not private.has_org_role(v_org_id, array['manager']) then
    raise exception 'only an owner, admin, or manager can assign leads';
  end if;

  if p_agent_id is not null and not exists (
    select 1 from public.org_members
    where org_id = v_org_id and user_id = p_agent_id and status = 'active'
  ) then
    raise exception 'target agent is not an active member of this org';
  end if;

  -- MISSION-5 TASK-M5-A5: a manager (not owner/admin) may only assign TO an agent in one of
  -- their own managed pods -- is_agent_in_callers_pod_scope already returns true unconditionally
  -- for owner/admin, so this only ever narrows a manager caller, never an owner/admin one.
  if p_agent_id is not null and not private.is_agent_in_callers_pod_scope(v_org_id, p_agent_id) then
    raise exception 'that agent is outside your managed pods';
  end if;

  if p_agent_id is not null then
    insert into public.campaign_agents (campaign_id, user_id, org_id)
    values (p_campaign_id, p_agent_id, v_org_id)
    on conflict (campaign_id, user_id) do nothing;
  end if;

  v_mode := coalesce(p_filter ->> 'mode', 'all');
  if v_mode not in ('all', 'range', 'percentage', 'tag', 'by_current_agent') then
    raise exception 'p_filter.mode must be one of: all, range, percentage, tag, by_current_agent';
  end if;

  if v_mode = 'by_current_agent' then
    v_from_agent_id := (p_filter ->> 'from_agent_id')::uuid;
    if v_from_agent_id is null then
      raise exception 'p_filter.from_agent_id is required for mode=by_current_agent';
    end if;
    -- Same pod-scope check as the target, applied to the SOURCE agent: a manager can't reach
    -- into a pod they don't supervise to pull leads out of it either.
    if not private.is_agent_in_callers_pod_scope(v_org_id, v_from_agent_id) then
      raise exception 'that agent is outside your managed pods';
    end if;
  end if;

  with ranked as (
    select
      cl2.id,
      cl2.assigned_agent_id,
      ct.ghl_tags,
      row_number() over (order by cl2.position) as rn,
      count(*) over () as total
    from public.campaign_leads cl2
    join public.contacts ct on ct.id = cl2.contact_id
    where cl2.campaign_id = p_campaign_id
      and (
        cl2.status = 'queued'
        or (v_mode = 'by_current_agent' and cl2.status = 'callback')
      )
  ),
  candidates as (
    select r.id
    from ranked r
    where (
      v_mode = 'all'
      or (v_mode = 'range'
        and r.rn between (p_filter ->> 'start')::int and (p_filter ->> 'end')::int)
      or (v_mode = 'percentage'
        and r.rn <= ceil(r.total * (p_filter ->> 'percentage')::numeric / 100))
      or (v_mode = 'tag' and r.ghl_tags && array[p_filter ->> 'tag'])
      or (v_mode = 'by_current_agent' and r.assigned_agent_id = v_from_agent_id)
    )
    -- MISSION-5 TASK-M5-A5 fix-forward (live dry-run BLOCKER): 'all'/'range'/'percentage'/'tag'
    -- match ANY currently-queued lead in the campaign, regardless of who (if anyone) already
    -- holds it -- a queued lead can already have an assigned_agent_id (assignment doesn't change
    -- status). Without this, a manager calling mode='all' targeting their own pod's agent would
    -- ALSO sweep up leads already assigned to a DIFFERENT pod's agent, reassigning them away --
    -- caught live: manager(pod X) assigning to agent(pod X) with mode='all' also grabbed a lead
    -- already held by agent(pod Y). A no-op for owner/admin (is_agent_in_callers_pod_scope is
    -- unconditionally true for them); for a manager, every mode may only touch a lead that is
    -- currently unassigned OR already held by an agent inside their OWN pod scope.
    and (
      r.assigned_agent_id is null
      or private.is_agent_in_callers_pod_scope(v_org_id, r.assigned_agent_id)
    )
  ),
  updated as (
    update public.campaign_leads cl
    set assigned_agent_id = p_agent_id, updated_at = now()
    from candidates
    where cl.id = candidates.id
      and cl.status in ('queued', 'callback')
    returning cl.id
  )
  select count(*) into v_count from updated;

  if v_count > 0 then
    perform private.log_org_action(
      v_org_id,
      'campaign_leads.assign',
      'campaign',
      p_campaign_id,
      jsonb_build_object(
        'agent_id', p_agent_id,
        'filter', p_filter,
        'lead_count', v_count
      )
    );
  end if;

  return v_count;
end;
$$;

revoke all on function public.assign_campaign_leads(uuid, uuid, jsonb) from public, anon;
grant execute on function public.assign_campaign_leads(uuid, uuid, jsonb) to authenticated;

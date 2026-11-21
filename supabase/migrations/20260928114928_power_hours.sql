-- MISSION-5 TASK-M5-E2: power hour / call blitz with a live sprint board.
-- industry-matrix.md E2: Kixie has a daily leaderboard; Orum has scheduled "call blitz" rooms, not
-- always org-wide. current-state.md: team_daily_stats has conversations_per_hr, but no named
-- sprint mode -- a manager wants "next 60 minutes, pod X, most conversations wins" with a live
-- board everyone watches. Design decisions (metric formulas, window column, per-dialing-hour
-- normalization, all 6 edge cases) are in audit/M5-E2/notes.md -- read that before touching this
-- file, don't re-derive it from scratch.
--
-- =================================================================================================
-- 1. power_hours -- one row per sprint. Scope shape reused verbatim from org_goals (20260927164816,
--    same mission): scope in ('org','pod') + nullable pod_id, tied together by a CHECK. No
--    automatic behavior of its own: create/cancel only, per the task's own closing line.
-- =================================================================================================

create table public.power_hours (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null,
  created_by uuid references auth.users(id) on delete set null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  scope text not null check (scope in ('org', 'pod')),
  pod_id uuid references public.org_pods(id) on delete cascade,
  metric text not null check (metric in ('conversations', 'connects', 'appointments')),
  target int check (target > 0),
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  constraint power_hours_scope_shape check (
    (scope = 'org' and pod_id is null) or (scope = 'pod' and pod_id is not null)
  ),
  constraint power_hours_duration check (
    ends_at > starts_at and ends_at <= starts_at + interval '4 hours'
  )
);

create index idx_power_hours_org_starts on public.power_hours(org_id, starts_at);

alter table public.power_hours enable row level security;

-- Requirement #1: "org members can read the ones in their scope". An org-scope row is visible to
-- any org member; a pod-scope row is visible to that pod's own active members (they're the
-- participants -- see notes.md's "Read path" section for why this must be MORE open than
-- org_goals's own agent-visibility model, which never shows a plain agent a pod-level row) or a
-- manager whose org_manager_pods covers it (same two-sided pod-scope check team_live_board's own
-- `members` CTE composes, just spelled out directly here since this is a plain SELECT policy, not
-- a SECURITY DEFINER function that can call is_agent_in_callers_pod_scope per-row).
create policy "org members can view power hours in their scope"
  on public.power_hours for select
  using (
    private.is_org_member(org_id)
    and (
      scope = 'org'
      or private.has_org_role(org_id, array['owner', 'admin'])
      or exists (
        select 1 from public.org_manager_pods mp
        where mp.org_id = power_hours.org_id
          and mp.manager_user_id = auth.uid()
          and mp.pod_id = power_hours.pod_id
      )
      or exists (
        select 1 from public.org_members m
        where m.org_id = power_hours.org_id
          and m.user_id = auth.uid()
          and m.status = 'active'
          and m.pod_id = power_hours.pod_id
      )
    )
  );

-- No insert/update/delete policy for any client role -- writes go through create_power_hour/
-- cancel_power_hour only (SECURITY DEFINER, same lockdown as org_goals/org_broadcasts), since the
-- manager pod-scope check on a write is easier to express as plpgsql than a WITH CHECK expression.
revoke all on public.power_hours from anon;

-- =================================================================================================
-- 2. create_power_hour / cancel_power_hour -- owner/admin any scope; a manager only for pods in
--    their own org_manager_pods. Same "v_is_owner_admin / v_is_manager" + per-scope branch shape
--    as set_org_goal/delete_org_goal (20260927164816) -- reused directly, not reinvented.
-- =================================================================================================

create function public.create_power_hour(
  p_org uuid,
  p_name text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_scope text,
  p_pod_id uuid,
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
  v_id uuid;
begin
  v_is_owner_admin := private.has_org_role(p_org, array['owner', 'admin']);
  v_is_manager := private.has_org_role(p_org, array['manager']);
  if not v_is_owner_admin and not v_is_manager then
    raise exception 'only an owner, admin, or manager can start a power hour';
  end if;

  if p_scope not in ('org', 'pod') then
    raise exception 'invalid scope';
  end if;
  if p_metric not in ('conversations', 'connects', 'appointments') then
    raise exception 'invalid metric';
  end if;
  if p_name is null or btrim(p_name) = '' then
    raise exception 'name is required';
  end if;
  if p_ends_at <= p_starts_at then
    raise exception 'ends_at must be after starts_at';
  end if;
  if p_ends_at > p_starts_at + interval '4 hours' then
    raise exception 'a power hour cannot run longer than 4 hours';
  end if;
  if p_target is not null and p_target <= 0 then
    raise exception 'target must be a positive whole number';
  end if;

  if p_scope = 'org' then
    if p_pod_id is not null then
      raise exception 'an org-wide power hour must not set a pod';
    end if;
    if not v_is_owner_admin then
      raise exception 'only an owner or admin can start an org-wide power hour';
    end if;
  else
    if p_pod_id is null then
      raise exception 'a pod-scoped power hour must set a pod';
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
  end if;

  insert into public.power_hours (
    org_id, name, created_by, starts_at, ends_at, scope, pod_id, metric, target
  ) values (
    p_org, btrim(p_name), auth.uid(), p_starts_at, p_ends_at, p_scope, p_pod_id, p_metric, p_target
  )
  returning id into v_id;

  perform private.log_org_action(
    p_org, 'power_hour.create', 'power_hour', v_id,
    jsonb_build_object('name', p_name, 'scope', p_scope, 'pod_id', p_pod_id, 'metric', p_metric,
      'starts_at', p_starts_at, 'ends_at', p_ends_at, 'target', p_target)
  );

  return v_id;
end;
$$;

revoke all on function public.create_power_hour(
  uuid, text, timestamptz, timestamptz, text, uuid, text, int
) from public, anon;
grant execute on function public.create_power_hour(
  uuid, text, timestamptz, timestamptz, text, uuid, text, int
) to authenticated;

create function public.cancel_power_hour(p_org uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_scope text;
  v_pod_id uuid;
  v_cancelled_at timestamptz;
  v_is_owner_admin boolean;
begin
  select scope, pod_id, cancelled_at into v_scope, v_pod_id, v_cancelled_at
  from public.power_hours
  where id = p_id and org_id = p_org;

  if v_scope is null then
    raise exception 'power hour not found';
  end if;
  if v_cancelled_at is not null then
    raise exception 'power hour is already cancelled';
  end if;

  v_is_owner_admin := private.has_org_role(p_org, array['owner', 'admin']);
  if not v_is_owner_admin then
    if not private.has_org_role(p_org, array['manager']) then
      raise exception 'only an owner, admin, or manager can cancel a power hour';
    end if;
    if v_scope = 'org' then
      raise exception 'only an owner or admin can cancel an org-wide power hour';
    end if;
    if not exists (
      select 1 from public.org_manager_pods
      where org_id = p_org and manager_user_id = auth.uid() and pod_id = v_pod_id
    ) then
      raise exception 'that pod is outside your managed pods';
    end if;
  end if;

  update public.power_hours set cancelled_at = now() where id = p_id and org_id = p_org;

  perform private.log_org_action(p_org, 'power_hour.cancel', 'power_hour', p_id, '{}'::jsonb);
end;
$$;

revoke all on function public.cancel_power_hour(uuid, uuid) from public, anon;
grant execute on function public.cancel_power_hour(uuid, uuid) to authenticated;

-- =================================================================================================
-- 3. power_hour_board(p_id) -- the live/final board. Visibility check mirrors the table's own
--    SELECT policy exactly (SECURITY DEFINER bypasses RLS, so this must re-derive it, same
--    "compose once conceptually, re-check per write/read RPC" discipline as G6's
--    can_view_inbox_item). The dialing-hours CTE is agent_self_stats's own clipped-overlap shape
--    (20260927144900), reused verbatim -- see notes.md for why dial_session_hours does not fit.
-- =================================================================================================

create function public.power_hour_board(p_id uuid)
returns table (
  agent_id uuid,
  name text,
  metric_count integer,
  dials integer,
  talk_minutes numeric,
  dialing_hours numeric,
  metric_per_hour numeric,
  board_rank integer
)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_org uuid;
  v_scope text;
  v_pod_id uuid;
  v_metric text;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_window_end timestamptz;
  v_can_view boolean;
begin
  select org_id, scope, pod_id, metric, starts_at, ends_at
  into v_org, v_scope, v_pod_id, v_metric, v_starts_at, v_ends_at
  from public.power_hours where id = p_id;

  if v_org is null then
    return;
  end if;

  v_can_view := private.is_org_member(v_org) and (
    v_scope = 'org'
    or private.has_org_role(v_org, array['owner', 'admin'])
    or exists (
      select 1 from public.org_manager_pods mp
      where mp.org_id = v_org and mp.manager_user_id = auth.uid() and mp.pod_id = v_pod_id
    )
    or exists (
      select 1 from public.org_members m
      where m.org_id = v_org and m.user_id = auth.uid() and m.status = 'active'
        and m.pod_id = v_pod_id
    )
  );
  if not v_can_view then
    return;
  end if;

  v_window_end := least(now(), v_ends_at);

  return query
  with participants as (
    select m.user_id,
      coalesce(nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
        u.email, 'Member') as full_name
    from public.org_members m
    left join public.profiles p on p.user_id = m.user_id
    left join auth.users u on u.id = m.user_id
    where m.org_id = v_org
      and m.status = 'active'
      and (v_scope = 'org' or m.pod_id = v_pod_id)
  ),
  legs as (
    select ds.agent_id, cl.outcome, cl.duration_seconds, cl.disposition_id
    from public.call_legs cl
    join public.dial_sessions ds on ds.id = cl.session_id
    where cl.org_id = v_org
      and cl.kind = 'contact'
      and cl.created_at >= v_starts_at
      and cl.created_at < v_window_end
  ),
  agg as (
    select
      l.agent_id,
      count(*) as dials,
      count(*) filter (where l.outcome = 'connected') as connects,
      count(*) filter (where l.outcome = 'connected' and l.duration_seconds >= 30) as conversations,
      count(*) filter (where d.is_win) as appointments,
      coalesce(sum(l.duration_seconds) filter (where l.outcome = 'connected'), 0) as talk_seconds
    from legs l
    left join public.dispositions d on d.id = l.disposition_id
    group by l.agent_id
  ),
  hours as (
    select
      ds.agent_id,
      coalesce(sum(
        extract(epoch from (
          least(coalesce(ds.ended_at, now()), v_window_end) - greatest(ds.started_at, v_starts_at)
        )) / 3600.0
      ), 0) as dialing_hours
    from public.dial_sessions ds
    where ds.org_id = v_org
      and ds.started_at < v_window_end
      and coalesce(ds.ended_at, now()) > v_starts_at
    group by ds.agent_id
  ),
  scored as (
    select
      pt.user_id as agent_id,
      pt.full_name as name,
      coalesce(
        case v_metric
          when 'connects' then a.connects
          when 'appointments' then a.appointments
          else a.conversations
        end, 0
      )::int as metric_count,
      coalesce(a.dials, 0)::int as dials,
      -- extract(epoch from ...) yields double precision; round(double precision, int) does not
      -- exist as a Postgres overload (R-039/agent_self_stats' own gotcha) -- cast to numeric
      -- first, same as agent_self_stats' per_agent CTE does.
      round((coalesce(a.talk_seconds, 0) / 60.0)::numeric, 1) as talk_minutes,
      round(coalesce(h.dialing_hours, 0)::numeric, 2) as dialing_hours,
      case when coalesce(h.dialing_hours, 0)::numeric >= 0.1
        then round((
          coalesce(
            case v_metric
              when 'connects' then a.connects
              when 'appointments' then a.appointments
              else a.conversations
            end, 0
          )::numeric / h.dialing_hours::numeric
        ), 2)
        else null
      end as metric_per_hour
    from participants pt
    left join agg a on a.agent_id = pt.user_id
    left join hours h on h.agent_id = pt.user_id
  )
  select
    s.agent_id, s.name, s.metric_count, s.dials, s.talk_minutes, s.dialing_hours,
    s.metric_per_hour,
    rank() over (
      order by s.metric_count desc, s.dialing_hours asc, s.name asc, s.agent_id asc
    )::int as board_rank
  from scored s
  order by board_rank, s.name;
end;
$$;

revoke all on function public.power_hour_board(uuid) from public, anon;
grant execute on function public.power_hour_board(uuid) to authenticated;

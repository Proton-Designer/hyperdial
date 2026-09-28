-- MISSION-5 TASK-M5-E13 (EC-13, audit/M5/edge-cases-v2.md): raw dial/connect counts and
-- "conversations per 100 dials" (Fairness) both reward an agent dialing more simultaneous LINES
-- over one dialing fewer, for reasons that have nothing to do with skill. This adds a
-- line-hour-normalized metric -- conversations per line-hour -- next to the existing ones.
--
-- audit/M5-E13/notes.md has the full investigation: `dial_sessions.lines` is set once at session
-- start (dialer-session-start/index.ts) and never updated afterward anywhere in this codebase
-- (grepped every migration + edge function) -- so `line_hours` for a session is exactly
-- `lines * clipped_session_hours`, no time-weighting/approximation needed.
--
-- R-038 applies: team_daily_stats' OUT columns change (2 new: line_hours,
-- conversations_per_line_hour), so this DROPs the current live signature first (latest body:
-- 20260927160550_manager_role_and_pods.sql) rather than `create or replace`, which would fail
-- with 42P13. Every other line of the function is copied verbatim except the `hours` CTE (gains a
-- `line_hours` sum alongside the existing `dialing_hours` sum) and the final `select` (2 new
-- expressions, same `>= 0.1` floor pattern conversations_per_hr already uses).

drop function if exists public.team_daily_stats(uuid, timestamptz, timestamptz);

create function public.team_daily_stats(p_org uuid, p_start timestamptz, p_end timestamptz)
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
  dialing_hours numeric,
  line_hours numeric,
  conversations_per_line_hour numeric
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
      ), 0) as dialing_hours,
      coalesce(sum(
        ds.lines * (
          extract(epoch from (
            least(coalesce(ds.ended_at, now()), p_end) - greatest(ds.started_at, p_start)
          )) / 3600.0
        )
      ), 0) as line_hours
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
    round(coalesce(h.dialing_hours, 0)::numeric, 2),
    round(coalesce(h.line_hours, 0)::numeric, 2),
    case when coalesce(h.line_hours, 0) >= 0.1
      then round((coalesce(a.conversations, 0)::numeric / h.line_hours) * 100) / 100
      else null
    end
  from members mem
  left join agg a on a.agent_id = mem.user_id
  left join hours h on h.agent_id = mem.user_id
  order by mem.full_name;
end;
$$;

revoke all on function public.team_daily_stats(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.team_daily_stats(uuid, timestamptz, timestamptz) to authenticated;

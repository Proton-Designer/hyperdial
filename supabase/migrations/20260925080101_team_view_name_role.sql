-- TASK-M2 fix (lead review of 20260925080100, live UI check): both team RPCs fell back straight
-- to the literal string 'Agent' whenever a member had no profile first/last name -- on the real
-- QA org neither seeded member has one set, so the live board showed two rows both labeled
-- "Agent", indistinguishable. Name resolution is now profile full name -> auth.users.email ->
-- 'Member' (reading auth.users.email is safe here: both functions are already SECURITY DEFINER,
-- and this is only ever reached for a row already scoped to the CALLER's own org via the
-- `private.has_org_role` gate + the `members` CTE's own `org_id = p_org` filter -- never a
-- cross-org email leak). Also returns each member's own `role` ('owner'/'admin'/'agent') so the
-- UI can show it as a small chip next to the name -- cheap (already joined via org_members),
-- and immediately tells a manager apart from an intern on both the live board and the daily
-- table, not just distinguishing two same-named/no-name interns from each other.
--
-- 080100 is already applied live -- `create or replace function` cannot change a function's
-- RETURN TYPE (adding `role` to a `returns table(...)` list counts as changing it, Postgres
-- rejects that with "cannot change return type of existing function"), so this drops and
-- recreates both functions instead of replacing them in place. DROP FUNCTION also drops its
-- grants, so both revoke/grant statements are repeated here verbatim -- otherwise these would
-- silently fall back to default (PUBLIC-executable) privileges after the recreate, reopening
-- exactly the kind of grant gap TASK-G7's review found.

drop function public.team_daily_stats(uuid, timestamptz, timestamptz);
drop function public.team_live_board(uuid);

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
  dialing_hours numeric
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
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
    where m.org_id = p_org and m.status = 'active'
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
  order by coalesce(a.dials, 0) desc, mem.full_name;
end;
$$;

revoke all on function public.team_daily_stats(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.team_daily_stats(uuid, timestamptz, timestamptz) to authenticated;

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
  conversations_today integer
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_today_start timestamptz;
  v_today_end timestamptz;
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    return;
  end if;

  v_today_start := date_trunc('day', now() at time zone 'America/Chicago') at time zone 'America/Chicago';
  v_today_end := v_today_start + interval '1 day';

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
    where m.org_id = p_org and m.status = 'active'
  ),
  current_session as (
    select distinct on (ds.agent_id)
      ds.agent_id, ds.state, ds.lines, ds.started_at, ds.updated_at, ds.active_leg_id
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
    coalesce(tl.conversations_today, 0)::int
  from members mem
  left join current_session cs on cs.agent_id = mem.user_id
  left join public.call_legs al on al.id = cs.active_leg_id
  left join public.contacts c on c.id = al.contact_id
  left join today_legs tl on tl.agent_id = mem.user_id
  order by mem.full_name;
end;
$$;

revoke all on function public.team_live_board(uuid) from public, anon;
grant execute on function public.team_live_board(uuid) to authenticated;

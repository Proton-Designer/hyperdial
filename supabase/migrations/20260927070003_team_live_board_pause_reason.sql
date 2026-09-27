-- MISSION-5 TASK-M5-B1: extend team_live_board with the session's current pause_reason, so
-- TASK-M5-A4 (eng1, live board UI) can render it next to the existing 'paused' status chip --
-- this migration only adds the server-side column; wiring it into Team.tsx's own rendering is
-- A4's job (board.md: "coordinate: eng1 owns Team.tsx"), not touched here.
--
-- `state_since` (already returned, from cs.updated_at) already covers "time in state" for the
-- live board's own row; this adds the one remaining piece B1's own spec calls for ("current
-- state + reason + state_since").
--
-- Same drop+recreate shape as 20260925080101 (adding a column to a `returns table(...)` counts
-- as a return-type change -- `create or replace function` cannot do that, Postgres rejects it).
-- DROP FUNCTION also drops its grants, so both are repeated here verbatim, same as 080101's own
-- header comment already warns.

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
  pause_reason text
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
      ds.agent_id, ds.state, ds.lines, ds.started_at, ds.updated_at, ds.active_leg_id, ds.pause_reason
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
    case when cs.state in ('paused', 'paused_agent_lost') then cs.pause_reason else null end
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

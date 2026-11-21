-- TASK-M2: manager team view -- per-intern daily numbers (ADM-6) + a live team board (ADM-7).
--
-- Both are "front door read" SECURITY DEFINER functions (same shape as contact_disposition_
-- history, 20260925060000) -- callable directly by the client (no edge function in between,
-- so the live board's 5s poll is a single RPC round trip, not N queries), granted to
-- `authenticated` directly rather than `service_role`-only like most of this repo's RPCs. That
-- means each function MUST check the caller's own org role itself (private.has_org_role, which
-- reads auth.uid() -- only meaningful when the caller's own JWT is what's attached, i.e. exactly
-- the case for a direct authenticated-client RPC call): an org member who isn't owner/admin gets
-- zero rows back, not an error, and a p_org the caller doesn't manage never leaks a row either,
-- since the role check is against auth.uid()'s OWN membership in that specific org, not just
-- "is owner/admin of some org somewhere." This is deliberately stricter than dialing_hours_today/
-- team-performance's existing pattern (service-role edge function does the one role check, the
-- RPC/query trusts the org_id it's handed) -- the lead's own review of TASK-G7 found a live
-- privilege hole from under-scoped grants, so these two new cross-agent-read functions get the
-- belt-and-braces treatment: revoked from public/anon, and the role check lives IN the function,
-- not only in a caller that might someday change.

-- ---- ADM-6: per-intern daily numbers ----------------------------------------------------------
-- One row per active org member (agents, plus any owner/admin who also dials) for the caller-
-- supplied [p_start, p_end) window. Mirrors dashboard-stats' own field definitions exactly
-- (created_at-scoped dials/connects/conversations/wins, is_win from dispositions, the >=30s
-- conversation gate) rather than reinventing them -- see .brain/domains/analytics.md. Dialing
-- hours generalizes dialing_hours_today's own overlap-clip math to an arbitrary window (today's
-- specific America/Chicago-midnight boundary stays the CALLER's job now, computed once in the
-- client the same way for every range -- see Team.tsx -- so this function has one clipping rule
-- for every range instead of a special case for "today").
create function public.team_daily_stats(p_org uuid, p_start timestamptz, p_end timestamptz)
returns table (
  agent_id uuid,
  name text,
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
      coalesce(
        nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
        'Agent'
      ) as full_name
    from public.org_members m
    left join public.profiles p on p.user_id = m.user_id
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

-- ---- ADM-7: live team board --------------------------------------------------------------------
-- One row per active org member: their current dial_sessions row (if any non-terminal one
-- exists), mapped to a small status enum the UI labels, plus today's calls/conversations so the
-- board doubles as a lightweight "today" tile without a second poll. `status` is raw (not
-- pre-formatted "Dialing (2 lines)" text) -- Team.tsx combines it with `lines`/`contact_name`
-- the same way every other screen in this repo keeps display formatting out of SQL.
create function public.team_live_board(p_org uuid)
returns table (
  agent_id uuid,
  name text,
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

  -- Same America/Chicago "today" boundary as dialing_hours_today (20260925020000) -- no org has
  -- a timezone column yet, see .brain/domains/analytics.md.
  v_today_start := date_trunc('day', now() at time zone 'America/Chicago') at time zone 'America/Chicago';
  v_today_end := v_today_start + interval '1 day';

  return query
  with members as (
    select
      m.user_id,
      coalesce(
        nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
        'Agent'
      ) as full_name
    from public.org_members m
    left join public.profiles p on p.user_id = m.user_id
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

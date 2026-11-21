-- MISSION-5 TASK-M5-B1: agent_time_in_state(org, from, to[, agent], tz) -> per agent/day seconds
-- by state and pause reason. Consumed by TASK-M5-A4's attendance tab (eng1); owner/admin only,
-- same has_org_role gate + "return with no rows rather than raise" shape as team_daily_stats/
-- team_live_board (20260925080101) -- an agent-facing self-view (TM-E6) is explicitly out of
-- scope for this task (A4's own item), so p_agent narrows an owner/admin's OWN query, it does not
-- let an agent call this for themselves.
--
-- Day bucketing: a single agent_state_events row can span a civil-day boundary (an overnight
-- pause, or a session still open at query time). generate_series walks every local midnight (in
-- p_tz) the row touches; each day's contribution is the overlap between the row's own
-- [clipped_start, clipped_end) and that day's own [start, start+1day) window, both expressed in
-- p_tz -- NOT a fixed 24h offset, so this is correct across a DST transition inside the queried
-- range. `<naive timestamp> at time zone p_tz` is the standard Postgres idiom for "reinterpret
-- this local wall-clock value as being in this zone, return the UTC instant" -- used here to
-- convert generate_series' own naive local-midnight values back into timestamptz for the overlap
-- comparison against the (already timestamptz) event bounds.
--
-- p_tz defaults to 'America/Chicago' (this codebase's own existing hardcoded default, e.g.
-- Team.tsx/team_live_board) per this task's own instruction to take a tz param now and let
-- TASK-M5-A4 pass the org's real timezone once that column exists.

create function public.agent_time_in_state(
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
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    return;
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
      and e.started_at < p_to
      and coalesce(e.ended_at, now()) > p_from
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

revoke all on function public.agent_time_in_state(uuid, timestamptz, timestamptz, uuid, text) from public, anon;
grant execute on function public.agent_time_in_state(uuid, timestamptz, timestamptz, uuid, text) to authenticated;

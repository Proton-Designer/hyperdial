-- MISSION-5 TASK-M5-A4 follow-up: "first activity" per agent/day for the Attendance tab. A4's
-- own migration (agent_time_in_state, 20260927070002) deliberately did NOT add this -- it
-- aggregates seconds by (agent, day, state, reason), which loses individual event start times
-- entirely, so there was nothing to read a literal clock time from without a separate query.
--
-- A SIBLING RPC rather than widening agent_time_in_state itself: that function's return shape is
-- already consumed by Team.tsx's groupAttendance() for a completely different purpose (per-state
-- second totals), and adding a first-activity column to every (agent, day, state, reason) row
-- would either repeat the same value across every row of a day (wasteful, and a foot-gun for a
-- future aggregation that naively sums a column meant to be read once per day) or force a
-- separate "state IS NULL" sentinel row shape into a function that already has callers.
--
-- "First activity" = the earliest agent_state_events.started_at whose OWN calendar day (in p_tz)
-- is that day -- unlike agent_time_in_state's own generate_series clipping (which SPLITS a
-- boundary-spanning row's SECONDS across the days it touches), a start time belongs to exactly
-- the one day it actually happened on; there is nothing to split. Same owner/admin-only gate,
-- p_agent narrowing, and p_tz default as agent_time_in_state -- an agent-facing self-view stays
-- explicitly out of scope, unchanged from that function's own header.

create function public.agent_first_activity(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_agent uuid default null,
  p_tz text default 'America/Chicago'
)
returns table (
  agent_id uuid,
  day date,
  first_started_at timestamptz
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
  select
    e.agent_id,
    (date_trunc('day', e.started_at at time zone p_tz))::date as day,
    min(e.started_at) as first_started_at
  from public.agent_state_events e
  where e.org_id = p_org
    and (p_agent is null or e.agent_id = p_agent)
    and e.started_at >= p_from
    and e.started_at < p_to
  group by e.agent_id, (date_trunc('day', e.started_at at time zone p_tz))::date
  order by 1, 2;
end;
$$;

revoke all on function public.agent_first_activity(uuid, timestamptz, timestamptz, uuid, text) from public, anon;
grant execute on function public.agent_first_activity(uuid, timestamptz, timestamptz, uuid, text) to authenticated;

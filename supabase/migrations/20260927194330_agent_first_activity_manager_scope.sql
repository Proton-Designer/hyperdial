-- Fix-forward for 20260927193905_agent_first_activity.sql: that migration copied
-- agent_time_in_state's ORIGINAL (pre-A5) owner/admin-only gate rather than its CURRENT one --
-- 20260927160550_manager_role_and_pods.sql already widened agent_time_in_state itself (via
-- `create or replace` on the same signature) to also admit a pod-scoped manager AND an agent's
-- own self-view, and agent_first_activity should have matched that from the start (same
-- "sibling RPC" reasoning as its own header: it exists so agent_time_in_state's callers get a
-- clock time without changing that function's own return shape -- but a sibling that enforces a
-- STALER trust boundary than the function it's a sibling of is just a second place for the same
-- rule to drift, the exact class of bug fix-A6/B5 already caught twice this session).
--
-- Net effect: a manager's Attendance tab was rendering every OTHER column correctly (via
-- agent_time_in_state, already manager-pod-scoped) but a blank "First activity" column, since
-- this function returned nothing at all for a manager caller.

create or replace function public.agent_first_activity(
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
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    -- Same self-view carve-out as agent_time_in_state: an agent may query ONLY their own rows.
    if not private.has_org_role(p_org, array['agent'])
      or p_agent is null
      or p_agent is distinct from auth.uid()
    then
      return;
    end if;
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
    -- MISSION-5 TASK-M5-A5 (fix-forward): row-level pod scope, same composition as
    -- agent_time_in_state's own -- owner/admin unconditionally true, manager pod-scoped, agent
    -- self-view via the explicit OR-clause.
    and (
      private.is_agent_in_callers_pod_scope(p_org, e.agent_id)
      or (private.has_org_role(p_org, array['agent']) and e.agent_id = auth.uid())
    )
  group by e.agent_id, (date_trunc('day', e.started_at at time zone p_tz))::date
  order by 1, 2;
end;
$$;

revoke all on function public.agent_first_activity(uuid, timestamptz, timestamptz, uuid, text) from public, anon;
grant execute on function public.agent_first_activity(uuid, timestamptz, timestamptz, uuid, text) to authenticated;

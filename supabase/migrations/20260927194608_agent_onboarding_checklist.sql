-- Deferred backlog item TM-B2: onboarding checklist per agent (pre-flight passed, number
-- assigned, campaign assigned, first call made), visible to owner/admin/manager on the Team page.
-- No new tracking table -- every item is DERIVED from data that already exists:
--
--   - preflight_passed: the agent has at least one `dial_sessions` row ever. Dialer.tsx's own
--     `handleStartSessionForCampaign` runs a mic-permission check (`getUserMedia`) and registers
--     the WebRTC line (`connectAgentLine`) BEFORE it ever calls the session-start endpoint,
--     returning early on either failure -- so a dial_sessions row existing at all is proof both
--     steps already succeeded at least once. There is no separate "pre-flight" table because
--     nothing about that check is persisted independently of a session actually starting.
--   - number_assigned: `user_phone_numbers.assigned_user_id = agent` has a row (Number Pool,
--     20260925070000).
--   - campaign_assigned: `campaign_agents` has a row for this agent (Campaigns' own agent-roster
--     assignment).
--   - first_call_made: a `call_legs` row of kind='contact' exists for a session this agent owns
--     (private.dial_session_agent_id) -- a REAL dial, not just a started/stopped session with
--     nothing ever attempted.
--
-- Scope: owner/admin see every active agent; a manager sees only their own pod-scoped agents
-- (`private.is_agent_in_callers_pod_scope`, composed once rather than re-derived -- same
-- discipline as every other Mission-5 manager-scoped surface this session). Restricted to
-- role='agent' rows -- this checklist is about an AGENT's own onboarding, not an owner/admin/
-- manager's.

create function public.agent_onboarding_checklist(p_org uuid)
returns table (
  agent_id uuid,
  agent_name text,
  preflight_passed boolean,
  number_assigned boolean,
  campaign_assigned boolean,
  first_call_made boolean
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
  select
    m.user_id,
    coalesce(nullif(trim(concat(pr.first_name, ' ', pr.last_name)), ''), 'Unknown') as agent_name,
    exists (
      select 1 from public.dial_sessions ds
      where ds.org_id = p_org and ds.agent_id = m.user_id
    ) as preflight_passed,
    exists (
      select 1 from public.user_phone_numbers upn
      where upn.org_id = p_org and upn.assigned_user_id = m.user_id
    ) as number_assigned,
    exists (
      select 1 from public.campaign_agents ca
      where ca.org_id = p_org and ca.user_id = m.user_id
    ) as campaign_assigned,
    exists (
      select 1 from public.call_legs cl
      where cl.org_id = p_org
        and cl.kind = 'contact'
        and private.dial_session_agent_id(cl.session_id) = m.user_id
    ) as first_call_made
  from public.org_members m
  left join public.profiles pr on pr.user_id = m.user_id
  where m.org_id = p_org
    and m.role = 'agent'
    and m.status = 'active'
    and private.is_agent_in_callers_pod_scope(p_org, m.user_id)
  order by agent_name;
end;
$$;

revoke all on function public.agent_onboarding_checklist(uuid) from public, anon;
grant execute on function public.agent_onboarding_checklist(uuid) to authenticated;

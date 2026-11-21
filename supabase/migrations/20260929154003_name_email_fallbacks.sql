-- TASK-Q2F (audit/ui/Q2/report.md, findings #2 and #3): two functions coalesce a member's display
-- name straight to a hardcoded placeholder with no email fallback in between, unlike every other
-- name-resolving query in this codebase. Same fix applied to both below.
--
-- Finding #2: preview_territory_rules' target_name falls
-- straight to the literal 'Unnamed teammate' when the resolved agent has no first/last name set
-- (a real gap for a fresh/seed account, e.g. the QA sandbox's own qa-agent@example.com) --
-- everywhere else in this codebase that resolves a member's display name falls back to their
-- email FIRST (team_daily_stats' own coalesce chain, 20260928123723_line_hour_fairness.sql:
-- `coalesce(nullif(trim(first+last), ''), u.email, 'Member')`, joining `auth.users u`). Same
-- pattern here: join `auth.users u` on the resolved agent id, and coalesce through email before
-- the literal fallback. No OUT-column change (still target_type/target_id/target_name/lead_count),
-- so a plain `create or replace` is correct (R-038 N/A). Every other line copied verbatim from the
-- LATEST body (20260927224036_territory_rules.sql) -- only the target_name expression's agent
-- branch and the join list changed.

create or replace function public.preview_territory_rules(p_campaign_id uuid, p_reassign boolean default false)
returns table (target_type text, target_id uuid, target_name text, lead_count int)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_org_id uuid;
begin
  select org_id into v_org_id from public.campaigns where id = p_campaign_id;
  if v_org_id is null then
    raise exception 'campaign not found';
  end if;
  if not (
    private.has_org_role(v_org_id, array['owner', 'admin'])
    or private.has_org_role(v_org_id, array['manager'])
  ) then
    raise exception 'only an owner, admin, or manager can preview territory rules';
  end if;
  if p_reassign and not private.has_org_role(v_org_id, array['owner', 'admin']) then
    raise exception 'only an owner or admin can reassign already-assigned leads';
  end if;

  return query
  with resolved as (
    select
      case
        when r.target_pod_id is not null then 'pod:' || r.target_pod_id::text
        when r.resolved_agent_id is not null then 'agent:' || r.resolved_agent_id::text
        else 'unmatched'
      end as group_key,
      r.target_pod_id,
      r.resolved_agent_id
    from private.resolve_territory_assignments(v_org_id, p_campaign_id, p_reassign) r
  )
  select
    case
      when bool_or(resolved.target_pod_id is not null) then 'pod'
      when bool_or(resolved.resolved_agent_id is not null) then 'agent'
      else 'unmatched'
    end as target_type,
    coalesce((array_agg(resolved.target_pod_id))[1], (array_agg(resolved.resolved_agent_id))[1]) as target_id,
    case
      when bool_or(resolved.target_pod_id is not null) then coalesce(max(op.name), 'Unnamed pod')
      when bool_or(resolved.resolved_agent_id is not null) then
        coalesce(
          nullif(btrim(coalesce(max(p.first_name), '') || ' ' || coalesce(max(p.last_name), '')), ''),
          max(u.email),
          'Unnamed teammate'
        )
      else 'Unmatched (normal distribution)'
    end as target_name,
    count(*)::int as lead_count
  from resolved
  left join public.profiles p on resolved.target_pod_id is null and p.user_id = resolved.resolved_agent_id
  left join auth.users u on resolved.target_pod_id is null and u.id = resolved.resolved_agent_id
  left join public.org_pods op on op.id = resolved.target_pod_id
  group by resolved.group_key
  order by lead_count desc;
end;
$$;

revoke all on function public.preview_territory_rules(uuid, boolean) from public, anon;
grant execute on function public.preview_territory_rules(uuid, boolean) to authenticated;

-- =================================================================================================
-- TASK-Q2F (Q2 finding #3, audit/ui/Q2/report.md): agent_onboarding_checklist's agent_name has
-- the exact same gap -- coalesces straight to the literal 'Unknown' with no email fallback in
-- between. Same fix, same auth.users join pattern. No OUT-column change, plain `create or
-- replace`. Every other line copied verbatim from the LATEST (and only) body
-- (20260927194608_agent_onboarding_checklist.sql).
-- =================================================================================================

create or replace function public.agent_onboarding_checklist(p_org uuid)
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
    coalesce(nullif(trim(concat(pr.first_name, ' ', pr.last_name)), ''), u.email, 'Unknown') as agent_name,
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
  left join auth.users u on u.id = m.user_id
  where m.org_id = p_org
    and m.role = 'agent'
    and m.status = 'active'
    and private.is_agent_in_callers_pod_scope(p_org, m.user_id)
  order by agent_name;
end;
$$;

revoke all on function public.agent_onboarding_checklist(uuid) from public, anon;
grant execute on function public.agent_onboarding_checklist(uuid) to authenticated;

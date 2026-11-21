-- MISSION-5 TASK-M5-D2: follow-up from the lead's D1 review. countLeadsAssignedToOthers (api.ts,
-- d754488) counts client-side over a plain `.select()` -- PostgREST caps it at 1000 rows by
-- default, so a bigger campaign undercounts AND gets wrong range/percentage ranks, and tag mode
-- sends every contact id in one `.in()` (URL length). It fails open (never blocks), so this was a
-- correctness bug, not a safety one -- fixed by moving the count server-side, sharing the EXACT
-- candidate-set logic assign_campaign_leads itself uses so the two can never drift.
--
-- assign_campaign_leads is refactored (verbatim behavior, R-037 new file since it's live;
-- R-038 N/A, same signature/return type) into 2 new private helpers:
--   1. private.resolve_campaign_assign_access(p_campaign_id, p_agent_id) -- the auth gate (campaign
--      lookup -> org_id, owner/admin/manager role check, target-agent active-membership +
--      caller's-pod-scope checks). Returns org_id or raises. Deliberately does NOT do the
--      campaign_agents insert -- that's a real write side effect of actually assigning, not
--      something a count-only caller should trigger.
--   2. private.resolve_campaign_lead_candidates(p_org_id, p_campaign_id, p_filter) -- the mode
--      validation + ranked/candidates CTEs, copied verbatim from assign_campaign_leads' own body.
-- Both are called by assign_campaign_leads AND the new public.count_reassign_impact, so the two
-- can never see a different candidate set for the same (campaign, filter).
--
-- count_reassign_impact's "is not null and differs from the target" check uses IS DISTINCT FROM
-- (not <>) so a null p_agent_id (unassigning) still counts every currently-assigned candidate --
-- matches api.ts's own client-side semantics exactly (`assigned_agent_id !== null &&
-- assigned_agent_id !== targetAgentId`, where a null targetAgentId makes the second half always
-- true), which is what's being replaced here.

-- =================================================================================================
-- 1. private.resolve_campaign_assign_access -- shared auth gate. Only ever called from another
--    SECURITY DEFINER function in this file, never from a policy or supabase.rpc() directly --
--    revoked from authenticated, same convention as private.log_org_action/
--    resolve_territory_assignments.
-- =================================================================================================

create function private.resolve_campaign_assign_access(p_campaign_id uuid, p_agent_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_is_owner_admin boolean;
begin
  select org_id into v_org_id from public.campaigns where id = p_campaign_id;
  if v_org_id is null then
    raise exception 'campaign not found';
  end if;

  v_is_owner_admin := private.has_org_role(v_org_id, array['owner', 'admin']);
  if not v_is_owner_admin and not private.has_org_role(v_org_id, array['manager']) then
    raise exception 'only an owner, admin, or manager can assign leads';
  end if;

  if p_agent_id is not null and not exists (
    select 1 from public.org_members
    where org_id = v_org_id and user_id = p_agent_id and status = 'active'
  ) then
    raise exception 'target agent is not an active member of this org';
  end if;

  if p_agent_id is not null and not private.is_agent_in_callers_pod_scope(v_org_id, p_agent_id) then
    raise exception 'that agent is outside your managed pods';
  end if;

  return v_org_id;
end;
$$;

revoke all on function private.resolve_campaign_assign_access(uuid, uuid) from public, anon, authenticated;

-- =================================================================================================
-- 2. private.resolve_campaign_lead_candidates -- the mode validation + ranked/candidates CTEs,
--    copied verbatim from assign_campaign_leads' current body (20260927224036_territory_rules.sql)
--    except it RETURNs the candidate rows instead of feeding them straight into an UPDATE.
-- =================================================================================================

create function private.resolve_campaign_lead_candidates(
  p_org_id uuid,
  p_campaign_id uuid,
  p_filter jsonb
)
returns table (lead_id uuid, assigned_agent_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_mode text;
  v_from_agent_id uuid;
  v_lead_ids uuid[];
  v_bad_lead_id text;
begin
  v_mode := coalesce(p_filter ->> 'mode', 'all');
  if v_mode not in ('all', 'range', 'percentage', 'tag', 'by_current_agent', 'lead_ids') then
    raise exception 'p_filter.mode must be one of: all, range, percentage, tag, by_current_agent, lead_ids';
  end if;

  if v_mode = 'by_current_agent' then
    v_from_agent_id := (p_filter ->> 'from_agent_id')::uuid;
    if v_from_agent_id is null then
      raise exception 'p_filter.from_agent_id is required for mode=by_current_agent';
    end if;
    if not private.is_agent_in_callers_pod_scope(p_org_id, v_from_agent_id) then
      raise exception 'that agent is outside your managed pods';
    end if;
  end if;

  if v_mode = 'lead_ids' then
    select elem into v_bad_lead_id
    from jsonb_array_elements_text(p_filter -> 'lead_ids') as elem
    where elem !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    limit 1;
    if v_bad_lead_id is not null then
      raise exception 'p_filter.lead_ids contains a malformed id: %', v_bad_lead_id;
    end if;

    select array_agg((elem)::uuid) into v_lead_ids
    from jsonb_array_elements_text(p_filter -> 'lead_ids') as elem;
    if v_lead_ids is null or array_length(v_lead_ids, 1) is null then
      raise exception 'p_filter.lead_ids must be a non-empty array for mode=lead_ids';
    end if;
  end if;

  return query
  with ranked as (
    select
      cl2.id,
      cl2.assigned_agent_id,
      ct.ghl_tags,
      row_number() over (order by cl2.position) as rn,
      count(*) over () as total
    from public.campaign_leads cl2
    join public.contacts ct on ct.id = cl2.contact_id
    where cl2.campaign_id = p_campaign_id
      and (
        cl2.status = 'queued'
        or (v_mode = 'by_current_agent' and cl2.status = 'callback')
      )
  )
  select r.id, r.assigned_agent_id
  from ranked r
  where (
    v_mode = 'all'
    or (v_mode = 'range'
      and r.rn between (p_filter ->> 'start')::int and (p_filter ->> 'end')::int)
    or (v_mode = 'percentage'
      and r.rn <= ceil(r.total * (p_filter ->> 'percentage')::numeric / 100))
    or (v_mode = 'tag' and r.ghl_tags && array[p_filter ->> 'tag'])
    or (v_mode = 'by_current_agent' and r.assigned_agent_id = v_from_agent_id)
    or (v_mode = 'lead_ids' and r.id = any(v_lead_ids))
  )
  and (
    r.assigned_agent_id is null
    or private.is_agent_in_callers_pod_scope(p_org_id, r.assigned_agent_id)
  );
end;
$$;

revoke all on function private.resolve_campaign_lead_candidates(uuid, uuid, jsonb) from public, anon, authenticated;

-- =================================================================================================
-- 3. assign_campaign_leads -- rewritten to call the 2 helpers above instead of inlining their
--    logic. Same signature/return type (R-038 N/A), identical observable behavior and exception
--    ordering: gate + agent-validity checks, THEN the campaign_agents insert, THEN mode
--    validation, THEN the update -- exactly the original order, just split across functions.
-- =================================================================================================

create or replace function public.assign_campaign_leads(
  p_campaign_id uuid,
  p_agent_id uuid,
  p_filter jsonb default '{"mode": "all"}'::jsonb
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_count int;
begin
  v_org_id := private.resolve_campaign_assign_access(p_campaign_id, p_agent_id);

  if p_agent_id is not null then
    insert into public.campaign_agents (campaign_id, user_id, org_id)
    values (p_campaign_id, p_agent_id, v_org_id)
    on conflict (campaign_id, user_id) do nothing;
  end if;

  with candidates as (
    select * from private.resolve_campaign_lead_candidates(v_org_id, p_campaign_id, p_filter)
  ),
  updated as (
    update public.campaign_leads cl
    set assigned_agent_id = p_agent_id, updated_at = now()
    from candidates
    where cl.id = candidates.lead_id
      and cl.status in ('queued', 'callback')
    returning cl.id
  )
  select count(*) into v_count from updated;

  if v_count > 0 then
    perform private.log_org_action(
      v_org_id,
      'campaign_leads.assign',
      'campaign',
      p_campaign_id,
      jsonb_build_object(
        'agent_id', p_agent_id,
        'filter', p_filter,
        'lead_count', v_count
      )
    );
  end if;

  return v_count;
end;
$$;

revoke all on function public.assign_campaign_leads(uuid, uuid, jsonb) from public, anon;
grant execute on function public.assign_campaign_leads(uuid, uuid, jsonb) to authenticated;

-- =================================================================================================
-- 4. count_reassign_impact -- the new read-only RPC. Same auth gate as assign_campaign_leads (it
--    reveals counts, including which candidates are currently assigned to someone else), the
--    SAME candidate set (the shared helper), no write of any kind.
-- =================================================================================================

create function public.count_reassign_impact(
  p_campaign_id uuid,
  p_agent_id uuid,
  p_filter jsonb
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_count int;
begin
  v_org_id := private.resolve_campaign_assign_access(p_campaign_id, p_agent_id);

  select count(*) into v_count
  from private.resolve_campaign_lead_candidates(v_org_id, p_campaign_id, p_filter) c
  where c.assigned_agent_id is not null
    and c.assigned_agent_id is distinct from p_agent_id;

  return v_count;
end;
$$;

revoke all on function public.count_reassign_impact(uuid, uuid, jsonb) from public, anon;
grant execute on function public.count_reassign_impact(uuid, uuid, jsonb) to authenticated;

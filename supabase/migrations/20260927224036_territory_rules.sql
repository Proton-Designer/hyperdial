-- MISSION-5 TASK-M5-C4 (deferred backlog item): territory rules -- route leads by contact US
-- state/phone area code to an agent or pod, ordered priority, first match wins, unmatched leads
-- are left for the normal distribution (never dropped).
--
-- No `state` column exists anywhere on `public.contacts` (grepped every `alter table
-- public.contacts add column` across every migration: business_name/business_link/business_type/
-- rating/review_count/open_hours/phone_number/website/notes/first_name/last_name/owner_contact/
-- org_id/timezone/dnc/phone_raw/ghl_contact_id/ghl_tags/custom_fields/ghl_pipeline_stage/
-- ghl_custom_fields/assigned_user_id -- no address, no state). Per the task's own "if there's no
-- state column, area code alone is fine for v1" -- state matching is DERIVED from the phone
-- number's own NANP area code via the EXISTING `private.area_code_states` table (TASK-T9,
-- `20260926080600_number_health.sql`), reusing established infrastructure instead of adding a
-- second area-code-to-state mapping. `match_area_code` still exists as its OWN, finer-grained
-- dimension (e.g. splitting one state across area codes) -- a rule may use either, or both.
--
-- =================================================================================================
-- 1. private.nanp_area_code: the exact extraction convention already used 3x in this codebase
--    (20260925070000, 20260926080600) -- `phone_number ~ '^\+1[0-9]{10}$'` (NANP only; a foreign
--    number returns null, same "out of scope by design" precedent as area_code_timezones/
--    area_code_states themselves), `substring(... from 3 for 3)`. Pulled out to a real function
--    here (those two call sites inline the case expression instead) since this migration needs it
--    in three different places (resolver, and implicitly via area_code_states join).
-- =================================================================================================

create function private.nanp_area_code(p_phone text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when p_phone ~ '^\+1[0-9]{10}$' then substring(p_phone from 3 for 3) else null end;
$$;

-- =================================================================================================
-- 2. private.is_pod_in_callers_pod_scope: mirrors `is_agent_in_callers_pod_scope`'s exact shape
--    (20260927160550) for a POD target instead of an agent target -- true unconditionally for
--    owner/admin, true for a manager whose own `org_manager_pods` covers that pod, false
--    otherwise. No `org_members` join needed (unlike the agent version) -- pod scope is just "is
--    this pod one of the manager's own rows," not conditioned on any member's status.
-- =================================================================================================

create function private.is_pod_in_callers_pod_scope(p_org uuid, p_pod uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    private.has_org_role(p_org, array['owner', 'admin'])
    or exists (
      select 1 from public.org_manager_pods mp
      where mp.org_id = p_org and mp.pod_id = p_pod and mp.manager_user_id = auth.uid()
    );
$$;

grant execute on function private.is_pod_in_callers_pod_scope(uuid, uuid) to authenticated;

-- =================================================================================================
-- 3. org_territory_rules -- per-org, ordered priority (lower = checked first), first match wins.
--    SELECT-only RLS (owner/admin/manager may see the whole list, same visibility as every other
--    team-management surface) -- every WRITE goes through the RPCs below (same "SELECT-only RLS +
--    security-definer RPCs do every write" shape as TASK-M5-G5's contact_notes), which is where
--    the "manager only for rules targeting their own pods/agents" scope check actually lives (RLS
--    alone can't express "the manager's scope over the TARGET," since that's a cross-table check
--    against org_manager_pods/org_members, and the write path also needs to emit the audit-log
--    row the task requires -- a bare permissive RLS policy could do neither).
-- =================================================================================================

create table public.org_territory_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  priority int not null,
  match_state text check (match_state is null or match_state ~ '^[A-Z]{2}$'),
  match_area_code text check (match_area_code is null or match_area_code ~ '^[0-9]{3}$'),
  target_type text not null check (target_type in ('agent', 'pod')),
  -- `on delete set null` (not cascade) even though the check below requires a non-null target for
  -- an existing row's OWN target_type: offboarding never hard-deletes `auth.users` (org_members
  -- just flips `status`), so this only fires on a genuine account deletion, which the task never
  -- names as a scenario to design around -- a rule left with a null target is simply never
  -- matchable again (resolve_territory_assignments' `agent_target` CTE already treats a
  -- non-active/missing target agent as "no match", see below), not a broken/crashing state.
  target_agent_id uuid references auth.users(id) on delete set null,
  -- `on delete cascade`: a rule pointing at a pod that no longer exists is meaningless, and
  -- `org_manager_pods` already uses this same cascade-from-pod convention.
  target_pod_id uuid references public.org_pods(id) on delete cascade,
  check (
    (target_type = 'agent' and target_agent_id is not null and target_pod_id is null)
    or (target_type = 'pod' and target_pod_id is not null and target_agent_id is null)
  ),
  check (match_state is not null or match_area_code is not null),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_org_territory_rules_org_priority on public.org_territory_rules(org_id, priority);

alter table public.org_territory_rules enable row level security;

create policy "owner/admin/manager can view territory rules"
  on public.org_territory_rules for select
  using (private.has_org_role(org_id, array['owner', 'admin', 'manager']));

revoke all on public.org_territory_rules from anon;

-- =================================================================================================
-- 4. CRUD RPCs. Role gate: owner/admin unconditional; manager only when BOTH the rule's existing
--    target (update/delete) and its new target (create/update) are inside their own
--    `is_agent_in_callers_pod_scope`/`is_pod_in_callers_pod_scope`. Every write emits exactly one
--    `private.log_org_action` row (the task's own requirement), after the write succeeds.
-- =================================================================================================

create function public.create_territory_rule(
  p_org uuid,
  p_match_state text,
  p_match_area_code text,
  p_target_type text,
  p_target_agent_id uuid default null,
  p_target_pod_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text := nullif(upper(btrim(coalesce(p_match_state, ''))), '');
  v_area text := nullif(btrim(coalesce(p_match_area_code, '')), '');
  v_priority int;
  v_id uuid;
begin
  if not (
    private.has_org_role(p_org, array['owner', 'admin'])
    or private.has_org_role(p_org, array['manager'])
  ) then
    raise exception 'only an owner, admin, or manager may manage territory rules';
  end if;

  if v_state is not null and v_state !~ '^[A-Z]{2}$' then
    raise exception 'match_state must be a 2-letter US state code';
  end if;
  if v_area is not null and v_area !~ '^[0-9]{3}$' then
    raise exception 'match_area_code must be a 3-digit area code';
  end if;
  if v_state is null and v_area is null then
    raise exception 'a rule needs match_state and/or match_area_code';
  end if;

  if p_target_type = 'agent' then
    if p_target_agent_id is null then
      raise exception 'target_agent_id is required for target_type=agent';
    end if;
    if not exists (
      select 1 from public.org_members
      where org_id = p_org and user_id = p_target_agent_id and status = 'active'
    ) then
      raise exception 'target agent is not an active member of this org';
    end if;
    if not private.is_agent_in_callers_pod_scope(p_org, p_target_agent_id) then
      raise exception 'that agent is outside your managed pods';
    end if;
  elsif p_target_type = 'pod' then
    if p_target_pod_id is null then
      raise exception 'target_pod_id is required for target_type=pod';
    end if;
    if not exists (select 1 from public.org_pods where id = p_target_pod_id and org_id = p_org) then
      raise exception 'pod not found';
    end if;
    if not private.is_pod_in_callers_pod_scope(p_org, p_target_pod_id) then
      raise exception 'that pod is outside your managed pods';
    end if;
  else
    raise exception 'target_type must be agent or pod';
  end if;

  select coalesce(max(priority), 0) + 1 into v_priority
  from public.org_territory_rules where org_id = p_org;

  insert into public.org_territory_rules (
    org_id, priority, match_state, match_area_code, target_type, target_agent_id, target_pod_id,
    created_by
  ) values (
    p_org, v_priority, v_state, v_area, p_target_type, p_target_agent_id, p_target_pod_id,
    auth.uid()
  )
  returning id into v_id;

  perform private.log_org_action(
    p_org, 'territory_rule.create', 'org_territory_rule', v_id,
    jsonb_build_object(
      'match_state', v_state, 'match_area_code', v_area, 'target_type', p_target_type,
      'target_agent_id', p_target_agent_id, 'target_pod_id', p_target_pod_id, 'priority', v_priority
    )
  );

  return v_id;
end;
$$;

revoke all on function public.create_territory_rule(uuid, text, text, text, uuid, uuid) from public, anon;
grant execute on function public.create_territory_rule(uuid, text, text, text, uuid, uuid) to authenticated;

create function public.update_territory_rule(
  p_org uuid,
  p_rule_id uuid,
  p_match_state text,
  p_match_area_code text,
  p_target_type text,
  p_target_agent_id uuid default null,
  p_target_pod_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_state text := nullif(upper(btrim(coalesce(p_match_state, ''))), '');
  v_area text := nullif(btrim(coalesce(p_match_area_code, '')), '');
  v_old public.org_territory_rules;
begin
  if not (
    private.has_org_role(p_org, array['owner', 'admin'])
    or private.has_org_role(p_org, array['manager'])
  ) then
    raise exception 'only an owner, admin, or manager may manage territory rules';
  end if;

  select * into v_old from public.org_territory_rules where id = p_rule_id and org_id = p_org;
  if v_old is null then
    raise exception 'territory rule not found';
  end if;

  -- The rule's CURRENT target must also be in the caller's scope -- a manager may not edit a rule
  -- they couldn't have created in the first place, even if the edit itself doesn't touch the
  -- target field.
  if v_old.target_type = 'agent' and not private.is_agent_in_callers_pod_scope(p_org, v_old.target_agent_id) then
    raise exception 'that agent is outside your managed pods';
  end if;
  if v_old.target_type = 'pod' and not private.is_pod_in_callers_pod_scope(p_org, v_old.target_pod_id) then
    raise exception 'that pod is outside your managed pods';
  end if;

  if v_state is not null and v_state !~ '^[A-Z]{2}$' then
    raise exception 'match_state must be a 2-letter US state code';
  end if;
  if v_area is not null and v_area !~ '^[0-9]{3}$' then
    raise exception 'match_area_code must be a 3-digit area code';
  end if;
  if v_state is null and v_area is null then
    raise exception 'a rule needs match_state and/or match_area_code';
  end if;

  if p_target_type = 'agent' then
    if p_target_agent_id is null then
      raise exception 'target_agent_id is required for target_type=agent';
    end if;
    if not exists (
      select 1 from public.org_members
      where org_id = p_org and user_id = p_target_agent_id and status = 'active'
    ) then
      raise exception 'target agent is not an active member of this org';
    end if;
    if not private.is_agent_in_callers_pod_scope(p_org, p_target_agent_id) then
      raise exception 'that agent is outside your managed pods';
    end if;
  elsif p_target_type = 'pod' then
    if p_target_pod_id is null then
      raise exception 'target_pod_id is required for target_type=pod';
    end if;
    if not exists (select 1 from public.org_pods where id = p_target_pod_id and org_id = p_org) then
      raise exception 'pod not found';
    end if;
    if not private.is_pod_in_callers_pod_scope(p_org, p_target_pod_id) then
      raise exception 'that pod is outside your managed pods';
    end if;
  else
    raise exception 'target_type must be agent or pod';
  end if;

  update public.org_territory_rules
  set
    match_state = v_state,
    match_area_code = v_area,
    target_type = p_target_type,
    target_agent_id = p_target_agent_id,
    target_pod_id = p_target_pod_id,
    updated_at = now()
  where id = p_rule_id;

  perform private.log_org_action(
    p_org, 'territory_rule.update', 'org_territory_rule', p_rule_id,
    jsonb_build_object(
      'old', jsonb_build_object(
        'match_state', v_old.match_state, 'match_area_code', v_old.match_area_code,
        'target_type', v_old.target_type, 'target_agent_id', v_old.target_agent_id,
        'target_pod_id', v_old.target_pod_id
      ),
      'new', jsonb_build_object(
        'match_state', v_state, 'match_area_code', v_area, 'target_type', p_target_type,
        'target_agent_id', p_target_agent_id, 'target_pod_id', p_target_pod_id
      )
    )
  );
end;
$$;

revoke all on function public.update_territory_rule(uuid, uuid, text, text, text, uuid, uuid) from public, anon;
grant execute on function public.update_territory_rule(uuid, uuid, text, text, text, uuid, uuid) to authenticated;

create function public.delete_territory_rule(p_org uuid, p_rule_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old public.org_territory_rules;
begin
  if not (
    private.has_org_role(p_org, array['owner', 'admin'])
    or private.has_org_role(p_org, array['manager'])
  ) then
    raise exception 'only an owner, admin, or manager may manage territory rules';
  end if;

  select * into v_old from public.org_territory_rules where id = p_rule_id and org_id = p_org;
  if v_old is null then
    raise exception 'territory rule not found';
  end if;

  if v_old.target_type = 'agent' and not private.is_agent_in_callers_pod_scope(p_org, v_old.target_agent_id) then
    raise exception 'that agent is outside your managed pods';
  end if;
  if v_old.target_type = 'pod' and not private.is_pod_in_callers_pod_scope(p_org, v_old.target_pod_id) then
    raise exception 'that pod is outside your managed pods';
  end if;

  delete from public.org_territory_rules where id = p_rule_id;

  perform private.log_org_action(
    p_org, 'territory_rule.delete', 'org_territory_rule', p_rule_id,
    jsonb_build_object(
      'match_state', v_old.match_state, 'match_area_code', v_old.match_area_code,
      'target_type', v_old.target_type, 'target_agent_id', v_old.target_agent_id,
      'target_pod_id', v_old.target_pod_id
    )
  );
end;
$$;

revoke all on function public.delete_territory_rule(uuid, uuid) from public, anon;
grant execute on function public.delete_territory_rule(uuid, uuid) to authenticated;

-- Reordering the WHOLE list at once is owner/admin only (a manager can still reprioritize by
-- deleting+recreating their own rules one at a time, or asking an owner/admin) -- keeps this one
-- action simple: no partial-scope reasoning about resequencing rules the caller can't otherwise
-- touch. `p_rule_ids` must be exactly this org's current rule set (order = new priority order);
-- anything else is rejected outright rather than silently repricing a subset.
create function public.reorder_territory_rules(p_org uuid, p_rule_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected int;
  v_given int;
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    raise exception 'only an owner or admin may reorder territory rules';
  end if;

  select count(*) into v_expected from public.org_territory_rules where org_id = p_org;
  v_given := coalesce(array_length(p_rule_ids, 1), 0);
  if v_given <> v_expected or v_given <> (
    select count(distinct r) from unnest(p_rule_ids) as r
  ) or exists (
    select 1 from unnest(p_rule_ids) as r
    where not exists (select 1 from public.org_territory_rules where id = r and org_id = p_org)
  ) then
    raise exception 'p_rule_ids must contain exactly this org''s current rule ids, no duplicates, no omissions';
  end if;

  -- `with ordinality` is the array's OWN 1-based position -- the new priority, directly. (An
  -- earlier draft re-derived this via a second, ORDER-BY-less `row_number() over ()` on top of
  -- it, which has no guaranteed row order at all; using the ordinality column itself avoids that
  -- class of bug entirely rather than needing an explicit ORDER BY to fix it.)
  update public.org_territory_rules t
  set priority = ord.rn, updated_at = now()
  from unnest(p_rule_ids) with ordinality as ord(id, rn)
  where t.id = ord.id;

  perform private.log_org_action(
    p_org, 'territory_rule.reorder', 'org', p_org, jsonb_build_object('rule_ids', to_jsonb(p_rule_ids))
  );
end;
$$;

revoke all on function public.reorder_territory_rules(uuid, uuid[]) from public, anon;
grant execute on function public.reorder_territory_rules(uuid, uuid[]) to authenticated;

-- =================================================================================================
-- 5. private.resolve_territory_assignments: the set-based matcher. For every ELIGIBLE lead in a
--    campaign (queued; unassigned only, unless `p_reassign`), finds the highest-priority rule
--    whose match_state (derived from the contact's phone area code via area_code_states) or
--    match_area_code condition holds (LATERAL + LIMIT 1 -- "first match wins" per lead), resolves
--    an 'agent' target directly (dropped back to "no match" if that agent is no longer an active
--    member -- the offboarded-target edge case) or a 'pod' target to one of that pod's ACTIVE,
--    campaign-assigned agents via round-robin by CURRENT LOAD (fewest queued/callback leads
--    already assigned to them IN THIS CAMPAIGN; ties by user_id) -- the Nth pod-targeted lead
--    (stable order by campaign_leads.position) goes to the agent at position (N mod pool size) in
--    that load-ordered list, so a batch of newly-matched leads spreads evenly starting from
--    whoever is least loaded right now, not "everything piles on the single currently-least-loaded
--    agent." A pod with zero qualifying agents resolves to `resolved_agent_id is null` -- the SAME
--    "unmatched" bucket a lead with no matching rule at all falls into (both are correctly folded
--    together by the caller: "no agent to route to" and "no rule matched" are both "leave for the
--    normal distribution").
--
--    Entirely set-based (CTEs + window functions, one query) -- the only per-row iteration in this
--    whole feature is `apply_territory_rules`'s loop over DISTINCT RESOLVED AGENTS (bounded by
--    roster size), never over leads, so this scales to a 100k-lead campaign the same way
--    `assign_campaign_leads` itself already does.
-- =================================================================================================

create function private.resolve_territory_assignments(
  p_org uuid,
  p_campaign_id uuid,
  p_reassign boolean
)
-- Review fix (eng2, audit/M5-C4/review-eng2.md SHOULD): `target_pod_id` is exposed here (already
-- carried through `agent_target`, just not selected out) so `preview_territory_rules` can roll a
-- pod-targeted rule's leads up into one "-> pod Y" line instead of fragmenting them into one row
-- per pod member -- guaranteed null for an agent-targeted rule by org_territory_rules' own CHECK
-- (target_type='agent' implies target_pod_id is null), so a plain `is not null` test is enough to
-- tell the two cases apart downstream.
returns table (lead_id uuid, resolved_agent_id uuid, target_pod_id uuid, rule_id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  with eligible as (
    select cl.id as lead_id, cl.position, c.phone_number
    from public.campaign_leads cl
    join public.contacts c on c.id = cl.contact_id
    where cl.campaign_id = p_campaign_id
      and cl.status = 'queued'
      and (p_reassign or cl.assigned_agent_id is null)
  ),
  lead_state as (
    select
      e.lead_id, e.position,
      private.nanp_area_code(e.phone_number) as area_code,
      acs.state
    from eligible e
    left join private.area_code_states acs on acs.area_code = private.nanp_area_code(e.phone_number)
  ),
  best_rule as (
    select ls.lead_id, ls.position, r.id as rule_id, r.target_type, r.target_agent_id, r.target_pod_id
    from lead_state ls
    left join lateral (
      -- Review fix (eng2, audit/M5-C4/review-eng2.md BLOCKER): a null field is "don't care", a
      -- SET field is a real filter -- so a rule with BOTH match_state and match_area_code set
      -- must match BOTH (AND/narrowing), not either one alone (the old OR let a
      -- both-fields-set rule silently match on state alone, widening instead of narrowing --
      -- e.g. match_state=TX + match_area_code=512 matched every TX lead, not just 512). The
      -- final line is redundant with the table's own CHECK constraint (at least one of the two
      -- is always set) but kept explicit so this WHERE clause is correct on its own terms.
      select r2.id, r2.target_type, r2.target_agent_id, r2.target_pod_id
      from public.org_territory_rules r2
      where r2.org_id = p_org
        and (r2.match_state is null or r2.match_state = ls.state)
        and (r2.match_area_code is null or r2.match_area_code = ls.area_code)
        and (r2.match_state is not null or r2.match_area_code is not null)
      order by r2.priority asc, r2.created_at asc
      limit 1
    ) r on true
  ),
  agent_target as (
    select
      br.lead_id, br.position, br.rule_id, br.target_type, br.target_pod_id,
      case
        when br.target_type = 'agent' and exists (
          select 1 from public.org_members m
          where m.org_id = p_org and m.user_id = br.target_agent_id and m.status = 'active'
        ) then br.target_agent_id
        else null
      end as direct_agent_id
    from best_rule br
  ),
  pod_pool as (
    select
      m.pod_id,
      ca.user_id as agent_id,
      row_number() over (
        partition by m.pod_id
        order by (
          select count(*) from public.campaign_leads cl3
          where cl3.campaign_id = p_campaign_id
            and cl3.assigned_agent_id = ca.user_id
            and cl3.status in ('queued', 'callback')
        ) asc, ca.user_id asc
      ) as rn,
      count(*) over (partition by m.pod_id) as pool_size
    from public.campaign_agents ca
    join public.org_members m
      on m.org_id = p_org and m.user_id = ca.user_id and m.status = 'active'
    where ca.campaign_id = p_campaign_id and m.pod_id is not null
  ),
  pod_seq as (
    select
      at.lead_id, at.target_pod_id,
      row_number() over (partition by at.target_pod_id order by at.position) - 1 as seq
    from agent_target at
    where at.target_type = 'pod' and at.target_pod_id is not null
  ),
  resolved_pod as (
    select ps.lead_id, pp.agent_id
    from pod_seq ps
    join pod_pool pp
      on pp.pod_id = ps.target_pod_id
     and pp.rn = (ps.seq % nullif(pp.pool_size, 0)) + 1
  )
  select
    at.lead_id,
    coalesce(at.direct_agent_id, rp.agent_id) as resolved_agent_id,
    -- Only meaningful (non-null) when the winning rule targeted a pod AND that pod actually
    -- resolved to a real agent -- an empty/offboarded pod's leads fall through to
    -- resolved_agent_id is null (the same "unmatched" bucket as no rule matching at all), and
    -- must NOT show up as a "-> pod Y" preview line with nobody behind it.
    case when rp.agent_id is not null then at.target_pod_id else null end as target_pod_id,
    at.rule_id
  from agent_target at
  left join resolved_pod rp on rp.lead_id = at.lead_id;
$$;

-- =================================================================================================
-- 6. public.preview_territory_rules / public.apply_territory_rules -- the AssignLeadsModal-
--    adjacent "Apply territory rules" action. Preview is read-only (never writes); apply commits
--    by grouping resolved leads by target agent and calling the SAME `assign_campaign_leads` RPC
--    per group (never a parallel INSERT/UPDATE path), so B3's own guards (active-agent check,
--    pod-scope re-check, audit logging) run exactly as they do for a manual assignment. `p_reassign`
--    is owner/admin-only in both (the task's own "an explicit reassign checkbox for owner/admin").
-- =================================================================================================

create function public.preview_territory_rules(p_campaign_id uuid, p_reassign boolean default false)
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

  -- Review fix (eng2, audit/M5-C4/review-eng2.md SHOULD): group by POD when the winning rule
  -- targeted one (r.target_pod_id is not null, per resolve_territory_assignments' own guard --
  -- only set when that pod actually resolved to a real agent), not by the individual agent that
  -- happened to win this round's round-robin slot -- the task's own "N leads -> agent X, M ->
  -- pod Y, K unmatched" wording is a policy-level rollup, not a preview of the round-robin split.
  -- The grouping key is computed ONCE (`resolved` below) and grouped on alone -- grouping on
  -- target_pod_id AND resolved_agent_id together would still fragment a pod's leads back into
  -- one row per pod member, since each member has a different resolved_agent_id.
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
    -- Lead's own dry-run caught this (42883): postgres has no max()/min() aggregate for uuid (no
    -- default sort-aggregate opclass registered for it, unlike text/int) -- every value of
    -- target_pod_id (or resolved_agent_id) is IDENTICAL within one group_key already (that's the
    -- whole point of grouping on it), so array_agg(...)[1] picks the same single value any max()
    -- would have, without needing a uuid aggregate that doesn't exist.
    coalesce((array_agg(resolved.target_pod_id))[1], (array_agg(resolved.resolved_agent_id))[1]) as target_id,
    case
      when bool_or(resolved.target_pod_id is not null) then coalesce(max(op.name), 'Unnamed pod')
      when bool_or(resolved.resolved_agent_id is not null) then
        coalesce(nullif(btrim(coalesce(max(p.first_name), '') || ' ' || coalesce(max(p.last_name), '')), ''), 'Unnamed teammate')
      else 'Unmatched (normal distribution)'
    end as target_name,
    count(*)::int as lead_count
  from resolved
  left join public.profiles p on resolved.target_pod_id is null and p.user_id = resolved.resolved_agent_id
  left join public.org_pods op on op.id = resolved.target_pod_id
  group by resolved.group_key
  order by lead_count desc;
end;
$$;

revoke all on function public.preview_territory_rules(uuid, boolean) from public, anon;
grant execute on function public.preview_territory_rules(uuid, boolean) to authenticated;

create function public.apply_territory_rules(p_campaign_id uuid, p_reassign boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_group record;
  v_count int;
  v_total_assigned int := 0;
  v_total_unmatched int := 0;
  v_by_agent jsonb := '[]'::jsonb;
begin
  select org_id into v_org_id from public.campaigns where id = p_campaign_id;
  if v_org_id is null then
    raise exception 'campaign not found';
  end if;
  if not (
    private.has_org_role(v_org_id, array['owner', 'admin'])
    or private.has_org_role(v_org_id, array['manager'])
  ) then
    raise exception 'only an owner, admin, or manager can apply territory rules';
  end if;
  if p_reassign and not private.has_org_role(v_org_id, array['owner', 'admin']) then
    raise exception 'only an owner or admin can reassign already-assigned leads';
  end if;

  select count(*) into v_total_unmatched
  from private.resolve_territory_assignments(v_org_id, p_campaign_id, p_reassign)
  where resolved_agent_id is null;

  for v_group in
    select resolved_agent_id, array_agg(lead_id) as lead_ids, count(*) as n
    from private.resolve_territory_assignments(v_org_id, p_campaign_id, p_reassign)
    where resolved_agent_id is not null
    group by resolved_agent_id
  loop
    -- A manager applying rules can hit a group whose resolved agent sits outside their OWN pod
    -- scope (e.g. an owner-authored rule they're merely re-running) -- assign_campaign_leads's own
    -- scope check would raise for that ONE group. Caught per-group so one out-of-scope group falls
    -- back to "unmatched" (with the reason recorded) instead of rolling back every group already
    -- applied earlier in this same loop.
    begin
      v_count := public.assign_campaign_leads(
        p_campaign_id,
        v_group.resolved_agent_id,
        jsonb_build_object('mode', 'lead_ids', 'lead_ids', to_jsonb(v_group.lead_ids))
      );
      v_total_assigned := v_total_assigned + v_count;
      v_by_agent := v_by_agent || jsonb_build_object('agent_id', v_group.resolved_agent_id, 'assigned', v_count);
    exception when others then
      v_total_unmatched := v_total_unmatched + v_group.n;
      v_by_agent := v_by_agent || jsonb_build_object(
        'agent_id', v_group.resolved_agent_id, 'assigned', 0, 'error', sqlerrm
      );
    end;
  end loop;

  perform private.log_org_action(
    v_org_id, 'territory_rules.apply', 'campaign', p_campaign_id,
    jsonb_build_object(
      'assigned', v_total_assigned, 'unmatched', v_total_unmatched, 'reassign', p_reassign,
      'by_agent', v_by_agent
    )
  );

  return jsonb_build_object('assigned', v_total_assigned, 'unmatched', v_total_unmatched, 'by_agent', v_by_agent);
end;
$$;

revoke all on function public.apply_territory_rules(uuid, boolean) from public, anon;
grant execute on function public.apply_territory_rules(uuid, boolean) to authenticated;

-- =================================================================================================
-- 7. assign_campaign_leads: additive 'lead_ids' filter mode -- the "SAME assignment path" the
--    task requires `apply_territory_rules` to use. Same signature (jsonb filter), so a plain
--    `create or replace` (R-038 doesn't apply -- no OUT-column/return-type change). Every existing
--    caller that never passes this mode is completely unaffected.
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
  v_mode text;
  v_count int;
  v_from_agent_id uuid;
  v_is_owner_admin boolean;
  v_lead_ids uuid[];
  v_bad_lead_id text;
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

  if p_agent_id is not null then
    insert into public.campaign_agents (campaign_id, user_id, org_id)
    values (p_campaign_id, p_agent_id, v_org_id)
    on conflict (campaign_id, user_id) do nothing;
  end if;

  v_mode := coalesce(p_filter ->> 'mode', 'all');
  if v_mode not in ('all', 'range', 'percentage', 'tag', 'by_current_agent', 'lead_ids') then
    raise exception 'p_filter.mode must be one of: all, range, percentage, tag, by_current_agent, lead_ids';
  end if;

  if v_mode = 'by_current_agent' then
    v_from_agent_id := (p_filter ->> 'from_agent_id')::uuid;
    if v_from_agent_id is null then
      raise exception 'p_filter.from_agent_id is required for mode=by_current_agent';
    end if;
    if not private.is_agent_in_callers_pod_scope(v_org_id, v_from_agent_id) then
      raise exception 'that agent is outside your managed pods';
    end if;
  end if;

  if v_mode = 'lead_ids' then
    -- Review fix (eng2, audit/M5-C4/review-eng2.md NIT): validate the shape BEFORE casting, so a
    -- malformed element raises this function's own clean exception instead of an unhandled
    -- Postgres "invalid input syntax for type uuid" -- unreachable from apply_territory_rules'
    -- own resolver (always real uuids), but this mode has no caller-identity restriction of its
    -- own and is grant-executed to authenticated, so a direct supabase.rpc() call with a bad
    -- array is a real, reachable path, not a hypothetical one.
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
  ),
  candidates as (
    select r.id
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
      or private.is_agent_in_callers_pod_scope(v_org_id, r.assigned_agent_id)
    )
  ),
  updated as (
    update public.campaign_leads cl
    set assigned_agent_id = p_agent_id, updated_at = now()
    from candidates
    where cl.id = candidates.id
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

-- MISSION-5 TASK-M5-N4 (eng1): round-robin lead distribution mode per campaign. Fair rotation
-- alongside manual (AssignLeadsModal/assign_campaign_leads) and territory rules (C4). See
-- audit/M5-N4/notes.md for the claim-path model this design is built on (read first, per the
-- task's own instruction) -- short version: `assigned_agent_id` IS the reservation
-- `claim_next_leads` respects, so this only ever needs to decide that column at the moment a lead
-- enters a campaign, never touch the dial/refill path itself (dialer-engine.ts untouched).

-- =================================================================================================
-- 1. campaigns.distribution_mode + campaign_distribution_state (the persisted rotation cursor).
-- =================================================================================================

alter table public.campaigns
  add column distribution_mode text not null default 'manual'
    check (distribution_mode in ('manual', 'round_robin'));

comment on column public.campaigns.distribution_mode is
  'TASK-M5-N4: ''manual'' (default, todays behaviour -- nothing auto-assigns) or ''round_robin''
   (every lead that enters this campaign unassigned is auto-assigned via campaign_distribution_state''s
   rotating cursor, after territory rules get first shot). Set only via set_campaign_distribution_mode
   (owner/admin, or a manager whose campaign is fully inside their pod scope).';

create table public.campaign_distribution_state (
  campaign_id uuid primary key references public.campaigns(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  last_agent_id uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

comment on table public.campaign_distribution_state is
  'TASK-M5-N4: one row per campaign that has ever round-robin-assigned a lead. last_agent_id is the
   most recently assigned agent in rotation order (created_at, user_id over campaign_agents joined
   to active org_members) -- the next batch resumes AFTER this agent, never restarting at the top.
   Written only by private.round_robin_assign_leads (locked `for update` first, so two concurrent
   imports on the same campaign serialize instead of double-assigning or skipping a slot).';

alter table public.campaign_distribution_state enable row level security;

create policy "org members can view campaign distribution state"
  on public.campaign_distribution_state for select
  using (private.is_org_member(org_id));

-- No insert/update/delete policy: written only by the SECURITY DEFINER functions below (RPC-only
-- writer, same pattern as disposition_quality_rules/E7) -- a client has no reason to ever touch
-- the cursor directly.

revoke all on public.campaign_distribution_state from anon;

-- =================================================================================================
-- 2. private.is_campaign_in_callers_pod_scope: "a manager for a campaign fully inside their pod
--    scope" (requirement 2's own phrase) -- no existing helper covers a WHOLE campaign, only
--    is_agent_in_callers_pod_scope (per-agent, 20260927160550). True for owner/admin always; true
--    for a manager only when EVERY agent currently on this campaign's roster (campaign_agents) is
--    already in their own pod scope -- vacuously true for a campaign with zero agents assigned yet
--    (nothing to be "outside" scope of). Reuses is_agent_in_callers_pod_scope per row rather than
--    re-deriving the org_manager_pods join, so there is exactly one definition of "in scope."
-- =================================================================================================

create function private.is_campaign_in_callers_pod_scope(p_org uuid, p_campaign uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  -- Lead's own live dry-run catch (BLOCKER): only an ACTIVE campaign_agents row can count
  -- against scope. is_agent_in_callers_pod_scope unconditionally returns false for a
  -- disabled/offboarded member (its own `m.status = 'active'` join condition), which used to make
  -- ANY manager fail this check the moment a disabled agent was still on the campaign's roster --
  -- including the manager whose own pod that agent used to belong to. A disabled member can never
  -- receive a lead anyway (round_robin_assign_leads' own eligible CTE already excludes them), so
  -- they must not count as "an agent outside scope" either.
  select
    private.has_org_role(p_org, array['owner', 'admin'])
    or (
      private.has_org_role(p_org, array['manager'])
      and not exists (
        select 1 from public.campaign_agents ca
        join public.org_members m on m.org_id = ca.org_id and m.user_id = ca.user_id
        where ca.campaign_id = p_campaign
          and m.status = 'active'
          and not private.is_agent_in_callers_pod_scope(p_org, ca.user_id)
      )
    );
$$;

revoke all on function private.is_campaign_in_callers_pod_scope(uuid, uuid) from public, anon;
grant execute on function private.is_campaign_in_callers_pod_scope(uuid, uuid) to authenticated;

-- =================================================================================================
-- 3. set_campaign_distribution_mode: a dedicated RPC (not a widened campaigns RLS UPDATE policy)
--    -- "owner or admin can update campaigns" is org-wide and would let ANY in-scope manager edit
--    every OTHER campaign setting too if reused/widened, not just this one field. Same
--    single-purpose-setter shape as set_disposition_quality_rule/set_quality_flag_status (E7).
-- =================================================================================================

create function public.set_campaign_distribution_mode(
  p_campaign_id uuid,
  p_mode text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  -- p_org is NOT a parameter here -- matches assign_campaign_leads/preview_territory_rules/
  -- apply_territory_rules (same file family, C4), which all derive org_id from the campaign
  -- itself rather than trusting a client-supplied org id.
  select org_id into v_org_id from public.campaigns where id = p_campaign_id and deleted_at is null;
  if v_org_id is null then
    raise exception 'campaign not found';
  end if;

  if p_mode not in ('manual', 'round_robin') then
    raise exception 'p_mode must be one of: manual, round_robin';
  end if;

  if not private.is_campaign_in_callers_pod_scope(v_org_id, p_campaign_id) then
    raise exception 'only an owner, admin, or a manager whose pods cover every agent on this campaign can set its distribution mode';
  end if;

  update public.campaigns set distribution_mode = p_mode, updated_at = now() where id = p_campaign_id;

  perform private.log_org_action(
    v_org_id, 'campaign.distribution_mode.update', 'campaign', p_campaign_id,
    jsonb_build_object('mode', p_mode)
  );
end;
$$;

revoke all on function public.set_campaign_distribution_mode(uuid, text) from public, anon;
grant execute on function public.set_campaign_distribution_mode(uuid, text) to authenticated;

-- =================================================================================================
-- 4. private.resolve_territory_assignments/4: a NEW 4-arg OVERLOAD of the existing 3-arg C4
--    function (20260927224036_territory_rules.sql, not edited -- that migration's own signature
--    has existing callers, preview_territory_rules/apply_territory_rules, that must keep resolving
--    to the original 3-arg definition; Postgres overloads by argument list, so adding a 4th
--    parameter here creates a SEPARATE function rather than replacing anything, with zero risk to
--    those callers). Body is the original's, with one addition: eligible is restricted to
--    `p_lead_ids` when given (this trigger's own new-rows batch only) -- the un-widened version
--    always scans the WHOLE campaign's unassigned backlog, which is right for a user-invoked
--    preview/apply but wrong for an automatic per-batch pass (it would re-offer leads round-robin
--    already correctly placed after an earlier rule miss).
-- =================================================================================================

create function private.resolve_territory_assignments(
  p_org uuid,
  p_campaign_id uuid,
  p_reassign boolean,
  p_lead_ids uuid[]
)
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
      and (p_lead_ids is null or cl.id = any(p_lead_ids))
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
    case when rp.agent_id is not null then at.target_pod_id else null end as target_pod_id,
    at.rule_id
  from agent_target at
  left join resolved_pod rp on rp.lead_id = at.lead_id;
$$;

-- Deliberately NOT granted to authenticated: only ever called from other SECURITY DEFINER
-- functions in this migration (the trigger, and indirectly nothing else) -- same lockdown
-- rationale as the original 3-arg version and private.log_org_action.
revoke all on function private.resolve_territory_assignments(uuid, uuid, boolean, uuid[]) from public, anon, authenticated;

-- =================================================================================================
-- 5. private.round_robin_assign_leads: the shared, set-based assignment core. Called by BOTH the
--    insert trigger (system-driven, no caller-role check needed -- the owner/admin already granted
--    this authority once, by turning distribution_mode to 'round_robin') and
--    rebalance_campaign_distribution (user-driven, checks role+scope itself before calling this).
--    Deliberately NOT routed through assign_campaign_leads (the task's OTHER offered option) --
--    that RPC's first line is `has_org_role(..., array['owner','admin','manager'])` against
--    auth.uid(), which would raise for the ordinary case of an AGENT adding their own lead (Add
--    new contact) or a service-role import with no JWT at all, breaking auto-assignment for
--    exactly the common paths it needs to cover.
--
--    p_lead_ids is pre-filtered by the caller to campaign_id/status='queued'/assigned_agent_id is
--    null (the trigger: this batch's own rows after the territory pass; rebalance: the whole
--    current backlog) -- this function trusts that filter and does one set-based UPDATE, no loop.
-- =================================================================================================

create function private.round_robin_assign_leads(
  p_org uuid,
  p_campaign_id uuid,
  p_lead_ids uuid[]
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_last_agent_id uuid;
  v_eligible_count int;
  v_assigned_count int;
  v_new_last_agent_id uuid;
begin
  if p_lead_ids is null or array_length(p_lead_ids, 1) is null then
    return 0;
  end if;

  insert into public.campaign_distribution_state (campaign_id, org_id)
  values (p_campaign_id, p_org)
  on conflict (campaign_id) do nothing;

  select last_agent_id into v_last_agent_id
  from public.campaign_distribution_state
  where campaign_id = p_campaign_id
  for update;

  select count(*) into v_eligible_count
  from public.campaign_agents ca
  join public.org_members om on om.org_id = ca.org_id and om.user_id = ca.user_id and om.status = 'active'
  where ca.campaign_id = p_campaign_id;

  if v_eligible_count = 0 then
    return 0;
  end if;

  -- Deliberately no temp tables here (a `create temporary table ... on commit drop` would raise
  -- "relation already exists" the second time this function runs inside the SAME transaction --
  -- a real case, not hypothetical: one transaction can contain multiple campaign_leads INSERTs,
  -- e.g. a dry run's own multi-batch fixtures, or two chunked upserts sharing a caller-opened
  -- transaction) -- one set-based statement with CTEs instead. `eligible` order is
  -- (created_at, user_id) -- first-added-to-the-campaign agent goes first, ties broken by id.
  -- Resume AFTER the cursor's agent; if that agent is no longer eligible (removed/offboarded
  -- since the last batch), restart at position 1 of whoever remains rather than error or skip
  -- the whole batch -- documented edge case (notes.md), not "perfectly seamless" but never blocks.
  with eligible as (
    select
      ca.user_id,
      row_number() over (order by ca.created_at, ca.user_id) as rn,
      count(*) over () as cnt
    from public.campaign_agents ca
    join public.org_members om on om.org_id = ca.org_id and om.user_id = ca.user_id and om.status = 'active'
    where ca.campaign_id = p_campaign_id
  ),
  start_rn as (
    select
      coalesce((select (rn % cnt) + 1 from eligible where user_id = v_last_agent_id), 1) as rn,
      (select cnt from eligible limit 1) as cnt
  ),
  leads as (
    select cl.id, row_number() over (order by cl.position, cl.id) - 1 as seq
    from public.campaign_leads cl
    where cl.id = any(p_lead_ids) and cl.campaign_id = p_campaign_id
      -- N4 review BLOCKER (eng2): re-check at write time; the caller's list may be stale.
      and cl.assigned_agent_id is null
  ),
  assignment as (
    select l.id as lead_id, e.user_id as agent_id, l.seq
    from leads l
    cross join start_rn s
    join eligible e on e.rn = (((s.rn - 1 + l.seq) % s.cnt) + 1)
  ),
  updated as (
    update public.campaign_leads cl
    set assigned_agent_id = a.agent_id, updated_at = now()
    from assignment a
    where cl.id = a.lead_id
      -- Re-evaluated on the newest row version if a concurrent manual assign got there first.
      and cl.assigned_agent_id is null
    returning a.agent_id, a.seq
  )
  select count(*), (array_agg(agent_id order by seq desc))[1]
  into v_assigned_count, v_new_last_agent_id
  from updated;

  if v_new_last_agent_id is not null then
    update public.campaign_distribution_state
    set last_agent_id = v_new_last_agent_id, updated_at = now()
    where campaign_id = p_campaign_id;
  end if;

  if v_assigned_count > 0 then
    perform private.log_org_action(
      p_org, 'campaign_leads.round_robin_assign', 'campaign', p_campaign_id,
      jsonb_build_object('assigned', v_assigned_count, 'cursor_agent_id', v_new_last_agent_id)
    );
  end if;

  return coalesce(v_assigned_count, 0);
end;
$$;

revoke all on function private.round_robin_assign_leads(uuid, uuid, uuid[]) from public, anon, authenticated;

-- =================================================================================================
-- 6. private.auto_distribute_new_campaign_leads: the AFTER INSERT trigger function. FOR EACH
--    STATEMENT with a transition table -- one set-based pass per INSERT statement (every known
--    caller chunks at <=200 rows: campaign-queue-io.ts's upsertCampaignLeads, and the raw client
--    upsert in addLeadsToCampaign), never a per-row loop even for a 100k-row import. Territory
--    rules (when the org has any) get first shot at the batch; round-robin only ever touches
--    whatever they leave unmatched (requirement 3's own ordering).
-- =================================================================================================

create function private.auto_distribute_new_campaign_leads()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign record;
  v_batch_ids uuid[];
  v_territory_group record;
  v_territory_assigned int := 0;
  v_remaining_ids uuid[];
  v_rr_assigned int;
begin
  for v_campaign in
    select distinct c.id, c.org_id
    from new_rows nr
    join public.campaigns c on c.id = nr.campaign_id
    where c.distribution_mode = 'round_robin'
  loop
    -- NIT (lead's dry-run): reset per campaign -- this is logged per campaign below, and the
    -- declare block's initializer only runs once for the whole trigger firing, not per iteration.
    v_territory_assigned := 0;

    select array_agg(nr.id) into v_batch_ids
    from new_rows nr
    where nr.campaign_id = v_campaign.id and nr.status = 'queued' and nr.assigned_agent_id is null;

    if v_batch_ids is null or array_length(v_batch_ids, 1) is null then
      continue;
    end if;

    -- Territory pass: only when the org actually has rules configured (skips the resolver
    -- entirely otherwise -- cheap, and keeps the common "no territory rules" org's import path
    -- from paying for a query that can never match anything).
    if exists (select 1 from public.org_territory_rules where org_id = v_campaign.org_id) then
      for v_territory_group in
        select resolved_agent_id, array_agg(lead_id) as lead_ids, count(*) as n
        from private.resolve_territory_assignments(v_campaign.org_id, v_campaign.id, false, v_batch_ids)
        where resolved_agent_id is not null
        group by resolved_agent_id
      loop
        update public.campaign_leads
        set assigned_agent_id = v_territory_group.resolved_agent_id, updated_at = now()
        where id = any(v_territory_group.lead_ids);
        v_territory_assigned := v_territory_assigned + v_territory_group.n;
      end loop;

      if v_territory_assigned > 0 then
        perform private.log_org_action(
          v_campaign.org_id, 'campaign_leads.territory_auto_assign', 'campaign', v_campaign.id,
          jsonb_build_object('assigned', v_territory_assigned)
        );
      end if;
    end if;

    -- Round-robin gets only what territory rules left unmatched (or everything, when there were
    -- no rules to begin with).
    select array_agg(id) into v_remaining_ids
    from public.campaign_leads
    where id = any(v_batch_ids) and assigned_agent_id is null;

    if v_remaining_ids is not null and array_length(v_remaining_ids, 1) is not null then
      v_rr_assigned := private.round_robin_assign_leads(v_campaign.org_id, v_campaign.id, v_remaining_ids);
    end if;
  end loop;

  return null;
exception when others then
  -- Same "never block the write it's attached to" contract as E7's disposition trigger: a bug in
  -- auto-distribution must never fail the INSERT of the leads themselves (a CSV import erroring
  -- out entirely because round-robin/territory resolution hit a bad state would be far worse than
  -- the leads simply landing unassigned this one time -- they self-heal via Rebalance/manual
  -- assign, same as claim_next_leads' own free-for-all pool already handles unassigned leads).
  raise warning 'auto_distribute_new_campaign_leads failed: %', sqlerrm;
  return null;
end;
$$;

create trigger campaign_leads_auto_distribute
  after insert on public.campaign_leads
  referencing new table as new_rows
  for each statement execute function private.auto_distribute_new_campaign_leads();

-- =================================================================================================
-- 7. rebalance_campaign_distribution: "Rebalance now" -- round-robins every currently-UNASSIGNED
--    queued lead in the campaign (never touches an already-assigned one, per requirement 5). Same
--    role+scope check as set_campaign_distribution_mode; requires the campaign to actually be in
--    round_robin mode (rebalancing a manual-mode campaign is a no-op by definition, and silently
--    assigning leads a manager didn't expect round-robin to touch would be a surprise, not a fix).
-- =================================================================================================

create function public.rebalance_campaign_distribution(p_campaign_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_mode text;
  v_lead_ids uuid[];
begin
  select org_id, distribution_mode into v_org_id, v_mode
  from public.campaigns where id = p_campaign_id and deleted_at is null;
  if v_org_id is null then
    raise exception 'campaign not found';
  end if;

  if not private.is_campaign_in_callers_pod_scope(v_org_id, p_campaign_id) then
    raise exception 'only an owner, admin, or a manager whose pods cover every agent on this campaign can rebalance it';
  end if;

  if v_mode <> 'round_robin' then
    raise exception 'campaign is not in round_robin distribution mode';
  end if;

  select array_agg(id) into v_lead_ids
  from public.campaign_leads
  where campaign_id = p_campaign_id and status = 'queued' and assigned_agent_id is null;

  if v_lead_ids is null or array_length(v_lead_ids, 1) is null then
    return 0;
  end if;

  return private.round_robin_assign_leads(v_org_id, p_campaign_id, v_lead_ids);
end;
$$;

revoke all on function public.rebalance_campaign_distribution(uuid) from public, anon;
grant execute on function public.rebalance_campaign_distribution(uuid) to authenticated;

-- =================================================================================================
-- 8. campaigns_with_stats: rebuilt to add distribution_mode -- AND, incidentally, to restore 4
--    columns the live definition (20260926080200_call_card_scripts.sql) silently dropped despite
--    its own "byte-identical to 20260924001500 + 2 columns" comment: voicemail_drop_mode (added
--    20260925050000, before 080200 ran) and the 3 high_lines_guard_* columns (added
--    20260926070005, also before 080200 ran). Confirmed by grepping every `alter table
--    public.campaigns add column` across every migration and diffing against the view's actual
--    SELECT list -- a real, currently-shipped bug (CampaignManageModal's Voicemail Drop dropdown
--    and 8-10 lines guard checkbox/notice have read `undefined` since that migration landed), not
--    something to leave broken a third time while rebuilding this same view for N4's own column.
-- =================================================================================================

drop view public.campaigns_with_stats;

create view public.campaigns_with_stats as
select
  c.id,
  c.user_id,
  c.org_id,
  c.name,
  c.status,
  c.total_calls_made,
  c.connect_rate,
  c.last_called_at,
  c.lines,
  c.amd_mode,
  c.voicemail_drop_mode,
  c.caller_id_number_id,
  c.max_attempts,
  c.retry_interval_minutes,
  c.calling_window_start,
  c.calling_window_end,
  c.abandon_message_enabled,
  c.script_text,
  c.objection_sheet_text,
  c.high_lines_guard_enabled,
  c.high_lines_guard_last_triggered_at,
  c.high_lines_guard_last_drop_rate_pct,
  c.distribution_mode,
  c.created_at,
  c.updated_at,
  count(cl.id)::integer as total_contacts,
  count(cl.id) filter (where cl.status = 'queued')::integer as queued,
  count(cl.id) filter (where cl.status = 'completed')::integer as completed,
  count(cl.id) filter (where cl.status = 'passthrough')::integer as passthrough
from public.campaigns c
left join public.campaign_leads cl on cl.campaign_id = c.id
where c.deleted_at is null
group by c.id;

alter view public.campaigns_with_stats set (security_invoker = on);

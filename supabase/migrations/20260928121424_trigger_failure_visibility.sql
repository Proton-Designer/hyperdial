-- MISSION-5 TASK-M5-O1 Part B (R3's own next-5 #1, audit/M5/edge-cases-v2.md): three LIVE "never
-- block the write" trigger guards -- E7's private.evaluate_disposition_quality_rules (call_legs),
-- N4's private.auto_distribute_new_campaign_leads (campaign_leads), G6's
-- private.create_inbox_item_from_ended_inbound_call (inbound_calls) -- all swallow a genuine
-- failure as a bare `raise warning`, which the Management API never returns and no admin UI ever
-- sees. This migration gives all three a shared, capped, owner/admin-visible failure log, with
-- ONLY the exception branch changed in each -- every other line of all three function bodies is
-- copied verbatim from their current live definitions (20260927231644, 20260928111616,
-- 20260927233652 respectively). These are live functions; per R-037 this is a NEW migration, not
-- an edit of any of the three original files.
--
-- =================================================================================================
-- 1. trigger_failures -- public (private isn't exposed to PostgREST; the Settings UI reads this
--    directly), owner/admin SELECT only. `source` is a fixed enum (one value per guarded
--    trigger, not a free-text label) so a typo in a future 4th guard can't silently create an
--    unqueryable one-off value. `row_id` is deliberately untyped/unconstrained (no FK) -- it
--    means something different per source (a call_leg id for E7, a campaign id for N4 since that
--    trigger is FOR EACH STATEMENT with no single row to point at, an inbound_call id for G6) and
--    must survive even if the row it names is later deleted.
-- =================================================================================================

create table public.trigger_failures (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  source text not null check (source in (
    'disposition_quality_checks', 'round_robin_distribution', 'shared_inbox'
  )),
  row_id uuid,
  error text not null,
  acknowledged_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_trigger_failures_org_created on public.trigger_failures(org_id, created_at desc);
create index idx_trigger_failures_org_source_created on public.trigger_failures(org_id, source, created_at);

alter table public.trigger_failures enable row level security;

create policy "owner or admin can view trigger failures"
  on public.trigger_failures for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- No insert/update/delete policy for any client role -- private.log_trigger_failure (writer,
-- called only from inside the three guards below) and acknowledge_trigger_failure (status-only
-- writer) are both SECURITY DEFINER and bypass RLS entirely, same lockdown as org_audit_log.
revoke all on public.trigger_failures from anon;

-- =================================================================================================
-- 2. private.log_trigger_failure -- the shared writer every guard's exception branch calls. Its
--    OWN exception handler (task's own instruction #1: "wrapped in its own nested begin/exception
--    so a failed log insert can never escalate") means a broken log write can NEVER itself throw
--    back into the guard that called it -- that guard is already mid-exception-handling, trying
--    to fail safely; a second failure there must not become a third one. Daily cap (100/org/source)
--    is a plain count-then-insert (not atomic against a concurrent flood, but a trigger firing
--    concurrently at flood volume is exactly the pathological case this cap exists to bound, not
--    to bound EXACTLY -- a few rows over 100 on a genuine stampede is an acceptable slop, an
--    unbounded table is not). UTC calendar day, not the org's own timezone -- this is an internal
--    ops signal, not a user-facing "today", so paying for an org_timezone_settings lookup on every
--    guarded trigger firing (hot path) isn't worth it for a boundary nobody user-facing reads.
-- =================================================================================================

create function private.log_trigger_failure(
  p_org uuid,
  p_source text,
  p_row_id uuid,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count_today int;
begin
  select count(*) into v_count_today
  from public.trigger_failures
  where org_id = p_org and source = p_source and created_at >= date_trunc('day', now());

  if v_count_today >= 100 then
    return;
  end if;

  insert into public.trigger_failures (org_id, source, row_id, error)
  values (p_org, p_source, p_row_id, p_error);
exception when others then
  -- Never escalate -- see header. A broken trigger_failures insert (e.g. org_id somehow null)
  -- must not turn "the disposition/lead-assign/inbox-item write still commits" into a lie.
  null;
end;
$$;

-- O1 review SHOULD (eng2): only the guarded trigger functions (owner-executed) call this.
revoke all on function private.log_trigger_failure(uuid, text, uuid, text) from public, anon, authenticated;

-- =================================================================================================
-- 3. public.acknowledge_trigger_failure -- owner/admin dismiss, cheap (a timestamp flip, no
--    delete -- the row survives for history same as every other soft-state column in this
--    mission). Acknowledging is per-row, not per-org-"mark all read": simplest thing that still
--    lets an admin clear a stampede of 100 identical rows without losing the ability to see a
--    NEW, different failure show up right after.
-- =================================================================================================

create function public.acknowledge_trigger_failure(p_org uuid, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    raise exception 'only an owner or admin can acknowledge a background failure';
  end if;
  update public.trigger_failures
  set acknowledged_at = now()
  where id = p_id and org_id = p_org and acknowledged_at is null;
end;
$$;

revoke all on function public.acknowledge_trigger_failure(uuid, uuid) from public, anon;
grant execute on function public.acknowledge_trigger_failure(uuid, uuid) to authenticated;

-- =================================================================================================
-- 4. The 3 guarded trigger functions -- byte-identical to their current live bodies EXCEPT the
--    exception branch, which now also calls private.log_trigger_failure before the same
--    `raise warning` each already had (the warning stays -- still useful in a live Postgres log
--    tail during development/on-call, this migration only ADDS the admin-visible channel, doesn't
--    replace the existing one). `create or replace` is enough for all three (same signature,
--    same `returns trigger`, no OUT-column change -- R-038 doesn't apply).
-- =================================================================================================

-- ---- 4a. E7: private.evaluate_disposition_quality_rules (verbatim from 20260927231644, lines
-- 284-424, except the exception branch) ----------------------------------------------------------

create or replace function private.evaluate_disposition_quality_rules()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_checks_enabled boolean;
  v_agent_id uuid;
  v_disposition_key text;
  v_rule record;
  v_missing jsonb;
  v_field text;
  v_min_seconds int;
  v_talk_seconds int;
begin
  if new.dispositioned_at is null or new.kind <> 'contact' or new.disposition_id is null then
    return new;
  end if;

  select enabled into v_checks_enabled
  from public.org_quality_check_settings where org_id = new.org_id;
  if not coalesce(v_checks_enabled, false) then
    delete from public.disposition_quality_flags where call_leg_id = new.id;
    return new;
  end if;

  select key into v_disposition_key from public.dispositions where id = new.disposition_id;
  if v_disposition_key is null then
    return new;
  end if;

  v_agent_id := private.dial_session_agent_id(new.session_id);
  if v_agent_id is null then
    return new;
  end if;

  delete from public.disposition_quality_flags
  where call_leg_id = new.id
    and rule_type not in (
      select rule_type from public.disposition_quality_rules
      where org_id = new.org_id and disposition_id = new.disposition_id
        and enabled and rule_type in ('min_talk_seconds', 'required_field')
    );

  for v_rule in
    select * from public.disposition_quality_rules
    where org_id = new.org_id and disposition_id = new.disposition_id
      and enabled and rule_type in ('min_talk_seconds', 'required_field')
  loop
    if v_rule.rule_type = 'min_talk_seconds' then
      v_min_seconds := (v_rule.config ->> 'min_seconds')::int;
      v_talk_seconds := coalesce(new.duration_seconds, 0);
      if v_talk_seconds < v_min_seconds then
        insert into public.disposition_quality_flags (
          org_id, call_leg_id, rule_id, rule_type, disposition_id, disposition_key,
          agent_id, dispositioned_by, detail
        )
        values (
          new.org_id, new.id, v_rule.id, v_rule.rule_type, new.disposition_id, v_disposition_key,
          v_agent_id, new.dispositioned_by,
          jsonb_build_object('talk_seconds', v_talk_seconds, 'min_required_seconds', v_min_seconds)
        )
        on conflict (call_leg_id, rule_type)
        do update set
          rule_id = excluded.rule_id, disposition_id = excluded.disposition_id,
          disposition_key = excluded.disposition_key, agent_id = excluded.agent_id,
          dispositioned_by = excluded.dispositioned_by, detail = excluded.detail;
      else
        delete from public.disposition_quality_flags
        where call_leg_id = new.id and rule_type = v_rule.rule_type;
      end if;

    elsif v_rule.rule_type = 'required_field' then
      v_missing := '[]'::jsonb;
      for v_field in select jsonb_array_elements_text(v_rule.config -> 'fields')
      loop
        if v_field = 'notes' and (new.notes is null or trim(new.notes) = '') then
          v_missing := v_missing || to_jsonb(v_field);
        elsif v_field = 'callback_at' and new.callback_at is null then
          v_missing := v_missing || to_jsonb(v_field);
        end if;
      end loop;

      if jsonb_array_length(v_missing) > 0 then
        insert into public.disposition_quality_flags (
          org_id, call_leg_id, rule_id, rule_type, disposition_id, disposition_key,
          agent_id, dispositioned_by, detail
        )
        values (
          new.org_id, new.id, v_rule.id, v_rule.rule_type, new.disposition_id, v_disposition_key,
          v_agent_id, new.dispositioned_by,
          jsonb_build_object('missing_fields', v_missing)
        )
        on conflict (call_leg_id, rule_type)
        do update set
          rule_id = excluded.rule_id, disposition_id = excluded.disposition_id,
          disposition_key = excluded.disposition_key, agent_id = excluded.agent_id,
          dispositioned_by = excluded.dispositioned_by, detail = excluded.detail;
      else
        delete from public.disposition_quality_flags
        where call_leg_id = new.id and rule_type = v_rule.rule_type;
      end if;
    end if;
  end loop;

  return new;
exception when others then
  raise warning 'evaluate_disposition_quality_rules failed for leg %: %', new.id, sqlerrm;
  perform private.log_trigger_failure(
    new.org_id, 'disposition_quality_checks', new.id, sqlstate || ': ' || sqlerrm
  );
  return new;
end;
$$;

-- ---- 4b. N4: private.auto_distribute_new_campaign_leads (verbatim from 20260928111616, lines
-- 382-459, except the exception branch). FOR EACH STATEMENT -- there is no `new`/`old` row here,
-- so the log uses v_campaign.org_id/v_campaign.id (the loop variable, whatever it last held when
-- the exception was raised -- may be null if the failure happened before the loop's first
-- iteration, e.g. in the initial campaign lookup itself; logged as-is rather than guessed at). ----

create or replace function private.auto_distribute_new_campaign_leads()
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
    v_territory_assigned := 0;

    select array_agg(nr.id) into v_batch_ids
    from new_rows nr
    where nr.campaign_id = v_campaign.id and nr.status = 'queued' and nr.assigned_agent_id is null;

    if v_batch_ids is null or array_length(v_batch_ids, 1) is null then
      continue;
    end if;

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

    select array_agg(id) into v_remaining_ids
    from public.campaign_leads
    where id = any(v_batch_ids) and assigned_agent_id is null;

    if v_remaining_ids is not null and array_length(v_remaining_ids, 1) is not null then
      v_rr_assigned := private.round_robin_assign_leads(v_campaign.org_id, v_campaign.id, v_remaining_ids);
    end if;
  end loop;

  return null;
exception when others then
  raise warning 'auto_distribute_new_campaign_leads failed: %', sqlerrm;
  perform private.log_trigger_failure(
    v_campaign.org_id, 'round_robin_distribution', v_campaign.id, sqlstate || ': ' || sqlerrm
  );
  return null;
end;
$$;

-- ---- 4c. G6: private.create_inbox_item_from_ended_inbound_call (verbatim from 20260927233652,
-- lines 256-276, except the exception branch) ----------------------------------------------------

create or replace function private.create_inbox_item_from_ended_inbound_call()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.state = 'ended' and old.state is distinct from 'ended'
     and new.outcome in ('missed', 'voicemail') then
    perform private.upsert_inbox_item_from_missed_call(
      new.org_id, new.from_e164, new.contact_id, new.to_number_id, new.routed_to_user_id
    );
  end if;
  return new;
exception when others then
  raise warning 'create_inbox_item_from_ended_inbound_call failed for call %: %', new.id, sqlerrm;
  perform private.log_trigger_failure(
    new.org_id, 'shared_inbox', new.id, sqlstate || ': ' || sqlerrm
  );
  return new;
end;
$$;

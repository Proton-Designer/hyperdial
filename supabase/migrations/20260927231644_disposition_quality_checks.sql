-- MISSION-5 TASK-M5-E7 (reassigned to eng1 23:1x): disposition quality checks. A failed rule
-- NEVER blocks or changes the disposition -- it writes a flag a supervisor reviews later. Three
-- v1 rule types, per the task spec:
--   (a) min_talk_seconds  -- a disposition requires >= N seconds of bridged talk time.
--   (b) required_field    -- a disposition requires notes and/or a callback time to be set.
--   (c) rate_outlier      -- an agent's share of a disposition today is > Xx the team's --
--       evaluated ON READ (get_disposition_rate_outliers below), NOT stored as a flag row: it is
--       an aggregate-over-today's-rows computation, not a fact about one call_legs row, so it
--       can't be evaluated O(1) at disposition time the way (a)/(b) can.
--
-- Lead decision (23:1x, on reassignment): evaluate via a DB trigger on the write path that
-- actually carries a disposition event -- `public.call_legs` (disposition_id/notes/callback_at/
-- dispositioned_at are UPDATEd there by submit_disposition; the `public.dispositions` table is
-- only the per-org catalog of disposition TYPES, seeded once and rarely touched -- a trigger on
-- that table would never fire per real call). This also, per the lead's own reasoning, "catches
-- every write path": submit_disposition is the only function that ever sets
-- call_legs.dispositioned_at, so one trigger there covers the agent path, a re-submit/retry, AND
-- eng2's N1 supervisor-takeover disposition path (a supervisor dispositions a taken-over leg
-- through the same RPC) -- see dispositioned_by's own comment below for how that attribution
-- works. Not touching dialer-session-disposition/index.ts, coaching-core.ts or dialer-engine.ts at
-- all, per the lead's explicit lane note.

-- =================================================================================================
-- 1. org_quality_check_settings: the org-wide master switch, OFF by default. Mirrors
--    org_spend_settings' own shape exactly (singleton per org, owner/admin insert/update, seeded
--    on org create, generic settings-change audit trigger) -- same established pattern, not a
--    fourth reinvention of it.
-- =================================================================================================

create table public.org_quality_check_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.org_quality_check_settings enable row level security;

create policy "org members can view quality check settings"
  on public.org_quality_check_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert quality check settings"
  on public.org_quality_check_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update quality check settings"
  on public.org_quality_check_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.org_quality_check_settings from anon;

create function private.seed_default_quality_check_settings(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.org_quality_check_settings (org_id) values (p_org)
  on conflict (org_id) do nothing;
$$;

create function private.seed_default_quality_check_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_quality_check_settings(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_quality_check_settings
  after insert on public.orgs
  for each row execute function private.seed_default_quality_check_settings_trigger();

do $$
declare r record;
begin
  for r in select id from public.orgs loop
    perform private.seed_default_quality_check_settings(r.id);
  end loop;
end $$;

create trigger org_quality_check_settings_audit
  after insert or update on public.org_quality_check_settings
  for each row execute function private.audit_log_settings_change_trigger(
    'settings.quality_checks.update', 'org_quality_check_settings'
  );

-- =================================================================================================
-- 2. disposition_quality_rules: per-org, per-disposition, per-rule-type config. RPC-only writer
--    (set_disposition_quality_rule below) -- same "no client insert/update/delete, a SECURITY
--    DEFINER function is the only writer" shape as call_scorecards, so config validation lives in
--    one place instead of a CHECK constraint per rule_type's own jsonb shape.
-- =================================================================================================

create table public.disposition_quality_rules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  disposition_id uuid not null references public.dispositions(id) on delete cascade,
  rule_type text not null check (rule_type in ('min_talk_seconds', 'required_field', 'rate_outlier')),
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, disposition_id, rule_type)
);

create index idx_disposition_quality_rules_org on public.disposition_quality_rules(org_id);
create index idx_disposition_quality_rules_disposition on public.disposition_quality_rules(disposition_id);

alter table public.disposition_quality_rules enable row level security;

create policy "org members can view quality rules"
  on public.disposition_quality_rules for select
  using (private.is_org_member(org_id));

-- No insert/update/delete policy for any client role -- set_disposition_quality_rule is the only
-- writer (validates config shape per rule_type, which a CHECK constraint can't do cleanly).

revoke all on public.disposition_quality_rules from anon;

create function public.set_disposition_quality_rule(
  p_org uuid,
  p_disposition_id uuid,
  p_rule_type text,
  p_enabled boolean,
  p_config jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rule_id uuid;
  v_field text;
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    raise exception 'only an owner or admin can configure quality rules';
  end if;

  if not exists (
    select 1 from public.dispositions where id = p_disposition_id and org_id = p_org
  ) then
    raise exception 'disposition not found for this org';
  end if;

  if p_rule_type not in ('min_talk_seconds', 'required_field', 'rate_outlier') then
    raise exception 'unknown rule_type: %', p_rule_type;
  end if;

  -- Validate each rule type's own config shape here (not a CHECK constraint -- a jsonb structural
  -- check per rule_type reads far more clearly in plpgsql than a matching CHECK expression, and
  -- this is the ONLY writer of this table anyway).
  if p_rule_type = 'min_talk_seconds' then
    if p_config is null or not (p_config ? 'min_seconds')
       or (p_config ->> 'min_seconds')::int is null
       or (p_config ->> 'min_seconds')::int < 1
       or (p_config ->> 'min_seconds')::int > 36000 then
      raise exception 'min_talk_seconds rule requires config.min_seconds between 1 and 36000';
    end if;
  elsif p_rule_type = 'required_field' then
    -- Three separate IF checks, not one OR chain: once 'fields' is confirmed present, its value
    -- could still be the wrong JSON type (e.g. a string), and jsonb_array_length ERRORS on a
    -- non-array rather than returning null -- an OR chain doesn't guarantee left-to-right
    -- short-circuit evaluation, so calling it before confirming the type is a real trap, not
    -- just a style choice.
    if p_config is null or not (p_config ? 'fields') then
      raise exception 'required_field rule requires a non-empty config.fields array';
    end if;
    if jsonb_typeof(p_config -> 'fields') <> 'array' then
      raise exception 'required_field rule requires a non-empty config.fields array';
    end if;
    if jsonb_array_length(p_config -> 'fields') = 0 then
      raise exception 'required_field rule requires a non-empty config.fields array';
    end if;
    for v_field in select jsonb_array_elements_text(p_config -> 'fields')
    loop
      if v_field not in ('notes', 'callback_at') then
        raise exception 'required_field config.fields may only contain notes or callback_at, got %', v_field;
      end if;
    end loop;
  elsif p_rule_type = 'rate_outlier' then
    if p_config is null or not (p_config ? 'multiplier')
       or (p_config ->> 'multiplier')::numeric is null
       or (p_config ->> 'multiplier')::numeric <= 1
       or (p_config ->> 'multiplier')::numeric > 100 then
      raise exception 'rate_outlier rule requires config.multiplier > 1 and <= 100';
    end if;
    if p_config ? 'min_sample'
       and ((p_config ->> 'min_sample')::int is null or (p_config ->> 'min_sample')::int < 1) then
      raise exception 'rate_outlier config.min_sample must be a positive integer when set';
    end if;
  end if;

  insert into public.disposition_quality_rules (org_id, disposition_id, rule_type, enabled, config)
  values (p_org, p_disposition_id, p_rule_type, p_enabled, p_config)
  on conflict (org_id, disposition_id, rule_type)
  do update set enabled = excluded.enabled, config = excluded.config, updated_at = now()
  returning id into v_rule_id;

  perform private.log_org_action(
    p_org, 'quality_rule.set', 'disposition_quality_rule', v_rule_id,
    jsonb_build_object(
      'disposition_id', p_disposition_id, 'rule_type', p_rule_type,
      'enabled', p_enabled, 'config', p_config
    )
  );

  return v_rule_id;
end;
$$;

revoke all on function public.set_disposition_quality_rule(uuid, uuid, text, boolean, jsonb) from public, anon;
grant execute on function public.set_disposition_quality_rule(uuid, uuid, text, boolean, jsonb) to authenticated;

-- =================================================================================================
-- 3. disposition_quality_flags: one row per (call_leg, rule_type) that is CURRENTLY failing --
--    trigger-only writer (evaluate_disposition_quality_rules below), upserted so a re-disposition
--    re-evaluates with no duplicate flags (task spec, verbatim), and DELETEd when a re-evaluation
--    no longer fails (the automated alert is moot once the underlying call_legs row no longer
--    matches; a supervisor's own review decision is independently preserved in org_audit_log via
--    set_quality_flag_status's own log_org_action call, so deleting the flag row does not erase
--    that history). Visibility reuses can_view_call_leg (TASK-M5-B5) verbatim -- the exact
--    "manager sees only flags in their pod scope" edge case the task spec calls out, for free.
--
--    disposition_id/disposition_key are a SNAPSHOT (on delete set null / not re-derived), not a
--    live join -- the task's own edge case "a disposition renamed/deleted after flags exist"
--    means the flag must still display sensibly after that happens, not disappear or point at
--    nothing.
-- =================================================================================================

create table public.disposition_quality_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  call_leg_id uuid not null references public.call_legs(id) on delete cascade,
  rule_id uuid references public.disposition_quality_rules(id) on delete set null,
  rule_type text not null check (rule_type in ('min_talk_seconds', 'required_field')),
  disposition_id uuid references public.dispositions(id) on delete set null,
  disposition_key text not null,
  -- The session's own agent (dial_sessions.agent_id) -- whose cockpit/Team-page row this counts
  -- against and whose pod scope gates manager visibility. Distinct from dispositioned_by: a
  -- taken-over leg (eng2's N1) is dispositioned by the supervisor, but the flag still belongs to
  -- the agent whose call it was, per the task's own attribution requirement.
  agent_id uuid not null references auth.users(id) on delete cascade,
  dispositioned_by uuid references auth.users(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'reviewed_ok', 'coached')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (call_leg_id, rule_type)
);

create index idx_disposition_quality_flags_org on public.disposition_quality_flags(org_id);
create index idx_disposition_quality_flags_agent on public.disposition_quality_flags(org_id, agent_id, status);
create index idx_disposition_quality_flags_leg on public.disposition_quality_flags(call_leg_id);

alter table public.disposition_quality_flags enable row level security;

create policy "anyone who can view the call leg can view its quality flags"
  on public.disposition_quality_flags for select
  using (private.can_view_call_leg(call_leg_id));

-- No client insert/update/delete -- the trigger (writer) and set_quality_flag_status (status-only
-- writer) are SECURITY DEFINER and bypass RLS entirely.

revoke all on public.disposition_quality_flags from anon;

-- =================================================================================================
-- 4. evaluate_disposition_quality_rules: the trigger function. Fires only when a real disposition
--    just landed (new.dispositioned_at is not null, guarded again below for belt-and-suspenders)
--    and only for a 'contact' leg -- an 'agent' leg never carries a disposition in practice, but
--    submit_disposition's own p_leg has no kind filter, so this is defensive, not load-bearing.
--    O(1) per disposition (task's own volume edge case): one settings lookup, one disposition
--    lookup, one small loop over at most 2 enabled rule rows (rate_outlier is never in this loop
--    at all -- it has no per-call representation, see the header).
-- =================================================================================================

create function private.evaluate_disposition_quality_rules()
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
    -- Checks are off org-wide: the loop below never runs again for this leg, so any flags
    -- left over from a run while checks WERE on would otherwise sit stale forever. Clear them
    -- so a later re-disposition (checks back on) re-evaluates clean rather than inheriting an
    -- old snapshot.
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

  -- A flag whose rule_type is no longer configured (enabled) on the CURRENT disposition is
  -- stale -- the loop below only ever touches rule_types configured here, so a re-disposition
  -- to a target with a different (or empty) rule set would otherwise leave the old flag
  -- attached forever to a call whose current disposition no longer describes it. Scoped to
  -- "not currently configured" (rather than an unconditional delete-all) so a rule_type that
  -- IS still configured -- same disposition re-evaluated, or a different disposition that
  -- happens to share that rule_type -- is left alone here and refreshed in place by the loop's
  -- own `on conflict` upsert below, which is what actually preserves a supervisor's prior
  -- status/reviewed_by/reviewed_at across a routine re-evaluation.
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
      -- Talk time is the leg's own bridged duration -- already the answered/claimed/bridged
      -- fallback chain dialer-engine.ts computes at hangup (LEG_COLUMNS' own comment), not
      -- re-derived here from timestamps. A leg that never bridged at all (voicemail drop, no
      -- answer) has duration_seconds null/0 -- deliberately NOT skipped: a "Conversation"
      -- disposition on a call that never bridged is exactly the gap this rule exists to catch.
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
        -- Re-dispositioning re-evaluates: refresh the snapshot/detail, but leave a supervisor's
        -- own status/reviewed_by/reviewed_at untouched -- a prior human review decision about
        -- this call+rule should not silently reset to "open" on an incidental retry/resubmit.
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
  -- "A failed rule never blocks or changes the disposition" (task spec) must hold even when a
  -- rule's own config is malformed -- this trigger fires inside submit_disposition's own
  -- transaction, so an unhandled error here would roll back the disposition write itself (plus
  -- DNC propagation, the GHL job enqueue, the session wrap_up->dialing transition). A plpgsql
  -- EXCEPTION block gets its own implicit savepoint, so this only rolls back this function's own
  -- writes (an earlier loop iteration's flag insert/delete on THIS call) -- never the outer
  -- UPDATE on call_legs. A lost flag on a genuinely broken rule config self-heals on the next
  -- real re-disposition once the config is fixed.
  raise warning 'evaluate_disposition_quality_rules failed for leg %: %', new.id, sqlerrm;
  return new;
end;
$$;

create trigger call_legs_evaluate_quality_rules
  after update of disposition_id, notes, callback_at, dispositioned_by, dispositioned_at
  on public.call_legs
  for each row execute function private.evaluate_disposition_quality_rules();

-- =================================================================================================
-- 5. set_quality_flag_status: a supervisor marks a flag reviewed/coached (or reopens it). Same
--    manager-pod-scope-on-write shape as set_call_scorecard -- easier in plpgsql than a single RLS
--    WITH CHECK, and this is the one write path that needs an audit-log row (RULES-CARD: "every
--    team-management write ... coaching start ... must call the audit-log helper").
-- =================================================================================================

create function public.set_quality_flag_status(
  p_org uuid,
  p_flag_id uuid,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_flag public.disposition_quality_flags;
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    raise exception 'only an owner, admin, or manager can review a quality flag';
  end if;

  if p_status not in ('open', 'reviewed_ok', 'coached') then
    raise exception 'unknown status: %', p_status;
  end if;

  select * into v_flag
  from public.disposition_quality_flags
  where id = p_flag_id and org_id = p_org;
  if v_flag is null then
    raise exception 'quality flag not found for this org';
  end if;

  if not private.is_agent_in_callers_pod_scope(p_org, v_flag.agent_id) then
    raise exception 'that agent is outside your managed pods';
  end if;

  update public.disposition_quality_flags
  set
    status = p_status,
    reviewed_by = case when p_status = 'open' then null else auth.uid() end,
    reviewed_at = case when p_status = 'open' then null else now() end
  where id = p_flag_id;

  perform private.log_org_action(
    p_org, 'quality_flag.review', 'disposition_quality_flag', p_flag_id,
    jsonb_build_object('status', p_status, 'agent_id', v_flag.agent_id)
  );
end;
$$;

revoke all on function public.set_quality_flag_status(uuid, uuid, text) from public, anon;
grant execute on function public.set_quality_flag_status(uuid, uuid, text) to authenticated;

-- =================================================================================================
-- 6. list_disposition_quality_flags: the review queue's own one-RPC-per-load list/filter query.
--    Visibility copied from recordings_search verbatim (owner/admin all; manager pod-scoped;
--    agent sees only their own) -- the same composition can_view_call_leg encodes, inlined here
--    for the same "already joining dial_sessions anyway" reason recordings_search gives.
-- =================================================================================================

create function public.list_disposition_quality_flags(
  p_org uuid,
  p_agent_id uuid default null,
  p_status text default null,
  p_call_leg_id uuid default null,
  p_limit int default 50,
  p_offset int default 0
)
returns table (
  id uuid,
  call_leg_id uuid,
  agent_id uuid,
  agent_name text,
  campaign_id uuid,
  campaign_name text,
  rule_type text,
  disposition_key text,
  detail jsonb,
  status text,
  dispositioned_by uuid,
  dispositioned_by_name text,
  reviewed_by uuid,
  reviewed_by_name text,
  reviewed_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz
)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_caller uuid := auth.uid();
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager', 'agent']) then
    return;
  end if;

  if p_agent_id is not null
     and not private.is_agent_in_callers_pod_scope(p_org, p_agent_id)
     and p_agent_id <> v_caller then
    raise exception 'that agent is outside your managed pods';
  end if;

  if p_status is not null and p_status not in ('open', 'reviewed_ok', 'coached') then
    raise exception 'unknown status: %', p_status;
  end if;

  return query
  select
    f.id,
    f.call_leg_id,
    f.agent_id,
    coalesce(nullif(trim(concat(pr.first_name, ' ', pr.last_name)), ''), 'Unknown'),
    cl.campaign_id,
    c.name,
    f.rule_type,
    f.disposition_key,
    f.detail,
    f.status,
    f.dispositioned_by,
    nullif(trim(concat(dpr.first_name, ' ', dpr.last_name)), ''),
    f.reviewed_by,
    nullif(trim(concat(rpr.first_name, ' ', rpr.last_name)), ''),
    f.reviewed_at,
    cl.ended_at,
    f.created_at
  from public.disposition_quality_flags f
  join public.call_legs cl on cl.id = f.call_leg_id
  left join public.campaigns c on c.id = cl.campaign_id
  left join public.profiles pr on pr.user_id = f.agent_id
  left join public.profiles dpr on dpr.user_id = f.dispositioned_by
  left join public.profiles rpr on rpr.user_id = f.reviewed_by
  where f.org_id = p_org
    and (private.is_agent_in_callers_pod_scope(p_org, f.agent_id) or f.agent_id = v_caller)
    and (p_agent_id is null or f.agent_id = p_agent_id)
    and (p_status is null or f.status = p_status)
    and (p_call_leg_id is null or f.call_leg_id = p_call_leg_id)
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke all on function public.list_disposition_quality_flags(uuid, uuid, text, uuid, int, int) from public, anon;
grant execute on function public.list_disposition_quality_flags(uuid, uuid, text, uuid, int, int) to authenticated;

-- =================================================================================================
-- 7. get_quality_flag_open_counts: one row per agent with at least one OPEN flag -- the cockpit/
--    Team-page badge count. Same pod-scope visibility as above.
-- =================================================================================================

create function public.get_quality_flag_open_counts(p_org uuid)
returns table (agent_id uuid, open_count bigint)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_caller uuid := auth.uid();
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager', 'agent']) then
    return;
  end if;

  return query
  select f.agent_id, count(*)
  from public.disposition_quality_flags f
  where f.org_id = p_org
    and f.status = 'open'
    and (private.is_agent_in_callers_pod_scope(p_org, f.agent_id) or f.agent_id = v_caller)
  group by f.agent_id;
end;
$$;

revoke all on function public.get_quality_flag_open_counts(uuid) from public, anon;
grant execute on function public.get_quality_flag_open_counts(uuid) to authenticated;

-- =================================================================================================
-- 8. get_disposition_rate_outliers: rule (c), evaluated ON READ (task spec, verbatim) -- never
--    stored as a flag row (see the header). p_date defaults to "today" in the caller's own
--    request, i.e. UTC today via current_date -- good enough for a same-day coaching signal, no
--    org-timezone plumbing exists anywhere else in this schema either.
--    Volume floor (config.min_sample, default 5): an agent with only 1-2 dispositions today
--    whose single "Interested" happens to be 100% of their calls is noise, not a signal -- same
--    reasoning as any rate-based alert needing a minimum sample.
-- =================================================================================================

create function public.get_disposition_rate_outliers(p_org uuid, p_date date default current_date)
returns table (
  disposition_id uuid,
  disposition_key text,
  disposition_label text,
  agent_id uuid,
  agent_name text,
  agent_count bigint,
  agent_total bigint,
  agent_share numeric,
  team_share numeric,
  threshold_multiplier numeric
)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_caller uuid := auth.uid();
  v_checks_enabled boolean;
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    return;
  end if;

  select enabled into v_checks_enabled
  from public.org_quality_check_settings where org_id = p_org;
  if not coalesce(v_checks_enabled, false) then
    return;
  end if;

  return query
  with today_legs as (
    select cl.disposition_id, private.dial_session_agent_id(cl.session_id) as agent_id
    from public.call_legs cl
    where cl.org_id = p_org
      and cl.kind = 'contact'
      and cl.disposition_id is not null
      and cl.dispositioned_at >= p_date::timestamptz
      and cl.dispositioned_at < (p_date + 1)::timestamptz
  ),
  agent_totals as (
    -- Alias "att", not "at" -- `at` is a SQL keyword (AT TIME ZONE) and best avoided as an
    -- identifier even where the grammar happens to allow it.
    select agent_id, count(*) as total from today_legs group by agent_id
  ),
  agent_disposition_counts as (
    select disposition_id, agent_id, count(*) as cnt from today_legs group by disposition_id, agent_id
  ),
  team_disposition_totals as (
    select disposition_id, count(*) as cnt from today_legs group by disposition_id
  ),
  team_total as (
    select count(*) as cnt from today_legs
  )
  select
    d.id,
    d.key,
    d.label,
    adc.agent_id,
    coalesce(nullif(trim(concat(pr.first_name, ' ', pr.last_name)), ''), 'Unknown'),
    adc.cnt,
    att.total,
    round(adc.cnt::numeric / att.total, 4),
    round(tdt.cnt::numeric / nullif(tt.cnt, 0), 4),
    (r.config ->> 'multiplier')::numeric
  from public.disposition_quality_rules r
  join public.dispositions d on d.id = r.disposition_id
  join agent_disposition_counts adc on adc.disposition_id = r.disposition_id
  join agent_totals att on att.agent_id = adc.agent_id
  join team_disposition_totals tdt on tdt.disposition_id = r.disposition_id
  cross join team_total tt
  left join public.profiles pr on pr.user_id = adc.agent_id
  where r.org_id = p_org
    and r.rule_type = 'rate_outlier'
    and r.enabled
    and att.total >= coalesce((r.config ->> 'min_sample')::int, 5)
    and tt.cnt > 0
    and (adc.cnt::numeric / att.total) > (tdt.cnt::numeric / nullif(tt.cnt, 0)) * (r.config ->> 'multiplier')::numeric
    and (private.is_agent_in_callers_pod_scope(p_org, adc.agent_id) or adc.agent_id = v_caller);
end;
$$;

revoke all on function public.get_disposition_rate_outliers(uuid, date) from public, anon;
grant execute on function public.get_disposition_rate_outliers(uuid, date) to authenticated;

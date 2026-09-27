-- MISSION-5 TASK-M5-B3: distribution guards -- callback fallback, bulk reassign "from agent X",
-- per-agent daily dial cap. All three ship OFF by default (org settings), per CLAUDE.md's own
-- "server-side guards default off" rule.

-- =================================================================================================
-- 1. org_distribution_settings: org-wide toggles + defaults. Same singleton "org_<feature>_
--    settings" shape as org_number_pool_settings/org_spend_settings -- select: any member (an
--    agent needs to know a cap might be in effect); insert/update: owner/admin. Reuses TASK-A1's
--    generic settings-change audit trigger (private.audit_log_settings_change_trigger) verbatim
--    -- no new logging code needed for "audit-log ... cap changes" on the ORG-DEFAULT half.
-- =================================================================================================

create table public.org_distribution_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  callback_fallback_enabled boolean not null default false,
  callback_fallback_minutes int not null default 30 check (callback_fallback_minutes > 0),
  daily_dial_cap_enabled boolean not null default false,
  daily_dial_cap_default int not null default 300 check (daily_dial_cap_default > 0),
  updated_at timestamptz not null default now()
);

alter table public.org_distribution_settings enable row level security;

create policy "org members can view distribution settings"
  on public.org_distribution_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert distribution settings"
  on public.org_distribution_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update distribution settings"
  on public.org_distribution_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create function private.seed_default_distribution_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.org_distribution_settings (org_id)
  values (new.id)
  on conflict (org_id) do nothing;
  return new;
end;
$$;

create trigger orgs_seed_default_distribution_settings
  after insert on public.orgs
  for each row execute function private.seed_default_distribution_settings_trigger();

insert into public.org_distribution_settings (org_id)
select id from public.orgs
on conflict (org_id) do nothing;

create trigger org_distribution_settings_audit
  after insert or update on public.org_distribution_settings
  for each row execute function private.audit_log_settings_change_trigger('settings.distribution.update', 'org_distribution_settings');

-- =================================================================================================
-- 2. org_agent_dial_caps: per-agent override (absence = use org_distribution_settings' own
--    daily_dial_cap_default). Same select-any-member/write-owner-admin RLS shape; the audit
--    trigger only covers insert/update (a DELETE that clears an override is NOT logged -- a known,
--    accepted gap, see decisions.md, not worth a second trigger for a rare "remove override"
--    action).
-- =================================================================================================

create table public.org_agent_dial_caps (
  org_id uuid not null references public.orgs(id) on delete cascade,
  agent_id uuid not null references auth.users(id) on delete cascade,
  daily_cap int not null check (daily_cap > 0),
  updated_at timestamptz not null default now(),
  primary key (org_id, agent_id)
);

alter table public.org_agent_dial_caps enable row level security;

create policy "org members can view agent dial caps"
  on public.org_agent_dial_caps for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert agent dial caps"
  on public.org_agent_dial_caps for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update agent dial caps"
  on public.org_agent_dial_caps for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can delete agent dial caps"
  on public.org_agent_dial_caps for delete
  using (private.has_org_role(org_id, array['owner', 'admin']));

create trigger org_agent_dial_caps_audit
  after insert or update on public.org_agent_dial_caps
  for each row execute function private.audit_log_settings_change_trigger('settings.agent_dial_cap.update', 'org_agent_dial_caps');

-- =================================================================================================
-- 3. agent_daily_dial_status: "where batches fire" reads this BEFORE claim_next_leads (mirrors
--    has_available_dial_number's own "pause before claiming, never fail mid-claim" shape).
--    service_role only -- called from refillSession (_shared/dialer-engine.ts), never a signed-in
--    client directly. `p_tz` defaults to 'America/Chicago', same placeholder-until-A4 convention
--    as TASK-M5-B1's agent_time_in_state.
-- =================================================================================================

create function public.agent_daily_dial_status(
  p_org uuid,
  p_agent uuid,
  p_tz text default 'America/Chicago'
)
returns table (
  cap_enabled boolean,
  effective_cap int,
  dialed_today int
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_enabled boolean;
  v_default_cap int;
  v_override_cap int;
  v_day_start timestamptz;
  v_day_end timestamptz;
  v_count int;
begin
  select ods.daily_dial_cap_enabled, ods.daily_dial_cap_default
    into v_enabled, v_default_cap
  from public.org_distribution_settings ods
  where ods.org_id = p_org;

  if v_enabled is null or not v_enabled then
    return query select coalesce(v_enabled, false), null::int, null::int;
    return;
  end if;

  select oadc.daily_cap into v_override_cap
  from public.org_agent_dial_caps oadc
  where oadc.org_id = p_org and oadc.agent_id = p_agent;

  v_day_start := date_trunc('day', now() at time zone p_tz) at time zone p_tz;
  v_day_end := v_day_start + interval '1 day';

  select count(*) into v_count
  from public.call_legs cl
  join public.dial_sessions ds on ds.id = cl.session_id
  where ds.agent_id = p_agent
    and ds.org_id = p_org
    and cl.kind = 'contact'
    and cl.created_at >= v_day_start
    and cl.created_at < v_day_end;

  return query select true, coalesce(v_override_cap, v_default_cap), v_count;
end;
$$;

revoke all on function public.agent_daily_dial_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.agent_daily_dial_status(uuid, uuid, text) to service_role;

-- =================================================================================================
-- 4. claim_next_leads: callback fallback. A 'callback' row not owned by the requesting agent
--    becomes claimable when callback_fallback_enabled AND it's been due for at least
--    callback_fallback_minutes AND (the owning agent is disabled/removed OR currently holds no
--    non-terminal dial_sessions row at all). The claiming agent becomes the new owner
--    (`assigned_agent_id`) -- "record who took it" -- logged once per call, batched, listing
--    every fallback-claimed lead's previous owner.
--
--    Byte-identical to 20260926070003's own version except: (a) v_org_id/v_agent_id already
--    selected above are reused for the fallback lookup (no new query needed for those), (b) the
--    `ranked`/`candidates` CTEs gain the fallback branch + carry `assigned_agent_id` +
--    `is_fallback_claim` through, (c) one `perform private.log_org_action` call at the end when
--    any fallback claim happened this call.
-- =================================================================================================

create or replace function public.claim_next_leads(p_session uuid)
returns setof public.claimed_dial_leg
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_campaign_id uuid;
  v_agent_id uuid;
  v_lines int;
  v_window_start time;
  v_window_end time;
  v_capacity int;
  v_fallback_enabled boolean;
  v_fallback_minutes int;
  v_fallback_cutoff timestamptz;
  v_fallback_count int := 0;
  v_row record;
begin
  select ds.org_id, ds.campaign_id, ds.agent_id, ds.lines
    into v_org_id, v_campaign_id, v_agent_id, v_lines
  from public.dial_sessions ds
  where ds.id = p_session and ds.state = 'dialing'
  for update;

  if v_campaign_id is null then
    return;
  end if;

  select count(*) into v_capacity
  from public.call_legs
  where session_id = p_session and kind = 'contact'
    and state not in ('ended', 'voicemail_dropping');

  v_capacity := greatest(0, v_lines - v_capacity);
  if v_capacity = 0 then
    return;
  end if;

  select c.calling_window_start, c.calling_window_end into v_window_start, v_window_end
  from public.campaigns c
  where c.id = v_campaign_id;

  select coalesce(ods.callback_fallback_enabled, false), ods.callback_fallback_minutes
    into v_fallback_enabled, v_fallback_minutes
  from public.org_distribution_settings ods
  where ods.org_id = v_org_id;
  v_fallback_cutoff := now() - make_interval(mins => coalesce(v_fallback_minutes, 30));

  -- Not `return query <select>` here (the original shape) -- callback fallback needs to count
  -- how many of THIS call's own claims were fallback claims, to log once at the end, and a CTE
  -- (`picked`) is only visible inside the single statement it's part of. `for ... in (<the same
  -- select>) loop return next ...; end loop;` gets the exact same output (order and all) while
  -- letting this function inspect each row (`v_row.is_fallback_claim`) as it goes, then log
  -- after the loop -- no second query, no re-running the update.
  for v_row in
  with picked as (
    select
      cl2.id,
      cl2.assigned_agent_id,
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) as is_priority_callback,
      (
        cl2.status = 'callback'
        and cl2.assigned_agent_id is distinct from v_agent_id
        and v_fallback_enabled
        and cl2.next_attempt_at <= v_fallback_cutoff
        and (
          not exists (
            select 1 from public.org_members om
            where om.org_id = v_org_id and om.user_id = cl2.assigned_agent_id and om.status = 'active'
          )
          or not exists (
            select 1 from public.dial_sessions ds3
            where ds3.agent_id = cl2.assigned_agent_id and ds3.state not in ('stopped', 'completed')
          )
        )
      ) as is_fallback_claim,
      cl2.priority_requeue,
      case cl2.priority when 'high' then 2 when 'normal' then 1 else 0 end as priority_rank,
      cl2.attempts,
      cl2.next_attempt_at,
      cl2.position,
      cl2.contact_id
    from public.campaign_leads cl2
    join public.contacts ct on ct.id = cl2.contact_id
    where cl2.campaign_id = v_campaign_id
      and cl2.next_attempt_at <= now()
      and not ct.dnc
      and not exists (
        select 1 from public.dnc_numbers dn
        where dn.org_id = v_org_id and dn.e164 = ct.phone_number
      )
      and (
        (cl2.status = 'queued' and (cl2.assigned_agent_id is null or cl2.assigned_agent_id = v_agent_id))
        or (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id)
        or (
          cl2.status = 'callback'
          and cl2.assigned_agent_id is distinct from v_agent_id
          and v_fallback_enabled
          and cl2.next_attempt_at <= v_fallback_cutoff
          and (
            not exists (
              select 1 from public.org_members om
              where om.org_id = v_org_id and om.user_id = cl2.assigned_agent_id and om.status = 'active'
            )
            or not exists (
              select 1 from public.dial_sessions ds3
              where ds3.agent_id = cl2.assigned_agent_id and ds3.state not in ('stopped', 'completed')
            )
          )
        )
      )
      and private.is_lead_callable_now(ct.timezone, v_window_start, v_window_end)
    order by
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) desc,
      cl2.priority_requeue desc,
      (case cl2.priority when 'high' then 2 when 'normal' then 1 else 0 end) desc,
      cl2.attempts asc,
      cl2.next_attempt_at asc,
      cl2.position asc
    limit v_capacity
    for update of cl2 skip locked
  ),
  updated as (
    update public.campaign_leads cl
    set
      status = 'in_flight',
      updated_at = now(),
      priority_requeue = false,
      assigned_agent_id = case when picked.is_fallback_claim then v_agent_id else cl.assigned_agent_id end
    from picked
    where cl.id = picked.id
    returning cl.id, cl.contact_id, picked.is_fallback_claim, picked.assigned_agent_id as previous_agent_id
  ),
  new_legs as (
    insert into public.call_legs (org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state, time_block)
    select
      v_org_id, p_session, v_campaign_id, u.contact_id, u.id, 'contact', 'pending-' || gen_random_uuid()::text, 'initiated',
      private.time_block_for(now(), (select ct3.timezone from public.contacts ct3 where ct3.id = u.contact_id))
    from updated u
    returning id, lead_id, contact_id, call_control_id
  )
  select
    nl.id as leg_id,
    nl.lead_id,
    nl.contact_id,
    (select ct2.phone_number from public.contacts ct2 where ct2.id = nl.contact_id) as phone_number,
    nl.call_control_id,
    p.is_fallback_claim,
    p.is_priority_callback, p.priority_requeue, p.priority_rank, p.attempts, p.next_attempt_at, p.position
  from new_legs nl
  join picked p on p.id = nl.lead_id
  order by
    p.is_priority_callback desc, p.priority_requeue desc, p.priority_rank desc,
    p.attempts asc, p.next_attempt_at asc, p.position asc
  loop
    if v_row.is_fallback_claim then
      v_fallback_count := v_fallback_count + 1;
    end if;
    return next row(v_row.leg_id, v_row.lead_id, v_row.contact_id, v_row.phone_number, v_row.call_control_id)::public.claimed_dial_leg;
  end loop;

  if v_fallback_count > 0 then
    perform private.log_org_action(
      v_org_id,
      'campaign_leads.callback_fallback_claim',
      'campaign',
      v_campaign_id,
      jsonb_build_object('agent_id', v_agent_id, 'lead_count', v_fallback_count),
      v_agent_id
    );
  end if;
end;
$$;

revoke all on function public.claim_next_leads(uuid) from public, anon, authenticated;
grant execute on function public.claim_next_leads(uuid) to service_role;

-- =================================================================================================
-- 5. assign_campaign_leads: a new 'by_current_agent' filter mode (reassign everything currently
--    on one agent to another agent, or to the pool with p_agent_id = null -- that half of the
--    signature already existed, unchanged), widened to include 'callback' rows (not just
--    'queued') for THIS mode only -- every other mode's own candidate pool is untouched.
--
--    EC-5 fix (applies to every mode, not just the new one): the actual UPDATE now re-checks
--    `cl.status = any(...)` directly against the CURRENT row, not just the `candidates` CTE's
--    own snapshot -- Postgres re-evaluates an UPDATE...FROM's join condition against the latest
--    committed row version once it acquires the row's lock, so a row a concurrent
--    claim_next_leads call has ALREADY flipped to 'in_flight' by the time this UPDATE reaches it
--    is now correctly excluded, instead of being silently reassigned out from under a live dial.
--    This was a real, pre-existing gap (this migration is the first time anything proves it with
--    a dry-run) -- see audit/M5-B3/dryrun-tests.sql's own EC-5 section.
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
begin
  select org_id into v_org_id from public.campaigns where id = p_campaign_id;
  if v_org_id is null then
    raise exception 'campaign not found';
  end if;

  if not private.has_org_role(v_org_id, array['owner', 'admin']) then
    raise exception 'only an owner or admin can assign leads';
  end if;

  if p_agent_id is not null and not exists (
    select 1 from public.org_members
    where org_id = v_org_id and user_id = p_agent_id and status = 'active'
  ) then
    raise exception 'target agent is not an active member of this org';
  end if;

  if p_agent_id is not null then
    insert into public.campaign_agents (campaign_id, user_id, org_id)
    values (p_campaign_id, p_agent_id, v_org_id)
    on conflict (campaign_id, user_id) do nothing;
  end if;

  v_mode := coalesce(p_filter ->> 'mode', 'all');
  if v_mode not in ('all', 'range', 'percentage', 'tag', 'by_current_agent') then
    raise exception 'p_filter.mode must be one of: all, range, percentage, tag, by_current_agent';
  end if;

  if v_mode = 'by_current_agent' then
    v_from_agent_id := (p_filter ->> 'from_agent_id')::uuid;
    if v_from_agent_id is null then
      raise exception 'p_filter.from_agent_id is required for mode=by_current_agent';
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
    where
      v_mode = 'all'
      or (v_mode = 'range'
        and r.rn between (p_filter ->> 'start')::int and (p_filter ->> 'end')::int)
      or (v_mode = 'percentage'
        and r.rn <= ceil(r.total * (p_filter ->> 'percentage')::numeric / 100))
      or (v_mode = 'tag' and r.ghl_tags && array[p_filter ->> 'tag'])
      or (v_mode = 'by_current_agent' and r.assigned_agent_id = v_from_agent_id)
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

-- TASK-N1 (MISSION-3): caller-ID number pool, daily caps, rest days, manager number assignment
-- (CID-1, CID-2, ADM-5, CID-5). Append-only -- evolves the existing `user_phone_numbers` (today:
-- one buyer-owned number per campaign via `campaigns.caller_id_number_id`) into an org-owned pool
-- interns rotate through, with a per-number daily dial cap and a rest period once a number hits
-- it. See decisions.md for the "day" boundary and legacy-fallback-tier tradeoffs.

-- =================================================================================================
-- 1. user_phone_numbers: evolve buyer-owned rows into pool-assignable ones.
--    `user_id` (the buyer, NOT NULL) is untouched -- `assigned_user_id` is a SEPARATE, nullable
--    column: who currently dials from this number day-to-day (null = the team pool). A number's
--    buyer and its current assignee are different facts and can differ over time.
-- =================================================================================================

alter table public.user_phone_numbers
  add column assigned_user_id uuid references auth.users(id) on delete set null,
  add column status text not null default 'active' check (status in ('active', 'resting', 'retired')),
  add column resting_until timestamptz,
  add column daily_cap int not null default 100 check (daily_cap > 0);

create index idx_user_phone_numbers_org_status on public.user_phone_numbers(org_id, status);
create index idx_user_phone_numbers_assigned on public.user_phone_numbers(assigned_user_id);

-- assigned_user_id must be a member of the number's own org -- same class of cross-org-reference
-- bug the campaigns.caller_id_number_id trigger below already guards against (a crafted or stale
-- id from a different org must never be assignable).

create function private.check_phone_number_assignee_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.assigned_user_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.org_members m
    where m.org_id = new.org_id and m.user_id = new.assigned_user_id
  ) then
    raise exception 'user_phone_numbers.assigned_user_id must be a member of the number''s own org';
  end if;
  return new;
end;
$$;

create trigger user_phone_numbers_check_assignee_org
  before insert or update on public.user_phone_numbers
  for each row execute function private.check_phone_number_assignee_org();

-- =================================================================================================
-- 2. org_number_pool_settings: CID-2's two org-level defaults. Same shape as
--    org_recording_settings (20260925040000) -- member read, owner/admin write, seed-on-org-create
--    + one-time backfill.
-- =================================================================================================

create table public.org_number_pool_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  default_daily_cap int not null default 100 check (default_daily_cap > 0),
  rest_days int not null default 2 check (rest_days >= 0),
  updated_at timestamptz not null default now()
);

alter table public.org_number_pool_settings enable row level security;

create policy "org members can view number pool settings"
  on public.org_number_pool_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert number pool settings"
  on public.org_number_pool_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update number pool settings"
  on public.org_number_pool_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create function private.seed_default_number_pool_settings(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.org_number_pool_settings (org_id, default_daily_cap, rest_days)
  values (p_org, 100, 2)
  on conflict (org_id) do nothing;
$$;

create function private.seed_default_number_pool_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_number_pool_settings(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_number_pool_settings
  after insert on public.orgs
  for each row execute function private.seed_default_number_pool_settings_trigger();

do $$
declare
  v_org record;
begin
  for v_org in select id from public.orgs loop
    perform private.seed_default_number_pool_settings(v_org.id);
  end loop;
end;
$$;

-- =================================================================================================
-- 3. number_daily_usage: the per-number, per-day dial counter (CID-2). `day` is the UTC calendar
--    date -- there is no per-org timezone concept anywhere in this schema (contacts/campaigns use
--    a per-CONTACT IANA timezone string for calling windows, never a per-ORG one), so "day in the
--    org tz" from the task's own design note has no real column to read; UTC calendar day is the
--    simplest defensible choice absent one. Documented in decisions.md, not silently assumed.
--    `org_id` is denormalized (also reachable via number_id -> user_phone_numbers.org_id) purely
--    so its own RLS read policy and index don't need a join, same tradeoff call_legs already
--    makes for `org_id` vs. going through `session_id`.
-- =================================================================================================

create table public.number_daily_usage (
  number_id uuid not null references public.user_phone_numbers(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  day date not null,
  dials int not null default 0 check (dials >= 0),
  primary key (number_id, day)
);

create index idx_number_daily_usage_org_day on public.number_daily_usage(org_id, day);

alter table public.number_daily_usage enable row level security;

-- Read-only for org members (health-stats/table display); writes are service-role only via
-- private.pick_and_reserve_dial_number below -- same "no client write policy at all" shape
-- call_legs itself already uses (dialer-engine.ts is the only writer of dial-derived state).

create policy "org members can view number daily usage"
  on public.number_daily_usage for select
  using (private.is_org_member(org_id));

-- =================================================================================================
-- 4. call_legs.from_number_id: which pool number actually dialed this leg (design's own "so health
--    stats work later"; CID-4 itself is out of scope). Nullable -- the agent leg never sets it
--    (see dialer-engine.ts's own header comment for why the agent leg stays on the legacy
--    campaign.caller_id_number_id path, out of this task's scope), and a leg dialed via the
--    legacy fallback tier (no pool number picked at all) also leaves it null.
-- =================================================================================================

alter table public.call_legs
  add column from_number_id uuid references public.user_phone_numbers(id) on delete set null;

-- =================================================================================================
-- 5. dial_sessions.pause_reason: BUG-... no, CID-2's own "pause with a clear reason" requirement.
--    Free-form text, not CHECK-constrained to a known set (same as the existing
--    paused_agent_lost_from column) -- only trusted engine code ever writes it, through
--    transition_session's own explicit field allowlist below, never directly by a client.
-- =================================================================================================

alter table public.dial_sessions
  add column pause_reason text;

create or replace function public.transition_session(
  p_session uuid,
  p_expected_states text[],
  p_new_state text,
  p_fields jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  update public.dial_sessions
  set
    state = p_new_state,
    updated_at = now(),
    agent_leg_id = case when p_fields ? 'agent_leg_id' then (p_fields ->> 'agent_leg_id')::uuid else agent_leg_id end,
    active_leg_id = case when p_fields ? 'active_leg_id' then (p_fields ->> 'active_leg_id')::uuid else active_leg_id end,
    conference_id = case when p_fields ? 'conference_id' then (p_fields ->> 'conference_id') else conference_id end,
    ended_at = case when p_fields ? 'ended_at' then (p_fields ->> 'ended_at')::timestamptz else ended_at end,
    paused_agent_lost_from = case when p_fields ? 'paused_agent_lost_from' then (p_fields ->> 'paused_agent_lost_from') else paused_agent_lost_from end,
    pause_reason = case when p_fields ? 'pause_reason' then (p_fields ->> 'pause_reason') else pause_reason end
  where id = p_session
    and state = any(p_expected_states)
  returning id into v_id;

  return v_id is not null;
end;
$$;

-- =================================================================================================
-- 6. private.has_available_dial_number / private.pick_and_reserve_dial_number: the atomic
--    selection engine, called once per contact leg about to be dialed (dialer-engine.ts's
--    refillSession). Both run the same lazy resting->active reactivation first (the task's own
--    "a cron or lazy check returns it to active") -- has_available_dial_number so a pre-check
--    right before it never disagrees with what the reserve call would actually find a moment
--    later, pick_and_reserve_dial_number because it needs the reactivated row to be selectable.
--
--    Priority order (design's own list): an assigned-to-this-agent number, else an unassigned
--    pool number, else nothing (the legacy campaign.caller_id_number_id fallback lives in
--    dialer-engine.ts, one tier below this function -- it is not capped or tracked at all, by
--    design; see decisions.md for why that's an accepted tradeoff, not an oversight). Within
--    either tier: prefer an area-code match with the contact, then the fewest dials today.
--
--    Concurrency safety: `for update of upn skip locked` locks the winning candidate row for the
--    rest of this transaction -- a second, concurrent call (a different session, same org) can
--    never select the SAME row while it's locked; skip locked means it instead falls through to
--    the next-best candidate rather than blocking. This is what makes "read today's count, then
--    increment it" safe without a table-level lock, the same pattern claim_next_leads already
--    uses (`for update of cl2 skip locked`) for lead claiming.
-- =================================================================================================

create function private.reactivate_rested_numbers(p_org_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.user_phone_numbers
  set status = 'active', resting_until = null
  where org_id = p_org_id and status = 'resting' and resting_until <= now();
$$;

create function private.has_available_dial_number(p_org_id uuid, p_agent_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.reactivate_rested_numbers(p_org_id);
  select exists (
    select 1
    from public.user_phone_numbers upn
    left join public.number_daily_usage ndu
      on ndu.number_id = upn.id and ndu.day = (now() at time zone 'utc')::date
    where upn.org_id = p_org_id
      and upn.status = 'active'
      and (upn.assigned_user_id is null or upn.assigned_user_id = p_agent_id)
      and coalesce(ndu.dials, 0) < upn.daily_cap
  );
$$;

create function private.pick_and_reserve_dial_number(
  p_org_id uuid,
  p_agent_id uuid,
  p_contact_phone text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest_days int;
  v_area_code text;
  v_today date := (now() at time zone 'utc')::date;
  v_number_id uuid;
  v_cap int;
  v_dials int;
begin
  perform private.reactivate_rested_numbers(p_org_id);

  select rest_days into v_rest_days
  from public.org_number_pool_settings where org_id = p_org_id;
  v_rest_days := coalesce(v_rest_days, 2);

  -- NANP-only area-code match (this build's own area-code-tz module is explicitly scoped the
  -- same way: "foreign NANP member -- out of scope by design"). A non-matching/malformed
  -- contact number just means no area-code preference applies, never an error.
  v_area_code := case
    when p_contact_phone ~ '^\+1[0-9]{10}$' then substring(p_contact_phone from 3 for 3)
    else null
  end;

  select upn.id, upn.daily_cap
    into v_number_id, v_cap
  from public.user_phone_numbers upn
  left join public.number_daily_usage ndu
    on ndu.number_id = upn.id and ndu.day = v_today
  where upn.org_id = p_org_id
    and upn.status = 'active'
    and (upn.assigned_user_id is null or upn.assigned_user_id = p_agent_id)
    and coalesce(ndu.dials, 0) < upn.daily_cap
  order by
    (upn.assigned_user_id = p_agent_id) desc nulls last,
    (v_area_code is not null and substring(upn.phone_number from 3 for 3) = v_area_code) desc,
    coalesce(ndu.dials, 0) asc
  limit 1
  for update of upn skip locked;

  if v_number_id is null then
    return null;
  end if;

  insert into public.number_daily_usage (number_id, org_id, day, dials)
  values (v_number_id, p_org_id, v_today, 1)
  on conflict (number_id, day) do update set dials = number_daily_usage.dials + 1
  returning dials into v_dials;

  if v_dials >= v_cap then
    update public.user_phone_numbers
    set status = 'resting', resting_until = now() + make_interval(days => v_rest_days)
    where id = v_number_id;
  end if;

  return v_number_id;
end;
$$;

revoke all on function private.reactivate_rested_numbers(uuid) from public, anon, authenticated;
revoke all on function private.has_available_dial_number(uuid, uuid) from public, anon, authenticated;
revoke all on function private.pick_and_reserve_dial_number(uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.reactivate_rested_numbers(uuid) to service_role;
grant execute on function private.has_available_dial_number(uuid, uuid) to service_role;
grant execute on function private.pick_and_reserve_dial_number(uuid, uuid, text) to service_role;

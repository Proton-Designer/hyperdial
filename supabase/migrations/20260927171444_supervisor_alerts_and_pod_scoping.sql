-- MISSION-5 TASK-M5-B4: supervisor alerts (per-org opt-in, per-condition thresholds, one alert
-- per agent per condition per EPISODE) + notification preferences per user + the manager/pod-scope
-- follow-up B2's own task file deferred ("manager after A5" -- A5 has since landed, commits
-- 2201136/bc35f31).
--
-- Four conditions, each independently opt-in with its own editable threshold
-- (org_supervisor_alert_settings, same "org_<feature>_settings" singleton shape as every other
-- settings table in this schema): agent in wrap-up too long, agent paused too long, agent on a
-- call too long, zero connects in the last N minutes of active dialing.
--
-- Dedup ("one alert per agent per condition per episode") uses two different mechanisms, chosen
-- to match what an "episode" actually IS for each condition:
--   - wrap_up/paused/call: an "episode" is exactly one OPEN row in agent_state_events (B1,
--     20260927070000) -- one continuous stretch in that state. A new `alerted_at` column on that
--     table, set once per row the instant it fires, naturally re-arms the moment that row closes
--     (the agent leaves the state) and a fresh row opens next time -- no separate "has this
--     recovered" check needed, the table's own one-open-row-per-agent shape already IS the
--     episode boundary.
--   - zero-connects: there is no single row that represents "a dry spell" -- it is derived from
--     call_legs history. The episode boundary here is "the stretch since the agent's last
--     CONNECTED leg (or since the session started, if they have never connected)" -- see
--     check_supervisor_alerts' own `dry_streak_start` below. `dial_sessions.zero_connects_
--     alerted_at` only blocks a re-fire while it falls INSIDE the current dry streak; a new
--     connect moves the streak's start forward past the old alert, re-arming it for the next dry
--     spell in the SAME session.
--
-- Delivery reuses reliability-alert-check (already a generic 5-minute cron+shared-secret worker
-- doing exactly this "SQL decides+flips, TS notifies via the notifications table" split for T10)
-- rather than standing up a second cron/secret/config.toml entry for the same shape.

-- =================================================================================================
-- 1. org_supervisor_alert_settings
-- =================================================================================================

create table public.org_supervisor_alert_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  wrap_up_alert_enabled boolean not null default false,
  wrap_up_alert_minutes int not null default 10,
  paused_alert_enabled boolean not null default false,
  paused_alert_minutes int not null default 15,
  call_alert_enabled boolean not null default false,
  call_alert_minutes int not null default 30,
  zero_connects_alert_enabled boolean not null default false,
  zero_connects_window_minutes int not null default 30,
  updated_at timestamptz not null default now(),
  constraint org_supervisor_alert_settings_minutes_positive check (
    wrap_up_alert_minutes > 0
    and paused_alert_minutes > 0
    and call_alert_minutes > 0
    and zero_connects_window_minutes > 0
  )
);

alter table public.org_supervisor_alert_settings enable row level security;

create policy "org members can view supervisor alert settings"
  on public.org_supervisor_alert_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert supervisor alert settings"
  on public.org_supervisor_alert_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update supervisor alert settings"
  on public.org_supervisor_alert_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.org_supervisor_alert_settings from anon;

create function private.seed_default_supervisor_alert_settings(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.org_supervisor_alert_settings (org_id)
  values (p_org)
  on conflict (org_id) do nothing;
$$;

create function private.seed_default_supervisor_alert_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_supervisor_alert_settings(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_supervisor_alert_settings
  after insert on public.orgs
  for each row execute function private.seed_default_supervisor_alert_settings_trigger();

do $$
declare
  v_org record;
begin
  for v_org in select id from public.orgs loop
    perform private.seed_default_supervisor_alert_settings(v_org.id);
  end loop;
end;
$$;

-- =================================================================================================
-- 2. Dedup markers -- agent_state_events.alerted_at (wrap_up/paused/call episodes) and
--    dial_sessions.zero_connects_alerted_at (the zero-connects episode). See header for why these
--    are two different shapes.
-- =================================================================================================

alter table public.agent_state_events add column alerted_at timestamptz;

comment on column public.agent_state_events.alerted_at is
  'TASK-M5-B4: set once a wrap_up/paused/call supervisor alert has fired for THIS open row (this
   state episode). A fresh row (opened when the agent leaves this state and later re-enters it)
   always starts null -- the one-open-row-per-agent shape this table already enforces is the
   episode boundary, no separate recovery check needed.';

alter table public.dial_sessions add column zero_connects_alerted_at timestamptz;

comment on column public.dial_sessions.zero_connects_alerted_at is
  'TASK-M5-B4: set once a zero-connects alert has fired for the CURRENT dry streak (since the
   agent''s last connected leg, or since the session started if they have never connected). Only
   blocks a re-fire while it falls inside that same streak -- a later connect moves the streak''s
   start forward past this value, re-arming the alert for the next dry spell in this session.';

-- =================================================================================================
-- 3. check_supervisor_alerts: SQL decides + flips every dedup marker atomically, same
--    "check_stuck_dial_sessions" shape (20260926080400) generalized to 4 conditions + per-org
--    editable thresholds (T10's own thresholds were hardcoded constants; these are not).
-- =================================================================================================

create function public.check_supervisor_alerts()
returns table (org_id uuid, agent_id uuid, session_id uuid, condition text, threshold_minutes int)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  -- wrap_up: one open agent_state_events row in state='wrap_up', past the org's threshold, never
  -- alerted for THIS row before.
  with wrap_up_candidates as (
    select e.id as event_id, e.org_id, e.agent_id, e.session_id, s.wrap_up_alert_minutes as minutes
    from public.agent_state_events e
    join public.org_supervisor_alert_settings s
      on s.org_id = e.org_id and s.wrap_up_alert_enabled
    where e.state = 'wrap_up'
      and e.ended_at is null
      and e.alerted_at is null
      and e.started_at < now() - make_interval(mins => s.wrap_up_alert_minutes)
  ),
  wrap_up_updated as (
    update public.agent_state_events e
    set alerted_at = now()
    from wrap_up_candidates c
    where e.id = c.event_id
    returning e.id
  ),
  wrap_up_fired as (
    select c.org_id, c.agent_id, c.session_id, 'wrap_up_stuck'::text as condition, c.minutes
    from wrap_up_candidates c
    join wrap_up_updated u on u.id = c.event_id
  ),
  -- paused: same shape, state in ('paused', 'paused_agent_lost').
  paused_candidates as (
    select e.id as event_id, e.org_id, e.agent_id, e.session_id, s.paused_alert_minutes as minutes
    from public.agent_state_events e
    join public.org_supervisor_alert_settings s
      on s.org_id = e.org_id and s.paused_alert_enabled
    where e.state in ('paused', 'paused_agent_lost')
      and e.ended_at is null
      and e.alerted_at is null
      and e.started_at < now() - make_interval(mins => s.paused_alert_minutes)
  ),
  paused_updated as (
    update public.agent_state_events e
    set alerted_at = now()
    from paused_candidates c
    where e.id = c.event_id
    returning e.id
  ),
  paused_fired as (
    select c.org_id, c.agent_id, c.session_id, 'paused_stuck'::text as condition, c.minutes
    from paused_candidates c
    join paused_updated u on u.id = c.event_id
  ),
  -- call: same shape, state = 'on_call'.
  call_candidates as (
    select e.id as event_id, e.org_id, e.agent_id, e.session_id, s.call_alert_minutes as minutes
    from public.agent_state_events e
    join public.org_supervisor_alert_settings s
      on s.org_id = e.org_id and s.call_alert_enabled
    where e.state = 'on_call'
      and e.ended_at is null
      and e.alerted_at is null
      and e.started_at < now() - make_interval(mins => s.call_alert_minutes)
  ),
  call_updated as (
    update public.agent_state_events e
    set alerted_at = now()
    from call_candidates c
    where e.id = c.event_id
    returning e.id
  ),
  call_fired as (
    select c.org_id, c.agent_id, c.session_id, 'call_stuck'::text as condition, c.minutes
    from call_candidates c
    join call_updated u on u.id = c.event_id
  ),
  -- zero_connects: derived from call_legs, not a single row -- see the migration header for why
  -- the episode ("dry streak") is computed as "since the agent's last connected leg, or since the
  -- session started if they've never connected" rather than a fixed row's own lifetime.
  zero_connects_base as (
    select
      ds.id as session_id,
      ds.org_id,
      ds.agent_id,
      ds.zero_connects_alerted_at,
      s.zero_connects_window_minutes as minutes,
      coalesce(
        (
          select max(cl.created_at)
          from public.call_legs cl
          where cl.session_id = ds.id and cl.kind = 'contact' and cl.outcome = 'connected'
        ),
        ds.started_at
      ) as dry_streak_start,
      exists (
        select 1
        from public.call_legs cl
        where cl.session_id = ds.id
          and cl.kind = 'contact'
          and cl.created_at > now() - make_interval(mins => s.zero_connects_window_minutes)
      ) as dialed_in_window
    from public.dial_sessions ds
    join public.org_supervisor_alert_settings s
      on s.org_id = ds.org_id and s.zero_connects_alert_enabled
    where ds.state not in ('stopped', 'completed')
  ),
  zero_connects_candidates as (
    select session_id, org_id, agent_id, minutes
    from zero_connects_base
    where dialed_in_window
      and now() - dry_streak_start >= make_interval(mins => minutes)
      and (zero_connects_alerted_at is null or zero_connects_alerted_at < dry_streak_start)
  ),
  zero_connects_updated as (
    update public.dial_sessions ds
    set zero_connects_alerted_at = now()
    from zero_connects_candidates c
    where ds.id = c.session_id
    returning ds.id
  ),
  zero_connects_fired as (
    select c.org_id, c.agent_id, c.session_id, 'zero_connects'::text as condition, c.minutes
    from zero_connects_candidates c
    join zero_connects_updated u on u.id = c.session_id
  )
  select * from wrap_up_fired
  union all
  select * from paused_fired
  union all
  select * from call_fired
  union all
  select * from zero_connects_fired;
end;
$$;

revoke all on function public.check_supervisor_alerts() from public, anon, authenticated;
grant execute on function public.check_supervisor_alerts() to service_role;

-- =================================================================================================
-- 4. user_notification_preferences: per-user opt-out for the 4 alert types above (in-app only,
--    per the task). Absence of a row = on (default, matches this schema's usual "settings row
--    absent means default" convention -- e.g. org_pause_reason_settings' own client-side fallback)
--    -- "defaults = everything on for owner/admin" falls out of this for free, and generalizes it
--    to every role rather than special-casing owner/admin, since a manager who never gets a row
--    should also default to receiving their own pod's alerts (the whole point of routing them at
--    all per this task's requirement).
-- =================================================================================================

create table public.user_notification_preferences (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  alert_type text not null check (
    alert_type in ('wrap_up_stuck', 'paused_stuck', 'call_stuck', 'zero_connects')
  ),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id, alert_type)
);

alter table public.user_notification_preferences enable row level security;

-- A user manages their own; owner/admin may manage anyone's ("owner/admin can set them for
-- someone else" -- the task's own wording). The with check's exists() keeps a row from ever being
-- written for a user who isn't actually a member of that org.
create policy "self or owner/admin can view notification preferences"
  on public.user_notification_preferences for select
  using (user_id = auth.uid() or private.has_org_role(org_id, array['owner', 'admin']));

create policy "self or owner/admin can manage notification preferences"
  on public.user_notification_preferences for all
  using (user_id = auth.uid() or private.has_org_role(org_id, array['owner', 'admin']))
  with check (
    (user_id = auth.uid() or private.has_org_role(org_id, array['owner', 'admin']))
    and exists (
      select 1 from public.org_members m
      where m.org_id = user_notification_preferences.org_id
        and m.user_id = user_notification_preferences.user_id
    )
  );

revoke all on public.user_notification_preferences from anon;

-- =================================================================================================
-- 5. coaching_sessions: widen the SELECT policy to a manager's own rows (TASK-M5-A5 adds the
--    'manager' role; this task widens dialer-coaching's own role gate to admit a pod-scoped
--    manager -- see coaching-core.ts). Nothing currently reads this table directly from the
--    client (the coachingId comes back from the start action's own response), so this is
--    consistency hardening, not a behavior change today. Owner/admin unchanged (still see every
--    row); a manager sees only coaching attempts THEY started, matching runSwitchCoachingModeAction's
--    own `.eq('manager_id', managerId)` scoping already in coaching-core.ts.
-- =================================================================================================

drop policy "owner or admin can view coaching_sessions" on public.coaching_sessions;

create policy "owner or admin see all coaching_sessions, a manager sees their own"
  on public.coaching_sessions for select
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or manager_id = auth.uid()
  );

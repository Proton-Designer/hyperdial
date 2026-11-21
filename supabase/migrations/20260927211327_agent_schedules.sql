-- MISSION-5 TASK-M5-F3 (deferred backlog item): agent working-hours schedules + "not scheduled"
-- warnings, eng1 lane.
--
-- 1. org_members.timezone: nullable per-agent IANA zone override (null = inherit the org's own
--    org_timezone_settings). set_agent_timezone is its one writer -- same gate shape as
--    set_agent_schedule_day (owner/admin any active member, manager only pod-scoped, agent never),
--    kept as its OWN RPC rather than folded into set_agent_schedule_day so setting just the
--    timezone never has to touch/replace an unrelated weekday's shifts (or write a confusing
--    'schedule.set_day' audit row for what is really a tz change). Validated at write time by
--    actually using it in an `at time zone` expression (an invalid IANA name raises there, not a
--    hand-rolled name check).
-- 2. agent_schedules: one row per (org, agent, weekday, shift). Weekday 0=Sunday..6=Saturday
--    (Postgres's own extract(dow ...) convention, so every read/compute side reuses it directly
--    with no off-by-one remapping). start_time/end_time are wall-clock `time` in the agent's own
--    effective timezone -- NEVER a fixed UTC offset, so a schedule survives a DST transition
--    unchanged (the same "9am" shift is correctly 1 hour different in UTC on either side of the
--    transition, exactly like a human's actual expectation). end_time <= start_time means the
--    shift crosses midnight (e.g. 22:00-06:00) -- every reader below treats that as "wraps to the
--    next calendar day", never as a rejected/invalid row.
-- 3. set_agent_schedule_day: the only writer. Replaces one weekday's entire shift list atomically
--    (delete + insert) -- this one RPC is also how the UI implements "copy day to other days"
--    (call it once per target weekday with the source day's shifts) and "apply to selected
--    agents" (call it once per selected agent) -- no separate bulk RPC needed, same "compose
--    small primitives, don't grow the RPC surface" precedent as TM-B2/A6. Rejects overlapping
--    shifts within the same day (including a wrap-around shift overlapping a same-day one) BEFORE
--    writing anything. Gate: owner/admin any active member; manager only
--    private.is_agent_in_callers_pod_scope; agent role can never write (not even their own -- see
--    task header: "an agent reads (not edits) their own").
-- 4. list_agent_schedules: the one reader. Owner/admin: every active member's shifts. Manager:
--    pod-scoped + their own. A caller with role='agent' and no wider role: ONLY their own rows,
--    same self-view carve-out shape as agent_first_activity/agent_time_in_state
--    (is_agent_in_callers_pod_scope(...) or (has_org_role('agent') and target = auth.uid())).
--    Returns effective_timezone per row (coalesce agent's own override, org default) so the client
--    never has to separately fetch/merge org_timezone_settings.
-- 5. Two read-only signal RPCs -- informational only, this task explicitly forbids blocking
--    dialing or auto-notifying (an org setting, default OFF, is out of scope for this pass; no
--    such setting is added here):
--    a. agent_schedule_live_status: for an agent CURRENTLY in an active dial_session, is "now"
--       inside any of today's (their local "today") shifts? Real-time, point-in-time only -- backs
--       the cockpit's "Dialing outside schedule" badge. Deliberately a SEPARATE function from
--       team_live_board (not a widen-in-place) -- that function was just widened by B2's own
--       in-flight edit (20260927151747_supervisor_controls.sql) and a second concurrent
--       return-type change to the same function this session is exactly the kind of collision
--       R-037 exists to avoid; the client merges this by agent_id instead (same pattern as
--       groupAttendance's own first-activity merge).
--    b. agent_schedule_attendance_signal: per (agent, local day) that has >=1 shift scheduled --
--       days with NO schedule at all emit NO ROW, so the client's merge naturally shows nothing
--       instead of a boolean needing tri-state handling (the task's own edge case: "no schedule
--       ever means 'no schedule', never a warning"). scheduled_not_signed_in: the day's EARLIEST
--       shift started (start_time + 15 minutes) at or before the point being evaluated (now(), for
--       today; end-of-day, for a past day already fully elapsed) AND the agent's first activity
--       that day (identical MIN(started_at) computation as agent_first_activity) is null or later
--       than that threshold -- a defensible, explicitly-approximate proxy (one threshold per day,
--       not per shift) for "the day was supposed to start by now and nothing did", matching the
--       task's own "informational" framing. dialed_outside_schedule: true iff any dial_session for
--       that agent on that local day STARTED at a local time-of-day outside every shift scheduled
--       for its own weekday (a session-start check, not a full session-interval overlap check --
--       proportionate to an informational badge, documented here per the TM-B2 "justify the proxy
--       in the migration header" precedent rather than silently picked).
--    Both mirror agent_first_activity's own p_from/p_to/p_agent/p_tz signature and CURRENT (post-
--    A5) role-gate shape for consistency, learned the hard way from a7f3b65 (a NEW sibling
--    function must mirror the CURRENT gate, not a stale original one -- there is no stale one here
--    since this is the first version).
-- 6. Edge cases (audit/M5-F3/notes.md has the one-line-each version):
--    - removed/offboarded agents (A3): every read path filters org_members.status = 'active', so a
--      removed agent's schedule rows (never deleted) simply stop appearing anywhere -- and
--      correctly reappear if restored within A3's 72h window, same "row persists, read path
--      filters" choice this session already made for org_manager_pods-adjacent state.
--    - DST: every conversion goes through `<timestamptz> at time zone <iana_zone>` (never a fixed
--      offset), so a shift's local wall-clock time is unaffected by a DST transition -- Postgres's
--      IANA tzdata handles the actual UTC-offset shift for us.
--    - overlapping shifts (including a wrap-around shift overlapping a plain same-day one):
--      rejected at write time in set_agent_schedule_day, see its own body.
--    - manager outside their pod scope: is_agent_in_callers_pod_scope returns false, both the
--      write RPC and the read RPC reject/exclude before touching any row.

-- =================================================================================================
-- 1. org_members.timezone
-- =================================================================================================

alter table public.org_members add column timezone text;

-- =================================================================================================
-- 2. agent_schedules
-- =================================================================================================

create table public.agent_schedules (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  agent_user_id uuid not null references auth.users(id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  start_time time not null,
  end_time time not null check (end_time <> start_time),
  created_by uuid not null default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index agent_schedules_org_agent_idx on public.agent_schedules(org_id, agent_user_id, weekday);

alter table public.agent_schedules enable row level security;

-- No insert/update/delete policy for any client role -- set_agent_schedule_day is the only writer
-- (same lockdown shape as org_goals/org_broadcasts: the RPC is where scope/overlap is enforced).
create policy "owner/admin all, manager pod-scoped, agent their own"
  on public.agent_schedules for select
  using (
    private.is_agent_in_callers_pod_scope(org_id, agent_user_id)
    or (private.has_org_role(org_id, array['agent']) and agent_user_id = auth.uid())
  );

revoke all on public.agent_schedules from anon;

-- =================================================================================================
-- 3. set_agent_schedule_day
-- =================================================================================================

create function public.set_agent_schedule_day(
  p_org uuid,
  p_agent uuid,
  p_weekday smallint,
  p_shifts jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_shift jsonb;
  v_start time;
  v_end time;
  v_eff_end numeric;
  v_starts numeric[] := '{}';
  v_ends numeric[] := '{}';
  v_i int;
  v_j int;
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    raise exception 'only an owner, admin, or manager can edit schedules';
  end if;
  if not private.is_agent_in_callers_pod_scope(p_org, p_agent) then
    raise exception 'that agent is outside your managed pods';
  end if;
  if not exists (
    select 1 from public.org_members where org_id = p_org and user_id = p_agent and status = 'active'
  ) then
    raise exception 'agent not found in this org';
  end if;
  if p_weekday < 0 or p_weekday > 6 then
    raise exception 'weekday must be 0-6';
  end if;
  if jsonb_typeof(p_shifts) is distinct from 'array' then
    raise exception 'shifts must be a JSON array';
  end if;

  for v_shift in select * from jsonb_array_elements(p_shifts)
  loop
    v_start := (v_shift ->> 'start')::time;
    v_end := (v_shift ->> 'end')::time;
    if v_start is null or v_end is null then
      raise exception 'each shift needs a start and end time';
    end if;
    if v_start = v_end then
      raise exception 'a shift cannot start and end at the same time';
    end if;
    -- Effective end on a 0-48h axis: a wrap-around shift (end <= start) extends past 24:00 so
    -- overlap comparison below works uniformly whether either shift wraps or not.
    v_eff_end := extract(epoch from v_end) / 60;
    if v_end <= v_start then
      v_eff_end := v_eff_end + 1440;
    end if;
    v_starts := array_append(v_starts, extract(epoch from v_start) / 60);
    v_ends := array_append(v_ends, v_eff_end);
  end loop;

  -- Pairwise overlap check across every shift submitted for this one day (O(n^2) over a handful
  -- of shifts per day, so this is plenty fast).
  for v_i in 1 .. coalesce(array_length(v_starts, 1), 0) loop
    for v_j in (v_i + 1) .. coalesce(array_length(v_starts, 1), 0) loop
      if v_starts[v_i] < v_ends[v_j] and v_starts[v_j] < v_ends[v_i] then
        raise exception 'shifts on the same day cannot overlap';
      end if;
    end loop;
  end loop;

  -- eng2 review SHOULD: serialize concurrent saves for the same agent (otherwise two delete+insert
  -- runs can't see each other's uncommitted rows and both sets of shifts survive).
  perform 1 from public.org_members where org_id = p_org and user_id = p_agent for update;
  delete from public.agent_schedules where org_id = p_org and agent_user_id = p_agent and weekday = p_weekday;

  for v_shift in select * from jsonb_array_elements(p_shifts)
  loop
    insert into public.agent_schedules (org_id, agent_user_id, weekday, start_time, end_time)
    values (p_org, p_agent, p_weekday, (v_shift ->> 'start')::time, (v_shift ->> 'end')::time);
  end loop;

  perform private.log_org_action(
    p_org, 'schedule.set_day', 'org_member', p_agent,
    jsonb_build_object('weekday', p_weekday, 'shift_count', jsonb_array_length(p_shifts))
  );
end;
$$;

revoke all on function public.set_agent_schedule_day(uuid, uuid, smallint, jsonb) from public, anon;
grant execute on function public.set_agent_schedule_day(uuid, uuid, smallint, jsonb) to authenticated;

-- =================================================================================================
-- 3b. set_agent_timezone: the one writer of org_members.timezone. Same gate shape as
--     set_agent_schedule_day (see its own header for why this is a separate RPC).
-- =================================================================================================

create function public.set_agent_timezone(p_org uuid, p_agent uuid, p_timezone text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_probe timestamptz;
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    raise exception 'only an owner, admin, or manager can edit schedules';
  end if;
  if not private.is_agent_in_callers_pod_scope(p_org, p_agent) then
    raise exception 'that agent is outside your managed pods';
  end if;
  if not exists (
    select 1 from public.org_members where org_id = p_org and user_id = p_agent and status = 'active'
  ) then
    raise exception 'agent not found in this org';
  end if;

  if p_timezone is not null then
    -- Validate by actually using it -- an unrecognized IANA zone raises here, not via a hand-
    -- rolled name check that would drift from Postgres's own tzdata.
    v_probe := now() at time zone p_timezone;
  end if;

  update public.org_members set timezone = p_timezone where org_id = p_org and user_id = p_agent;

  perform private.log_org_action(
    p_org, 'schedule.set_timezone', 'org_member', p_agent, jsonb_build_object('timezone', p_timezone)
  );
end;
$$;

revoke all on function public.set_agent_timezone(uuid, uuid, text) from public, anon;
grant execute on function public.set_agent_timezone(uuid, uuid, text) to authenticated;

-- =================================================================================================
-- 4. list_agent_schedules
-- =================================================================================================

create function public.list_agent_schedules(p_org uuid, p_agent uuid default null)
returns table (
  agent_user_id uuid,
  weekday smallint,
  start_time time,
  end_time time,
  effective_timezone text
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    s.agent_user_id,
    s.weekday,
    s.start_time,
    s.end_time,
    coalesce(m.timezone, ots.timezone) as effective_timezone
  from public.agent_schedules s
  join public.org_members m on m.org_id = s.org_id and m.user_id = s.agent_user_id
  join public.org_timezone_settings ots on ots.org_id = s.org_id
  where s.org_id = p_org
    and m.status = 'active'
    and (p_agent is null or s.agent_user_id = p_agent)
    and (
      private.is_agent_in_callers_pod_scope(p_org, s.agent_user_id)
      or (private.has_org_role(p_org, array['agent']) and s.agent_user_id = auth.uid())
    )
  order by s.agent_user_id, s.weekday, s.start_time;
$$;

revoke all on function public.list_agent_schedules(uuid, uuid) from public, anon;
grant execute on function public.list_agent_schedules(uuid, uuid) to authenticated;

-- =================================================================================================
-- 5a. agent_schedule_live_status -- cockpit real-time badge
-- =================================================================================================

create function public.agent_schedule_live_status(p_org uuid)
returns table (
  agent_id uuid,
  has_schedule boolean,
  dialing_outside_schedule boolean
)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager']) then
    return;
  end if;

  return query
  with active_agents as (
    select distinct ds.agent_id
    from public.dial_sessions ds
    where ds.org_id = p_org and ds.state not in ('stopped', 'completed')
      and private.is_agent_in_callers_pod_scope(p_org, ds.agent_id)
  ),
  tz as (
    select a.agent_id, coalesce(m.timezone, ots.timezone) as agent_tz
    from active_agents a
    join public.org_members m on m.org_id = p_org and m.user_id = a.agent_id
    join public.org_timezone_settings ots on ots.org_id = p_org
  ),
  now_local as (
    select tz.agent_id, tz.agent_tz,
      (now() at time zone tz.agent_tz) as local_now
    from tz
  )
  select
    nl.agent_id,
    exists (select 1 from public.agent_schedules s where s.org_id = p_org and s.agent_user_id = nl.agent_id) as has_schedule,
    (
      exists (select 1 from public.agent_schedules s where s.org_id = p_org and s.agent_user_id = nl.agent_id)
      and not exists (
        select 1 from public.agent_schedules s
        where s.org_id = p_org and s.agent_user_id = nl.agent_id
          and (
            -- today's own shift, wrap or not
            (s.weekday = extract(dow from nl.local_now)
              and nl.local_now::time >= s.start_time
              and (nl.local_now::time < s.end_time or s.end_time <= s.start_time))
            or
            -- yesterday's wrap-around shift still covering the early hours of today
            (s.weekday = extract(dow from nl.local_now - interval '1 day')
              and s.end_time <= s.start_time
              and nl.local_now::time < s.end_time)
          )
      )
    ) as dialing_outside_schedule
  from now_local nl;
end;
$$;

revoke all on function public.agent_schedule_live_status(uuid) from public, anon;
grant execute on function public.agent_schedule_live_status(uuid) to authenticated;

-- =================================================================================================
-- 5b. agent_schedule_attendance_signal -- Attendance tab column
-- =================================================================================================

create function public.agent_schedule_attendance_signal(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_agent uuid default null,
  p_tz text default 'America/Chicago'
)
returns table (
  agent_id uuid,
  day date,
  scheduled_not_signed_in boolean,
  dialed_outside_schedule boolean
)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not (
    private.has_org_role(p_org, array['owner', 'admin', 'manager'])
    or (private.has_org_role(p_org, array['agent']) and p_agent = auth.uid())
  ) then
    return;
  end if;

  return query
  with scoped_agents as (
    select m.user_id as agent_id, coalesce(m.timezone, p_tz) as agent_tz
    from public.org_members m
    where m.org_id = p_org and m.status = 'active'
      and (p_agent is null or m.user_id = p_agent)
      and (
        private.is_agent_in_callers_pod_scope(p_org, m.user_id)
        or (private.has_org_role(p_org, array['agent']) and m.user_id = auth.uid())
      )
  ),
  days as (
    select sa.agent_id, sa.agent_tz, d::date as day
    from scoped_agents sa
    cross join lateral generate_series(
      date_trunc('day', p_from at time zone sa.agent_tz),
      date_trunc('day', p_to at time zone sa.agent_tz),
      interval '1 day'
    ) as d
  ),
  day_shifts as (
    select dd.agent_id, dd.agent_tz, dd.day,
      s.start_time, s.end_time
    from days dd
    join public.agent_schedules s
      on s.org_id = p_org and s.agent_user_id = dd.agent_id
      and s.weekday = extract(dow from dd.day)
  ),
  earliest_shift as (
    select agent_id, day, agent_tz, min(start_time) as earliest_start
    from day_shifts
    group by agent_id, day, agent_tz
  ),
  first_activity as (
    select ds.agent_id,
      (date_trunc('day', ds.started_at at time zone sa.agent_tz))::date as day,
      min(ds.started_at at time zone sa.agent_tz) as first_started_local
    from public.dial_sessions ds
    join scoped_agents sa on sa.agent_id = ds.agent_id
    where ds.org_id = p_org
    group by ds.agent_id, date_trunc('day', ds.started_at at time zone sa.agent_tz)
  ),
  dial_starts as (
    select ds.agent_id,
      (date_trunc('day', ds.started_at at time zone dd.agent_tz))::date as day,
      (ds.started_at at time zone dd.agent_tz)::time as local_time_of_day
    from public.dial_sessions ds
    join scoped_agents dd on dd.agent_id = ds.agent_id
    where ds.org_id = p_org
      and ds.started_at >= p_from and ds.started_at <= p_to
  )
  select
    es.agent_id,
    es.day,
    (
      (now() at time zone es.agent_tz) >= (es.day + es.earliest_start + interval '15 minutes')
      and (
        fa.first_started_local is null
        or fa.first_started_local > (es.day + es.earliest_start + interval '15 minutes')
      )
    ) as scheduled_not_signed_in,
    exists (
      select 1 from dial_starts ds2
      where ds2.agent_id = es.agent_id and ds2.day = es.day
        and not exists (
          select 1 from day_shifts sh
          where sh.agent_id = ds2.agent_id and sh.day = ds2.day
            and ds2.local_time_of_day >= sh.start_time
            and (ds2.local_time_of_day < sh.end_time or sh.end_time <= sh.start_time)
        )
        and not exists (
          -- yesterday's wrap-around shift still covering this session's start
          select 1 from public.agent_schedules s
          where s.org_id = p_org and s.agent_user_id = ds2.agent_id
            and s.weekday = extract(dow from ds2.day - interval '1 day')
            and s.end_time <= s.start_time
            and ds2.local_time_of_day < s.end_time
        )
    ) as dialed_outside_schedule
  from earliest_shift es
  left join first_activity fa on fa.agent_id = es.agent_id and fa.day = es.day;
end;
$$;

revoke all on function public.agent_schedule_attendance_signal(uuid, timestamptz, timestamptz, uuid, text) from public, anon;
grant execute on function public.agent_schedule_attendance_signal(uuid, timestamptz, timestamptz, uuid, text) to authenticated;

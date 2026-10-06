-- TASK-S01 (Shifts subsystem, backend foundation). Design mapping: docs/design/shifts.md (D1-D10),
-- product spec: docs/design/shifts-build-spec.txt.
--
-- What this migration is: every table, RLS policy and SQL function the Shifts feature needs, EXCEPT
-- the cron schedules (S05), the KPI compute (S05), the review/admin RPCs (S03) and the GHL HTTP
-- sync (S04). Nothing here touches an existing table, function or the dialer. The feature is OFF per
-- org (shift_settings.enabled default false); enqueue_shift_event and submit_week are inert/refuse
-- for a disabled org.
--
-- Decisions worth knowing (also in audit/S01/notes.md):
--  * Tenancy = org_id on every table, roles come from org_members (D1). Manager visibility over
--    other people's rows = private.is_agent_in_callers_pod_scope, the same rule as list_agent_schedules.
--  * Writes: no client write privilege on ANY new table (revoked, not just "no policy"). Every write
--    is a service_role-only SECURITY DEFINER function (EXECUTE revoked from public/anon/authenticated).
--  * Error protocol for the write RPCs: `raise exception using errcode='P0001', message=<code>,
--    detail=<json>` so an edge function can return { error: code, ...detail }.
--  * submit_week's bad_block detail is { index (0-based position in p_blocks), reason } where reason
--    is one of bad_format | outside_week | bad_time_step | end_before_start | bad_activity |
--    outside_open_hours. Extra codes beyond shifts.md section 3: bad_week (week_start not a Monday),
--    forbidden (caller is not an active member).
--  * The weekly-minimum check counts the picks being submitted PLUS the user's other scheduled
--    shifts that week (source request/admin), so an approved "add" never forces redundant picks.
--  * week_commitments.scheduled_hours / power_hours count status scheduled+completed+missed shifts so
--    the figure does not shrink as the week plays out (cancelled/excused never count).

create extension if not exists btree_gist with schema extensions;

-- =================================================================================================
-- 1. Tables
-- =================================================================================================

create table public.shift_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  enabled boolean not null default false,
  timezone text not null default 'America/Chicago',
  min_weekly_hours numeric(4,2) not null default 8 check (min_weekly_hours >= 0),
  lock_weekday smallint not null default 7 check (lock_weekday between 1 and 7),
  lock_time time not null default '18:00',
  change_notice_hours smallint not null default 12 check (change_notice_hours >= 0),
  grace_minutes smallint not null default 10 check (grace_minutes >= 0),
  conversation_min_seconds smallint not null default 60 check (conversation_min_seconds >= 0),
  idle_flag_minutes smallint not null default 20 check (idle_flag_minutes >= 0),
  adherence_flag_pct smallint not null default 75 check (adherence_flag_pct between 0 and 100),
  open_session_tail_minutes smallint not null default 5 check (open_session_tail_minutes >= 0),
  power_coverage_alert smallint not null default 2 check (power_coverage_alert >= 0),
  power_week_pct smallint not null default 80 check (power_week_pct between 0 and 100),
  ghl_calendar_id text,
  ghl_owner_user_id text,
  last_locked_week date,
  last_closed_week date,
  updated_at timestamptz not null default now()
);

create table public.open_hours (
  org_id uuid not null references public.orgs(id) on delete cascade,
  iso_weekday smallint not null check (iso_weekday between 1 and 7),
  open_from time not null,
  open_until time not null check (open_until > open_from),
  primary key (org_id, iso_weekday)
);

create table public.power_windows (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  label text not null,
  iso_weekdays smallint[] not null default '{1,2,3,4,5}',
  start_time time not null,
  end_time time not null check (end_time > start_time),
  active boolean not null default true
);
create index power_windows_org_idx on public.power_windows(org_id);

-- D4: who participates + their GHL contact. A missing row = participates iff role = 'agent'.
create table public.shift_members (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  ghl_contact_id text,
  participates boolean not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, user_id),
  unique (org_id, ghl_contact_id)
);

create table public.week_commitments (
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null check (extract(isodow from week_start) = 1),
  submitted_at timestamptz,
  scheduled_hours numeric(5,2) not null default 0,
  power_hours numeric(5,2) not null default 0,
  power_dial_pct numeric(5,1),
  power_week boolean not null default false,
  light_week boolean not null default false,
  min_hours_override numeric(4,2),
  primary key (org_id, user_id, week_start)
);

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  activity text not null default 'dialing' check (activity in ('dialing', 'follow_up', 'social')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  hours numeric(5,2) generated always as ((extract(epoch from (ends_at - starts_at)) / 3600)::numeric(5,2)) stored,
  power_minutes integer not null default 0,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'cancelled', 'completed', 'missed', 'excused')),
  source text not null check (source in ('pick', 'request', 'admin')),
  ghl_appointment_id text,
  ghl_sync_status text not null default 'pending' check (ghl_sync_status in ('pending', 'synced', 'error')),
  ghl_sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at - starts_at >= interval '30 minutes'),
  check (extract(epoch from starts_at)::bigint % 1800 = 0 and extract(epoch from ends_at)::bigint % 1800 = 0),
  exclude using gist (org_id with =, user_id with =, tstzrange(starts_at, ends_at) with &&)
    where (status = 'scheduled')
);
create index shifts_org_week_status on public.shifts(org_id, week_start, status);
create index shifts_user_start on public.shifts(user_id, starts_at);
create index shifts_time on public.shifts using gist (tstzrange(starts_at, ends_at)) where (status = 'scheduled');

create table public.shift_change_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  week_start date not null,
  type text not null check (type in ('move', 'drop', 'add', 'light_week')),
  from_shift_id uuid references public.shifts(id) on delete cascade,
  to_starts_at timestamptz,
  to_ends_at timestamptz,
  to_activity text check (to_activity in ('dialing', 'follow_up', 'social')),
  requested_min_hours numeric(4,2),
  reason text not null check (char_length(btrim(reason)) >= 20),
  is_late boolean not null default false,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'withdrawn')),
  reviewer_id uuid references auth.users(id),
  reviewer_note text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((type in ('move', 'drop')) = (from_shift_id is not null)),
  check ((type in ('move', 'add')) = (to_starts_at is not null and to_ends_at is not null)),
  check ((type = 'light_week') = (requested_min_hours is not null))
);
create index shift_change_requests_org_status on public.shift_change_requests(org_id, status, created_at);
create index shift_change_requests_user on public.shift_change_requests(user_id, created_at desc);
create unique index one_open_request_per_shift
  on public.shift_change_requests(from_shift_id) where status = 'pending';

create table public.shift_kpis (
  shift_id uuid primary key references public.shifts(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  computed_at timestamptz not null default now(),
  final boolean not null default false,
  scheduled_minutes integer not null,
  active_dial_minutes integer not null default 0,
  power_active_minutes integer not null default 0,
  adherence_pct integer not null default 0,
  first_dial_at timestamptz,
  last_call_end_at timestamptz,
  late_start_minutes integer not null default 0,
  early_end_minutes integer not null default 0,
  longest_idle_minutes integer not null default 0,
  dials integer not null default 0,
  connects integer not null default 0,
  conversations integer not null default 0,
  voicemails integer not null default 0,
  no_answers integer not null default 0,
  talk_minutes integer not null default 0,
  dials_per_active_hour numeric(6,1),
  connect_rate_pct numeric(5,1),
  dispositions jsonb not null default '{}',
  flags text[] not null default '{}'
);
create index shift_kpis_org_user on public.shift_kpis(org_id, user_id);

create table public.shift_ghl_outbox (
  id bigserial primary key,
  org_id uuid not null references public.orgs(id) on delete cascade,
  kind text not null check (kind in ('appointment_upsert', 'appointment_cancel', 'appointment_status',
                                     'contact_fields', 'contact_note', 'contact_tags_add', 'contact_tags_remove')),
  event text,
  shift_id uuid references public.shifts(id) on delete cascade,
  user_id uuid references auth.users(id) on delete cascade,
  payload jsonb not null default '{}',
  status text not null default 'pending' check (status in ('pending', 'done', 'error')),
  attempts smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now()
);
create index shift_ghl_outbox_due on public.shift_ghl_outbox(status, next_attempt_at);
create index shift_ghl_outbox_org on public.shift_ghl_outbox(org_id, status);

-- =================================================================================================
-- 2. Helpers (private schema)
-- =================================================================================================

-- The one error shape every shifts write RPC raises (see header).
create function private.shift_err(p_code text, p_detail jsonb default '{}')
returns void
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = p_detail::text;
end;
$$;

create function private.shift_is_manager(p_org uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select private.has_org_role(p_org, array['owner', 'admin', 'manager']);
$$;

-- Visibility rule for per-person shift rows: your own, or manager-level + pod scope (D1).
create function private.shift_can_see(p_org uuid, p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    (p_user = auth.uid() and private.has_org_role(p_org, array['owner', 'admin', 'manager', 'agent']))
    or (private.shift_is_manager(p_org) and private.is_agent_in_callers_pod_scope(p_org, p_user));
$$;

-- D4: does this member count as an "intern" for lock/close/coverage jobs?
create function private.shift_participates(p_org uuid, p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    exists (select 1 from public.org_members m where m.org_id = p_org and m.user_id = p_user and m.status = 'active')
    and coalesce(
      (select sm.participates from public.shift_members sm where sm.org_id = p_org and sm.user_id = p_user),
      (select m.role = 'agent' from public.org_members m where m.org_id = p_org and m.user_id = p_user),
      false
    );
$$;

create function private.shift_tz(p_org uuid)
returns text
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select s.timezone from public.shift_settings s where s.org_id = p_org),
    (select o.timezone from public.org_timezone_settings o where o.org_id = p_org),
    'America/Chicago'
  );
$$;

-- Display name. Same source as every other name-resolving query (profiles first/last, then email,
-- then 'Member'). p_full = false gives the intern-facing "First L." form.
create function private.shift_member_name(p_user uuid, p_full boolean)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select case
    when p_full then coalesce(
      nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
      u.email,
      'Member'
    )
    else coalesce(
      nullif(btrim(
        coalesce(nullif(btrim(p.first_name), ''), '')
        || case when nullif(btrim(p.last_name), '') is not null
                then ' ' || upper(left(btrim(p.last_name), 1)) || '.' else '' end
      ), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      'Member'
    )
  end
  from (select 1) one
  left join public.profiles p on p.user_id = p_user
  left join auth.users u on u.id = p_user;
$$;

-- Idempotent, concurrency-safe default seeding (D2). Seeds once, together with the settings row: a
-- manager who later deletes every power window does not get them re-created.
create function private.ensure_shift_config(p_org uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows int;
begin
  if exists (select 1 from public.shift_settings where org_id = p_org) then
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('shift_cfg:' || p_org::text, 0));

  insert into public.shift_settings (org_id, timezone)
  values (p_org, coalesce((select o.timezone from public.org_timezone_settings o where o.org_id = p_org), 'America/Chicago'))
  on conflict (org_id) do nothing;
  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    insert into public.open_hours (org_id, iso_weekday, open_from, open_until)
    select p_org, d, '07:00', case when d = 6 then '12:00'::time else '21:00'::time end
    from generate_series(1, 6) as d
    on conflict do nothing;

    insert into public.power_windows (org_id, label, iso_weekdays, start_time, end_time) values
      (p_org, 'Morning', '{1,2,3,4,5}', '07:00', '10:00'),
      (p_org, 'Lunch', '{1,2,3,4,5}', '11:00', '14:00'),
      (p_org, 'After work', '{1,2,3,4,5}', '16:00', '18:00');
  end if;
end;
$$;

-- Pick deadline for a week: the lock weekday of the PRECEDING week (7 = Sunday = the day before a
-- Monday week_start) at lock_time, in the org's timezone (converted per date, so DST-safe).
create function private.shift_week_deadline(p_org uuid, p_week_start date)
returns timestamptz
language sql
stable
set search_path = ''
as $$
  select ((p_week_start - 8 + s.lock_weekday)::timestamp + s.lock_time) at time zone s.timezone
  from public.shift_settings s
  where s.org_id = p_org;
$$;

-- Minutes of [starts, ends) inside active power windows, computed in the org's local time per date.
create function private.shift_power_minutes(p_org uuid, p_starts_at timestamptz, p_ends_at timestamptz)
returns integer
language sql
stable
set search_path = ''
as $$
  with tz as (select private.shift_tz(p_org) as z)
  select coalesce(sum(greatest(0, floor(extract(epoch from (
      least(p_ends_at, w.we) - greatest(p_starts_at, w.ws)
    )) / 60))), 0)::int
  from tz,
  lateral (
    select
      ((g.d::date + pw.start_time)::timestamp at time zone tz.z) as ws,
      ((g.d::date + pw.end_time)::timestamp at time zone tz.z) as we
    from generate_series(
      (p_starts_at at time zone tz.z)::date::timestamp,
      (p_ends_at at time zone tz.z)::date::timestamp,
      interval '1 day'
    ) as g(d)
    join public.power_windows pw
      on pw.org_id = p_org and pw.active
     and extract(isodow from g.d)::smallint = any (pw.iso_weekdays)
  ) w;
$$;

-- Recomputes (creating if needed) one user-week's hours on week_commitments. S03 reuses this.
create function private.recompute_week_hours(p_org uuid, p_user uuid, p_week date)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.week_commitments (org_id, user_id, week_start, scheduled_hours, power_hours)
  select p_org, p_user, p_week,
    coalesce(sum(s.hours), 0),
    coalesce(sum(s.power_minutes), 0) / 60.0
  from public.shifts s
  where s.org_id = p_org and s.user_id = p_user and s.week_start = p_week
    and s.status in ('scheduled', 'completed', 'missed')
  on conflict (org_id, user_id, week_start)
  do update set scheduled_hours = excluded.scheduled_hours, power_hours = excluded.power_hours;
$$;

-- ---- text/format helpers ------------------------------------------------------------------------

-- "7:00-10:00 AM" (same meridiem) or "11:00 AM-2:00 PM".
create function private.shift_time_range_text(p_start timestamptz, p_end timestamptz, p_tz text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when to_char(p_start at time zone p_tz, 'AM') = to_char(p_end at time zone p_tz, 'AM')
      then to_char(p_start at time zone p_tz, 'FMHH12:MI') || '-' || to_char(p_end at time zone p_tz, 'FMHH12:MI AM')
    else to_char(p_start at time zone p_tz, 'FMHH12:MI AM') || '-' || to_char(p_end at time zone p_tz, 'FMHH12:MI AM')
  end;
$$;

-- "Tue Oct 13, 7:00-10:00 AM, dialing (power)"
create function private.shift_line(s public.shifts, p_tz text)
returns text
language sql
stable
set search_path = ''
as $$
  select to_char(s.starts_at at time zone p_tz, 'Dy Mon FMDD') || ', '
    || private.shift_time_range_text(s.starts_at, s.ends_at, p_tz) || ', '
    || replace(s.activity, '_', ' ')
    || case when s.power_minutes > 0 then ' (power)' else '' end;
$$;

-- "{First} {L}. dialed {hours} hrs this week, {all | NN%} in power windows."  (p_name is the short
-- form, which already ends in the initial's period.)
create function private.shift_power_week_sentence(p_name text, p_dial_minutes numeric, p_power_pct numeric)
returns text
language sql
immutable
set search_path = ''
as $$
  select p_name || ' dialed ' || to_char(round(p_dial_minutes / 60.0, 1), 'FM990.0') || ' hrs this week, '
    || case when p_power_pct >= 100 then 'all' else round(p_power_pct)::int::text || '%' end
    || ' in power windows.';
$$;

create function private.shift_request_desc(r public.shift_change_requests, p_tz text)
returns text
language sql
stable
set search_path = ''
as $$
  select case r.type
    when 'move' then 'Move shift ' || coalesce((select private.shift_line(s, p_tz) from public.shifts s where s.id = r.from_shift_id), '(removed shift)')
      || ' to ' || to_char(r.to_starts_at at time zone p_tz, 'Dy Mon FMDD') || ', '
      || private.shift_time_range_text(r.to_starts_at, r.to_ends_at, p_tz) || ', ' || replace(coalesce(r.to_activity, 'dialing'), '_', ' ')
    when 'drop' then 'Drop shift ' || coalesce((select private.shift_line(s, p_tz) from public.shifts s where s.id = r.from_shift_id), '(removed shift)')
    when 'add' then 'Add time ' || to_char(r.to_starts_at at time zone p_tz, 'Dy Mon FMDD') || ', '
      || private.shift_time_range_text(r.to_starts_at, r.to_ends_at, p_tz) || ', ' || replace(coalesce(r.to_activity, 'dialing'), '_', ' ')
    else 'Light week: ' || r.requested_min_hours::text || ' hrs for the week of ' || to_char(r.week_start, 'Mon FMDD')
  end;
$$;

-- ---- GHL field value builders ---------------------------------------------------------------------

-- Fields describing one week, in the this-week or next-week bucket depending on how the week relates
-- to "now" in the org's timezone; a week further out than next gets no week-bucket fields.
create function private.shift_week_fields(p_org uuid, p_user uuid, p_week date)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text := private.shift_tz(p_org);
  v_this date := date_trunc('week', now() at time zone private.shift_tz(p_org))::date;
  v_c public.week_commitments;
  v_hours numeric;
  v_power numeric;
  v_lines text;
  v_min numeric;
begin
  select * into v_c from public.week_commitments
  where org_id = p_org and user_id = p_user and week_start = p_week;

  select coalesce(sum(s.hours), 0), coalesce(sum(s.power_minutes), 0) / 60.0,
         string_agg(private.shift_line(s, v_tz), E'\n' order by s.starts_at)
  into v_hours, v_power, v_lines
  from public.shifts s
  where s.org_id = p_org and s.user_id = p_user and s.week_start = p_week
    and s.status in ('scheduled', 'completed', 'missed');

  v_min := coalesce(v_c.min_hours_override, (select st.min_weekly_hours from public.shift_settings st where st.org_id = p_org));

  if p_week = v_this then
    return jsonb_build_object(
      'shift_hours_this_week', round(v_hours, 2),
      'shift_power_hours_this_week', round(v_power, 2),
      'shift_schedule_this_week', coalesce(v_lines, ''),
      'shift_min_hours_this_week', v_min,
      'shift_light_week', case when coalesce(v_c.light_week, false) then 'Yes' else 'No' end
    );
  elsif p_week = v_this + 7 then
    return jsonb_build_object(
      'shift_hours_next_week', round(v_hours, 2),
      'shift_power_hours_next_week', round(v_power, 2),
      'shift_schedule_next_week', coalesce(v_lines, ''),
      'shift_week_submitted', case when v_c.submitted_at is not null then 'Yes' else 'No' end
    );
  end if;
  return '{}'::jsonb;
end;
$$;

-- shift_next_shift_at: local date (GHL Date field) of the next scheduled shift, JSON null if none.
create function private.shift_next_shift_field(p_org uuid, p_user uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object('shift_next_shift_at',
    (select to_char(min(s.starts_at) at time zone private.shift_tz(p_org), 'YYYY-MM-DD')
     from public.shifts s
     where s.org_id = p_org and s.user_id = p_user and s.status = 'scheduled' and s.starts_at > now()));
$$;

-- week_* rollup (week-to-date; final after week close). week_power_week is added only by the events
-- that own it (power_week / week_closed).
create function private.shift_week_rollup(p_org uuid, p_user uuid, p_week date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  with k as (
    select
      coalesce(sum(x.active_dial_minutes), 0) as active,
      coalesce(sum(x.power_active_minutes), 0) as power,
      coalesce(sum(x.dials), 0) as dials,
      coalesce(sum(x.conversations), 0) as convs,
      coalesce(sum(x.scheduled_minutes), 0) as sched
    from public.shift_kpis x
    join public.shifts s on s.id = x.shift_id
    where s.org_id = p_org and s.user_id = p_user and s.week_start = p_week
  )
  select jsonb_build_object(
    'week_dial_minutes', k.active,
    'week_power_dial_minutes', k.power,
    'week_power_dial_pct', coalesce(
      (select c.power_dial_pct from public.week_commitments c where c.org_id = p_org and c.user_id = p_user and c.week_start = p_week),
      case when k.active > 0 then round(100.0 * k.power / k.active, 1) else 0 end),
    'week_dials', k.dials,
    'week_conversations', k.convs,
    'week_adherence_pct', case when k.sched > 0 then round(100.0 * k.active / k.sched)::int else 0 end,
    'week_missed_shifts', (select count(*) from public.shifts s
                           where s.org_id = p_org and s.user_id = p_user and s.week_start = p_week and s.status = 'missed')
  )
  from k;
$$;

-- last_shift_* fields. p_status is passed in ('completed' | 'missed') because the event is queued
-- around the same transaction that flips shifts.status.
create function private.shift_last_fields(p_org uuid, p_shift public.shifts, p_status text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  k public.shift_kpis;
begin
  select * into k from public.shift_kpis where shift_id = p_shift.id;
  return jsonb_build_object(
    'last_shift_date', to_char(p_shift.starts_at at time zone private.shift_tz(p_org), 'YYYY-MM-DD'),
    'last_shift_status', p_status,
    'last_shift_active_minutes', coalesce(k.active_dial_minutes, 0),
    'last_shift_power_active_minutes', coalesce(k.power_active_minutes, 0),
    'last_shift_adherence_pct', coalesce(k.adherence_pct, 0),
    'last_shift_dials', coalesce(k.dials, 0),
    'last_shift_connects', coalesce(k.connects, 0),
    'last_shift_conversations', coalesce(k.conversations, 0),
    'last_shift_talk_minutes', coalesce(k.talk_minutes, 0),
    'last_shift_longest_idle_minutes', coalesce(k.longest_idle_minutes, 0),
    'last_shift_late_start_minutes', coalesce(k.late_start_minutes, 0),
    'last_shift_flags', coalesce(array_to_string(k.flags, ', '), '')
  );
end;
$$;

-- The shift-finalized note (spec "Shift-finalized note body"), one fact group per line.
create function private.shift_kpi_note(p_org uuid, p_shift public.shifts)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text := private.shift_tz(p_org);
  k public.shift_kpis;
  v_disp text;
begin
  select * into k from public.shift_kpis where shift_id = p_shift.id;
  if k.shift_id is null then
    return 'Shift ' || private.shift_line(p_shift, v_tz) || E'\nNo KPI data (not a dialing shift, or no calls).';
  end if;
  select string_agg(d.key || ' ' || d.value, ', ' order by d.key) into v_disp
  from jsonb_each_text(k.dispositions) d;
  return 'Shift ' || to_char(p_shift.starts_at at time zone v_tz, 'Dy Mon FMDD') || ', '
    || private.shift_time_range_text(p_shift.starts_at, p_shift.ends_at, v_tz)
    || ' (' || replace(p_shift.activity, '_', ' ') || ')'
    || E'\nActive dialing: ' || k.active_dial_minutes || ' of ' || k.scheduled_minutes || ' min (' || k.adherence_pct || '%)'
    || E'\nDials ' || k.dials || ' | Connects ' || k.connects || ' | Conversations ' || k.conversations
    || ' | Talk ' || k.talk_minutes || ' min'
    || E'\nFirst dial ' || coalesce(to_char(k.first_dial_at at time zone v_tz, 'FMHH12:MI AM'), '-')
    || ' | Last call ended ' || coalesce(to_char(k.last_call_end_at at time zone v_tz, 'FMHH12:MI AM'), '-')
    || ' | Longest idle ' || k.longest_idle_minutes || ' min'
    || E'\nDispositions: ' || coalesce(v_disp, 'none')
    || E'\nFlags: ' || coalesce(nullif(array_to_string(k.flags, ', '), ''), 'none');
end;
$$;

-- =================================================================================================
-- 3. The outbox enqueue core
-- =================================================================================================

create function private.shift_outbox_add(
  p_org uuid, p_user uuid, p_kind text, p_event text, p_shift uuid, p_payload jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.shift_ghl_outbox (org_id, user_id, kind, event, shift_id, payload)
  values (p_org, p_user, p_kind, p_event, p_shift, coalesce(p_payload, '{}'::jsonb));
$$;

-- The ONE place an event-map row becomes ordered outbox rows (outbox ids are the send order):
--   appointment -> contact_fields -> contact_note -> tags remove -> tags add.
-- Events (p_event): week_submitted, not_submitted, under_minimum, request_created, request_approved,
-- request_denied, request_withdrawn, admin_edit, shift_completed, shift_missed, off_shift_dialing,
-- power_week, week_closed.
-- p_extra keys: week_start (date) | request_id (uuid) | appointment ('upsert'|'cancel'|'status')
--   (+ appointment_status 'showed'|'noshow') | change (text, admin_edit) | actor_id (uuid, admin_edit)
--   | at (timestamptz, off_shift_dialing) | hours, minimum (under_minimum)
--   | dial_minutes, power_pct (power_week).
-- shift_completed / shift_missed always queue the appointment status row for p_shift. An org with
-- shifts disabled gets nothing. A missing GHL connection still enqueues (the sync marks the rows).
create function private.enqueue_shift_event(
  p_org uuid,
  p_user uuid,
  p_event text,
  p_shift uuid default null,
  p_extra jsonb default '{}'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_label text;
  v_week date;
  v_shift public.shifts;
  v_req public.shift_change_requests;
  v_c public.week_commitments;
  v_fields jsonb := '{}'::jsonb;
  v_note text;
  v_tags text[] := '{}';
  v_appt text;
  v_pending int;
  v_name text;
  v_actor text;
  v_hours numeric;
  v_min numeric;
begin
  if not coalesce((select s.enabled from public.shift_settings s where s.org_id = p_org), false) then
    return;
  end if;
  v_tz := private.shift_tz(p_org);
  v_name := private.shift_member_name(p_user, false);
  v_appt := p_extra ->> 'appointment';

  if p_shift is not null then
    select * into v_shift from public.shifts where id = p_shift;
  end if;
  if p_extra ? 'request_id' then
    select * into v_req from public.shift_change_requests where id = (p_extra ->> 'request_id')::uuid;
  end if;
  v_week := coalesce((p_extra ->> 'week_start')::date, v_shift.week_start, v_req.week_start);
  select * into v_c from public.week_commitments where org_id = p_org and user_id = p_user and week_start = v_week;
  select count(*) into v_pending from public.shift_change_requests
  where org_id = p_org and user_id = p_user and status = 'pending';

  if p_event like 'request\_%' and v_req.id is null then
    raise exception 'event % needs a valid request_id in p_extra', p_event;
  end if;
  if p_event in ('shift_completed', 'shift_missed') and v_shift.id is null then
    raise exception 'event % needs a valid p_shift', p_event;
  end if;

  if p_event = 'week_submitted' then
    v_label := 'Week submitted';
    v_fields := private.shift_week_fields(p_org, p_user, v_week) || private.shift_next_shift_field(p_org, p_user)
      || jsonb_build_object('shift_week_submitted', 'Yes', 'hyper_dialer_user_id', p_user::text);
    select 'Week of ' || to_char(v_week, 'Mon FMDD') || ': '
      || to_char(coalesce(sum(s.hours), 0), 'FM990.0#') || ' hrs total, '
      || to_char(coalesce(sum(s.power_minutes), 0) / 60.0, 'FM990.0#') || ' hrs in power windows'
      || coalesce(E'\n' || string_agg(private.shift_line(s, v_tz), E'\n' order by s.starts_at), '')
    into v_note
    from public.shifts s
    where s.org_id = p_org and s.user_id = p_user and s.week_start = v_week and s.status in ('scheduled', 'completed', 'missed');
    v_tags := array['shift-evt-submitted'];

  elsif p_event = 'not_submitted' then
    v_label := 'Not submitted';
    v_fields := jsonb_build_object('shift_week_submitted', 'No');
    v_note := 'No shifts submitted for the week of ' || to_char(v_week, 'Mon FMDD') || ' by the deadline.';
    v_tags := array['shift-evt-not-submitted'];

  elsif p_event = 'under_minimum' then
    v_label := 'Under minimum';
    v_hours := coalesce((p_extra ->> 'hours')::numeric, v_c.scheduled_hours, 0);
    v_min := coalesce((p_extra ->> 'minimum')::numeric, v_c.min_hours_override,
                      (select s.min_weekly_hours from public.shift_settings s where s.org_id = p_org));
    v_fields := private.shift_week_fields(p_org, p_user, v_week);
    v_note := 'Week of ' || to_char(v_week, 'Mon FMDD') || ': ' || to_char(v_hours, 'FM990.0#')
      || ' hrs scheduled, minimum is ' || to_char(v_min, 'FM990.0#') || ' hrs.';
    v_tags := array['shift-evt-under-minimum'];

  elsif p_event = 'request_created' then
    v_label := 'Request created';
    v_fields := jsonb_build_object(
      'shift_requests_pending', v_pending,
      'shift_last_request_type', v_req.type,
      'shift_last_request_reason', v_req.reason,
      'shift_last_request_note', coalesce(v_req.reviewer_note, ''),
      'shift_last_request_status', v_req.status,
      'shift_last_request_late', case when v_req.is_late then 'Yes' else 'No' end);
    v_note := private.shift_request_desc(v_req, v_tz) || E'\nReason: ' || v_req.reason
      || case when v_req.is_late then E'\nLate (under the notice window).' else '' end;
    v_tags := array['shift-evt-request-created'];
    if v_req.is_late then v_tags := array_append(v_tags, 'shift-evt-request-late'); end if;

  elsif p_event in ('request_approved', 'request_denied') then
    v_label := case p_event when 'request_approved' then 'Request approved' else 'Request denied' end;
    v_fields := jsonb_build_object(
        'shift_requests_pending', v_pending,
        'shift_last_request_type', v_req.type,
        'shift_last_request_reason', v_req.reason,
        'shift_last_request_status', v_req.status,
        'shift_last_request_note', coalesce(v_req.reviewer_note, ''),
        'shift_last_request_late', case when v_req.is_late then 'Yes' else 'No' end)
      || private.shift_week_fields(p_org, p_user, v_week) || private.shift_next_shift_field(p_org, p_user);
    v_actor := case when v_req.reviewer_id is null then 'a manager' else private.shift_member_name(v_req.reviewer_id, true) end;
    v_note := (case p_event when 'request_approved' then 'Approved' else 'Denied' end) || ' by ' || v_actor || ': '
      || private.shift_request_desc(v_req, v_tz)
      || coalesce(E'\nNote: ' || nullif(v_req.reviewer_note, ''), '');
    v_tags := array[case p_event when 'request_approved' then 'shift-evt-request-approved' else 'shift-evt-request-denied' end];

  elsif p_event = 'request_withdrawn' then
    v_label := 'Request withdrawn';
    v_fields := jsonb_build_object('shift_last_request_status', v_req.status, 'shift_requests_pending', v_pending);
    v_note := 'Request withdrawn: ' || private.shift_request_desc(v_req, v_tz);
    v_tags := array['shift-evt-request-withdrawn'];

  elsif p_event = 'admin_edit' then
    v_label := 'Admin edit';
    v_fields := private.shift_week_fields(p_org, p_user, v_week) || private.shift_next_shift_field(p_org, p_user);
    v_actor := case when p_extra ->> 'actor_id' is null then 'a manager'
                    else private.shift_member_name((p_extra ->> 'actor_id')::uuid, true) end;
    v_note := 'Edited by ' || v_actor || ': ' || coalesce(p_extra ->> 'change', 'shift changed');
    v_tags := array['shift-evt-admin-edit'];

  elsif p_event = 'shift_completed' then
    v_label := 'Shift completed';
    v_appt := 'status';
    p_extra := p_extra || jsonb_build_object('appointment_status', 'showed');
    v_fields := private.shift_last_fields(p_org, v_shift, 'completed') || private.shift_week_rollup(p_org, p_user, v_week)
      || private.shift_next_shift_field(p_org, p_user);
    v_note := private.shift_kpi_note(p_org, v_shift);
    v_tags := array['shift-evt-completed'];
    if exists (select 1 from public.shift_kpis k where k.shift_id = v_shift.id and cardinality(k.flags) > 0) then
      v_tags := array_append(v_tags, 'shift-evt-flagged');
    end if;

  elsif p_event = 'shift_missed' then
    v_label := 'Shift missed';
    v_appt := 'status';
    p_extra := p_extra || jsonb_build_object('appointment_status', 'noshow');
    v_fields := private.shift_last_fields(p_org, v_shift, 'missed') || private.shift_week_rollup(p_org, p_user, v_week)
      || jsonb_build_object('shifts_missed_total',
           (select count(*) from public.shifts s where s.org_id = p_org and s.status = 'missed')
           + case when v_shift.status = 'missed' then 0 else 1 end)
      || private.shift_next_shift_field(p_org, p_user);
    v_note := 'Shift ' || private.shift_line(v_shift, v_tz) || ' missed (no dials).';
    v_tags := array['shift-evt-missed'];

  elsif p_event = 'off_shift_dialing' then
    v_label := 'Off-shift dialing';
    v_note := 'Dialing outside a scheduled shift, started at '
      || to_char(coalesce((p_extra ->> 'at')::timestamptz, now()) at time zone v_tz, 'Dy Mon FMDD, FMHH12:MI AM') || '.';
    v_tags := array['shift-evt-off-shift-dialing'];

  elsif p_event = 'power_week' then
    v_label := 'Power week';
    v_note := private.shift_power_week_sentence(
      v_name,
      coalesce((p_extra ->> 'dial_minutes')::numeric, (private.shift_week_rollup(p_org, p_user, v_week) ->> 'week_dial_minutes')::numeric, 0),
      coalesce((p_extra ->> 'power_pct')::numeric, v_c.power_dial_pct, 0));
    v_fields := jsonb_build_object(
      'week_power_week', 'Yes',
      'week_power_dial_pct', coalesce((p_extra ->> 'power_pct')::numeric, v_c.power_dial_pct, 0),
      'week_power_summary', v_note,
      'power_weeks_total', (select count(*) from public.week_commitments c where c.org_id = p_org and c.power_week));
    v_tags := array['shift-evt-power-week'];

  elsif p_event = 'week_closed' then
    v_label := 'Week closed';
    -- Final week_* for the week that just ended, then roll: this-week fields describe the week that
    -- just started, next-week fields the one after (computed from truth, not blanket-reset).
    v_fields := private.shift_week_rollup(p_org, p_user, v_week)
      || jsonb_build_object('week_power_week', case when coalesce(v_c.power_week, false) then 'Yes' else 'No' end)
      || private.shift_week_fields(p_org, p_user, v_week + 7)
      || private.shift_week_fields(p_org, p_user, v_week + 14)
      || private.shift_next_shift_field(p_org, p_user);
    v_note := 'Week of ' || to_char(v_week, 'Mon FMDD') || ' closed: '
      || to_char(coalesce((private.shift_week_rollup(p_org, p_user, v_week) ->> 'week_dial_minutes')::numeric, 0) / 60.0, 'FM990.0#')
      || ' hrs dialing, ' || coalesce(private.shift_week_rollup(p_org, p_user, v_week) ->> 'week_dials', '0') || ' dials, '
      || coalesce(private.shift_week_rollup(p_org, p_user, v_week) ->> 'week_conversations', '0') || ' conversations'
      || case when coalesce(v_c.power_week, false) then ' (Power week)' else '' end || '.';
    v_tags := array['shift-evt-week-closed'];

  else
    raise exception 'unknown shift event %', p_event;
  end if;

  -- 1. appointment
  if p_shift is not null and v_appt in ('upsert', 'cancel', 'status') then
    perform private.shift_outbox_add(p_org, p_user, 'appointment_' || v_appt, v_label, p_shift,
      case when v_appt = 'status' then jsonb_build_object('status', p_extra ->> 'appointment_status') else '{}'::jsonb end);
  end if;
  -- 2. fields
  if v_fields <> '{}'::jsonb then
    perform private.shift_outbox_add(p_org, p_user, 'contact_fields', v_label, p_shift, jsonb_build_object('fields', v_fields));
  end if;
  -- 3. note
  if v_note is not null then
    perform private.shift_outbox_add(p_org, p_user, 'contact_note', v_label, p_shift, jsonb_build_object('body', v_note));
  end if;
  -- 4/5. tags: remove then add (GHL's Tag Added trigger only fires for a tag that is new)
  if cardinality(v_tags) > 0 then
    perform private.shift_outbox_add(p_org, p_user, 'contact_tags_remove', v_label, p_shift, jsonb_build_object('tags', to_jsonb(v_tags)));
    perform private.shift_outbox_add(p_org, p_user, 'contact_tags_add', v_label, p_shift, jsonb_build_object('tags', to_jsonb(v_tags)));
  end if;
end;
$$;

-- =================================================================================================
-- 4. submit_week
-- =================================================================================================

create function public.submit_week(p_org uuid, p_user uuid, p_week_start date, p_blocks jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_set public.shift_settings;
  v_tz text;
  v_min numeric;
  v_el jsonb;
  v_idx int;
  v_d date;
  v_s time;
  v_e time;
  v_a text;
  v_reason text;
  v_oh public.open_hours;
  -- validated blocks
  a_idx int[] := '{}'; a_d date[] := '{}'; a_s time[] := '{}'; a_e time[] := '{}'; a_a text[] := '{}';
  -- merged blocks
  m_d date[] := '{}'; m_s time[] := '{}'; m_e time[] := '{}'; m_a text[] := '{}';
  m_start timestamptz[] := '{}'; m_end timestamptz[] := '{}';
  v_r record;
  v_have boolean := false;
  c_d date; c_s time; c_e time; c_a text;
  v_i int;
  v_pick_min numeric := 0;
  v_other_min numeric;
  v_hours numeric;
  v_old public.shifts;
  v_new_id uuid;
begin
  perform private.ensure_shift_config(p_org);
  select * into v_set from public.shift_settings where org_id = p_org;
  if not v_set.enabled then
    perform private.shift_err('shifts_disabled');
  end if;
  v_tz := v_set.timezone;
  if not exists (select 1 from public.org_members m where m.org_id = p_org and m.user_id = p_user and m.status = 'active') then
    perform private.shift_err('forbidden');
  end if;
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    perform private.shift_err('bad_week');
  end if;
  if now() > private.shift_week_deadline(p_org, p_week_start) then
    perform private.shift_err('deadline_passed',
      jsonb_build_object('deadline', private.shift_week_deadline(p_org, p_week_start)));
  end if;
  if jsonb_typeof(p_blocks) is distinct from 'array' then
    perform private.shift_err('bad_block', jsonb_build_object('index', 0, 'reason', 'bad_format'));
  end if;

  -- One submit per (org, user, week) at a time.
  perform pg_advisory_xact_lock(hashtextextended('shift_week:' || p_org::text || ':' || p_user::text || ':' || p_week_start::text, 0));

  -- ---- validate every block ----------------------------------------------------------------------
  for v_el, v_idx in
    select e.value, (e.ordinality - 1)::int
    from jsonb_array_elements(p_blocks) with ordinality as e(value, ordinality)
  loop
    v_reason := null;
    v_d := null; v_s := null; v_e := null;
    begin
      v_d := (v_el ->> 'date')::date;
      v_s := (v_el ->> 'start')::time;
      v_e := (v_el ->> 'end')::time;
      v_a := coalesce(v_el ->> 'activity', 'dialing');
    exception when others then
      v_reason := 'bad_format';
    end;
    if v_reason is null and (v_d is null or v_s is null or v_e is null) then
      v_reason := 'bad_format';
    end if;
    if v_reason is null and (v_d < p_week_start or v_d > p_week_start + 6) then
      v_reason := 'outside_week';
    end if;
    if v_reason is null and (
      extract(minute from v_s) not in (0, 30) or extract(second from v_s) <> 0
      or extract(minute from v_e) not in (0, 30) or extract(second from v_e) <> 0
    ) then
      v_reason := 'bad_time_step';
    end if;
    if v_reason is null and v_e <= v_s then
      v_reason := 'end_before_start';
    end if;
    if v_reason is null and v_a not in ('dialing', 'follow_up', 'social') then
      v_reason := 'bad_activity';
    end if;
    if v_reason is null then
      select * into v_oh from public.open_hours
      where org_id = p_org and iso_weekday = extract(isodow from v_d)::smallint;
      if not found or v_s < v_oh.open_from or v_e > v_oh.open_until then
        v_reason := 'outside_open_hours';
      end if;
    end if;
    if v_reason is not null then
      perform private.shift_err('bad_block', jsonb_build_object('index', v_idx, 'reason', v_reason));
    end if;
    a_idx := a_idx || v_idx; a_d := a_d || v_d; a_s := a_s || v_s; a_e := a_e || v_e; a_a := a_a || v_a;
  end loop;

  -- ---- sort + merge (touching/overlapping, same activity) ----------------------------------------
  for v_r in
    select t.idx, t.d, t.s, t.e, t.act
    from unnest(a_idx, a_d, a_s, a_e, a_a) as t(idx, d, s, e, act)
    order by t.d, t.s, t.e, t.idx
  loop
    if v_have and v_r.d = c_d and v_r.s <= c_e then
      if v_r.act = c_a then
        c_e := greatest(c_e, v_r.e);
      elsif v_r.s < c_e then
        perform private.shift_err('overlap', jsonb_build_object('index', v_r.idx));
      else
        -- touching blocks with different activities stay separate shifts
        m_d := m_d || c_d; m_s := m_s || c_s; m_e := m_e || c_e; m_a := m_a || c_a;
        c_d := v_r.d; c_s := v_r.s; c_e := v_r.e; c_a := v_r.act;
      end if;
    else
      if v_have then
        m_d := m_d || c_d; m_s := m_s || c_s; m_e := m_e || c_e; m_a := m_a || c_a;
      end if;
      c_d := v_r.d; c_s := v_r.s; c_e := v_r.e; c_a := v_r.act; v_have := true;
    end if;
  end loop;
  if v_have then
    m_d := m_d || c_d; m_s := m_s || c_s; m_e := m_e || c_e; m_a := m_a || c_a;
  end if;

  -- ---- per-date local -> UTC conversion (the DST-correct step) -------------------------------------
  for v_i in 1 .. coalesce(cardinality(m_d), 0) loop
    m_start := m_start || ((m_d[v_i] + m_s[v_i])::timestamp at time zone v_tz);
    m_end := m_end || ((m_d[v_i] + m_e[v_i])::timestamp at time zone v_tz);
    v_pick_min := v_pick_min + extract(epoch from (m_end[v_i] - m_start[v_i])) / 60;
  end loop;

  -- ---- weekly minimum (picks + the user's other scheduled shifts that week) -------------------------
  select coalesce(sum(s.hours), 0) * 60 into v_other_min
  from public.shifts s
  where s.org_id = p_org and s.user_id = p_user and s.week_start = p_week_start
    and s.status in ('scheduled', 'completed', 'missed') and s.source <> 'pick';
  v_hours := (v_pick_min + v_other_min) / 60.0;
  v_min := coalesce(
    (select c.min_hours_override from public.week_commitments c
     where c.org_id = p_org and c.user_id = p_user and c.week_start = p_week_start),
    v_set.min_weekly_hours);
  if v_hours < v_min then
    perform private.shift_err('under_minimum', jsonb_build_object('hours', round(v_hours, 2), 'minimum', v_min));
  end if;

  -- ---- diff against existing picks -------------------------------------------------------------------
  for v_old in
    select * from public.shifts
    where org_id = p_org and user_id = p_user and week_start = p_week_start
      and source = 'pick' and status = 'scheduled'
    for update
  loop
    if not exists (
      select 1 from unnest(m_start, m_end, m_a) as n(s, e, a)
      where n.s = v_old.starts_at and n.e = v_old.ends_at and n.a = v_old.activity
    ) then
      update public.shifts set status = 'cancelled', ghl_sync_status = 'pending', updated_at = now() where id = v_old.id;
      perform private.shift_outbox_add(p_org, p_user, 'appointment_cancel', 'Week submitted', v_old.id, '{}'::jsonb);
    end if;
  end loop;

  for v_i in 1 .. coalesce(cardinality(m_d), 0) loop
    if exists (
      select 1 from public.shifts s
      where s.org_id = p_org and s.user_id = p_user and s.week_start = p_week_start
        and s.source = 'pick' and s.status = 'scheduled'
        and s.starts_at = m_start[v_i] and s.ends_at = m_end[v_i] and s.activity = m_a[v_i]
    ) then
      continue;
    end if;
    begin
      insert into public.shifts (org_id, user_id, week_start, activity, starts_at, ends_at, power_minutes, source)
      values (p_org, p_user, p_week_start, m_a[v_i], m_start[v_i], m_end[v_i],
              private.shift_power_minutes(p_org, m_start[v_i], m_end[v_i]), 'pick')
      returning id into v_new_id;
    exception when exclusion_violation then
      perform private.shift_err('overlap', jsonb_build_object('reason', 'conflicts_with_existing_shift'));
    end;
    perform private.shift_outbox_add(p_org, p_user, 'appointment_upsert', 'Week submitted', v_new_id, '{}'::jsonb);
  end loop;

  -- ---- commitment + the Week submitted event --------------------------------------------------------
  perform private.recompute_week_hours(p_org, p_user, p_week_start);
  update public.week_commitments set submitted_at = now()
  where org_id = p_org and user_id = p_user and week_start = p_week_start;

  perform private.enqueue_shift_event(p_org, p_user, 'week_submitted', null,
    jsonb_build_object('week_start', p_week_start));

  return jsonb_build_object(
    'shifts', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.starts_at) from public.shifts s
      where s.org_id = p_org and s.user_id = p_user and s.week_start = p_week_start and s.status = 'scheduled'
    ), '[]'::jsonb),
    'commitment', (
      select to_jsonb(c) from public.week_commitments c
      where c.org_id = p_org and c.user_id = p_user and c.week_start = p_week_start
    )
  );
end;
$$;

-- =================================================================================================
-- 5. RLS + grants
-- =================================================================================================

alter table public.shift_settings enable row level security;
alter table public.open_hours enable row level security;
alter table public.power_windows enable row level security;
alter table public.shift_members enable row level security;
alter table public.week_commitments enable row level security;
alter table public.shifts enable row level security;
alter table public.shift_change_requests enable row level security;
alter table public.shift_kpis enable row level security;
alter table public.shift_ghl_outbox enable row level security;

-- Config tables: any active org member can read.
create policy "org members read shift settings" on public.shift_settings for select
  using (private.has_org_role(org_id, array['owner', 'admin', 'manager', 'agent']));
create policy "org members read open hours" on public.open_hours for select
  using (private.has_org_role(org_id, array['owner', 'admin', 'manager', 'agent']));
create policy "org members read power windows" on public.power_windows for select
  using (private.has_org_role(org_id, array['owner', 'admin', 'manager', 'agent']));

-- Per-person tables: own rows, or manager-level within pod scope.
create policy "own or managed shift members" on public.shift_members for select
  using (private.shift_can_see(org_id, user_id));
create policy "own or managed week commitments" on public.week_commitments for select
  using (private.shift_can_see(org_id, user_id));
create policy "own or managed shifts" on public.shifts for select
  using (private.shift_can_see(org_id, user_id));
create policy "own or managed shift requests" on public.shift_change_requests for select
  using (private.shift_can_see(org_id, user_id));
create policy "own or managed shift kpis" on public.shift_kpis for select
  using (private.shift_can_see(org_id, user_id));
-- shift_ghl_outbox: no policies at all (service role only).

-- No client write privilege anywhere (belt and braces on top of "no write policies").
revoke all on public.shift_settings, public.open_hours, public.power_windows, public.shift_members,
  public.week_commitments, public.shifts, public.shift_change_requests, public.shift_kpis,
  public.shift_ghl_outbox from anon, authenticated;
grant select on public.shift_settings, public.open_hours, public.power_windows, public.shift_members,
  public.week_commitments, public.shifts, public.shift_change_requests, public.shift_kpis to authenticated;
revoke all on sequence public.shift_ghl_outbox_id_seq from anon, authenticated;

-- Policy helpers must be callable by the role evaluating the policy.
grant execute on function private.shift_can_see(uuid, uuid) to authenticated;
grant execute on function private.shift_is_manager(uuid) to authenticated;

-- Everything else in private is internal: callable only from the SECURITY DEFINER RPCs (owner) or
-- service_role. Lock down every function this migration created.
revoke all on function
  private.shift_err(text, jsonb),
  private.shift_participates(uuid, uuid),
  private.shift_tz(uuid),
  private.shift_member_name(uuid, boolean),
  private.ensure_shift_config(uuid),
  private.shift_week_deadline(uuid, date),
  private.shift_power_minutes(uuid, timestamptz, timestamptz),
  private.recompute_week_hours(uuid, uuid, date),
  private.shift_time_range_text(timestamptz, timestamptz, text),
  private.shift_line(public.shifts, text),
  private.shift_power_week_sentence(text, numeric, numeric),
  private.shift_request_desc(public.shift_change_requests, text),
  private.shift_week_fields(uuid, uuid, date),
  private.shift_next_shift_field(uuid, uuid),
  private.shift_week_rollup(uuid, uuid, date),
  private.shift_last_fields(uuid, public.shifts, text),
  private.shift_kpi_note(uuid, public.shifts),
  private.shift_outbox_add(uuid, uuid, text, text, uuid, jsonb),
  private.enqueue_shift_event(uuid, uuid, text, uuid, jsonb)
from public, anon, authenticated;
grant execute on function
  private.shift_err(text, jsonb),
  private.shift_participates(uuid, uuid),
  private.shift_tz(uuid),
  private.shift_member_name(uuid, boolean),
  private.ensure_shift_config(uuid),
  private.shift_week_deadline(uuid, date),
  private.shift_power_minutes(uuid, timestamptz, timestamptz),
  private.recompute_week_hours(uuid, uuid, date),
  private.shift_time_range_text(timestamptz, timestamptz, text),
  private.shift_line(public.shifts, text),
  private.shift_power_week_sentence(text, numeric, numeric),
  private.shift_request_desc(public.shift_change_requests, text),
  private.shift_week_fields(uuid, uuid, date),
  private.shift_next_shift_field(uuid, uuid),
  private.shift_week_rollup(uuid, uuid, date),
  private.shift_last_fields(uuid, public.shifts, text),
  private.shift_kpi_note(uuid, public.shifts),
  private.shift_outbox_add(uuid, uuid, text, text, uuid, jsonb),
  private.enqueue_shift_event(uuid, uuid, text, uuid, jsonb)
to service_role;

revoke all on function public.submit_week(uuid, uuid, date, jsonb) from public, anon, authenticated;
grant execute on function public.submit_week(uuid, uuid, date, jsonb) to service_role;

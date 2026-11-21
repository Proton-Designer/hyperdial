-- TASK-S03 (Shifts admin backend). Builds on 20261006114226_shifts_schema.sql and 20261006120116_shifts_intern_rpcs.sql.
--
-- Public, SECURITY DEFINER, service_role-only functions (edge functions can only rpc() public.*), each
-- taking the CALLER as an explicit argument (the edge function passes the verified user id) and
-- enforcing the role + pod-scope rule itself, so a non-manager is refused even if one of these were
-- reached some other way:
--   * shift_admin_members(org, actor)             members the actor may see (+ email, pod, GHL contact id)
--   * review_shift_request(...)                   approve / deny, one transaction (spec "Request approval logic")
--   * admin_update_shift(...)                     create / move / cancel / excuse (source 'admin')
--   * admin_upsert_power_window(...)              + recompute power_minutes for weeks that have not started
--   * admin_replace_open_hours(org, actor, rows)  full replace
--   * admin_update_shift_settings(org, actor, patch jsonb)   whitelisted keys; `enabled` owner/admin only
--   * admin_upsert_shift_member(...)              shift_members (GHL contact id / participates)
--   * admin_retry_shift_outbox(org, actor, id)    error rows -> pending (also pending rows that carry last_error)
-- Errors use the shifts protocol (errcode P0001, message = code, detail = json). Codes raised here:
--   forbidden, shifts_disabled, not_found, not_pending, under_minimum_needs_ack {hoursAfter, minimum},
--   overlap {reason:'conflicts_with_existing_shift'}, bad_time_step, outside_open_hours, bad_request {reason}.
-- Contract notes: a move that SHORTENS the shift is held to the same minimum-hours acknowledgement as a drop
-- (the spec names only drop); the ack is required only when the change lowers the intern's hours below the
-- week's effective minimum, so a neutral move for someone already under it is never blocked.

-- ---- guards -------------------------------------------------------------------------------------------

-- The actor's role in the org when it is manager-level (owner/admin/manager), else forbidden.
create function private.shift_admin_guard(p_org uuid, p_actor uuid, p_owner_admin_only boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select m.role into v_role from public.org_members m
  where m.org_id = p_org and m.user_id = p_actor and m.status = 'active';
  if v_role is null
     or v_role not in ('owner', 'admin', 'manager')
     or (p_owner_admin_only and v_role not in ('owner', 'admin')) then
    perform private.shift_err('forbidden');
  end if;
  return v_role;
end;
$$;

-- owner/admin: every member; manager: members of the pods they manage.
create function private.shift_actor_sees(p_org uuid, p_actor uuid, p_user uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.org_members a
    where a.org_id = p_org and a.user_id = p_actor and a.status = 'active'
      and (
        a.role in ('owner', 'admin')
        or (a.role = 'manager' and exists (
          select 1 from public.org_manager_pods mp
          join public.org_members t on t.org_id = mp.org_id and t.pod_id = mp.pod_id
          where mp.org_id = p_org and mp.manager_user_id = p_actor and t.user_id = p_user and t.status = 'active'))
      )
  );
$$;

create function private.shift_require_enabled(p_org uuid)
returns public.shift_settings
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set public.shift_settings;
begin
  perform private.ensure_shift_config(p_org);
  select * into v_set from public.shift_settings where org_id = p_org;
  if not coalesce(v_set.enabled, false) then
    perform private.shift_err('shifts_disabled');
  end if;
  return v_set;
end;
$$;

-- Local date + HH:MM(:SS) -> UTC instants, validating the 30-minute marks and the open hours.
create function private.shift_admin_times(p_org uuid, p_date date, p_start time, p_end time, out v_start timestamptz, out v_end timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_tz text := private.shift_tz(p_org);
  v_oh public.open_hours;
begin
  if p_date is null or p_start is null or p_end is null then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'missing_time'));
  end if;
  if extract(minute from p_start) not in (0, 30) or extract(second from p_start) <> 0
     or extract(minute from p_end) not in (0, 30) or extract(second from p_end) <> 0
     or p_end <= p_start then
    perform private.shift_err('bad_time_step');
  end if;
  select * into v_oh from public.open_hours
  where org_id = p_org and iso_weekday = extract(isodow from p_date)::smallint;
  if not found or p_start < v_oh.open_from or p_end > v_oh.open_until then
    perform private.shift_err('outside_open_hours');
  end if;
  v_start := (p_date + p_start)::timestamp at time zone v_tz;
  v_end := (p_date + p_end)::timestamp at time zone v_tz;
end;
$$;

-- Recompute shifts.power_minutes for scheduled shifts in weeks that have not started, then the affected
-- weekly commitment totals.
create function private.shift_recompute_power(p_org uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_today date := (now() at time zone private.shift_tz(p_org))::date;
  v_monday date := v_today - (extract(isodow from v_today)::int - 1);
  r record;
  v_n integer := 0;
begin
  for r in
    with upd as (
      update public.shifts s
      set power_minutes = private.shift_power_minutes(s.org_id, s.starts_at, s.ends_at)
      where s.org_id = p_org and s.status = 'scheduled' and s.week_start > v_monday
        and s.power_minutes is distinct from private.shift_power_minutes(s.org_id, s.starts_at, s.ends_at)
      returning s.user_id, s.week_start
    )
    select distinct user_id, week_start from upd
  loop
    perform private.recompute_week_hours(p_org, r.user_id, r.week_start);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---- members ------------------------------------------------------------------------------------------

create function public.shift_admin_members(p_org uuid, p_actor uuid)
returns table (
  user_id uuid, name text, email text, role text, participates boolean,
  ghl_contact_id text, pod_id uuid, pod_name text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  perform private.shift_admin_guard(p_org, p_actor);
  return query
  select m.user_id, private.shift_member_name(m.user_id, true), u.email::text, m.role::text,
    coalesce(sm.participates, m.role = 'agent'), sm.ghl_contact_id, m.pod_id, p.name::text
  from public.org_members m
  join auth.users u on u.id = m.user_id
  left join public.shift_members sm on sm.org_id = m.org_id and sm.user_id = m.user_id
  left join public.org_pods p on p.id = m.pod_id
  where m.org_id = p_org and m.status = 'active'
    and (m.user_id = p_actor or private.shift_actor_sees(p_org, p_actor, m.user_id))
  order by 2;
end;
$$;

-- ---- request review -----------------------------------------------------------------------------------

create function public.review_shift_request(
  p_org uuid,
  p_reviewer uuid,
  p_request uuid,
  p_decision text,
  p_note text default null,
  p_allow_under_min boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set public.shift_settings;
  v_req public.shift_change_requests;
  v_shift public.shifts;
  v_c public.week_commitments;
  v_tz text := private.shift_tz(p_org);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_counted numeric;
  v_after numeric;
  v_min numeric;
  v_new_hours numeric;
  v_appt text := null;
  v_event_shift uuid := null;
  v_ack boolean := false;
begin
  perform private.shift_admin_guard(p_org, p_reviewer);
  v_set := private.shift_require_enabled(p_org);
  if p_decision not in ('approve', 'deny') then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_decision'));
  end if;

  select * into v_req from public.shift_change_requests where id = p_request and org_id = p_org for update;
  if v_req.id is null then
    perform private.shift_err('not_found');
  end if;
  if not private.shift_actor_sees(p_org, p_reviewer, v_req.user_id) then
    perform private.shift_err('forbidden');
  end if;
  if v_req.status <> 'pending' then
    perform private.shift_err('not_pending');
  end if;

  if p_decision = 'approve' then
    select * into v_c from public.week_commitments
    where org_id = p_org and user_id = v_req.user_id and week_start = v_req.week_start;
    v_min := coalesce(v_c.min_hours_override, v_set.min_weekly_hours);
    select coalesce(sum(s.hours), 0) into v_counted from public.shifts s
    where s.org_id = p_org and s.user_id = v_req.user_id and s.week_start = v_req.week_start
      and s.status in ('scheduled', 'completed', 'missed');

    if v_req.type in ('move', 'drop') then
      select * into v_shift from public.shifts where id = v_req.from_shift_id and org_id = p_org for update;
      if v_shift.id is null or v_shift.status <> 'scheduled' then
        perform private.shift_err('bad_request', jsonb_build_object('reason', 'shift_not_scheduled'));
      end if;
      v_new_hours := case when v_req.type = 'move'
        then round((extract(epoch from (v_req.to_ends_at - v_req.to_starts_at)) / 3600)::numeric, 2) else 0 end;
      v_after := v_counted - v_shift.hours + v_new_hours;
      if v_after < v_min and v_after < v_counted then
        if not coalesce(p_allow_under_min, false) then
          perform private.shift_err('under_minimum_needs_ack',
            jsonb_build_object('hoursAfter', v_after, 'minimum', v_min));
        end if;
        v_ack := true;
      end if;
    end if;

    begin
      if v_req.type = 'move' then
        update public.shifts
        set starts_at = v_req.to_starts_at, ends_at = v_req.to_ends_at,
            activity = coalesce(v_req.to_activity, activity),
            power_minutes = private.shift_power_minutes(p_org, v_req.to_starts_at, v_req.to_ends_at),
            ghl_sync_status = 'pending', updated_at = now()
        where id = v_shift.id;
        v_appt := 'upsert'; v_event_shift := v_shift.id;
      elsif v_req.type = 'drop' then
        update public.shifts set status = 'excused', ghl_sync_status = 'pending', updated_at = now() where id = v_shift.id;
        v_appt := 'cancel'; v_event_shift := v_shift.id;
      elsif v_req.type = 'add' then
        insert into public.shifts (org_id, user_id, week_start, activity, starts_at, ends_at, power_minutes, source)
        values (p_org, v_req.user_id, v_req.week_start, coalesce(v_req.to_activity, 'dialing'),
          v_req.to_starts_at, v_req.to_ends_at,
          private.shift_power_minutes(p_org, v_req.to_starts_at, v_req.to_ends_at), 'request')
        returning id into v_event_shift;
        v_appt := 'upsert';
      else
        insert into public.week_commitments (org_id, user_id, week_start, light_week, min_hours_override)
        values (p_org, v_req.user_id, v_req.week_start, true, v_req.requested_min_hours)
        on conflict (org_id, user_id, week_start)
        do update set light_week = true, min_hours_override = excluded.min_hours_override;
      end if;
    exception when exclusion_violation then
      perform private.shift_err('overlap', jsonb_build_object('reason', 'conflicts_with_existing_shift'));
    end;

    if v_ack then
      insert into public.week_commitments (org_id, user_id, week_start, min_hours_override)
      values (p_org, v_req.user_id, v_req.week_start, v_after)
      on conflict (org_id, user_id, week_start) do update set min_hours_override = excluded.min_hours_override;
    end if;
  end if;

  update public.shift_change_requests
  set status = case when p_decision = 'approve' then 'approved' else 'denied' end,
      reviewer_id = p_reviewer, reviewer_note = v_note, reviewed_at = now()
  where id = v_req.id
  returning * into v_req;

  perform private.recompute_week_hours(p_org, v_req.user_id, v_req.week_start);

  -- Best effort: the decision itself must never fail on a notification.
  begin
    insert into public.notifications (org_id, user_id, type, title, body, data)
    values (p_org, v_req.user_id, 'shift_request_reviewed',
      'Your shift request was ' || v_req.status,
      private.shift_request_desc(v_req, v_tz) || coalesce(E'\nNote: ' || v_note, ''),
      jsonb_build_object('request_id', v_req.id, 'status', v_req.status));
  exception when others then
    null;
  end;

  perform private.enqueue_shift_event(p_org, v_req.user_id,
    case when p_decision = 'approve' then 'request_approved' else 'request_denied' end,
    v_event_shift,
    jsonb_build_object('request_id', v_req.id) || case when v_appt is null then '{}'::jsonb else jsonb_build_object('appointment', v_appt) end);

  return to_jsonb(v_req);
end;
$$;

-- ---- direct shift edits -------------------------------------------------------------------------------

create function public.admin_update_shift(
  p_org uuid,
  p_actor uuid,
  p_action text,
  p_shift uuid default null,
  p_user uuid default null,
  p_date date default null,
  p_start time default null,
  p_end time default null,
  p_activity text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tz text;
  v_shift public.shifts;
  v_old_week date;
  v_start timestamptz;
  v_end timestamptz;
  v_activity text;
  v_user uuid;
  v_change text;
  v_appt text;
  v_t record;
begin
  perform private.shift_admin_guard(p_org, p_actor);
  perform private.shift_require_enabled(p_org);
  v_tz := private.shift_tz(p_org);
  if p_action not in ('create', 'move', 'cancel', 'excuse') then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_action'));
  end if;
  if p_activity is not null and p_activity not in ('dialing', 'follow_up', 'social') then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_activity'));
  end if;

  if p_action = 'create' then
    if p_user is null then
      perform private.shift_err('bad_request', jsonb_build_object('reason', 'missing_user'));
    end if;
    if not exists (
      select 1 from public.org_members m
      left join public.shift_members sm on sm.org_id = m.org_id and sm.user_id = m.user_id
      where m.org_id = p_org and m.user_id = p_user and m.status = 'active'
        and coalesce(sm.participates, m.role = 'agent')
    ) then
      perform private.shift_err('bad_request', jsonb_build_object('reason', 'not_participating'));
    end if;
    if not private.shift_actor_sees(p_org, p_actor, p_user) then
      perform private.shift_err('forbidden');
    end if;
    select * into v_t from private.shift_admin_times(p_org, p_date, p_start, p_end);
    v_user := p_user;
    begin
      insert into public.shifts (org_id, user_id, week_start, activity, starts_at, ends_at, power_minutes, source)
      values (p_org, v_user, p_date - (extract(isodow from p_date)::int - 1), coalesce(p_activity, 'dialing'),
        v_t.v_start, v_t.v_end, private.shift_power_minutes(p_org, v_t.v_start, v_t.v_end), 'admin')
      returning * into v_shift;
    exception when exclusion_violation then
      perform private.shift_err('overlap', jsonb_build_object('reason', 'conflicts_with_existing_shift'));
    end;
    v_change := 'added ' || private.shift_line(v_shift, v_tz);
    v_appt := 'upsert';
  else
    if p_shift is null then
      perform private.shift_err('bad_request', jsonb_build_object('reason', 'missing_shift'));
    end if;
    select * into v_shift from public.shifts where id = p_shift and org_id = p_org for update;
    if v_shift.id is null then
      perform private.shift_err('not_found');
    end if;
    if not private.shift_actor_sees(p_org, p_actor, v_shift.user_id) then
      perform private.shift_err('forbidden');
    end if;
    v_user := v_shift.user_id;
    v_old_week := v_shift.week_start;

    if p_action = 'move' then
      if v_shift.status <> 'scheduled' then
        perform private.shift_err('bad_request', jsonb_build_object('reason', 'shift_not_scheduled'));
      end if;
      select * into v_t from private.shift_admin_times(
        p_org,
        coalesce(p_date, (v_shift.starts_at at time zone v_tz)::date),
        coalesce(p_start, (v_shift.starts_at at time zone v_tz)::time),
        coalesce(p_end, (v_shift.ends_at at time zone v_tz)::time));
      v_change := 'moved ' || private.shift_line(v_shift, v_tz) || ' to ';
      begin
        update public.shifts
        set starts_at = v_t.v_start, ends_at = v_t.v_end,
            week_start = (v_t.v_start at time zone v_tz)::date - (extract(isodow from (v_t.v_start at time zone v_tz)::date)::int - 1),
            activity = coalesce(p_activity, activity),
            power_minutes = private.shift_power_minutes(p_org, v_t.v_start, v_t.v_end),
            ghl_sync_status = 'pending', updated_at = now()
        where id = v_shift.id
        returning * into v_shift;
      exception when exclusion_violation then
        perform private.shift_err('overlap', jsonb_build_object('reason', 'conflicts_with_existing_shift'));
      end;
      v_change := v_change || private.shift_line(v_shift, v_tz);
      v_appt := 'upsert';
    elsif p_action = 'cancel' then
      if v_shift.status <> 'scheduled' then
        perform private.shift_err('bad_request', jsonb_build_object('reason', 'shift_not_scheduled'));
      end if;
      update public.shifts set status = 'cancelled', ghl_sync_status = 'pending', updated_at = now()
      where id = v_shift.id returning * into v_shift;
      v_change := 'cancelled ' || private.shift_line(v_shift, v_tz);
      v_appt := 'cancel';
    else
      if v_shift.status not in ('scheduled', 'missed') then
        perform private.shift_err('bad_request', jsonb_build_object('reason', 'shift_not_scheduled'));
      end if;
      v_appt := case when v_shift.status = 'scheduled' then 'cancel' else null end;
      update public.shifts
      set status = 'excused', ghl_sync_status = case when v_appt is null then ghl_sync_status else 'pending' end, updated_at = now()
      where id = v_shift.id returning * into v_shift;
      v_change := 'marked excused ' || private.shift_line(v_shift, v_tz);
    end if;
  end if;

  perform private.recompute_week_hours(p_org, v_user, v_shift.week_start);
  if v_old_week is not null and v_old_week <> v_shift.week_start then
    perform private.recompute_week_hours(p_org, v_user, v_old_week);
  end if;
  perform private.enqueue_shift_event(p_org, v_user, 'admin_edit', v_shift.id,
    jsonb_build_object('change', v_change, 'actor_id', p_actor)
      || case when v_appt is null then '{}'::jsonb else jsonb_build_object('appointment', v_appt) end);
  return to_jsonb(v_shift);
end;
$$;

-- ---- setup: power windows, open hours, settings, members ---------------------------------------------

create function public.admin_upsert_power_window(
  p_org uuid,
  p_actor uuid,
  p_id uuid,
  p_label text,
  p_days integer[],
  p_start time,
  p_end time,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.power_windows;
  v_label text := btrim(coalesce(p_label, ''));
begin
  perform private.shift_admin_guard(p_org, p_actor);
  perform private.ensure_shift_config(p_org);
  if v_label = '' or char_length(v_label) > 60 then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_label'));
  end if;
  if p_days is null or cardinality(p_days) = 0 or exists (select 1 from unnest(p_days) d where d not between 1 and 7) then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_weekdays'));
  end if;
  if p_start is null or p_end is null or p_end <= p_start then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_time'));
  end if;
  if p_id is null then
    insert into public.power_windows (org_id, label, iso_weekdays, start_time, end_time, active)
    values (p_org, v_label, (select array_agg(distinct d::smallint order by d::smallint) from unnest(p_days) d),
      p_start, p_end, coalesce(p_active, true))
    returning * into v_row;
  else
    update public.power_windows
    set label = v_label, iso_weekdays = (select array_agg(distinct d::smallint order by d::smallint) from unnest(p_days) d),
        start_time = p_start, end_time = p_end, active = coalesce(p_active, true)
    where id = p_id and org_id = p_org
    returning * into v_row;
    if v_row.id is null then
      perform private.shift_err('not_found');
    end if;
  end if;
  perform private.shift_recompute_power(p_org);
  return to_jsonb(v_row);
end;
$$;

create function public.admin_replace_open_hours(p_org uuid, p_actor uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_day int;
  v_from time;
  v_until time;
  v_seen int[] := '{}';
begin
  perform private.shift_admin_guard(p_org, p_actor);
  perform private.ensure_shift_config(p_org);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_rows'));
  end if;
  begin
    for r in select * from jsonb_array_elements(p_rows) loop
      v_day := (r ->> 'isoWeekday')::int;
      v_from := (r ->> 'openFrom')::time;
      v_until := (r ->> 'openUntil')::time;
      if v_day is null or v_day not between 1 and 7 or v_day = any(v_seen)
         or v_from is null or v_until is null or v_until <= v_from
         or extract(minute from v_from) not in (0, 30) or extract(minute from v_until) not in (0, 30) then
        perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_rows'));
      end if;
      v_seen := array_append(v_seen, v_day);
    end loop;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_rows'));
  end;
  delete from public.open_hours where org_id = p_org;
  insert into public.open_hours (org_id, iso_weekday, open_from, open_until)
  select p_org, (e ->> 'isoWeekday')::smallint, (e ->> 'openFrom')::time, (e ->> 'openUntil')::time
  from jsonb_array_elements(p_rows) e;
  return coalesce((select jsonb_agg(to_jsonb(o) order by o.iso_weekday) from public.open_hours o where o.org_id = p_org), '[]'::jsonb);
end;
$$;

create function public.admin_update_shift_settings(p_org uuid, p_actor uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.shift_settings;
  v_tz text;
begin
  perform private.shift_admin_guard(p_org, p_actor);
  perform private.ensure_shift_config(p_org);
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_patch'));
  end if;
  if p_patch ? 'enabled' then
    perform private.shift_admin_guard(p_org, p_actor, true);
  end if;
  if p_patch ? 'timezone' then
    v_tz := p_patch ->> 'timezone';
    if v_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names n where n.name = v_tz) then
      perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_timezone'));
    end if;
  end if;
  begin
    update public.shift_settings s set
      enabled = case when p_patch ? 'enabled' then (p_patch ->> 'enabled')::boolean else s.enabled end,
      timezone = case when p_patch ? 'timezone' then v_tz else s.timezone end,
      min_weekly_hours = case when p_patch ? 'minWeeklyHours' then (p_patch ->> 'minWeeklyHours')::numeric else s.min_weekly_hours end,
      lock_weekday = case when p_patch ? 'lockWeekday' then (p_patch ->> 'lockWeekday')::smallint else s.lock_weekday end,
      lock_time = case when p_patch ? 'lockTime' then (p_patch ->> 'lockTime')::time else s.lock_time end,
      change_notice_hours = case when p_patch ? 'changeNoticeHours' then (p_patch ->> 'changeNoticeHours')::smallint else s.change_notice_hours end,
      grace_minutes = case when p_patch ? 'graceMinutes' then (p_patch ->> 'graceMinutes')::smallint else s.grace_minutes end,
      conversation_min_seconds = case when p_patch ? 'conversationMinSeconds' then (p_patch ->> 'conversationMinSeconds')::smallint else s.conversation_min_seconds end,
      idle_flag_minutes = case when p_patch ? 'idleFlagMinutes' then (p_patch ->> 'idleFlagMinutes')::smallint else s.idle_flag_minutes end,
      adherence_flag_pct = case when p_patch ? 'adherenceFlagPct' then (p_patch ->> 'adherenceFlagPct')::smallint else s.adherence_flag_pct end,
      open_session_tail_minutes = case when p_patch ? 'openSessionTailMinutes' then (p_patch ->> 'openSessionTailMinutes')::smallint else s.open_session_tail_minutes end,
      power_coverage_alert = case when p_patch ? 'powerCoverageAlert' then (p_patch ->> 'powerCoverageAlert')::smallint else s.power_coverage_alert end,
      power_week_pct = case when p_patch ? 'powerWeekPct' then (p_patch ->> 'powerWeekPct')::smallint else s.power_week_pct end,
      ghl_calendar_id = case when p_patch ? 'ghlCalendarId' then nullif(btrim(p_patch ->> 'ghlCalendarId'), '') else s.ghl_calendar_id end,
      ghl_owner_user_id = case when p_patch ? 'ghlOwnerUserId' then nullif(btrim(p_patch ->> 'ghlOwnerUserId'), '') else s.ghl_owner_user_id end,
      updated_at = now()
    where s.org_id = p_org
    returning * into v_row;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow
                or numeric_value_out_of_range or check_violation or not_null_violation then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_setting'));
  end;
  return to_jsonb(v_row);
end;
$$;

create function public.admin_upsert_shift_member(
  p_org uuid,
  p_actor uuid,
  p_user uuid,
  p_set_contact boolean,
  p_contact text,
  p_set_participates boolean,
  p_participates boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_contact text := nullif(btrim(coalesce(p_contact, '')), '');
  v_row jsonb;
begin
  perform private.shift_admin_guard(p_org, p_actor);
  select m.role into v_role from public.org_members m
  where m.org_id = p_org and m.user_id = p_user and m.status = 'active';
  if v_role is null then
    perform private.shift_err('not_found');
  end if;
  if not private.shift_actor_sees(p_org, p_actor, p_user) then
    perform private.shift_err('forbidden');
  end if;
  begin
    insert into public.shift_members (org_id, user_id, ghl_contact_id, participates)
    values (p_org, p_user,
      case when coalesce(p_set_contact, false) then v_contact else null end,
      case when coalesce(p_set_participates, false) then coalesce(p_participates, v_role = 'agent') else v_role = 'agent' end)
    on conflict (org_id, user_id) do update set
      ghl_contact_id = case when coalesce(p_set_contact, false) then v_contact else public.shift_members.ghl_contact_id end,
      participates = case when coalesce(p_set_participates, false) then coalesce(p_participates, public.shift_members.participates)
                          else public.shift_members.participates end,
      updated_at = now();
  exception when unique_violation then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'ghl_contact_in_use'));
  end;
  select to_jsonb(x) into v_row from public.shift_admin_members(p_org, p_actor) x where x.user_id = p_user;
  return v_row;
end;
$$;

-- ---- GHL sync health ----------------------------------------------------------------------------------

-- One row, or every row of the org. Error rows -> pending; pending rows that carry last_error (an org not
-- connected to GHL yet) are made due now. Returns how many rows were reset.
create function public.admin_retry_shift_outbox(p_org uuid, p_actor uuid, p_id bigint default null)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform private.shift_admin_guard(p_org, p_actor);
  with u as (
    update public.shift_ghl_outbox o
    set status = 'pending', attempts = 0, next_attempt_at = now()
    where o.org_id = p_org
      and (p_id is null or o.id = p_id)
      and (o.status = 'error' or (o.status = 'pending' and o.last_error is not null))
      and (o.user_id is null or private.shift_actor_sees(p_org, p_actor, o.user_id))
    returning o.id, o.shift_id, o.kind
  ), s as (
    update public.shifts sh set ghl_sync_status = 'pending', ghl_sync_error = null
    from u where u.shift_id = sh.id and u.kind like 'appointment\_%'
    returning sh.id
  )
  select count(*) into v_n from u;
  return v_n;
end;
$$;

revoke all on function
  private.shift_admin_guard(uuid, uuid, boolean),
  private.shift_actor_sees(uuid, uuid, uuid),
  private.shift_require_enabled(uuid),
  private.shift_admin_times(uuid, date, time, time),
  private.shift_recompute_power(uuid),
  public.shift_admin_members(uuid, uuid),
  public.review_shift_request(uuid, uuid, uuid, text, text, boolean),
  public.admin_update_shift(uuid, uuid, text, uuid, uuid, date, time, time, text),
  public.admin_upsert_power_window(uuid, uuid, uuid, text, integer[], time, time, boolean),
  public.admin_replace_open_hours(uuid, uuid, jsonb),
  public.admin_update_shift_settings(uuid, uuid, jsonb),
  public.admin_upsert_shift_member(uuid, uuid, uuid, boolean, text, boolean, boolean),
  public.admin_retry_shift_outbox(uuid, uuid, bigint)
from public, anon, authenticated;
grant execute on function
  public.shift_admin_members(uuid, uuid),
  public.review_shift_request(uuid, uuid, uuid, text, text, boolean),
  public.admin_update_shift(uuid, uuid, text, uuid, uuid, date, time, time, text),
  public.admin_upsert_power_window(uuid, uuid, uuid, text, integer[], time, time, boolean),
  public.admin_replace_open_hours(uuid, uuid, jsonb),
  public.admin_update_shift_settings(uuid, uuid, jsonb),
  public.admin_upsert_shift_member(uuid, uuid, uuid, boolean, text, boolean, boolean),
  public.admin_retry_shift_outbox(uuid, uuid, bigint)
to service_role;

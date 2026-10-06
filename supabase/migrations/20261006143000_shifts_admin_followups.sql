-- TASK-S03F (admin backend follow-ups from eng2's S03 review, lead-decided). Replaces functions from the S03
-- (20261006130000) and S05 (20261006140000) migrations (same signatures, create or replace) and adds one helper.
--  * private.shift_close_pending_requests: a request waiting on a shift that a manager cancelled / excused / moved,
--    or that has since taken place (finalized), is closed in the same transaction: status 'denied', a reviewer note,
--    a notification and the Request denied event. Nothing dangles.
--  * review_shift_request: a manager cannot approve or deny their OWN request (forbidden, reason 'self_review');
--    owner/admin can.
--  * admin_update_shift_settings: `timezone` is owner/admin only, like `enabled`.
--  * admin_replace_open_hours: existing shifts are left alone (changes apply to future picks) and the result is now
--    { rows, affected } where `affected` = scheduled future shifts that sit outside the new hours (the UI warns).
--  * shift_kpi_save: finalizing a shift also closes any request still pending on it.

create function private.shift_close_pending_requests(p_org uuid, p_actor uuid, p_shift uuid, p_note text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.shift_change_requests;
  v_r public.shift_change_requests;
  v_tz text := private.shift_tz(p_org);
  v_n integer := 0;
begin
  for r in
    select * from public.shift_change_requests
    where org_id = p_org and from_shift_id = p_shift and status = 'pending'
    for update
  loop
    update public.shift_change_requests
    set status = 'denied', reviewer_id = p_actor, reviewer_note = p_note, reviewed_at = now()
    where id = r.id
    returning * into v_r;
    begin
      insert into public.notifications (org_id, user_id, type, title, body, data)
      values (p_org, v_r.user_id, 'shift_request_reviewed', 'Your shift request was denied',
        private.shift_request_desc(v_r, v_tz) || E'\nNote: ' || p_note,
        jsonb_build_object('request_id', v_r.id, 'status', v_r.status));
    exception when others then
      null;
    end;
    perform private.enqueue_shift_event(p_org, v_r.user_id, 'request_denied', null,
      jsonb_build_object('request_id', v_r.id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

revoke all on function private.shift_close_pending_requests(uuid, uuid, uuid, text) from public, anon, authenticated;

create or replace function public.review_shift_request(
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
  v_role text;
begin
  v_role := private.shift_admin_guard(p_org, p_reviewer);
  v_set := private.shift_require_enabled(p_org);
  if p_decision not in ('approve', 'deny') then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_decision'));
  end if;

  select * into v_req from public.shift_change_requests where id = p_request and org_id = p_org for update;
  if v_req.id is null then
    perform private.shift_err('not_found');
  end if;
  -- A manager cannot decide their own request (owner/admin can).
  if v_req.user_id = p_reviewer and v_role not in ('owner', 'admin') then
    perform private.shift_err('forbidden', jsonb_build_object('reason', 'self_review'));
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

create or replace function public.admin_update_shift(
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

  -- A request waiting on a shift a manager just changed would dangle: close it.
  if p_action in ('move', 'cancel', 'excuse') then
    perform private.shift_close_pending_requests(p_org, p_actor, v_shift.id, 'Shift was changed by a manager');
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

create or replace function public.admin_update_shift_settings(p_org uuid, p_actor uuid, p_patch jsonb)
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
  if p_patch ? 'enabled' or p_patch ? 'timezone' then
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

create or replace function public.admin_replace_open_hours(p_org uuid, p_actor uuid, p_rows jsonb)
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
  v_tz text;
  v_affected integer;
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
  -- Existing shifts are not touched (changes apply to future picks); say how many now sit outside the hours.
  v_tz := private.shift_tz(p_org);
  select count(*) into v_affected from public.shifts s
  where s.org_id = p_org and s.status = 'scheduled' and s.starts_at > now()
    and not exists (
      select 1 from public.open_hours o
      where o.org_id = s.org_id
        and o.iso_weekday = extract(isodow from (s.starts_at at time zone v_tz))::smallint
        and (s.starts_at at time zone v_tz)::time >= o.open_from
        and (s.ends_at at time zone v_tz)::time <= o.open_until);
  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(o) order by o.iso_weekday) from public.open_hours o where o.org_id = p_org), '[]'::jsonb),
    'affected', v_affected);
end;
$$;

create or replace function public.shift_kpi_save(p_shift uuid, p_kpi jsonb, p_final boolean default false)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.shifts;
  v_flags text[];
  v_status text;
begin
  select * into v from public.shifts where id = p_shift for update;
  if v.id is null or v.status <> 'scheduled' then
    return 'skipped';
  end if;

  if p_kpi is not null then
    v_flags := coalesce(array(select jsonb_array_elements_text(coalesce(p_kpi -> 'flags', '[]'::jsonb))), '{}');
    insert into public.shift_kpis (
      shift_id, org_id, user_id, computed_at, final, scheduled_minutes, active_dial_minutes, power_active_minutes,
      adherence_pct, first_dial_at, last_call_end_at, late_start_minutes, early_end_minutes, longest_idle_minutes,
      dials, connects, conversations, voicemails, no_answers, talk_minutes, dials_per_active_hour,
      connect_rate_pct, dispositions, flags)
    values (
      v.id, v.org_id, v.user_id, now(), coalesce(p_final, false),
      (p_kpi ->> 'scheduled_minutes')::integer, (p_kpi ->> 'active_dial_minutes')::integer,
      (p_kpi ->> 'power_active_minutes')::integer, (p_kpi ->> 'adherence_pct')::integer,
      (p_kpi ->> 'first_dial_at')::timestamptz, (p_kpi ->> 'last_call_end_at')::timestamptz,
      (p_kpi ->> 'late_start_minutes')::integer, (p_kpi ->> 'early_end_minutes')::integer,
      (p_kpi ->> 'longest_idle_minutes')::integer, (p_kpi ->> 'dials')::integer, (p_kpi ->> 'connects')::integer,
      (p_kpi ->> 'conversations')::integer, (p_kpi ->> 'voicemails')::integer, (p_kpi ->> 'no_answers')::integer,
      (p_kpi ->> 'talk_minutes')::integer, (p_kpi ->> 'dials_per_active_hour')::numeric,
      (p_kpi ->> 'connect_rate_pct')::numeric, coalesce(p_kpi -> 'dispositions', '{}'::jsonb), v_flags)
    on conflict (shift_id) do update set
      computed_at = now(), final = excluded.final, scheduled_minutes = excluded.scheduled_minutes,
      active_dial_minutes = excluded.active_dial_minutes, power_active_minutes = excluded.power_active_minutes,
      adherence_pct = excluded.adherence_pct, first_dial_at = excluded.first_dial_at,
      last_call_end_at = excluded.last_call_end_at, late_start_minutes = excluded.late_start_minutes,
      early_end_minutes = excluded.early_end_minutes, longest_idle_minutes = excluded.longest_idle_minutes,
      dials = excluded.dials, connects = excluded.connects, conversations = excluded.conversations,
      voicemails = excluded.voicemails, no_answers = excluded.no_answers, talk_minutes = excluded.talk_minutes,
      dials_per_active_hour = excluded.dials_per_active_hour, connect_rate_pct = excluded.connect_rate_pct,
      dispositions = excluded.dispositions, flags = excluded.flags;
  end if;

  if not coalesce(p_final, false) then
    return 'saved';
  end if;

  v_status := case when 'no_show' = any(coalesce(v_flags, '{}')) then 'missed' else 'completed' end;
  update public.shifts set status = v_status, updated_at = now() where id = v.id;
  perform private.shift_close_pending_requests(v.org_id, null, v.id, 'The shift has already taken place');
  perform private.recompute_week_hours(v.org_id, v.user_id, v.week_start);
  perform private.enqueue_shift_event(v.org_id, v.user_id,
    case when v_status = 'missed' then 'shift_missed' else 'shift_completed' end, v.id, '{}'::jsonb);
  return v_status;
end;
$$;

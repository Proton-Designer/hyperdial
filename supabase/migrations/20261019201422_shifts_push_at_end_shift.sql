-- TASK-G10: push to the intern contact when the intern presses End shift (spec section 2: "push when the intern ends the shift").
-- Before: the GHL push waited for the KPI finalize job (more than 2 h after ends_at). Now clock_shift('end') also queues a
-- `shift_ended` event: contact_fields only (clock-in/out, late minutes, survey answers, last_shift_* counts as of the last KPI
-- pass, week rollup + sign-up totals, next shift). No appointment row, no note, no tags: the final shift_completed /
-- shift_missed at finalize is unchanged and stays the only place the completed / flagged / late-start tags and the note fire.
-- The enqueue is wrapped in its own exception block: End shift never fails or waits because of GHL.
-- Replaces public.clock_shift (20261006173000) and private.enqueue_shift_event (20261019201136; new shift_ended branch only).
-- Same signatures, grants kept (create or replace).

create or replace function public.clock_shift(
  p_org uuid,
  p_user uuid,
  p_shift uuid,
  p_action text,
  p_survey jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.shifts;
  sv public.shift_surveys;
  v_now timestamptz := now();
  v_obj text; v_obj_note text; v_worked text; v_slow text; v_slow_note text; v_quality integer;
begin
  perform private.shift_require_enabled(p_org);
  select * into v from public.shifts where id = p_shift and org_id = p_org and user_id = p_user for update;
  if v.id is null then
    perform private.shift_err('not_found');
  end if;
  if v.status <> 'scheduled' then
    perform private.shift_err('shift_not_scheduled');
  end if;

  if p_action = 'start' then
    if v.clocked_in_at is null then
      if v_now < v.starts_at - interval '15 minutes' then
        perform private.shift_err('too_early', jsonb_build_object('opensAt', v.starts_at - interval '15 minutes'));
      end if;
      if v_now >= v.ends_at then
        perform private.shift_err('shift_over');
      end if;
      update public.shifts set clocked_in_at = v_now, updated_at = v_now where id = v.id returning * into v;
      update public.shift_kpis set clocked_in_at = v.clocked_in_at,
        clock_in_late_minutes = greatest(0, floor(extract(epoch from (v.clocked_in_at - v.starts_at)) / 60))::integer
      where shift_id = v.id;
    end if; -- already clocked in: idempotent, the existing clock-in comes back

  elsif p_action = 'end' then
    if v.clocked_in_at is null then
      perform private.shift_err('not_clocked_in');
    end if;
    if v.clocked_out_at is not null then
      perform private.shift_err('already_ended');
    end if;
    if v.activity = 'dialing' then
      if p_survey is null or jsonb_typeof(p_survey) <> 'object' then
        perform private.shift_err('survey_required');
      end if;
      v_obj := p_survey ->> 'topObjection';
      if v_obj is null or v_obj not in ('too_busy', 'enough_work', 'fees', 'dont_trust_apps', 'not_interested_app_jobs', 'other') then
        perform private.shift_err('bad_survey', jsonb_build_object('field', 'topObjection'));
      end if;
      v_obj_note := btrim(coalesce(p_survey ->> 'objectionNote', ''));
      if char_length(v_obj_note) < 3 or char_length(v_obj_note) > 500 then
        perform private.shift_err('bad_survey', jsonb_build_object('field', 'objectionNote'));
      end if;
      v_worked := btrim(coalesce(p_survey ->> 'whatWorked', ''));
      if char_length(v_worked) < 3 or char_length(v_worked) > 500 then
        perform private.shift_err('bad_survey', jsonb_build_object('field', 'whatWorked'));
      end if;
      v_slow := p_survey ->> 'slowedBy';
      if v_slow is null or v_slow not in ('bad_numbers', 'dialer_issue', 'didnt_know_answer', 'script_off', 'nothing') then
        perform private.shift_err('bad_survey', jsonb_build_object('field', 'slowedBy'));
      end if;
      v_slow_note := nullif(btrim(coalesce(p_survey ->> 'slowedNote', '')), '');
      if v_slow = 'nothing' then
        v_slow_note := null;
      elsif v_slow_note is null or char_length(v_slow_note) < 3 or char_length(v_slow_note) > 500 then
        perform private.shift_err('bad_survey', jsonb_build_object('field', 'slowedNote'));
      end if;
      if jsonb_typeof(p_survey -> 'listQuality') is distinct from 'number'
         or (p_survey ->> 'listQuality')::numeric not between 1 and 5
         or (p_survey ->> 'listQuality')::numeric <> floor((p_survey ->> 'listQuality')::numeric) then
        perform private.shift_err('bad_survey', jsonb_build_object('field', 'listQuality'));
      end if;
      v_quality := (p_survey ->> 'listQuality')::integer;
      insert into public.shift_surveys (shift_id, org_id, user_id, top_objection, objection_note, what_worked,
                                        slowed_by, slowed_note, list_quality, submitted_at)
      values (v.id, v.org_id, v.user_id, v_obj, v_obj_note, v_worked, v_slow, v_slow_note, v_quality, v_now);
    end if;
    update public.shifts set clocked_out_at = v_now, updated_at = v_now where id = v.id returning * into v;
    update public.shift_kpis set clocked_out_at = v.clocked_out_at where shift_id = v.id;
    -- TASK-G10: queue the quick GHL push (clock times, survey, counts so far). Enqueue only (no network), and guarded:
    -- End shift must never fail because of GHL; a failure here rolls back only this sub-block and is logged.
    begin
      perform private.enqueue_shift_event(v.org_id, v.user_id, 'shift_ended', v.id, '{}'::jsonb);
    exception when others then
      raise warning 'clock_shift: shift_ended enqueue failed for shift %: %', v.id, sqlerrm;
    end;

  else
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_action'));
  end if;

  select * into sv from public.shift_surveys where shift_id = v.id;
  return jsonb_build_object('shift', to_jsonb(v), 'survey', case when sv.shift_id is null then null else to_jsonb(sv) end);
end;
$$;

create or replace function private.enqueue_shift_event(
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
  if p_event in ('shift_completed', 'shift_missed', 'shift_ended') and v_shift.id is null then
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

  elsif p_event = 'shift_ended' then
    -- TASK-G10: queued at clock-out (End shift). Fields only: no appointment status, no note, no tags (those stay with the
    -- final shift_completed / shift_missed at finalize, so the completed / flagged / late-start tags fire once). The shift is
    -- still 'scheduled' here, so last_shift_status is left out (its GHL options are completed / missed). Counts are the
    -- shift_kpis row as of the last 15-minute KPI pass; the finalize push overwrites them with the exact numbers.
    v_label := 'Shift ended';
    v_fields := (private.shift_last_fields(p_org, v_shift, 'completed') - 'last_shift_status')
      || private.shift_week_rollup(p_org, p_user, v_week) || private.shift_week_sign_totals(p_org, p_user, v_week)
      || private.shift_next_shift_field(p_org, p_user);

  elsif p_event = 'shift_completed' then
    v_label := 'Shift completed';
    v_appt := 'status';
    p_extra := p_extra || jsonb_build_object('appointment_status', 'showed');
    v_fields := private.shift_last_fields(p_org, v_shift, 'completed') || private.shift_week_rollup(p_org, p_user, v_week)
      || private.shift_week_sign_totals(p_org, p_user, v_week)
      || private.shift_next_shift_field(p_org, p_user);
    v_note := private.shift_kpi_note(p_org, v_shift);
    v_tags := array['shift-evt-completed'];
    if exists (select 1 from public.shift_kpis k where k.shift_id = v_shift.id and cardinality(k.flags) > 0) then
      v_tags := array_append(v_tags, 'shift-evt-flagged');
    end if;
    -- TASK-G07: its own tag so a GHL workflow can follow up on a late start without parsing last_shift_flags
    if exists (select 1 from public.shift_kpis k where k.shift_id = v_shift.id
               and (k.flags && array['late_start', 'late_clock_in']::text[])) then
      v_tags := array_append(v_tags, 'shift-evt-late-start');
    end if;

  elsif p_event = 'shift_missed' then
    v_label := 'Shift missed';
    v_appt := 'status';
    p_extra := p_extra || jsonb_build_object('appointment_status', 'noshow');
    v_fields := private.shift_last_fields(p_org, v_shift, 'missed') || private.shift_week_rollup(p_org, p_user, v_week)
      || private.shift_week_sign_totals(p_org, p_user, v_week)
      || jsonb_build_object('shifts_missed_total',
           (select count(*) from public.shifts s where s.org_id = p_org and s.user_id = p_user and s.status = 'missed')
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
      'power_weeks_total', (select count(*) from public.week_commitments c where c.org_id = p_org and c.user_id = p_user and c.power_week));
    v_tags := array['shift-evt-power-week'];

  elsif p_event = 'week_closed' then
    v_label := 'Week closed';
    -- Call this only AFTER the Monday boundary (S05's week-close job): this-week/next-week buckets are
    -- computed from now(). Final week_* for the week that just ended, then roll: this-week fields describe the week that
    -- just started, next-week fields the one after (computed from truth, not blanket-reset).
    v_fields := private.shift_week_rollup(p_org, p_user, v_week)
      || jsonb_build_object('week_power_week', case when coalesce(v_c.power_week, false) then 'Yes' else 'No' end)
      -- TASK-G09: ACTUAL dialing hours of the week vs the week's effective minimum (override, else the org minimum).
      -- week_hours_vs_min = actual - minimum (negative = short); week_under_minimum Yes when actual < minimum.
      || jsonb_build_object(
           'week_hours_vs_min', round(coalesce((private.shift_week_rollup(p_org, p_user, v_week) ->> 'week_dial_minutes')::numeric, 0) / 60.0
             - coalesce(v_c.min_hours_override, (select st.min_weekly_hours from public.shift_settings st where st.org_id = p_org), 0), 2),
           'week_under_minimum', case when coalesce((private.shift_week_rollup(p_org, p_user, v_week) ->> 'week_dial_minutes')::numeric, 0) / 60.0
             < coalesce(v_c.min_hours_override, (select st.min_weekly_hours from public.shift_settings st where st.org_id = p_org), 0)
             then 'Yes' else 'No' end)
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

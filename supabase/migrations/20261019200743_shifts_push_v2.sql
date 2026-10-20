-- TASK-G07: shift push v2 (ghl-data-sync spec section 2/3). Intern-contact fields added to the shift_completed /
-- shift_missed push, all through SECURITY DEFINER SQL (service_role has no USAGE on schema private):
--  * last_shift_sign_ups, last_shift_connect_rate_pct, last_shift_conversion_rate_pct (from shift_kpis, TASK-G01)
--  * last_shift_clock_in_at / last_shift_clock_out_at (ISO 8601 with the org-zone offset), last_shift_clock_in_late_minutes
--  * the end-of-shift survey (only when the shift has one): last_shift_top_objection, last_shift_objection_note,
--    last_shift_what_worked, last_shift_slowed_by, last_shift_slowed_note, last_shift_list_quality. The note keeps the survey too.
--  * week_sign_ups, week_connects (private.shift_week_sign_totals) on shift_completed and shift_missed
--  * tag shift-evt-late-start on shift_completed when the KPI flags contain late_start or late_clock_in
-- None of these GHL custom fields exist yet: shift-ghl.ts now SKIPS keys that have no definition (reports them) instead of
-- failing the whole contact_fields row. Replaces private.shift_last_fields (20261006114226) and private.enqueue_shift_event
-- (20261006114226; only the shift_completed / shift_missed branches changed). Same signatures, grants kept.

-- "2026-10-13T14:00:00-05:00": wall time in the org zone with that instant's own UTC offset (same shape as offsetIso in shift-ghl.ts).
create function private.shift_iso_local(p_ts timestamptz, p_tz text)
returns text
language sql
stable
set search_path = ''
as $$
  select case when p_ts is null then null else
    to_char(p_ts at time zone p_tz, 'YYYY-MM-DD"T"HH24:MI:SS')
    || (select case when o < interval '0' then '-' else '+' end
          || to_char(abs(extract(epoch from o))::int / 3600, 'FM00') || ':'
          || to_char((abs(extract(epoch from o))::int % 3600) / 60, 'FM00')
        from (select (p_ts at time zone p_tz) - (p_ts at time zone 'UTC') as o) x)
  end;
$$;

revoke all on function private.shift_iso_local(timestamptz, text) from public, anon, authenticated;
grant execute on function private.shift_iso_local(timestamptz, text) to service_role;

create or replace function private.shift_last_fields(p_org uuid, p_shift public.shifts, p_status text)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  k public.shift_kpis;
  sv public.shift_surveys;
  v_tz text := private.shift_tz(p_org);
  v_out jsonb;
begin
  select * into k from public.shift_kpis where shift_id = p_shift.id;
  select * into sv from public.shift_surveys where shift_id = p_shift.id;
  v_out := jsonb_build_object(
    'last_shift_date', to_char(p_shift.starts_at at time zone v_tz, 'YYYY-MM-DD'),
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
    'last_shift_flags', coalesce(array_to_string(k.flags, ', '), ''),
    -- TASK-G07. A null value clears the GHL field (shift-ghl.ts buildCustomFields sends "").
    'last_shift_sign_ups', coalesce(k.sign_ups, 0),
    'last_shift_connect_rate_pct', k.connect_rate_pct,
    'last_shift_conversion_rate_pct', k.conversion_rate_pct,
    'last_shift_clock_in_at', private.shift_iso_local(p_shift.clocked_in_at, v_tz),
    'last_shift_clock_out_at', private.shift_iso_local(p_shift.clocked_out_at, v_tz),
    'last_shift_clock_in_late_minutes', case when p_shift.clocked_in_at is null then null
      else greatest(0, floor(extract(epoch from (p_shift.clocked_in_at - p_shift.starts_at)) / 60))::integer end
  );
  if sv.shift_id is not null then
    v_out := v_out || jsonb_build_object(
      'last_shift_top_objection', case sv.top_objection
        when 'too_busy' then 'Too busy'
        when 'enough_work' then 'Has enough work'
        when 'fees' then 'Fees'
        when 'dont_trust_apps' then 'Does not trust apps'
        when 'not_interested_app_jobs' then 'Not interested in app jobs'
        else 'Other' end,
      'last_shift_objection_note', sv.objection_note,
      'last_shift_what_worked', sv.what_worked,
      'last_shift_slowed_by', case sv.slowed_by
        when 'bad_numbers' then 'Bad numbers'
        when 'dialer_issue' then 'Dialer issue'
        when 'didnt_know_answer' then 'Did not know the answer'
        when 'script_off' then 'Script felt off'
        else 'Nothing' end,
      'last_shift_slowed_note', coalesce(sv.slowed_note, ''),
      'last_shift_list_quality', sv.list_quality);
  end if;
  return v_out;
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

-- TASK-G24 (spec section 2, "Shift start / end -- scheduled vs actual"; G22 PARTIAL 2.2): the per-shift push already carried
-- the ACTUAL clock-in/out times; now it also carries the shift's SCHEDULED start and end as ISO text with offset in the org
-- time zone (same format/helper as the clock times: private.shift_iso_local, DST-safe because the offset is computed for
-- that instant). One function carries them for every event that pushes the last-shift fields (shift_ended, shift_completed,
-- shift_missed), since enqueue_shift_event builds all of them from private.shift_last_fields.
-- Replaces private.shift_last_fields (20261019200743) only: same signature, two added keys; grants kept (create or replace).
-- A GHL field that does not exist yet is skipped by shift-ghl.ts, so nothing breaks before Kareem creates them.

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
    'last_shift_scheduled_start', private.shift_iso_local(p_shift.starts_at, v_tz),
    'last_shift_scheduled_end', private.shift_iso_local(p_shift.ends_at, v_tz),
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

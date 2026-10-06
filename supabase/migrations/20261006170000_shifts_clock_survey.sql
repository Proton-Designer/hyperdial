-- TASK-C1: clock in / clock out + the end-of-shift survey (docs/design/shifts.md section 4b).
--
--  * shifts.clocked_in_at / clocked_out_at (server clock only; written ONLY by clock_shift)
--  * shift_surveys: one row per ended dialing shift. RLS = own or manager-level in pod scope (same helper as
--    shift_kpis). No client write privilege: every write goes through clock_shift.
--  * shift_kpis gains clocked_in_at, clocked_out_at, clock_in_late_minutes; shift_kpi_save adds the flags
--    late_clock_in (> grace), no_clock_in and no_clock_out (the last two only when the shift is finalized).
--    A no_show shift keeps its single flag, as before.
--  * The Shift completed / Shift missed GHL note gets the clock-in line and the survey answers in plain English
--    (no new custom fields or tags: those would need setup in GHL).
--  * clock_shift(p_org, p_user, p_shift, p_action, p_survey): service_role only, one transaction, the only writer.

alter table public.shifts
  add column clocked_in_at timestamptz,
  add column clocked_out_at timestamptz;

create table public.shift_surveys (
  shift_id uuid primary key references public.shifts(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  top_objection text not null
    check (top_objection in ('too_busy', 'enough_work', 'fees', 'dont_trust_apps', 'not_interested_app_jobs', 'other')),
  objection_note text not null check (char_length(objection_note) between 3 and 500),
  what_worked text not null check (char_length(what_worked) between 3 and 500),
  slowed_by text not null
    check (slowed_by in ('bad_numbers', 'dialer_issue', 'didnt_know_answer', 'script_off', 'nothing')),
  slowed_note text check (slowed_note is null or char_length(slowed_note) <= 500),
  list_quality smallint not null check (list_quality between 1 and 5),
  submitted_at timestamptz not null default now(),
  check (slowed_by = 'nothing' or char_length(coalesce(slowed_note, '')) >= 1)
);
create index shift_surveys_org_user on public.shift_surveys(org_id, user_id);

alter table public.shift_surveys enable row level security;
create policy "own or managed shift surveys" on public.shift_surveys for select
  using (private.shift_can_see(org_id, user_id));
revoke all on public.shift_surveys from anon, authenticated;
grant select on public.shift_surveys to authenticated;

alter table public.shift_kpis
  add column clocked_in_at timestamptz,
  add column clocked_out_at timestamptz,
  add column clock_in_late_minutes integer;

-- ---- plain-English note lines -------------------------------------------------------------------------------------------------

create function private.shift_clock_note(p_org uuid, p_shift public.shifts)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_tz text := private.shift_tz(p_org);
  v_late integer;
  sv public.shift_surveys;
  v_out text;
begin
  if p_shift.clocked_in_at is null then
    v_out := 'Clock-in: none (never started the shift)';
  else
    v_late := greatest(0, floor(extract(epoch from (p_shift.clocked_in_at - p_shift.starts_at)) / 60))::integer;
    v_out := 'Clock-in: ' || to_char(p_shift.clocked_in_at at time zone v_tz, 'FMHH12:MI AM')
      || case when v_late > 0 then ' (' || v_late || ' min late)' else ' (on time)' end
      || ' | Clock-out: '
      || coalesce(to_char(p_shift.clocked_out_at at time zone v_tz, 'FMHH12:MI AM'), 'none (never ended the shift)');
  end if;
  select * into sv from public.shift_surveys where shift_id = p_shift.id;
  if sv.shift_id is not null then
    v_out := v_out
      || E'\nTop objection: ' || case sv.top_objection
           when 'too_busy' then 'Too busy'
           when 'enough_work' then 'Has enough work'
           when 'fees' then 'Fees'
           when 'dont_trust_apps' then 'Does not trust apps'
           when 'not_interested_app_jobs' then 'Not interested in app jobs'
           else 'Other' end
        || ' - ' || sv.objection_note
      || E'\nWhat kept people on the phone: ' || sv.what_worked
      || E'\nSlowed down by: ' || case sv.slowed_by
           when 'bad_numbers' then 'Bad numbers'
           when 'dialer_issue' then 'Dialer issue'
           when 'didnt_know_answer' then 'Did not know the answer'
           when 'script_off' then 'Script felt off'
           else 'Nothing' end
        || coalesce(' - ' || sv.slowed_note, '')
      || E'\nList quality: ' || sv.list_quality || ' of 5';
  end if;
  return v_out;
end;
$$;

-- ---- clock_shift ------------------------------------------------------------------------------------------------------------------------

create function public.clock_shift(
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
      elsif v_slow_note is null or char_length(v_slow_note) > 500 then
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

  else
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_action'));
  end if;

  select * into sv from public.shift_surveys where shift_id = v.id;
  return jsonb_build_object('shift', to_jsonb(v), 'survey', case when sv.shift_id is null then null else to_jsonb(sv) end);
end;
$$;

revoke all on function public.clock_shift(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.clock_shift(uuid, uuid, uuid, text, jsonb) to service_role;

-- ---- shift_kpi_save: clock fields, clock flags and the note lines (replaces 20261006143000) ----------------------------------------

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
  v_grace integer;
  v_late integer;
  v_extra text[] := '{}';
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

    -- clock fields and clock flags (SQL is the one place that knows them); a no_show shift keeps its single flag
    v_late := case when v.clocked_in_at is null then null
                   else greatest(0, floor(extract(epoch from (v.clocked_in_at - v.starts_at)) / 60))::integer end;
    if not ('no_show' = any(v_flags)) then
      select grace_minutes into v_grace from public.shift_settings where org_id = v.org_id;
      if v_late is not null and v_late > coalesce(v_grace, 10) then
        v_extra := array_append(v_extra, 'late_clock_in');
      end if;
      if coalesce(p_final, false) then
        if v.clocked_in_at is null then
          v_extra := array_append(v_extra, 'no_clock_in');
        elsif v.clocked_out_at is null then
          v_extra := array_append(v_extra, 'no_clock_out');
        end if;
      end if;
    end if;
    update public.shift_kpis set
      clocked_in_at = v.clocked_in_at, clocked_out_at = v.clocked_out_at, clock_in_late_minutes = v_late,
      flags = flags || array(select f from unnest(v_extra) f where not (f = any(flags)))
    where shift_id = v.id;
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
  -- the clock-in line and the survey answers go at the end of the note just queued (same transaction)
  update public.shift_ghl_outbox
  set payload = jsonb_set(payload, '{body}',
    to_jsonb(coalesce(payload ->> 'body', '') || E'\n' || private.shift_clock_note(v.org_id, v)))
  where shift_id = v.id and kind = 'contact_note' and created_at = now()
    and event = case when v_status = 'missed' then 'Shift missed' else 'Shift completed' end;
  return v_status;
end;
$$;

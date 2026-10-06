-- TASK-C1 follow-up: the slowed-by note needs at least 3 characters on the server too (the UI already asks for 3).
-- Replaces clock_shift from 20261006170000 (create or replace keeps its service_role-only grant).

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

  else
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_action'));
  end if;

  select * into sv from public.shift_surveys where shift_id = v.id;
  return jsonb_build_object('shift', to_jsonb(v), 'survey', case when sv.shift_id is null then null else to_jsonb(sv) end);
end;
$$;


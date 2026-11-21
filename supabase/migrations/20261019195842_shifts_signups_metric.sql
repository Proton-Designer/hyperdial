-- TASK-G01: shift sign-ups (main outcome metric, ghl-data-sync spec section 2/3) and conversion rate.
--  * sign-up = a contact leg whose disposition is a win (dispositions.is_win); conversion rate = sign_ups / conversations
--    (null when there were no conversations). Connect rate is unchanged.
--  * shift_kpis gains sign_ups (default 0) and conversion_rate_pct (null). Existing rows keep 0 / null and are NOT
--    backfilled: they fill in the next time shift_kpi_save runs for a shift that is still 'scheduled' (finalized shifts
--    are skipped by shift_kpi_save, so their sign_ups stay 0).
--  * shift_kpi_inputs: each leg also carries is_win (replaces 20261006150000; same return shape, grants kept).
--  * shift_kpi_save: stores the two columns (replaces 20261006170000; p_kpi without the keys, e.g. an older edge
--    deploy, stores 0 / null).
--  * private.shift_week_sign_totals: week sums of sign_ups and connects. It is deliberately NOT merged into
--    private.shift_week_rollup, because that jsonb is pushed to GHL as custom fields as-is and an unknown field key
--    makes the whole contact_fields row fail permanently. The GHL push of week_sign_ups / week_connects is a later task.

alter table public.shift_kpis
  add column sign_ups integer not null default 0,
  add column conversion_rate_pct numeric(5,1);

create or replace function public.shift_kpi_inputs(p_shift uuid)
returns jsonb
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v public.shifts;
begin
  select * into v from public.shifts where id = p_shift;
  if v.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'state', e.state, 'started_at', e.started_at, 'ended_at', e.ended_at, 'session_id', e.session_id)
        order by e.started_at)
      from public.agent_state_events e
      where e.org_id = v.org_id and e.agent_id = v.user_id
        and e.started_at < v.ends_at and (e.ended_at is null or e.ended_at > v.starts_at)
    ), '[]'::jsonb),
    'legs', coalesce((
      select jsonb_agg(jsonb_build_object(
        'created_at', cl.created_at, 'ended_at', cl.ended_at, 'outcome', cl.outcome,
        'amd_result', cl.amd_result, 'duration_seconds', cl.duration_seconds, 'disposition', d.label,
        'is_win', coalesce(d.is_win, false))
        order by cl.created_at)
      from public.call_legs cl
      join public.dial_sessions ds on ds.id = cl.session_id
      left join public.dispositions d on d.id = cl.disposition_id
      where cl.org_id = v.org_id and ds.agent_id = v.user_id and cl.kind = 'contact'
        and cl.created_at >= v.starts_at and cl.created_at < v.ends_at
    ), '[]'::jsonb),
    'last_leg_end', coalesce((
      select jsonb_object_agg(x.session_id, x.t)
      from (
        select cl.session_id, max(coalesce(cl.ended_at, least(now(), cl.created_at + interval '30 minutes'))) as t
        from public.call_legs cl
        where cl.kind = 'contact'
          and cl.session_id in (
            select e.session_id from public.agent_state_events e
            where e.org_id = v.org_id and e.agent_id = v.user_id
              and e.started_at < v.ends_at and (e.ended_at is null or e.ended_at > v.starts_at))
        group by cl.session_id
      ) x
    ), '{}'::jsonb)
  );
end;
$$;

-- ---- shift_kpi_save: sign_ups + conversion_rate_pct ----

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
      connect_rate_pct, sign_ups, conversion_rate_pct, dispositions, flags)
    values (
      v.id, v.org_id, v.user_id, now(), coalesce(p_final, false),
      (p_kpi ->> 'scheduled_minutes')::integer, (p_kpi ->> 'active_dial_minutes')::integer,
      (p_kpi ->> 'power_active_minutes')::integer, (p_kpi ->> 'adherence_pct')::integer,
      (p_kpi ->> 'first_dial_at')::timestamptz, (p_kpi ->> 'last_call_end_at')::timestamptz,
      (p_kpi ->> 'late_start_minutes')::integer, (p_kpi ->> 'early_end_minutes')::integer,
      (p_kpi ->> 'longest_idle_minutes')::integer, (p_kpi ->> 'dials')::integer, (p_kpi ->> 'connects')::integer,
      (p_kpi ->> 'conversations')::integer, (p_kpi ->> 'voicemails')::integer, (p_kpi ->> 'no_answers')::integer,
      (p_kpi ->> 'talk_minutes')::integer, (p_kpi ->> 'dials_per_active_hour')::numeric,
      (p_kpi ->> 'connect_rate_pct')::numeric, coalesce((p_kpi ->> 'sign_ups')::integer, 0),
      (p_kpi ->> 'conversion_rate_pct')::numeric, coalesce(p_kpi -> 'dispositions', '{}'::jsonb), v_flags)
    on conflict (shift_id) do update set
      computed_at = now(), final = excluded.final, scheduled_minutes = excluded.scheduled_minutes,
      active_dial_minutes = excluded.active_dial_minutes, power_active_minutes = excluded.power_active_minutes,
      adherence_pct = excluded.adherence_pct, first_dial_at = excluded.first_dial_at,
      last_call_end_at = excluded.last_call_end_at, late_start_minutes = excluded.late_start_minutes,
      early_end_minutes = excluded.early_end_minutes, longest_idle_minutes = excluded.longest_idle_minutes,
      dials = excluded.dials, connects = excluded.connects, conversations = excluded.conversations,
      voicemails = excluded.voicemails, no_answers = excluded.no_answers, talk_minutes = excluded.talk_minutes,
      dials_per_active_hour = excluded.dials_per_active_hour, connect_rate_pct = excluded.connect_rate_pct,
      sign_ups = excluded.sign_ups, conversion_rate_pct = excluded.conversion_rate_pct,
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

-- ---- week totals (not pushed to GHL yet) ----

create function private.shift_week_sign_totals(p_org uuid, p_user uuid, p_week date)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'week_sign_ups', coalesce(sum(x.sign_ups), 0)::integer,
    'week_connects', coalesce(sum(x.connects), 0)::integer)
  from public.shift_kpis x
  join public.shifts s on s.id = x.shift_id
  where s.org_id = p_org and s.user_id = p_user and s.week_start = p_week;
$$;

revoke all on function private.shift_week_sign_totals(uuid, uuid, date) from public, anon, authenticated;
grant execute on function private.shift_week_sign_totals(uuid, uuid, date) to service_role;

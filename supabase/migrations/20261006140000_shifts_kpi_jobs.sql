-- TASK-S05 (Shifts KPIs, week lock/close, off-shift dialing). Builds on the S01..S04 shifts migrations.
-- The cron schedules live in the next migration (20261006140100_shifts_cron.sql) so this file can be
-- dry-run on a database without pg_cron.
--
-- Public, SECURITY DEFINER, service_role-only functions (called by the shift-kpi-compute /
-- shifts-week-lock / shifts-week-close edge functions):
--   * shift_kpi_due(limit)              scheduled shifts that need a KPI pass (dialing shifts that started,
--                                       non-dialing shifts that ended), enabled orgs only
--   * shift_kpi_inputs(shift)           the raw rows shift-kpi-core.ts needs: the agent's state events that
--                                       overlap the shift, the contact legs created inside it (with the
--                                       disposition label) and, per session, the last leg end (a leg still
--                                       in progress counts as now)
--   * shift_kpi_save(shift, kpi, final) upsert shift_kpis; when final: status completed (or missed on the
--                                       no_show flag), recompute week hours, enqueue Shift completed / Shift
--                                       missed (+ the appointment showed/noshow row). A shift that is no
--                                       longer 'scheduled' is skipped, so a manager edit always wins.
--   * shifts_week_lock_run()            once per org per week after the pick deadline: Not submitted +
--                                       Under minimum events, notification for the not-submitted interns
--   * shifts_week_close_run()           once per org per week after Monday 00:30 local: power_dial_pct,
--                                       power_week, Power week + Week closed events
-- Plus the guarded off-shift trigger on dial_sessions (D14, R-042): it can never block a session insert.

-- ---- KPI plumbing -----------------------------------------------------------------------------------------------

create function public.shift_kpi_due(p_limit integer default 200)
returns setof public.shifts
language sql
security definer
stable
set search_path = ''
as $$
  select s.*
  from public.shifts s
  join public.shift_settings st on st.org_id = s.org_id and st.enabled
  where s.status = 'scheduled'
    and ((s.activity = 'dialing' and s.starts_at <= now())
      or (s.activity <> 'dialing' and s.ends_at <= now()))
  order by s.ends_at
  limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

create function public.shift_kpi_inputs(p_shift uuid)
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
        'amd_result', cl.amd_result, 'duration_seconds', cl.duration_seconds, 'disposition', d.label)
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
        select cl.session_id, max(coalesce(cl.ended_at, now())) as t
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

create function public.shift_kpi_save(p_shift uuid, p_kpi jsonb, p_final boolean default false)
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
  perform private.recompute_week_hours(v.org_id, v.user_id, v.week_start);
  perform private.enqueue_shift_event(v.org_id, v.user_id,
    case when v_status = 'missed' then 'shift_missed' else 'shift_completed' end, v.id, '{}'::jsonb);
  return v_status;
end;
$$;

-- ---- week lock -------------------------------------------------------------------------------------------------------

-- Interns who still have not submitted get a notification + the Not submitted events; submitted interns
-- under their (effective) minimum get Under minimum. One failing member never stops the rest.
create function private.shift_lock_week(p_org uuid, p_week date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set public.shift_settings;
  v_tz text;
  m record;
  c public.week_commitments;
  v_hours numeric;
  v_min numeric;
begin
  select * into v_set from public.shift_settings where org_id = p_org;
  v_tz := v_set.timezone;
  for m in
    select om.user_id
    from public.org_members om
    left join public.shift_members sm on sm.org_id = om.org_id and sm.user_id = om.user_id
    where om.org_id = p_org and om.status = 'active' and coalesce(sm.participates, om.role = 'agent')
  loop
    begin
      select * into c from public.week_commitments
      where org_id = p_org and user_id = m.user_id and week_start = p_week;
      if c.submitted_at is null then
        begin
          insert into public.notifications (org_id, user_id, type, title, body, data)
          values (p_org, m.user_id, 'shift_week_not_submitted', 'Pick next week''s shifts',
            'Picks for the week of ' || to_char(p_week, 'Mon FMDD') || ' have closed and you have not submitted yet. '
              || 'You can still ask for changes from the Shifts tab.',
            jsonb_build_object('week_start', p_week));
        exception when others then
          null;
        end;
        perform private.enqueue_shift_event(p_org, m.user_id, 'not_submitted', null,
          jsonb_build_object('week_start', p_week));
      else
        select coalesce(sum(s.hours), 0) into v_hours from public.shifts s
        where s.org_id = p_org and s.user_id = m.user_id and s.week_start = p_week
          and s.status in ('scheduled', 'completed', 'missed');
        v_min := coalesce(c.min_hours_override, v_set.min_weekly_hours);
        if v_hours < v_min then
          perform private.enqueue_shift_event(p_org, m.user_id, 'under_minimum', null,
            jsonb_build_object('week_start', p_week, 'hours', v_hours, 'minimum', v_min));
        end if;
      end if;
    exception when others then
      raise warning 'shift_lock_week org % user %: %', p_org, m.user_id, sqlerrm;
    end;
  end loop;
end;
$$;

create function public.shifts_week_lock_run()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.shift_settings;
  v_today date;
  v_next date;
  v_locked integer := 0;
  v_failed integer := 0;
begin
  for r in select * from public.shift_settings s where s.enabled loop
    begin
      v_today := (now() at time zone r.timezone)::date;
      v_next := v_today - (extract(isodow from v_today)::int - 1) + 7;
      if (r.last_locked_week is null or r.last_locked_week < v_next)
         and now() >= private.shift_week_deadline(r.org_id, v_next) then
        perform private.shift_lock_week(r.org_id, v_next);
        update public.shift_settings set last_locked_week = v_next where org_id = r.org_id;
        v_locked := v_locked + 1;
      end if;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'shifts_week_lock_run org %: %', r.org_id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('ok', v_failed = 0, 'locked', v_locked, 'failed', v_failed);
end;
$$;

-- ---- week close ------------------------------------------------------------------------------------------------------

-- power_dial_pct = sum(power_active_minutes) / sum(active_dial_minutes) x 100; power_week when it reaches
-- power_week_pct AND they dialed at least an hour AND the week's counted hours met their (effective) minimum.
create function private.shift_close_week(p_org uuid, p_week date)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_set public.shift_settings;
  m record;
  c public.week_commitments;
  v_active numeric;
  v_power numeric;
  v_hours numeric;
  v_pct numeric;
  v_earned boolean;
  v_had boolean;
begin
  select * into v_set from public.shift_settings where org_id = p_org;
  for m in
    select om.user_id
    from public.org_members om
    left join public.shift_members sm on sm.org_id = om.org_id and sm.user_id = om.user_id
    where om.org_id = p_org and om.status = 'active' and coalesce(sm.participates, om.role = 'agent')
  loop
    begin
      select coalesce(sum(k.active_dial_minutes), 0), coalesce(sum(k.power_active_minutes), 0)
      into v_active, v_power
      from public.shift_kpis k join public.shifts s on s.id = k.shift_id
      where s.org_id = p_org and s.user_id = m.user_id and s.week_start = p_week;
      select coalesce(sum(s.hours), 0) into v_hours from public.shifts s
      where s.org_id = p_org and s.user_id = m.user_id and s.week_start = p_week
        and s.status in ('scheduled', 'completed', 'missed');
      select * into c from public.week_commitments
      where org_id = p_org and user_id = m.user_id and week_start = p_week;
      v_pct := case when v_active > 0 then round(100.0 * v_power / v_active, 1) else null end;
      v_earned := v_pct is not null and v_pct >= v_set.power_week_pct and v_active >= 60
        and v_hours >= coalesce(c.min_hours_override, v_set.min_weekly_hours);
      v_had := c.user_id is not null or exists (
        select 1 from public.shifts s where s.org_id = p_org and s.user_id = m.user_id and s.week_start = p_week);
      if v_had then
        insert into public.week_commitments (org_id, user_id, week_start, power_dial_pct, power_week)
        values (p_org, m.user_id, p_week, v_pct, v_earned)
        on conflict (org_id, user_id, week_start)
        do update set power_dial_pct = excluded.power_dial_pct, power_week = excluded.power_week;
        perform private.recompute_week_hours(p_org, m.user_id, p_week);
      end if;
      if v_earned then
        perform private.enqueue_shift_event(p_org, m.user_id, 'power_week', null,
          jsonb_build_object('week_start', p_week, 'dial_minutes', v_active, 'power_pct', v_pct));
      end if;
      perform private.enqueue_shift_event(p_org, m.user_id, 'week_closed', null,
        jsonb_build_object('week_start', p_week));
    exception when others then
      raise warning 'shift_close_week org % user %: %', p_org, m.user_id, sqlerrm;
    end;
  end loop;
end;
$$;

create function public.shifts_week_close_run()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.shift_settings;
  v_today date;
  v_mon date;
  v_prev date;
  v_closed integer := 0;
  v_failed integer := 0;
begin
  for r in select * from public.shift_settings s where s.enabled loop
    begin
      v_today := (now() at time zone r.timezone)::date;
      v_mon := v_today - (extract(isodow from v_today)::int - 1);
      v_prev := v_mon - 7;
      if (r.last_closed_week is null or r.last_closed_week < v_prev)
         and now() >= ((v_mon::timestamp + time '00:30') at time zone r.timezone) then
        -- A brand-new org has no shifts in that week: nothing to close, but do not retry every hour.
        if exists (select 1 from public.shifts s where s.org_id = r.org_id and s.week_start = v_prev) then
          perform private.shift_close_week(r.org_id, v_prev);
          v_closed := v_closed + 1;
        end if;
        update public.shift_settings set last_closed_week = v_prev where org_id = r.org_id;
      end if;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'shifts_week_close_run org %: %', r.org_id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('ok', v_failed = 0, 'closed', v_closed, 'failed', v_failed);
end;
$$;

-- ---- off-shift dialing (D14) -----------------------------------------------------------------------------------------

-- Queue the "Off-shift dialing" event when a participating intern starts a dial session with no scheduled shift
-- within 15 minutes either side of now. At most one event per intern per hour, so restarting a session does not
-- spam the contact.
create function private.enqueue_off_shift_dialing(p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_s public.dial_sessions;
begin
  select * into v_s from public.dial_sessions where id = p_session;
  if v_s.id is null then
    return;
  end if;
  if not coalesce((select st.enabled from public.shift_settings st where st.org_id = v_s.org_id), false) then
    return;
  end if;
  if not exists (
    select 1 from public.org_members om
    left join public.shift_members sm on sm.org_id = om.org_id and sm.user_id = om.user_id
    where om.org_id = v_s.org_id and om.user_id = v_s.agent_id and om.status = 'active'
      and coalesce(sm.participates, om.role = 'agent')
  ) then
    return;
  end if;
  if exists (
    select 1 from public.shifts s
    where s.org_id = v_s.org_id and s.user_id = v_s.agent_id and s.status = 'scheduled'
      and s.starts_at < now() + interval '15 minutes' and s.ends_at > now() - interval '15 minutes'
  ) then
    return;
  end if;
  if exists (
    select 1 from public.shift_ghl_outbox o
    where o.org_id = v_s.org_id and o.user_id = v_s.agent_id and o.event = 'Off-shift dialing'
      and o.created_at > now() - interval '60 minutes'
  ) then
    return;
  end if;
  perform private.enqueue_shift_event(v_s.org_id, v_s.agent_id, 'off_shift_dialing', null,
    jsonb_build_object('at', v_s.started_at));
end;
$$;

-- R-042: hot path. Whatever happens in the body, the dial_sessions insert goes through.
create function private.trg_off_shift_dialing()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  begin
    perform private.enqueue_off_shift_dialing(new.id);
  exception when others then
    null;
  end;
  return new;
end;
$$;

create trigger trg_off_shift_dialing
  after insert on public.dial_sessions
  for each row execute function private.trg_off_shift_dialing();

-- ---- privileges --------------------------------------------------------------------------------------------------------

revoke all on function
  public.shift_kpi_due(integer),
  public.shift_kpi_inputs(uuid),
  public.shift_kpi_save(uuid, jsonb, boolean),
  public.shifts_week_lock_run(),
  public.shifts_week_close_run(),
  private.shift_lock_week(uuid, date),
  private.shift_close_week(uuid, date),
  private.enqueue_off_shift_dialing(uuid),
  private.trg_off_shift_dialing()
from public, anon, authenticated;
grant execute on function
  public.shift_kpi_due(integer),
  public.shift_kpi_inputs(uuid),
  public.shift_kpi_save(uuid, jsonb, boolean),
  public.shifts_week_lock_run(),
  public.shifts_week_close_run()
to service_role;

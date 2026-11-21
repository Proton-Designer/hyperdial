-- TASK-S05F (eng2's S05 review SHOULDs S1..S4). Replaces three functions from 20261006140000 (create or replace keeps
-- their service_role-only grants).
--
--  S1 week close waits until the week is final: while any shift of the week is still 'scheduled' and ended less than
--     2 h 15 min ago (the 2 h finalize rule + one 15-minute KPI pass), the close does nothing this tick and is retried
--     on the next hourly run. A shift that is still scheduled after that (the KPI job is down) no longer blocks it.
--     The once-per-org-week guard (last_closed_week) is unchanged.
--  S2 a contact leg with no ended_at counts as ended at min(now, created_at + 30 min) in shift_kpi_inputs.last_leg_end
--     (shift-kpi-core.ts applies the same cap to the legs themselves), never as "now" for ever.
--  S3 after a cron outage the lock and the close run for EVERY missed week in order, at most 4 weeks back. An org that
--     has never run (last_*_week is null) still starts at the one current week, so enabling Shifts never replays history.
--  S4 (no SQL) placeholder / failed legs: claim_next_leads inserts a contact leg per attempt (state 'initiated'); a failed
--     dial ends it with outcome 'failed'. call_leg_analytics counts every kind='contact' leg as a dial, and so does the
--     Shifts KPI (dials = contact legs created inside the shift), so a failed attempt is a dial in both. The only
--     deliberate difference: Shifts also counts AMD human variants as connects (D6).

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

create or replace function public.shifts_week_lock_run()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.shift_settings;
  v_today date;
  v_next date;
  v_w date;
  v_locked integer := 0;
  v_failed integer := 0;
begin
  for r in select * from public.shift_settings s where s.enabled loop
    begin
      v_today := (now() at time zone r.timezone)::date;
      v_next := v_today - (extract(isodow from v_today)::int - 1) + 7;
      -- oldest first, at most 4 weeks back (the current upcoming week included)
      v_w := case when r.last_locked_week is null then v_next else greatest(r.last_locked_week + 7, v_next - 21) end;
      while v_w <= v_next loop
        exit when now() < private.shift_week_deadline(r.org_id, v_w);
        perform private.shift_lock_week(r.org_id, v_w);
        update public.shift_settings set last_locked_week = v_w where org_id = r.org_id;
        v_locked := v_locked + 1;
        v_w := v_w + 7;
      end loop;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'shifts_week_lock_run org %: %', r.org_id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('ok', v_failed = 0, 'locked', v_locked, 'failed', v_failed);
end;
$$;

create or replace function public.shifts_week_close_run()
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
  v_w date;
  v_closed integer := 0;
  v_failed integer := 0;
begin
  for r in select * from public.shift_settings s where s.enabled loop
    begin
      v_today := (now() at time zone r.timezone)::date;
      v_mon := v_today - (extract(isodow from v_today)::int - 1);
      v_prev := v_mon - 7;
      -- oldest first, at most 4 weeks back; a week closes after the Monday that follows it, 00:30 local
      v_w := case when r.last_closed_week is null then v_prev else greatest(r.last_closed_week + 7, v_prev - 21) end;
      while v_w <= v_prev loop
        exit when now() < (((v_w + 7)::timestamp + time '00:30') at time zone r.timezone);
        -- S1: do not score a week while one of its shifts may still be finalized by the KPI job
        exit when exists (
          select 1 from public.shifts s
          where s.org_id = r.org_id and s.week_start = v_w and s.status = 'scheduled'
            and s.ends_at > now() - interval '135 minutes');
        -- A week with no shifts at all has nothing to close, but is still marked so it is not retried every hour.
        if exists (select 1 from public.shifts s where s.org_id = r.org_id and s.week_start = v_w) then
          perform private.shift_close_week(r.org_id, v_w);
          v_closed := v_closed + 1;
        end if;
        update public.shift_settings set last_closed_week = v_w where org_id = r.org_id;
        v_w := v_w + 7;
      end loop;
    exception when others then
      v_failed := v_failed + 1;
      raise warning 'shifts_week_close_run org %: %', r.org_id, sqlerrm;
    end;
  end loop;
  return jsonb_build_object('ok', v_failed = 0, 'closed', v_closed, 'failed', v_failed);
end;
$$;

-- TASK-S05F follow-up (lead's decision): a catch-up LOCK for a week that has already started is only recorded as locked
-- (last_locked_week), with no notification and no Not submitted / Under minimum events. Those are for the upcoming week.
-- Replaces shifts_week_lock_run from 20261006150000 (create or replace keeps its grants).

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
        -- a catch-up for a week that has already started only records it: the Not submitted / Under minimum events and
        -- the notification are for the upcoming week
        if v_w >= v_next then
          perform private.shift_lock_week(r.org_id, v_w);
        end if;
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

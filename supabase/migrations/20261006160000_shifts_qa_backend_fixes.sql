-- TASK-QF-B (backend fixes from the live UI QA, audit/Q1/results.md; contract: docs/design/shifts.md section 3 additions).
--
--  D1  shift_settings.enabled_at: the first moment Shifts was switched on (set by a trigger, so every path that flips
--      `enabled` is covered, not only admin_update_shift_settings). Existing enabled orgs are backfilled with now().
--      The lock and close jobs only record a week whose pick deadline is before enabled_at (no Not submitted / Under
--      minimum, no Week closed rollups with zeros). The edge functions expose it as WeekInfo.beforeLaunch.
--  D4  private.shift_member_name never returns a raw email: "First Last", else the email local part, else "Member"
--      (same fallback as the short form and everywhere else in the app).
-- (D14 weekMinimum, D15 pendingCount/ghlConnected and the D7 request history are edge-function changes only.)

alter table public.shift_settings add column enabled_at timestamptz;
update public.shift_settings set enabled_at = now() where enabled and enabled_at is null;

create function private.shift_settings_set_enabled_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.enabled and new.enabled_at is null then
    new.enabled_at := now();
  end if;
  return new;
end;
$$;

create trigger trg_shift_settings_enabled_at
  before insert or update of enabled on public.shift_settings
  for each row execute function private.shift_settings_set_enabled_at();

create or replace function private.shift_member_name(p_user uuid, p_full boolean)
returns text
language sql
security definer
stable
set search_path = ''
as $$
  select case
    when p_full then coalesce(
      nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      'Member'
    )
    else coalesce(
      nullif(btrim(
        coalesce(nullif(btrim(p.first_name), ''), '')
        || case when nullif(btrim(p.last_name), '') is not null
                then ' ' || upper(left(btrim(p.last_name), 1)) || '.' else '' end
      ), ''),
      nullif(split_part(coalesce(u.email, ''), '@', 1), ''),
      'Member'
    )
  end
  from (select 1) one
  left join public.profiles p on p.user_id = p_user
  left join auth.users u on u.id = p_user;
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
        -- a week that has already started, or whose pick deadline is before Shifts was switched on (enabled_at), is only
        -- recorded as locked: no notification and no Not submitted / Under minimum events
        if v_w >= v_next and private.shift_week_deadline(r.org_id, v_w) >= coalesce(r.enabled_at, '-infinity'::timestamptz) then
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
        -- A week whose pick deadline is before Shifts was switched on (enabled_at) is only recorded: no rollup, no events.
        if private.shift_week_deadline(r.org_id, v_w) >= coalesce(r.enabled_at, '-infinity'::timestamptz)
           and exists (select 1 from public.shifts s where s.org_id = r.org_id and s.week_start = v_w) then
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

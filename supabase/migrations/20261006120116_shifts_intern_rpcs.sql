-- TASK-S02 (Shifts subsystem, intern edge-function support). Builds on 20261006114226_shifts_schema.sql.
--
-- Everything here is a PUBLIC, service_role-only SECURITY DEFINER function, because the edge
-- functions can only call public.* through supabase.rpc() (the private schema is not reachable).
-- None is callable by anon/authenticated (EXECUTE revoked), same lockdown as submit_week.
--
--  * shift_ensure_config(org)            thin wrapper over private.ensure_shift_config
--  * shift_member_names(ids, full)       display names ("Sara K." / full), one source of truth
--  * shift_week_roster(org, week, full, viewer)   who is on, per shift, participants (+ the viewer)
--  * create_shift_request(...)           validate + insert + notify managers + enqueue "Request created"
--  * withdraw_shift_request(...)         own pending only + enqueue "Request withdrawn"
--
-- Error protocol = the same as submit_week (errcode P0001, message = code, detail = json).
-- Codes raised here: shifts_disabled, forbidden, reason_too_short {minimum,length}, not_found,
-- shift_started, request_pending, bad_request {reason}, bad_time_step, outside_open_hours,
-- bad_block {reason:'in_the_past'}, overlap, not_pending.
--
-- Contract notes (additive, docs/design/shifts.md section 3):
--  * light_week accepts an optional `date` (any day in the target week); default = NEXT week
--    (local, org timezone). requestedMinHours must be > 0 and below the org minimum.
--  * For move/drop the request's week_start is the original shift's week; for add it is the week of
--    the new time; for light_week the target week.
--  * is_late: the AFFECTED shift starts within change_notice_hours of now (move: the original OR the
--    new time; drop: the original; add: the new time). light_week is never late.
--  * Managers notified (public.notifications, type 'shift_request'): active owners/admins plus
--    managers whose pods include the requester's pod; never the requester.

create function public.shift_ensure_config(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.ensure_shift_config(p_org);
$$;

create function public.shift_member_names(p_ids uuid[], p_full boolean)
returns table (user_id uuid, name text)
language sql
security definer
stable
set search_path = ''
as $$
  select i, private.shift_member_name(i, p_full) from unnest(p_ids) as i;
$$;

create function public.shift_week_roster(p_org uuid, p_week_start date, p_full boolean, p_viewer uuid)
returns table (user_id uuid, name text, activity text, starts_at timestamptz, ends_at timestamptz)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  select s.user_id, private.shift_member_name(s.user_id, p_full), s.activity, s.starts_at, s.ends_at
  from public.shifts s
  where s.org_id = p_org and s.week_start = p_week_start and s.status in ('scheduled', 'completed')
    and (s.user_id = p_viewer or private.shift_participates(p_org, s.user_id))
  order by s.starts_at, s.user_id;
end;
$$;

create function public.create_shift_request(
  p_org uuid,
  p_user uuid,
  p_type text,
  p_from_shift_id uuid,
  p_date date,
  p_start time,
  p_end time,
  p_to_activity text,
  p_requested_min_hours numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_set public.shift_settings;
  v_tz text;
  v_from public.shifts;
  v_oh public.open_hours;
  v_to_start timestamptz;
  v_to_end timestamptz;
  v_activity text;
  v_week date;
  v_late boolean := false;
  v_req public.shift_change_requests;
  v_name text;
  v_reason text;
begin
  perform private.ensure_shift_config(p_org);
  select * into v_set from public.shift_settings where org_id = p_org;
  if not v_set.enabled then
    perform private.shift_err('shifts_disabled');
  end if;
  v_tz := v_set.timezone;
  if not exists (select 1 from public.org_members m where m.org_id = p_org and m.user_id = p_user and m.status = 'active') then
    perform private.shift_err('forbidden');
  end if;
  if p_type is null or p_type not in ('move', 'drop', 'add', 'light_week') then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_type'));
  end if;
  -- "At least 20 characters after trimming": trim ALL leading/trailing whitespace (incl. NBSP and
  -- zero-width characters that btrim ignores) and require some real content, so a reason made of
  -- invisible characters cannot pass. The table check (btrim >= 20) stays as the backstop.
  v_reason := regexp_replace(coalesce(p_reason, ''),
    '^[\s\u00a0\u200b-\u200d\u2060\ufeff]+|[\s\u00a0\u200b-\u200d\u2060\ufeff]+$', '', 'g');
  if char_length(v_reason) < 20
     or char_length(regexp_replace(v_reason, '[\s\u00a0\u200b-\u200d\u2060\ufeff]', '', 'g')) < 10 then
    perform private.shift_err('reason_too_short', jsonb_build_object('minimum', 20, 'length', char_length(v_reason)));
  end if;

  -- ---- the affected existing shift (move / drop) ----------------------------------------------------
  if p_type in ('move', 'drop') then
    select * into v_from from public.shifts
    where id = p_from_shift_id and org_id = p_org and user_id = p_user
    for update;
    if not found then
      perform private.shift_err('not_found');
    end if;
    if v_from.starts_at <= now() then
      perform private.shift_err('shift_started');
    end if;
    if v_from.status <> 'scheduled' then
      perform private.shift_err('not_found');
    end if;
    if exists (select 1 from public.shift_change_requests r where r.from_shift_id = v_from.id and r.status = 'pending') then
      perform private.shift_err('request_pending');
    end if;
    v_week := v_from.week_start;
    v_late := v_from.starts_at < now() + make_interval(hours => v_set.change_notice_hours);
  end if;

  -- ---- the new time (move / add) ----------------------------------------------------------------------
  if p_type in ('move', 'add') then
    if p_date is null or p_start is null or p_end is null then
      perform private.shift_err('bad_request', jsonb_build_object('reason', 'missing_time'));
    end if;
    v_activity := coalesce(p_to_activity, 'dialing');
    if v_activity not in ('dialing', 'follow_up', 'social') then
      perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_activity'));
    end if;
    if extract(minute from p_start) not in (0, 30) or extract(second from p_start) <> 0
       or extract(minute from p_end) not in (0, 30) or extract(second from p_end) <> 0
       or p_end <= p_start then
      perform private.shift_err('bad_time_step');
    end if;
    select * into v_oh from public.open_hours
    where org_id = p_org and iso_weekday = extract(isodow from p_date)::smallint;
    if not found or p_start < v_oh.open_from or p_end > v_oh.open_until then
      perform private.shift_err('outside_open_hours');
    end if;
    v_to_start := (p_date + p_start)::timestamp at time zone v_tz;
    v_to_end := (p_date + p_end)::timestamp at time zone v_tz;
    if v_to_start <= now() then
      perform private.shift_err('bad_block', jsonb_build_object('reason', 'in_the_past'));
    end if;
    if exists (
      select 1 from public.shifts s
      where s.org_id = p_org and s.user_id = p_user and s.status = 'scheduled'
        and s.id is distinct from p_from_shift_id
        and tstzrange(s.starts_at, s.ends_at) && tstzrange(v_to_start, v_to_end)
    ) then
      perform private.shift_err('overlap');
    end if;
    if p_type = 'add' then
      v_week := p_date - (extract(isodow from p_date)::int - 1);
      v_late := v_to_start < now() + make_interval(hours => v_set.change_notice_hours);
    else
      -- a move is late when EITHER end of it falls inside the notice window
      v_late := v_late or v_to_start < now() + make_interval(hours => v_set.change_notice_hours);
    end if;
  else
    v_to_start := null; v_to_end := null; v_activity := null;
  end if;

  -- ---- light week -----------------------------------------------------------------------------------------
  if p_type = 'light_week' then
    if p_requested_min_hours is null or p_requested_min_hours <= 0 or p_requested_min_hours >= v_set.min_weekly_hours then
      perform private.shift_err('bad_request', jsonb_build_object('reason', 'light_week_hours', 'minimum', v_set.min_weekly_hours));
    end if;
    v_week := coalesce(p_date, (now() at time zone v_tz)::date + 7);
    v_week := v_week - (extract(isodow from v_week)::int - 1);
    if v_week + 7 <= (now() at time zone v_tz)::date then
      perform private.shift_err('bad_request', jsonb_build_object('reason', 'past_week'));
    end if;
    if exists (select 1 from public.shift_change_requests r
               where r.org_id = p_org and r.user_id = p_user and r.type = 'light_week'
                 and r.week_start = v_week and r.status = 'pending') then
      perform private.shift_err('request_pending');
    end if;
  end if;

  begin
    insert into public.shift_change_requests (
      org_id, user_id, week_start, type, from_shift_id, to_starts_at, to_ends_at, to_activity,
      requested_min_hours, reason, is_late
    ) values (
      p_org, p_user, v_week, p_type, case when p_type in ('move', 'drop') then v_from.id end,
      v_to_start, v_to_end, v_activity,
      case when p_type = 'light_week' then p_requested_min_hours end, v_reason, v_late
    ) returning * into v_req;
  exception when unique_violation then
    perform private.shift_err('request_pending');
  end;

  -- Notify managers in scope. Best effort: never block the request itself (R-042 spirit).
  begin
    v_name := private.shift_member_name(p_user, true);
    insert into public.notifications (org_id, user_id, type, title, body, data)
    select p_org, m.user_id, 'shift_request',
      v_name || ' requested a shift change' || case when v_late then ' (late)' else '' end,
      private.shift_request_desc(v_req, v_tz),
      jsonb_build_object('request_id', v_req.id, 'user_id', p_user, 'is_late', v_late)
    from public.org_members m
    where m.org_id = p_org and m.status = 'active' and m.user_id <> p_user
      and (
        m.role in ('owner', 'admin')
        or (m.role = 'manager' and exists (
          select 1 from public.org_manager_pods mp
          join public.org_members t on t.org_id = mp.org_id and t.pod_id = mp.pod_id
          where mp.org_id = p_org and mp.manager_user_id = m.user_id and t.user_id = p_user))
      );
  exception when others then
    raise warning 'create_shift_request: manager notification failed: %', sqlerrm;
  end;

  perform private.enqueue_shift_event(p_org, p_user, 'request_created', v_req.from_shift_id,
    jsonb_build_object('request_id', v_req.id));

  return to_jsonb(v_req);
end;
$$;

create function public.withdraw_shift_request(p_org uuid, p_user uuid, p_request_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_req public.shift_change_requests;
begin
  perform private.ensure_shift_config(p_org);
  if not coalesce((select s.enabled from public.shift_settings s where s.org_id = p_org), false) then
    perform private.shift_err('shifts_disabled');
  end if;
  select * into v_req from public.shift_change_requests
  where id = p_request_id and org_id = p_org
  for update;
  -- Someone else's request is indistinguishable from a missing one.
  if not found or v_req.user_id <> p_user then
    perform private.shift_err('not_found');
  end if;
  if v_req.status <> 'pending' then
    perform private.shift_err('not_pending');
  end if;
  update public.shift_change_requests set status = 'withdrawn' where id = v_req.id returning * into v_req;
  perform private.enqueue_shift_event(p_org, p_user, 'request_withdrawn', v_req.from_shift_id,
    jsonb_build_object('request_id', v_req.id));
  return to_jsonb(v_req);
end;
$$;

revoke all on function
  public.shift_ensure_config(uuid),
  public.shift_member_names(uuid[], boolean),
  public.shift_week_roster(uuid, date, boolean, uuid),
  public.create_shift_request(uuid, uuid, text, uuid, date, time, time, text, numeric, text),
  public.withdraw_shift_request(uuid, uuid, uuid)
from public, anon, authenticated;
grant execute on function
  public.shift_ensure_config(uuid),
  public.shift_member_names(uuid[], boolean),
  public.shift_week_roster(uuid, date, boolean, uuid),
  public.create_shift_request(uuid, uuid, text, uuid, date, time, time, text, numeric, text),
  public.withdraw_shift_request(uuid, uuid, uuid)
to service_role;

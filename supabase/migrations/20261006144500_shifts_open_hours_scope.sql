-- TASK-S03F security follow-up: the `affected` count returned by admin_replace_open_hours only counts shifts of
-- interns the CALLER may see (owner/admin: everyone; manager: their pods), so a pod-scoped manager does not learn
-- org-wide shift volumes through it. Same signature, create or replace (grants preserved).

create or replace function public.admin_replace_open_hours(p_org uuid, p_actor uuid, p_rows jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  r jsonb;
  v_day int;
  v_from time;
  v_until time;
  v_seen int[] := '{}';
  v_tz text;
  v_affected integer;
begin
  perform private.shift_admin_guard(p_org, p_actor);
  perform private.ensure_shift_config(p_org);
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_rows'));
  end if;
  begin
    for r in select * from jsonb_array_elements(p_rows) loop
      v_day := (r ->> 'isoWeekday')::int;
      v_from := (r ->> 'openFrom')::time;
      v_until := (r ->> 'openUntil')::time;
      if v_day is null or v_day not between 1 and 7 or v_day = any(v_seen)
         or v_from is null or v_until is null or v_until <= v_from
         or extract(minute from v_from) not in (0, 30) or extract(minute from v_until) not in (0, 30) then
        perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_rows'));
      end if;
      v_seen := array_append(v_seen, v_day);
    end loop;
  exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
    perform private.shift_err('bad_request', jsonb_build_object('reason', 'bad_rows'));
  end;
  delete from public.open_hours where org_id = p_org;
  insert into public.open_hours (org_id, iso_weekday, open_from, open_until)
  select p_org, (e ->> 'isoWeekday')::smallint, (e ->> 'openFrom')::time, (e ->> 'openUntil')::time
  from jsonb_array_elements(p_rows) e;
  -- Existing shifts are not touched (changes apply to future picks); say how many now sit outside the hours.
  v_tz := private.shift_tz(p_org);
  select count(*) into v_affected from public.shifts s
  where s.org_id = p_org and s.status = 'scheduled' and s.starts_at > now()
    and private.shift_actor_sees(p_org, p_actor, s.user_id)
    and not exists (
      select 1 from public.open_hours o
      where o.org_id = s.org_id
        and o.iso_weekday = extract(isodow from (s.starts_at at time zone v_tz))::smallint
        and (s.starts_at at time zone v_tz)::time >= o.open_from
        and (s.ends_at at time zone v_tz)::time <= o.open_until);
  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(to_jsonb(o) order by o.iso_weekday) from public.open_hours o where o.org_id = p_org), '[]'::jsonb),
    'affected', v_affected);
end;
$$;

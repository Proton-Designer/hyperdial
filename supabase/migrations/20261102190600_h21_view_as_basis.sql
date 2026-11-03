-- TASK-H21 (lead review MUST 2): a view-as session has no time limit, so it must stop when its basis stops. The viewer must still
-- be an ACTIVE owner/admin of the session's org, and the target still an ACTIVE agent of that org with no membership in any other
-- org. view_as_basis_ok() is the one check; db_pre_request uses it for view sessions only (cost on view sessions only) and the
-- Edge Function guard calls it too (cached 60 s there). Replaces view_as_pre_request from 20261102190000 (same signature).
create or replace function public.view_as_basis_ok(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.view_as_sessions v
     where v.session_id = p_session_id
       and exists (select 1 from public.org_members m
                    where m.org_id = v.org_id and m.user_id = v.viewer_id and m.status = 'active' and m.role in ('owner', 'admin'))
       and exists (select 1 from public.org_members m
                    where m.org_id = v.org_id and m.user_id = v.target_id and m.status = 'active' and m.role = 'agent')
       and not exists (select 1 from public.org_members m
                        where m.user_id = v.target_id and m.org_id <> v.org_id)
  );
$$;
revoke all on function public.view_as_basis_ok(uuid) from public, anon, authenticated;
grant execute on function public.view_as_basis_ok(uuid) to service_role;

create or replace function public.view_as_pre_request()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims text;
  v_sid text;
  v_found boolean := false;
  v_ended timestamptz;
  v_basis boolean := true;
begin
  v_claims := current_setting('request.jwt.claims', true);
  if v_claims is null or v_claims = '' then return; end if;
  begin
    if (v_claims::jsonb ->> 'role') is distinct from 'authenticated' then return; end if;
    v_sid := v_claims::jsonb ->> 'session_id';
    if v_sid is null then return; end if;
    select true, v.ended_at into v_found, v_ended
      from public.view_as_sessions v where v.session_id = v_sid::uuid;
    if v_found and v_ended is null then
      v_basis := public.view_as_basis_ok(v_sid::uuid);
    end if;
  exception when others then
    raise warning 'view_as_pre_request lookup failed: %', sqlerrm;
    perform set_config('transaction_read_only', 'on', true);
    return;
  end;
  if not coalesce(v_found, false) then return; end if;
  if v_ended is not null or not v_basis then
    raise exception 'view-as session ended' using errcode = 'PT401';
  end if;
  perform set_config('transaction_read_only', 'on', true);
end;
$$;

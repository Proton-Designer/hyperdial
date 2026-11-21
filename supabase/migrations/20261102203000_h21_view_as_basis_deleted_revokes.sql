-- TASK-H21 (security review of 20261102200500): with the foreign keys gone the marker survives a deleted viewer / target / org,
-- and db_pre_request already answers PT401 for it. This also ENDS the session right away (marker ended + GoTrue session and
-- refresh tokens deleted), instead of waiting for the next Edge Function request to notice (the guard's basis_lost path).
create or replace function public.view_as_basis_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select v.session_id as sid
      from public.view_as_sessions v
     where v.ended_at is null
       and ((tg_table_name = 'users' and (v.viewer_id = old.id or v.target_id = old.id))
         or (tg_table_name = 'orgs' and v.org_id = old.id))
  loop
    perform public.view_as_end(r.sid, 'basis_deleted');
  end loop;
  return old;
exception when others then
  raise warning 'view_as_basis_deleted failed: %', sqlerrm;
  return old;
end;
$$;
revoke all on function public.view_as_basis_deleted() from public, anon, authenticated;

create trigger view_as_basis_deleted after delete on auth.users
  for each row execute function public.view_as_basis_deleted();
create trigger view_as_basis_deleted after delete on public.orgs
  for each row execute function public.view_as_basis_deleted();

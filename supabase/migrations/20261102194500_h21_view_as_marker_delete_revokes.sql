-- TASK-H21 (security review): the view_as_sessions marker row cascades away when the viewer's auth user or the org is deleted.
-- Without the marker the guard and db_pre_request treat the token as an ordinary session, so a still-valid view-as session would
-- become a FULL session of the intern. Deleting the marker therefore deletes the GoTrue session (and its refresh tokens) first.
create or replace function public.view_as_marker_delete_revokes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from auth.sessions where id = old.session_id;
  return old;
end;
$$;
revoke all on function public.view_as_marker_delete_revokes() from public, anon, authenticated;

create trigger view_as_marker_delete_revokes
  before delete on public.view_as_sessions
  for each row execute function public.view_as_marker_delete_revokes();

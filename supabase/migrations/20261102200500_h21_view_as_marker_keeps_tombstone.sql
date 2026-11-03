-- TASK-H21 (security review of 20261102194500): deleting the marker still leaves the already-issued access token (up to 1 h,
-- PostgREST only checks the signature) acting as an ORDINARY session. So the marker must never disappear by cascade: drop the
-- foreign keys. A viewer/org/target that was deleted then fails view_as_basis_ok (membership gone) and db_pre_request answers
-- PT401 until the token expires. The delete-revokes trigger stays (it still kills the GoTrue session if a marker is ever deleted).
alter table public.view_as_sessions drop constraint if exists view_as_sessions_org_id_fkey;
alter table public.view_as_sessions drop constraint if exists view_as_sessions_viewer_id_fkey;
alter table public.view_as_sessions drop constraint if exists view_as_sessions_target_id_fkey;

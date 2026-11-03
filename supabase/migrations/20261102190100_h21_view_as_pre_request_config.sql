-- TASK-H21 rollout step 3 (the lead applies this ONE only after the guard is deployed to every user-facing Edge Function,
-- see audit/H21/design.md section 9). Switches PostgREST's db_pre_request on. `alter role ... set` adds one key to the
-- authenticator role's settings (safeupdate, statement_timeout, lock_timeout stay).
--
-- ROLLBACK (instant, no deploy):
--   alter role authenticator reset pgrst.db_pre_request;
--   notify pgrst, 'reload config';
alter role authenticator set pgrst.db_pre_request = 'public.view_as_pre_request';
notify pgrst, 'reload config';

-- TASK-H16 acceptance test for migration 20261101202710_h16_ghl_intake_log.sql. One transaction, ROLLED BACK.
-- Positive control: without the migration the first insert fails (relation does not exist).
begin;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $f$ begin return new; end; $f$;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data,
  raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', 'a16a0000-a000-4000-8000-00000000000a', 'authenticated', 'authenticated',
  'h16-owner@example.com', 'x', now(), '{}', '{}', now(), now(), '', '', false, false);
insert into public.orgs (id, name, created_by) values ('a16a0000-a000-4000-8000-0000000000aa', 'H16 Org', 'a16a0000-a000-4000-8000-00000000000a');
insert into public.org_members (org_id, user_id, role, status) values ('a16a0000-a000-4000-8000-0000000000aa', 'a16a0000-a000-4000-8000-00000000000a', 'owner', 'active');

do $$
declare n int; ok boolean;
begin
  insert into public.ghl_intake_log (org_id, ghl_contact_id, outcome) values ('a16a0000-a000-4000-8000-0000000000aa', 'g1', 'queued');
  select count(*) into n from public.ghl_intake_log;
  if n <> 1 then raise exception 'FAIL insert as postgres'; end if;
  raise notice 'PASS insert works for the owner role';

  -- every contract outcome is accepted, anything else is rejected
  insert into public.ghl_intake_log (org_id, ghl_contact_id, outcome)
    select 'a16a0000-a000-4000-8000-0000000000aa', 'g2', o from unnest(array['already_queued','skipped_dnc','skipped_paused','skipped_active_elsewhere','no_matching_rule','error']) o;
  begin
    insert into public.ghl_intake_log (org_id, ghl_contact_id, outcome) values ('a16a0000-a000-4000-8000-0000000000aa', 'g3', 'bogus');
    raise exception 'FAIL bogus outcome accepted';
  exception when check_violation then raise notice 'PASS bogus outcome rejected'; end;

  -- authenticated (even the org owner) and anon can neither read nor write
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"role":"authenticated","sub":"a16a0000-a000-4000-8000-00000000000a"}', true);
  begin
    perform count(*) from public.ghl_intake_log;
    raise exception 'FAIL authenticated could select';
  exception when insufficient_privilege then raise notice 'PASS authenticated cannot select'; end;
  begin
    insert into public.ghl_intake_log (org_id, ghl_contact_id, outcome) values ('a16a0000-a000-4000-8000-0000000000aa', 'g4', 'queued');
    raise exception 'FAIL authenticated could insert';
  exception when insufficient_privilege then raise notice 'PASS authenticated cannot insert'; end;
  reset role;
  set local role anon;
  begin
    perform count(*) from public.ghl_intake_log;
    raise exception 'FAIL anon could select';
  exception when insufficient_privilege then raise notice 'PASS anon cannot select'; end;
  reset role;

  -- service_role can read and delete
  set local role service_role;
  select count(*) into n from public.ghl_intake_log;
  if n <> 7 then raise exception 'FAIL service_role sees % rows, expected 7', n; end if;
  delete from public.ghl_intake_log where outcome = 'error';
  reset role;
  raise notice 'PASS service_role can read and delete';

  -- RLS is on
  select relrowsecurity into ok from pg_class where oid = 'public.ghl_intake_log'::regclass;
  if not ok then raise exception 'FAIL rls off'; end if;
  raise notice 'PASS rls enabled';

  -- deleting the org cascades
  delete from public.orgs where id = 'a16a0000-a000-4000-8000-0000000000aa';
  select count(*) into n from public.ghl_intake_log;
  if n <> 0 then raise exception 'FAIL cascade left % rows', n; end if;
  raise notice 'PASS org delete cascades';
end $$;

rollback;

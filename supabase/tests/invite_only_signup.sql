-- Acceptance tests for TASK-L4's invite-only signup trigger
-- (20260925000300_invite_only_signup.sql). Assumes that migration is already applied -- does not
-- replay migration DDL, same convention as the other files in this directory. Everything runs
-- inside one transaction, ROLLED BACK at the end.
--
-- Token hashing: org-invite-create/org-invite-accept compute token_hash as
-- hex(sha256(raw_token)) via crypto.subtle in TS; extensions.digest(raw_token, 'sha256') is the
-- same algorithm, so a raw token string chosen here and its hash inserted directly into
-- org_invites.token_hash exercises the exact same lookup the trigger performs against a real,
-- edge-function-issued invite.

begin;

create or replace function public._test_expect_count(p_label text, p_query text, p_expected bigint)
returns void language plpgsql as $$
declare v_actual bigint;
begin
  execute p_query into v_actual;
  if v_actual is distinct from p_expected then
    raise exception 'FAIL [%]: expected % row(s), got % -- %', p_label, p_expected, v_actual, p_query;
  end if;
  raise notice 'PASS [%]: % row(s) as expected', p_label, v_actual;
end;
$$;

create or replace function public._test_expect_error(p_label text, p_query text)
returns void language plpgsql as $$
declare v_errored boolean := false;
begin
  begin
    execute p_query;
  exception
    when others then
      v_errored := true;
  end;
  if not v_errored then
    raise exception 'FAIL [%]: statement succeeded but should have errored', p_label;
  end if;
  raise notice 'PASS [%]: statement correctly errored', p_label;
end;
$$;

create or replace function public._test_expect_ok(p_label text, p_query text)
returns void language plpgsql as $$
begin
  execute p_query;
  raise notice 'PASS [%]: statement succeeded as expected', p_label;
exception
  when others then
    raise exception 'FAIL [%]: expected success, got error -- % (%)', p_label, sqlerrm, p_query;
end;
$$;

-- Bootstrap an inviting org + owner, the same hand-built way rls_org_matrix.sql now does it
-- (the trigger being under test can no longer auto-provision a self-serve org). ------------

alter table auth.users disable trigger on_auth_user_created;
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, is_sso_user, is_anonymous
) values (
  '00000000-0000-0000-0000-000000000000', '9c4b1000-a000-4000-8000-00000000000a', 'authenticated',
  'authenticated', 'l4-owner@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(),
  now(), '', '', false, false
);
alter table auth.users enable trigger on_auth_user_created;

insert into public.orgs (id, name, created_by) values
  ('9c4b1001-a000-4000-8000-00000000000a', 'L4 Test Org', '9c4b1000-a000-4000-8000-00000000000a');
insert into public.profiles (user_id, active_org_id) values
  ('9c4b1000-a000-4000-8000-00000000000a', '9c4b1001-a000-4000-8000-00000000000a');
insert into public.org_members (org_id, user_id, role, status) values
  ('9c4b1001-a000-4000-8000-00000000000a', '9c4b1000-a000-4000-8000-00000000000a', 'owner', 'active');

-- Four invites: valid/pending, expired, already-accepted, and one whose email won't match the
-- signup attempt below. ---------------------------------------------------------------------

insert into public.org_invites (id, org_id, email, role, token_hash, invited_by, expires_at, accepted_at) values
  ('9c4b1002-a000-4000-8000-00000000000a', '9c4b1001-a000-4000-8000-00000000000a', 'invitee-valid@example.com', 'agent',
    encode(extensions.digest('l4-valid-token', 'sha256'), 'hex'), '9c4b1000-a000-4000-8000-00000000000a', now() + interval '7 days', null),
  ('9c4b1002-a000-4000-8000-00000000000b', '9c4b1001-a000-4000-8000-00000000000a', 'invitee-expired@example.com', 'agent',
    encode(extensions.digest('l4-expired-token', 'sha256'), 'hex'), '9c4b1000-a000-4000-8000-00000000000a', now() - interval '1 hour', null),
  ('9c4b1002-a000-4000-8000-00000000000c', '9c4b1001-a000-4000-8000-00000000000a', 'invitee-used@example.com', 'admin',
    encode(extensions.digest('l4-used-token', 'sha256'), 'hex'), '9c4b1000-a000-4000-8000-00000000000a', now() + interval '7 days', now() - interval '1 minute'),
  ('9c4b1002-a000-4000-8000-00000000000d', '9c4b1001-a000-4000-8000-00000000000a', 'invitee-other@example.com', 'agent',
    encode(extensions.digest('l4-mismatch-token', 'sha256'), 'hex'), '9c4b1000-a000-4000-8000-00000000000a', now() + interval '7 days', null);

-- 1. No invite_token at all -> rejected (this is the entire point of TASK-L4: no more open
--    self-serve signup, not even for a brand-new company's first/owner account). -----------

select public._test_expect_error(
  'no invite_token -> signup rejected',
  $q$insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous) values ('00000000-0000-0000-0000-000000000000', '9c4b1003-a000-4000-8000-000000000001', 'authenticated', 'authenticated', 'no-token@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false)$q$
);

-- 2. A syntactically-present but made-up invite_token -> rejected (not just "is it non-null",
--    the old trigger's whole check) ----------------------------------------------------------

select public._test_expect_error(
  'garbage invite_token -> signup rejected',
  $q$insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous) values ('00000000-0000-0000-0000-000000000000', '9c4b1003-a000-4000-8000-000000000002', 'authenticated', 'authenticated', 'garbage-token@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"not-a-real-token"}', now(), now(), '', '', false, false)$q$
);

-- 3. Expired invite -> rejected -----------------------------------------------------------

select public._test_expect_error(
  'expired invite_token -> signup rejected',
  $q$insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous) values ('00000000-0000-0000-0000-000000000000', '9c4b1003-a000-4000-8000-000000000003', 'authenticated', 'authenticated', 'invitee-expired@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"l4-expired-token"}', now(), now(), '', '', false, false)$q$
);

-- 4. Already-accepted invite -> rejected (no replaying a used invite link) ----------------

select public._test_expect_error(
  'already-accepted invite_token -> signup rejected',
  $q$insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous) values ('00000000-0000-0000-0000-000000000000', '9c4b1003-a000-4000-8000-000000000004', 'authenticated', 'authenticated', 'invitee-used@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"l4-used-token"}', now(), now(), '', '', false, false)$q$
);

-- 5. Valid invite, but the signing-up email doesn't match the invited email -> rejected --

select public._test_expect_error(
  'valid token, mismatched email -> signup rejected',
  $q$insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous) values ('00000000-0000-0000-0000-000000000000', '9c4b1003-a000-4000-8000-000000000005', 'authenticated', 'authenticated', 'someone-else@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"l4-mismatch-token"}', now(), now(), '', '', false, false)$q$
);

-- None of the 5 rejected attempts left a profile behind (the whole auth.users insert rolled
-- back, not just skipped a later step) ---------------------------------------------------

select public._test_expect_count(
  'no orphaned profiles from any rejected signup',
  $q$select count(*) from public.profiles where user_id in ('9c4b1003-a000-4000-8000-000000000001','9c4b1003-a000-4000-8000-000000000002','9c4b1003-a000-4000-8000-000000000003','9c4b1003-a000-4000-8000-000000000004','9c4b1003-a000-4000-8000-000000000005')$q$,
  0
);

-- 6. Valid, unexpired, unaccepted invite, matching email -> signup succeeds, trigger creates
--    only the profile (no org yet -- that is still org-invite-accept's job, unchanged). ----

select public._test_expect_ok(
  'valid invite_token + matching email -> signup succeeds',
  $q$insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous) values ('00000000-0000-0000-0000-000000000000', '9c4b1003-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'invitee-valid@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"l4-valid-token","first_name":"Val","last_name":"Idson"}', now(), now(), '', '', false, false)$q$
);

select public._test_expect_count(
  'profile created for the accepted signup, no org yet',
  $q$select count(*) from public.profiles where user_id = '9c4b1003-a000-4000-8000-00000000000a' and active_org_id is null and first_name = 'Val'$q$,
  1
);

select public._test_expect_count(
  'no org_members row yet -- that is org-invite-accept''s step, not the trigger''s',
  $q$select count(*) from public.org_members where user_id = '9c4b1003-a000-4000-8000-00000000000a'$q$,
  0
);

-- 7. Replaying org-invite-accept's own two writes (it is a TS edge function, not something a SQL
--    script can call directly) to prove the full round trip lands the user as an active member
--    under the invited role -- this is the "member created as the invited role" half of the
--    acceptance criteria. ---------------------------------------------------------------------

select public._test_expect_ok(
  'org-invite-accept-equivalent: membership insert',
  $q$insert into public.org_members (org_id, user_id, role, status) select org_id, '9c4b1003-a000-4000-8000-00000000000a', role, 'active' from public.org_invites where id = '9c4b1002-a000-4000-8000-00000000000a'$q$
);
select public._test_expect_ok(
  'org-invite-accept-equivalent: active_org_id set',
  $q$update public.profiles set active_org_id = '9c4b1001-a000-4000-8000-00000000000a' where user_id = '9c4b1003-a000-4000-8000-00000000000a'$q$
);

select public._test_expect_count(
  'invited user is now an active agent member of the inviting org',
  $q$select count(*) from public.org_members where user_id = '9c4b1003-a000-4000-8000-00000000000a' and org_id = '9c4b1001-a000-4000-8000-00000000000a' and role = 'agent' and status = 'active'$q$,
  1
);

rollback;

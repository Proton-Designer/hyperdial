-- Acceptance tests for TASK-P2-P2 (campaign settings editor, agent assignment, soft-delete,
-- dial-session status enforcement from 20260924001500_campaign_settings_agents_delete.sql).
-- Assumes that migration is already applied -- does not replay migration DDL, same
-- convention as contacts_e164_tz_dnc.sql / rls_org_matrix.sql / dialer_schema_rpcs.sql.
-- Everything runs inside one transaction, ROLLED BACK at the end.

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

create or replace function public._test_expect_affected(p_label text, p_query text, p_expected int)
returns void language plpgsql as $$
declare v_n int;
begin
  execute p_query;
  get diagnostics v_n = row_count;
  if v_n is distinct from p_expected then
    raise exception 'FAIL [%]: expected % row(s) affected, got % -- %', p_label, p_expected, v_n, p_query;
  end if;
  raise notice 'PASS [%]: % row(s) affected as expected', p_label, v_n;
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

-- Fixtures: org A (owner, admin, agent), campaign A (active), campaign P (paused),
-- agent assigned to campaign A only. -------------------------------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '9c2fee00-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p2p2-owner-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c2fee00-a000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'p2p2-admin-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"t"}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c2fee00-a000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'p2p2-agent-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"t"}', now(), now(), '', '', false, false);

select active_org_id as org_a from public.profiles where user_id = '9c2fee00-a000-4000-8000-00000000000a' \gset

insert into public.org_members (org_id, user_id, role, status) values (:'org_a', '9c2fee00-a000-4000-8000-00000000000b', 'admin', 'active');
update public.profiles set active_org_id = :'org_a' where user_id = '9c2fee00-a000-4000-8000-00000000000b';
insert into public.org_members (org_id, user_id, role, status) values (:'org_a', '9c2fee00-a000-4000-8000-00000000000c', 'agent', 'active');
update public.profiles set active_org_id = :'org_a' where user_id = '9c2fee00-a000-4000-8000-00000000000c';

insert into public.campaigns (id, org_id, user_id, name, status) values
  ('9c2fee02-a000-4000-8000-00000000000a', :'org_a', '9c2fee00-a000-4000-8000-00000000000a', 'Campaign A (active)', 'active'),
  ('9c2fee02-a000-4000-8000-00000000000b', :'org_a', '9c2fee00-a000-4000-8000-00000000000a', 'Campaign P (paused)', 'paused');
insert into public.campaign_agents (campaign_id, user_id, org_id)
  values ('9c2fee02-a000-4000-8000-00000000000a', '9c2fee00-a000-4000-8000-00000000000c', :'org_a');

-- 1. campaigns_with_stats exposes the E1 settings columns with their defaults -------

select public._test_expect_count(
  'campaigns_with_stats exposes settings defaults',
  $q$select count(*) from public.campaigns_with_stats where id = '9c2fee02-a000-4000-8000-00000000000a' and lines = 3 and amd_mode = 'off' and max_attempts = 3 and retry_interval_minutes = 120 and calling_window_start = '08:00' and calling_window_end = '21:00' and abandon_message_enabled = true$q$,
  1
);

-- 2. Owner/admin can edit the settings columns; an agent cannot (RLS-enforced, not just
--    UI-hidden) ------------------------------------------------------------------------

select set_config('request.jwt.claims', '{"sub":"9c2fee00-a000-4000-8000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_affected(
  'owner: settings update persists',
  $q$update public.campaigns set lines = 5, amd_mode = 'on', max_attempts = 7, retry_interval_minutes = 45, calling_window_start = '09:00', calling_window_end = '18:00', abandon_message_enabled = false where id = '9c2fee02-a000-4000-8000-00000000000a'$q$,
  1
);
reset role;

select public._test_expect_count(
  'owner settings update actually took effect',
  $q$select count(*) from public.campaigns where id = '9c2fee02-a000-4000-8000-00000000000a' and lines = 5 and amd_mode = 'on' and max_attempts = 7$q$,
  1
);

select set_config('request.jwt.claims', '{"sub":"9c2fee00-a000-4000-8000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_affected(
  'agent: settings update denied (0 rows, RLS)',
  $q$update public.campaigns set lines = 1 where id = '9c2fee02-a000-4000-8000-00000000000a'$q$,
  0
);
reset role;

-- 3. caller_id_number_id must belong to the campaign's own org (E1 trigger, still active) --

insert into public.orgs (id, name, created_by) values ('9c2fee03-b000-4000-8000-00000000000a', 'Org B (foreign numbers)', '9c2fee00-a000-4000-8000-00000000000a');
insert into public.user_phone_numbers (id, org_id, user_id, phone_number, telnyx_phone_number_id)
  values ('9c2fee04-b000-4000-8000-00000000000a', '9c2fee03-b000-4000-8000-00000000000a', '9c2fee00-a000-4000-8000-00000000000a', '+14155559999', 'tnx-foreign');

select public._test_expect_error(
  'caller_id_number_id from a foreign org is rejected',
  $q$update public.campaigns set caller_id_number_id = '9c2fee04-b000-4000-8000-00000000000a' where id = '9c2fee02-a000-4000-8000-00000000000a'$q$
);

-- 4. Agent assignment: owner/admin can assign and unassign; already-existing RLS
--    (TASK-P1-01), smoke-tested end to end against this task's own fixtures ----------

select set_config('request.jwt.claims', '{"sub":"9c2fee00-a000-4000-8000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_affected(
  'admin: assign a second agent to campaign P',
  $q$insert into public.campaign_agents (campaign_id, user_id, org_id) select '9c2fee02-a000-4000-8000-00000000000b', '9c2fee00-a000-4000-8000-00000000000c', org_id from public.campaigns where id = '9c2fee02-a000-4000-8000-00000000000b'$q$,
  1
);
select public._test_expect_affected(
  'admin: unassign that agent',
  $q$delete from public.campaign_agents where campaign_id = '9c2fee02-a000-4000-8000-00000000000b' and user_id = '9c2fee00-a000-4000-8000-00000000000c'$q$,
  1
);
reset role;

select set_config('request.jwt.claims', '{"sub":"9c2fee00-a000-4000-8000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_error(
  'agent: cannot assign themselves to a campaign',
  $q$insert into public.campaign_agents (campaign_id, user_id, org_id) select '9c2fee02-a000-4000-8000-00000000000b', '9c2fee00-a000-4000-8000-00000000000c', org_id from public.campaigns where id = '9c2fee02-a000-4000-8000-00000000000b'$q$
);
reset role;

-- 5. Soft delete: owner can soft-delete; hard DELETE is refused entirely (no policy); a
--    soft-deleted campaign disappears from campaigns_with_stats but call_legs/dial_sessions
--    referencing it are untouched (no cascade fired) ------------------------------------

select set_config('request.jwt.claims', '{"sub":"9c2fee00-a000-4000-8000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_affected(
  'owner: soft-delete (set deleted_at) succeeds',
  $q$update public.campaigns set deleted_at = now() where id = '9c2fee02-a000-4000-8000-00000000000b'$q$,
  1
);
select public._test_expect_affected(
  'hard DELETE on campaigns is refused for everyone (no policy)',
  $q$delete from public.campaigns where id = '9c2fee02-a000-4000-8000-00000000000a'$q$,
  0
);
reset role;

select public._test_expect_count(
  'soft-deleted campaign hidden from campaigns_with_stats',
  $q$select count(*) from public.campaigns_with_stats where id = '9c2fee02-a000-4000-8000-00000000000b'$q$,
  0
);
select public._test_expect_count(
  'soft-deleted campaign row itself still exists (not actually gone)',
  $q$select count(*) from public.campaigns where id = '9c2fee02-a000-4000-8000-00000000000b'$q$,
  1
);

select set_config('request.jwt.claims', '{"sub":"9c2fee00-a000-4000-8000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_affected(
  'agent: cannot soft-delete a campaign (0 rows, RLS)',
  $q$update public.campaigns set deleted_at = now() where id = '9c2fee02-a000-4000-8000-00000000000a'$q$,
  0
);
reset role;

-- 6. dial_sessions BEFORE INSERT trigger: active campaign OK; paused/deleted rejected ----

select public._test_expect_affected(
  'dial_sessions insert on active campaign succeeds',
  $q$insert into public.dial_sessions (org_id, campaign_id, agent_id) select org_id, id, '9c2fee00-a000-4000-8000-00000000000a' from public.campaigns where id = '9c2fee02-a000-4000-8000-00000000000a'$q$,
  1
);

update public.campaigns set status = 'paused' where id = '9c2fee02-a000-4000-8000-00000000000a';
select public._test_expect_error(
  'dial_sessions insert on paused campaign is rejected',
  $q$insert into public.dial_sessions (org_id, campaign_id, agent_id) select org_id, id, '9c2fee00-a000-4000-8000-00000000000a' from public.campaigns where id = '9c2fee02-a000-4000-8000-00000000000a'$q$
);
update public.campaigns set status = 'active' where id = '9c2fee02-a000-4000-8000-00000000000a';

select public._test_expect_error(
  'dial_sessions insert on soft-deleted campaign is rejected',
  $q$insert into public.dial_sessions (org_id, campaign_id, agent_id) select org_id, id, '9c2fee00-a000-4000-8000-00000000000a' from public.campaigns where id = '9c2fee02-a000-4000-8000-00000000000b'$q$
);

rollback;

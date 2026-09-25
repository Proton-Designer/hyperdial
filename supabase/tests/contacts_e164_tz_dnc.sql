-- Acceptance tests for TASK-P2-P1 (contacts.phone_raw, private.area_code_timezones +
-- timezone backfill, the conditional per-org phone dedupe index, and the agent DNC-only
-- update trigger from 20260924001300_contacts_e164_tz_dnc.sql). Assumes that migration is
-- already applied -- this does not replay migration DDL, same convention as
-- rls_org_matrix.sql / dialer_schema_rpcs.sql / ghl_integration_outbox.sql. Everything runs
-- inside one transaction, ROLLED BACK at the end, so no fixtures or helper functions are
-- left behind regardless of pass/fail.
--
-- Technique: same as rls_org_matrix.sql -- `SET LOCAL ROLE authenticated` +
-- set_config('request.jwt.claims', ...) for a real user's RLS, and
-- set_config('request.jwt.claims', '{"role":"service_role"}', true) (Postgres role stays
-- postgres/superuser, which already bypasses RLS and schema grants -- only auth.role() is
-- being faked here, which is all contacts_agent_update_scope actually inspects) to prove
-- the trigger's backend-write exemption the same way a real service-role Edge Function call
-- would exercise it.

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

create or replace function public._test_expect_update_denied(p_label text, p_query text)
returns void language plpgsql as $$
declare v_denied boolean := false;
begin
  begin
    execute p_query;
  exception
    when insufficient_privilege then
      v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL [%]: update succeeded but should have been denied', p_label;
  end if;
  raise notice 'PASS [%]: update correctly denied', p_label;
end;
$$;

create or replace function public._test_expect_insert_denied(p_label text, p_query text)
returns void language plpgsql as $$
declare v_denied boolean := false;
begin
  begin
    execute p_query;
  exception
    when unique_violation or insufficient_privilege then
      v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL [%]: insert succeeded but should have been denied', p_label;
  end if;
  raise notice 'PASS [%]: insert correctly denied', p_label;
end;
$$;

-- Fixtures: org A (owner, admin, agent; agent assigned to campaign A -> contact A1 only),
-- org B (owner, one contact) -----------------------------------------------------------
--
-- TASK-L8: 20260925000300_invite_only_signup.sql's on_auth_user_created trigger now validates a
-- real org_invites token -- this file's old "no token = self-serve org" / "any non-null token =
-- already invited" shortcuts no longer run those side effects, they just error. `postgres` is not
-- the owner of auth.users on live (only supabase_auth_admin is, so `alter table ... disable
-- trigger` fails there), but it DOES own the trigger FUNCTION -- swap that to a no-op instead,
-- same live-runnable technique as audit/L4/dryrun.sql, then build org/profile/membership by hand
-- (what org-invite-accept would have done after a real invited signup), then restore the real
-- function so anything later in this file that inserts into auth.users still gets real behavior.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $l8fx$
begin
  return new;
end;
$l8fx$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '9c1fee00-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p2p1-owner-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c1fee00-a000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'p2p1-admin-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c1fee00-a000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'p2p1-agent-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c1fee00-b000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p2p1-owner-b@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_invite record;
begin
  v_token := new.raw_user_meta_data ->> 'invite_token';
  if v_token is null or btrim(v_token) = '' then
    raise exception 'Sign-up is invite-only. Ask your team owner or admin for an invite link.';
  end if;
  select id, email, expires_at, accepted_at
    into v_invite
    from public.org_invites
   where token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex');
  if not found then
    raise exception 'This invite link is not valid.';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'This invite has already been used.';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'This invite has expired. Ask your team to send a new one.';
  end if;
  if lower(new.email) is distinct from lower(v_invite.email) then
    raise exception 'This invite was sent to a different email address.';
  end if;
  insert into public.profiles (user_id, first_name, last_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'first_name', ''), nullif(new.raw_user_meta_data ->> 'last_name', ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

insert into public.orgs (id, name, created_by) values
  ('9c1fee00-a000-4000-8000-0000000000aa', 'P2P1 Org A', '9c1fee00-a000-4000-8000-00000000000a'),
  ('9c1fee00-b000-4000-8000-0000000000aa', 'P2P1 Org B', '9c1fee00-b000-4000-8000-00000000000a');

select '9c1fee00-a000-4000-8000-0000000000aa' as org_a \gset
select '9c1fee00-b000-4000-8000-0000000000aa' as org_b \gset

insert into public.profiles (user_id, active_org_id) values
  ('9c1fee00-a000-4000-8000-00000000000a', :'org_a'),
  ('9c1fee00-a000-4000-8000-00000000000b', :'org_a'),
  ('9c1fee00-a000-4000-8000-00000000000c', :'org_a'),
  ('9c1fee00-b000-4000-8000-00000000000a', :'org_b');

insert into public.org_members (org_id, user_id, role, status) values
  (:'org_a', '9c1fee00-a000-4000-8000-00000000000a', 'owner', 'active'),
  (:'org_a', '9c1fee00-a000-4000-8000-00000000000b', 'admin', 'active'),
  (:'org_a', '9c1fee00-a000-4000-8000-00000000000c', 'agent', 'active'),
  (:'org_b', '9c1fee00-b000-4000-8000-00000000000a', 'owner', 'active');

insert into public.contacts (id, org_id, user_id, first_name, phone_number, notes) values
  ('9c1fee01-a000-4000-8000-00000000000a', :'org_a', '9c1fee00-a000-4000-8000-00000000000a', 'Assigned Contact', '+14155551111', 'orig notes'),
  ('9c1fee01-a000-4000-8000-00000000000b', :'org_a', '9c1fee00-a000-4000-8000-00000000000a', 'Unassigned Contact', '+14155552222', 'orig notes');
insert into public.campaigns (id, org_id, user_id, name)
  values ('9c1fee02-a000-4000-8000-00000000000a', :'org_a', '9c1fee00-a000-4000-8000-00000000000a', 'Campaign A');
insert into public.campaign_leads (campaign_id, contact_id, org_id)
  values ('9c1fee02-a000-4000-8000-00000000000a', '9c1fee01-a000-4000-8000-00000000000a', :'org_a');
insert into public.campaign_agents (campaign_id, user_id, org_id)
  values ('9c1fee02-a000-4000-8000-00000000000a', '9c1fee00-a000-4000-8000-00000000000c', :'org_a');
insert into public.contacts (id, org_id, user_id, first_name, phone_number)
  values ('9c1fee01-b000-4000-8000-00000000000a', :'org_b', '9c1fee00-b000-4000-8000-00000000000a', 'Org B Contact', '+14155553333');

-- 1. private.area_code_timezones is seeded and matches _shared/area-code-tz.ts's known
--    entries (a drift check, not exhaustive: this only proves the two sources still agree
--    on the handful of documented exceptions, not the full 400+-row list) -------------

select public._test_expect_count('area_code_timezones: seeded', 'select count(*) from private.area_code_timezones', 422);
select public._test_expect_count('area_code_timezones: TX 915 override', $q$select count(*) from private.area_code_timezones where area_code = '915' and timezone = 'America/Denver'$q$, 1);
select public._test_expect_count('area_code_timezones: IN 219 override', $q$select count(*) from private.area_code_timezones where area_code = '219' and timezone = 'America/Chicago'$q$, 1);

-- 2. Backfill UPDATE logic (acceptance #2: tested on seeded legacy-shaped rows). Re-runs
--    the exact statement 20260924001300 uses, against freshly seeded rows that mimic
--    contacts that predate this feature (no timezone). Run under a service_role JWT
--    context since contacts_agent_update_scope now exists and would otherwise treat this
--    bulk write as an unprivileged edit -- exactly the ordering gotcha noted in the
--    migration's own comments. ------------------------------------------------------

insert into public.contacts (id, org_id, user_id, phone_number, timezone) values
  ('9c1fbf01-a000-4000-8000-00000000000a', :'org_a', '9c1fee00-a000-4000-8000-00000000000a', '+12125551111', null),   -- 212 NYC -> should backfill
  ('9c1fbf01-a000-4000-8000-00000000000b', :'org_a', '9c1fee00-a000-4000-8000-00000000000a', '+13125552222', 'America/Denver'), -- already set -> must not change
  ('9c1fbf01-a000-4000-8000-00000000000c', :'org_a', '9c1fee00-a000-4000-8000-00000000000a', '+15555553333', null),   -- 555 not a real area code -> stays null
  ('9c1fbf01-a000-4000-8000-00000000000d', :'org_a', '9c1fee00-a000-4000-8000-00000000000a', 'not-a-real-number', null); -- malformed -> stays null, no error

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
update public.contacts c
set timezone = t.timezone
from private.area_code_timezones t
where c.timezone is null
  and c.phone_number ~ '^\+1[0-9]{10}$'
  and t.area_code = substring(c.phone_number from 3 for 3);

select public._test_expect_count('backfill: 212 NYC -> Eastern', $q$select count(*) from public.contacts where id = '9c1fbf01-a000-4000-8000-00000000000a' and timezone = 'America/New_York'$q$, 1);
select public._test_expect_count('backfill: pre-set timezone untouched', $q$select count(*) from public.contacts where id = '9c1fbf01-a000-4000-8000-00000000000b' and timezone = 'America/Denver'$q$, 1);
select public._test_expect_count('backfill: unmapped area code stays null', $q$select count(*) from public.contacts where id = '9c1fbf01-a000-4000-8000-00000000000c' and timezone is null$q$, 1);
select public._test_expect_count('backfill: malformed number stays null, no error', $q$select count(*) from public.contacts where id = '9c1fbf01-a000-4000-8000-00000000000d' and timezone is null$q$, 1);

delete from public.contacts where id in (
  '9c1fbf01-a000-4000-8000-00000000000a', '9c1fbf01-a000-4000-8000-00000000000b',
  '9c1fbf01-a000-4000-8000-00000000000c', '9c1fbf01-a000-4000-8000-00000000000d'
);

-- 3. Per-org phone dedupe index is a real active constraint (proves the migration's
--    duplicate-free-data branch actually took the unique-index path against this repo's
--    current data, not just that the index exists in some inert form) --------------

select public._test_expect_insert_denied(
  'dedupe: duplicate (org_id, phone_number) rejected',
  $q$insert into public.contacts (org_id, user_id, phone_number) select org_id, user_id, '+14155551111' from public.contacts where id = '9c1fee01-a000-4000-8000-00000000000a'$q$
);
select public._test_expect_count(
  'dedupe: same phone number, different org, is fine',
  $q$select count(*) from public.contacts where phone_number = '+14155551111'$q$,
  1
);

-- 4. Agent DNC-only update scope (acceptance #4: an agent can set DNC only on contacts
--    they can see) --------------------------------------------------------------------

-- Owner: full-row update on any org A contact.
select set_config('request.jwt.claims', '{"sub":"9c1fee00-a000-4000-8000-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_affected('owner: full-row update', $q$update public.contacts set business_name = 'Owner Edit', dnc = true where id = '9c1fee01-a000-4000-8000-00000000000a'$q$, 1);
reset role;

-- Admin: full-row update on any org A contact.
select set_config('request.jwt.claims', '{"sub":"9c1fee00-a000-4000-8000-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_affected('admin: full-row update', $q$update public.contacts set notes = 'admin edit', dnc = false where id = '9c1fee01-a000-4000-8000-00000000000b'$q$, 1);
reset role;

-- Agent: CAN set dnc on the contact they're assigned to (via campaign_agents).
select set_config('request.jwt.claims', '{"sub":"9c1fee00-a000-4000-8000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_affected('agent: dnc update on assigned contact succeeds', $q$update public.contacts set dnc = true where id = '9c1fee01-a000-4000-8000-00000000000a'$q$, 1);
reset role;

-- Agent: CANNOT change any other column, even on a contact they can see (trigger blocks --
-- 42501, not a silent no-op).
select set_config('request.jwt.claims', '{"sub":"9c1fee00-a000-4000-8000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_update_denied('agent: non-dnc update on assigned contact is rejected', $q$update public.contacts set business_name = 'Agent Should Not' where id = '9c1fee01-a000-4000-8000-00000000000a'$q$);
reset role;

-- Agent: dnc update on a contact NOT reachable through their campaigns matches zero rows
-- (RLS USING filters it out before the trigger even has a row to inspect) -- "only on
-- contacts they can see" is an access boundary, not just a column boundary.
select set_config('request.jwt.claims', '{"sub":"9c1fee00-a000-4000-8000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_affected('agent: dnc update on unassigned contact matches 0 rows', $q$update public.contacts set dnc = true where id = '9c1fee01-a000-4000-8000-00000000000b'$q$, 0);
reset role;

-- Agent: cannot reach org B's contact at all (tenant isolation, sanity check).
select set_config('request.jwt.claims', '{"sub":"9c1fee00-a000-4000-8000-00000000000c","role":"authenticated"}', true);
set local role authenticated;
select public._test_expect_affected('agent: org B contact unreachable', $q$update public.contacts set dnc = true where id = '9c1fee01-b000-4000-8000-00000000000a'$q$, 0);
reset role;

-- service_role: full-row update on any contact, any org (dialer-engine.ts / telnyx-webhook
-- write contacts columns other than dnc this way).
select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select public._test_expect_affected('service_role: full-row update bypasses the agent-scope trigger', $q$update public.contacts set business_name = 'Service Role Edit', notes = 'engine-written' where id = '9c1fee01-b000-4000-8000-00000000000a'$q$, 1);

-- No JWT context at all (auth.role() is null): a plain migration-role/SECURITY DEFINER-RPC/
-- future pg_cron-job UPDATE, same shape as this migration's own timezone backfill. Must
-- succeed -- auth.role() is distinct from 'authenticated' is the only condition that
-- exempts it, not an explicit allowlist of caller identities.
select set_config('request.jwt.claims', '', true);
select public._test_expect_affected('no-JWT context (auth.role() is null): full-row update succeeds', $q$update public.contacts set business_name = 'No-JWT-Context Edit' where id = '9c1fee01-b000-4000-8000-00000000000a'$q$, 1);

rollback;

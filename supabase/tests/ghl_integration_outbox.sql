-- Acceptance tests for TASK-P3-P1 (GHL connect storage + push outbox, design §6).
-- Same technique as rls_org_matrix.sql / dialer_schema_rpcs.sql: SET LOCAL ROLE authenticated +
-- set_config('request.jwt.claims', ...) to exercise real RLS as a real request would; everything
-- runs inside one transaction that is ROLLED BACK at the end, so this file leaves no fixtures
-- behind regardless of pass/fail and is safe to run repeatedly against the shared local DB.

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

create or replace function public._test_expect_eq(p_label text, p_actual text, p_expected text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'PASS [%]: % as expected', p_label, p_actual;
end;
$$;

create or replace function public._test_expect_null(p_label text, p_actual anyelement)
returns void language plpgsql as $$
begin
  if p_actual is not null then
    raise exception 'FAIL [%]: expected null, got %', p_label, p_actual;
  end if;
  raise notice 'PASS [%]: null as expected', p_label;
end;
$$;

-- Fixtures (as postgres; table owner bypasses RLS) --------------------------------------------
-- Two orgs (A, B), each self-serve from the signup trigger. Org A gets an admin (co-member of
-- the owner) and an agent, so the crm_sync_jobs "owner or admin" SELECT policy has both a
-- positive (admin) and negative (agent) case in the same org.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '9c1f9000-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p3p1-owner-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c1f9000-a000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'p3p1-admin-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"test"}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c1f9000-a000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'p3p1-agent-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"test"}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c1f9000-b000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p3p1-owner-b@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);

select active_org_id as org_a from public.profiles where user_id = '9c1f9000-a000-4000-8000-00000000000a' \gset
select active_org_id as org_b from public.profiles where user_id = '9c1f9000-b000-4000-8000-00000000000a' \gset
insert into public.org_members (org_id, user_id, role, status) values
  (:'org_a', '9c1f9000-a000-4000-8000-00000000000b', 'admin', 'active'),
  (:'org_a', '9c1f9000-a000-4000-8000-00000000000c', 'agent', 'active');
update public.profiles set active_org_id = :'org_a'
  where user_id in ('9c1f9000-a000-4000-8000-00000000000b', '9c1f9000-a000-4000-8000-00000000000c');

-- ===============================================================================================
-- 1. enqueue_crm_job no-ops (returns null, writes nothing) without a connected integration
-- ===============================================================================================

select public._test_expect_null('enqueue_crm_job: org A has no GHL integration yet -> null',
  public.enqueue_crm_job(:'org_a', 'disposition', null, null, '{}'::jsonb));

select public._test_expect_count('enqueue_crm_job: nothing was written for org A',
  format('select count(*) from public.crm_sync_jobs where org_id = %L', :'org_a'), 0);

-- ===============================================================================================
-- 2. set_org_ghl_token / get_org_ghl_token: round-trip through Vault, last4 exposed, full token isn't
-- ===============================================================================================

select public.set_org_ghl_token(:'org_a', 'pit-test-token-ABCD1234', 'loc_test123');

select public._test_expect_eq('get_org_ghl_token: round-trips the exact token that was stored',
  public.get_org_ghl_token(:'org_a'), 'pit-test-token-ABCD1234');

select public._test_expect_eq('org_integrations: status is connected after set_org_ghl_token',
  status, 'connected') from public.org_integrations where org_id = :'org_a' and provider = 'ghl';

select public._test_expect_eq('org_integrations: token_last4 is the last 4 chars, not the full token',
  token_last4, '1234') from public.org_integrations where org_id = :'org_a' and provider = 'ghl';

-- Re-set (simulates reconnecting with a new token) reuses the same Vault secret id and updates
-- in place rather than leaving an orphaned secret behind.

select token_secret_id as first_secret_id from public.org_integrations where org_id = :'org_a' and provider = 'ghl' \gset
select public.set_org_ghl_token(:'org_a', 'pit-test-token-WXYZ9999', 'loc_test123');
select public._test_expect_eq('set_org_ghl_token: reconnecting reuses the same Vault secret id',
  token_secret_id::text, :'first_secret_id') from public.org_integrations where org_id = :'org_a' and provider = 'ghl';
select public._test_expect_eq('get_org_ghl_token: returns the newest token after a reconnect',
  public.get_org_ghl_token(:'org_a'), 'pit-test-token-WXYZ9999');

-- ===============================================================================================
-- 3. enqueue_crm_job now succeeds (org A is connected) and the payload round-trips
-- ===============================================================================================

select public.enqueue_crm_job(
  :'org_a', 'disposition', null, null,
  '{"disposition_key":"interested","disposition_label":"Interested","notes":"call back Tuesday","callback_at":null,"agent_name":"Test Agent","duration_seconds":42,"recording_url":null,"transcript_excerpt":null}'::jsonb
) as job_id \gset

select public._test_expect_eq('enqueue_crm_job: writes a queued row',
  status, 'queued') from public.crm_sync_jobs where id = :'job_id';

select public._test_expect_eq('enqueue_crm_job: payload round-trips',
  payload ->> 'disposition_key', 'interested') from public.crm_sync_jobs where id = :'job_id';

-- A disconnected org (never connected) still no-ops -- org B never called set_org_ghl_token.

select public._test_expect_null('enqueue_crm_job: org B (never connected) -> null',
  public.enqueue_crm_job(:'org_b', 'contact_upsert', null, null, '{}'::jsonb));

-- ===============================================================================================
-- 3b. enqueue_crm_job dedupe (20260924001200 fix): a second 'disposition' for the same
--     call_leg_id is a no-op; a different kind for the same call_leg_id, or a null call_leg_id
--     (contact_upsert), is unaffected.
-- ===============================================================================================

select public.enqueue_crm_job(:'org_a', 'disposition', null, '9c1f9000-c000-4000-8000-00000000000a', '{"disposition_key":"no_answer"}'::jsonb) as leg_job_id \gset

select public._test_expect_null('enqueue_crm_job: a second disposition for the same call_leg_id is deduped (no-op)',
  public.enqueue_crm_job(:'org_a', 'disposition', null, '9c1f9000-c000-4000-8000-00000000000a', '{"disposition_key":"retry"}'::jsonb));

select public._test_expect_count('enqueue_crm_job: only the first disposition row for that call_leg_id exists',
  format('select count(*) from public.crm_sync_jobs where call_leg_id = %L and kind = %L', '9c1f9000-c000-4000-8000-00000000000a', 'disposition'), 1);

select public.enqueue_crm_job(:'org_a', 'contact_upsert', null, '9c1f9000-c000-4000-8000-00000000000a', '{}'::jsonb) as other_kind_job_id \gset
select public._test_expect_count('enqueue_crm_job: a different kind for the same call_leg_id is NOT deduped',
  format('select count(*) from public.crm_sync_jobs where call_leg_id = %L', '9c1f9000-c000-4000-8000-00000000000a'), 2);

select public.enqueue_crm_job(:'org_a', 'contact_upsert', null, null, '{}'::jsonb) as null_leg_job_1 \gset
select public.enqueue_crm_job(:'org_a', 'contact_upsert', null, null, '{}'::jsonb) as null_leg_job_2 \gset
select public._test_expect_count('enqueue_crm_job: null call_leg_id rows are never deduped against each other',
  'select count(*) from public.crm_sync_jobs where call_leg_id is null and kind = ''contact_upsert''', 2);

-- ===============================================================================================
-- 4. RLS: org_integrations has zero client policies (nobody reads the base table directly,
--    not even the owner); org_integrations_status is the only client-facing read, scoped by org;
--    crm_sync_jobs is owner/admin-only, org-scoped, never agent-readable
-- ===============================================================================================

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f9000-a000-4000-8000-00000000000a","role":"authenticated"}', true);

select public._test_expect_count('org_integrations: base table is unreadable even by the owner (zero client policies)',
  format('select count(*) from public.org_integrations where org_id = %L', :'org_a'), 0);

select public._test_expect_count('org_integrations_status: owner sees their own org''s row via the safe view',
  format('select count(*) from public.org_integrations_status where org_id = %L', :'org_a'), 1);

select public._test_expect_count('crm_sync_jobs: owner sees their org''s jobs (5: section 3 + the 4 dedupe-section jobs)',
  format('select count(*) from public.crm_sync_jobs where org_id = %L', :'org_a'), 5);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f9000-a000-4000-8000-00000000000b","role":"authenticated"}', true);

select public._test_expect_count('crm_sync_jobs: admin (co-member, not owner) also sees the org''s jobs',
  format('select count(*) from public.crm_sync_jobs where org_id = %L', :'org_a'), 5);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f9000-a000-4000-8000-00000000000c","role":"authenticated"}', true);

select public._test_expect_count('crm_sync_jobs: agent cannot read the org''s job (owner/admin only)',
  format('select count(*) from public.crm_sync_jobs where org_id = %L', :'org_a'), 0);

select public._test_expect_count('org_integrations_status: agent still sees their own org''s status row (any member, not owner/admin only)',
  format('select count(*) from public.org_integrations_status where org_id = %L', :'org_a'), 1);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f9000-b000-4000-8000-00000000000a","role":"authenticated"}', true);

select public._test_expect_count('crm_sync_jobs: org B owner sees none of org A''s jobs',
  format('select count(*) from public.crm_sync_jobs where org_id = %L', :'org_a'), 0);

select public._test_expect_count('org_integrations_status: org B owner sees none of org A''s status',
  format('select count(*) from public.org_integrations_status where org_id = %L', :'org_a'), 0);

reset role;

-- TASK-P3-P3: claim_crm_sync_jobs' lease reclaim (20260924002100). A job stuck in 'running'
-- for over 10 minutes (its worker crashed/timed out before calling complete/fail) is reclaimed
-- as a failed attempt; one still within the lease window is left alone; one already at
-- attempts=7 goes straight to 'dead' instead of being requeued for a 9th try.

insert into public.crm_sync_jobs (id, org_id, provider, kind, payload, status, updated_at)
values ('9c1fb000-a000-4000-8000-000000000001', :'org_a', 'ghl', 'contact_upsert', '{}'::jsonb, 'running', now() - interval '15 minutes');
insert into public.crm_sync_jobs (id, org_id, provider, kind, payload, status, updated_at)
values ('9c1fb000-a000-4000-8000-000000000002', :'org_a', 'ghl', 'contact_upsert', '{}'::jsonb, 'running', now() - interval '2 minutes');
insert into public.crm_sync_jobs (id, org_id, provider, kind, payload, status, updated_at, attempts)
values ('9c1fb000-a000-4000-8000-000000000003', :'org_a', 'ghl', 'contact_upsert', '{}'::jsonb, 'running', now() - interval '15 minutes', 7);

select public.claim_crm_sync_jobs(10);

select public._test_expect_eq('lease: a job stuck >10min is reclaimed to queued',
  (select status from public.crm_sync_jobs where id = '9c1fb000-a000-4000-8000-000000000001'), 'queued');
select public._test_expect_count('lease: the reclaim counts as an attempt',
  $q$select count(*) from public.crm_sync_jobs where id = '9c1fb000-a000-4000-8000-000000000001' and attempts = 1$q$, 1);
select public._test_expect_count('lease: reclaimed job is not itself re-claimed by the same call (backoff pushed next_run_at into the future)',
  $q$select count(*) from public.crm_sync_jobs where id = '9c1fb000-a000-4000-8000-000000000001' and next_run_at > now()$q$, 1);

select public._test_expect_eq('lease: a job stuck <10min is left alone',
  (select status from public.crm_sync_jobs where id = '9c1fb000-a000-4000-8000-000000000002'), 'running');
select public._test_expect_count('lease: the untouched job keeps attempts=0',
  $q$select count(*) from public.crm_sync_jobs where id = '9c1fb000-a000-4000-8000-000000000002' and attempts = 0$q$, 1);

select public._test_expect_eq('lease: a stuck job already at attempts=7 goes straight to dead, not a 9th queued attempt',
  (select status from public.crm_sync_jobs where id = '9c1fb000-a000-4000-8000-000000000003'), 'dead');
select public._test_expect_count('lease: the dead job stops at attempts=8',
  $q$select count(*) from public.crm_sync_jobs where id = '9c1fb000-a000-4000-8000-000000000003' and attempts = 8$q$, 1);

do $$ begin raise notice 'ALL GHL INTEGRATION / OUTBOX ASSERTIONS PASSED'; end $$;

rollback;

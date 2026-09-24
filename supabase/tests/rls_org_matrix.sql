-- RLS matrix for the tenancy migration (TASK-P1-01 acceptance criteria #3): owner, admin, and
-- agent in org A, plus an unrelated owner in org B, exercised against every org-scoped table.
-- Everything runs inside one transaction that is ROLLED BACK at the end, so it leaves no fixtures
-- or helper functions behind regardless of pass/fail.
--
-- Technique: `SET LOCAL ROLE authenticated` (the same non-superuser role PostgREST connects as)
-- plus `set_config('request.jwt.claims', ...)` to make auth.uid() resolve to a chosen test user,
-- exactly like a real request. `RESET ROLE` returns to the superuser session between personas so
-- fixtures can be set up without fighting RLS. Not exhaustive over every (role, verb, table)
-- triple; it covers the tenant boundary on every table plus the role boundaries the design's
-- permission matrix calls out (owner/admin vs agent, and the campaign_leads / campaign_agents
-- cross-org insert checks the auth.md audit specifically flagged).

begin;

-- Assertion helpers, public schema (authenticated always has USAGE there), dropped by the
-- transaction rollback at the end either way.

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

create or replace function public._test_expect_insert_denied(p_label text, p_query text)
returns void language plpgsql as $$
declare
  v_denied boolean := false;
begin
  -- The catch is scoped to just the EXECUTE, not this function's own FAIL raise below --
  -- otherwise a FAIL (insert unexpectedly succeeded) would raise_exception and be swallowed by
  -- the very handler that is supposed to detect denial, silently reporting a false PASS.
  begin
    execute p_query;
  exception
    -- RLS WITH CHECK violations raise insufficient_privilege (42501); the campaign_agents
    -- org-match guard is an ordinary trigger raise_exception (P0001). Both count as "denied".
    when insufficient_privilege or raise_exception then
      v_denied := true;
  end;
  if not v_denied then
    raise exception 'FAIL [%]: insert succeeded but should have been denied', p_label;
  end if;
  raise notice 'PASS [%]: insert correctly denied', p_label;
end;
$$;

create or replace function public._test_expect_insert_ok(p_label text, p_query text)
returns void language plpgsql as $$
begin
  execute p_query;
  raise notice 'PASS [%]: insert correctly allowed', p_label;
end;
$$;

-- Fixtures (as postgres; table owner bypasses RLS) --------------------------

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '9c1f7a11-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'owner-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c1f7a11-a000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'admin-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"test"}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c1f7a11-a000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'agent-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"test"}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9c1f7a11-b000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'owner-b@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);

-- owner-a and owner-b get an org from the signup trigger (no invite_token); admin-a/agent-a only
-- got a profile (invite_token present), so add their org A membership by hand, as accept-invite
-- would.

select active_org_id as org_a from public.profiles where user_id = '9c1f7a11-a000-4000-8000-00000000000a' \gset
select active_org_id as org_b from public.profiles where user_id = '9c1f7a11-b000-4000-8000-00000000000a' \gset

insert into public.org_members (org_id, user_id, role, status) values (:'org_a', '9c1f7a11-a000-4000-8000-00000000000b', 'admin', 'active');
update public.profiles set active_org_id = :'org_a' where user_id = '9c1f7a11-a000-4000-8000-00000000000b';
insert into public.org_members (org_id, user_id, role, status) values (:'org_a', '9c1f7a11-a000-4000-8000-00000000000c', 'agent', 'active');
update public.profiles set active_org_id = :'org_a' where user_id = '9c1f7a11-a000-4000-8000-00000000000c';

-- Business data: org A (owned by owner-a, agent-a assigned to campaign-a only)

insert into public.contacts (id, org_id, user_id, first_name, phone_number)
  values ('9c1f7a11-a001-4000-8000-00000000000a', :'org_a', '9c1f7a11-a000-4000-8000-00000000000a', 'Contact A', '+15551110001');
insert into public.campaigns (id, org_id, user_id, name)
  values ('9c1f7a11-a002-4000-8000-00000000000a', :'org_a', '9c1f7a11-a000-4000-8000-00000000000a', 'Campaign A');
insert into public.campaign_leads (campaign_id, contact_id, org_id)
  values ('9c1f7a11-a002-4000-8000-00000000000a', '9c1f7a11-a001-4000-8000-00000000000a', :'org_a');
insert into public.campaign_agents (campaign_id, user_id, org_id)
  values ('9c1f7a11-a002-4000-8000-00000000000a', '9c1f7a11-a000-4000-8000-00000000000c', :'org_a');
insert into public.user_phone_numbers (id, org_id, user_id, telnyx_phone_number_id, phone_number)
  values ('9c1f7a11-a003-4000-8000-00000000000a', :'org_a', '9c1f7a11-a000-4000-8000-00000000000a', 'tid-a', '+15550001111');
insert into public.notifications (id, org_id, user_id, type, title)
  values ('9c1f7a11-a004-4000-8000-00000000000a', :'org_a', '9c1f7a11-a000-4000-8000-00000000000a', 'test', 'hi');
insert into public.dialer_sessions (id, org_id, user_id, campaign_id)
  values ('9c1f7a11-a005-4000-8000-00000000000a', :'org_a', '9c1f7a11-a000-4000-8000-00000000000a', '9c1f7a11-a002-4000-8000-00000000000a');
insert into public.call_logs (id, org_id, user_id, campaign_id, contact_id, call_control_id)
  values ('9c1f7a11-a006-4000-8000-00000000000a', :'org_a', '9c1f7a11-a000-4000-8000-00000000000a', '9c1f7a11-a002-4000-8000-00000000000a', '9c1f7a11-a001-4000-8000-00000000000a', 'cc-a');
insert into public.call_events (id, org_id, user_id, telnyx_call_session_id, direction, from_number, to_number, started_at)
  values ('9c1f7a11-a007-4000-8000-00000000000a', :'org_a', '9c1f7a11-a000-4000-8000-00000000000a', 'sess-a', 'outbound', '+15550001111', '+15551110001', now());

-- Business data: org B (owned by owner-b, unrelated to org A)

insert into public.contacts (id, org_id, user_id, first_name, phone_number)
  values ('9c1f7a11-b001-4000-8000-00000000000a', :'org_b', '9c1f7a11-b000-4000-8000-00000000000a', 'Contact B', '+15552220001');
insert into public.campaigns (id, org_id, user_id, name)
  values ('9c1f7a11-b002-4000-8000-00000000000a', :'org_b', '9c1f7a11-b000-4000-8000-00000000000a', 'Campaign B');
insert into public.campaign_leads (campaign_id, contact_id, org_id)
  values ('9c1f7a11-b002-4000-8000-00000000000a', '9c1f7a11-b001-4000-8000-00000000000a', :'org_b');

-- ===========================================================================================
-- SELECT visibility matrix: owner-a, admin-a, agent-a, owner-b against org A's rows.
-- ===========================================================================================

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_count('campaigns/owner-a sees campaign A', 'select count(*) from public.campaigns where id = ''9c1f7a11-a002-4000-8000-00000000000a''', 1);
select public._test_expect_count('contacts/owner-a sees contact A', 'select count(*) from public.contacts where id = ''9c1f7a11-a001-4000-8000-00000000000a''', 1);
select public._test_expect_count('campaign_leads/owner-a sees lead A', 'select count(*) from public.campaign_leads where campaign_id = ''9c1f7a11-a002-4000-8000-00000000000a''', 1);
select public._test_expect_count('campaign_agents/owner-a sees assignment A', 'select count(*) from public.campaign_agents where campaign_id = ''9c1f7a11-a002-4000-8000-00000000000a''', 1);
select public._test_expect_count('user_phone_numbers/owner-a sees number A', 'select count(*) from public.user_phone_numbers where id = ''9c1f7a11-a003-4000-8000-00000000000a''', 1);
select public._test_expect_count('notifications/owner-a sees own notification', 'select count(*) from public.notifications where id = ''9c1f7a11-a004-4000-8000-00000000000a''', 1);
select public._test_expect_count('dialer_sessions/owner-a sees org session (owner)', 'select count(*) from public.dialer_sessions where id = ''9c1f7a11-a005-4000-8000-00000000000a''', 1);
select public._test_expect_count('call_logs/owner-a sees org call (owner)', 'select count(*) from public.call_logs where id = ''9c1f7a11-a006-4000-8000-00000000000a''', 1);
select public._test_expect_count('call_events/owner-a sees org event (owner)', 'select count(*) from public.call_events where id = ''9c1f7a11-a007-4000-8000-00000000000a''', 1);
select public._test_expect_count('orgs/owner-a sees own org', format('select count(*) from public.orgs where id = %L', :'org_a'), 1);
select public._test_expect_count('org_members/owner-a sees full roster', format('select count(*) from public.org_members where org_id = %L', :'org_a'), 3);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000b","role":"authenticated"}', true);
select public._test_expect_count('campaigns/admin-a sees campaign A', 'select count(*) from public.campaigns where id = ''9c1f7a11-a002-4000-8000-00000000000a''', 1);
select public._test_expect_count('contacts/admin-a sees contact A', 'select count(*) from public.contacts where id = ''9c1f7a11-a001-4000-8000-00000000000a''', 1);
select public._test_expect_count('dialer_sessions/admin-a sees owner-a''s session (admin sees all)', 'select count(*) from public.dialer_sessions where id = ''9c1f7a11-a005-4000-8000-00000000000a''', 1);
select public._test_expect_count('call_logs/admin-a sees owner-a''s call (admin sees all)', 'select count(*) from public.call_logs where id = ''9c1f7a11-a006-4000-8000-00000000000a''', 1);
select public._test_expect_count('notifications/admin-a does NOT see owner-a''s notification (personal, not org-shared)', 'select count(*) from public.notifications where id = ''9c1f7a11-a004-4000-8000-00000000000a''', 0);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000c","role":"authenticated"}', true);
select public._test_expect_count('campaigns/agent-a sees campaign A (org member)', 'select count(*) from public.campaigns where id = ''9c1f7a11-a002-4000-8000-00000000000a''', 1);
select public._test_expect_count('contacts/agent-a sees contact A (assigned via campaign_agents)', 'select count(*) from public.contacts where id = ''9c1f7a11-a001-4000-8000-00000000000a''', 1);
select public._test_expect_count('campaign_leads/agent-a sees lead A (assigned campaign)', 'select count(*) from public.campaign_leads where campaign_id = ''9c1f7a11-a002-4000-8000-00000000000a''', 1);
select public._test_expect_count('dialer_sessions/agent-a does NOT see owner-a''s session (agent = own only)', 'select count(*) from public.dialer_sessions where id = ''9c1f7a11-a005-4000-8000-00000000000a''', 0);
select public._test_expect_count('call_logs/agent-a does NOT see owner-a''s call (agent = own only)', 'select count(*) from public.call_logs where id = ''9c1f7a11-a006-4000-8000-00000000000a''', 0);
select public._test_expect_count('call_events/agent-a does NOT see owner-a''s event (agent = own only)', 'select count(*) from public.call_events where id = ''9c1f7a11-a007-4000-8000-00000000000a''', 0);
select public._test_expect_count('org_members/agent-a sees full roster (member visibility, not role-gated)', format('select count(*) from public.org_members where org_id = %L', :'org_a'), 3);

-- Negative cases: owner-b, an unrelated org, must see none of org A's rows.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-b000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_count('campaigns/owner-b does NOT see campaign A', 'select count(*) from public.campaigns where id = ''9c1f7a11-a002-4000-8000-00000000000a''', 0);
select public._test_expect_count('contacts/owner-b does NOT see contact A', 'select count(*) from public.contacts where id = ''9c1f7a11-a001-4000-8000-00000000000a''', 0);
select public._test_expect_count('campaign_leads/owner-b does NOT see lead A', 'select count(*) from public.campaign_leads where campaign_id = ''9c1f7a11-a002-4000-8000-00000000000a''', 0);
select public._test_expect_count('campaign_agents/owner-b does NOT see assignment A', 'select count(*) from public.campaign_agents where campaign_id = ''9c1f7a11-a002-4000-8000-00000000000a''', 0);
select public._test_expect_count('user_phone_numbers/owner-b does NOT see number A', 'select count(*) from public.user_phone_numbers where id = ''9c1f7a11-a003-4000-8000-00000000000a''', 0);
select public._test_expect_count('dialer_sessions/owner-b does NOT see session A', 'select count(*) from public.dialer_sessions where id = ''9c1f7a11-a005-4000-8000-00000000000a''', 0);
select public._test_expect_count('call_logs/owner-b does NOT see call A', 'select count(*) from public.call_logs where id = ''9c1f7a11-a006-4000-8000-00000000000a''', 0);
select public._test_expect_count('call_events/owner-b does NOT see event A', 'select count(*) from public.call_events where id = ''9c1f7a11-a007-4000-8000-00000000000a''', 0);
select public._test_expect_count('orgs/owner-b does NOT see org A', format('select count(*) from public.orgs where id = %L', :'org_a'), 0);
select public._test_expect_count('org_members/owner-b does NOT see org A roster', format('select count(*) from public.org_members where org_id = %L', :'org_a'), 0);
select public._test_expect_count('profiles/owner-b does NOT see owner-a''s profile', 'select count(*) from public.profiles where user_id = ''9c1f7a11-a000-4000-8000-00000000000a''', 0);

-- ===========================================================================================
-- Role-boundary and cross-tenant write checks.
-- ===========================================================================================

-- Owner/admin can create campaigns; agent cannot.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000b","role":"authenticated"}', true);
select public._test_expect_insert_ok('campaigns/admin-a can create a campaign',
  format('insert into public.campaigns (org_id, user_id, name) values (%L, %L, %L)', :'org_a', '9c1f7a11-a000-4000-8000-00000000000b', 'Admin-created'));

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000c","role":"authenticated"}', true);
select public._test_expect_insert_denied('campaigns/agent-a cannot create a campaign',
  format('insert into public.campaigns (org_id, user_id, name) values (%L, %L, %L)', :'org_a', '9c1f7a11-a000-4000-8000-00000000000c', 'Agent-created'));

-- Cross-tenant insert: owner-b cannot create a campaign claiming org A.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-b000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_insert_denied('campaigns/owner-b cannot create a campaign in org A',
  format('insert into public.campaigns (org_id, user_id, name) values (%L, %L, %L)', :'org_a', '9c1f7a11-b000-4000-8000-00000000000a', 'Cross-tenant'));

-- Regression check for the auth.md finding: campaign_leads INSERT must verify the contact is in
-- the SAME org as the campaign, not just that the caller owns the campaign.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000b","role":"authenticated"}', true);
select public._test_expect_insert_denied('campaign_leads/admin-a cannot link org B''s contact into org A''s campaign',
  format('insert into public.campaign_leads (campaign_id, contact_id, org_id) values (%L, %L, %L)',
    '9c1f7a11-a002-4000-8000-00000000000a', '9c1f7a11-b001-4000-8000-00000000000a', :'org_a'));

-- campaign_agents validation trigger: org_id must match the campaign's own org. owner-b is
-- legitimately owner of org_b (so the table's RLS INSERT check on org_id alone would pass) --
-- this isolates the trigger's own org-match check, not just RLS.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-b000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_insert_denied('campaign_agents/owner-b cannot attach org B''s id to org A''s campaign (trigger catches the mismatch RLS alone would not)',
  format('insert into public.campaign_agents (campaign_id, user_id, org_id) values (%L, %L, %L)',
    '9c1f7a11-a002-4000-8000-00000000000a', '9c1f7a11-b000-4000-8000-00000000000a', :'org_b'));

-- Agent can update a contact reachable through their assigned campaign; owner-b cannot touch it.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000c","role":"authenticated"}', true);
select public._test_expect_affected('contacts/agent-a can update assigned contact A',
  'update public.contacts set notes = ''touched by agent'' where id = ''9c1f7a11-a001-4000-8000-00000000000a''', 1);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-b000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_affected('contacts/owner-b cannot update contact A (cross-tenant)',
  'update public.contacts set notes = ''hijacked'' where id = ''9c1f7a11-a001-4000-8000-00000000000a''', 0);
select public._test_expect_affected('campaigns/owner-b cannot delete campaign A (cross-tenant)',
  'delete from public.campaigns where id = ''9c1f7a11-a002-4000-8000-00000000000a''', 0);

-- org_members: admin can manage non-owner members but cannot touch or create owner rows.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000b","role":"authenticated"}', true);
select public._test_expect_insert_denied('org_members/admin-a cannot insert a new owner row',
  format('insert into public.org_members (org_id, user_id, role, status) values (%L, %L, %L, %L)',
    :'org_a', '9c1f7a11-b000-4000-8000-00000000000a', 'owner', 'active'));
select public._test_expect_affected('org_members/admin-a cannot demote the owner',
  format('update public.org_members set role = %L where org_id = %L and user_id = %L', 'admin', :'org_a', '9c1f7a11-a000-4000-8000-00000000000a'), 0);
select public._test_expect_affected('org_members/admin-a can disable the agent',
  format('update public.org_members set status = %L where org_id = %L and user_id = %L', 'disabled', :'org_a', '9c1f7a11-a000-4000-8000-00000000000c'), 1);

-- Restore agent-a to active (TASK-P1-03): the profiles.active_org_id WITH CHECK added below now
-- re-validates active_org_id's membership via private.is_org_member on every UPDATE to a profile
-- row, including ones that don't touch active_org_id -- so a disabled member fails WITH CHECK on
-- any self-update while their org_members row stays disabled. That's real, intended behavior (see
-- this task's log), but it would otherwise make the pre-existing "profiles/agent-a can update own
-- profile" test below fail as a side effect of this test having just disabled them, not because
-- of anything that test is actually checking.
reset role;
update public.org_members set status = 'active'
  where org_id = :'org_a' and user_id = '9c1f7a11-a000-4000-8000-00000000000c';

-- orgs: only the owner can rename the org.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000c","role":"authenticated"}', true);
select public._test_expect_affected('orgs/agent-a cannot rename org A',
  format('update public.orgs set name = %L where id = %L', 'Hijacked', :'org_a'), 0);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_affected('orgs/owner-a can rename org A',
  format('update public.orgs set name = %L where id = %L', 'Renamed A', :'org_a'), 1);

-- profiles: everyone edits only their own.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000c","role":"authenticated"}', true);
select public._test_expect_affected('profiles/agent-a can update own profile',
  format('update public.profiles set first_name = %L where user_id = %L', 'Agent', '9c1f7a11-a000-4000-8000-00000000000c'), 1);
select public._test_expect_affected('profiles/agent-a cannot update admin-a''s profile',
  format('update public.profiles set first_name = %L where user_id = %L', 'Hijacked', '9c1f7a11-a000-4000-8000-00000000000b'), 0);

-- ===========================================================================================
-- TASK-P1-03 RLS hardening: org_invites role<>'owner', profiles.active_org_id membership check,
-- and co-member profile visibility (20260924000600).
-- ===========================================================================================

-- org_invites: neither admin nor owner can create/update an invite claiming role='owner' --
-- ownership transfer is a separate, not-yet-built owner-only path, never an invite grant.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000b","role":"authenticated"}', true);
select public._test_expect_insert_denied('org_invites/admin-a cannot create an owner-role invite',
  format('insert into public.org_invites (org_id, email, role, token_hash, invited_by, expires_at) values (%L, %L, %L, %L, %L, now() + interval ''7 days'')',
    :'org_a', 'hijack@example.com', 'owner', 'th-admin-owner-attempt', '9c1f7a11-a000-4000-8000-00000000000b'));

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_insert_denied('org_invites/owner-a cannot create an owner-role invite either',
  format('insert into public.org_invites (org_id, email, role, token_hash, invited_by, expires_at) values (%L, %L, %L, %L, %L, now() + interval ''7 days'')',
    :'org_a', 'hijack2@example.com', 'owner', 'th-owner-owner-attempt', '9c1f7a11-a000-4000-8000-00000000000a'));

select public._test_expect_insert_ok('org_invites/owner-a can create an admin-role invite',
  format('insert into public.org_invites (org_id, email, role, token_hash, invited_by, expires_at) values (%L, %L, %L, %L, %L, now() + interval ''7 days'')',
    :'org_a', 'new-admin@example.com', 'admin', 'th-owner-admin-ok', '9c1f7a11-a000-4000-8000-00000000000a'));

-- Existing invite row (org A, role admin) used below to prove UPDATE also rejects role='owner'.
select id as invite_a from public.org_invites where token_hash = 'th-owner-admin-ok' \gset

-- The existing row (role=admin) passes UPDATE's USING clause fine (owner-a is owner of org A),
-- so this is WITH CHECK rejecting the *new* row's role='owner' -- Postgres raises
-- insufficient_privilege here rather than silently affecting 0 rows (that silent-skip behavior
-- only happens when USING itself already excludes the row -- see the org_members admin-a/owner
-- case above, where the row's *current* role='owner' fails USING before WITH CHECK is even
-- reached).
select public._test_expect_insert_denied('org_invites/owner-a cannot escalate an existing invite to role=owner via UPDATE',
  format('update public.org_invites set role = %L where id = %L', 'owner', :'invite_a'));

-- profiles.active_org_id: can only be set to an org the caller actually belongs to. Same
-- USING-passes-but-WITH-CHECK-fails shape as above: agent-a's own row always passes USING
-- (user_id = auth.uid()), so an invalid active_org_id raises insufficient_privilege, not a
-- silent 0-row update.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000c","role":"authenticated"}', true);
select public._test_expect_insert_denied('profiles/agent-a cannot set active_org_id to org B (not a member)',
  format('update public.profiles set active_org_id = %L where user_id = %L', :'org_b', '9c1f7a11-a000-4000-8000-00000000000c'));
select public._test_expect_affected('profiles/agent-a can set active_org_id to org A (real membership)',
  format('update public.profiles set active_org_id = %L where user_id = %L', :'org_a', '9c1f7a11-a000-4000-8000-00000000000c'), 1);

-- Co-member profile visibility (team roster): admin-a can read agent-a's name; owner-b (no
-- shared org) still cannot -- this repeats the existing owner-b/profiles negative check above,
-- now proving the new policy didn't accidentally widen it.
reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-a000-4000-8000-00000000000b","role":"authenticated"}', true);
select public._test_expect_count('profiles/admin-a sees co-member agent-a''s profile (team roster)',
  'select count(*) from public.profiles where user_id = ''9c1f7a11-a000-4000-8000-00000000000c''', 1);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"9c1f7a11-b000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_count('profiles/owner-b (no shared org) still does NOT see agent-a''s profile',
  'select count(*) from public.profiles where user_id = ''9c1f7a11-a000-4000-8000-00000000000c''', 0);

-- private.ensure_org_for_user: revoked from authenticated -- direct .rpc()-style call denied.
-- NOTE: do not provoke this as an actual EXECUTE-permission error -- calling a function as a role
-- with no EXECUTE grant segfaults this local Postgres image (mem.lessons). Assert the grant state
-- instead of the call.
reset role;
select public._test_expect_count('private.ensure_org_for_user/authenticated has no EXECUTE (revoked, TASK-P1-03)',
  $q$select count(*) from (select has_function_privilege('authenticated', 'private.ensure_org_for_user(uuid)', 'EXECUTE') as ok) s where ok = false$q$, 1);

reset role;
do $$ begin raise notice 'ALL RLS MATRIX ASSERTIONS PASSED'; end $$;
rollback;

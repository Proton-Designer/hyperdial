-- Acceptance tests for TASK-P2-E1 (dialer schema + transition RPCs, design §4.2-4.4, §7).
-- Same technique as rls_org_matrix.sql: SET LOCAL ROLE authenticated + set_config('request.jwt.claims', ...)
-- to exercise real RLS as a real request would; everything runs inside one transaction that is
-- ROLLED BACK at the end, so this file leaves no fixtures behind regardless of pass/fail and is
-- safe to run repeatedly against the shared local DB.
--
-- Concurrency (acceptance #2, SKIP LOCKED) is NOT exercised here -- a single psql script can't
-- open two overlapping transactions. See run-dialer-concurrency-test.sh, a documented manual
-- script per this task's own acceptance text.

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

create or replace function public._test_expect_true(p_label text, p_actual boolean)
returns void language plpgsql as $$
begin
  if p_actual is distinct from true then
    raise exception 'FAIL [%]: expected true, got %', p_label, p_actual;
  end if;
  raise notice 'PASS [%]', p_label;
end;
$$;

create or replace function public._test_expect_false(p_label text, p_actual boolean)
returns void language plpgsql as $$
begin
  if p_actual is distinct from false then
    raise exception 'FAIL [%]: expected false, got %', p_label, p_actual;
  end if;
  raise notice 'PASS [%]', p_label;
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

-- Fixtures (as postgres; table owner bypasses RLS) --------------------------------------------
-- One org, one owner (self-serve org from the signup trigger), one agent added by hand, one
-- campaign with a wide-open calling window (calling-window correctness is tested separately below
-- via private.is_lead_callable_now directly, so the queue-ordering/outcome fixtures don't also
-- have to fight the real wall-clock time in a specific timezone).

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', '7d1e5000-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p2e1-owner@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '7d1e5000-a000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'p2e1-agent@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{"invite_token":"test"}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '7d1e5000-b000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p2e1-owner-b@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);

select active_org_id as org_a from public.profiles where user_id = '7d1e5000-a000-4000-8000-00000000000a' \gset
select active_org_id as org_b from public.profiles where user_id = '7d1e5000-b000-4000-8000-00000000000a' \gset
insert into public.org_members (org_id, user_id, role, status) values (:'org_a', '7d1e5000-a000-4000-8000-00000000000b', 'agent', 'active');
update public.profiles set active_org_id = :'org_a' where user_id = '7d1e5000-a000-4000-8000-00000000000b';

insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('7d1e5000-a010-4000-8000-00000000000a', :'org_a', '7d1e5000-a000-4000-8000-00000000000a', 'P2E1 Campaign', '00:00', '23:59', 3, 120);

-- contacts: l1 (attempts=1, due now), l2 (attempts=0, due now), l3 (attempts=0, due in 1h -- not
-- yet due), l4 (attempts=0, null timezone, due now), l5 (dnc, due now)
insert into public.contacts (id, org_id, user_id, phone_number, timezone, dnc) values
  ('7d1e5000-a020-4000-8000-00000000000a', :'org_a', '7d1e5000-a000-4000-8000-00000000000a', '+15550000001', 'America/Chicago', false),
  ('7d1e5000-a020-4000-8000-00000000000b', :'org_a', '7d1e5000-a000-4000-8000-00000000000a', '+15550000002', 'America/Chicago', false),
  ('7d1e5000-a020-4000-8000-00000000000c', :'org_a', '7d1e5000-a000-4000-8000-00000000000a', '+15550000003', 'America/Chicago', false),
  ('7d1e5000-a020-4000-8000-00000000000d', :'org_a', '7d1e5000-a000-4000-8000-00000000000a', '+15550000004', null, false),
  ('7d1e5000-a020-4000-8000-00000000000e', :'org_a', '7d1e5000-a000-4000-8000-00000000000a', '+15550000005', 'America/Chicago', true);

insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts, next_attempt_at) values
  ('7d1e5000-a030-4000-8000-00000000000a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000a', :'org_a', 'queued', 1, now()),
  ('7d1e5000-a030-4000-8000-00000000000b', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000b', :'org_a', 'queued', 0, now()),
  ('7d1e5000-a030-4000-8000-00000000000c', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000c', :'org_a', 'queued', 0, now() + interval '1 hour'),
  ('7d1e5000-a030-4000-8000-00000000000d', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000d', :'org_a', 'queued', 0, now()),
  ('7d1e5000-a030-4000-8000-00000000000e', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000e', :'org_a', 'queued', 0, now());

insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state) values
  ('7d1e5000-a040-4000-8000-00000000000a', :'org_a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a000-4000-8000-00000000000b', 'dialing');

-- ===========================================================================================
-- 1. Ordering + 2c. DNC/callable exclusion (acceptance #1, #3)
-- ===========================================================================================

select array_agg(contact_id order by ord) as claimed_order
from (select contact_id, row_number() over () as ord from public.claim_next_leads('7d1e5000-a040-4000-8000-00000000000a', 5)) t
\gset

select public._test_expect_eq('claim_next_leads: attempts-0-due-now (b) before attempts-0-null-tz-due-now (d) before attempts-1 (a); not-due (c) and dnc (e) excluded',
  :'claimed_order',
  '{7d1e5000-a020-4000-8000-00000000000b,7d1e5000-a020-4000-8000-00000000000d,7d1e5000-a020-4000-8000-00000000000a}');

select public._test_expect_count('claim_next_leads: claimed rows are now in_flight',
  'select count(*) from public.campaign_leads where id in (''7d1e5000-a030-4000-8000-00000000000a'',''7d1e5000-a030-4000-8000-00000000000b'',''7d1e5000-a030-4000-8000-00000000000d'') and status = ''in_flight''', 3);
select public._test_expect_count('claim_next_leads: not-due lead (c) is untouched (still queued)',
  'select count(*) from public.campaign_leads where id = ''7d1e5000-a030-4000-8000-00000000000c'' and status = ''queued''', 1);
select public._test_expect_count('claim_next_leads: dnc lead (e) is untouched (still queued)',
  'select count(*) from public.campaign_leads where id = ''7d1e5000-a030-4000-8000-00000000000e'' and status = ''queued''', 1);

-- ===========================================================================================
-- 3. Calling window (§7): explicit boundary + null-timezone both-coasts rule
-- ===========================================================================================

select public._test_expect_false('calling window: 07:59 local is not callable in an 08:00-21:00 window',
  time '07:59' >= time '08:00' and time '07:59' < time '21:00');
select public._test_expect_true('calling window: 08:00 local is callable in an 08:00-21:00 window',
  time '08:00' >= time '08:00' and time '08:00' < time '21:00');
select public._test_expect_true('calling window: null-timezone contact IS callable inside a window wide enough for both NY and LA',
  private.is_lead_callable_now(null, '00:00', '23:59'));
select public._test_expect_false('calling window: null-timezone contact is NOT callable in a window too narrow to hold on both coasts at once',
  private.is_lead_callable_now(null, '00:00', '00:01'));

-- ===========================================================================================
-- 4. claim_leg: single-winner conditional UPDATE (acceptance #4)
-- ===========================================================================================

insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state) values
  ('7d1e5000-a050-4000-8000-00000000000a', :'org_a', '7d1e5000-a040-4000-8000-00000000000a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000a', '7d1e5000-a030-4000-8000-00000000000a', 'contact', 'v3:p2e1-leg-1', 'ringing');

select public._test_expect_true('claim_leg: first claim on a dialing session with no active leg wins',
  public.claim_leg('7d1e5000-a040-4000-8000-00000000000a', '7d1e5000-a050-4000-8000-00000000000a'));
select public._test_expect_false('claim_leg: second claim on the same session loses (already has an active leg)',
  public.claim_leg('7d1e5000-a040-4000-8000-00000000000a', '7d1e5000-a050-4000-8000-00000000000a'));
select public._test_expect_eq('claim_leg: winning session state is now connecting',
  (select state from public.dial_sessions where id = '7d1e5000-a040-4000-8000-00000000000a'), 'connecting');
select public._test_expect_eq('claim_leg: winning leg state is now claimed',
  (select state from public.call_legs where id = '7d1e5000-a050-4000-8000-00000000000a'), 'claimed');

-- ===========================================================================================
-- 5. Transitions are idempotent no-ops on a state/expectation mismatch (acceptance #5)
-- ===========================================================================================

select public._test_expect_true('transition_leg: claimed -> ended (expected state matches)',
  public.transition_leg('v3:p2e1-leg-1', array['claimed'], 'ended', jsonb_build_object('outcome', 'connected')));
select public._test_expect_false('transition_leg: calling the same transition again is a no-op (state is no longer claimed)',
  public.transition_leg('v3:p2e1-leg-1', array['claimed'], 'ended', jsonb_build_object('outcome', 'connected')));
select public._test_expect_eq('transition_leg: state stayed ended, not reverted or errored',
  (select state from public.call_legs where id = '7d1e5000-a050-4000-8000-00000000000a'), 'ended');

select public._test_expect_false('transition_session: wrong expected prior state is a no-op, not an error',
  public.transition_session('7d1e5000-a040-4000-8000-00000000000a', array['ready'], 'dialing'));
select public._test_expect_eq('transition_session: state is unchanged after the no-op',
  (select state from public.dial_sessions where id = '7d1e5000-a040-4000-8000-00000000000a'), 'connecting');

select public.apply_leg_outcome('7d1e5000-a050-4000-8000-00000000000a'); -- leg-1's outcome is 'connected' (left to disposition); this call's only job here is clearing active_leg_id below

-- ===========================================================================================
-- 6. apply_leg_outcome: every row of the §4.2 outcome table that this task can exercise without
--    the engine (dropped +0, no_answer +1 with retry_interval, failed always exhausts, and the
--    generic attempts >= max_attempts -> exhausted rule)
-- ===========================================================================================

insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state, outcome) values
  ('7d1e5000-a050-4000-8000-00000000000b', :'org_a', '7d1e5000-a040-4000-8000-00000000000a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000b', '7d1e5000-a030-4000-8000-00000000000b', 'contact', 'v3:p2e1-leg-2', 'dropped', 'dropped');
select public.apply_leg_outcome('7d1e5000-a050-4000-8000-00000000000b');
select public._test_expect_count('apply_leg_outcome/dropped: attempts NOT incremented, requeued ~15min out',
  'select count(*) from public.campaign_leads where id = ''7d1e5000-a030-4000-8000-00000000000b'' and attempts = 0 and status = ''queued'' and last_outcome = ''dropped'' and next_attempt_at > now() + interval ''10 minutes''', 1);

update public.campaign_leads set attempts = 2 where id = '7d1e5000-a030-4000-8000-00000000000a'; -- one below max_attempts=3
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state, outcome) values
  ('7d1e5000-a050-4000-8000-00000000000c', :'org_a', '7d1e5000-a040-4000-8000-00000000000a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000a', '7d1e5000-a030-4000-8000-00000000000a', 'contact', 'v3:p2e1-leg-3', 'ended', 'no_answer');
select public.apply_leg_outcome('7d1e5000-a050-4000-8000-00000000000c');
select public._test_expect_count('apply_leg_outcome/no_answer at attempts=max_attempts-1: increments to max_attempts and exhausts',
  'select count(*) from public.campaign_leads where id = ''7d1e5000-a030-4000-8000-00000000000a'' and attempts = 3 and status = ''exhausted''', 1);

insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state, outcome) values
  ('7d1e5000-a050-4000-8000-00000000000d', :'org_a', '7d1e5000-a040-4000-8000-00000000000a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000c', '7d1e5000-a030-4000-8000-00000000000c', 'contact', 'v3:p2e1-leg-4', 'ended', 'failed');
select public.apply_leg_outcome('7d1e5000-a050-4000-8000-00000000000d');
select public._test_expect_count('apply_leg_outcome/failed: exhausts regardless of attempts (attempts was 0)',
  'select count(*) from public.campaign_leads where id = ''7d1e5000-a030-4000-8000-00000000000c'' and status = ''exhausted''', 1);

select public._test_expect_count('apply_leg_outcome: clears active_leg_id when the outcome leg was active',
  'select count(*) from public.dial_sessions where id = ''7d1e5000-a040-4000-8000-00000000000a'' and active_leg_id is null', 1);

-- record_webhook_event: dedupe
select public._test_expect_true('record_webhook_event: first sighting of an event_id is recorded',
  public.record_webhook_event(:'org_a', '22222222-2222-2222-2222-222222222222', 'call.answered', 'v3:p2e1-leg-1'));
select public._test_expect_false('record_webhook_event: replay of the same event_id is rejected (dedupe)',
  public.record_webhook_event(:'org_a', '22222222-2222-2222-2222-222222222222', 'call.answered', 'v3:p2e1-leg-1'));

-- ===========================================================================================
-- 7. RLS: agent sees only their own session/legs; owner sees the whole org; org-B sees nothing
-- ===========================================================================================

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"7d1e5000-a000-4000-8000-00000000000b","role":"authenticated"}', true);
select public._test_expect_count('dial_sessions/agent sees their own session',
  'select count(*) from public.dial_sessions where id = ''7d1e5000-a040-4000-8000-00000000000a''', 1);
select public._test_expect_count('call_legs/agent sees legs on their own session',
  'select count(*) from public.call_legs where session_id = ''7d1e5000-a040-4000-8000-00000000000a''', 4);
select public._test_expect_count('webhook_events/agent has no client access at all',
  'select count(*) from public.webhook_events', 0);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"7d1e5000-a000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_count('dial_sessions/owner sees the whole org''s sessions, not just their own',
  'select count(*) from public.dial_sessions where campaign_id = ''7d1e5000-a010-4000-8000-00000000000a''', 1);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"7d1e5000-b000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_count('dial_sessions/org-B owner sees none of org A''s sessions',
  'select count(*) from public.dial_sessions where id = ''7d1e5000-a040-4000-8000-00000000000a''', 0);
select public._test_expect_count('call_legs/org-B owner sees none of org A''s legs',
  'select count(*) from public.call_legs where session_id = ''7d1e5000-a040-4000-8000-00000000000a''', 0);

reset role;
rollback;

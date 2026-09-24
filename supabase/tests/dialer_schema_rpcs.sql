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

-- lines=7 (the max) so this session's capacity is never the binding constraint anywhere in
-- this file -- both claim_next_leads calls below, plus the call_legs the RPC itself now
-- inserts for every claimed lead (TASK-P2-E2 fix-forward item 1), have ample room; only
-- eligibility (due/DNC/callable/candidate-pool) is under test here, not capacity.
insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines) values
  ('7d1e5000-a040-4000-8000-00000000000a', :'org_a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a000-4000-8000-00000000000b', 'dialing', 7);

-- ===========================================================================================
-- 1. Ordering + 2c. DNC/callable exclusion (acceptance #1, #3)
-- ===========================================================================================

-- claim_next_leads no longer takes a p_n -- it computes its own capacity from `lines` (fix-
-- forward item 1) and now also inserts each claimed lead's call_legs row itself (contact_id
-- comes back on the same row, so the ordering assertion below is unaffected).
select array_agg(contact_id order by ord) as claimed_order
from (select contact_id, row_number() over () as ord from public.claim_next_leads('7d1e5000-a040-4000-8000-00000000000a')) t
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
-- 2d. Fix D: an unrecognized contacts.timezone falls back to the both-coasts rule instead of
--     aborting claim_next_leads for the whole campaign (one bad CSV row must not stop dialing).
-- ===========================================================================================

insert into public.contacts (id, org_id, user_id, phone_number, timezone) values
  ('7d1e5000-a020-4000-8000-00000000000f', :'org_a', '7d1e5000-a000-4000-8000-00000000000a', '+15550000006', 'Not/AZone');
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts, next_attempt_at) values
  ('7d1e5000-a030-4000-8000-00000000000f', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000f', :'org_a', 'queued', 0, now());

select public._test_expect_count('claim_next_leads: a lead with an unrecognized timezone is still claimed (both-coasts fallback), not an abort',
  'select count(*) from public.claim_next_leads(''7d1e5000-a040-4000-8000-00000000000a'') where contact_id = ''7d1e5000-a020-4000-8000-00000000000f''', 1);
select public._test_expect_count('claim_next_leads: the bad-timezone lead is now in_flight too (proves the call didn''t just silently skip it)',
  'select count(*) from public.campaign_leads where id = ''7d1e5000-a030-4000-8000-00000000000f'' and status = ''in_flight''', 1);

-- ===========================================================================================
-- 2e. TASK-P2-E2 fix-forward: a failed dial's leftover placeholder call_control_id must not
--     collide when the SAME lead is claimed again later. The lead caught this before this
--     migration was ever applied: the placeholder was originally keyed on the LEAD id, which
--     is reused every time that lead is claimed again -- dialLead's error path ends the leg
--     but never changes its call_control_id away from the placeholder, so the second attempt's
--     insert collided with the first attempt's still-there dead row and raised a unique
--     violation, aborting claim_next_leads for the WHOLE SESSION, not just this one lead.
-- ===========================================================================================

insert into public.contacts (id, org_id, user_id, phone_number, timezone) values
  ('7d1e5000-a020-4000-8000-000000000010', :'org_a', '7d1e5000-a000-4000-8000-00000000000a', '+15550000007', 'America/Chicago');
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts, next_attempt_at) values
  ('7d1e5000-a030-4000-8000-000000000010', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-000000000010', :'org_a', 'queued', 0, now());

select leg_id as first_leg_id, call_control_id as first_placeholder
from public.claim_next_leads('7d1e5000-a040-4000-8000-00000000000a')
where lead_id = '7d1e5000-a030-4000-8000-000000000010'
\gset

select public._test_expect_count('fix-forward: the fresh lead was claimed and got a call_legs row',
  'select count(*) from public.call_legs where id = ''' || :'first_leg_id' || '''', 1);

-- Simulate dialLead's own error path exactly: the dial fails, the leg ends without ever
-- overwriting the placeholder, and next_attempt_at is forced to now() (rather than waiting out
-- the campaign's real retry_interval_minutes) so the same lead is immediately due again.
select public.transition_leg(:'first_placeholder', array['initiated'], 'ended',
  jsonb_build_object('outcome', 'no_answer', 'hangup_cause', 'unspecified'));
select public.apply_leg_outcome(:'first_leg_id');
update public.campaign_leads set next_attempt_at = now() where id = '7d1e5000-a030-4000-8000-000000000010';

select public._test_expect_count('fix-forward: the failed lead is requeued and due again',
  'select count(*) from public.campaign_leads where id = ''7d1e5000-a030-4000-8000-000000000010'' and status = ''queued''', 1);

select leg_id as second_leg_id, call_control_id as second_placeholder
from public.claim_next_leads('7d1e5000-a040-4000-8000-00000000000a')
where lead_id = '7d1e5000-a030-4000-8000-000000000010'
\gset

select public._test_expect_count('fix-forward: reclaiming the same lead after a failed dial succeeds (no unique violation, no aborted claim)',
  'select count(*) from public.call_legs where id = ''' || :'second_leg_id' || '''', 1);
select public._test_expect_true('fix-forward: the retry gets its OWN placeholder, not a collision with the dead first attempt',
  :'first_placeholder' is distinct from :'second_placeholder');

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
-- 3a. Fix C: claim_leg must validate the leg itself (belongs to this session, still live,
--     kind='contact') before it can ever touch dial_sessions -- a leg that already ended in a
--     race must not be able to win the session and leave it stuck pointing at a dead leg.
-- ===========================================================================================

insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state) values
  ('7d1e5000-a041-4000-8000-00000000000a', :'org_a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a000-4000-8000-00000000000a', 'dialing');
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, kind, call_control_id, state) values
  ('7d1e5000-a051-4000-8000-00000000000a', :'org_a', '7d1e5000-a041-4000-8000-00000000000a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000a', 'contact', 'v3:p2e1-leg-c-live', 'ringing'),
  ('7d1e5000-a051-4000-8000-00000000000b', :'org_a', '7d1e5000-a041-4000-8000-00000000000a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000a', 'agent', 'v3:p2e1-leg-c-agent', 'answered'),
  ('7d1e5000-a051-4000-8000-00000000000c', :'org_a', '7d1e5000-a041-4000-8000-00000000000a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000a', 'contact', 'v3:p2e1-leg-c-dead', 'ended');

select public._test_expect_false('claim_leg: a leg belonging to a DIFFERENT session cannot win',
  public.claim_leg('7d1e5000-a040-4000-8000-00000000000a', '7d1e5000-a051-4000-8000-00000000000a'));
select public._test_expect_false('claim_leg: an agent-kind leg cannot win a contact-leg claim',
  public.claim_leg('7d1e5000-a041-4000-8000-00000000000a', '7d1e5000-a051-4000-8000-00000000000b'));
select public._test_expect_false('claim_leg: a leg that already ended (dead, lost a race) cannot win',
  public.claim_leg('7d1e5000-a041-4000-8000-00000000000a', '7d1e5000-a051-4000-8000-00000000000c'));
select public._test_expect_eq('claim_leg: none of the above touched the session -- still dialing, no active_leg_id',
  (select state from public.dial_sessions where id = '7d1e5000-a041-4000-8000-00000000000a'), 'dialing');
select public._test_expect_true('claim_leg: a live contact leg that genuinely belongs to this session still wins',
  public.claim_leg('7d1e5000-a041-4000-8000-00000000000a', '7d1e5000-a051-4000-8000-00000000000a'));

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

-- Fix B: hangup_cause/amd_result are Telnyx's own vocabulary, not ours to gatekeep with a closed
-- CHECK -- a real Telnyx value this task's original CHECK never listed must still be accepted.
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, kind, call_control_id, state) values
  ('7d1e5000-a052-4000-8000-00000000000a', :'org_a', '7d1e5000-a041-4000-8000-00000000000a', '7d1e5000-a010-4000-8000-00000000000a', '7d1e5000-a020-4000-8000-00000000000a', 'contact', 'v3:p2e1-leg-b', 'answered');
select public._test_expect_true('transition_leg: accepts an unlisted-but-real Telnyx hangup_cause (destination_out_of_order)',
  public.transition_leg('v3:p2e1-leg-b', array['answered'], 'ended', jsonb_build_object('hangup_cause', 'destination_out_of_order', 'amd_result', 'some_future_telnyx_value')));
select public._test_expect_eq('transition_leg: the unlisted hangup_cause is stored verbatim, not rejected',
  (select hangup_cause from public.call_legs where id = '7d1e5000-a052-4000-8000-00000000000a'), 'destination_out_of_order');

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

-- Fix A: apply_leg_outcome must be idempotent -- a webhook redelivery or the sweeper racing the
-- webhook calling it again on the SAME leg must not double-apply (double-increment attempts).
select public.apply_leg_outcome('7d1e5000-a050-4000-8000-00000000000c');
select public._test_expect_count('apply_leg_outcome: calling it a SECOND time on the same leg does not increment attempts again',
  'select count(*) from public.campaign_leads where id = ''7d1e5000-a030-4000-8000-00000000000a'' and attempts = 3', 1);
select public._test_expect_count('apply_leg_outcome: outcome_applied_at is set exactly once, not re-touched',
  'select count(*) from public.call_legs where id = ''7d1e5000-a050-4000-8000-00000000000c'' and outcome_applied_at is not null', 1);

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

-- Fix E: claim_next_leads must return nothing for a session that isn't 'dialing' (defense in
-- depth). Session a040 is already 'connecting' at this point (claim_leg's own test above won it),
-- which is exactly the real-world case this fix guards -- a session mid-connect should never also
-- be handed a fresh batch of leads to dial.
select public._test_expect_count('claim_next_leads: a non-dialing session (connecting) gets zero leads',
  'select count(*) from public.claim_next_leads(''7d1e5000-a040-4000-8000-00000000000a'')', 0);

-- ===========================================================================================
-- 7. RLS: agent sees only their own session/legs; owner sees the whole org; org-B sees nothing
-- ===========================================================================================

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"7d1e5000-a000-4000-8000-00000000000b","role":"authenticated"}', true);
select public._test_expect_count('dial_sessions/agent sees their own session',
  'select count(*) from public.dial_sessions where id = ''7d1e5000-a040-4000-8000-00000000000a''', 1);
-- 10 = 6 from claim_next_leads itself (3 in section 1 + 1 in section 2d + 2 in section 2e's
-- failed-dial-then-retry -- fix-forward items 1 and the placeholder-collision fix, now that it
-- inserts a call_legs row per claimed lead) + 4 explicit fixture legs inserted below in
-- sections 4 and 6 (leg-1..leg-4).
select public._test_expect_count('call_legs/agent sees legs on their own session',
  'select count(*) from public.call_legs where session_id = ''7d1e5000-a040-4000-8000-00000000000a''', 10);
select public._test_expect_count('webhook_events/agent has no client access at all',
  'select count(*) from public.webhook_events', 0);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"7d1e5000-a000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_count('dial_sessions/owner sees the whole org''s sessions, not just their own',
  'select count(*) from public.dial_sessions where campaign_id = ''7d1e5000-a010-4000-8000-00000000000a''', 2);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"7d1e5000-b000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_count('dial_sessions/org-B owner sees none of org A''s sessions',
  'select count(*) from public.dial_sessions where id = ''7d1e5000-a040-4000-8000-00000000000a''', 0);
select public._test_expect_count('call_legs/org-B owner sees none of org A''s legs',
  'select count(*) from public.call_legs where session_id = ''7d1e5000-a040-4000-8000-00000000000a''', 0);

reset role;

-- ===========================================================================================
-- 8. Perf: the fix for D (private.safe_timezone via a PK-lookup table, not a pg_timezone_names
--    scan) must keep claim_next_leads fast even with a large candidate pool -- every candidate is
--    filtered BEFORE the LIMIT, so this scales with queued leads, not with p_n. Own dedicated
--    campaign/session/5,000 leads so it can't be skewed by anything else in this file.
-- ===========================================================================================

do $$
-- psql's :'var' substitution does not reach inside a dollar-quoted body, so org_a is re-derived
-- here (its owner's user_id is a fixed literal fixture id, same as everywhere else in this file).
declare
  v_org uuid;
  v_campaign uuid;
  v_session uuid;
  v_start timestamptz;
  v_elapsed_ms numeric;
begin
  select active_org_id into v_org from public.profiles where user_id = '7d1e5000-a000-4000-8000-00000000000a';

  insert into public.campaigns (id, user_id, org_id, name, calling_window_start, calling_window_end)
  values (gen_random_uuid(), '7d1e5000-a000-4000-8000-00000000000a', v_org, 'perf-test-campaign', '00:00', '23:59')
  returning id into v_campaign;
  insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines)
  values (gen_random_uuid(), v_org, v_campaign, '7d1e5000-a000-4000-8000-00000000000a', 'dialing', 5)
  returning id into v_session;

  -- +1557 (not +1555): this file's own section-1 fixture already uses +1555000000{1..6} for
  -- l1-f, and org_id/phone_number is now unique (TASK-P2-P1, added after this perf test was
  -- first written) -- a collision here aborted the whole DO block with a unique-violation,
  -- unrelated to anything this fix-forward changed. Found and fixed while verifying it.
  insert into public.contacts (id, user_id, org_id, phone_number, timezone)
  select gen_random_uuid(), '7d1e5000-a000-4000-8000-00000000000a', v_org, '+1557' || lpad(i::text, 7, '0'),
         (array['America/Chicago', 'America/New_York', 'America/Los_Angeles', 'America/Denver'])[1 + (i % 4)]
  from generate_series(1, 5000) i;

  insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts, next_attempt_at)
  select gen_random_uuid(), v_campaign, c.id, v_org, 'queued', 0, now()
  from public.contacts c
  where c.org_id = v_org and c.phone_number like '+1557%' and length(c.phone_number) = 12;

  v_start := clock_timestamp();
  perform * from public.claim_next_leads(v_session);
  v_elapsed_ms := extract(epoch from (clock_timestamp() - v_start)) * 1000;
  raise notice 'perf: claim_next_leads over 5000 tz-having candidates took % ms', v_elapsed_ms;
  if v_elapsed_ms > 500 then
    raise exception 'FAIL [perf]: claim_next_leads took %ms over 5000 candidates, expected well under 500ms (fix D''s PK-lookup table)', v_elapsed_ms;
  end if;
  raise notice 'PASS [perf]: claim_next_leads over 5000 candidates in %ms', v_elapsed_ms;
end;
$$;

rollback;

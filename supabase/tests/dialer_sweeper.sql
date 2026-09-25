-- Acceptance tests for TASK-P2-E5 (dialer-sweeper safety net, design §4.7; also closes TASK-
-- P2-E2's carried item 5). Same technique as dialer_schema_rpcs.sql: everything runs inside one
-- transaction, ROLLED BACK at the end -- safe to run repeatedly against the shared local DB.
--
-- Covers the acceptance text verbatim: a stuck leg (old activity), an in_flight lead with an
-- ended leg, and a session with a dead agent leg -> run the sweeper -> all resolved; run twice
-- -> no second change. Plus the negative controls that justify run_dialer_sweep's own design
-- choices (a fresh leg, an actively-bridged 'claimed' leg, and a leg with a RECENT webhook
-- event despite an old created_at must all survive untouched), and both halves of concern 3
-- (an orphaned-but-decided outcome vs. a genuinely nothing-to-apply gap).

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

-- Fixtures (as postgres; table owner bypasses RLS) --------------------------------------------

-- TASK-L8: 20260925000300_invite_only_signup.sql's on_auth_user_created trigger now validates a
-- real org_invites token -- swap the trigger FUNCTION to a no-op (postgres owns it; live-runnable
-- technique, same as audit/L4/dryrun.sql), build org/profile/membership by hand, then restore it.
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
  ('00000000-0000-0000-0000-000000000000', '9e5e0000-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p2e5-owner@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', '9e5e0000-a000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'p2e5-agent@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);

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
  ('9e5e0000-a000-4000-8000-0000000000aa', 'P2E5 Org A', '9e5e0000-a000-4000-8000-00000000000a');

select '9e5e0000-a000-4000-8000-0000000000aa' as org_a \gset

insert into public.profiles (user_id, active_org_id) values
  ('9e5e0000-a000-4000-8000-00000000000a', :'org_a'),
  ('9e5e0000-a000-4000-8000-00000000000b', :'org_a');

insert into public.org_members (org_id, user_id, role, status) values
  (:'org_a', '9e5e0000-a000-4000-8000-00000000000a', 'owner', 'active'),
  (:'org_a', '9e5e0000-a000-4000-8000-00000000000b', 'agent', 'active');

insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('9e5e0000-a010-4000-8000-00000000000a', :'org_a', '9e5e0000-a000-4000-8000-00000000000a', 'P2E5 Campaign', '00:00', '23:59', 3, 120);

insert into public.contacts (id, org_id, user_id, phone_number, timezone) values
  ('9e5e0000-a020-4000-8000-00000000000a', :'org_a', '9e5e0000-a000-4000-8000-00000000000a', '+15590000001', 'America/Chicago'),
  ('9e5e0000-a020-4000-8000-00000000000b', :'org_a', '9e5e0000-a000-4000-8000-00000000000a', '+15590000002', 'America/Chicago'),
  ('9e5e0000-a020-4000-8000-00000000000c', :'org_a', '9e5e0000-a000-4000-8000-00000000000a', '+15590000003', 'America/Chicago'),
  ('9e5e0000-a020-4000-8000-00000000000d', :'org_a', '9e5e0000-a000-4000-8000-00000000000a', '+15590000004', 'America/Chicago'),
  ('9e5e0000-a020-4000-8000-00000000000e', :'org_a', '9e5e0000-a000-4000-8000-00000000000a', '+15590000005', 'America/Chicago'),
  ('9e5e0000-a020-4000-8000-00000000000f', :'org_a', '9e5e0000-a000-4000-8000-00000000000a', '+15590000006', 'America/Chicago'),
  ('9e5e0000-a020-4000-8000-000000000010', :'org_a', '9e5e0000-a000-4000-8000-00000000000a', '+15590000007', 'America/Chicago'),
  ('9e5e0000-a020-4000-8000-000000000011', :'org_a', '9e5e0000-a000-4000-8000-00000000000a', '+15590000008', 'America/Chicago');

-- Leads: A (stuck ringing, never answered), B (stuck amd_pending, answered, attempts already at
-- max_attempts-1), C (ended leg, outcome decided but never applied -- the item-5 crash), D
-- (ended leg, no outcome at all -- the defensive gap), E (no leg row at all), F (fresh leg --
-- must survive), G (old leg but a RECENT webhook event -- must survive), H (actively 'claimed'
-- leg -- must survive regardless of age).
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts, next_attempt_at) values
  ('9e5e0000-a030-4000-8000-00000000000a', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000a', :'org_a', 'in_flight', 0, now()),
  ('9e5e0000-a030-4000-8000-00000000000b', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000b', :'org_a', 'in_flight', 2, now()),
  ('9e5e0000-a030-4000-8000-00000000000c', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000c', :'org_a', 'in_flight', 0, now()),
  ('9e5e0000-a030-4000-8000-00000000000d', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000d', :'org_a', 'in_flight', 1, now()),
  ('9e5e0000-a030-4000-8000-00000000000e', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000e', :'org_a', 'in_flight', 0, now()),
  ('9e5e0000-a030-4000-8000-00000000000f', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000f', :'org_a', 'in_flight', 0, now()),
  ('9e5e0000-a030-4000-8000-000000000010', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-000000000010', :'org_a', 'in_flight', 0, now()),
  ('9e5e0000-a030-4000-8000-000000000011', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-000000000011', :'org_a', 'in_flight', 0, now());

-- Session 1: hosts every contact-kind leg above (lines=7, capacity is never under test here).
insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines) values
  ('9e5e0000-a040-4000-8000-00000000000a', :'org_a', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a000-4000-8000-00000000000b', 'dialing', 7);

-- Session 2: a dead agent leg (kind='agent', already 'ended') -- exercises concern 2. No agent
-- legs exist in production yet (E3's job); this is a synthetic fixture for exactly that reason.
insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines) values
  ('9e5e0000-a040-4000-8000-00000000000b', :'org_a', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a000-4000-8000-00000000000b', 'on_call', 7);

insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state, outcome, answered_at, ended_at, outcome_applied_at, created_at) values
  -- A: stuck ringing, never answered, no webhook_events row at all -> reap as no_answer.
  ('9e5e0000-a050-4000-8000-00000000000a', :'org_a', '9e5e0000-a040-4000-8000-00000000000a', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000a', '9e5e0000-a030-4000-8000-00000000000a', 'contact', 'sweep-test-a', 'ringing', null, null, null, null, now() - interval '5 minutes'),
  -- B: stuck amd_pending, answered -> reap as failed (answered_at is not null).
  ('9e5e0000-a050-4000-8000-00000000000b', :'org_a', '9e5e0000-a040-4000-8000-00000000000a', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000b', '9e5e0000-a030-4000-8000-00000000000b', 'contact', 'sweep-test-b', 'amd_pending', null, now() - interval '3 minutes', null, null, now() - interval '5 minutes'),
  -- C: already ended with an outcome, but outcome_applied_at was never set (the item-5 crash).
  ('9e5e0000-a050-4000-8000-00000000000c', :'org_a', '9e5e0000-a040-4000-8000-00000000000a', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000c', '9e5e0000-a030-4000-8000-00000000000c', 'contact', 'sweep-test-c', 'ended', 'busy', null, now() - interval '1 minute', null, now() - interval '5 minutes'),
  -- D: already ended with NO outcome at all -- nothing for apply_leg_outcome to compute.
  ('9e5e0000-a050-4000-8000-00000000000d', :'org_a', '9e5e0000-a040-4000-8000-00000000000a', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000d', '9e5e0000-a030-4000-8000-00000000000d', 'contact', 'sweep-test-d', 'ended', null, null, now() - interval '1 minute', null, now() - interval '5 minutes'),
  -- F: fresh leg, no webhook_events row, but only just created -- under the 60s default threshold.
  ('9e5e0000-a050-4000-8000-00000000000f', :'org_a', '9e5e0000-a040-4000-8000-00000000000a', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-00000000000f', '9e5e0000-a030-4000-8000-00000000000f', 'contact', 'sweep-test-f', 'ringing', null, null, null, null, now()),
  -- G: old created_at, but a RECENT webhook_events row (inserted below) covers it.
  ('9e5e0000-a050-4000-8000-000000000010', :'org_a', '9e5e0000-a040-4000-8000-00000000000a', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-000000000010', '9e5e0000-a030-4000-8000-000000000010', 'contact', 'sweep-test-g', 'ringing', null, null, null, null, now() - interval '5 minutes'),
  -- H: actively bridged (claimed) -- excluded regardless of age; a real call is silent on the
  -- webhook stream for its whole duration by design.
  ('9e5e0000-a050-4000-8000-000000000011', :'org_a', '9e5e0000-a040-4000-8000-00000000000a', '9e5e0000-a010-4000-8000-00000000000a', '9e5e0000-a020-4000-8000-000000000011', '9e5e0000-a030-4000-8000-000000000011', 'contact', 'sweep-test-h', 'claimed', null, now() - interval '10 minutes', null, null, now() - interval '10 minutes'),
  -- I: a dead agent leg for session 2.
  ('9e5e0000-a050-4000-8000-000000000012', :'org_a', '9e5e0000-a040-4000-8000-00000000000b', '9e5e0000-a010-4000-8000-00000000000a', null, null, 'agent', 'sweep-test-agent-i', 'ended', null, null, now() - interval '2 minutes', null, now() - interval '10 minutes');

update public.dial_sessions set agent_leg_id = '9e5e0000-a050-4000-8000-000000000012' where id = '9e5e0000-a040-4000-8000-00000000000b';

insert into public.webhook_events (org_id, event_id, event_type, call_control_id, received_at) values
  (:'org_a', gen_random_uuid(), 'call.ringing', 'sweep-test-g', now() - interval '5 seconds');

-- Lead E has NO call_legs row at all -- its campaign_leads insert above is the whole fixture.

-- ===========================================================================================
-- Pass 1: everything stuck/orphaned/dead resolves in one call.
-- ===========================================================================================

-- `select * from f()`, NOT `select (f()).*` -- the latter calls a multi-column composite-
-- returning function ONCE PER COLUMN (a real Postgres quirk, verified empirically: 4 columns,
-- 4 calls), so a stateful function like this one would have its later columns reflect a
-- SECOND/THIRD/FOURTH call made after the first already fixed everything. PostgREST's own
-- `.rpc()` call (the real production path) is unaffected -- this only bites hand-written SQL.
select * from public.run_dialer_sweep() \gset sweep1_

select public._test_expect_eq('sweep pass 1: paused 1 dead-agent-leg session', :'sweep1_paused_agent_sessions', '1');
select public._test_expect_eq('sweep pass 1: applied 1 orphaned outcome (lead C)', :'sweep1_applied_orphaned_outcomes', '1');
select public._test_expect_eq('sweep pass 1: requeued 2 leads with nothing to apply (D, E)', :'sweep1_requeued_leads', '2');
select jsonb_array_length(:'sweep1_reaped_legs'::jsonb)::text as len \gset
select public._test_expect_eq('sweep pass 1: reaped exactly 2 stuck legs (A, B)', :'len', '2');

-- A: never answered -> no_answer, attempts 0->1 (< max_attempts 3) -> queued.
select public._test_expect_eq('leg A: reaped as ended/no_answer', (select state || '/' || outcome from public.call_legs where id = '9e5e0000-a050-4000-8000-00000000000a'), 'ended/no_answer');
select public._test_expect_eq('lead A: attempts 1, queued', (select status || '/' || attempts::text from public.campaign_leads where id = '9e5e0000-a030-4000-8000-00000000000a'), 'queued/1');

-- B: was answered -> failed, which always exhausts regardless of attempts (2->3).
select public._test_expect_eq('leg B: reaped as ended/failed', (select state || '/' || outcome from public.call_legs where id = '9e5e0000-a050-4000-8000-00000000000b'), 'ended/failed');
select public._test_expect_eq('lead B: attempts 3, exhausted', (select status || '/' || attempts::text from public.campaign_leads where id = '9e5e0000-a030-4000-8000-00000000000b'), 'exhausted/3');

-- C: outcome was already 'busy' -- apply_leg_outcome runs (not a blind requeue), attempts 0->1.
select public._test_expect_eq('leg C: outcome_applied_at now set', (select (outcome_applied_at is not null)::text from public.call_legs where id = '9e5e0000-a050-4000-8000-00000000000c'), 'true');
select public._test_expect_eq('lead C: attempts 1, queued (busy retries)', (select status || '/' || attempts::text from public.campaign_leads where id = '9e5e0000-a030-4000-8000-00000000000c'), 'queued/1');

-- D: ended with no outcome -- direct requeue, attempts UNCHANGED at 1 (not a real attempt).
select public._test_expect_eq('lead D: requeued, attempts unchanged at 1', (select status || '/' || attempts::text from public.campaign_leads where id = '9e5e0000-a030-4000-8000-00000000000d'), 'queued/1');

-- E: no leg row at all -- direct requeue, attempts UNCHANGED at 0.
select public._test_expect_eq('lead E: requeued, attempts unchanged at 0', (select status || '/' || attempts::text from public.campaign_leads where id = '9e5e0000-a030-4000-8000-00000000000e'), 'queued/0');

-- F: too fresh (created just now) -- untouched.
select public._test_expect_eq('leg F: untouched (fresh)', (select state from public.call_legs where id = '9e5e0000-a050-4000-8000-00000000000f'), 'ringing');
select public._test_expect_eq('lead F: still in_flight', (select status from public.campaign_leads where id = '9e5e0000-a030-4000-8000-00000000000f'), 'in_flight');

-- G: old, but a recent webhook_events row covers it -- untouched.
select public._test_expect_eq('leg G: untouched (recent event)', (select state from public.call_legs where id = '9e5e0000-a050-4000-8000-000000000010'), 'ringing');
select public._test_expect_eq('lead G: still in_flight', (select status from public.campaign_leads where id = '9e5e0000-a030-4000-8000-000000000010'), 'in_flight');

-- H: actively 'claimed' -- untouched regardless of age (a real call is webhook-silent by design).
select public._test_expect_eq('leg H: untouched (claimed/live call)', (select state from public.call_legs where id = '9e5e0000-a050-4000-8000-000000000011'), 'claimed');
select public._test_expect_eq('lead H: still in_flight', (select status from public.campaign_leads where id = '9e5e0000-a030-4000-8000-000000000011'), 'in_flight');

-- Session 2: dead agent leg -> paused_agent_lost.
select public._test_expect_eq('session 2: paused_agent_lost', (select state from public.dial_sessions where id = '9e5e0000-a040-4000-8000-00000000000b'), 'paused_agent_lost');

-- ===========================================================================================
-- Pass 2: running it again with nothing newly stuck changes nothing (idempotency).
-- ===========================================================================================

select * from public.run_dialer_sweep() \gset sweep2_

select public._test_expect_eq('sweep pass 2: reaped 0 legs', (select jsonb_array_length(:'sweep2_reaped_legs'::jsonb))::text, '0');
select public._test_expect_eq('sweep pass 2: paused 0 sessions', :'sweep2_paused_agent_sessions', '0');
select public._test_expect_eq('sweep pass 2: applied 0 orphaned outcomes', :'sweep2_applied_orphaned_outcomes', '0');
select public._test_expect_eq('sweep pass 2: requeued 0 leads', :'sweep2_requeued_leads', '0');

-- Untouched fixtures (F, G, H) are still exactly as pass 1 left them.
select public._test_expect_count('pass 2: F/G/H leads still in_flight', 'select count(*) from public.campaign_leads where id in (''9e5e0000-a030-4000-8000-00000000000f'',''9e5e0000-a030-4000-8000-000000000010'',''9e5e0000-a030-4000-8000-000000000011'') and status = ''in_flight''', 3);

rollback;



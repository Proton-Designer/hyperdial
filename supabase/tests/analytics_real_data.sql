-- Acceptance tests for TASK-P4-P1 (dashboard/analytics on real data, design §8 Phase 4).
-- Same techniques as rls_org_matrix.sql (SET LOCAL ROLE authenticated + set_config for real RLS)
-- and dialer_schema_rpcs.sql (fixtures as postgres, everything in one rolled-back transaction).
--
-- Covers the task's own acceptance text: "Seed fixture legs for 2 orgs and 2 agents; SQL tests
-- for the per-role visibility matrix (an agent sees only self, org B sees nothing) and the
-- metric math (a positive control with hand-computed numbers)."

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

-- Fixtures ---------------------------------------------------------------------------------
-- org_a: owner + 2 agents, each with their own completed dial session and a hand-picked set of
-- call_legs with known outcomes/durations. org_b: an unrelated owner + agent, one leg, used only
-- to prove nothing in org_a's analytics ever leaks into org_b's or vice versa.

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
  ('00000000-0000-0000-0000-000000000000', 'a2a10000-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p4p1-owner-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'a2a10000-a000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'p4p1-agent1-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'a2a10000-a000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'p4p1-agent2-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'a2a10000-b000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p4p1-owner-b@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'a2a10000-b000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'p4p1-agent-b@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);

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
  ('a2a10000-a000-4000-8000-0000000000aa', 'P4P1 Org A', 'a2a10000-a000-4000-8000-00000000000a'),
  ('a2a10000-b000-4000-8000-0000000000aa', 'P4P1 Org B', 'a2a10000-b000-4000-8000-00000000000a');

select 'a2a10000-a000-4000-8000-0000000000aa' as org_a \gset
select 'a2a10000-b000-4000-8000-0000000000aa' as org_b \gset

insert into public.profiles (user_id, active_org_id) values
  ('a2a10000-a000-4000-8000-00000000000a', :'org_a'),
  ('a2a10000-a000-4000-8000-00000000000b', :'org_a'),
  ('a2a10000-a000-4000-8000-00000000000c', :'org_a'),
  ('a2a10000-b000-4000-8000-00000000000a', :'org_b'),
  ('a2a10000-b000-4000-8000-00000000000b', :'org_b');

insert into public.org_members (org_id, user_id, role, status) values
  (:'org_a', 'a2a10000-a000-4000-8000-00000000000a', 'owner', 'active'),
  (:'org_a', 'a2a10000-a000-4000-8000-00000000000b', 'agent', 'active'),
  (:'org_a', 'a2a10000-a000-4000-8000-00000000000c', 'agent', 'active'),
  (:'org_b', 'a2a10000-b000-4000-8000-00000000000a', 'owner', 'active'),
  (:'org_b', 'a2a10000-b000-4000-8000-00000000000b', 'agent', 'active');

insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('a2a12000-a000-4000-8000-00000000000a', :'org_a', 'a2a10000-a000-4000-8000-00000000000a', 'P4P1 Campaign A', '00:00', '23:59', 3, 120);
insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('a2a12000-b000-4000-8000-00000000000a', :'org_b', 'a2a10000-b000-4000-8000-00000000000a', 'P4P1 Campaign B', '00:00', '23:59', 3, 120);

insert into public.contacts (id, org_id, user_id, phone_number) values
  ('a2a13000-a000-4000-8000-00000000000a', :'org_a', 'a2a10000-a000-4000-8000-00000000000a', '+15553330001'),
  ('a2a13000-a000-4000-8000-00000000000b', :'org_a', 'a2a10000-a000-4000-8000-00000000000a', '+15553330002'),
  ('a2a13000-b000-4000-8000-00000000000a', :'org_b', 'a2a10000-b000-4000-8000-00000000000a', '+15554440001');

-- session_agent1 spans exactly 90 minutes -> session_hours = 1.5. session_agent2 spans exactly
-- 30 minutes -> session_hours = 0.5. Both 'completed' (ended_at set) so they count toward the
-- agent-hours denominator.
insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines, started_at, ended_at) values
  ('a2a14000-a000-4000-8000-00000000000a', :'org_a', 'a2a12000-a000-4000-8000-00000000000a', 'a2a10000-a000-4000-8000-00000000000b', 'completed', 3, '2026-09-20T10:00:00Z', '2026-09-20T11:30:00Z'),
  ('a2a14000-a000-4000-8000-00000000000b', :'org_a', 'a2a12000-a000-4000-8000-00000000000a', 'a2a10000-a000-4000-8000-00000000000c', 'completed', 3, '2026-09-20T10:00:00Z', '2026-09-20T10:30:00Z');
insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines, started_at, ended_at) values
  ('a2a14000-b000-4000-8000-00000000000a', :'org_b', 'a2a12000-b000-4000-8000-00000000000a', 'a2a10000-b000-4000-8000-00000000000b', 'completed', 3, '2026-09-20T10:00:00Z', '2026-09-20T10:15:00Z');

select id as disp_interested from public.dispositions where org_id = :'org_a' and key = 'interested' \gset

-- agent1's 3 legs: 1 connected (120s, dispositioned "interested"), 1 no_answer, 1 machine.
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, kind, call_control_id, state, outcome, duration_seconds, disposition_id, created_at) values
  ('a2a16000-a000-4000-8000-00000000000a', :'org_a', 'a2a14000-a000-4000-8000-00000000000a', 'a2a12000-a000-4000-8000-00000000000a', 'a2a13000-a000-4000-8000-00000000000a', 'contact', 'p4p1-leg-a1', 'ended', 'connected', 120, :'disp_interested', '2026-09-20T10:05:00Z'),
  ('a2a16000-a000-4000-8000-00000000000b', :'org_a', 'a2a14000-a000-4000-8000-00000000000a', 'a2a12000-a000-4000-8000-00000000000a', 'a2a13000-a000-4000-8000-00000000000b', 'contact', 'p4p1-leg-a2', 'ended', 'no_answer', null, null, '2026-09-20T10:10:00Z'),
  ('a2a16000-a000-4000-8000-00000000000c', :'org_a', 'a2a14000-a000-4000-8000-00000000000a', 'a2a12000-a000-4000-8000-00000000000a', 'a2a13000-a000-4000-8000-00000000000a', 'contact', 'p4p1-leg-a3', 'ended', 'machine', null, null, '2026-09-20T10:15:00Z');
-- agent2's 1 leg: connected, 180s.
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, kind, call_control_id, state, outcome, duration_seconds, disposition_id, created_at) values
  ('a2a16000-a000-4000-8000-00000000000d', :'org_a', 'a2a14000-a000-4000-8000-00000000000b', 'a2a12000-a000-4000-8000-00000000000a', 'a2a13000-a000-4000-8000-00000000000b', 'contact', 'p4p1-leg-a4', 'ended', 'connected', 180, null, '2026-09-20T10:05:00Z');
-- org_b's one leg, entirely separate.
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, kind, call_control_id, state, outcome, duration_seconds, disposition_id, created_at) values
  ('a2a16000-b000-4000-8000-00000000000a', :'org_b', 'a2a14000-b000-4000-8000-00000000000a', 'a2a12000-b000-4000-8000-00000000000a', 'a2a13000-b000-4000-8000-00000000000a', 'contact', 'p4p1-leg-b1', 'ended', 'connected', 60, null, '2026-09-20T10:05:00Z');

-- ===========================================================================================
-- 1. Metric math: a positive control with hand-computed numbers (acceptance's own wording),
--    run as postgres (bypasses RLS -- this block is about the view's ARITHMETIC, not visibility).
-- ===========================================================================================

select public._test_expect_count('call_leg_analytics: agent1''s session has exactly 3 contact legs',
  format('select count(*) from public.call_leg_analytics where session_id = %L', 'a2a14000-a000-4000-8000-00000000000a'), 3);
select public._test_expect_count('call_leg_analytics: agent1''s session has exactly 1 connected leg',
  format('select count(*) from public.call_leg_analytics where session_id = %L and is_connected', 'a2a14000-a000-4000-8000-00000000000a'), 1);
select public._test_expect_eq('call_leg_analytics: agent1''s connected talk time is exactly 120s',
  (select sum(duration_seconds)::text from public.call_leg_analytics where session_id = 'a2a14000-a000-4000-8000-00000000000a' and is_connected), '120');
select public._test_expect_eq('call_leg_analytics: leg a1''s disposition_label surfaces from the join',
  (select disposition_label from public.call_leg_analytics where leg_id = 'a2a16000-a000-4000-8000-00000000000a'), 'Interested / Meeting booked');
select public._test_expect_eq('call_leg_analytics: leg a2 (no disposition yet) has a null disposition_label',
  (select disposition_label from public.call_leg_analytics where leg_id = 'a2a16000-a000-4000-8000-00000000000b'), null);

select public._test_expect_eq('dial_session_hours: agent1''s 90-minute session -> 1.5 hours exactly',
  (select session_hours::text from public.dial_session_hours where session_id = 'a2a14000-a000-4000-8000-00000000000a'), '1.50');
select public._test_expect_eq('dial_session_hours: agent2''s 30-minute session -> 0.5 hours exactly',
  (select session_hours::text from public.dial_session_hours where session_id = 'a2a14000-a000-4000-8000-00000000000b'), '0.50');

select public._test_expect_count('call_leg_analytics: org_a totals 4 contact legs (3 + 1, org-wide)',
  format('select count(*) from public.call_leg_analytics where org_id = %L', :'org_a'), 4);
select public._test_expect_count('call_leg_analytics: org_a totals 2 connected legs (1 + 1, org-wide)',
  format('select count(*) from public.call_leg_analytics where org_id = %L and is_connected', :'org_a'), 2);
select public._test_expect_eq('call_leg_analytics: org_a''s total connected talk time is exactly 300s (120 + 180)',
  (select sum(duration_seconds)::text from public.call_leg_analytics where org_id = :'org_a' and is_connected), '300');

-- The north-star metric itself, hand-computed: 2 connected legs org-wide / (1.5 + 0.5) agent-hours
-- = 1.0 conversation per agent-hour exactly.
select
  (select count(*) from public.call_leg_analytics where org_id = :'org_a' and is_connected) as connected_a,
  (select sum(session_hours) from public.dial_session_hours where org_id = :'org_a') as hours_a
\gset
select public._test_expect_eq('north-star metric: org_a connected-legs / agent-hours = 1.0 exactly (2 / 2.0)',
  (round(:connected_a::numeric / :hours_a, 2))::text, '1.00');

-- ===========================================================================================
-- 2. Per-role visibility matrix (acceptance's own wording: "an agent sees only self, org B sees
--    nothing"), as real RLS via SET LOCAL ROLE + set_config -- not a query-time filter this
--    migration reinvents, the whole point of call_leg_analytics/dial_session_hours being
--    security_invoker over already-scoped call_legs/dial_sessions RLS.
-- ===========================================================================================

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2a10000-a000-4000-8000-00000000000b","role":"authenticated"}', true);
select public._test_expect_count('agent1-a sees only their OWN 3 legs in call_leg_analytics, not agent2''s or org_b''s',
  format('select count(*) from public.call_leg_analytics where org_id = %L', :'org_a'), 3);
select public._test_expect_count('agent1-a sees only their OWN dial_session_hours row',
  format('select count(*) from public.dial_session_hours where org_id = %L', :'org_a'), 1);
select public._test_expect_count('agent1-a sees zero org_b rows in call_leg_analytics',
  format('select count(*) from public.call_leg_analytics where org_id = %L', :'org_b'), 0);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2a10000-a000-4000-8000-00000000000c","role":"authenticated"}', true);
select public._test_expect_count('agent2-a sees only their OWN 1 leg in call_leg_analytics, not agent1''s',
  format('select count(*) from public.call_leg_analytics where org_id = %L', :'org_a'), 1);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2a10000-a000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_count('owner-a sees ALL 4 org_a legs (org-wide, both agents)',
  format('select count(*) from public.call_leg_analytics where org_id = %L', :'org_a'), 4);
select public._test_expect_count('owner-a sees BOTH org_a dial_session_hours rows',
  format('select count(*) from public.dial_session_hours where org_id = %L', :'org_a'), 2);
select public._test_expect_count('owner-a sees zero org_b rows',
  format('select count(*) from public.call_leg_analytics where org_id = %L', :'org_b'), 0);

reset role;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"a2a10000-b000-4000-8000-00000000000a","role":"authenticated"}', true);
select public._test_expect_count('owner-b sees zero org_a rows (org B sees nothing of org A, per the acceptance text)',
  format('select count(*) from public.call_leg_analytics where org_id = %L', :'org_a'), 0);
select public._test_expect_count('owner-b sees their own 1 org_b leg',
  format('select count(*) from public.call_leg_analytics where org_id = %L', :'org_b'), 1);

reset role;

rollback;

-- Acceptance tests for TASK-H09 (callback time optional at wrap-up). Same technique as dispositions.sql: fixtures as
-- postgres, one transaction ROLLED BACK at the end. submit_disposition is service-role-only, so it is called with
-- explicit p_org / p_caller_user_id. Needs migration *_h09_callback_time_optional.sql applied (positive control: on the
-- old function the "no time" call below raises 'callback_at is required for a callback disposition').

begin;

create or replace function public._test_expect_eq(p_label text, p_actual text, p_expected text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'PASS [%]: % as expected', p_label, p_actual;
end;
$$;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $fx$
begin
  return new;
end;
$fx$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'a09a0000-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'h09-owner@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'a09a0000-a000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'h09-agent@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);

insert into public.orgs (id, name, created_by) values
  ('a09a0000-a000-4000-8000-0000000000aa', 'H09 Org', 'a09a0000-a000-4000-8000-00000000000a');
select 'a09a0000-a000-4000-8000-0000000000aa' as org \gset

insert into public.profiles (user_id, active_org_id) values
  ('a09a0000-a000-4000-8000-00000000000a', :'org'),
  ('a09a0000-a000-4000-8000-00000000000b', :'org');
insert into public.org_members (org_id, user_id, role, status) values
  (:'org', 'a09a0000-a000-4000-8000-00000000000a', 'owner', 'active'),
  (:'org', 'a09a0000-a000-4000-8000-00000000000b', 'agent', 'active');

-- Campaign: retry interval 45 min, max 3 attempts.
insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('a09a2000-a000-4000-8000-00000000000a', :'org', 'a09a0000-a000-4000-8000-00000000000a', 'H09 Campaign', '00:00', '23:59', 3, 45);
insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines) values
  ('a09a4000-a000-4000-8000-00000000000a', :'org', 'a09a2000-a000-4000-8000-00000000000a', 'a09a0000-a000-4000-8000-00000000000b', 'wrap_up', 3);

-- A: callback WITH a time. B: callback WITHOUT a time. C: no_answer (the reference behaviour for B).
-- D: callback without a time, lead already at max attempts.
insert into public.contacts (id, org_id, user_id, phone_number) values
  ('a09a3000-a000-4000-8000-00000000000a', :'org', 'a09a0000-a000-4000-8000-00000000000a', '+15552220001'),
  ('a09a3000-a000-4000-8000-00000000000b', :'org', 'a09a0000-a000-4000-8000-00000000000a', '+15552220002'),
  ('a09a3000-a000-4000-8000-00000000000c', :'org', 'a09a0000-a000-4000-8000-00000000000a', '+15552220003'),
  ('a09a3000-a000-4000-8000-00000000000d', :'org', 'a09a0000-a000-4000-8000-00000000000a', '+15552220004');
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts) values
  ('a09a5000-a000-4000-8000-00000000000a', 'a09a2000-a000-4000-8000-00000000000a', 'a09a3000-a000-4000-8000-00000000000a', :'org', 'in_flight', 1),
  ('a09a5000-a000-4000-8000-00000000000b', 'a09a2000-a000-4000-8000-00000000000a', 'a09a3000-a000-4000-8000-00000000000b', :'org', 'in_flight', 1),
  ('a09a5000-a000-4000-8000-00000000000c', 'a09a2000-a000-4000-8000-00000000000a', 'a09a3000-a000-4000-8000-00000000000c', :'org', 'in_flight', 1),
  ('a09a5000-a000-4000-8000-00000000000d', 'a09a2000-a000-4000-8000-00000000000a', 'a09a3000-a000-4000-8000-00000000000d', :'org', 'in_flight', 3);
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state) values
  ('a09a6000-a000-4000-8000-00000000000a', :'org', 'a09a4000-a000-4000-8000-00000000000a', 'a09a2000-a000-4000-8000-00000000000a', 'a09a3000-a000-4000-8000-00000000000a', 'a09a5000-a000-4000-8000-00000000000a', 'contact', 'h09-leg-a', 'ended'),
  ('a09a6000-a000-4000-8000-00000000000b', :'org', 'a09a4000-a000-4000-8000-00000000000a', 'a09a2000-a000-4000-8000-00000000000a', 'a09a3000-a000-4000-8000-00000000000b', 'a09a5000-a000-4000-8000-00000000000b', 'contact', 'h09-leg-b', 'ended'),
  ('a09a6000-a000-4000-8000-00000000000c', :'org', 'a09a4000-a000-4000-8000-00000000000a', 'a09a2000-a000-4000-8000-00000000000a', 'a09a3000-a000-4000-8000-00000000000c', 'a09a5000-a000-4000-8000-00000000000c', 'contact', 'h09-leg-c', 'ended'),
  ('a09a6000-a000-4000-8000-00000000000d', :'org', 'a09a4000-a000-4000-8000-00000000000a', 'a09a2000-a000-4000-8000-00000000000a', 'a09a3000-a000-4000-8000-00000000000d', 'a09a5000-a000-4000-8000-00000000000d', 'contact', 'h09-leg-d', 'ended');

select public.submit_disposition('a09a6000-a000-4000-8000-00000000000a', :'org', 'a09a0000-a000-4000-8000-00000000000b', 'callback', 'call at 2', '2031-10-05T14:00:00Z');
select public.submit_disposition('a09a6000-a000-4000-8000-00000000000b', :'org', 'a09a0000-a000-4000-8000-00000000000b', 'callback', 'no time given', null);
select public.submit_disposition('a09a6000-a000-4000-8000-00000000000c', :'org', 'a09a0000-a000-4000-8000-00000000000b', 'no_answer', null, null);
select public.submit_disposition('a09a6000-a000-4000-8000-00000000000d', :'org', 'a09a0000-a000-4000-8000-00000000000b', 'callback', null, null);

-- A: unchanged behaviour
select public._test_expect_eq('A with time: lead status callback',
  (select status from public.campaign_leads where id = 'a09a5000-a000-4000-8000-00000000000a'), 'callback');
select public._test_expect_eq('A with time: next_attempt_at is the chosen time',
  (select to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from public.campaign_leads where id = 'a09a5000-a000-4000-8000-00000000000a'), '2031-10-05T14:00:00Z');
select public._test_expect_eq('A with time: assigned to the session agent',
  (select assigned_agent_id::text from public.campaign_leads where id = 'a09a5000-a000-4000-8000-00000000000a'), 'a09a0000-a000-4000-8000-00000000000b');
select public._test_expect_eq('A with time: call_legs.callback_at stored',
  (select to_char(callback_at, 'YYYY') from public.call_legs where id = 'a09a6000-a000-4000-8000-00000000000a'), '2031');

-- B: accepted, scheduled by the campaign retry rule like the no-answer C
select public._test_expect_eq('B no time: lead is queued (not callback)',
  (select status from public.campaign_leads where id = 'a09a5000-a000-4000-8000-00000000000b'), 'queued');
select public._test_expect_eq('B no time: next_attempt_at is about retry_interval_minutes (45) out',
  (select (next_attempt_at between now() + interval '44 minutes' and now() + interval '46 minutes')::text from public.campaign_leads where id = 'a09a5000-a000-4000-8000-00000000000b'), 'true');
select public._test_expect_eq('B no time: same status and attempts as no_answer C',
  (select status || '/' || attempts from public.campaign_leads where id = 'a09a5000-a000-4000-8000-00000000000b'),
  (select status || '/' || attempts from public.campaign_leads where id = 'a09a5000-a000-4000-8000-00000000000c'));
select public._test_expect_eq('B no time: call_legs.callback_at is null',
  (select (callback_at is null)::text from public.call_legs where id = 'a09a6000-a000-4000-8000-00000000000b'), 'true');
select public._test_expect_eq('B no time: disposition recorded as callback',
  (select d.key from public.call_legs l join public.dispositions d on d.id = l.disposition_id where l.id = 'a09a6000-a000-4000-8000-00000000000b'), 'callback');

-- D: at max attempts, the campaign's own rule exhausts it, as for a no-answer
select public._test_expect_eq('D no time at max attempts: exhausted',
  (select status from public.campaign_leads where id = 'a09a5000-a000-4000-8000-00000000000d'), 'exhausted');

rollback;

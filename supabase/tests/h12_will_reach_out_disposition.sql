-- Acceptance tests for TASK-H12 ("They'll reach out" disposition). Same technique as dispositions.sql: fixtures as postgres,
-- one transaction ROLLED BACK. Needs migration *_h12_will_reach_out_disposition.sql applied.
-- Positive control: on a database without the migration, tests 1 and 4 fail (no 'will_reach_out' row / lead not completed).

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
  ('00000000-0000-0000-0000-000000000000', 'a12a0000-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'h12-owner@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'a12a0000-a000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'h12-agent@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);

-- A NEW org (the seed trigger path)
insert into public.orgs (id, name, created_by) values
  ('a12a0000-a000-4000-8000-0000000000aa', 'H12 Org', 'a12a0000-a000-4000-8000-00000000000a');
select 'a12a0000-a000-4000-8000-0000000000aa' as org \gset

-- 1. New org is seeded with the row, with the intended shape
select public._test_expect_eq('new org seeded with will_reach_out',
  (select count(*)::text from public.dispositions where org_id = :'org' and key = 'will_reach_out'), '1');
select public._test_expect_eq('shape: label / effect / tag / task / win / sort',
  (select concat_ws('|', label, lead_effect, ghl_tag, creates_task, is_win, sort, active) from public.dispositions where org_id = :'org' and key = 'will_reach_out'),
  'They''ll reach out|completed|Will Reach Out|f|f|35|t');
-- 2. The 9 existing defaults are untouched
select public._test_expect_eq('10 defaults in total (9 old + 1)',
  (select count(*)::text from public.dispositions where org_id = :'org'), '10');
select public._test_expect_eq('callback disposition unchanged',
  (select lead_effect from public.dispositions where org_id = :'org' and key = 'callback'), 'callback');

-- 3. Backfill for an EXISTING org: drop the row, re-run the migration's insert statement, row is back; an org-edited row is kept.
delete from public.dispositions where org_id = :'org' and key = 'will_reach_out';
insert into public.dispositions (org_id, key, label, lead_effect, ghl_tag, creates_task, sort, is_win, required_fields)
select o.id, 'will_reach_out', 'They''ll reach out', 'completed', 'Will Reach Out', false, 35, false, null
from public.orgs o where o.id = :'org'
on conflict (org_id, key) do nothing;
select public._test_expect_eq('backfill restores the row', (select count(*)::text from public.dispositions where org_id = :'org' and key = 'will_reach_out'), '1');
update public.dispositions set label = 'Custom label' where org_id = :'org' and key = 'will_reach_out';
insert into public.dispositions (org_id, key, label, lead_effect, ghl_tag, creates_task, sort, is_win, required_fields)
select o.id, 'will_reach_out', 'They''ll reach out', 'completed', 'Will Reach Out', false, 35, false, null
from public.orgs o where o.id = :'org'
on conflict (org_id, key) do nothing;
select public._test_expect_eq('backfill never overwrites an org-edited row',
  (select label from public.dispositions where org_id = :'org' and key = 'will_reach_out'), 'Custom label');

-- 4. Lead effect end to end: submit stops the lead (completed), no callback, no retry, no nurture/dnc side effect
insert into public.profiles (user_id, active_org_id) values
  ('a12a0000-a000-4000-8000-00000000000a', :'org'), ('a12a0000-a000-4000-8000-00000000000b', :'org');
insert into public.org_members (org_id, user_id, role, status) values
  (:'org', 'a12a0000-a000-4000-8000-00000000000a', 'owner', 'active'),
  (:'org', 'a12a0000-a000-4000-8000-00000000000b', 'agent', 'active');
insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('a12a2000-a000-4000-8000-00000000000a', :'org', 'a12a0000-a000-4000-8000-00000000000a', 'H12 Campaign', '00:00', '23:59', 3, 45);
insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines) values
  ('a12a4000-a000-4000-8000-00000000000a', :'org', 'a12a2000-a000-4000-8000-00000000000a', 'a12a0000-a000-4000-8000-00000000000b', 'wrap_up', 3);
insert into public.contacts (id, org_id, user_id, phone_number) values
  ('a12a3000-a000-4000-8000-00000000000a', :'org', 'a12a0000-a000-4000-8000-00000000000a', '+15553330001');
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts) values
  ('a12a5000-a000-4000-8000-00000000000a', 'a12a2000-a000-4000-8000-00000000000a', 'a12a3000-a000-4000-8000-00000000000a', :'org', 'in_flight', 1);
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state) values
  ('a12a6000-a000-4000-8000-00000000000a', :'org', 'a12a4000-a000-4000-8000-00000000000a', 'a12a2000-a000-4000-8000-00000000000a', 'a12a3000-a000-4000-8000-00000000000a', 'a12a5000-a000-4000-8000-00000000000a', 'contact', 'h12-leg-a', 'ended');

select public.submit_disposition('a12a6000-a000-4000-8000-00000000000a', :'org', 'a12a0000-a000-4000-8000-00000000000b', 'will_reach_out', 'said he will call us', null);

select public._test_expect_eq('submit: lead status completed (out of the dial queue)',
  (select status from public.campaign_leads where id = 'a12a5000-a000-4000-8000-00000000000a'), 'completed');
select public._test_expect_eq('submit: not marked DNC',
  (select coalesce(dnc, false)::text from public.contacts where id = 'a12a3000-a000-4000-8000-00000000000a'), 'false');
select public._test_expect_eq('submit: no callback stored',
  (select (callback_at is null)::text from public.call_legs where id = 'a12a6000-a000-4000-8000-00000000000a'), 'true');

rollback;

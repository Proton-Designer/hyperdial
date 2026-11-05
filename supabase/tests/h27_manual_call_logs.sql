-- TASK-H27 tests: manual_call_logs + record_manual_call + set_manual_call_outcome + list_contact_manual_calls.
-- One batch, ROLLED BACK. Needs *_h27_manual_call_logs.sql applied (on a database without it every check fails: positive control).
-- Result: one row {failed:[labels], n:count}.
begin;
create temp table t_res(label text, ok boolean, detail text) on commit drop;
create temp table r_cap(k text, v text) on commit drop;
grant all on r_cap to public;
grant all on t_res to public;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $fx$ begin return new; end; $fx$;

-- users: o owner, ag agent on the campaign, ag2 agent NOT on it, mg manager of pod d1, agp agent in pod d1 (on the campaign), x owner of org B only
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.em, 'x', now(), '{}', '{}', now(), now(), '', false, false
from (values
  ('a27a0000-a000-4000-8000-000000000001', 'h27-o@example.com'),
  ('a27a0000-a000-4000-8000-000000000002', 'h27-ag@example.com'),
  ('a27a0000-a000-4000-8000-000000000003', 'h27-ag2@example.com'),
  ('a27a0000-a000-4000-8000-000000000004', 'h27-mg@example.com'),
  ('a27a0000-a000-4000-8000-000000000005', 'h27-x@example.com'),
  ('a27a0000-a000-4000-8000-000000000006', 'h27-agp@example.com')
) u(id, em);
insert into public.orgs (id, name, created_by) values
  ('a27a0000-a000-4000-8000-0000000000a1', 'H27 A', 'a27a0000-a000-4000-8000-000000000001'),
  ('a27a0000-a000-4000-8000-0000000000b2', 'H27 B', 'a27a0000-a000-4000-8000-000000000005');
insert into public.org_pods (id, org_id, name) values ('a27a0000-a000-4000-8000-0000000000d1', 'a27a0000-a000-4000-8000-0000000000a1', 'P1');
insert into public.org_members (org_id, user_id, role, status, pod_id) values
  ('a27a0000-a000-4000-8000-0000000000a1', 'a27a0000-a000-4000-8000-000000000001', 'owner', 'active', null),
  ('a27a0000-a000-4000-8000-0000000000a1', 'a27a0000-a000-4000-8000-000000000002', 'agent', 'active', null),
  ('a27a0000-a000-4000-8000-0000000000a1', 'a27a0000-a000-4000-8000-000000000003', 'agent', 'active', null),
  ('a27a0000-a000-4000-8000-0000000000a1', 'a27a0000-a000-4000-8000-000000000004', 'manager', 'active', null),
  ('a27a0000-a000-4000-8000-0000000000a1', 'a27a0000-a000-4000-8000-000000000006', 'agent', 'active', 'a27a0000-a000-4000-8000-0000000000d1'),
  ('a27a0000-a000-4000-8000-0000000000b2', 'a27a0000-a000-4000-8000-000000000005', 'owner', 'active', null);
insert into public.org_manager_pods (org_id, manager_user_id, pod_id) values ('a27a0000-a000-4000-8000-0000000000a1', 'a27a0000-a000-4000-8000-000000000004', 'a27a0000-a000-4000-8000-0000000000d1');
-- dispositions with the live shapes (the scratch schema has no seeding trigger)
insert into public.dispositions (org_id, key, label, lead_effect, ghl_tag, active, required_fields, sort) values
  ('a27a0000-a000-4000-8000-0000000000a1', 'yes_build_profile', 'Yes - Build Profile', 'completed', 'Interested', true, array['license_number', 'zips'], 10),
  ('a27a0000-a000-4000-8000-0000000000a1', 'callback', 'Callback', 'callback', 'Callback', true, null, 20),
  ('a27a0000-a000-4000-8000-0000000000a1', 'not_interested', 'Not interested', 'completed', 'Not Interested', true, null, 30),
  ('a27a0000-a000-4000-8000-0000000000a1', 'already_on_platform', 'Already on platform', 'exhausted', 'Already On Platform', true, null, 40),
  ('a27a0000-a000-4000-8000-0000000000a1', 'do_not_call', 'Do not call', 'dnc', 'DNC', true, null, 70),
  ('a27a0000-a000-4000-8000-0000000000a1', 'voicemail_left', 'Left voicemail', 'queued', null, true, null, 80),
  ('a27a0000-a000-4000-8000-0000000000a1', 'retired_key', 'Retired', 'completed', null, false, null, 99);
insert into public.org_integrations (org_id, provider, status) values ('a27a0000-a000-4000-8000-0000000000a1', 'ghl', 'connected');
-- contacts: c1 dnc test (lead), c2 completed (lead), c3 NOT readable by ag (no lead), c4 exhausted (lead), c5 callback no-op (lead),
-- c6 completed with a callback-status lead, c7 created AFTER the call (late resolve)
insert into public.contacts (id, user_id, org_id, business_name, phone_number) values
  ('a27a0000-a000-4000-8000-0000000000c1', 'a27a0000-a000-4000-8000-000000000001', 'a27a0000-a000-4000-8000-0000000000a1', 'One Co', '+13185550701'),
  ('a27a0000-a000-4000-8000-0000000000c2', 'a27a0000-a000-4000-8000-000000000001', 'a27a0000-a000-4000-8000-0000000000a1', 'Two Co', '+13185550702'),
  ('a27a0000-a000-4000-8000-0000000000c3', 'a27a0000-a000-4000-8000-000000000001', 'a27a0000-a000-4000-8000-0000000000a1', 'Three Co (not readable)', '+13185550703'),
  ('a27a0000-a000-4000-8000-0000000000c4', 'a27a0000-a000-4000-8000-000000000001', 'a27a0000-a000-4000-8000-0000000000a1', 'Four Co', '+13185550704'),
  ('a27a0000-a000-4000-8000-0000000000c5', 'a27a0000-a000-4000-8000-000000000001', 'a27a0000-a000-4000-8000-0000000000a1', 'Five Co', '+13185550705'),
  ('a27a0000-a000-4000-8000-0000000000c6', 'a27a0000-a000-4000-8000-000000000001', 'a27a0000-a000-4000-8000-0000000000a1', 'Six Co', '+13185550706');
insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('a27a2000-a000-4000-8000-00000000000a', 'a27a0000-a000-4000-8000-0000000000a1', 'a27a0000-a000-4000-8000-000000000001', 'H27 Campaign', '00:00', '23:59', 3, 45);
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts) values
  ('a27a5000-a000-4000-8000-000000000001', 'a27a2000-a000-4000-8000-00000000000a', 'a27a0000-a000-4000-8000-0000000000c1', 'a27a0000-a000-4000-8000-0000000000a1', 'queued', 0),
  ('a27a5000-a000-4000-8000-000000000002', 'a27a2000-a000-4000-8000-00000000000a', 'a27a0000-a000-4000-8000-0000000000c2', 'a27a0000-a000-4000-8000-0000000000a1', 'queued', 0),
  ('a27a5000-a000-4000-8000-000000000004', 'a27a2000-a000-4000-8000-00000000000a', 'a27a0000-a000-4000-8000-0000000000c4', 'a27a0000-a000-4000-8000-0000000000a1', 'queued', 0),
  ('a27a5000-a000-4000-8000-000000000005', 'a27a2000-a000-4000-8000-00000000000a', 'a27a0000-a000-4000-8000-0000000000c5', 'a27a0000-a000-4000-8000-0000000000a1', 'queued', 0),
  ('a27a5000-a000-4000-8000-000000000006', 'a27a2000-a000-4000-8000-00000000000a', 'a27a0000-a000-4000-8000-0000000000c6', 'a27a0000-a000-4000-8000-0000000000a1', 'callback', 0);
insert into public.campaign_agents (campaign_id, user_id, org_id) values
  ('a27a2000-a000-4000-8000-00000000000a', 'a27a0000-a000-4000-8000-000000000002', 'a27a0000-a000-4000-8000-0000000000a1'),
  ('a27a2000-a000-4000-8000-00000000000a', 'a27a0000-a000-4000-8000-000000000006', 'a27a0000-a000-4000-8000-0000000000a1');

create function pg_temp.run_as(p_uid text, p_sql text) returns text language plpgsql as $$
declare res text;
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  execute 'set local role ' || case when p_uid is null then 'anon' else 'authenticated' end;
  begin
    execute 'select coalesce(to_jsonb(r)::text, ''null'') from (' || p_sql || ') r limit 1' into res;
  exception when others then
    res := 'ERR ' || sqlstate || ': ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return res;
end $$;
-- DML as a signed-in user: 'OK <rows>' or 'ERR ...'
create function pg_temp.dml_as(p_uid text, p_sql text) returns text language plpgsql as $$
declare res text; n bigint;
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_uid, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    execute p_sql; get diagnostics n = row_count; res := 'OK ' || n;
  exception when others then
    res := 'ERR ' || sqlstate || ': ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return res;
end $$;
-- record a call (answered by default) started a minute ago
create function pg_temp.rec(p_key text, p_phone text, p_answered boolean default true, p_dir text default 'outbound', p_org text default 'a27a0000-a000-4000-8000-0000000000a1') returns text language sql as $$
  select format('select * from public.record_manual_call(%L::uuid, %L, %L, %L, %s, now() - interval ''1 minute'', now(), 42)', p_org, p_key, p_phone, p_dir, p_answered::text) $$;
create function pg_temp.lid(p_key text) returns text language sql as $$ select id::text from public.manual_call_logs where client_key = p_key $$;
create function pg_temp.setout(p_key text, p_disp text, p_notes text default null) returns text language sql as $$
  select format('select * from public.set_manual_call_outcome(%L::uuid, %L, %L)', pg_temp.lid(p_key), p_disp, p_notes) $$;

-- ===== 1. record_manual_call =========================================================================================
insert into r_cap select 'r1', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.rec('key-ag-call01', '(318) 555-0701'));
insert into t_res select 'agent records an answered call: id back, contact resolved (agent can read it), created, number normalised, user is the caller',
  (select v from r_cap where k='r1')::jsonb ->> 'created' = 'true'
  and (select v from r_cap where k='r1')::jsonb ->> 'contact_id' = 'a27a0000-a000-4000-8000-0000000000c1'
  and exists (select 1 from public.manual_call_logs where client_key = 'key-ag-call01' and phone = '+13185550701' and user_id = 'a27a0000-a000-4000-8000-000000000002'
              and org_id = 'a27a0000-a000-4000-8000-0000000000a1' and answered and direction = 'outbound' and duration_seconds = 42), (select v from r_cap where k='r1');
insert into r_cap select 'r1b', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.rec('key-ag-call01', '(318) 555-0701'));
insert into t_res select 'retry with the same client key: same id, created false, still ONE row',
  (select v from r_cap where k='r1b')::jsonb ->> 'created' = 'false' and (select v from r_cap where k='r1b')::jsonb ->> 'id' = (select v from r_cap where k='r1')::jsonb ->> 'id'
  and (select count(*) from public.manual_call_logs where client_key = 'key-ag-call01') = 1, (select v from r_cap where k='r1b');
insert into r_cap select 'r2', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.rec('key-ag-call02', '+13185550701', false, 'inbound'));
insert into t_res select 'control: a different key makes a second row', (select v from r_cap where k='r2') like '%"created": true%'
  and (select count(*) from public.manual_call_logs where phone = '+13185550701') = 2
  and exists (select 1 from public.manual_call_logs where client_key = 'key-ag-call02' and not answered and direction = 'inbound'), null;
insert into r_cap select 'r3', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.rec('key-ag-call03', '+13185550703'));
insert into t_res select 'a contact the agent cannot read is NOT revealed: contact_id null in the answer and on the row, the call is still recorded',
  (select v from r_cap where k='r3')::jsonb ->> 'contact_id' is null and exists (select 1 from public.manual_call_logs where client_key = 'key-ag-call03' and contact_id is null), (select v from r_cap where k='r3');
insert into t_res select 'control: the owner recording the same number DOES resolve the contact',
  pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', pg_temp.rec('key-o-call03', '+13185550703'))::jsonb ->> 'contact_id' = 'a27a0000-a000-4000-8000-0000000000c3', null;
insert into r_cap select 'r4', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.rec('key-ag-unk01', '+13185559999'));
insert into t_res select 'an unknown number records with contact null', (select v from r_cap where k='r4')::jsonb ->> 'contact_id' is null
  and exists (select 1 from public.manual_call_logs where client_key = 'key-ag-unk01'), null;
insert into r_cap select 'r5', pg_temp.run_as('a27a0000-a000-4000-8000-000000000003', pg_temp.rec('key-ag-call01', '+13185550701'));
insert into t_res select 'the same client key from ANOTHER user is a separate row (keys are per user)', (select v from r_cap where k='r5') like '%"created": true%'
  and (select count(*) from public.manual_call_logs where client_key = 'key-ag-call01') = 2, null;
insert into t_res select 'validation: bad direction, short key, bad phone, old/future start, end before start, bad duration are all 22023',
  pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.rec('key-bad-0001', '+13185550701', true, 'sideways')) like 'ERR 22023%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.rec('short', '+13185550701')) like 'ERR 22023%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.rec('key-bad-0002', '123')) like 'ERR 22023%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', $q$ select * from public.record_manual_call('a27a0000-a000-4000-8000-0000000000a1', 'key-bad-0003', '+13185550701', 'outbound', true, now() - interval '3 days') $q$) like 'ERR 22023%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', $q$ select * from public.record_manual_call('a27a0000-a000-4000-8000-0000000000a1', 'key-bad-0004', '+13185550701', 'outbound', true, now() + interval '1 hour') $q$) like 'ERR 22023%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', $q$ select * from public.record_manual_call('a27a0000-a000-4000-8000-0000000000a1', 'key-bad-0005', '+13185550701', 'outbound', true, now(), now() - interval '1 hour') $q$) like 'ERR 22023%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', $q$ select * from public.record_manual_call('a27a0000-a000-4000-8000-0000000000a1', 'key-bad-0006', '+13185550701', 'outbound', true, now(), now(), -5) $q$) like 'ERR 22023%'
  and not exists (select 1 from public.manual_call_logs where client_key like 'key-bad-%'), null;
insert into t_res select 'a non-member (org B owner) cannot record in org A (42501); anon is refused', pg_temp.run_as('a27a0000-a000-4000-8000-000000000005', pg_temp.rec('key-x-call01', '+13185550701')) like 'ERR 42501%'
  and pg_temp.run_as(null, pg_temp.rec('key-anon-001', '+13185550701')) like 'ERR%' and not exists (select 1 from public.manual_call_logs where client_key in ('key-x-call01', 'key-anon-001')), null;


-- ===== 2. visibility (RLS) and no client writes =====================================================================
insert into r_cap select 'agp1', pg_temp.run_as('a27a0000-a000-4000-8000-000000000006', pg_temp.rec('key-agp-call01', '+13185550702'));
insert into t_res select 'RLS: an agent reads only their own rows (and has some)', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', 'select count(*) as n from public.manual_call_logs')::jsonb ->> 'n' = (select count(*)::text from public.manual_call_logs where user_id = 'a27a0000-a000-4000-8000-000000000002')
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', 'select count(*) as n from public.manual_call_logs where user_id <> auth.uid()')::jsonb ->> 'n' = '0'
  and (select count(*) from public.manual_call_logs where user_id = 'a27a0000-a000-4000-8000-000000000002') >= 3, null;
insert into t_res select 'RLS: the owner reads every org A row', pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', 'select count(*) as n from public.manual_call_logs')::jsonb ->> 'n' = (select count(*)::text from public.manual_call_logs), null;
insert into t_res select 'RLS: a manager reads ONLY rows of agents in their pod (agp), not ag or ag2', pg_temp.run_as('a27a0000-a000-4000-8000-000000000004', 'select count(*) as n from public.manual_call_logs')::jsonb ->> 'n' = (select count(*)::text from public.manual_call_logs where user_id = 'a27a0000-a000-4000-8000-000000000006')
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000004', 'select count(*) as n from public.manual_call_logs')::jsonb ->> 'n' <> '0', null;
insert into t_res select 'RLS: ag2 sees nothing of others, org B owner sees none, anon is denied',
  pg_temp.run_as('a27a0000-a000-4000-8000-000000000003', 'select count(*) as n from public.manual_call_logs where user_id <> auth.uid()')::jsonb ->> 'n' = '0'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000005', 'select count(*) as n from public.manual_call_logs')::jsonb ->> 'n' = '0'
  and pg_temp.run_as(null, 'select * from public.manual_call_logs') like 'ERR 42501%', null;
insert into t_res select 'no client writes: insert, update and delete are denied for agent AND owner',
  pg_temp.dml_as('a27a0000-a000-4000-8000-000000000002', $q$ insert into public.manual_call_logs (org_id, user_id, phone, direction, answered, started_at, client_key) values ('a27a0000-a000-4000-8000-0000000000a1', 'a27a0000-a000-4000-8000-000000000002', '+13185550701', 'outbound', true, now(), 'key-direct-01') $q$) like 'ERR 42501%'
  and pg_temp.dml_as('a27a0000-a000-4000-8000-000000000001', $q$ update public.manual_call_logs set notes = 'x' $q$) like 'ERR 42501%'
  and pg_temp.dml_as('a27a0000-a000-4000-8000-000000000001', $q$ delete from public.manual_call_logs $q$) like 'ERR 42501%', null;
insert into t_res select 'RLS is enabled on manual_call_logs', (select relrowsecurity from pg_class where relname = 'manual_call_logs'), null;

-- ===== 3. set_manual_call_outcome ====================================================================================
-- dnc on c1 (the agent can read it): contact dnc, its lead dnc, number in dnc_numbers, one GHL job keyed on the log id
insert into r_cap select 'o1', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', format('select * from public.set_manual_call_outcome(%L::uuid, ''do_not_call'', ''asked to stop'')', (select id from public.manual_call_logs where client_key = 'key-ag-call01' and user_id = 'a27a0000-a000-4000-8000-000000000002')));
insert into t_res select 'outcome do_not_call (own call, readable contact): dnc applied to the contact, its lead and dnc_numbers',
  (select v from r_cap where k='o1')::jsonb ->> 'effect' = 'dnc' and (select v from r_cap where k='o1')::jsonb ->> 'contact_effect' = 'applied'
  and (select dnc from public.contacts where id = 'a27a0000-a000-4000-8000-0000000000c1')
  and (select status from public.campaign_leads where id = 'a27a5000-a000-4000-8000-000000000001') = 'dnc'
  and exists (select 1 from public.dnc_numbers where org_id = 'a27a0000-a000-4000-8000-0000000000a1' and e164 = '+13185550701' and source = 'disposition'), (select v from r_cap where k='o1');
insert into t_res select 'the row keeps the outcome + note and applied_effect',
  exists (select 1 from public.manual_call_logs l join public.dispositions d on d.id = l.disposition_id where l.client_key = 'key-ag-call01' and l.user_id = 'a27a0000-a000-4000-8000-000000000002' and d.key = 'do_not_call' and l.notes = 'asked to stop' and l.applied_effect = 'dnc'), null;
insert into t_res select 'GHL: exactly one disposition job keyed on the log id (no call leg), carrying the outcome and no recording',
  (select count(*) from public.crm_sync_jobs where kind = 'disposition' and call_leg_id = (select id from public.manual_call_logs where client_key = 'key-ag-call01' and user_id = 'a27a0000-a000-4000-8000-000000000002')) = 1
  and exists (select 1 from public.crm_sync_jobs where kind = 'disposition' and payload ->> 'disposition_key' = 'do_not_call' and payload ->> 'notes' = 'asked to stop' and payload -> 'recording_url' = 'null'::jsonb and (payload ->> 'is_dnc')::boolean), null;
-- re-save applies nothing. Control: reset the effects by hand first, then re-save and see they stay reset.
update public.contacts set dnc = false where id = 'a27a0000-a000-4000-8000-0000000000c1';
update public.campaign_leads set status = 'queued' where id = 'a27a5000-a000-4000-8000-000000000001';
insert into r_cap select 'o1b', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', format('select * from public.set_manual_call_outcome(%L::uuid, ''do_not_call'', ''asked to stop'')', (select id from public.manual_call_logs where client_key = 'key-ag-call01' and user_id = 'a27a0000-a000-4000-8000-000000000002')));
insert into t_res select 're-saving the same outcome re-applies nothing: contact and lead stay as reset, still one job, contact_effect already_applied',
  (select v from r_cap where k='o1b')::jsonb ->> 'contact_effect' = 'already_applied'
  and not (select dnc from public.contacts where id = 'a27a0000-a000-4000-8000-0000000000c1')
  and (select status from public.campaign_leads where id = 'a27a5000-a000-4000-8000-000000000001') = 'queued'
  and (select count(*) from public.crm_sync_jobs where kind = 'disposition' and call_leg_id = (select id from public.manual_call_logs where client_key = 'key-ag-call01' and user_id = 'a27a0000-a000-4000-8000-000000000002')) = 1, (select v from r_cap where k='o1b');
update public.contacts set dnc = true where id = 'a27a0000-a000-4000-8000-0000000000c1';
update public.campaign_leads set status = 'dnc' where id = 'a27a5000-a000-4000-8000-000000000001';
insert into r_cap select 'o1c', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', format('select * from public.set_manual_call_outcome(%L::uuid, ''not_interested'')', (select id from public.manual_call_logs where client_key = 'key-ag-call01' and user_id = 'a27a0000-a000-4000-8000-000000000002')));
insert into t_res select 'DNC is never downgraded by a later outcome: lead and contact stay dnc, applied_effect stays dnc',
  (select status from public.campaign_leads where id = 'a27a5000-a000-4000-8000-000000000001') = 'dnc'
  and (select dnc from public.contacts where id = 'a27a0000-a000-4000-8000-0000000000c1')
  and exists (select 1 from public.manual_call_logs where client_key = 'key-ag-call01' and user_id = 'a27a0000-a000-4000-8000-000000000002' and applied_effect = 'dnc'), (select v from r_cap where k='o1c');
-- completed / exhausted / callback-status lead / queued and callback = no change
insert into r_cap select 'k2', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.rec('key-ag-call-c2', '+13185550702'));
insert into r_cap select 'o2', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.setout('key-ag-call-c2', 'not_interested'));
insert into t_res select 'outcome not_interested (completed): the queued lead becomes completed, contact not DNC',
  (select status from public.campaign_leads where id = 'a27a5000-a000-4000-8000-000000000002') = 'completed' and not (select dnc from public.contacts where id = 'a27a0000-a000-4000-8000-0000000000c2')
  and (select v from r_cap where k='o2')::jsonb ->> 'effect' = 'completed', (select v from r_cap where k='o2');
insert into r_cap select 'k4', pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', pg_temp.rec('key-o-call-c4', '+13185550704'));
insert into r_cap select 'o4', pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', pg_temp.setout('key-o-call-c4', 'already_on_platform'));
insert into t_res select 'outcome already_on_platform (exhausted): the queued lead becomes exhausted', (select status from public.campaign_leads where id = 'a27a5000-a000-4000-8000-000000000004') = 'exhausted', (select v from r_cap where k='o4');
insert into r_cap select 'k6', pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', pg_temp.rec('key-o-call-c6', '+13185550706'));
insert into r_cap select 'o6', pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', pg_temp.setout('key-o-call-c6', 'not_interested'));
insert into t_res select 'a lead in callback status also takes completed', (select status from public.campaign_leads where id = 'a27a5000-a000-4000-8000-000000000006') = 'completed', (select v from r_cap where k='o6');
insert into r_cap select 'k5', pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', pg_temp.rec('key-o-call-c5', '+13185550705'));
insert into r_cap select 'o5a', pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', pg_temp.setout('key-o-call-c5', 'callback'));
insert into r_cap select 'o5b', pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', pg_temp.setout('key-o-call-c5', 'voicemail_left'));
insert into t_res select 'outcomes callback and voicemail_left change no lead', (select status from public.campaign_leads where id = 'a27a5000-a000-4000-8000-000000000005') = 'queued'
  and (select v from r_cap where k='o5a')::jsonb ->> 'contact_effect' = 'none', (select v from r_cap where k='o5a');
insert into t_res select 'changing the outcome on the same call keeps ONE row and updates the disposition', (select count(*) from public.manual_call_logs where client_key = 'key-o-call-c5') = 1
  and exists (select 1 from public.manual_call_logs l join public.dispositions d on d.id = l.disposition_id where l.client_key = 'key-o-call-c5' and d.key = 'voicemail_left'), null;
-- no contact access: c3 is not readable by ag
insert into r_cap select 'o3', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.setout('key-ag-call03', 'do_not_call'));
insert into t_res select 'no contact access: the number is STILL added to dnc_numbers, the contact and its leads are untouched, no GHL job',
  exists (select 1 from public.dnc_numbers where org_id = 'a27a0000-a000-4000-8000-0000000000a1' and e164 = '+13185550703')
  and not (select dnc from public.contacts where id = 'a27a0000-a000-4000-8000-0000000000c3')
  and (select v from r_cap where k='o3')::jsonb ->> 'contact_effect' = 'skipped_no_access'
  and not exists (select 1 from public.crm_sync_jobs where call_leg_id = (select id from public.manual_call_logs where client_key = 'key-ag-call03')), (select v from r_cap where k='o3');
-- who may set an outcome
insert into t_res select 'another agent, a manager and an org B owner cannot set the outcome of ag''s call (42501), nothing written',
  pg_temp.run_as('a27a0000-a000-4000-8000-000000000003', format('select * from public.set_manual_call_outcome(%L::uuid, ''callback'')', (select id from public.manual_call_logs where client_key = 'key-ag-call02'))) like 'ERR 42501%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000004', format('select * from public.set_manual_call_outcome(%L::uuid, ''callback'')', (select id from public.manual_call_logs where client_key = 'key-ag-call02'))) like 'ERR 42501%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000005', format('select * from public.set_manual_call_outcome(%L::uuid, ''callback'')', (select id from public.manual_call_logs where client_key = 'key-ag-call02'))) like 'ERR 42501%'
  and not exists (select 1 from public.manual_call_logs where client_key = 'key-ag-call02' and user_id = 'a27a0000-a000-4000-8000-000000000002' and disposition_id is not null), null;
insert into r_cap select 'oc', pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', format('select * from public.set_manual_call_outcome(%L::uuid, ''callback'')', (select id from public.manual_call_logs where client_key = 'key-ag-call02' and user_id = 'a27a0000-a000-4000-8000-000000000002')));
insert into t_res select 'control: the owner CAN set the outcome of an agent''s call', (select v from r_cap where k='oc') not like 'ERR%'
  and exists (select 1 from public.manual_call_logs where client_key = 'key-ag-call02' and user_id = 'a27a0000-a000-4000-8000-000000000002' and disposition_id is not null), null;
insert into t_res select 'bad input: required-fields outcome, inactive key, unknown key, nothing to save, long notes, unknown call id',
  pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.setout('key-ag-unk01', 'yes_build_profile')) like 'ERR 22023%Log close%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.setout('key-ag-unk01', 'retired_key')) like 'ERR 22023%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.setout('key-ag-unk01', 'nope')) like 'ERR 22023%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', format('select * from public.set_manual_call_outcome(%L::uuid, null, null)', pg_temp.lid('key-ag-unk01'))) like 'ERR 22023%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.setout('key-ag-unk01', 'callback', repeat('x', 2001))) like 'ERR 22023%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', $q$ select * from public.set_manual_call_outcome('a27a9999-a000-4000-8000-000000000000', 'callback') $q$) like 'ERR P0002%'
  and not exists (select 1 from public.manual_call_logs where client_key = 'key-ag-unk01' and (disposition_id is not null or notes is not null)), null;
insert into r_cap select 'nt', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', format('select * from public.set_manual_call_outcome(%L::uuid, null, ''left a message with a neighbour'')', pg_temp.lid('key-ag-unk01')));
insert into t_res select 'notes alone are allowed (no outcome)',
  (select v from r_cap where k='nt') not like 'ERR%'
  and exists (select 1 from public.manual_call_logs where client_key = 'key-ag-unk01' and notes = 'left a message with a neighbour' and disposition_id is null), null;
insert into r_cap select 'u1', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.setout('key-ag-unk01', 'voicemail_left'));
insert into t_res select 'unknown number + outcome: no contact effect and no GHL job (nothing readable to push)', (select v from r_cap where k='u1')::jsonb ->> 'contact_effect' = 'none'
  and not exists (select 1 from public.crm_sync_jobs where call_leg_id = (select id from public.manual_call_logs where client_key = 'key-ag-unk01')), (select v from r_cap where k='u1');
-- late resolve: a call recorded before the contact existed; once the contact exists and the agent can read it, the outcome applies
insert into r_cap select 'late0', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.rec('key-ag-late01', '+13185550777'));
insert into public.contacts (id, user_id, org_id, business_name, phone_number) values ('a27a0000-a000-4000-8000-0000000000c7', 'a27a0000-a000-4000-8000-000000000001', 'a27a0000-a000-4000-8000-0000000000a1', 'Late Co', '+13185550777');
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts) values ('a27a5000-a000-4000-8000-000000000007', 'a27a2000-a000-4000-8000-00000000000a', 'a27a0000-a000-4000-8000-0000000000c7', 'a27a0000-a000-4000-8000-0000000000a1', 'queued', 0);
insert into r_cap select 'late1', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', pg_temp.setout('key-ag-late01', 'not_interested'));
insert into t_res select 'a contact created after the call is found by phone when the outcome is saved: the row gets the contact_id and the effect applies',
  exists (select 1 from public.manual_call_logs where client_key = 'key-ag-late01' and contact_id = 'a27a0000-a000-4000-8000-0000000000c7')
  and (select status from public.campaign_leads where id = 'a27a5000-a000-4000-8000-000000000007') = 'completed', (select v from r_cap where k='late1');
-- GHL not connected: no job, no error
update public.org_integrations set status = 'disconnected' where org_id = 'a27a0000-a000-4000-8000-0000000000a1';
insert into r_cap select 'gx', pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', pg_temp.setout('key-o-call03', 'not_interested'));
insert into t_res select 'GHL not connected: the outcome saves, no job is queued', (select v from r_cap where k='gx') not like 'ERR%' and not exists (select 1 from public.crm_sync_jobs where call_leg_id = (select id from public.manual_call_logs where client_key = 'key-o-call03')), (select v from r_cap where k='gx');
update public.org_integrations set status = 'connected' where org_id = 'a27a0000-a000-4000-8000-0000000000a1';

-- ===== 4. list_contact_manual_calls ==================================================================================
insert into t_res select 'list (agent): only their own calls on c1', pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', $q$ select count(*) as n, count(*) filter (where user_id <> auth.uid()) as others from public.list_contact_manual_calls('a27a0000-a000-4000-8000-0000000000c1') $q$)::jsonb = '{"n": 2, "others": 0}'::jsonb
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', $q$ select disposition_key as k from public.list_contact_manual_calls('a27a0000-a000-4000-8000-0000000000c1') where disposition_key is not null $q$)::jsonb ->> 'k' = 'not_interested', null;
insert into t_res select 'list (owner): sees every user''s calls on that number (ag and ag2 on c1)', (pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', $q$ select count(*) as n from public.list_contact_manual_calls('a27a0000-a000-4000-8000-0000000000c1') $q$)::jsonb ->> 'n')::int >= 3, null;
insert into t_res select 'list: refused for an unreadable contact (agent, c3), another org, anon; unknown contact is P0002',
  pg_temp.run_as('a27a0000-a000-4000-8000-000000000002', $q$ select * from public.list_contact_manual_calls('a27a0000-a000-4000-8000-0000000000c3') $q$) like 'ERR 42501%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000001', $q$ select * from public.list_contact_manual_calls('a27a9999-a000-4000-8000-000000000000') $q$) like 'ERR P0002%'
  and pg_temp.run_as('a27a0000-a000-4000-8000-000000000005', $q$ select * from public.list_contact_manual_calls('a27a0000-a000-4000-8000-0000000000c1') $q$) like 'ERR 42501%'
  and pg_temp.run_as(null, $q$ select * from public.list_contact_manual_calls('a27a0000-a000-4000-8000-0000000000c1') $q$) like 'ERR%', null;
insert into t_res select 'list (agp, another agent on the campaign): sees none of ag''s calls on c1', pg_temp.run_as('a27a0000-a000-4000-8000-000000000006', $q$ select count(*) as n from public.list_contact_manual_calls('a27a0000-a000-4000-8000-0000000000c1') $q$)::jsonb ->> 'n' = '0', null;
insert into t_res select 'list (agp): sees their own call on c2', pg_temp.run_as('a27a0000-a000-4000-8000-000000000006', $q$ select count(*) as n from public.list_contact_manual_calls('a27a0000-a000-4000-8000-0000000000c2') $q$)::jsonb ->> 'n' = '1', null;

-- ===== 5. grants and disabled members ================================================================================
insert into t_res select 'the three functions are callable by authenticated, not by anon', has_function_privilege('authenticated', 'public.record_manual_call(uuid,text,text,text,boolean,timestamptz,timestamptz,integer)', 'execute')
  and has_function_privilege('authenticated', 'public.set_manual_call_outcome(uuid,text,text)', 'execute')
  and has_function_privilege('authenticated', 'public.list_contact_manual_calls(uuid,integer)', 'execute')
  and not has_function_privilege('anon', 'public.record_manual_call(uuid,text,text,text,boolean,timestamptz,timestamptz,integer)', 'execute')
  and not has_function_privilege('anon', 'public.set_manual_call_outcome(uuid,text,text)', 'execute')
  and not has_function_privilege('anon', 'public.list_contact_manual_calls(uuid,integer)', 'execute'), null;
update public.org_members set status = 'disabled' where user_id = 'a27a0000-a000-4000-8000-000000000003';
insert into t_res select 'a disabled member cannot record (42501)', pg_temp.run_as('a27a0000-a000-4000-8000-000000000003', pg_temp.rec('key-ag2-disab1', '+13185550701')) like 'ERR 42501%'
  and not exists (select 1 from public.manual_call_logs where client_key = 'key-ag2-disab1'), null;

select jsonb_build_object('failed', coalesce((select jsonb_agg(label) from t_res where ok is not true), '[]'::jsonb), 'n', (select count(*) from t_res)) as result;
rollback;

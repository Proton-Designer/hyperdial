-- TASK-H25 tests: public.list_onboarded_pros. One batch, ROLLED BACK. Needs migration *_h25_list_onboarded_pros.sql applied
-- (without it every check that calls the RPC fails: positive control). Result: {failed:[labels], n}.
begin;
create temp table t_res(label text, ok boolean, detail text) on commit drop;
create temp table r_cap(k text, v text) on commit drop;
grant all on r_cap to public;
grant all on t_res to public;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $fx$ begin return new; end; $fx$;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.em, crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false
from (values
  ('a25a0000-a000-4000-8000-000000000001', 'h25-o@example.com'),
  ('a25a0000-a000-4000-8000-000000000002', 'h25-ag@example.com'),
  ('a25a0000-a000-4000-8000-000000000003', 'h25-mg@example.com'),
  ('a25a0000-a000-4000-8000-000000000004', 'h25-ad@example.com'),
  ('a25a0000-a000-4000-8000-000000000005', 'h25-ob@example.com'),
  ('a25a0000-a000-4000-8000-000000000006', 'h25-nm@example.com'),
  ('a25a0000-a000-4000-8000-000000000007', 'h25-mg2@example.com')
) u(id, em);

insert into public.orgs (id, name, created_by) values
  ('a25a0000-a000-4000-8000-0000000000a1', 'H25 A', 'a25a0000-a000-4000-8000-000000000001'),
  ('a25a0000-a000-4000-8000-0000000000b2', 'H25 B', 'a25a0000-a000-4000-8000-000000000005'),
  ('a25a0000-a000-4000-8000-0000000000c3', 'H25 C (empty)', 'a25a0000-a000-4000-8000-000000000001');
insert into public.org_members (org_id, user_id, role, status) values
  ('a25a0000-a000-4000-8000-0000000000a1', 'a25a0000-a000-4000-8000-000000000001', 'owner', 'active'),
  ('a25a0000-a000-4000-8000-0000000000a1', 'a25a0000-a000-4000-8000-000000000002', 'agent', 'active'),
  ('a25a0000-a000-4000-8000-0000000000a1', 'a25a0000-a000-4000-8000-000000000003', 'manager', 'active'),
  ('a25a0000-a000-4000-8000-0000000000a1', 'a25a0000-a000-4000-8000-000000000004', 'admin', 'active'),
  ('a25a0000-a000-4000-8000-0000000000a1', 'a25a0000-a000-4000-8000-000000000007', 'manager', 'active'),
  ('a25a0000-a000-4000-8000-0000000000b2', 'a25a0000-a000-4000-8000-000000000005', 'owner', 'active'),
  ('a25a0000-a000-4000-8000-0000000000c3', 'a25a0000-a000-4000-8000-000000000001', 'owner', 'active')
on conflict (org_id, user_id) do update set role = excluded.role, status = 'active';
insert into public.profiles (user_id, first_name, last_name) values
  ('a25a0000-a000-4000-8000-000000000002', 'Ann', 'Agent'),
  ('a25a0000-a000-4000-8000-000000000001', 'Olive', null)
on conflict (user_id) do update set first_name = excluded.first_name, last_name = excluded.last_name;

-- org A: c1 closed TWICE (older by agent, newer by owner; must show once, latest values, close_count 2), c2 closed once by the
-- agent with 2 services + 2 cities, c3 never closed (must not appear). org B: c4 closed once (must never show in A).
insert into public.contacts (id, user_id, org_id, business_name, phone_number) values
  ('a25a0000-a000-4000-8000-0000000000d1', 'a25a0000-a000-4000-8000-000000000001', 'a25a0000-a000-4000-8000-0000000000a1', 'One Co', '+13185550201'),
  ('a25a0000-a000-4000-8000-0000000000d2', 'a25a0000-a000-4000-8000-000000000001', 'a25a0000-a000-4000-8000-0000000000a1', 'Two Co', '+13185550202'),
  ('a25a0000-a000-4000-8000-0000000000d3', 'a25a0000-a000-4000-8000-000000000001', 'a25a0000-a000-4000-8000-0000000000a1', 'Never Closed', '+13185550203'),
  ('a25a0000-a000-4000-8000-0000000000d4', 'a25a0000-a000-4000-8000-000000000005', 'a25a0000-a000-4000-8000-0000000000b2', 'B Co', '+13185550204');
insert into public.contact_closes (id, org_id, contact_id, closed_by, owner_name, business_name, mobile, services, cities, frequencies, insured, delivery_status, created_at) values
  ('a25a0000-a000-4000-8000-0000000000e1', 'a25a0000-a000-4000-8000-0000000000a1', 'a25a0000-a000-4000-8000-0000000000d1', 'a25a0000-a000-4000-8000-000000000002', 'Old Owner', 'One Co OLD', '+13185550201', array['Cleaning'], array['Monroe'], array['weekly'], false, 'not_configured', now() - interval '10 days'),
  ('a25a0000-a000-4000-8000-0000000000e2', 'a25a0000-a000-4000-8000-0000000000a1', 'a25a0000-a000-4000-8000-0000000000d1', 'a25a0000-a000-4000-8000-000000000001', 'New Owner', 'One Co', '+13185550201', array['Cleaning','Lawn'], array['Monroe','Ruston'], array['weekly','monthly'], true, 'not_configured', now() - interval '1 day'),
  ('a25a0000-a000-4000-8000-0000000000e3', 'a25a0000-a000-4000-8000-0000000000a1', 'a25a0000-a000-4000-8000-0000000000d2', 'a25a0000-a000-4000-8000-000000000002', 'Two Owner', 'Two Co', '+13185550202', array['Pool'], array['West Monroe'], array['monthly'], true, 'not_configured', now() - interval '2 hours'),
  ('a25a0000-a000-4000-8000-0000000000e4', 'a25a0000-a000-4000-8000-0000000000b2', 'a25a0000-a000-4000-8000-0000000000d4', 'a25a0000-a000-4000-8000-000000000005', 'B Owner', 'B Co', '+13185550204', array['Roofing'], array['Dallas'], array['weekly'], true, 'not_configured', now());

-- pods: manager u3 manages pod P1; the agent u2 is in P1; manager u7 has NO pods. (u1 owner is in no pod.)
insert into public.org_pods (id, org_id, name) values ('a25a0000-a000-4000-8000-0000000000f1', 'a25a0000-a000-4000-8000-0000000000a1', 'H25 pod');
update public.org_members set pod_id = 'a25a0000-a000-4000-8000-0000000000f1' where org_id = 'a25a0000-a000-4000-8000-0000000000a1' and user_id = 'a25a0000-a000-4000-8000-000000000002';
insert into public.org_manager_pods (org_id, manager_user_id, pod_id) values ('a25a0000-a000-4000-8000-0000000000a1', 'a25a0000-a000-4000-8000-000000000003', 'a25a0000-a000-4000-8000-0000000000f1');
insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('a25a2000-a000-4000-8000-00000000000a', 'a25a0000-a000-4000-8000-0000000000a1', 'a25a0000-a000-4000-8000-000000000001', 'H25 Campaign', '00:00', '23:59', 3, 45);

create function pg_temp.run_as(p_uid text, p_sql text) returns text language plpgsql as $$
declare res text;
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  execute 'set local role ' || case when p_uid is null then 'anon' else 'authenticated' end;
  begin
    execute 'select coalesce(jsonb_agg(to_jsonb(r)), ''[]''::jsonb)::text from (' || p_sql || ') r' into res;
  exception when others then
    res := 'ERR ' || sqlstate || ': ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return res;
end $$;


insert into r_cap select 'ro', pg_temp.run_as('a25a0000-a000-4000-8000-000000000001', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000a1'));
insert into t_res select 'owner: one row per closed contact (2), never-closed contact absent, org B absent', jsonb_array_length((select v from r_cap where k='ro')::jsonb) = 2 and not ((select v from r_cap where k='ro') like '%Never Closed%') and not ((select v from r_cap where k='ro') like '%B Co%') and not ((select v from r_cap where k='ro') like '%Roofing%'), (select v from r_cap where k='ro');
insert into t_res select 'owner: a contact closed twice shows its LATEST close (values, closer) with close_count 2', exists (
  select 1 from jsonb_to_recordset((select v from r_cap where k='ro')::jsonb) r(business_name text, owner_name text, services text[], cities text[], close_count bigint, closed_by uuid, closed_by_name text)
  where business_name = 'One Co' and owner_name = 'New Owner' and services = array['Cleaning','Lawn'] and cities = array['Monroe','Ruston'] and close_count = 2 and closed_by = 'a25a0000-a000-4000-8000-000000000001'::uuid and closed_by_name = 'Olive'), null;
insert into t_res select 'owner: newest first, closer name from profiles, total_count = 2', ((select v from r_cap where k='ro')::jsonb -> 0 ->> 'business_name') = 'Two Co' and ((select v from r_cap where k='ro')::jsonb -> 0 ->> 'closed_by_name') = 'Ann Agent' and ((select v from r_cap where k='ro')::jsonb -> 0 ->> 'total_count') = '2', null;
insert into t_res select 'owner: row carries every column the list shows', (select bool_and(r ?& array['close_id','contact_id','business_name','owner_name','mobile','email','services','cities','frequencies','insured','starting_price','capacity','years_in_business','closed_by_name','closed_at']) from jsonb_array_elements((select v from r_cap where k='ro')::jsonb) r), null;

insert into t_res select 'admin sees the same list', jsonb_array_length(pg_temp.run_as('a25a0000-a000-4000-8000-000000000004', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000a1'))::jsonb) = 2, null;
insert into t_res select 'MANAGER with pod P1 (agent u2 in it) sees ONLY the pros closed by pod agents: Two Co, total_count scoped to 1, not One Co (latest close by the owner, outside the pod)', (select jsonb_array_length(x) = 1 and (x -> 0 ->> 'business_name') = 'Two Co' and (x -> 0 ->> 'total_count') = '1' from (select pg_temp.run_as('a25a0000-a000-4000-8000-000000000003', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000a1'))::jsonb x) q), null;
insert into t_res select 'MANAGER with NO pods sees none', pg_temp.run_as('a25a0000-a000-4000-8000-000000000007', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000a1')) = '[]', null;
-- a lead for One Co assigned to the pod agent brings that pro into the manager's scope
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts, assigned_agent_id) values ('a25a5000-a000-4000-8000-00000000000a', 'a25a2000-a000-4000-8000-00000000000a', 'a25a0000-a000-4000-8000-0000000000d1', 'a25a0000-a000-4000-8000-0000000000a1', 'queued', 0, 'a25a0000-a000-4000-8000-000000000002');
insert into t_res select 'manager: a pro whose contact has a lead assigned to a pod agent is in scope (2 rows, close_count of One Co still 2)', (select jsonb_array_length(x) = 2 and (x -> 0 ->> 'total_count') = '2' from (select pg_temp.run_as('a25a0000-a000-4000-8000-000000000003', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000a1'))::jsonb x) q), null;
insert into t_res select 'the other manager (no pods) still sees none after the lead assignment', pg_temp.run_as('a25a0000-a000-4000-8000-000000000007', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000a1')) = '[]', null;
insert into t_res select 'AGENT is refused (42501)', pg_temp.run_as('a25a0000-a000-4000-8000-000000000002', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000a1')) like 'ERR 42501%', null;
insert into t_res select 'member of another org is refused for org A (42501)', pg_temp.run_as('a25a0000-a000-4000-8000-000000000005', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000a1')) like 'ERR 42501%', null;
insert into t_res select 'user with no membership is refused (42501)', pg_temp.run_as('a25a0000-a000-4000-8000-000000000006', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000a1')) like 'ERR 42501%', null;
insert into t_res select 'null org is refused (42501)', pg_temp.run_as('a25a0000-a000-4000-8000-000000000001', 'select * from public.list_onboarded_pros(null)') like 'ERR 42501%', null;
insert into t_res select 'no JWT cannot call it', pg_temp.run_as(null, format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000a1')) like 'ERR%', null;
insert into t_res select 'other org: owner of B sees only B (1 row, B Co), none of A', (pg_temp.run_as('a25a0000-a000-4000-8000-000000000005', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000b2'))::jsonb -> 0 ->> 'business_name') = 'B Co' and jsonb_array_length(pg_temp.run_as('a25a0000-a000-4000-8000-000000000005', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000b2'))::jsonb) = 1, null;
insert into t_res select 'org with no closes: empty list, no error', pg_temp.run_as('a25a0000-a000-4000-8000-000000000001', format('select * from public.list_onboarded_pros(%L)', 'a25a0000-a000-4000-8000-0000000000c3')) = '[]', null;
insert into t_res select 'limit works and total_count still says the full number', (select jsonb_array_length(x) = 1 and (x -> 0 ->> 'total_count') = '2' from (select pg_temp.run_as('a25a0000-a000-4000-8000-000000000001', format('select * from public.list_onboarded_pros(%L, 1)', 'a25a0000-a000-4000-8000-0000000000a1'))::jsonb x) q), null;
insert into t_res select 'anon has no execute grant', not has_function_privilege('anon', 'public.list_onboarded_pros(uuid,integer)', 'execute'), null;

select jsonb_build_object('failed', coalesce((select jsonb_agg(label) from t_res where ok is not true), '[]'::jsonb), 'n', (select count(*) from t_res)) as result;
rollback;

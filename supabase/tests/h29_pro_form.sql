-- TASK-H29 tests: pro_form_links / pro_applications / pro_form_attempts + get_my_pro_form_link, rotate_my_pro_form_link,
-- get_pro_form_info, submit_pro_application (service only), review_pro_application, list_pro_applications.
-- One batch, ROLLED BACK. Needs *_h29_pro_form.sql (and the H28 migration) applied. Result: one row {failed:[labels], n:count}.
begin;
create temp table t_res(label text, ok boolean, detail text) on commit drop;
create temp table r_cap(k text, v text) on commit drop;
grant all on r_cap to public;
grant all on t_res to public;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $fx$ begin return new; end; $fx$;

-- users: o owner, ad admin, mg manager of pod p1, mg2 manager with no pods, ag1 agent in p1, ag2 agent outside p1,
-- gone agent (deactivated later), x owner of org B only, nm no membership
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.em, crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false
from (values
  ('a29a0000-a000-4000-8000-000000000001', 'h29-o@example.com'),
  ('a29a0000-a000-4000-8000-000000000002', 'h29-ag1@example.com'),
  ('a29a0000-a000-4000-8000-000000000003', 'h29-ag2@example.com'),
  ('a29a0000-a000-4000-8000-000000000004', 'h29-mg@example.com'),
  ('a29a0000-a000-4000-8000-000000000005', 'h29-x@example.com'),
  ('a29a0000-a000-4000-8000-000000000006', 'h29-ad@example.com'),
  ('a29a0000-a000-4000-8000-000000000007', 'h29-mg2@example.com'),
  ('a29a0000-a000-4000-8000-000000000008', 'h29-nm@example.com'),
  ('a29a0000-a000-4000-8000-000000000009', 'h29-gone@example.com')
) u(id, em);
insert into public.orgs (id, name, created_by) values
  ('a29a0000-a000-4000-8000-0000000000a1', 'H29 Cleaning Co', 'a29a0000-a000-4000-8000-000000000001'),
  ('a29a0000-a000-4000-8000-0000000000b2', 'H29 B', 'a29a0000-a000-4000-8000-000000000005');
insert into public.org_pods (id, org_id, name) values ('a29a0000-a000-4000-8000-0000000000d1', 'a29a0000-a000-4000-8000-0000000000a1', 'P1');
insert into public.org_members (org_id, user_id, role, status, pod_id) values
  ('a29a0000-a000-4000-8000-0000000000a1', 'a29a0000-a000-4000-8000-000000000001', 'owner', 'active', null),
  ('a29a0000-a000-4000-8000-0000000000a1', 'a29a0000-a000-4000-8000-000000000002', 'agent', 'active', 'a29a0000-a000-4000-8000-0000000000d1'),
  ('a29a0000-a000-4000-8000-0000000000a1', 'a29a0000-a000-4000-8000-000000000003', 'agent', 'active', null),
  ('a29a0000-a000-4000-8000-0000000000a1', 'a29a0000-a000-4000-8000-000000000004', 'manager', 'active', null),
  ('a29a0000-a000-4000-8000-0000000000a1', 'a29a0000-a000-4000-8000-000000000006', 'admin', 'active', null),
  ('a29a0000-a000-4000-8000-0000000000a1', 'a29a0000-a000-4000-8000-000000000007', 'manager', 'active', null),
  ('a29a0000-a000-4000-8000-0000000000a1', 'a29a0000-a000-4000-8000-000000000009', 'agent', 'active', null),
  ('a29a0000-a000-4000-8000-0000000000b2', 'a29a0000-a000-4000-8000-000000000005', 'owner', 'active', null);
insert into public.org_manager_pods (org_id, manager_user_id, pod_id) values ('a29a0000-a000-4000-8000-0000000000a1', 'a29a0000-a000-4000-8000-000000000004', 'a29a0000-a000-4000-8000-0000000000d1');
insert into public.org_close_settings (org_id, service_categories) values ('a29a0000-a000-4000-8000-0000000000a1', array['Cleaning', 'Lawn']);
-- existing contacts: old = named, dnc = on the do-not-call flag
insert into public.contacts (id, user_id, org_id, business_name, owner_contact, phone_number, contact_status, dnc) values
  ('a29a0000-a000-4000-8000-0000000000c1', 'a29a0000-a000-4000-8000-000000000001', 'a29a0000-a000-4000-8000-0000000000a1', 'Old Co', 'Old Owner', '+13185550301', 'No Contact', false),
  ('a29a0000-a000-4000-8000-0000000000c2', 'a29a0000-a000-4000-8000-000000000001', 'a29a0000-a000-4000-8000-0000000000a1', 'DNC Co', 'D', '+13185550302', 'No Contact', true);

-- as a signed-in user (or anon when p_uid is null) / as the service role; returns '{row json}' of the first row or 'ERR <sqlstate>: <msg>'
create function pg_temp.run_as(p_uid text, p_sql text, p_role text default null) returns text language plpgsql as $$
declare res text;
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  execute 'set local role ' || coalesce(p_role, case when p_uid is null then 'anon' else 'authenticated' end);
  begin
    execute 'select coalesce(to_jsonb(r)::text, ''null'') from (' || p_sql || ') r limit 1' into res;
  exception when others then
    res := 'ERR ' || sqlstate || ': ' || sqlerrm;
  end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return res;
end $$;
-- a data-changing statement as a user: returns 'ok' or 'ERR <sqlstate>: <msg>' (DML cannot sit inside run_as's subselect)
create function pg_temp.dml_as(p_uid text, p_sql text) returns text language plpgsql as $$
declare res text := 'ok';
begin
  perform set_config('request.jwt.claims', case when p_uid is null then '' else json_build_object('sub', p_uid, 'role', 'authenticated')::text end, true);
  execute 'set local role ' || case when p_uid is null then 'anon' else 'authenticated' end;
  begin execute p_sql; exception when others then res := 'ERR ' || sqlstate || ': ' || sqlerrm; end;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
  return res;
end $$;
create function pg_temp.svc(p_sql text) returns text language sql as $$ select pg_temp.run_as(null, p_sql, 'service_role') $$;
create function pg_temp.tok(p_name text) returns text language sql as $$ select (select v from r_cap where r_cap.k = 'tok_' || p_name) $$;
-- a valid submission; mobile and business vary
create function pg_temp.sub(p_tok text, p_ip text, p_mobile text, p_biz text default 'Acme Cleaning') returns text language sql as $$
  select format($f$ select * from public.submit_pro_application(%L, %L, 'Ann Owner', %L, %L, null, array['Cleaning'], array['Monroe'], array['weekly'], true) $f$, p_tok, p_ip, p_biz, p_mobile) $$;
create function pg_temp.n_apps(p_mobile text) returns int language sql as $$ select count(*)::int from public.pro_applications where mobile = p_mobile $$;
create function pg_temp.app_id(p_mobile text) returns text language sql as $$ select id::text from public.pro_applications where mobile = p_mobile order by created_at desc limit 1 $$;
create function pg_temp.review(p_uid text, p_id text, p_action text) returns text language sql as $$
  select pg_temp.run_as(p_uid, format('select * from public.review_pro_application(%L::uuid, %L)', p_id, p_action)) $$;

-- ===== 1. links ======================================================================================================
insert into r_cap select 'tok_ag1', pg_temp.run_as('a29a0000-a000-4000-8000-000000000002', $q$ select token from public.get_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'token';
insert into r_cap select 'tok_ag1b', pg_temp.run_as('a29a0000-a000-4000-8000-000000000002', $q$ select token from public.get_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'token';
insert into t_res select 'agent gets a link: 64 url-safe hex chars, one live row credited to them', pg_temp.tok('ag1') ~ '^[0-9a-f]{64}$'
  and (select count(*) from public.pro_form_links where user_id = 'a29a0000-a000-4000-8000-000000000002' and revoked_at is null) = 1, pg_temp.tok('ag1');
insert into t_res select 'get_my_pro_form_link is get-or-create: the second call returns the same token', pg_temp.tok('ag1') = pg_temp.tok('ag1b'), null;
insert into r_cap select 'tok_o', pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', $q$ select token from public.get_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'token';
insert into r_cap select 'tok_ad', pg_temp.run_as('a29a0000-a000-4000-8000-000000000006', $q$ select token from public.get_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'token';
insert into r_cap select 'tok_mg', pg_temp.run_as('a29a0000-a000-4000-8000-000000000004', $q$ select token from public.get_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'token';
insert into r_cap select 'tok_ag2', pg_temp.run_as('a29a0000-a000-4000-8000-000000000003', $q$ select token from public.get_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'token';
insert into r_cap select 'tok_gone', pg_temp.run_as('a29a0000-a000-4000-8000-000000000009', $q$ select token from public.get_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'token';
insert into t_res select 'owner, admin, manager and agent can each get a link, all different', pg_temp.tok('o') ~ '^[0-9a-f]{64}$' and pg_temp.tok('ad') ~ '^[0-9a-f]{64}$' and pg_temp.tok('mg') ~ '^[0-9a-f]{64}$' and pg_temp.tok('ag2') ~ '^[0-9a-f]{64}$'
  and (select count(distinct v) from r_cap where k in ('tok_ag1', 'tok_o', 'tok_ad', 'tok_mg', 'tok_ag2')) = 5, null;
insert into t_res select 'non-member refused (42501)', pg_temp.run_as('a29a0000-a000-4000-8000-000000000008', $q$ select * from public.get_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$) like 'ERR 42501%', null;
insert into t_res select 'member of another org refused (42501), for get and rotate', pg_temp.run_as('a29a0000-a000-4000-8000-000000000005', $q$ select * from public.get_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$) like 'ERR 42501%'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000005', $q$ select * from public.rotate_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$) like 'ERR 42501%', null;
insert into t_res select 'no login (anon): refused', pg_temp.run_as(null, $q$ select * from public.get_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$) like 'ERR%', null;
insert into t_res select 'RLS: an agent reads only their own link row, owner/admin read the org''s, another agent''s token is invisible', pg_temp.run_as('a29a0000-a000-4000-8000-000000000002', 'select count(*) as n from public.pro_form_links')::jsonb ->> 'n' = '1'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000003', format('select count(*) as n from public.pro_form_links where token = %L', pg_temp.tok('ag1')))::jsonb ->> 'n' = '0'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000006', 'select count(*) as n from public.pro_form_links')::jsonb ->> 'n' = '6', null;
insert into t_res select 'no client writes on the link table', pg_temp.dml_as('a29a0000-a000-4000-8000-000000000002', $q$ update public.pro_form_links set revoked_at = now() $q$) like 'ERR 42501%'
  and pg_temp.dml_as('a29a0000-a000-4000-8000-000000000001', $q$ insert into public.pro_form_links (org_id, user_id, token) values ('a29a0000-a000-4000-8000-0000000000a1', 'a29a0000-a000-4000-8000-000000000001', repeat('a', 40)) $q$) like 'ERR 42501%'
  and pg_temp.run_as(null, 'select * from public.pro_form_links') like 'ERR 42501%', null;

-- ===== 2. public side is service-only ===============================================================================
insert into t_res select 'submit_pro_application is NOT callable by anon or authenticated', pg_temp.run_as(null, pg_temp.sub(pg_temp.tok('ag1'), 'ip-x', '+13185550401')) like 'ERR 42501%'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', pg_temp.sub(pg_temp.tok('ag1'), 'ip-x', '+13185550401')) like 'ERR 42501%', null;
insert into t_res select 'get_pro_form_info is NOT callable by anon or authenticated', pg_temp.run_as(null, format('select * from public.get_pro_form_info(%L)', pg_temp.tok('ag1'))) like 'ERR 42501%'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', format('select * from public.get_pro_form_info(%L)', pg_temp.tok('ag1'))) like 'ERR 42501%', null;
insert into t_res select 'control: the service role can call both', pg_temp.svc(format('select * from public.get_pro_form_info(%L)', pg_temp.tok('ag1'))) not like 'ERR%', null;
insert into t_res select 'GET info returns the org name and the service categories (and nothing else)', pg_temp.svc(format('select * from public.get_pro_form_info(%L)', pg_temp.tok('ag1')))::jsonb = '{"org_name": "H29 Cleaning Co", "service_categories": ["Cleaning", "Lawn"]}'::jsonb, pg_temp.svc(format('select * from public.get_pro_form_info(%L)', pg_temp.tok('ag1')));
insert into t_res select 'GET info for an unknown token: no rows', pg_temp.svc($q$ select count(*) as n from public.get_pro_form_info('nope') $q$)::jsonb ->> 'n' = '0', null;
insert into t_res select 'pro_form_attempts: no client access', pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', 'select * from public.pro_form_attempts') like 'ERR 42501%', null;

-- ===== 3. submit =====================================================================================================
insert into r_cap select 's1', pg_temp.svc(pg_temp.sub(pg_temp.tok('ag1'), 'ip-s1', '(318) 555-0401'));
insert into t_res select 'valid submit: status ok, no message', (select v from r_cap where k='s1')::jsonb = '{"status": "ok", "message": null}'::jsonb, (select v from r_cap where k='s1');
insert into t_res select 'valid submit: one pending row credited to the link owner, mobile normalised, ip hash stored as given, fields kept', exists (
  select 1 from public.pro_applications where mobile = '+13185550401' and status = 'pending' and referred_by = 'a29a0000-a000-4000-8000-000000000002' and org_id = 'a29a0000-a000-4000-8000-0000000000a1'
    and owner_name = 'Ann Owner' and business_name = 'Acme Cleaning' and services = array['Cleaning'] and cities = array['Monroe'] and frequencies = array['weekly'] and insured = true and ip_hash = 'ip-s1'), null;
-- invalid forms: each answers 'invalid' with a message and writes no row (distinct IPs so the rate limit is not what answers)
create temp table inv(label text, args text, msg text);
insert into inv values
  ('no owner name', $a$ '  ', 'Biz', '3185550402', null, array['Cleaning'], array['Monroe'], array['weekly'], true $a$, 'Owner name is required'),
  ('no business name', $a$ 'Ann', '', '3185550402', null, array['Cleaning'], array['Monroe'], array['weekly'], true $a$, 'Business name is required'),
  ('bad mobile', $a$ 'Ann', 'Biz', '12345', null, array['Cleaning'], array['Monroe'], array['weekly'], true $a$, 'Mobile number is not valid'),
  ('no mobile', $a$ 'Ann', 'Biz', null, null, array['Cleaning'], array['Monroe'], array['weekly'], true $a$, 'Mobile number is not valid'),
  ('no service', $a$ 'Ann', 'Biz', '3185550402', null, '{}'::text[], array['Monroe'], array['weekly'], true $a$, 'Pick at least one service'),
  ('no city', $a$ 'Ann', 'Biz', '3185550402', null, array['Cleaning'], array[' '], array['weekly'], true $a$, 'Add at least one city'),
  ('no frequency', $a$ 'Ann', 'Biz', '3185550402', null, array['Cleaning'], array['Monroe'], null, true $a$, 'Pick at least one frequency'),
  ('bad frequency', $a$ 'Ann', 'Biz', '3185550402', null, array['Cleaning'], array['Monroe'], array['daily'], true $a$, 'Frequency must be weekly, biweekly or monthly'),
  ('insured not answered', $a$ 'Ann', 'Biz', '3185550402', null, array['Cleaning'], array['Monroe'], array['weekly'], null $a$, 'Say whether you are insured'),
  ('bad email', $a$ 'Ann', 'Biz', '3185550402', 'nope', array['Cleaning'], array['Monroe'], array['weekly'], true $a$, 'Email is not valid'),
  ('too many services', $a$ 'Ann', 'Biz', '3185550402', null, (select array_agg('s' || g) from generate_series(1, 11) g), array['Monroe'], array['weekly'], true $a$, 'Too many or too long services or cities');
insert into r_cap select 'inv_' || i.label, pg_temp.svc(format('select * from public.submit_pro_application(%L, %L, %s)', pg_temp.tok('ag2'), 'ip-inv-' || i.label, i.args)) from inv i;
insert into t_res select 'invalid form: ' || i.label || ' -> status invalid with the readable message', (select v from r_cap where k = 'inv_' || i.label)::jsonb = jsonb_build_object('status', 'invalid', 'message', i.msg), (select v from r_cap where k = 'inv_' || i.label) from inv i;
insert into t_res select 'none of the invalid forms wrote an application', pg_temp.n_apps('+13185550402') = 0, null;
-- optional bits are optional and validated
insert into r_cap select 's2', pg_temp.svc(format($f$ select * from public.submit_pro_application(%L, 'ip-s2', 'Ann', 'Opt Co', '318-555-0403', 'a@b.co', array['Cleaning','Lawn'], array['Monroe','Ruston'], array['weekly','monthly'], false, 'mornings', 90, 4, 6) $f$, pg_temp.tok('ag1')));
insert into t_res select 'all optional fields sent: stored (insured false kept)', (select v from r_cap where k='s2') like '%"ok"%' and exists (select 1 from public.pro_applications where mobile = '+13185550403' and email = 'a@b.co' and insured = false and best_contact = 'mornings' and starting_price = 90 and capacity = 4 and years_in_business = 6 and cardinality(services) = 2), (select v from r_cap where k='s2');
insert into t_res select 'out-of-range price / capacity / years answer invalid', pg_temp.svc(format($f$ select * from public.submit_pro_application(%L, 'ip-r1', 'Ann', 'Biz', '3185550404', null, array['x'], array['y'], array['weekly'], true, null, -5) $f$, pg_temp.tok('ag2'))) like '%invalid%'
  and pg_temp.svc(format($f$ select * from public.submit_pro_application(%L, 'ip-r2', 'Ann', 'Biz', '3185550404', null, array['x'], array['y'], array['weekly'], true, null, null, 20000) $f$, pg_temp.tok('ag2'))) like '%invalid%'
  and pg_temp.svc(format($f$ select * from public.submit_pro_application(%L, 'ip-r3', 'Ann', 'Biz', '3185550404', null, array['x'], array['y'], array['weekly'], true, null, null, null, 200) $f$, pg_temp.tok('ag2'))) like '%invalid%', null;

-- bad / revoked / orphaned tokens
insert into t_res select 'unknown token: not_found, nothing written', pg_temp.svc(pg_temp.sub('deadbeef', 'ip-nf', '+13185550405')) like '%not_found%' and pg_temp.n_apps('+13185550405') = 0, null;
insert into r_cap select 'tok_old', pg_temp.tok('ag2');
insert into r_cap select 'tok_ag2new', pg_temp.run_as('a29a0000-a000-4000-8000-000000000003', $q$ select token from public.rotate_my_pro_form_link('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'token';
insert into t_res select 'rotate: a new token, the old one is revoked and exactly one stays live', pg_temp.tok('ag2new') ~ '^[0-9a-f]{64}$' and pg_temp.tok('ag2new') <> pg_temp.tok('old')
  and (select revoked_at is not null from public.pro_form_links where token = pg_temp.tok('old'))
  and (select count(*) from public.pro_form_links where user_id = 'a29a0000-a000-4000-8000-000000000003' and revoked_at is null) = 1, null;
insert into t_res select 'revoked token: GET gives no rows and POST gives not_found, nothing written', pg_temp.svc(format('select count(*) as n from public.get_pro_form_info(%L)', pg_temp.tok('old')))::jsonb ->> 'n' = '0'
  and pg_temp.svc(pg_temp.sub(pg_temp.tok('old'), 'ip-rv', '+13185550406')) like '%not_found%' and pg_temp.n_apps('+13185550406') = 0, null;
insert into t_res select 'control: the new token works', pg_temp.svc(pg_temp.sub(pg_temp.tok('ag2new'), 'ip-rv2', '+13185550406')) like '%"ok"%', null;
update public.org_members set status = 'inactive' where user_id = 'a29a0000-a000-4000-8000-000000000009';
insert into t_res select 'a link whose owner is no longer an active member is dead (GET empty, POST not_found)', pg_temp.svc(format('select count(*) as n from public.get_pro_form_info(%L)', pg_temp.tok('gone')))::jsonb ->> 'n' = '0'
  and pg_temp.svc(pg_temp.sub(pg_temp.tok('gone'), 'ip-gone', '+13185550407')) like '%not_found%', null;

-- the response never reveals whether the number / business exists
insert into r_cap select 'x_new', pg_temp.svc(pg_temp.sub(pg_temp.tok('o'), 'ip-x1', '+13185550410', 'Totally New'));
insert into r_cap select 'x_contact', pg_temp.svc(pg_temp.sub(pg_temp.tok('o'), 'ip-x2', '+13185550301', 'Old Co'));
insert into t_res select 'submitting an existing contact''s number or business name answers exactly like a fresh one', (select v from r_cap where k='x_new') = (select v from r_cap where k='x_contact') and (select v from r_cap where k='x_new') = '{"status": "ok", "message": null}', (select v from r_cap where k='x_contact');

-- pending rule: only the SAME visitor (org + mobile + link + ip hash) replaces; anyone else adds another pending row
insert into r_cap select 'rp1', pg_temp.svc(pg_temp.sub(pg_temp.tok('ag1'), 'ip-rp1', '+13185550420', 'First Name Co'));
insert into r_cap select 'rp2', pg_temp.svc(pg_temp.sub(pg_temp.tok('o'), 'ip-rp2', '(318) 555-0420', 'Stranger Co'));
insert into t_res select 'stranger (other link AND other ip) with the same mobile: same 200, a SECOND pending row, the original untouched', (select v from r_cap where k='rp2') = '{"status": "ok", "message": null}'
  and pg_temp.n_apps('+13185550420') = 2
  and exists (select 1 from public.pro_applications where mobile = '+13185550420' and business_name = 'First Name Co' and referred_by = 'a29a0000-a000-4000-8000-000000000002' and status = 'pending')
  and exists (select 1 from public.pro_applications where mobile = '+13185550420' and business_name = 'Stranger Co' and referred_by = 'a29a0000-a000-4000-8000-000000000001'), null;
insert into r_cap select 'rp3', pg_temp.svc(pg_temp.sub(pg_temp.tok('ag1'), 'ip-rp3', '+13185550420', 'Other Ip Co'));
insert into t_res select 'same link but a different ip: also a new row (all four must match to replace)', pg_temp.n_apps('+13185550420') = 3 and exists (select 1 from public.pro_applications where mobile = '+13185550420' and business_name = 'First Name Co'), null;
insert into r_cap select 'rp4', pg_temp.svc(pg_temp.sub(pg_temp.tok('o'), 'ip-rp1', '+13185550420', 'Same Ip Other Link Co'));
insert into t_res select 'same ip but a different link: also a new row', pg_temp.n_apps('+13185550420') = 4 and exists (select 1 from public.pro_applications where mobile = '+13185550420' and business_name = 'First Name Co'), null;
insert into r_cap select 'rp5', pg_temp.svc(pg_temp.sub(pg_temp.tok('ag1'), 'ip-rp1', '(318) 555-0420', 'Corrected Co'));
insert into t_res select 'POSITIVE CONTROL: the same visitor (same link + ip + number) corrects its own pending row: still 4 rows, original now corrected, credit kept', pg_temp.n_apps('+13185550420') = 4
  and exists (select 1 from public.pro_applications where mobile = '+13185550420' and business_name = 'Corrected Co' and referred_by = 'a29a0000-a000-4000-8000-000000000002' and status = 'pending')
  and not exists (select 1 from public.pro_applications where mobile = '+13185550420' and business_name = 'First Name Co'), null;
insert into t_res select 'a second submit from the same visitor for a DIFFERENT number is a different row, never a replace', pg_temp.svc(pg_temp.sub(pg_temp.tok('ag1'), 'ip-rp1', '+13185550421', 'Other Number Co')) like '%"ok"%' and pg_temp.n_apps('+13185550421') = 1 and pg_temp.n_apps('+13185550420') = 4, null;
insert into t_res select 'submit takes the per-link and per-ip advisory locks before counting (both exact keys held in this transaction)',
  (select count(*) from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objid::bigint = (hashtext('proformlinkrate:' || (select id::text from public.pro_form_links where token = pg_temp.tok('ag1')))::bigint & 4294967295)) >= 1
  and (select count(*) from pg_locks l where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objid::bigint = (hashtext('proformiprate:ip-rp1')::bigint & 4294967295)) >= 1, null;

-- rate limits
create temp table rl(k text);
insert into r_cap select 'ip' || g, pg_temp.svc(pg_temp.sub(pg_temp.tok('ad'), 'ip-limit', '+1318555053' || lpad(g::text, 1, '0') || '0')) from generate_series(1, 6) g;
insert into t_res select 'rate limit per IP: attempts 1-5 from one hashed IP are accepted', (select count(*) from r_cap where k in ('ip1','ip2','ip3','ip4','ip5') and v like '%"ok"%') = 5, null;
insert into t_res select 'rate limit per IP: the 6th in the hour is rate_limited and writes nothing', (select v from r_cap where k='ip6') like '%rate_limited%' and pg_temp.n_apps('+131855505360') = 0, (select v from r_cap where k='ip6');
insert into t_res select 'control: a different IP is still accepted (the limit is per IP)', pg_temp.svc(pg_temp.sub(pg_temp.tok('ad'), 'ip-other', '+13185550370')) like '%"ok"%', null;
-- per link: 30 attempts from 30 different IPs on mg's link (invalid forms count as attempts too), the 31st is refused
insert into r_cap select 'lk' || g, pg_temp.svc(format('select * from public.submit_pro_application(%L, %L, '''', '''', ''x'', null, null, null, null, null)', pg_temp.tok('mg'), 'ip-link-' || g)) from generate_series(1, 31) g;
insert into t_res select 'rate limit per link: 30 attempts per hour are processed', (select count(*) from r_cap where k ~ '^lk' and v like '%invalid%') = 30, null;
insert into t_res select 'rate limit per link: the 31st attempt on the link is rate_limited', (select v from r_cap where k = 'lk31') like '%rate_limited%', (select v from r_cap where k = 'lk31');
insert into t_res select 'control: another link, new IP, is not affected by that link''s limit', pg_temp.svc(pg_temp.sub(pg_temp.tok('o'), 'ip-link-ctl', '+13185550380')) like '%"ok"%', null;
insert into t_res select 'attempts are stored hashed as given (no raw IP column exists)', not exists (select 1 from information_schema.columns where table_name in ('pro_form_attempts', 'pro_applications') and column_name in ('ip', 'ip_address', 'raw_ip')), null;

-- ===== 4. review =====================================================================================================
-- fixtures: a1 pending from ag1 (new contact), a2 pending for the EXISTING contact c1, a3 for the DNC contact c2, a4 from the (deactivated) 'gone' link owner via a fresh row
-- the existing-contact submission above left a pending row for c1's number: drop it so the fixture below can use that number
delete from public.pro_applications where mobile = '+13185550301';
insert into public.pro_applications (id, org_id, link_id, referred_by, owner_name, business_name, mobile, services, cities, frequencies, insured, status) values
  ('a29a6000-a000-4000-8000-000000000001', 'a29a0000-a000-4000-8000-0000000000a1', (select id from public.pro_form_links where token = pg_temp.tok('ag1')), 'a29a0000-a000-4000-8000-000000000002', 'New Owner', 'New Biz', '+13185550501', array['Cleaning'], array['Ruston', 'Monroe'], array['weekly'], true, 'pending'),
  ('a29a6000-a000-4000-8000-000000000002', 'a29a0000-a000-4000-8000-0000000000a1', (select id from public.pro_form_links where token = pg_temp.tok('ag1')), 'a29a0000-a000-4000-8000-000000000002', 'Pro Owner', 'Pro Biz', '+13185550301', array['Lawn'], array['Monroe'], array['monthly'], false, 'pending'),
  ('a29a6000-a000-4000-8000-000000000003', 'a29a0000-a000-4000-8000-0000000000a1', null, 'a29a0000-a000-4000-8000-000000000002', 'Dnc Owner', 'Dnc Biz', '+13185550302', array['Lawn'], array['Monroe'], array['weekly'], true, 'pending'),
  ('a29a6000-a000-4000-8000-000000000004', 'a29a0000-a000-4000-8000-0000000000a1', null, 'a29a0000-a000-4000-8000-000000000009', 'Gone Ref', 'Gone Biz', '+13185550504', array['Lawn'], array['Monroe'], array['weekly'], true, 'pending'),
  ('a29a6000-a000-4000-8000-000000000005', 'a29a0000-a000-4000-8000-0000000000a1', null, 'a29a0000-a000-4000-8000-000000000002', 'Rej Owner', 'Rej Biz', '+13185550505', array['Lawn'], array['Monroe'], array['weekly'], true, 'pending'),
  ('a29a6000-a000-4000-8000-000000000006', 'a29a0000-a000-4000-8000-0000000000b2', null, null, 'B Owner', 'B Biz', '+13185550506', array['Lawn'], array['Monroe'], array['weekly'], true, 'pending'),
  ('a29a6000-a000-4000-8000-000000000007', 'a29a0000-a000-4000-8000-0000000000a1', null, null, 'Orphan', 'Orphan Biz', '+13185550507', array['Lawn'], array['Monroe'], array['weekly'], true, 'pending');

insert into t_res select 'agent, manager, other-org owner and non-member cannot approve or reject (42501), nothing changes',
  pg_temp.review('a29a0000-a000-4000-8000-000000000002', 'a29a6000-a000-4000-8000-000000000001', 'approve') like 'ERR 42501%'
  and pg_temp.review('a29a0000-a000-4000-8000-000000000004', 'a29a6000-a000-4000-8000-000000000001', 'approve') like 'ERR 42501%'
  and pg_temp.review('a29a0000-a000-4000-8000-000000000005', 'a29a6000-a000-4000-8000-000000000001', 'reject') like 'ERR 42501%'
  and pg_temp.review('a29a0000-a000-4000-8000-000000000008', 'a29a6000-a000-4000-8000-000000000001', 'approve') like 'ERR 42501%'
  and pg_temp.review(null, 'a29a6000-a000-4000-8000-000000000001', 'approve') like 'ERR%'
  and (select status from public.pro_applications where id = 'a29a6000-a000-4000-8000-000000000001') = 'pending' and not exists (select 1 from public.contact_closes where mobile = '+13185550501'), null;
insert into t_res select 'an unknown application id looks the same as a forbidden one (42501)', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-0000000000ff', 'approve') like 'ERR 42501%', null;
insert into t_res select 'owner of ORG A cannot review an ORG B application', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-000000000006', 'approve') like 'ERR 42501%', null;
insert into t_res select 'a bad action is refused (22023)', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-000000000001', 'delete') like 'ERR 22023%', null;

-- approve a new contact (as ADMIN: the contacts trigger and the close insert must pass for them)
insert into r_cap select 'ap1', pg_temp.review('a29a0000-a000-4000-8000-000000000006', 'a29a6000-a000-4000-8000-000000000001', 'approve');
insert into t_res select 'approve (new contact, by admin): approved, close id + contact id returned, contact_created true', (select v from r_cap where k='ap1')::jsonb ->> 'status' = 'approved' and (select v from r_cap where k='ap1')::jsonb ->> 'contact_created' = 'true' and (select v from r_cap where k='ap1')::jsonb ->> 'close_id' is not null, (select v from r_cap where k='ap1');
insert into t_res select 'approve (new contact): contact has the number, the form''s names, import_list ''Pro form'', created by the approver, status Closed',
  exists (select 1 from public.contacts where org_id = 'a29a0000-a000-4000-8000-0000000000a1' and phone_number = '+13185550501' and business_name = 'New Biz' and owner_contact = 'New Owner' and import_list = 'Pro form' and user_id = 'a29a0000-a000-4000-8000-000000000006' and contact_status = 'Closed' and city = 'Ruston'), null;
insert into t_res select 'approve: one close credited to the REFERRER (still active), with the application''s fields, delivery not_configured',
  (select count(*) from public.contact_closes where mobile = '+13185550501') = 1 and exists (select 1 from public.contact_closes where mobile = '+13185550501' and closed_by = 'a29a0000-a000-4000-8000-000000000002' and owner_name = 'New Owner' and business_name = 'New Biz' and services = array['Cleaning'] and cities = array['Ruston', 'Monroe'] and insured = true and delivery_status = 'not_configured'), null;
insert into t_res select 'approve: application is approved with reviewer, time, close and contact ids', exists (select 1 from public.pro_applications a where a.id = 'a29a6000-a000-4000-8000-000000000001' and a.status = 'approved' and a.reviewed_by = 'a29a0000-a000-4000-8000-000000000006' and a.reviewed_at is not null and a.close_id is not null and a.contact_id is not null), null;
-- idempotent
insert into t_res select 'double approve: refused cleanly (22023 already reviewed), still exactly one close and one contact', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-000000000001', 'approve') like 'ERR 22023: This application was already reviewed'
  and (select count(*) from public.contact_closes where mobile = '+13185550501') = 1 and (select count(*) from public.contacts where phone_number = '+13185550501') = 1, null;
insert into t_res select 'approved then reject is refused too (22023), status stays approved', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-000000000001', 'reject') like 'ERR 22023%' and (select status from public.pro_applications where id = 'a29a6000-a000-4000-8000-000000000001') = 'approved', null;
-- existing contact
insert into r_cap select 'ap2', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-000000000002', 'approve');
insert into t_res select 'approve for an EXISTING contact: no duplicate, contact_created false, fields NOT overwritten, status Closed', (select v from r_cap where k='ap2')::jsonb ->> 'contact_created' = 'false'
  and (select count(*) from public.contacts where phone_number = '+13185550301') = 1
  and exists (select 1 from public.contacts where id = 'a29a0000-a000-4000-8000-0000000000c1' and business_name = 'Old Co' and owner_contact = 'Old Owner' and contact_status = 'Closed' and import_list is distinct from 'Pro form')
  and exists (select 1 from public.contact_closes where contact_id = 'a29a0000-a000-4000-8000-0000000000c1' and business_name = 'Pro Biz'), (select v from r_cap where k='ap2');
-- DNC
insert into r_cap select 'ap3', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-000000000003', 'approve');
insert into t_res select 'approve for a DNC contact: the contact stays DNC', (select v from r_cap where k='ap3') not like 'ERR%' and (select dnc from public.contacts where id = 'a29a0000-a000-4000-8000-0000000000c2') = true, (select v from r_cap where k='ap3');
-- disabled referrer
insert into r_cap select 'ap4', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-000000000004', 'approve');
insert into t_res select 'closed_by credit: a referrer who is no longer an active member -> the approver', (select v from r_cap where k='ap4') not like 'ERR%' and exists (select 1 from public.contact_closes where mobile = '+13185550504' and closed_by = 'a29a0000-a000-4000-8000-000000000001'), (select v from r_cap where k='ap4');
insert into r_cap select 'ap7', pg_temp.review('a29a0000-a000-4000-8000-000000000006', 'a29a6000-a000-4000-8000-000000000007', 'approve');
insert into t_res select 'closed_by credit: no referrer at all -> the approver', (select v from r_cap where k='ap7') not like 'ERR%' and exists (select 1 from public.contact_closes where mobile = '+13185550507' and closed_by = 'a29a0000-a000-4000-8000-000000000006'), (select v from r_cap where k='ap7');
-- reject
insert into r_cap select 'rj5', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-000000000005', 'reject');
insert into t_res select 'reject: status rejected with reviewer, NO close, NO contact created', (select v from r_cap where k='rj5')::jsonb ->> 'status' = 'rejected' and exists (select 1 from public.pro_applications where id = 'a29a6000-a000-4000-8000-000000000005' and status = 'rejected' and reviewed_by = 'a29a0000-a000-4000-8000-000000000001' and close_id is null and contact_id is null)
  and not exists (select 1 from public.contact_closes where mobile = '+13185550505') and not exists (select 1 from public.contacts where phone_number = '+13185550505'), (select v from r_cap where k='rj5');
insert into t_res select 'rejected then approve is refused (22023): a rejected application never becomes a close', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-000000000005', 'approve') like 'ERR 22023%' and not exists (select 1 from public.contact_closes where mobile = '+13185550505'), null;
-- webhook on -> pending + GHL close tag
insert into public.org_close_webhook (org_id, url, secret, enabled) values ('a29a0000-a000-4000-8000-0000000000a1', 'https://example.com/hook', 's', true);
insert into public.org_integrations (org_id, provider, status) values ('a29a0000-a000-4000-8000-0000000000a1', 'ghl', 'connected');
insert into public.pro_applications (id, org_id, referred_by, owner_name, business_name, mobile, services, cities, frequencies, insured, status)
  values ('a29a6000-a000-4000-8000-000000000008', 'a29a0000-a000-4000-8000-0000000000a1', 'a29a0000-a000-4000-8000-000000000002', 'Hook', 'Hook Biz', '+13185550508', array['Lawn'], array['Monroe'], array['weekly'], true, 'pending');
insert into r_cap select 'ap8', pg_temp.review('a29a0000-a000-4000-8000-000000000001', 'a29a6000-a000-4000-8000-000000000008', 'approve');
insert into t_res select 'webhook on: the close is delivery pending with a next attempt, and the GHL close tag job is queued', (select v from r_cap where k='ap8') not like 'ERR%' and exists (select 1 from public.contact_closes where mobile = '+13185550508' and delivery_status = 'pending' and next_attempt_at is not null)
  and exists (select 1 from public.crm_sync_jobs j join public.contacts c on c.id = j.contact_id where c.phone_number = '+13185550508' and j.kind = 'close_tag'), (select v from r_cap where k='ap8');
-- other-org approve left no trace
insert into t_res select 'the org B application stayed pending and untouched', (select status from public.pro_applications where id = 'a29a6000-a000-4000-8000-000000000006') = 'pending', null;
-- Onboarded pros shows approved only
do $$ begin
  if to_regprocedure('public.list_onboarded_pros(uuid,integer)') is not null then
    insert into r_cap select 'pros', pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', $q$ select string_agg(mobile, ',' order by mobile) as m, count(*) as n from public.list_onboarded_pros('a29a0000-a000-4000-8000-0000000000a1') $q$);
  else
    insert into r_cap values ('pros', '{"m": "skipped", "n": 0}');
  end if;
end $$;
insert into t_res select 'list_onboarded_pros shows the approved applications and none of the pending or rejected ones', (select v from r_cap where k='pros') = '{"m": "+13185550301,+13185550302,+13185550501,+13185550504,+13185550507,+13185550508", "n": 6}' or (select v from r_cap where k='pros') like '%skipped%', (select v from r_cap where k='pros');

-- ===== 5. list =======================================================================================================
insert into r_cap select 'l_o', pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', $q$ select count(*) as n, max(pending_count) as pending, max(total_count) as total from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') $q$);
insert into t_res select 'list as owner: sees every org-A application (never org B), pending_count matches the pending rows', (select v from r_cap where k='l_o')::jsonb ->> 'n' = (select count(*)::text from public.pro_applications where org_id = 'a29a0000-a000-4000-8000-0000000000a1')
  and (select v from r_cap where k='l_o')::jsonb ->> 'pending' = (select count(*)::text from public.pro_applications where org_id = 'a29a0000-a000-4000-8000-0000000000a1' and status = 'pending'), (select v from r_cap where k='l_o');
insert into t_res select 'list filters by status, and a bad status is refused (22023)', pg_temp.run_as('a29a0000-a000-4000-8000-000000000006', $q$ select count(*) as n from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1', 'rejected') $q$)::jsonb ->> 'n' = '1'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000006', $q$ select * from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1', 'bogus') $q$) like 'ERR 22023%', null;
insert into t_res select 'list: agent, other-org owner, non-member and anon are refused', pg_temp.run_as('a29a0000-a000-4000-8000-000000000002', $q$ select * from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') $q$) like 'ERR 42501%'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000005', $q$ select * from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') $q$) like 'ERR 42501%'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000008', $q$ select * from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') $q$) like 'ERR 42501%'
  and pg_temp.run_as(null, $q$ select * from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') $q$) like 'ERR%', null;
insert into t_res select 'list rows carry the referrer id and never the ip hash', pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', $q$ select * from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1', 'approved') $q$) like '%referred_by%'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', $q$ select * from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1', 'approved') $q$) not like '%ip_hash%', null;
-- manager scope: mg manages pod p1 (ag1 only)
insert into t_res select 'manager (pod p1): sees ONLY applications referred by agents of their pods', pg_temp.run_as('a29a0000-a000-4000-8000-000000000004', $q$ select count(*) as n from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') where referred_by <> 'a29a0000-a000-4000-8000-000000000002' $q$)::jsonb ->> 'n' = '0'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000004', $q$ select count(*) as n from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'n' = (select count(*)::text from public.pro_applications where org_id = 'a29a0000-a000-4000-8000-0000000000a1' and referred_by = 'a29a0000-a000-4000-8000-000000000002'), null;
insert into t_res select 'manager: pending_count is also scoped to their pods', pg_temp.run_as('a29a0000-a000-4000-8000-000000000004', $q$ select max(pending_count) as p from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'p' = (select count(*)::text from public.pro_applications where org_id = 'a29a0000-a000-4000-8000-0000000000a1' and referred_by = 'a29a0000-a000-4000-8000-000000000002' and status = 'pending'), null;
insert into t_res select 'manager with no pods sees nothing; a manager cannot review', pg_temp.run_as('a29a0000-a000-4000-8000-000000000007', $q$ select count(*) as n from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'n' = '0'
  and pg_temp.review('a29a0000-a000-4000-8000-000000000004', 'a29a6000-a000-4000-8000-000000000001', 'approve') like 'ERR 42501%', null;
-- duplicates + existing contact flags on list_pro_applications
insert into r_cap select 'dup_o', pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', $q$ select count(*) filter (where same_number_pending) as dup, count(*) as n from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') where mobile = '+13185550420' $q$);
insert into t_res select 'list (owner): all four pending rows for the shared number say same_number_pending; a unique number does not', (select v from r_cap where k='dup_o')::jsonb ->> 'dup' = '4'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', $q$ select same_number_pending as d from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') where mobile = '+13185550421' $q$)::jsonb ->> 'd' = 'false', (select v from r_cap where k='dup_o');
insert into t_res select 'list (owner): existing_contact is true for a number that is an org contact (and contact_dnc true only for the DNC one), false for a new number', pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', $q$ select existing_contact as e, contact_dnc as d from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') where mobile = '+13185550301' $q$)::jsonb = '{"e": true, "d": false}'::jsonb
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', $q$ select existing_contact as e, contact_dnc as d from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') where mobile = '+13185550302' $q$)::jsonb = '{"e": true, "d": true}'::jsonb
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', $q$ select existing_contact as e, contact_dnc as d from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') where mobile = '+13185550421' $q$)::jsonb = '{"e": false, "d": false}'::jsonb, null;
insert into t_res select 'list (admin) gets the contact flags too', pg_temp.run_as('a29a0000-a000-4000-8000-000000000006', $q$ select existing_contact as e from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') where mobile = '+13185550301' $q$)::jsonb ->> 'e' = 'true', null;
insert into t_res select 'list (manager): existing_contact and contact_dnc are NULL on every row (even for a number that is a contact), same_number_pending still works', pg_temp.run_as('a29a0000-a000-4000-8000-000000000004', $q$ select count(*) filter (where existing_contact is not null or contact_dnc is not null) as leaked, count(*) as n from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') $q$)::jsonb ->> 'leaked' = '0'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000004', $q$ select count(*) as n from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') where mobile = '+13185550301' $q$)::jsonb ->> 'n' <> '0'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000004', $q$ select count(*) filter (where same_number_pending) as dup from public.list_pro_applications('a29a0000-a000-4000-8000-0000000000a1') where mobile = '+13185550420' $q$)::jsonb ->> 'dup' = '2', null;
insert into t_res select 'approve keeps a DNC contact DNC (the flag is a column approve never writes)', (select dnc from public.contacts where id = 'a29a0000-a000-4000-8000-0000000000c2') is true, null;

-- table RLS direct
insert into t_res select 'table RLS: agent sees no application rows, manager only pod rows, owner all of the org, anon denied', pg_temp.run_as('a29a0000-a000-4000-8000-000000000002', 'select count(*) as n from public.pro_applications')::jsonb ->> 'n' = '0'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000004', 'select count(*) as n from public.pro_applications where referred_by is distinct from ''a29a0000-a000-4000-8000-000000000002''')::jsonb ->> 'n' = '0'
  and pg_temp.run_as('a29a0000-a000-4000-8000-000000000001', 'select count(*) as n from public.pro_applications')::jsonb ->> 'n' = (select count(*)::text from public.pro_applications where org_id = 'a29a0000-a000-4000-8000-0000000000a1')
  and pg_temp.run_as(null, 'select * from public.pro_applications') like 'ERR 42501%', null;
insert into t_res select 'no client writes on applications (insert/update/delete denied for agent AND owner)', pg_temp.dml_as('a29a0000-a000-4000-8000-000000000001', $q$ update public.pro_applications set status = 'approved' $q$) like 'ERR 42501%'
  and pg_temp.dml_as('a29a0000-a000-4000-8000-000000000001', $q$ delete from public.pro_applications $q$) like 'ERR 42501%'
  and pg_temp.dml_as('a29a0000-a000-4000-8000-000000000002', $q$ insert into public.pro_applications (org_id, owner_name, business_name, mobile, services, cities, frequencies, insured) values ('a29a0000-a000-4000-8000-0000000000a1', 'a', 'b', '+13185550999', '{x}', '{y}', '{weekly}', true) $q$) like 'ERR 42501%', null;
-- schema facts
insert into t_res select 'RLS is enabled on all three new tables; pending-mobile index is a plain (non-unique) partial index and the unique one is gone', (select count(*) from pg_class where relname in ('pro_form_links', 'pro_applications', 'pro_form_attempts') and relrowsecurity) = 3
  and exists (select 1 from pg_indexes where indexname = 'pro_applications_pending_mobile_idx' and indexdef like '%WHERE%pending%' and indexdef not like '%UNIQUE%')
  and not exists (select 1 from pg_indexes where indexname = 'pro_applications_one_pending_per_mobile'), null;

select jsonb_build_object('failed', coalesce((select jsonb_agg(label) from t_res where ok is not true), '[]'::jsonb), 'n', (select count(*) from t_res)) as result;
rollback;

-- TASK-H26 tests: public.is_number_dnc. One batch, ROLLED BACK. Needs migration *_h26_is_number_dnc.sql (without it every
-- check fails: positive control). Result: {failed:[labels], n}.
begin;
create temp table t_res(label text, ok boolean, detail text) on commit drop;
grant all on t_res to public;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $fx$ begin return new; end; $fx$;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.em, crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false
from (values
  ('a26a0000-a000-4000-8000-000000000001', 'h26-o@example.com'),
  ('a26a0000-a000-4000-8000-000000000002', 'h26-ag@example.com'),
  ('a26a0000-a000-4000-8000-000000000003', 'h26-x@example.com'),
  ('a26a0000-a000-4000-8000-000000000004', 'h26-off@example.com')
) u(id, em);

insert into public.orgs (id, name, created_by) values
  ('a26a0000-a000-4000-8000-0000000000a1', 'H26 A', 'a26a0000-a000-4000-8000-000000000001'),
  ('a26a0000-a000-4000-8000-0000000000b2', 'H26 B', 'a26a0000-a000-4000-8000-000000000003');
insert into public.org_members (org_id, user_id, role, status) values
  ('a26a0000-a000-4000-8000-0000000000a1', 'a26a0000-a000-4000-8000-000000000001', 'owner', 'active'),
  ('a26a0000-a000-4000-8000-0000000000a1', 'a26a0000-a000-4000-8000-000000000002', 'agent', 'active'),
  ('a26a0000-a000-4000-8000-0000000000a1', 'a26a0000-a000-4000-8000-000000000004', 'agent', 'disabled'),
  ('a26a0000-a000-4000-8000-0000000000b2', 'a26a0000-a000-4000-8000-000000000003', 'owner', 'active')
on conflict (org_id, user_id) do update set role = excluded.role, status = excluded.status;

-- +13185550301 on the org list only; +13185550302 a contact flagged dnc (agent has no campaign access: RLS would hide it);
-- +13185550303 a clean contact; +13185550304 dnc only in org B; +13185550305 a contact with dnc = false
insert into public.dnc_numbers (org_id, e164, source) values
  ('a26a0000-a000-4000-8000-0000000000a1', '+13185550301', 'manual'),
  ('a26a0000-a000-4000-8000-0000000000b2', '+13185550304', 'manual');
insert into public.contacts (id, user_id, org_id, business_name, phone_number, dnc) values
  ('a26a0000-a000-4000-8000-0000000000d2', 'a26a0000-a000-4000-8000-000000000001', 'a26a0000-a000-4000-8000-0000000000a1', 'Flagged Co', '+13185550302', true),
  ('a26a0000-a000-4000-8000-0000000000d3', 'a26a0000-a000-4000-8000-000000000001', 'a26a0000-a000-4000-8000-0000000000a1', 'Clean Co', '+13185550303', false),
  ('a26a0000-a000-4000-8000-0000000000d5', 'a26a0000-a000-4000-8000-000000000001', 'a26a0000-a000-4000-8000-0000000000a1', 'Not Flagged', '+13185550305', false);

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
create function pg_temp.q(p_org text, p_num text) returns text language sql as $$
  select format('select public.is_number_dnc(%L::uuid, %L) as dnc', p_org, p_num) $$;

insert into t_res select 'agent: number on the org dnc_numbers list -> true', pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+13185550301')) = '{"dnc": true}', null;
insert into t_res select 'agent: contact flagged dnc that the agent cannot read -> true (the gap this closes)', pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+13185550302')) = '{"dnc": true}', null;
insert into t_res select 'agent: control: a clean contact and an unknown number -> false', pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+13185550303')) = '{"dnc": false}' and pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+13185559999')) = '{"dnc": false}' and pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+13185550305')) = '{"dnc": false}', null;
insert into t_res select 'formatted input is normalized: (318) 555-0301, 13185550302, +1 318 555 0302', pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '(318) 555-0301')) = '{"dnc": true}' and pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '13185550302')) = '{"dnc": true}' and pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+1 318 555 0302')) = '{"dnc": true}', null;
insert into t_res select 'org scoped: a number on org B''s list is NOT dnc for org A', pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+13185550304')) = '{"dnc": false}' and pg_temp.run_as('a26a0000-a000-4000-8000-000000000003', pg_temp.q('a26a0000-a000-4000-8000-0000000000b2', '+13185550304')) = '{"dnc": true}', null;
insert into t_res select 'owner also gets true', pg_temp.run_as('a26a0000-a000-4000-8000-000000000001', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+13185550302')) = '{"dnc": true}', null;
insert into t_res select 'non-member (org B owner asking about org A) is refused 42501', pg_temp.run_as('a26a0000-a000-4000-8000-000000000003', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+13185550301')) like 'ERR 42501%', null;
insert into t_res select 'disabled member is refused 42501', pg_temp.run_as('a26a0000-a000-4000-8000-000000000004', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+13185550301')) like 'ERR 42501%', null;
insert into t_res select 'null org refused 42501; invalid number 22023 (fail closed, not false)', pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', 'select public.is_number_dnc(null, ''+13185550301'')') like 'ERR 42501%' and pg_temp.run_as('a26a0000-a000-4000-8000-000000000002', pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '12345')) like 'ERR 22023%', null;
insert into t_res select 'no JWT cannot call it; anon has no execute grant', pg_temp.run_as(null, pg_temp.q('a26a0000-a000-4000-8000-0000000000a1', '+13185550301')) like 'ERR%' and not has_function_privilege('anon', 'public.is_number_dnc(uuid,text)', 'execute'), null;

select jsonb_build_object('failed', coalesce((select jsonb_agg(label) from t_res where ok is not true), '[]'::jsonb), 'n', (select count(*) from t_res)) as result;
rollback;

-- TASK-H28 tests: Log close with nothing required (log_contact_close + log_contact_close_by_phone + contact_closes).
-- One batch, ROLLED BACK. Needs *_h28_close_fields_optional.sql applied on top of the H24 migrations (on a database without
-- it the empty-form checks fail: positive control). Result: one row {failed:[labels], n:count}.
begin;
create temp table t_res(label text, ok boolean, detail text) on commit drop;
create temp table r_cap(k text, v text) on commit drop;
grant all on r_cap to public;
grant all on t_res to public;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $fx$ begin return new; end; $fx$;

-- users: o owner, ag agent WITH campaign access to c1/c2/c3, ag2 agent with none, x owner of org B only
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.em, crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false
from (values
  ('a28a0000-a000-4000-8000-000000000001', 'h28-o@example.com'),
  ('a28a0000-a000-4000-8000-000000000002', 'h28-ag@example.com'),
  ('a28a0000-a000-4000-8000-000000000003', 'h28-ag2@example.com'),
  ('a28a0000-a000-4000-8000-000000000005', 'h28-x@example.com')
) u(id, em);

insert into public.orgs (id, name, created_by) values
  ('a28a0000-a000-4000-8000-0000000000a1', 'H28 A', 'a28a0000-a000-4000-8000-000000000001'),
  ('a28a0000-a000-4000-8000-0000000000b2', 'H28 B', 'a28a0000-a000-4000-8000-000000000005');
insert into public.org_members (org_id, user_id, role, status) values
  ('a28a0000-a000-4000-8000-0000000000a1', 'a28a0000-a000-4000-8000-000000000001', 'owner', 'active'),
  ('a28a0000-a000-4000-8000-0000000000a1', 'a28a0000-a000-4000-8000-000000000002', 'agent', 'active'),
  ('a28a0000-a000-4000-8000-0000000000a1', 'a28a0000-a000-4000-8000-000000000003', 'agent', 'active'),
  ('a28a0000-a000-4000-8000-0000000000b2', 'a28a0000-a000-4000-8000-000000000005', 'owner', 'active')
on conflict (org_id, user_id) do update set role = excluded.role, status = 'active';

-- c1 named (Bloom Clean), c2 no name, c3 no name AND no phone, c4 a teammate's lead the agent cannot read, c5/c6/c7/c8 spare named
insert into public.contacts (id, user_id, org_id, business_name, owner_contact, phone_number, contact_status) values
  ('a28a0000-a000-4000-8000-0000000000c1', 'a28a0000-a000-4000-8000-000000000001', 'a28a0000-a000-4000-8000-0000000000a1', 'Bloom Clean', null, '+13185550201', 'No Contact'),
  ('a28a0000-a000-4000-8000-0000000000c2', 'a28a0000-a000-4000-8000-000000000001', 'a28a0000-a000-4000-8000-0000000000a1', null, null, '+13185550202', 'No Contact'),
  ('a28a0000-a000-4000-8000-0000000000c3', 'a28a0000-a000-4000-8000-000000000001', 'a28a0000-a000-4000-8000-0000000000a1', null, null, null, 'No Contact'),
  ('a28a0000-a000-4000-8000-0000000000c4', 'a28a0000-a000-4000-8000-000000000001', 'a28a0000-a000-4000-8000-0000000000a1', 'Teammate Lead', 'T', '+13185550204', 'No Contact'),
  ('a28a0000-a000-4000-8000-0000000000c5', 'a28a0000-a000-4000-8000-000000000001', 'a28a0000-a000-4000-8000-0000000000a1', 'Five Co', null, '+13185550205', 'No Contact'),
  ('a28a0000-a000-4000-8000-0000000000c6', 'a28a0000-a000-4000-8000-000000000001', 'a28a0000-a000-4000-8000-0000000000a1', 'Six Co', null, '+13185550206', 'No Contact'),
  ('a28a0000-a000-4000-8000-0000000000c7', 'a28a0000-a000-4000-8000-000000000001', 'a28a0000-a000-4000-8000-0000000000a1', 'Seven Co', null, '+13185550207', 'No Contact'),
  ('a28a0000-a000-4000-8000-0000000000c8', 'a28a0000-a000-4000-8000-000000000001', 'a28a0000-a000-4000-8000-0000000000a1', 'Eight Co', null, '+13185550208', 'No Contact');
insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('a28a2000-a000-4000-8000-00000000000a', 'a28a0000-a000-4000-8000-0000000000a1', 'a28a0000-a000-4000-8000-000000000001', 'H28 Campaign', '00:00', '23:59', 3, 45);
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts)
select ('a28a5000-a000-4000-8000-0000000000' || lpad(n::text, 2, '0'))::uuid, 'a28a2000-a000-4000-8000-00000000000a', ('a28a0000-a000-4000-8000-0000000000c' || n)::uuid, 'a28a0000-a000-4000-8000-0000000000a1', 'queued', 0
from generate_series(1, 3) n;
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts)
select ('a28a5000-a000-4000-8000-0000000000' || lpad((n + 4)::text, 2, '0'))::uuid, 'a28a2000-a000-4000-8000-00000000000a', ('a28a0000-a000-4000-8000-0000000000c' || n)::uuid, 'a28a0000-a000-4000-8000-0000000000a1', 'queued', 0
from generate_series(5, 8) n;
insert into public.campaign_agents (campaign_id, user_id, org_id)
  values ('a28a2000-a000-4000-8000-00000000000a', 'a28a0000-a000-4000-8000-000000000002', 'a28a0000-a000-4000-8000-0000000000a1');
-- (the one agent is on the campaign, so it reads every contact that has a lead on it, c4 included: c4 gets its lead in ANOTHER campaign below)
delete from public.campaign_leads where contact_id = 'a28a0000-a000-4000-8000-0000000000c4';

-- run one statement as a signed-in user; returns '{row json}' of its first row, or 'ERR <sqlstate>: <msg>'.
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

-- p_rest = the 9 form arguments from owner name to insured as SQL text (owner, business, mobile, email, services, cities, frequencies, insured)
create function pg_temp.byid(p_contact text, p_rest text) returns text language sql as $$
  select format('select * from public.log_contact_close(%L::uuid, %s)', p_contact, p_rest) $$;
create function pg_temp.byphone(p_phone text, p_rest text) returns text language sql as $$
  select format('select * from public.log_contact_close_by_phone(%L::uuid, %L, %s)', 'a28a0000-a000-4000-8000-0000000000a1', p_phone, p_rest) $$;
create function pg_temp.n_closes(p_contact text) returns int language sql as $$
  select count(*)::int from public.contact_closes where contact_id = p_contact::uuid $$;

-- the empty form: everything blank / absent
create function pg_temp.empty() returns text language sql as $$ select $e$ null, null, null, null, '{}'::text[], '{}'::text[], '{}'::text[], null $e$ $$;

-- 1. empty form by contact (Henry's case): named contact -> business falls back, mobile = contact phone, everything else null/empty
insert into r_cap select 'e1', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c1', pg_temp.empty()));
insert into t_res select 'empty form by contact: accepted, deduped false, a close id returned', (select v from r_cap where k='e1') not like 'ERR%' and ((select v from r_cap where k='e1')::jsonb ->> 'close_id') is not null and ((select v from r_cap where k='e1')::jsonb ->> 'deduped') = 'false', (select v from r_cap where k='e1');
insert into t_res select 'empty form by contact: row has NULL owner/insured/email, business = contact''s, mobile = contact phone, empty lists, contact Closed',
  exists (select 1 from public.contact_closes where contact_id = 'a28a0000-a000-4000-8000-0000000000c1' and closed_by = 'a28a0000-a000-4000-8000-000000000002' and owner_name is null and insured is null and email is null and best_contact is null
    and business_name = 'Bloom Clean' and mobile = '+13185550201' and services = '{}' and cities = '{}' and frequencies = '{}')
  and (select contact_status from public.contacts where id = 'a28a0000-a000-4000-8000-0000000000c1') = 'Closed', null;

-- 2. blank strings and whitespace become NULL, never ''
insert into r_cap select 'e2', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c5', $a$ '   ', '', '  ', ' ', array['  ', ''], array[''], array[' '], null $a$));
insert into t_res select 'blank / whitespace strings and lists: accepted and stored as NULL / empty, never ''''', (select v from r_cap where k='e2') not like 'ERR%'
  and exists (select 1 from public.contact_closes where contact_id = 'a28a0000-a000-4000-8000-0000000000c5' and owner_name is null and email is null and services = '{}' and cities = '{}' and frequencies = '{}' and business_name = 'Five Co'), (select v from r_cap where k='e2');
insert into t_res select 'no empty-string text anywhere in the new close rows', not exists (select 1 from public.contact_closes where owner_name = '' or business_name = '' or mobile = '' or email = '' or best_contact = ''), null;

-- 3. contact with no name and no phone: allowed, business and mobile NULL
insert into r_cap select 'e3', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c3', pg_temp.empty()));
insert into t_res select 'contact with no name and no phone, empty form: accepted, business and mobile NULL', (select v from r_cap where k='e3') not like 'ERR%'
  and exists (select 1 from public.contact_closes where contact_id = 'a28a0000-a000-4000-8000-0000000000c3' and business_name is null and mobile is null), (select v from r_cap where k='e3');
insert into r_cap select 'e3b', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c2', pg_temp.empty()));
insert into t_res select 'unnamed contact WITH a phone, empty form: business NULL, mobile = its phone', (select v from r_cap where k='e3b') not like 'ERR%'
  and exists (select 1 from public.contact_closes where contact_id = 'a28a0000-a000-4000-8000-0000000000c2' and business_name is null and mobile = '+13185550202'), (select v from r_cap where k='e3b');

-- 4. by phone, number not a contact yet, empty form: contact created from the dialed number alone
insert into r_cap select 'e4', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byphone('(318) 555-0299', pg_temp.empty()));
insert into t_res select 'by phone, new number, empty form: accepted, contact_created true, contact_id returned', (select v from r_cap where k='e4') not like 'ERR%' and ((select v from r_cap where k='e4')::jsonb ->> 'contact_created') = 'true' and ((select v from r_cap where k='e4')::jsonb ->> 'contact_id') is not null, (select v from r_cap where k='e4');
insert into t_res select 'by phone, new number: contact has the dialed number, NULL business/owner, import_list ''Manual close'', status Closed',
  exists (select 1 from public.contacts where org_id = 'a28a0000-a000-4000-8000-0000000000a1' and phone_number = '+13185550299' and business_name is null and owner_contact is null and import_list = 'Manual close' and contact_status = 'Closed' and user_id = 'a28a0000-a000-4000-8000-000000000002'), null;
insert into t_res select 'by phone, new number: the close row has NULL owner/business/insured, mobile = the dialed number, empty lists',
  exists (select 1 from public.contact_closes cc join public.contacts c on c.id = cc.contact_id where c.phone_number = '+13185550299' and cc.owner_name is null and cc.business_name is null and cc.insured is null and cc.mobile = '+13185550299' and cc.services = '{}' and cc.cities = '{}' and cc.frequencies = '{}' and cc.closed_by = 'a28a0000-a000-4000-8000-000000000002'), null;
-- existing contact by phone with campaign access, empty form
insert into r_cap select 'e4b', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byphone('+13185550206', pg_temp.empty()));
insert into t_res select 'by phone, existing readable contact, empty form: accepted, not created, business falls back to the contact''s', (select v from r_cap where k='e4b') not like 'ERR%' and ((select v from r_cap where k='e4b')::jsonb ->> 'contact_created') = 'false'
  and exists (select 1 from public.contact_closes where contact_id = 'a28a0000-a000-4000-8000-0000000000c6' and business_name = 'Six Co' and mobile = '+13185550206'), (select v from r_cap where k='e4b');
-- a name only (the form half filled): the contact is created with it
insert into r_cap select 'e4c', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byphone('+13185550298', $a$ null, 'Half Co', null, null, '{}'::text[], '{}'::text[], '{}'::text[], null $a$));
insert into t_res select 'by phone, only a business name entered: created contact and close carry it', (select v from r_cap where k='e4c') not like 'ERR%'
  and exists (select 1 from public.contacts where phone_number = '+13185550298' and business_name = 'Half Co') and exists (select 1 from public.contact_closes where business_name = 'Half Co' and owner_name is null), (select v from r_cap where k='e4c');

-- 5. invalid values that ARE entered are still refused (and by phone, no contact is left behind)
insert into t_res select 'invalid email refused 22023 (by contact)', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c7', $a$ null, null, null, 'not-an-email', '{}'::text[], '{}'::text[], '{}'::text[], null $a$)) like 'ERR 22023: email is not valid', null;
insert into t_res select 'invalid mobile ("123") refused 22023', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c7', $a$ null, null, '123', null, '{}'::text[], '{}'::text[], '{}'::text[], null $a$)) like 'ERR 22023: mobile number is not valid', null;
insert into t_res select 'mobile typed as "not sure" (no digits) is refused, not silently blanked', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c7', $a$ null, null, 'not sure', null, '{}'::text[], '{}'::text[], '{}'::text[], null $a$)) like 'ERR 22023: mobile number is not valid', null;
insert into t_res select 'frequency outside weekly/biweekly/monthly refused', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c7', $a$ null, null, null, null, '{}'::text[], '{}'::text[], array['daily'], null $a$)) like 'ERR 22023%frequency%', null;
insert into t_res select 'more than 10 services refused', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c7', $a$ null, null, null, null, (select array_agg('s' || g) from generate_series(1, 11) g), '{}'::text[], '{}'::text[], null $a$)) like 'ERR 22023%too many%', null;
insert into t_res select 'out of range price / capacity / years refused', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', 'select * from public.log_contact_close(''a28a0000-a000-4000-8000-0000000000c7'', null, null, null, null, ''{}'', ''{}'', ''{}'', null, null, -1)') like 'ERR 22023%price%'
  and pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', 'select * from public.log_contact_close(''a28a0000-a000-4000-8000-0000000000c7'', null, null, null, null, ''{}'', ''{}'', ''{}'', null, null, null, 20000)') like 'ERR 22023%capacity%'
  and pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', 'select * from public.log_contact_close(''a28a0000-a000-4000-8000-0000000000c7'', null, null, null, null, ''{}'', ''{}'', ''{}'', null, null, null, null, 200)') like 'ERR 22023%years%', null;
insert into t_res select 'too-long owner name refused', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c7', format($a$ %L, null, null, null, '{}'::text[], '{}'::text[], '{}'::text[], null $a$, repeat('x', 121)))) like 'ERR 22023: name is too long', null;
insert into t_res select 'none of those refused calls wrote a close or changed the contact', pg_temp.n_closes('a28a0000-a000-4000-8000-0000000000c7') = 0 and (select contact_status from public.contacts where id = 'a28a0000-a000-4000-8000-0000000000c7') = 'No Contact', null;
insert into t_res select 'by phone: invalid email refused and NO contact is created for that number', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byphone('+13185550297', $a$ null, null, null, 'bad', '{}'::text[], '{}'::text[], '{}'::text[], null $a$)) like 'ERR 22023%'
  and not exists (select 1 from public.contacts where phone_number = '+13185550297'), null;
insert into t_res select 'by phone: an invalid dialed number is still refused', pg_temp.run_as('a28a0000-a000-4000-8000-000000000002', pg_temp.byphone('12', pg_temp.empty())) like 'ERR 22023: phone number is not valid', null;

-- 6. access rules unchanged
insert into t_res select 'agent without access (ag2) closing by contact id: refused 42501 even with an empty form, no close', pg_temp.run_as('a28a0000-a000-4000-8000-000000000003', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c1', pg_temp.empty())) like 'ERR 42501%no access%', null;
insert into t_res select 'agent without access to a teammate''s contact by phone, no inbound call: refused 42501 (readable message), no close, status unchanged', pg_temp.run_as('a28a0000-a000-4000-8000-000000000003', pg_temp.byphone('+13185550204', pg_temp.empty())) like 'ERR 42501: This number belongs to a contact you don''t have access to%'
  and pg_temp.n_closes('a28a0000-a000-4000-8000-0000000000c4') = 0 and (select contact_status from public.contacts where id = 'a28a0000-a000-4000-8000-0000000000c4') = 'No Contact', null;
insert into t_res select 'member of another org refused (42501) with an empty form', pg_temp.run_as('a28a0000-a000-4000-8000-000000000005', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c1', pg_temp.empty())) like 'ERR 42501%', null;
insert into t_res select 'no JWT: refused (not authenticated)', pg_temp.run_as(null, pg_temp.byid('a28a0000-a000-4000-8000-0000000000c1', pg_temp.empty())) like 'ERR%', null;
insert into t_res select 'unknown contact id: P0002', pg_temp.run_as('a28a0000-a000-4000-8000-000000000001', pg_temp.byid('a28a0000-a000-4000-8000-0000000000ff', pg_temp.empty())) like 'ERR P0002%', null;

-- 6b. MUST (lead): an inbound-proof caller (no read access) with an empty form must not get the contact's name copied into a row they can read
insert into public.inbound_calls (org_id, call_control_id, from_e164, created_at) values ('a28a0000-a000-4000-8000-0000000000a1', 'h28-cc-4', '+13185550204', now() - interval '1 hour');
insert into r_cap select 'p1', pg_temp.run_as('a28a0000-a000-4000-8000-000000000003', pg_temp.byphone('+13185550204', pg_temp.empty()));
insert into t_res select 'inbound-proof caller, empty form: allowed, contact_id hidden', (select v from r_cap where k='p1') not like 'ERR%' and ((select v from r_cap where k='p1')::jsonb -> 'contact_id') = 'null'::jsonb, (select v from r_cap where k='p1');
insert into t_res select 'inbound-proof caller, empty form: their close row has NO business name (the contact''s stays hidden), mobile = the dialed number',
  exists (select 1 from public.contact_closes where contact_id = 'a28a0000-a000-4000-8000-0000000000c4' and closed_by = 'a28a0000-a000-4000-8000-000000000003' and business_name is null and mobile = '+13185550204'), null;
insert into t_res select 'inbound-proof caller reading contact_closes as themselves sees no "Teammate Lead"', pg_temp.run_as('a28a0000-a000-4000-8000-000000000003', $q$ select count(*) as n from public.contact_closes where business_name = 'Teammate Lead' $q$)::jsonb ->> 'n' = '0', null;
-- control: a caller WITH read access and the same empty form does get the fallback (e4b above, Six Co); and the owner on c4
insert into r_cap select 'p2', pg_temp.run_as('a28a0000-a000-4000-8000-000000000001', pg_temp.byphone('+13185550204', pg_temp.empty()));
insert into t_res select 'control: owner (read access) with an empty form on that same contact gets the contact''s name as fallback', (select v from r_cap where k='p2') not like 'ERR%'
  and exists (select 1 from public.contact_closes where contact_id = 'a28a0000-a000-4000-8000-0000000000c4' and closed_by = 'a28a0000-a000-4000-8000-000000000001' and business_name = 'Teammate Lead'), null;

-- 7. 60 s dedupe still works with an empty form
insert into r_cap select 'd1', pg_temp.run_as('a28a0000-a000-4000-8000-000000000001', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c8', pg_temp.empty()));
insert into r_cap select 'd2', pg_temp.run_as('a28a0000-a000-4000-8000-000000000001', pg_temp.byid('a28a0000-a000-4000-8000-0000000000c8', pg_temp.empty()));
insert into t_res select 'same caller, same contact, 2nd empty submit inside 60 s: deduped true, same close id, one row', ((select v from r_cap where k='d2')::jsonb ->> 'deduped') = 'true' and ((select v from r_cap where k='d1')::jsonb ->> 'close_id') = ((select v from r_cap where k='d2')::jsonb ->> 'close_id') and pg_temp.n_closes('a28a0000-a000-4000-8000-0000000000c8') = 1, (select v from r_cap where k='d1') || ' / ' || (select v from r_cap where k='d2');

-- 8. a full form still stores every value (positive control for the "values are kept" side)
insert into r_cap select 'f1', pg_temp.run_as('a28a0000-a000-4000-8000-000000000001', $q$ select * from public.log_contact_close('a28a0000-a000-4000-8000-0000000000c7', 'Nora', 'Nora Cleaning', '(318) 555-0777', 'nora@example.com', array['Cleaning'], array['Monroe'], array['weekly','monthly'], false, 'mornings', 85.5, 3, 7) $q$);
insert into t_res select 'full form: every entered value is stored (insured false is kept, not nulled)', (select v from r_cap where k='f1') not like 'ERR%'
  and exists (select 1 from public.contact_closes where contact_id = 'a28a0000-a000-4000-8000-0000000000c7' and owner_name = 'Nora' and business_name = 'Nora Cleaning' and mobile = '+13185550777' and email = 'nora@example.com' and services = array['Cleaning'] and cities = array['Monroe'] and frequencies = array['monthly','weekly'] and insured = false and best_contact = 'mornings' and starting_price = 85.5 and capacity = 3 and years_in_business = 7), (select v from r_cap where k='f1');
insert into t_res select 'an entered mobile wins over the contact phone fallback', exists (select 1 from public.contact_closes where contact_id = 'a28a0000-a000-4000-8000-0000000000c7' and mobile = '+13185550777'), null;

-- 9. the table: columns nullable, lists have only upper bounds, the other checks stay
insert into t_res select 'contact_closes: owner_name, business_name, mobile, insured nullable; services/cities/frequencies still NOT NULL',
  (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'contact_closes' and column_name in ('owner_name','business_name','mobile','insured') and is_nullable = 'YES') = 4
  and (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'contact_closes' and column_name in ('services','cities','frequencies') and is_nullable = 'NO') = 3, null;
insert into t_res select 'contact_closes: no check still demands >= 1 service/city/frequency; the upper bounds are there',
  not exists (select 1 from pg_constraint where conrelid = 'public.contact_closes'::regclass and contype = 'c' and pg_get_constraintdef(oid) ~ 'cardinality\((services|cities|frequencies)\) >= 1|BETWEEN 1 AND')
  and exists (select 1 from pg_constraint where conrelid = 'public.contact_closes'::regclass and conname = 'contact_closes_frequencies_valid'), null;
insert into t_res select 'contact_closes: a direct insert of an empty-string owner is still refused by the table check (the RPC turns blanks into NULL)', (select count(*) from pg_constraint where conrelid = 'public.contact_closes'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%owner_name%') >= 1, null;

-- 10. list_onboarded_pros needs no change: rows with NULLs come through (only when that function exists in this database)
do $$ begin
  if to_regprocedure('public.list_onboarded_pros(uuid,integer)') is not null then
    insert into r_cap select 'l1', pg_temp.run_as('a28a0000-a000-4000-8000-000000000001', $q$ select count(*)::int as n, count(*) filter (where owner_name is null and insured is null and business_name is null) as nullrows from public.list_onboarded_pros('a28a0000-a000-4000-8000-0000000000a1') $q$);
  else
    insert into r_cap values ('l1', '{"n": 1, "nullrows": 1, "skipped": true}');
  end if;
end $$;
insert into t_res select 'list_onboarded_pros returns the NULL-field closes without error (or is absent in this database)', (select v from r_cap where k='l1') not like 'ERR%' and ((select v from r_cap where k='l1')::jsonb ->> 'n')::int >= 1 and ((select v from r_cap where k='l1')::jsonb ->> 'nullrows')::int >= 1, (select v from r_cap where k='l1');

select jsonb_build_object('failed', coalesce((select jsonb_agg(label) from t_res where ok is not true), '[]'::jsonb), 'n', (select count(*) from t_res)) as result;
rollback;

-- TASK-H24 tests: log_contact_close_by_phone + the refactored log_contact_close. One batch, ROLLED BACK. Needs migration
-- *_h24_log_close_by_phone.sql applied (on a database without it, every by_phone check fails: positive control).
-- Result: one row {failed:[labels], n:count}.
begin;
create temp table t_res(label text, ok boolean, detail text) on commit drop;
create temp table r_cap(k text, v text) on commit drop;
grant all on r_cap to public;
grant all on t_res to public;

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = '' as $fx$ begin return new; end; $fx$;

-- users: o owner, ag agent (no campaign access to anything), ag2 other agent, mg manager, x member of org B only, nm no membership
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous)
select '00000000-0000-0000-0000-000000000000', u.id::uuid, 'authenticated', 'authenticated', u.em, crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false
from (values
  ('a24a0000-a000-4000-8000-000000000001', 'h24-o@example.com'),
  ('a24a0000-a000-4000-8000-000000000002', 'h24-ag@example.com'),
  ('a24a0000-a000-4000-8000-000000000003', 'h24-ag2@example.com'),
  ('a24a0000-a000-4000-8000-000000000004', 'h24-mg@example.com'),
  ('a24a0000-a000-4000-8000-000000000005', 'h24-x@example.com'),
  ('a24a0000-a000-4000-8000-000000000006', 'h24-nm@example.com'),
  ('a24a0000-a000-4000-8000-000000000007', 'h24-ad@example.com'),
  ('a24a0000-a000-4000-8000-000000000008', 'h24-agc@example.com')
) u(id, em);

insert into public.orgs (id, name, created_by) values
  ('a24a0000-a000-4000-8000-0000000000a1', 'H24 A', 'a24a0000-a000-4000-8000-000000000001'),
  ('a24a0000-a000-4000-8000-0000000000b2', 'H24 B', 'a24a0000-a000-4000-8000-000000000005');
insert into public.org_members (org_id, user_id, role, status) values
  ('a24a0000-a000-4000-8000-0000000000a1', 'a24a0000-a000-4000-8000-000000000001', 'owner', 'active'),
  ('a24a0000-a000-4000-8000-0000000000a1', 'a24a0000-a000-4000-8000-000000000002', 'agent', 'active'),
  ('a24a0000-a000-4000-8000-0000000000a1', 'a24a0000-a000-4000-8000-000000000003', 'agent', 'active'),
  ('a24a0000-a000-4000-8000-0000000000a1', 'a24a0000-a000-4000-8000-000000000004', 'manager', 'active'),
  ('a24a0000-a000-4000-8000-0000000000a1', 'a24a0000-a000-4000-8000-000000000007', 'admin', 'active'),
  ('a24a0000-a000-4000-8000-0000000000a1', 'a24a0000-a000-4000-8000-000000000008', 'agent', 'active'),
  ('a24a0000-a000-4000-8000-0000000000b2', 'a24a0000-a000-4000-8000-000000000005', 'owner', 'active')
on conflict (org_id, user_id) do update set role = excluded.role, status = 'active';

-- known contacts: kA in org A (no name, as ff4b46a0), kB in org B with the SAME number as kA's twin, kN a named contact
insert into public.contacts (id, user_id, org_id, business_name, owner_contact, phone_number, contact_status) values
  ('a24a0000-a000-4000-8000-0000000000c1', 'a24a0000-a000-4000-8000-000000000001', 'a24a0000-a000-4000-8000-0000000000a1', null, null, '+13187800951', 'No Contact'),
  ('a24a0000-a000-4000-8000-0000000000c2', 'a24a0000-a000-4000-8000-000000000005', 'a24a0000-a000-4000-8000-0000000000b2', 'B Co', 'B Owner', '+13185550102', 'No Contact'),
  ('a24a0000-a000-4000-8000-0000000000c3', 'a24a0000-a000-4000-8000-000000000001', 'a24a0000-a000-4000-8000-0000000000a1', 'Named Co', 'Nora Named', '+13185550103', 'No Contact'),
  -- teammates' leads the agent has no access to and never spoke to: c4 no inbound call, c5 inbound 8 days ago, c6 inbound only in org B, c7 for admin
  ('a24a0000-a000-4000-8000-0000000000c4', 'a24a0000-a000-4000-8000-000000000001', 'a24a0000-a000-4000-8000-0000000000a1', 'Teammate Lead 4', 'T4', '+13185550104', 'No Contact'),
  ('a24a0000-a000-4000-8000-0000000000c5', 'a24a0000-a000-4000-8000-000000000001', 'a24a0000-a000-4000-8000-0000000000a1', 'Teammate Lead 5', 'T5', '+13185550105', 'No Contact'),
  ('a24a0000-a000-4000-8000-0000000000c6', 'a24a0000-a000-4000-8000-000000000001', 'a24a0000-a000-4000-8000-0000000000a1', 'Teammate Lead 6', 'T6', '+13185550106', 'No Contact'),
  ('a24a0000-a000-4000-8000-0000000000c8', 'a24a0000-a000-4000-8000-000000000001', 'a24a0000-a000-4000-8000-0000000000a1', 'Teammate Lead 8', 'T8', '+13185550108', 'No Contact');
-- agent u8 WITH campaign access: campaign + lead (contact c9) + campaign_agents row
insert into public.contacts (id, user_id, org_id, business_name, owner_contact, phone_number, contact_status) values
  ('a24a0000-a000-4000-8000-0000000000c9', 'a24a0000-a000-4000-8000-000000000001', 'a24a0000-a000-4000-8000-0000000000a1', 'Assigned Lead 9', 'T9', '+13185550109', 'No Contact');
insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('a24a2000-a000-4000-8000-00000000000a', 'a24a0000-a000-4000-8000-0000000000a1', 'a24a0000-a000-4000-8000-000000000001', 'H24 Campaign', '00:00', '23:59', 3, 45);
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts)
  values ('a24a5000-a000-4000-8000-00000000000a', 'a24a2000-a000-4000-8000-00000000000a', 'a24a0000-a000-4000-8000-0000000000c9', 'a24a0000-a000-4000-8000-0000000000a1', 'pending', 0);
insert into public.campaign_agents (campaign_id, user_id, org_id)
  values ('a24a2000-a000-4000-8000-00000000000a', 'a24a0000-a000-4000-8000-000000000008', 'a24a0000-a000-4000-8000-0000000000a1');
-- inbound calls: c1's number called in 1 hour ago (org A); c5's number 8 days ago; c6's number only in org B
insert into public.inbound_calls (org_id, call_control_id, from_e164, created_at) values
  ('a24a0000-a000-4000-8000-0000000000a1', 'h24-cc-1', '+13187800951', now() - interval '1 hour'),
  ('a24a0000-a000-4000-8000-0000000000a1', 'h24-cc-5', '+13185550105', now() - interval '8 days'),
  ('a24a0000-a000-4000-8000-0000000000b2', 'h24-cc-6', '+13185550106', now() - interval '1 hour');

-- run one statement as a signed-in user; returns '{row json}' of its first row, or 'ERR <sqlstate>: <msg>'. p_uid null = no JWT at all.
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

-- the close form payload; $1 = phone, $2 = owner, $3 = business, $4 = services array literal
create function pg_temp.byphone(p_org text, p_phone text, p_owner text, p_biz text, p_services text default $s$array['Cleaning']$s$) returns text language sql as $$
  select format($f$ select * from public.log_contact_close_by_phone(%L::uuid, %L, %L, %L, %L, null, %s, array['Monroe'], array['weekly'], true) $f$,
    p_org, p_phone, p_owner, p_biz, '3187800951', p_services) $$;

create function pg_temp.n_contacts(p_org text, p_phone text) returns int language sql as $$
  select count(*)::int from public.contacts where org_id = p_org::uuid and phone_number = p_phone $$;
create function pg_temp.n_closes(p_org text) returns int language sql as $$
  select count(*)::int from public.contact_closes where org_id = p_org::uuid $$;


-- 1. existing contact the agent cannot read: allowed ONLY with an inbound call from that number to this org in the last 7 days
insert into r_cap select 'r1', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '(318) 780-0951', 'Hank', 'Hank Cleaning'));
insert into t_res select 'unreadable contact + inbound call 1 h ago: close allowed, contact_id hidden (null), no new contact', ((select v from r_cap where k='r1')::jsonb ->> 'contact_created') = 'false' and ((select v from r_cap where k='r1')::jsonb -> 'contact_id') = 'null'::jsonb and ((select v from r_cap where k='r1')::jsonb ->> 'close_id') is not null and pg_temp.n_contacts('a24a0000-a000-4000-8000-0000000000a1', '+13187800951') = 1, (select v from r_cap where k='r1');
insert into t_res select 'unreadable contact + inbound: contact Closed, own fields untouched (still no name), close row by the agent with the form values', (select contact_status = 'Closed' and business_name is null and owner_contact is null from public.contacts where id = 'a24a0000-a000-4000-8000-0000000000c1')
  and exists (select 1 from public.contact_closes where contact_id = 'a24a0000-a000-4000-8000-0000000000c1' and closed_by = 'a24a0000-a000-4000-8000-000000000002'::uuid and business_name = 'Hank Cleaning' and owner_name = 'Hank'), null;

-- 1b. MUST (lead review): no proof -> refused with the readable message, no close row, status unchanged
insert into r_cap select 'r1b', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550104', 'N', 'Biz'));
insert into t_res select 'unreadable contact, NO inbound row: refused 42501 with the readable message', (select v from r_cap where k='r1b') like 'ERR 42501: This number belongs to a contact you don''t have access to. Ask your manager to log the close.', (select v from r_cap where k='r1b');
insert into t_res select 'unreadable contact, NO inbound row: no close row, status unchanged, no contact_id leaked', not exists (select 1 from public.contact_closes where contact_id = 'a24a0000-a000-4000-8000-0000000000c4') and (select contact_status from public.contacts where id = 'a24a0000-a000-4000-8000-0000000000c4') = 'No Contact' and (select v from r_cap where k='r1b') not like '%c4%', null;
insert into t_res select 'inbound call 8 days ago (older than 7 days): refused 42501, nothing written', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550105', 'N', 'Biz')) like 'ERR 42501%' and not exists (select 1 from public.contact_closes where contact_id = 'a24a0000-a000-4000-8000-0000000000c5') and (select contact_status from public.contacts where id = 'a24a0000-a000-4000-8000-0000000000c5') = 'No Contact', null;
insert into t_res select 'inbound call only in ANOTHER org: refused 42501, nothing written', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550106', 'N', 'Biz')) like 'ERR 42501%' and not exists (select 1 from public.contact_closes where contact_id = 'a24a0000-a000-4000-8000-0000000000c6'), null;
insert into t_res select 'a different agent with the same unreadable number and no inbound of their own proof is judged per number+org (inbound row exists for c1 -> also allowed)', pg_temp.run_as('a24a0000-a000-4000-8000-000000000003', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13187800951', 'Other', 'Other Biz')) not like 'ERR%', null;
insert into t_res select 'owner and admin always pass for an existing contact (no inbound needed), contact_id returned', (pg_temp.run_as('a24a0000-a000-4000-8000-000000000001', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550104', 'T4', 'Lead 4 Biz')))::jsonb ->> 'contact_id' = 'a24a0000-a000-4000-8000-0000000000c4'
  and (pg_temp.run_as('a24a0000-a000-4000-8000-000000000007', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550108', 'T8', 'Lead 8 Biz')))::jsonb ->> 'contact_id' = 'a24a0000-a000-4000-8000-0000000000c8', null;
insert into t_res select 'manager without access and without inbound is refused too (read access is owner/admin or assigned agent)', pg_temp.run_as('a24a0000-a000-4000-8000-000000000004', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550105', 'N', 'Biz')) like 'ERR 42501%', null;

-- 1c. agent WITH campaign access to the lead: allowed with no inbound call, contact_id returned (contact_read_access true branch)
insert into r_cap select 'r1c', pg_temp.run_as('a24a0000-a000-4000-8000-000000000008', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550109', 'T9', 'Lead 9 Biz'));
insert into t_res select 'agent WITH campaign access: by phone passes with no inbound call, contact_id returned, contact Closed', (select v from r_cap where k='r1c') not like 'ERR%' and ((select v from r_cap where k='r1c')::jsonb ->> 'contact_id') = 'a24a0000-a000-4000-8000-0000000000c9' and ((select v from r_cap where k='r1c')::jsonb ->> 'contact_created') = 'false', (select v from r_cap where k='r1c');
insert into t_res select 'agent WITH campaign access: the contact is Closed and the close row is theirs', (select contact_status from public.contacts where id = 'a24a0000-a000-4000-8000-0000000000c9') = 'Closed' and exists (select 1 from public.contact_closes where contact_id = 'a24a0000-a000-4000-8000-0000000000c9' and closed_by = 'a24a0000-a000-4000-8000-000000000008'), null;
insert into t_res select 'agent WITH campaign access: log_contact_close by id also passes (control for the access rule)', pg_temp.run_as('a24a0000-a000-4000-8000-000000000008', $q$ select * from public.log_contact_close('a24a0000-a000-4000-8000-0000000000c9', 'T9', 'Lead 9 Biz', '+13185550109', null, array['Cleaning'], array['Monroe'], array['weekly'], true) $q$) not like 'ERR%', null;

-- 2. unknown number, agent: contact is created from the form, then closed
insert into r_cap select 'r2', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+1 (318) 555-0199', 'New Owner', 'New Biz LLC'));
insert into t_res select 'unknown number: contact created + closed in one call', ((select v from r_cap where k='r2')::jsonb ->> 'contact_created') = 'true' and ((select v from r_cap where k='r2')::jsonb ->> 'close_id') is not null, (select v from r_cap where k='r2');
insert into t_res select 'unknown number: contact has org, E.164 phone, business, owner, city, timezone, creator, status Closed', exists (
  select 1 from public.contacts where id = ((select v from r_cap where k='r2')::jsonb ->> 'contact_id')::uuid and org_id = 'a24a0000-a000-4000-8000-0000000000a1'::uuid and phone_number = '+13185550199'
    and business_name = 'New Biz LLC' and owner_contact = 'New Owner' and city = 'Monroe' and timezone = 'America/Chicago'
    and user_id = 'a24a0000-a000-4000-8000-000000000002'::uuid and contact_status = 'Closed'), null;
insert into t_res select 'unknown number: close row points at the new contact', exists (select 1 from public.contact_closes where id = ((select v from r_cap where k='r2')::jsonb ->> 'close_id')::uuid and contact_id = ((select v from r_cap where k='r2')::jsonb ->> 'contact_id')::uuid and closed_by = 'a24a0000-a000-4000-8000-000000000002'::uuid), null;

-- 3. same number again in another format, same agent within 60 s: same contact (no duplicate), deduped close
insert into r_cap select 'r3', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '3185550199', 'New Owner', 'New Biz LLC'));
insert into t_res select 'same number, other format: same contact, close deduped, one contact, one close', ((select v from r_cap where k='r3')::jsonb ->> 'contact_id') = ((select v from r_cap where k='r2')::jsonb ->> 'contact_id') and ((select v from r_cap where k='r3')::jsonb ->> 'deduped') = 'true' and ((select v from r_cap where k='r3')::jsonb ->> 'contact_created') = 'false' and pg_temp.n_contacts('a24a0000-a000-4000-8000-0000000000a1', '+13185550199') = 1 and (select count(*) from public.contact_closes where contact_id = ((select v from r_cap where k='r2')::jsonb ->> 'contact_id')::uuid) = 1, (select v from r_cap where k='r3');

-- 4. a DIFFERENT agent, same number, now an existing contact created by the first agent: no access, no inbound -> refused
insert into r_cap select 'r4', pg_temp.run_as('a24a0000-a000-4000-8000-000000000003', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550199', 'New Owner', 'New Biz LLC'));
insert into t_res select 'contact created by agent 1: agent 2 (no access, no inbound) is refused, not given the contact', (select v from r_cap where k='r4') like 'ERR 42501%' and pg_temp.n_closes('a24a0000-a000-4000-8000-0000000000a1') >= 1 and (select count(*) from public.contact_closes where contact_id = ((select v from r_cap where k='r2')::jsonb ->> 'contact_id')::uuid) = 1, (select v from r_cap where k='r4');

-- 5. a number that exists only in ANOTHER org: a new contact in this org (no cross-org match), the other org's contact untouched
insert into r_cap select 'r5', pg_temp.run_as('a24a0000-a000-4000-8000-000000000001', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550102', 'O', 'Cross Biz'));
insert into t_res select 'number known only in org B: created in org A, org B contact untouched', ((select v from r_cap where k='r5')::jsonb ->> 'contact_created') = 'true' and ((select v from r_cap where k='r5')::jsonb ->> 'contact_id') <> 'a24a0000-a000-4000-8000-0000000000c2' and (select contact_status from public.contacts where id = 'a24a0000-a000-4000-8000-0000000000c2') = 'No Contact' and pg_temp.n_closes('a24a0000-a000-4000-8000-0000000000b2') = 0, (select v from r_cap where k='r5');

-- 6. manager + owner allowed
insert into t_res select 'manager may log a close by phone', pg_temp.run_as('a24a0000-a000-4000-8000-000000000004', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550111', 'M', 'Mgr Biz')) not like 'ERR%', null;

-- 7. refused: member of another org, user with no membership, no JWT
insert into t_res select 'member of ANOTHER org is refused (42501), nothing created', pg_temp.run_as('a24a0000-a000-4000-8000-000000000005', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550122', 'X', 'X Biz')) like 'ERR 42501%' and pg_temp.n_contacts('a24a0000-a000-4000-8000-0000000000a1', '+13185550122') = 0, null;
insert into t_res select 'user with no membership is refused (42501)', pg_temp.run_as('a24a0000-a000-4000-8000-000000000006', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550123', 'N', 'N Biz')) like 'ERR 42501%', null;
insert into t_res select 'agent of A naming org B is refused (42501)', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000b2', '+13185550124', 'N', 'N Biz')) like 'ERR 42501%' and pg_temp.n_contacts('a24a0000-a000-4000-8000-0000000000b2', '+13185550124') = 0, null;
insert into t_res select 'no JWT (anon) cannot call it at all', pg_temp.run_as(null, pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550125', 'N', 'N Biz')) like 'ERR 42501%' or pg_temp.run_as(null, pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550125', 'N', 'N Biz')) like 'ERR 28000%', null;
insert into t_res select 'anon has no execute grant on by_phone; the core is not callable by authenticated', not has_function_privilege('anon', 'public.log_contact_close_by_phone(uuid,text,text,text,text,text,text[],text[],text[],boolean,text,numeric,integer,integer)', 'execute')
  and not has_function_privilege('authenticated', 'private.log_contact_close_core(uuid,uuid,uuid,text,text,text,text,text[],text[],text[],boolean,text,numeric,integer,integer)', 'execute'), null;

-- 8. validation: refused with the form's readable message, and NO contact is left behind
insert into t_res select 'invalid phone -> 22023, no contact', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '12345', 'N', 'N Biz')) like 'ERR 22023%phone%', null;
insert into t_res select 'unknown number with no owner name -> 22023, no contact', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550131', '', 'Biz')) like 'ERR 22023%owner%' and pg_temp.n_contacts('a24a0000-a000-4000-8000-0000000000a1', '+13185550131') = 0, null;
insert into t_res select 'unknown number, close refused later (no services): the new contact is rolled back too', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', pg_temp.byphone('a24a0000-a000-4000-8000-0000000000a1', '+13185550132', 'N', 'Biz', 'array[]::text[]')) like 'ERR 22023%service%' and pg_temp.n_contacts('a24a0000-a000-4000-8000-0000000000a1', '+13185550132') = 0, null;

-- 9. REGRESSION of the refactored log_contact_close (by contact id)
insert into r_cap select 'r9', pg_temp.run_as('a24a0000-a000-4000-8000-000000000001', $q$ select * from public.log_contact_close('a24a0000-a000-4000-8000-0000000000c3', 'Nora', 'Named Co', '+13185550103', null, array['Cleaning'], array['Monroe'], array['weekly'], true) $q$);
insert into t_res select 'log_contact_close by id: owner closes a named contact (works as before)', (select v from r_cap where k='r9') not like 'ERR%' and (select contact_status from public.contacts where id = 'a24a0000-a000-4000-8000-0000000000c3') = 'Closed', (select v from r_cap where k='r9');
insert into t_res select 'log_contact_close by id: an agent WITHOUT campaign access is still refused (42501, unchanged rule)', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', $q$ select * from public.log_contact_close('a24a0000-a000-4000-8000-0000000000c1', 'H', 'H', '+13187800951', null, array['Cleaning'], array['Monroe'], array['weekly'], true) $q$) like 'ERR 42501%no access%', null;
insert into t_res select 'log_contact_close by id: member of another org refused (42501)', pg_temp.run_as('a24a0000-a000-4000-8000-000000000005', $q$ select * from public.log_contact_close('a24a0000-a000-4000-8000-0000000000c3', 'H', 'H', '+13185550103', null, array['Cleaning'], array['Monroe'], array['weekly'], true) $q$) like 'ERR 42501%', null;
insert into t_res select 'log_contact_close by id: unknown contact -> P0002', pg_temp.run_as('a24a0000-a000-4000-8000-000000000001', $q$ select * from public.log_contact_close('a24a0000-a000-4000-8000-0000000000ff', 'H', 'H', '+13187800951', null, array['Cleaning'], array['Monroe'], array['weekly'], true) $q$) like 'ERR P0002%', null;
insert into t_res select 'agent still cannot change a contact field directly (trigger unchanged)', pg_temp.run_as('a24a0000-a000-4000-8000-000000000002', $q$ update public.contacts set business_name = 'hacked' where id = 'a24a0000-a000-4000-8000-0000000000c3' returning 1 $q$) like 'ERR 42501%' or (select business_name from public.contacts where id = 'a24a0000-a000-4000-8000-0000000000c3') = 'Named Co', null;

select jsonb_build_object('failed', coalesce((select jsonb_agg(label) from t_res where ok is not true), '[]'::jsonb), 'n', (select count(*) from t_res)) as result;
rollback;

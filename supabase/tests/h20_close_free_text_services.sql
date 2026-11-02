-- TASK-H20: log_contact_close accepts free-text services (org with NO categories, and an "Other" value when it has some).
-- Needs migration *_h20_close_services_free_text.sql applied. Run: begin; <this file>; rollback;  Output: one row, failed must be [].
-- Positive control: against the H03 original, K2/K3 fail ("unknown service category") and K5 fails (20 allowed -> no error).
create temporary table _h20 (k text primary key, ok boolean not null, detail text) on commit drop;
grant all on _h20 to authenticated;

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $f$
begin
  return new;
end;
$f$;

insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', '6b200000-0000-4000-8000-0000000000a1', 'authenticated', 'authenticated',
  'h20dry@example.invalid', 'x', now(), '{}', '{}', now(), now(), '', '', false, false);
insert into public.orgs (id, name, created_by) values ('6b200000-0000-4000-8000-000000000001', 'H20 Org', '6b200000-0000-4000-8000-0000000000a1');
insert into public.org_members (org_id, user_id, role, status) values
  ('6b200000-0000-4000-8000-000000000001', '6b200000-0000-4000-8000-0000000000a1', 'owner', 'active');
insert into public.contacts (id, user_id, org_id, first_name, phone_number)
select ('6b200000-0000-4000-8000-0000000000' || x.c)::uuid, '6b200000-0000-4000-8000-0000000000a1', '6b200000-0000-4000-8000-000000000001', x.c, '+155542' || x.n
from (values ('c1','00001'),('c2','00002'),('c3','00003'),('c4','00004'),('c5','00005'),('c6','00006')) as x(c, n);

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"6b200000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);

-- K1: org with NO org_close_settings row: free text accepted
do $d$ begin
  perform public.log_contact_close('6b200000-0000-4000-8000-0000000000c1', 'Pat', 'Biz', '(512) 555-0100', null,
    array['plumbing', ' HVAC '], array['Austin'], array['weekly'], true);
  insert into _h20 values ('K1_no_categories_free_text_ok', true, null);
exception when others then insert into _h20 values ('K1_no_categories_free_text_ok', false, sqlstate || ' ' || sqlerrm); end $d$;
insert into _h20 select 'K1_trimmed', coalesce((select services @> array['HVAC'] and services @> array['plumbing'] from public.contact_closes where contact_id = '6b200000-0000-4000-8000-0000000000c1'), false), null;

-- K2/K3: org WITH categories: a listed one and an "Other" one together
reset role;
insert into public.org_close_settings (org_id, service_categories) values ('6b200000-0000-4000-8000-000000000001', array['Gutters','Windows']);
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"6b200000-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
do $d$ begin
  perform public.log_contact_close('6b200000-0000-4000-8000-0000000000c2', 'Pat', 'Biz', '(512) 555-0101', null,
    array['Gutters', 'Pressure washing'], array['Austin'], array['weekly'], true);
  insert into _h20 values ('K2_listed_plus_other_ok', true, null);
exception when others then insert into _h20 values ('K2_listed_plus_other_ok', false, sqlstate || ' ' || sqlerrm); end $d$;
do $d$ begin
  perform public.log_contact_close('6b200000-0000-4000-8000-0000000000c3', 'Pat', 'Biz', '(512) 555-0102', null,
    array['Roofing'], array['Austin'], array['weekly'], true);
  insert into _h20 values ('K3_other_only_ok', true, null);
exception when others then insert into _h20 values ('K3_other_only_ok', false, sqlstate || ' ' || sqlerrm); end $d$;

-- K4: empty / blank still rejected
do $d$ begin
  perform public.log_contact_close('6b200000-0000-4000-8000-0000000000c4', 'Pat', 'Biz', '(512) 555-0103', null,
    array['   '], array['Austin'], array['weekly'], true);
  insert into _h20 values ('K4_blank_rejected', false, 'succeeded');
exception when others then insert into _h20 values ('K4_blank_rejected', sqlstate = '22023', sqlstate || ' ' || sqlerrm); end $d$;

-- K5: 11 services rejected; 10 would be ok
do $d$ begin
  perform public.log_contact_close('6b200000-0000-4000-8000-0000000000c5', 'Pat', 'Biz', '(512) 555-0104', null,
    (select array_agg('svc' || g) from generate_series(1, 11) g), array['Austin'], array['weekly'], true);
  insert into _h20 values ('K5_eleven_rejected', false, 'succeeded');
exception when others then insert into _h20 values ('K5_eleven_rejected', sqlstate = '22023', sqlstate || ' ' || sqlerrm); end $d$;

-- K6: 61-character service rejected
do $d$ begin
  perform public.log_contact_close('6b200000-0000-4000-8000-0000000000c6', 'Pat', 'Biz', '(512) 555-0105', null,
    array[repeat('x', 61)], array['Austin'], array['weekly'], true);
  insert into _h20 values ('K6_too_long_rejected', false, 'succeeded');
exception when others then insert into _h20 values ('K6_too_long_rejected', sqlstate = '22023', sqlstate || ' ' || sqlerrm); end $d$;

reset role;
select jsonb_build_object(
  'failed', coalesce((select jsonb_agg(k order by k) from _h20 where not ok), '[]'::jsonb),
  'results', (select jsonb_object_agg(k, ok) from _h20),
  'details', coalesce((select jsonb_object_agg(k, detail) from _h20 where detail is not null), '{}'::jsonb)
) as h20_dryrun;

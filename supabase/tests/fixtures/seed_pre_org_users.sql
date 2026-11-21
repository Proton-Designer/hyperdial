-- Seeds two legacy (pre-org) users with a contact and a campaign each. Run this against the
-- LEGACY schema only, i.e. after scripts/db-local-reset.sh's legacy replay and BEFORE the new
-- 20260924* migrations are applied -- it proves the backfill migration picks up data that existed
-- before orgs did. See supabase/tests/run-tenancy-tests.sh.
--
-- Seeded users exercise the two org-name fallback paths: user A has raw_user_meta_data.company_name
-- set (org name = that value); user B has none, so the org name must fall back to the email
-- domain.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at, confirmation_token, recovery_token,
  is_sso_user, is_anonymous
) values
  (
    '00000000-0000-0000-0000-000000000000',
    '9c1f7a10-0000-4000-8000-00000000000a',
    'authenticated', 'authenticated', 'legacy-a@example.com', crypt('password123', gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}',
    '{"first_name":"Ann","last_name":"Owner","company_name":"Acme Cold Calling"}',
    now(), now(), '', '', false, false
  ),
  (
    '00000000-0000-0000-0000-000000000000',
    '9c1f7a10-0000-4000-8000-00000000000b',
    'authenticated', 'authenticated', 'legacy-b@example.com', crypt('password123', gen_salt('bf')),
    now(), '{"provider":"email","providers":["email"]}',
    '{"first_name":"Bo","last_name":"Ownerson"}',
    now(), now(), '', '', false, false
  );

insert into public.contacts (id, user_id, first_name, last_name, phone_number)
values
  ('9c1f7a10-0001-4000-8000-00000000000a', '9c1f7a10-0000-4000-8000-00000000000a', 'Cara', 'Contact', '+15550000001'),
  ('9c1f7a10-0001-4000-8000-00000000000b', '9c1f7a10-0000-4000-8000-00000000000b', 'Dee', 'Contact', '+15550000002');

insert into public.campaigns (id, user_id, name)
values
  ('9c1f7a10-0002-4000-8000-00000000000a', '9c1f7a10-0000-4000-8000-00000000000a', 'Legacy Campaign A'),
  ('9c1f7a10-0002-4000-8000-00000000000b', '9c1f7a10-0000-4000-8000-00000000000b', 'Legacy Campaign B');

insert into public.campaign_leads (campaign_id, contact_id)
values
  ('9c1f7a10-0002-4000-8000-00000000000a', '9c1f7a10-0001-4000-8000-00000000000a'),
  ('9c1f7a10-0002-4000-8000-00000000000b', '9c1f7a10-0001-4000-8000-00000000000b');

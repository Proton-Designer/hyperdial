-- Assertions for the tenancy backfill (TASK-P1-01 acceptance criteria #2). Run after
-- fixtures/seed_pre_org_users.sql and the new migrations have both been applied. Raises on the
-- first failure (ON_ERROR_STOP is set by the caller); prints one line per passed check.

do $$
declare
  org_a uuid;
  org_b uuid;
  role_a text;
  role_b text;
  name_a text;
  name_b text;
  contact_org_a uuid;
  contact_org_b uuid;
  campaign_org_a uuid;
  campaign_org_b uuid;
  lead_org_a uuid;
  lead_org_b uuid;
begin
  select active_org_id into org_a from public.profiles where user_id = '9c1f7a10-0000-4000-8000-00000000000a';
  select active_org_id into org_b from public.profiles where user_id = '9c1f7a10-0000-4000-8000-00000000000b';

  if org_a is null or org_b is null then
    raise exception 'FAIL: backfill did not create a profile/org for one or both seeded users';
  end if;
  if org_a = org_b then
    raise exception 'FAIL: both seeded users backfilled into the SAME org (expected one org each)';
  end if;
  raise notice 'PASS: each seeded user got a distinct org (a=%, b=%)', org_a, org_b;

  select role into role_a from public.org_members where org_id = org_a and user_id = '9c1f7a10-0000-4000-8000-00000000000a';
  select role into role_b from public.org_members where org_id = org_b and user_id = '9c1f7a10-0000-4000-8000-00000000000b';
  if role_a is distinct from 'owner' or role_b is distinct from 'owner' then
    raise exception 'FAIL: backfilled user is not owner of their own org (a=%, b=%)', role_a, role_b;
  end if;
  raise notice 'PASS: each seeded user is owner of their own org';

  select name into name_a from public.orgs where id = org_a;
  select name into name_b from public.orgs where id = org_b;
  if name_a is distinct from 'Acme Cold Calling' then
    raise exception 'FAIL: org name did not use raw_user_meta_data.company_name (got %)', name_a;
  end if;
  if name_b is distinct from 'example.com' then
    raise exception 'FAIL: org name did not fall back to the email domain (got %)', name_b;
  end if;
  raise notice 'PASS: org name derivation (company_name, then email domain fallback) is correct';

  select org_id into contact_org_a from public.contacts where id = '9c1f7a10-0001-4000-8000-00000000000a';
  select org_id into contact_org_b from public.contacts where id = '9c1f7a10-0001-4000-8000-00000000000b';
  select org_id into campaign_org_a from public.campaigns where id = '9c1f7a10-0002-4000-8000-00000000000a';
  select org_id into campaign_org_b from public.campaigns where id = '9c1f7a10-0002-4000-8000-00000000000b';
  select org_id into lead_org_a from public.campaign_leads where campaign_id = '9c1f7a10-0002-4000-8000-00000000000a';
  select org_id into lead_org_b from public.campaign_leads where campaign_id = '9c1f7a10-0002-4000-8000-00000000000b';

  if contact_org_a is distinct from org_a or campaign_org_a is distinct from org_a or lead_org_a is distinct from org_a then
    raise exception 'FAIL: user A''s pre-existing rows did not backfill to org A (contact=%, campaign=%, lead=%)',
      contact_org_a, campaign_org_a, lead_org_a;
  end if;
  if contact_org_b is distinct from org_b or campaign_org_b is distinct from org_b or lead_org_b is distinct from org_b then
    raise exception 'FAIL: user B''s pre-existing rows did not backfill to org B (contact=%, campaign=%, lead=%)',
      contact_org_b, campaign_org_b, lead_org_b;
  end if;
  raise notice 'PASS: pre-existing contacts, campaigns, and campaign_leads backfilled to the correct org';

  raise notice 'ALL BACKFILL ASSERTIONS PASSED';
end;
$$;

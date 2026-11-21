-- TASK-H29: public "pro form" + approve into Onboarded pros. First public, no-login surface: everything a visitor can reach
-- goes through the Edge function `pro-application` (service role) which calls the SERVICE-ONLY definer RPCs below; no table is
-- readable or writable by anon, and nothing a visitor sends is trusted beyond the validation here.
--
--   pro_form_links      one live link per (org, user): the token credits that user. No client writes (RPCs only).
--   pro_applications    what a pro submitted; pending | approved | rejected. No client writes.
--   pro_form_attempts   rate-limit ledger (hashed IP + link). Service only: RLS on, no policy, no grant.
--   get_my_pro_form_link / rotate_my_pro_form_link   any active owner/admin/manager/agent; user_id is always auth.uid()
--   get_pro_form_info / submit_pro_application       SERVICE ROLE ONLY (revoked from anon/authenticated)
--   review_pro_application                           owner/admin only, row lock, idempotent: approve creates the close
--   list_pro_applications                            owner/admin all; manager: only referrals from their pods; agents refused
-- Required on the public form: owner name, business name, mobile, >= 1 service, >= 1 city, >= 1 frequency, insured.
-- Rate limits (counted per attempt after the token resolves): 5 / hour per hashed IP, 30 / hour per link.
-- A second PENDING application from the same org + mobile replaces the pending row (the first link keeps the credit).
-- The submit RPC never says whether the number or business already exists as a contact or close.
-- The tokens are 64 hex chars from two gen_random_uuid() (CSPRNG, 244 bits), unique.

-- ---- 1. links -------------------------------------------------------------------------------------------------------
create table public.pro_form_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  token text not null unique check (char_length(token) >= 32),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index pro_form_links_one_live on public.pro_form_links (org_id, user_id) where revoked_at is null;
alter table public.pro_form_links enable row level security;
revoke all on table public.pro_form_links from public, anon, authenticated;
grant select on table public.pro_form_links to authenticated;
create policy "own link, owner/admin read the org's"
  on public.pro_form_links for select to authenticated
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (user_id = auth.uid() and private.is_org_member(org_id))
  );

-- ---- 2. applications ------------------------------------------------------------------------------------------------
create table public.pro_applications (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  link_id uuid references public.pro_form_links(id) on delete set null,
  referred_by uuid references auth.users(id) on delete set null,
  owner_name text not null check (char_length(owner_name) between 1 and 120),
  business_name text not null check (char_length(business_name) between 1 and 200),
  mobile text not null check (mobile ~ '^\+[0-9]{10,15}$'),
  email text check (email is null or (char_length(email) <= 200 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  services text[] not null check (cardinality(services) between 1 and 20),
  cities text[] not null check (cardinality(cities) between 1 and 30),
  frequencies text[] not null
    check (cardinality(frequencies) between 1 and 3 and frequencies <@ array['weekly', 'biweekly', 'monthly']),
  insured boolean not null,
  best_contact text check (best_contact is null or char_length(best_contact) <= 500),
  starting_price numeric(10, 2) check (starting_price is null or starting_price >= 0),
  capacity integer check (capacity is null or capacity between 0 and 10000),
  years_in_business integer check (years_in_business is null or years_in_business between 0 and 150),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  close_id uuid references public.contact_closes(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  ip_hash text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index pro_applications_pending_mobile_idx on public.pro_applications (org_id, mobile) where status = 'pending';
create index pro_applications_org_status_idx on public.pro_applications (org_id, status, created_at desc);
create index pro_applications_referred_idx on public.pro_applications (referred_by);
alter table public.pro_applications enable row level security;
revoke all on table public.pro_applications from public, anon, authenticated;
grant select on table public.pro_applications to authenticated;
create policy "owner/admin read all, manager referrals from their pods"
  on public.pro_applications for select to authenticated
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (private.has_org_role(org_id, array['manager'])
        and referred_by is not null
        and private.is_agent_in_callers_pod_scope(org_id, referred_by))
  );

-- ---- 3. rate-limit ledger -------------------------------------------------------------------------------------------
create table public.pro_form_attempts (
  id bigint generated always as identity primary key,
  link_id uuid not null references public.pro_form_links(id) on delete cascade,
  ip_hash text not null,
  created_at timestamptz not null default now()
);
create index pro_form_attempts_ip_idx on public.pro_form_attempts (ip_hash, created_at);
create index pro_form_attempts_link_idx on public.pro_form_attempts (link_id, created_at);
alter table public.pro_form_attempts enable row level security;
revoke all on table public.pro_form_attempts from public, anon, authenticated;

-- ---- 4. my link ---------------------------------------------------------------------------------------------------
create function public.get_my_pro_form_link(p_org_id uuid)
returns table (token text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_token text;
  v_created timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_org_id is null or not private.has_org_role(p_org_id, array['owner', 'admin', 'manager', 'agent']) then
    raise exception 'not allowed in this organization' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('proformlink:' || p_org_id::text || ':' || v_uid::text));
  select l.token, l.created_at into v_token, v_created
  from public.pro_form_links l
  where l.org_id = p_org_id and l.user_id = v_uid and l.revoked_at is null;
  if v_token is null then
    v_token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    insert into public.pro_form_links (org_id, user_id, token) values (p_org_id, v_uid, v_token)
    returning created_at into v_created;
  end if;
  return query select v_token, v_created;
end;
$$;

-- the kill switch: the old link stops working at once, a new one is issued
create function public.rotate_my_pro_form_link(p_org_id uuid)
returns table (token text, created_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_token text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
  v_created timestamptz;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_org_id is null or not private.has_org_role(p_org_id, array['owner', 'admin', 'manager', 'agent']) then
    raise exception 'not allowed in this organization' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('proformlink:' || p_org_id::text || ':' || v_uid::text));
  update public.pro_form_links l set revoked_at = now()
  where l.org_id = p_org_id and l.user_id = v_uid and l.revoked_at is null;
  insert into public.pro_form_links (org_id, user_id, token) values (p_org_id, v_uid, v_token)
  returning created_at into v_created;
  return query select v_token, v_created;
end;
$$;

-- ---- 5. public side (service role only) -----------------------------------------------------------------------------
-- GET: what the form page needs. Zero rows = unknown, revoked, or the link's owner is no longer an active member.
create function public.get_pro_form_info(p_token text)
returns table (org_name text, service_categories text[])
language sql
security definer
stable
set search_path = ''
as $$
  select o.name, coalesce(s.service_categories, '{}')
  from public.pro_form_links l
  join public.orgs o on o.id = l.org_id
  join public.org_members m on m.org_id = l.org_id and m.user_id = l.user_id and m.status = 'active'
  left join public.org_close_settings s on s.org_id = l.org_id
  where l.token = p_token and l.revoked_at is null
  limit 1;
$$;

-- POST: status is 'ok' | 'not_found' | 'rate_limited' | 'invalid' (message = the readable reason). Never raises for a visitor's
-- input, so the attempt row that was just counted is kept even when the form is wrong.
create function public.submit_pro_application(
  p_token text,
  p_ip_hash text,
  p_owner_name text,
  p_business_name text,
  p_mobile text,
  p_email text,
  p_services text[],
  p_cities text[],
  p_frequencies text[],
  p_insured boolean,
  p_best_contact text default null,
  p_starting_price numeric default null,
  p_capacity integer default null,
  p_years_in_business integer default null
)
returns table (status text, message text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_link public.pro_form_links;
  v_owner text := btrim(coalesce(p_owner_name, ''));
  v_business text := btrim(coalesce(p_business_name, ''));
  v_email text := nullif(btrim(coalesce(p_email, '')), '');
  v_best text := nullif(btrim(coalesce(p_best_contact, '')), '');
  v_digits text;
  v_mobile text;
  v_services text[];
  v_cities text[];
  v_freqs text[];
  v_ip text := coalesce(nullif(btrim(p_ip_hash), ''), 'unknown');
begin
  select l.* into v_link
  from public.pro_form_links l
  join public.org_members m on m.org_id = l.org_id and m.user_id = l.user_id and m.status = 'active'
  where l.token = p_token and l.revoked_at is null;
  if v_link.id is null then
    return query select 'not_found'::text, null::text;
    return;
  end if;

  -- serialize concurrent submissions per link, then per ip hash (always this order), so the count-then-insert below
  -- cannot be raced past the caps by parallel requests
  perform pg_advisory_xact_lock(hashtext('proformlinkrate:' || v_link.id::text));
  perform pg_advisory_xact_lock(hashtext('proformiprate:' || v_ip));

  delete from public.pro_form_attempts a where a.created_at < now() - interval '1 day';
  if (select count(*) from public.pro_form_attempts a where a.ip_hash = v_ip and a.created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.pro_form_attempts a where a.link_id = v_link.id and a.created_at > now() - interval '1 hour') >= 30 then
    return query select 'rate_limited'::text, null::text;
    return;
  end if;
  insert into public.pro_form_attempts (link_id, ip_hash) values (v_link.id, v_ip);

  if v_owner = '' then return query select 'invalid'::text, 'Owner name is required'::text; return; end if;
  if v_business = '' then return query select 'invalid'::text, 'Business name is required'::text; return; end if;
  if char_length(v_owner) > 120 or char_length(v_business) > 200 then
    return query select 'invalid'::text, 'A name is too long'::text; return;
  end if;
  v_digits := regexp_replace(coalesce(p_mobile, ''), '[^0-9]', '', 'g');
  if length(v_digits) = 10 then
    v_mobile := '+1' || v_digits;
  elsif length(v_digits) between 11 and 15 then
    v_mobile := '+' || v_digits;
  else
    return query select 'invalid'::text, 'Mobile number is not valid'::text; return;
  end if;
  if v_email is not null and (char_length(v_email) > 200 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    return query select 'invalid'::text, 'Email is not valid'::text; return;
  end if;
  select array_agg(distinct btrim(s)) into v_services from unnest(coalesce(p_services, '{}')) s where btrim(s) <> '';
  select array_agg(distinct btrim(s)) into v_cities from unnest(coalesce(p_cities, '{}')) s where btrim(s) <> '';
  select array_agg(distinct lower(btrim(s))) into v_freqs from unnest(coalesce(p_frequencies, '{}')) s where btrim(s) <> '';
  if v_services is null then return query select 'invalid'::text, 'Pick at least one service'::text; return; end if;
  if v_cities is null then return query select 'invalid'::text, 'Add at least one city'::text; return; end if;
  if v_freqs is null then return query select 'invalid'::text, 'Pick at least one frequency'::text; return; end if;
  if cardinality(v_services) > 10 or cardinality(v_cities) > 30
     or exists (select 1 from unnest(v_services) s where char_length(s) > 60)
     or exists (select 1 from unnest(v_cities) s where char_length(s) > 80) then
    return query select 'invalid'::text, 'Too many or too long services or cities'::text; return;
  end if;
  if not (v_freqs <@ array['weekly', 'biweekly', 'monthly']) then
    return query select 'invalid'::text, 'Frequency must be weekly, biweekly or monthly'::text; return;
  end if;
  if p_insured is null then return query select 'invalid'::text, 'Say whether you are insured'::text; return; end if;
  if v_best is not null and char_length(v_best) > 500 then
    return query select 'invalid'::text, 'Best time/way is too long'::text; return;
  end if;
  if p_starting_price is not null and (p_starting_price < 0 or p_starting_price > 99999999) then
    return query select 'invalid'::text, 'Starting price is not valid'::text; return;
  end if;
  if p_capacity is not null and (p_capacity < 0 or p_capacity > 10000) then
    return query select 'invalid'::text, 'Capacity is not valid'::text; return;
  end if;
  if p_years_in_business is not null and (p_years_in_business < 0 or p_years_in_business > 150) then
    return query select 'invalid'::text, 'Years in business is not valid'::text; return;
  end if;

  perform pg_advisory_xact_lock(hashtext('proformmobile:' || v_link.org_id::text || ':' || v_mobile));  -- third and last, for the cap below

  -- A correction replaces the pending row only when the SAME visitor sends it: org + mobile + link + ip hash all match.
  -- Anyone else (another link, another address) gets their own pending row and the same answer; the reviewer sees the
  -- duplicates through list_pro_applications.same_number_pending. A stranger can therefore never alter an existing row.
  update public.pro_applications pa set
    owner_name = v_owner, business_name = v_business, email = v_email, services = v_services, cities = v_cities,
    frequencies = v_freqs, insured = p_insured, best_contact = v_best, starting_price = p_starting_price,
    capacity = p_capacity, years_in_business = p_years_in_business, updated_at = now()
  where pa.id = (
    select x.id from public.pro_applications x
    where x.org_id = v_link.org_id and x.mobile = v_mobile and x.status = 'pending'
      and x.link_id = v_link.id and x.ip_hash = v_ip
    order by x.created_at limit 1
    for update
  );
  if not found then
    -- at most 3 pending rows per org + mobile: a 4th from yet another link/address gets the same answer but is not stored
    if (select count(*) from public.pro_applications x
        where x.org_id = v_link.org_id and x.mobile = v_mobile and x.status = 'pending') >= 3 then
      return query select 'ok'::text, null::text;
      return;
    end if;
    insert into public.pro_applications (
      org_id, link_id, referred_by, owner_name, business_name, mobile, email, services, cities, frequencies, insured,
      best_contact, starting_price, capacity, years_in_business, ip_hash
    ) values (
      v_link.org_id, v_link.id, v_link.user_id, v_owner, v_business, v_mobile, v_email, v_services, v_cities, v_freqs,
      p_insured, v_best, p_starting_price, p_capacity, p_years_in_business, v_ip
    );
  end if;
  return query select 'ok'::text, null::text;
end;
$$;

revoke all on function public.get_pro_form_info(text) from public, anon, authenticated;
revoke all on function public.submit_pro_application(text, text, text, text, text, text, text[], text[], text[], boolean, text, numeric, integer, integer) from public, anon, authenticated;
grant execute on function public.get_pro_form_info(text) to service_role;
grant execute on function public.submit_pro_application(text, text, text, text, text, text, text[], text[], text[], boolean, text, numeric, integer, integer) to service_role;

-- ---- 6. review (owner/admin) -----------------------------------------------------------------------------------------
create function public.review_pro_application(p_id uuid, p_action text)
returns table (status text, close_id uuid, contact_id uuid, contact_created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_app public.pro_applications;
  v_contact uuid;
  v_created boolean := false;
  v_closer uuid;
  v_hook boolean;
  v_delivery text;
  v_close uuid;
  v_tz text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_action is null or p_action not in ('approve', 'reject') then
    raise exception 'action must be approve or reject' using errcode = '22023';
  end if;
  -- an unknown id and someone else's id look the same
  select a.org_id into v_org from public.pro_applications a where a.id = p_id;
  if v_org is null or not private.has_org_role(v_org, array['owner', 'admin']) then
    raise exception 'not allowed to review applications' using errcode = '42501';
  end if;

  select a.* into v_app from public.pro_applications a where a.id = p_id for update;
  if v_app.status <> 'pending' then
    raise exception 'This application was already reviewed' using errcode = '22023';
  end if;

  if p_action = 'reject' then
    update public.pro_applications set status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), updated_at = now()
    where id = p_id;
    return query select 'rejected'::text, null::uuid, null::uuid, false;
    return;
  end if;

  -- approve: the org contact for this number (same lock as the by-phone close), created when there is none. An existing
  -- contact is never modified here except contact_status; a DNC contact stays DNC.
  perform pg_advisory_xact_lock(hashtext('closephone:' || v_org::text || ':' || v_app.mobile));
  select c.id into v_contact from public.contacts c
  where c.org_id = v_org and c.phone_number = v_app.mobile
  order by c.created_at, c.id limit 1;
  if v_contact is null then
    if v_app.mobile ~ '^\+1[0-9]{10}$' then
      select t.timezone into v_tz from private.area_code_timezones t where t.area_code = substring(v_app.mobile from 3 for 3);
    end if;
    insert into public.contacts (user_id, org_id, business_name, owner_contact, phone_number, phone_raw, timezone, city, import_list)
    values (v_uid, v_org, v_app.business_name, v_app.owner_name, v_app.mobile, v_app.mobile, v_tz, v_app.cities[1], 'Pro form')
    returning id into v_contact;
    v_created := true;
  end if;

  -- the close is credited to whoever referred the form if they are still an active member, else to the approver
  v_closer := case when v_app.referred_by is not null and exists (
      select 1 from public.org_members m where m.org_id = v_org and m.user_id = v_app.referred_by and m.status = 'active')
    then v_app.referred_by else v_uid end;

  select (w.enabled and w.url is not null) into v_hook from public.org_close_webhook w where w.org_id = v_org;
  v_delivery := case when coalesce(v_hook, false) then 'pending' else 'not_configured' end;

  insert into public.contact_closes (
    org_id, contact_id, closed_by, owner_name, business_name, mobile, email, services, cities, frequencies,
    insured, best_contact, starting_price, capacity, years_in_business, delivery_status, next_attempt_at
  ) values (
    v_org, v_contact, v_closer, v_app.owner_name, v_app.business_name, v_app.mobile, v_app.email, v_app.services,
    v_app.cities, v_app.frequencies, v_app.insured, v_app.best_contact, v_app.starting_price, v_app.capacity,
    v_app.years_in_business, v_delivery, case when v_delivery = 'pending' then now() end
  ) returning id into v_close;

  update public.contacts set contact_status = 'Closed' where id = v_contact;

  begin
    perform public.enqueue_crm_job(v_org, 'close_tag', v_contact, null, jsonb_build_object('ghl_tag', 'closed'));
  exception when others then
    perform private.log_trigger_failure(v_org, 'contact_close_tag', v_close, sqlstate || ': ' || sqlerrm);
  end;

  update public.pro_applications
  set status = 'approved', reviewed_by = v_uid, reviewed_at = now(), close_id = v_close, contact_id = v_contact, updated_at = now()
  where id = p_id;
  return query select 'approved'::text, v_close, v_contact, v_created;
end;
$$;

-- ---- 7. list (owner/admin all; manager only referrals from their pods) ---------------------------------------------
create function public.list_pro_applications(p_org_id uuid, p_status text default null, p_limit integer default 200)
returns table (
  id uuid,
  referred_by uuid,
  referred_by_name text,
  owner_name text,
  business_name text,
  mobile text,
  email text,
  services text[],
  cities text[],
  frequencies text[],
  insured boolean,
  best_contact text,
  starting_price numeric,
  capacity integer,
  years_in_business integer,
  status text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  close_id uuid,
  contact_id uuid,
  created_at timestamptz,
  pending_count bigint,
  total_count bigint,
  same_number_pending boolean,
  existing_contact boolean,
  contact_dnc boolean
)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_full boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_org_id is null or not private.has_org_role(p_org_id, array['owner', 'admin', 'manager']) then
    raise exception 'not allowed to view applications in this organization' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('pending', 'approved', 'rejected') then
    raise exception 'status must be pending, approved or rejected' using errcode = '22023';
  end if;

  v_full := private.has_org_role(p_org_id, array['owner', 'admin']);

  return query
  with visible as (
    select a.* from public.pro_applications a
    where a.org_id = p_org_id
      and (private.has_org_role(p_org_id, array['owner', 'admin'])
           or (a.referred_by is not null and private.is_agent_in_callers_pod_scope(p_org_id, a.referred_by)))
  ),
  counts as (
    select count(*) filter (where v.status = 'pending') as pending, count(*) filter (where p_status is null or v.status = p_status) as total
    from visible v
  )
  select v.id, v.referred_by,
         nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
         v.owner_name, v.business_name, v.mobile, v.email, v.services, v.cities, v.frequencies, v.insured, v.best_contact,
         v.starting_price, v.capacity, v.years_in_business, v.status, v.reviewed_by, v.reviewed_at, v.close_id, v.contact_id,
         v.created_at, c.pending, c.total,
         -- another pending application for the same number among the rows this caller can see
         (v.status = 'pending' and exists (
           select 1 from visible o where o.mobile = v.mobile and o.status = 'pending' and o.id <> v.id)),
         -- contact existence / DNC only for owner/admin: a manager must not learn about contacts outside their pods
         case when v_full then exists (select 1 from public.contacts k where k.org_id = p_org_id and k.phone_number = v.mobile) end,
         case when v_full then exists (select 1 from public.contacts k where k.org_id = p_org_id and k.phone_number = v.mobile and k.dnc) end
  from visible v
  cross join counts c
  left join public.profiles p on p.user_id = v.referred_by
  where p_status is null or v.status = p_status
  order by v.created_at desc, v.id desc
  limit greatest(least(coalesce(p_limit, 200), 500), 1);
end;
$$;

revoke all on function public.get_my_pro_form_link(uuid) from public, anon;
revoke all on function public.rotate_my_pro_form_link(uuid) from public, anon;
revoke all on function public.review_pro_application(uuid, text) from public, anon;
revoke all on function public.list_pro_applications(uuid, text, integer) from public, anon;
grant execute on function public.get_my_pro_form_link(uuid) to authenticated;
grant execute on function public.rotate_my_pro_form_link(uuid) to authenticated;
grant execute on function public.review_pro_application(uuid, text) to authenticated;
grant execute on function public.list_pro_applications(uuid, text, integer) to authenticated;

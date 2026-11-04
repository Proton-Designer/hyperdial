-- TASK-H28: Log close -- nothing is required. An agent can submit the form with every field empty; the contact (or the
-- dialed number) is the only anchor. A value that IS entered must still be valid (email, phone, ranges, sizes).
--   1. contact_closes: owner_name, business_name, mobile, insured become nullable; services/cities/frequencies may be
--      empty (the ">= 1" checks become upper bounds only; found by definition, so the real names do not matter).
--      The remaining checks (length, E.164 mobile, email, ranges) pass on NULL, so entered values stay validated.
--   2. private.log_contact_close_core (shared by log_contact_close and log_contact_close_by_phone, so both change):
--      the "required" raises are gone. Blank text = NULL, never ''. Blank business name falls back to the contact's;
--      (only when the caller has contact_read_access: an inbound-proof caller learns nothing about the contact); blank mobile to the contact's phone (by phone: the dialed number, which is the new contact's phone); no usable
--      phone = NULL. A mobile that is typed but not a real number (e.g. "not sure") is still refused. Access rules, the
--      per-contact lock, the 60 s dedupe, status 'Closed' and the close_tag job are unchanged.
--   3. log_contact_close_by_phone: same signature and access rules (H24 final); a created contact no longer needs a name,
--      business_name / owner_contact are NULL when the form is blank.
-- list_onboarded_pros (H25) needs no change: it passes the columns through (checked: no not-null assumption).

do $$
declare r record;
begin
  for r in
    select conname from pg_constraint
    where conrelid = 'public.contact_closes'::regclass and contype = 'c'
      and (pg_get_constraintdef(oid) like '%cardinality(services)%'
        or pg_get_constraintdef(oid) like '%cardinality(cities)%'
        or pg_get_constraintdef(oid) like '%cardinality(frequencies)%')
  loop
    execute format('alter table public.contact_closes drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.contact_closes
  alter column owner_name drop not null,
  alter column business_name drop not null,
  alter column mobile drop not null,
  alter column insured drop not null,
  add constraint contact_closes_services_max check (cardinality(services) <= 20),
  add constraint contact_closes_cities_max check (cardinality(cities) <= 30),
  add constraint contact_closes_frequencies_valid
    check (cardinality(frequencies) <= 3 and frequencies <@ array['weekly', 'biweekly', 'monthly']);

create or replace function private.log_contact_close_core(
  p_uid uuid,
  p_org uuid,
  p_contact_id uuid,
  p_owner_name text,
  p_business_name text,
  p_mobile text,
  p_email text,
  p_services text[],
  p_cities text[],
  p_frequencies text[],
  p_insured boolean,
  p_best_contact text,
  p_starting_price numeric,
  p_capacity integer,
  p_years_in_business integer
)
returns table (close_id uuid, deduped boolean, delivery_status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := p_uid;
  v_org uuid := p_org;
  v_id uuid;
  v_status text;
  v_digits text;
  v_mobile text;
  v_services text[];
  v_cities text[];
  v_freqs text[];
  v_hook boolean;
  v_c_business text;
  v_c_phone text;
begin
  -- TASK-H05: serialize closes of one contact. Two parallel submits (double click, two tabs) used to both pass the 60 s
  -- check below and insert twice. The second caller now waits here for the first transaction to commit, then sees its row
  -- and returns it as `deduped`. Transaction-scoped: released at commit/rollback.
  perform pg_advisory_xact_lock(hashtext('close:' || p_contact_id::text));

  -- 60 s double-click guard: the same caller closing the same contact again returns the existing close.
  select cc.id, cc.delivery_status into v_id, v_status
  from public.contact_closes cc
  where cc.contact_id = p_contact_id and cc.closed_by = v_uid and cc.created_at > now() - interval '60 seconds'
  order by cc.created_at desc
  limit 1;
  if v_id is not null then
    return query select v_id, true, v_status;
    return;
  end if;

  -- validation (the table CHECKs are the backstop; these give the form readable messages)
  -- TASK-H28: nothing is required. Blank means NULL (never ''); a value that IS entered is still validated below.
  p_owner_name := nullif(btrim(coalesce(p_owner_name, '')), '');
  p_business_name := nullif(btrim(coalesce(p_business_name, '')), '');
  p_email := nullif(btrim(coalesce(p_email, '')), '');
  p_best_contact := nullif(btrim(coalesce(p_best_contact, '')), '');
  if char_length(p_owner_name) > 120 or char_length(p_business_name) > 200 then
    raise exception 'name is too long' using errcode = '22023';
  end if;
  if p_email is not null and p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'email is not valid' using errcode = '22023';
  end if;

  select nullif(btrim(coalesce(c.business_name, '')), ''), c.phone_number
    into v_c_business, v_c_phone
  from public.contacts c where c.id = p_contact_id;

  p_mobile := nullif(btrim(coalesce(p_mobile, '')), '');
  if p_mobile is not null then
    v_digits := regexp_replace(p_mobile, '[^0-9]', '', 'g');
    if length(v_digits) = 10 then
      v_mobile := '+1' || v_digits;
    elsif length(v_digits) between 11 and 15 then
      v_mobile := '+' || v_digits;
    else
      raise exception 'mobile number is not valid' using errcode = '22023';
    end if;
  else
    -- blank: the contact's own number (by phone: the dialed number); NULL when it is not a usable number
    v_digits := regexp_replace(coalesce(v_c_phone, ''), '[^0-9]', '', 'g');
    if length(v_digits) = 10 then
      v_mobile := '+1' || v_digits;
    elsif length(v_digits) between 11 and 15 then
      v_mobile := '+' || v_digits;
    end if;
  end if;
  -- blank business name: the contact's, but only for a caller who may read that contact: one let through by the inbound-call proof must not learn the
  -- contact's name from a close row they can read (contact_closes RLS shows them their own rows). The phone fallback is
  -- safe either way: a contact found by phone has exactly the dialed number.
  if p_business_name is null and private.contact_read_access(v_org, p_contact_id) then
    p_business_name := left(v_c_business, 200);
  end if;

  select array_agg(distinct btrim(s)) into v_services from unnest(coalesce(p_services, '{}')) s where btrim(s) <> '';
  select array_agg(distinct btrim(s)) into v_cities from unnest(coalesce(p_cities, '{}')) s where btrim(s) <> '';
  select array_agg(distinct lower(btrim(s))) into v_freqs from unnest(coalesce(p_frequencies, '{}')) s where btrim(s) <> '';
  v_services := coalesce(v_services, '{}');
  v_cities := coalesce(v_cities, '{}');
  v_freqs := coalesce(v_freqs, '{}');
  if cardinality(v_services) > 10 or cardinality(v_cities) > 30 then
    raise exception 'too many services or cities' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_services) s where char_length(s) > 60)
     or exists (select 1 from unnest(v_cities) s where char_length(s) > 80) then
    raise exception 'a service or city name is too long' using errcode = '22023';
  end if;
  if not (v_freqs <@ array['weekly', 'biweekly', 'monthly']) then
    raise exception 'frequency must be weekly, biweekly or monthly' using errcode = '22023';
  end if;
  -- p_insured may be NULL (not answered)
  if p_best_contact is not null and char_length(p_best_contact) > 500 then
    raise exception 'best time/way is too long' using errcode = '22023';
  end if;
  if p_starting_price is not null and (p_starting_price < 0 or p_starting_price > 99999999) then
    raise exception 'starting price is not valid' using errcode = '22023';
  end if;
  if p_capacity is not null and (p_capacity < 0 or p_capacity > 10000) then
    raise exception 'capacity is not valid' using errcode = '22023';
  end if;
  if p_years_in_business is not null and (p_years_in_business < 0 or p_years_in_business > 150) then
    raise exception 'years in business is not valid' using errcode = '22023';
  end if;

  -- TASK-H20: the org's service_categories are a pick-list suggestion, not a whitelist: an org with none (NULL) and
  -- the "Other" free-text entry both send names that are not in the list. Trim/non-empty/count/length are checked above.

  select (w.enabled and w.url is not null) into v_hook from public.org_close_webhook w where w.org_id = v_org;
  v_status := case when coalesce(v_hook, false) then 'pending' else 'not_configured' end;

  insert into public.contact_closes (
    org_id, contact_id, closed_by, owner_name, business_name, mobile, email, services, cities, frequencies,
    insured, best_contact, starting_price, capacity, years_in_business, delivery_status, next_attempt_at
  ) values (
    v_org, p_contact_id, v_uid, p_owner_name, p_business_name, v_mobile, p_email, v_services, v_cities, v_freqs,
    p_insured, p_best_contact, p_starting_price, p_capacity, p_years_in_business, v_status,
    case when v_status = 'pending' then now() end
  ) returning id into v_id;

  -- Same transaction as the insert: this is what the contacts trigger's TASK-H03 clause looks for.
  update public.contacts set contact_status = 'Closed' where id = p_contact_id;

  -- GHL 'closed' tag (no-op when GHL is not connected). A tag failure must never undo the close.
  begin
    perform public.enqueue_crm_job(v_org, 'close_tag', p_contact_id, null, jsonb_build_object('ghl_tag', 'closed'));
  exception when others then
    perform private.log_trigger_failure(v_org, 'contact_close_tag', v_id, sqlstate || ': ' || sqlerrm);
  end;

  return query select v_id, false, v_status;
end;
$$;

revoke all on function private.log_contact_close_core(uuid, uuid, uuid, text, text, text, text, text[], text[], text[], boolean, text, numeric, integer, integer) from public, anon, authenticated;

create or replace function public.log_contact_close_by_phone(
  p_org_id uuid,
  p_phone text,
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
returns table (close_id uuid, deduped boolean, delivery_status text, contact_id uuid, contact_created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_digits text;
  v_phone text;
  v_contact uuid;
  v_created boolean := false;
  v_hide boolean := false;
  v_tz text;
  v_city text;
  v_owner text := btrim(coalesce(p_owner_name, ''));
  v_business text := btrim(coalesce(p_business_name, ''));
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_org_id is null or not private.has_org_role(p_org_id, array['owner', 'admin', 'manager', 'agent']) then
    raise exception 'not allowed to log a close in this organization' using errcode = '42501';
  end if;

  -- the dialed number, E.164 (same rule as the form's mobile in the core)
  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_digits) = 10 then
    v_phone := '+1' || v_digits;
  elsif length(v_digits) between 11 and 15 then
    v_phone := '+' || v_digits;
  else
    raise exception 'phone number is not valid' using errcode = '22023';
  end if;

  -- serialize lookup+create of one number in one org (two tabs, or two agents, closing the same unknown caller)
  perform pg_advisory_xact_lock(hashtext('closephone:' || p_org_id::text || ':' || v_phone));

  select c.id into v_contact
  from public.contacts c
  where c.org_id = p_org_id and c.phone_number = v_phone
  order by c.created_at, c.id
  limit 1;

  -- Access to an EXISTING contact: read access, or the contact this caller created through this flow (import_list
  -- 'Manual close', user_id = caller, and they hold a close on it: a double submit / closing the same pro again), or an
  -- inbound call from that number in the last 7 days (org-wide on purpose: a call-back can come from another agent).
  -- A close earned through the inbound proof does NOT grant later access: it is neither read access nor "created here".
  -- contact_id is returned only when the caller may know it (read access, or they created it); otherwise NULL. (The agent
  -- can still read contact_id of their OWN closes through contact_closes RLS: the UUID is not a secret, the mask only keeps
  -- this response from confirming which contact a number belongs to.)
  if v_contact is not null and not private.contact_read_access(p_org_id, v_contact) then
    if exists (
         select 1 from public.contacts k
         where k.id = v_contact and k.user_id = v_uid and k.import_list = 'Manual close'
           and exists (select 1 from public.contact_closes mine where mine.contact_id = k.id and mine.closed_by = v_uid))
    then
      null; -- created here by this caller
    elsif exists (
      select 1 from public.inbound_calls ic
      where ic.org_id = p_org_id and ic.from_e164 = v_phone and ic.created_at > now() - interval '7 days'
    ) then
      v_hide := true;
    else
      raise exception 'This number belongs to a contact you don''t have access to. Ask your manager to log the close.'
        using errcode = '42501';
    end if;
  end if;

  if v_contact is null then
    -- TASK-H28: an empty form is fine (the dialed number is the anchor); a too-long name is refused before a contact is created
    if char_length(v_owner) > 120 or char_length(v_business) > 200 then
      raise exception 'name is too long' using errcode = '22023';
    end if;
    if v_phone ~ '^\+1[0-9]{10}$' then
      select t.timezone into v_tz from private.area_code_timezones t where t.area_code = substring(v_phone from 3 for 3);
    end if;
    select btrim(s) into v_city from unnest(coalesce(p_cities, '{}')) s where btrim(s) <> '' limit 1;
    insert into public.contacts (user_id, org_id, business_name, owner_contact, phone_number, phone_raw, timezone, city, import_list)
    values (v_uid, p_org_id, nullif(v_business, ''), nullif(v_owner, ''), v_phone, btrim(p_phone), v_tz, v_city, 'Manual close')
    returning id into v_contact;
    v_created := true;
  end if;

  return query
    select r.close_id, r.deduped, r.delivery_status, case when v_hide then null::uuid else v_contact end, v_created
    from private.log_contact_close_core(
      v_uid, p_org_id, v_contact, p_owner_name, p_business_name, p_mobile, p_email, p_services, p_cities,
      p_frequencies, p_insured, p_best_contact, p_starting_price, p_capacity, p_years_in_business) r;
end;
$$;

revoke all on function public.log_contact_close_by_phone(uuid, text, text, text, text, text, text[], text[], text[], boolean, text, numeric, integer, integer) from public, anon;
grant execute on function public.log_contact_close_by_phone(uuid, text, text, text, text, text, text[], text[], text[], boolean, text, numeric, integer, integer) to authenticated;

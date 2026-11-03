-- TASK-H24 security review follow-up #2 (new migration; earlier H24 migrations may be applied): (1) the "caller already closed
-- it" exemption let a close earned through the 7-day inbound proof grant permanent access: now only the contact this caller
-- CREATED through this flow (import_list 'Manual close', user_id = caller, with a close of theirs) is exempt; (2) contact_id
-- is NULL for any caller without read access unless they created the contact, whichever path let them through. Same
-- signature and grants.
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
    -- same readable messages the core would give, raised before a contact is created for a form that cannot succeed
    if v_owner = '' then raise exception 'owner name is required' using errcode = '22023'; end if;
    if v_business = '' then raise exception 'business name is required' using errcode = '22023'; end if;
    if char_length(v_owner) > 120 or char_length(v_business) > 200 then
      raise exception 'name is too long' using errcode = '22023';
    end if;
    if v_phone ~ '^\+1[0-9]{10}$' then
      select t.timezone into v_tz from private.area_code_timezones t where t.area_code = substring(v_phone from 3 for 3);
    end if;
    select btrim(s) into v_city from unnest(coalesce(p_cities, '{}')) s where btrim(s) <> '' limit 1;
    insert into public.contacts (user_id, org_id, business_name, owner_contact, phone_number, phone_raw, timezone, city, import_list)
    values (v_uid, p_org_id, v_business, v_owner, v_phone, btrim(p_phone), v_tz, v_city, 'Manual close')
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

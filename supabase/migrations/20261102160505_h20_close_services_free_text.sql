-- TASK-H20: log_contact_close accepts free-text services (org with no categories, or an "Other" entry); max 10 services, 60 chars each.
-- Same signature as 20261027133819, so grants carry over.
create or replace function public.log_contact_close(
  p_contact_id uuid,
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
returns table (close_id uuid, deduped boolean, delivery_status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_org uuid;
  v_id uuid;
  v_status text;
  v_digits text;
  v_mobile text;
  v_services text[];
  v_cities text[];
  v_freqs text[];
  v_hook boolean;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  select c.org_id into v_org from public.contacts c where c.id = p_contact_id;
  if v_org is null then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;
  -- TASK-H05: explicit role gate inside the RPC (it is granted to `authenticated`, so the Edge Function's check is not the only door).
  -- Everyone who can dial may log a close: owner, admin, manager, agent. Non-members and any other role are refused.
  if not private.has_org_role(v_org, array['owner', 'admin', 'manager', 'agent']) then
    raise exception 'not allowed to log a close in this organization' using errcode = '42501';
  end if;
  if not private.contact_read_access(v_org, p_contact_id) then
    raise exception 'no access to this contact' using errcode = '42501';
  end if;

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
  p_owner_name := btrim(coalesce(p_owner_name, ''));
  p_business_name := btrim(coalesce(p_business_name, ''));
  p_email := nullif(btrim(coalesce(p_email, '')), '');
  p_best_contact := nullif(btrim(coalesce(p_best_contact, '')), '');
  if p_owner_name = '' then raise exception 'owner name is required' using errcode = '22023'; end if;
  if p_business_name = '' then raise exception 'business name is required' using errcode = '22023'; end if;
  if char_length(p_owner_name) > 120 or char_length(p_business_name) > 200 then
    raise exception 'name is too long' using errcode = '22023';
  end if;
  if p_email is not null and p_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'email is not valid' using errcode = '22023';
  end if;

  v_digits := regexp_replace(coalesce(p_mobile, ''), '[^0-9]', '', 'g');
  if length(v_digits) = 10 then
    v_mobile := '+1' || v_digits;
  elsif length(v_digits) between 11 and 15 then
    v_mobile := '+' || v_digits;
  else
    raise exception 'mobile number is not valid' using errcode = '22023';
  end if;

  select array_agg(distinct btrim(s)) into v_services from unnest(coalesce(p_services, '{}')) s where btrim(s) <> '';
  select array_agg(distinct btrim(s)) into v_cities from unnest(coalesce(p_cities, '{}')) s where btrim(s) <> '';
  select array_agg(distinct lower(btrim(s))) into v_freqs from unnest(coalesce(p_frequencies, '{}')) s where btrim(s) <> '';
  if v_services is null then raise exception 'pick at least one service' using errcode = '22023'; end if;
  if v_cities is null then raise exception 'add at least one city' using errcode = '22023'; end if;
  if v_freqs is null then raise exception 'pick at least one frequency' using errcode = '22023'; end if;
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
  if p_insured is null then raise exception 'insured is required' using errcode = '22023'; end if;
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

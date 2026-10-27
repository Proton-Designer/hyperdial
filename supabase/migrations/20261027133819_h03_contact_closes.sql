-- TASK-H03: "Log Close" -- an intern closes a provider, fills a short form, the close is stored, the contact becomes
-- 'Closed', and the form is delivered to the org's closes webhook (Google Apps Script Sheet / GHL inbound webhook).
--
--   org_close_settings   per-org service-category list (owner/admin edit via close-webhook-settings; members read)
--   org_close_webhook    per-org webhook url + secret + enabled (service-only, like ghl_webhook_state)
--   contact_closes       one row per close; INSERT only through log_contact_close (no client write grant)
--   log_contact_close    definer RPC: validate, insert, set contact_status='Closed', enqueue the GHL 'closed' tag
--   claim_contact_closes service-only claim (skip locked + lease) for the delivery worker / immediate attempt
--   enforce_agent_contact_update_scope  body of 20261019210936 verbatim + ONE clause (marked TASK-H03): an agent may set
--     contact_status to 'Closed' (and nothing else but dnc/updated_at) only when a contact_closes row exists for that
--     contact, written by this caller in this same transaction (created_at = now()).

-- ---- 1. settings ------------------------------------------------------------------------------------------------
create table public.org_close_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  service_categories text[] not null default '{}'
    check (cardinality(service_categories) <= 50),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.org_close_settings enable row level security;
revoke all on table public.org_close_settings from public, anon, authenticated;
grant select on table public.org_close_settings to authenticated;
create policy "org members can read close settings"
  on public.org_close_settings for select to authenticated
  using (private.is_org_member(org_id));

create table public.org_close_webhook (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  url text,
  secret text,
  enabled boolean not null default false,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
alter table public.org_close_webhook enable row level security;
-- No client policy and no grant: only the service-role Edge Functions read or write it (the secret is in here).
revoke all on table public.org_close_webhook from public, anon, authenticated;

-- ---- 2. contact_closes ------------------------------------------------------------------------------------------
create table public.contact_closes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  closed_by uuid not null references auth.users(id) on delete cascade,
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
  created_at timestamptz not null default now(),
  -- delivery to the org's webhook
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sent', 'failed', 'not_configured')),
  delivery_attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz,
  claimed_at timestamptz,
  delivered_at timestamptz
);

create index contact_closes_contact_idx on public.contact_closes (contact_id, created_at desc);
create index contact_closes_org_created_idx on public.contact_closes (org_id, created_at desc);
create index contact_closes_due_idx on public.contact_closes (next_attempt_at) where delivery_status = 'pending';

alter table public.contact_closes enable row level security;
revoke all on table public.contact_closes from public, anon, authenticated;
grant select on table public.contact_closes to authenticated;

create policy "agents read their own closes, owner/admin read all"
  on public.contact_closes for select to authenticated
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (closed_by = auth.uid() and private.is_org_member(org_id))
  );

-- ---- 3. log_contact_close ---------------------------------------------------------------------------------------
create function public.log_contact_close(
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
  v_categories text[];
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
  if cardinality(v_services) > 20 or cardinality(v_cities) > 30 then
    raise exception 'too many services or cities' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_services) s where char_length(s) > 80)
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

  -- services must come from the org's list once an admin has defined one
  select s.service_categories into v_categories from public.org_close_settings s where s.org_id = v_org;
  if coalesce(cardinality(v_categories), 0) > 0 and not (v_services <@ v_categories) then
    raise exception 'unknown service category' using errcode = '22023';
  end if;

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
revoke all on function public.log_contact_close(uuid, text, text, text, text, text[], text[], text[], boolean, text, numeric, integer, integer) from public, anon;
grant execute on function public.log_contact_close(uuid, text, text, text, text, text[], text[], text[], boolean, text, numeric, integer, integer) to authenticated;

-- ---- 4. trigger_failures + GHL job kind ------------------------------------------------------------------------
-- widen trigger_failures.source for the tag-enqueue failure log (constraint name set by 20261019200613)
alter table public.trigger_failures drop constraint trigger_failures_source_check;
alter table public.trigger_failures add constraint trigger_failures_source_check
  check (source in (
    'disposition_quality_checks', 'round_robin_distribution', 'shared_inbox', 'ghl_dnc_push', 'contact_close_tag'
  ));

alter table public.crm_sync_jobs drop constraint crm_sync_jobs_kind_check;
alter table public.crm_sync_jobs add constraint crm_sync_jobs_kind_check
  check (kind in (
    'disposition', 'contact_upsert', 'nurture_tag', 'voicemail_tag', 'no_answer_tag',
    'inbound_call_note', 'transfer_note', 'dnc_flag', 'objection_field', 'close_tag'
  ));

-- ---- 5. delivery claim (service-only) --------------------------------------------------------------------------
create function public.claim_contact_closes(p_limit integer, p_close_id uuid default null)
returns setof public.contact_closes
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select cc.id from public.contact_closes cc
    where cc.delivery_status = 'pending'
      and cc.next_attempt_at <= now()
      and (cc.claimed_at is null or cc.claimed_at < now() - interval '3 minutes')
      and (p_close_id is null or cc.id = p_close_id)
    order by cc.next_attempt_at
    limit greatest(least(coalesce(p_limit, 20), 50), 1)
    for update skip locked
  ),
  upd as (
    update public.contact_closes cc
    set claimed_at = now(), delivery_attempts = cc.delivery_attempts + 1
    from due where cc.id = due.id
    returning cc.*
  )
  select * from upd;
end;
$$;
revoke all on function public.claim_contact_closes(integer, uuid) from public, anon, authenticated;
grant execute on function public.claim_contact_closes(integer, uuid) to service_role;

-- ---- 6. contacts agent-update trigger: body of 20261019210936 + the TASK-H03 clause -----------------------------
create or replace function private.enforce_agent_contact_update_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;

  if private.has_org_role(new.org_id, array['owner', 'admin']) then
    return new;
  end if;

  -- TASK-G31: an agent may mark a contact do-not-call but never clear it.
  if old.dnc is true and new.dnc is not true then
    raise exception 'only an owner or admin can clear do-not-call' using errcode = '42501';
  end if;

  -- TASK-H03: contact_status -> 'Closed' is allowed only for the agent who just logged a close for this contact in
  -- this same transaction (log_contact_close inserted the row; contact_closes has no client INSERT grant, so the
  -- row cannot be forged). Everything else on the row must still be unchanged.
  if new.contact_status is distinct from old.contact_status
     and new.contact_status = 'Closed'
     and exists (
       select 1 from public.contact_closes cc
       where cc.contact_id = new.id and cc.closed_by = auth.uid() and cc.created_at = now()
     )
     and (to_jsonb(new) - 'dnc' - 'updated_at' - 'contact_status')
         is not distinct from (to_jsonb(old) - 'dnc' - 'updated_at' - 'contact_status') then
    return new;
  end if;

  -- Anyone else matching the row (an assigned agent, per the existing UPDATE policy) may
  -- only change dnc.
  if (to_jsonb(new) - 'dnc' - 'updated_at') is distinct from (to_jsonb(old) - 'dnc' - 'updated_at') then
    raise exception 'agents may only change the dnc flag on a contact' using errcode = '42501';
  end if;

  return new;
end;
$$;

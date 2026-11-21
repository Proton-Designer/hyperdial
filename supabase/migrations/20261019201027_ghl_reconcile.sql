-- TASK-G08 (spec section 4, priority b): GHL -> HyperDial reconcile. A 5-minute sweep reads GHL state for
-- QUEUED/CALLBACK campaign leads whose contact is linked to GHL and takes them off call lists when GHL says
--   * DNC  : contact dnd = true, or dndSettings.Call active/permanent, or a tag in ghl_dnc_tags  -> contacts.dnc,
--            dnc_numbers row (source 'import'), campaign_leads 'dnc'
--   * done : signed up / active conversation = a tag in ghl_exclude_tags (NEW) or an opportunity in a stage listed
--            in ghl_exclude_stage_ids (NEW)                                                    -> campaign_leads 'completed'
--   * paused: a tag in ghl_paused_tags                                                        -> campaign_leads 'paused'
-- Everything is OFF by default (ghl_reconcile_enabled = false, empty exclude lists). Work per tick is bounded by
-- claim_ghl_reconcile_batch (oldest-checked first, a per-contact lease stamp), so a long list is covered over several
-- ticks and a crashed tick loses nothing. Removal only touches queued/callback leads, never an in-flight call.
-- GHL-origin DNC is written with a transaction-local flag (hyperdial.ghl_origin) that the G05 dnc push triggers honor,
-- so nothing is echoed back to GHL.

-- ---- settings + bookkeeping -------------------------------------------------------------------
alter table public.org_integrations
  add column ghl_reconcile_enabled boolean not null default false,
  add column ghl_exclude_tags text[] not null default '{}',
  add column ghl_exclude_stage_ids text[] not null default '{}',
  add column ghl_last_reconcile_at timestamptz,
  add column ghl_last_reconcile_counts jsonb;

alter table public.contacts add column ghl_reconciled_at timestamptz;
create index idx_contacts_ghl_reconcile
  on public.contacts (org_id, ghl_reconciled_at nulls first)
  where ghl_contact_id is not null;

-- service-role only (same pattern as set_org_ghl_pull_settings); no client path reads/writes these directly
create function public.set_org_ghl_reconcile_settings(
  p_org uuid, p_enabled boolean, p_exclude_tags text[], p_exclude_stage_ids text[]
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.org_integrations
  set ghl_reconcile_enabled = p_enabled,
      ghl_exclude_tags = coalesce(p_exclude_tags, '{}'),
      ghl_exclude_stage_ids = coalesce(p_exclude_stage_ids, '{}'),
      updated_at = now()
  where org_id = p_org and provider = 'ghl';
  if not found then
    raise exception 'org % has no GHL integration to configure', p_org;
  end if;
end;
$$;

revoke all on function public.set_org_ghl_reconcile_settings(uuid, boolean, text[], text[]) from public, anon, authenticated;
grant execute on function public.set_org_ghl_reconcile_settings(uuid, boolean, text[], text[]) to service_role;

create function public.record_ghl_reconcile_result(p_org uuid, p_counts jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.org_integrations
  set ghl_last_reconcile_at = now(), ghl_last_reconcile_counts = p_counts, updated_at = now()
  where org_id = p_org and provider = 'ghl';
end;
$$;

revoke all on function public.record_ghl_reconcile_result(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_ghl_reconcile_result(uuid, jsonb) to service_role;

-- ---- claim a bounded, oldest-checked-first batch ------------------------------------------------
create function public.claim_ghl_reconcile_batch(p_org uuid, p_limit int)
returns table (contact_id uuid, ghl_contact_id text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select c.id
    from public.contacts c
    where c.org_id = p_org
      and c.ghl_contact_id is not null
      and c.dnc is not true
      and exists (
        select 1 from public.campaign_leads cl
        where cl.contact_id = c.id and cl.org_id = p_org and cl.status in ('queued', 'callback'))
    order by c.ghl_reconciled_at asc nulls first, c.id
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    for update of c skip locked
  ), upd as (
    update public.contacts c
    set ghl_reconciled_at = now()
    from picked
    where c.id = picked.id
    returning c.id, c.ghl_contact_id
  )
  select upd.id, upd.ghl_contact_id from upd;
end;
$$;

revoke all on function public.claim_ghl_reconcile_batch(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_ghl_reconcile_batch(uuid, int) to service_role;

-- ---- apply decisions atomically -----------------------------------------------------------------
-- p_items: [{contact_id, action: 'dnc'|'exclude'|'paused', reason}] -> counts jsonb
create function public.apply_ghl_reconcile(p_org uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_n int;
  v_dnc int := 0;
  v_excluded int := 0;
  v_paused int := 0;
  v_leads int := 0;
begin
  -- GHL is the origin of these changes: tell the G05 dnc push triggers not to echo them back
  perform set_config('hyperdial.ghl_origin', 'on', true);

  for v in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(contact_id uuid, action text, reason text)
  loop
    if v.action = 'dnc' then
      update public.contacts set dnc = true, updated_at = now()
      where id = v.contact_id and org_id = p_org and dnc is not true;
      get diagnostics v_n = row_count;
      v_dnc := v_dnc + v_n;
      insert into public.dnc_numbers (org_id, e164, source, note)
      select p_org, c.phone_number, 'import', left('GHL reconcile: ' || coalesce(v.reason, 'dnd'), 200)
      from public.contacts c
      where c.id = v.contact_id and c.org_id = p_org and c.phone_number is not null
      on conflict (org_id, e164) do nothing;
      update public.campaign_leads set status = 'dnc', updated_at = now()
      where org_id = p_org and contact_id = v.contact_id and status in ('queued', 'callback');
      get diagnostics v_n = row_count;
      v_leads := v_leads + v_n;
    elsif v.action = 'exclude' then
      update public.campaign_leads set status = 'completed', updated_at = now()
      where org_id = p_org and contact_id = v.contact_id and status in ('queued', 'callback');
      get diagnostics v_n = row_count;
      v_excluded := v_excluded + v_n;
      v_leads := v_leads + v_n;
    elsif v.action = 'paused' then
      update public.campaign_leads set status = 'paused', updated_at = now()
      where org_id = p_org and contact_id = v.contact_id and status in ('queued', 'callback');
      get diagnostics v_n = row_count;
      v_paused := v_paused + v_n;
      v_leads := v_leads + v_n;
    end if;
  end loop;

  perform set_config('hyperdial.ghl_origin', 'off', true);
  return jsonb_build_object('dnc_contacts', v_dnc, 'excluded_leads', v_excluded, 'paused_leads', v_paused, 'leads_moved', v_leads);
end;
$$;

revoke all on function public.apply_ghl_reconcile(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_ghl_reconcile(uuid, jsonb) to service_role;

-- ---- G05 dnc push triggers: skip GHL-origin changes (replaces 20261019200613 bodies, same signatures) ----
create or replace function private.contacts_dnc_push_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('hyperdial.ghl_origin', true), '') = 'on' then
    return new;
  end if;
  if new.dnc is true and new.ghl_contact_id is not null
     and (tg_op = 'INSERT' or old.dnc is distinct from true) then
    perform private.enqueue_dnc_flag(new.org_id, new.id, 'contacts.dnc');
  end if;
  return new;
exception when others then
  raise warning 'contacts_dnc_push_trigger failed for contact %: %', new.id, sqlerrm;
  perform private.log_trigger_failure(new.org_id, 'ghl_dnc_push', new.id, sqlstate || ': ' || sqlerrm);
  return new;
end;
$$;

create or replace function private.dnc_numbers_push_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact uuid;
begin
  if coalesce(current_setting('hyperdial.ghl_origin', true), '') = 'on' then
    return new;
  end if;
  for v_contact in
    select c.id from public.contacts c
    where c.org_id = new.org_id and c.phone_number = new.e164 and c.ghl_contact_id is not null
  loop
    perform private.enqueue_dnc_flag(new.org_id, v_contact, 'dnc_numbers.' || new.source);
  end loop;
  return new;
exception when others then
  raise warning 'dnc_numbers_push_trigger failed for dnc_numbers %: %', new.id, sqlerrm;
  perform private.log_trigger_failure(new.org_id, 'ghl_dnc_push', new.id, sqlstate || ': ' || sqlerrm);
  return new;
end;
$$;

-- ---- cron worker config + trigger (same shape as ghl-pull-worker, its OWN secret/url) -------------------
create table private.ghl_reconcile_worker_config (
  id boolean primary key default true,
  url text,
  secret_secret_id uuid,
  constraint ghl_reconcile_worker_config_singleton check (id)
);

create function private.set_ghl_reconcile_worker_config(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select secret_secret_id into v_existing_secret_id from private.ghl_reconcile_worker_config where id = true;
  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret);
  end if;
  insert into private.ghl_reconcile_worker_config (id, url, secret_secret_id)
  values (true, p_url, v_secret_id)
  on conflict (id) do update set url = excluded.url, secret_secret_id = excluded.secret_secret_id;
end;
$$;

revoke all on function private.set_ghl_reconcile_worker_config(text, text) from public;
grant execute on function private.set_ghl_reconcile_worker_config(text, text) to service_role, postgres;

create function private.trigger_ghl_reconcile_worker()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret_id uuid;
  v_secret text;
begin
  select url, secret_secret_id into v_url, v_secret_id from private.ghl_reconcile_worker_config where id = true;
  if v_url is null or v_secret_id is null then
    return; -- not configured yet: no-op, not an error every tick
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    return;
  end if;
  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
    timeout_milliseconds := 25000
  );
end;
$$;

-- offset 2 minutes from ghl-pull-worker (*/5) so the two do not start together
select cron.schedule('ghl-reconcile-worker', '2-59/5 * * * *', $$select private.trigger_ghl_reconcile_worker();$$);
revoke all on function private.trigger_ghl_reconcile_worker() from public;

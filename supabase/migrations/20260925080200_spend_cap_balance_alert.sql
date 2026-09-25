-- TASK-SP (SEC-2 + the balance part of SEC-7): monthly spend cap + low-balance alert.
--
-- MTD spend has no cheap, reliable, non-BETA Telnyx API (verified against spec3.json,
-- 2026-09-25 -- see decisions.md's TASK-SP entry and _shared/spend-estimate.ts's own header for
-- the full citation and the rejected alternatives). Only the real-time balance
-- (`GET /balance`, stable/non-BETA) is a live Telnyx call; MTD spend is estimated from our own
-- call_legs + user_phone_numbers data, clearly labelled "estimated" everywhere it's shown.

-- =================================================================================================
-- 1. org_spend_settings: same "member read, owner/admin write, seed-on-org-create + one-time
--    backfill" shape as org_number_pool_settings (20260925070000). `last_low_balance_alert_at`
--    lives here too (one row per org anyway) rather than a separate dedupe table -- the alert
--    cron's own dedupe rule (at most once per 12h) reads and writes this same row.
-- =================================================================================================

create table public.org_spend_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  -- null = no cap, never blocks regardless of spend (spend-estimate.ts's isOverSpendCap).
  monthly_spend_cap_usd numeric(10,2) check (monthly_spend_cap_usd is null or monthly_spend_cap_usd > 0),
  low_balance_alert_usd numeric(10,2) not null default 20 check (low_balance_alert_usd >= 0),
  min_balance_to_dial_usd numeric(10,2) not null default 5 check (min_balance_to_dial_usd >= 0),
  -- Estimate-only knobs (task's own "a configurable per-minute rate" + "the monthly number
  -- price") -- defaults are a reasonable US outbound PSTN ballpark, not a Telnyx-quoted number;
  -- an org that wants a closer estimate tunes these in Settings -> Telephony.
  estimated_per_minute_rate_usd numeric(10,4) not null default 0.0150 check (estimated_per_minute_rate_usd >= 0),
  estimated_monthly_number_price_usd numeric(10,2) not null default 1.15 check (estimated_monthly_number_price_usd >= 0),
  last_low_balance_alert_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.org_spend_settings enable row level security;

create policy "org members can view spend settings"
  on public.org_spend_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert spend settings"
  on public.org_spend_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update spend settings"
  on public.org_spend_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create function private.seed_default_spend_settings(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.org_spend_settings (org_id)
  values (p_org)
  on conflict (org_id) do nothing;
$$;

create function private.seed_default_spend_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_spend_settings(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_spend_settings
  after insert on public.orgs
  for each row execute function private.seed_default_spend_settings_trigger();

do $$
declare
  v_org record;
begin
  for v_org in select id from public.orgs loop
    perform private.seed_default_spend_settings(v_org.id);
  end loop;
end;
$$;

-- =================================================================================================
-- 2. pg_cron + pg_net: spend-alert-check, hourly off the :00 mark. Same shared-secret shape as
--    recording-retention/ghl-sync-worker/dialer-sweeper (20260925040000/20260924002000/
--    20260924001700): a Vault-stored secret checked via X-Cron-Secret, a silent no-op until
--    private.set_spend_alert_config(url, secret) is called live (never errors on a fresh
--    install/before the lead wires it up).
-- =================================================================================================

create table private.spend_alert_config (
  id boolean primary key default true,
  url text,
  secret_secret_id uuid,
  constraint spend_alert_config_singleton check (id)
);

create function private.set_spend_alert_config(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select secret_secret_id into v_existing_secret_id from private.spend_alert_config where id = true;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret);
  end if;

  insert into private.spend_alert_config (id, url, secret_secret_id)
  values (true, p_url, v_secret_id)
  on conflict (id) do update set url = excluded.url, secret_secret_id = excluded.secret_secret_id;
end;
$$;

revoke all on function private.set_spend_alert_config(text, text) from public;
grant execute on function private.set_spend_alert_config(text, text) to service_role, postgres;

create function private.trigger_spend_alert_check()
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
  select url, secret_secret_id into v_url, v_secret_id from private.spend_alert_config where id = true;

  if v_url is null or v_secret_id is null then
    return; -- not configured yet -- no-op, not an error every tick.
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

-- Explicit, not assumed already enabled (same lesson call_recording's own header cites).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

-- Hourly, off the :00 mark (task's own requirement, so it doesn't collide with every other
-- on-the-hour job) -- :23.
select cron.schedule('spend-alert-check', '23 * * * *', $$select private.trigger_spend_alert_check();$$);

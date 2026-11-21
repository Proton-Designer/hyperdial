-- TASK-S05: pg_cron + pg_net schedules for the Shifts jobs. Same shape as the existing cron migrations
-- (ghl-sync-worker, ghl-pull-worker, campaign-lines-guard-check): an X-Cron-Secret header, no-op until the
-- worker config exists, `cron.schedule(name, ...)` is upsert-by-name.
--
-- No new secret and no new config table: the jobs reuse the ghl-sync-worker config
-- (private.crm_sync_worker_config: its URL ".../functions/v1/ghl-sync-worker" gives the functions base, its Vault
-- secret is CRM_SYNC_WORKER_SECRET, which the shift functions accept as X-Cron-Secret). If that worker is
-- configured, these jobs work the moment the functions are deployed; if not, every tick is a harmless no-op.
--
-- Jobs (pg_cron runs in UTC; the functions/SQL check the org's local time themselves):
--   shift-ghl-sync      every minute   drain shift_ghl_outbox
--   shift-kpi-compute   every 15 min   per-shift KPIs, finalize shifts that ended > 2 h ago
--   shifts-week-lock    hourly :05     acts once per org per week after the pick deadline
--   shifts-week-close   hourly :35     acts once per org per week after Monday 00:30 local
--   shift-outbox-prune  daily 03:40 UTC  drop finished outbox rows older than 14 days

create function private.trigger_shift_job(p_fn text)
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
  select url, secret_secret_id into v_url, v_secret_id from private.crm_sync_worker_config where id = true;
  if v_url is null or v_secret_id is null then
    return; -- not configured yet: no-op, not an error every tick.
  end if;
  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    return;
  end if;
  perform net.http_post(
    url := regexp_replace(v_url, '/[^/]*$', '') || '/' || p_fn,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
    timeout_milliseconds := 25000
  );
end;
$$;

create function private.prune_shift_outbox()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  delete from public.shift_ghl_outbox where status = 'done' and created_at < now() - interval '14 days';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function private.trigger_shift_job(text), private.prune_shift_outbox() from public;
grant execute on function private.trigger_shift_job(text), private.prune_shift_outbox() to service_role, postgres;

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('shift-ghl-sync', '* * * * *', $$select private.trigger_shift_job('shift-ghl-sync');$$);
select cron.schedule('shift-kpi-compute', '*/15 * * * *', $$select private.trigger_shift_job('shift-kpi-compute');$$);
select cron.schedule('shifts-week-lock', '5 * * * *', $$select private.trigger_shift_job('shifts-week-lock');$$);
select cron.schedule('shifts-week-close', '35 * * * *', $$select private.trigger_shift_job('shifts-week-close');$$);
select cron.schedule('shift-outbox-prune', '40 3 * * *', $$select private.prune_shift_outbox();$$);

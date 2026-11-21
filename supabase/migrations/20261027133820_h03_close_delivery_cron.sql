-- TASK-H03: retry sweep for contact_closes deliveries. The immediate attempt happens in log-contact-close; this
-- cron (every 5 min) only picks up rows whose retry came due. Same shape as ghl-reconcile-worker: own secret
-- (CLOSE_DELIVERY_WORKER_SECRET) + own url in a private config table, no-op until configured (lead step).
create table private.close_delivery_worker_config (
  id boolean primary key default true,
  url text,
  secret_secret_id uuid,
  constraint close_delivery_worker_config_singleton check (id)
);

create function private.set_close_delivery_worker_config(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select secret_secret_id into v_existing_secret_id from private.close_delivery_worker_config where id = true;
  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret);
  end if;
  insert into private.close_delivery_worker_config (id, url, secret_secret_id)
  values (true, p_url, v_secret_id)
  on conflict (id) do update set url = excluded.url, secret_secret_id = excluded.secret_secret_id;
end;
$$;
revoke all on function private.set_close_delivery_worker_config(text, text) from public;
grant execute on function private.set_close_delivery_worker_config(text, text) to service_role, postgres;

create function private.trigger_close_delivery_worker()
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
  select url, secret_secret_id into v_url, v_secret_id from private.close_delivery_worker_config where id = true;
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
revoke all on function private.trigger_close_delivery_worker() from public;

select cron.schedule('close-delivery-worker', '4-59/5 * * * *', $$select private.trigger_close_delivery_worker();$$);

-- GHL push outbox worker (design §6, TASK-P3-P3): claim/complete/fail RPCs for
-- crm_sync_jobs (20260924000900), a progress column for idempotent per-step retry, and the
-- pg_cron + pg_net scaffolding that pings ghl-sync-worker on a timer. This is the FIRST
-- pg_cron/pg_net usage in this repo -- no prior sweeper/cron task had landed yet (TASK-P2-E5
-- was still unclaimed as of this migration). Naming convention established here for any future
-- cron job in this codebase: cron.schedule('<domain>-<purpose>', ...) -- this one is
-- 'ghl-sync-worker', matching its Edge Function's own name.

-- progress -----------------------------------------------------------------------------------
-- Tracks which of a disposition job's steps (upsert/note/tag/task/dnd) already succeeded, so a
-- retry after a partial failure (e.g. the tag step 500s after the note already posted) never
-- redoes a completed step. Keys are the worker's own choice (_shared/ghl-sync-worker.ts), not
-- enforced here -- this column is opaque storage, same spirit as crm_sync_jobs.payload.

alter table public.crm_sync_jobs add column progress jsonb not null default '{}'::jsonb;

-- claim / complete / fail RPCs -----------------------------------------------------------------
-- Same FOR UPDATE SKIP LOCKED shape as claim_next_leads (20260924000800): several concurrent
-- worker invocations (overlapping cron ticks, or a manual + a scheduled run) never claim the
-- same job twice. Empirically verified with two real concurrent psql sessions, not just read
-- from the SQL -- see supabase/tests/crm_sync_jobs_concurrency.sh.

create function public.claim_crm_sync_jobs(p_n int)
returns setof public.crm_sync_jobs
language sql
security definer
set search_path = ''
as $$
  update public.crm_sync_jobs
  set status = 'running', updated_at = now()
  where id in (
    select id from public.crm_sync_jobs
    where status = 'queued' and next_run_at <= now()
    order by next_run_at asc
    limit p_n
    for update skip locked
  )
  returning *;
$$;

create function public.complete_crm_sync_job(p_job uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.crm_sync_jobs
  set status = 'done', updated_at = now(), last_error = null
  where id = p_job;
$$;

-- Exponential backoff, capped: 1, 2, 4, 8, 16, 32, 60, 60 minutes for attempts 1-8 (least(2^n,
-- 60) minutes) -- the task spec names no exact schedule, only "exponential backoff; dead after
-- 8 attempts." `dead` preserves last_error and progress so far for a human to inspect; nothing
-- auto-retries a dead job.

create function public.fail_crm_sync_job(p_job uuid, p_error text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts int;
begin
  update public.crm_sync_jobs
  set attempts = attempts + 1
  where id = p_job
  returning attempts into v_attempts;

  if v_attempts is null then
    return;
  end if;

  if v_attempts >= 8 then
    update public.crm_sync_jobs
    set status = 'dead', last_error = p_error, updated_at = now()
    where id = p_job;
  else
    update public.crm_sync_jobs
    set status = 'queued',
        last_error = p_error,
        next_run_at = now() + (least(power(2, v_attempts), 60) || ' minutes')::interval,
        updated_at = now()
    where id = p_job;
  end if;
end;
$$;

create function public.update_crm_sync_job_progress(p_job uuid, p_progress jsonb)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.crm_sync_jobs
  set progress = progress || p_progress, updated_at = now()
  where id = p_job;
$$;

revoke all on function public.claim_crm_sync_jobs(int) from public, anon, authenticated;
revoke all on function public.complete_crm_sync_job(uuid) from public, anon, authenticated;
revoke all on function public.fail_crm_sync_job(uuid, text) from public, anon, authenticated;
revoke all on function public.update_crm_sync_job_progress(uuid, jsonb) from public, anon, authenticated;

grant execute on function public.claim_crm_sync_jobs(int) to service_role;
grant execute on function public.complete_crm_sync_job(uuid) to service_role;
grant execute on function public.fail_crm_sync_job(uuid, text) to service_role;
grant execute on function public.update_crm_sync_job_progress(uuid, jsonb) to service_role;

-- sync-status view for Settings -> Integrations (last 20 jobs) -------------------------------
-- Reuses the existing "owner or admin can view crm_sync_jobs" RLS policy on the base table
-- (20260924000900) -- a plain view with security_invoker so that policy still applies per
-- caller, not a service-role bypass.

create view public.crm_sync_jobs_recent
  with (security_invoker = on)
  as
  select id, org_id, provider, kind, contact_id, status, attempts, last_error, created_at, updated_at
  from public.crm_sync_jobs
  order by updated_at desc;

grant select on public.crm_sync_jobs_recent to authenticated;

-- pg_cron + pg_net: ping ghl-sync-worker every 60s ---------------------------------------------
-- Global (not per-org) worker config -- URL + a shared secret the Edge Function checks via an
-- X-Cron-Secret header (task spec: "shared-secret header like eng2's sweeper", not a user JWT).
-- Stored in Vault, same shape as the per-org token helpers (set_org_ghl_token,
-- 20260924000900) -- deliberately NOT inserted by this migration (a migration shouldn't bake
-- in a local-dev-only Docker hostname, and this repo never touches the live project). Whoever
-- deploys/runs this locally calls private.set_crm_sync_worker_config(url, secret) once, and
-- sets the exact same secret as the ghl-sync-worker function's CRM_SYNC_WORKER_SECRET env var.
-- Until configured, trigger_ghl_sync_worker() no-ops (returns without calling net.http_post)
-- rather than erroring every single cron tick on a fresh install.

create table private.crm_sync_worker_config (
  id boolean primary key default true,
  url text,
  secret_secret_id uuid,
  constraint crm_sync_worker_config_singleton check (id)
);

create function private.set_crm_sync_worker_config(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select secret_secret_id into v_existing_secret_id from private.crm_sync_worker_config where id = true;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret);
  end if;

  insert into private.crm_sync_worker_config (id, url, secret_secret_id)
  values (true, p_url, v_secret_id)
  on conflict (id) do update set url = excluded.url, secret_secret_id = excluded.secret_secret_id;
end;
$$;

revoke all on function private.set_crm_sync_worker_config(text, text) from public;
grant execute on function private.set_crm_sync_worker_config(text, text) to service_role, postgres;

create function private.trigger_ghl_sync_worker()
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
    return; -- not configured yet (fresh install) -- no-op, not an error every tick.
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    return;
  end if;

  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
    timeout_milliseconds := 20000
  );
end;
$$;

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule('ghl-sync-worker', '* * * * *', $$select private.trigger_ghl_sync_worker();$$);

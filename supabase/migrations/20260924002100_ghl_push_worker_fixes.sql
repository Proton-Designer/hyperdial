-- Fix-forward for TASK-P3-P3, per the lead's review of 20260924002000 (applied):
-- (1) lease reclaim for a job stuck in 'running' after a worker crash/timeout,
-- (2) explicit pg_net extension creation (don't rely on it already being enabled).
-- config.toml's verify_jwt=false + the worker's constant-time secret comparison are code-side
-- fixes, not migration content -- see the accompanying commit.

-- pg_net may already be enabled locally (it is, as a dependency of something else in this
-- stack), but nothing in this repo has explicitly created it until now -- don't rely on a real
-- deployed project having it enabled already.
create extension if not exists pg_net with schema extensions;

-- Lease reclaim: a job stuck in 'running' for more than 10 minutes means the worker that
-- claimed it crashed, timed out, or its response was lost before it ever called
-- complete/fail -- it will otherwise never be retried (claim_crm_sync_jobs only ever selects
-- status='queued'). Reclaiming it counts as a failed attempt (same backoff/dead semantics as a
-- real failure via fail_crm_sync_job, inlined here since this needs to run as part of the same
-- claim call, not a separate RPC round-trip): back to 'queued' with the usual backoff, or
-- 'dead' if this reclaim would be attempt 8+, preserving next_run_at rather than clobbering it.

create or replace function public.claim_crm_sync_jobs(p_n int)
returns setof public.crm_sync_jobs
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.crm_sync_jobs
  set attempts = attempts + 1,
      status = case when attempts + 1 >= 8 then 'dead' else 'queued' end,
      last_error = 'worker lease expired (stuck in running for over 10 minutes)',
      next_run_at = case
        when attempts + 1 >= 8 then next_run_at
        else now() + (least(power(2, attempts + 1), 60) || ' minutes')::interval
      end,
      updated_at = now()
  where status = 'running' and updated_at < now() - interval '10 minutes';

  return query
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
end;
$$;

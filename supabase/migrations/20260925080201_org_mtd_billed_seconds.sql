-- TASK-SP fix-forward (lead review, HIGH): `getMonthToDateBilledSeconds` in
-- `_shared/spend-gate.ts` summed `call_legs.duration_seconds` client-side via a plain
-- `.select('duration_seconds')` -- PostgREST caps an unpaginated select at its `max-rows` config
-- (1000). A real team's month can produce far more than 1000 legs, so the sum silently
-- undercounts once that cap is hit and the monthly spend cap never actually fires for a busy org.
--
-- Fix: do the sum in SQL instead of in the edge function. Not a `private.*` function forwarded by
-- a `public.*` wrapper (the org_telephony precedent, 20260924000500) -- there's no existing
-- private helper to forward to, so this defines the aggregate directly in public, service-role
-- only, same as every other service-role-only public RPC in this task.
--
-- Append-only: 20260925080200 is not edited. Timestamp assigned by the lead.

create function public.org_mtd_billed_seconds(p_org uuid)
returns bigint
language sql
security definer
set search_path = ''
as $$
  select coalesce(sum(duration_seconds), 0)::bigint
  from public.call_legs
  where org_id = p_org
    and created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc');
$$;

revoke all on function public.org_mtd_billed_seconds(uuid) from public, anon, authenticated;
grant execute on function public.org_mtd_billed_seconds(uuid) to service_role;

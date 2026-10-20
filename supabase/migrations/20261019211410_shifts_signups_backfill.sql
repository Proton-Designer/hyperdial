-- TASK-G33 (G01 review SHOULD 1): sign-ups and conversion rate for shifts that were finalized BEFORE G01 (20261019195842).
-- shift_kpi_save skips final rows, so those shifts kept sign_ups = 0 and conversion_rate_pct = null forever, and the week
-- sign-up totals under-counted any week that straddled the deploy.
--
-- Recomputes both from the same data and the same window as shift_kpi_inputs / shift-kpi-core.ts:
--   sign_ups            = contact legs of the shift's user in [starts_at, ends_at) whose disposition is_win
--   conversion_rate_pct = round(100 * sign_ups / conversations, 1) using the STORED conversations count, only when > 0
--                         (not capped: like new rows it can exceed 100 when wins outnumber >=30 s conversations)
-- Touches only FINAL rows with sign_ups = 0 and conversion_rate_pct is null (a pre-G01 shape), so it is idempotent: a second
-- run finds nothing new, and a post-G01 row (already computed) is never overwritten. Rows whose recomputed value would
-- still be "0 sign-ups, no conversations" are left alone. Not pushed to GoHighLevel: past shifts are not re-sent.
-- The update lives in private.backfill_shift_signups() (returns the number of rows changed) so it can be tested and re-run;
-- the migration calls it once. Read-only preview: audit/G33/precount.sql.
create or replace function private.backfill_shift_signups()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows integer;
begin
  update public.shift_kpis k
  set sign_ups = w.n,
      conversion_rate_pct = case when k.conversations > 0 then round(100.0 * w.n / k.conversations, 1) end
  from (
    select k2.shift_id,
           (select count(*)::integer
            from public.call_legs cl
            join public.dial_sessions ds on ds.id = cl.session_id
            join public.dispositions d on d.id = cl.disposition_id
            where cl.org_id = s.org_id and ds.agent_id = s.user_id and cl.kind = 'contact'
              and cl.created_at >= s.starts_at and cl.created_at < s.ends_at
              and d.is_win) as n
    from public.shift_kpis k2
    join public.shifts s on s.id = k2.shift_id
    where k2.final and k2.sign_ups = 0 and k2.conversion_rate_pct is null
  ) w
  where k.shift_id = w.shift_id
    and k.final and k.sign_ups = 0 and k.conversion_rate_pct is null
    and (w.n > 0 or k.conversations > 0);
  get diagnostics v_rows = row_count;
  return v_rows;
end;
$$;

revoke all on function private.backfill_shift_signups() from public, anon, authenticated;
grant execute on function private.backfill_shift_signups() to service_role;

select private.backfill_shift_signups();

-- MISSION-5 TASK-M5-G7: eng1's own edge-cases-v2.md #3 -- G6's shared inbox only reopens a stale
-- claim "on read" (private.reopen_stale_inbox_claims(p_org), called at the top of every inbox
-- read/write RPC). An org where nobody opens the Inbox keeps a stale claim forever, and every
-- OTHER surface that reads inbox_items (a badge count, a future dashboard widget) shows it as
-- still claimed. This adds a pg_cron sweep that reopens stale claims across every org on a
-- schedule -- pure SQL, no Edge Function, per the lead's own design decision. It does not change
-- WHEN a claim is considered stale (each org's own `claim_stale_minutes`, same default when the
-- settings row is missing) -- only how promptly the reopen happens when nobody's looking.
--
-- =================================================================================================
-- 1. private.reopen_stale_inbox_claims_all() -- ALL orgs, ONE set-based UPDATE (no per-org loop:
--    the per-org staleness threshold is just a correlated subquery on org_shared_inbox_settings,
--    the exact same rule private.reopen_stale_inbox_claims(p_org) already applies per-org,
--    default 30 minutes when the settings row is missing). Returns the reopened-row count.
--    Revoked from public/anon/authenticated -- cron's own internal role runs this, no client
--    (human or service) ever calls it directly.
-- =================================================================================================

create function private.reopen_stale_inbox_claims_all()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  with reopened as (
    update public.inbox_items ii
    set status = 'open', claimed_by = null, claimed_at = null, updated_at = now()
    where ii.status = 'claimed'
      and ii.claimed_at < now() - make_interval(mins => coalesce(
        (select s.claim_stale_minutes from public.org_shared_inbox_settings s where s.org_id = ii.org_id),
        30
      ))
    returning ii.id
  )
  select count(*) into v_count from reopened;

  return v_count;
end;
$$;

revoke all on function private.reopen_stale_inbox_claims_all() from public, anon, authenticated;

-- G7 review SHOULD (eng2): the cross-org sweep has no org_id predicate, so give it its own index.
create index if not exists idx_inbox_items_claimed_at_claimed on public.inbox_items (claimed_at) where status = 'claimed';

-- =================================================================================================
-- 2. Schedule with pg_cron, every 5 minutes. `cron.schedule(job_name, ...)` is upsert-by-name --
--    pg_cron's own documented behavior for the named-job overload is "if a job with this
--    job_name already exists, it is updated," not duplicated -- so calling this again (a re-run
--    of this migration, or a future migration that reschedules the same name) can never create a
--    second 'inbox-stale-claims' row. Checked whether 20260924001700_dialer_sweeper_cron.sql (and
--    every other cron.schedule call in this repo: ghl-sync-worker, recording-retention,
--    campaign-lines-guard-check, spend-alert-check, number-health-check, ghl-pull-worker,
--    reliability-alert-check) unschedules first -- NONE of them do, for the same reason: it isn't
--    needed. No extra unschedule-then-reschedule guard added here either, to match the repo's
--    own established (and correct) convention rather than inventing a new one.
-- =================================================================================================

create extension if not exists pg_cron with schema pg_catalog;

select cron.schedule('inbox-stale-claims', '*/5 * * * *', $$select private.reopen_stale_inbox_claims_all()$$);

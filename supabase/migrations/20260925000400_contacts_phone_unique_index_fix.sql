-- TASK-L8 (L3 re-review nit): idx_contacts_org_phone_unique's WHERE clause only excluded a NULL
-- phone_number -- inconsistent with 20260925000100's own merge criteria, which deliberately only
-- merges/dedupes groups matching `phone_number ~ '^\+'` (real E.164 values), leaving junk/empty
-- values alone. Two contacts sharing a junk non-'+' phone_number in the same org (both, say,
-- 'N/A') were never a target of that merge, but this index still enforced uniqueness across them
-- -- a live insert of a second junk-phone contact could 23505 for a reason that has nothing to do
-- with a real duplicate phone number.
--
-- Safe to apply as a plain drop+recreate (no CONCURRENTLY): 20260925000100 already applied
-- successfully against live with the OLD, broader predicate, which means live had zero duplicate
-- groups under that broader condition at apply time -- so live necessarily also has zero
-- duplicate groups under this NEW, narrower predicate (a strict subset of rows). Narrowing an
-- already-satisfied unique constraint can never introduce a new violation.
--
-- No explicit begin/commit -- see 20260925000100's header for why.

drop index if exists public.idx_contacts_org_phone_unique;

create unique index if not exists idx_contacts_org_phone_unique
  on public.contacts (org_id, phone_number)
  where phone_number is not null and phone_number ~ '^\+';

-- Copy-paste verification queries for the lead's live dry-run (not executed by this file):
--   select indexname, indexdef from pg_indexes where tablename='contacts' and indexname='idx_contacts_org_phone_unique';  -- indexdef must include the `phone_number ~ '^\+'::text` predicate
--   select org_id, phone_number, count(*) from public.contacts where phone_number is not null and phone_number ~ '^\+' group by 1,2 having count(*) > 1;  -- must return 0 rows (proves the narrower index is safe to create)

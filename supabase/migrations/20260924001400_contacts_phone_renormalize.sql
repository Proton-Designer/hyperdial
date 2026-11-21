-- Best-effort retroactive normalization of contacts.phone_number for rows that predate
-- strict E.164 validation (design §7 / TASK-P2-P1, 20260924001300). contacts-import has
-- normalized phone numbers for years, but the single "Add Contact" flow
-- (AddContactModal.tsx) never did -- it only checked digit COUNT, then saved whatever the
-- user typed verbatim. Any contact added that way could hold "(512) 555-0100" or similar
-- in phone_number, which the 20260924001300 timezone backfill silently skips (it only
-- matches already-strict-E.164 rows) and which dialer-engine.ts would dial as-is.
--
-- Flagged by the lead during review of 20260924001300's apply. Fixed here rather than left
-- for a morning step: the fix is the exact same digit-stripping heuristic
-- contacts-import/index.ts used (pre-libphonenumber-js) for years -- 10 digits -> +1<digits>,
-- 11 digits starting with 1 -> +<digits> -- so this carries no new risk beyond what that
-- code already tolerated, just applied retroactively and once.
--
-- Safety:
--  - Only touches rows that don't already match strict E.164 shape (^\+1[0-9]{10}$).
--  - Never invents a country code for anything that isn't a plausible 10/11-digit NANP
--    number -- anything else is skipped and counted, not guessed at.
--  - Never overwrites a row if the normalized value would collide with another contact's
--    phone_number in the same org -- checked directly (a `where not exists` guard, not a
--    reliance on the unique index), so this is safe whether or not 20260924001300 actually
--    created idx_contacts_org_phone_unique on this environment (it skips its own unique
--    index if pre-existing duplicates are found -- see that migration). A future migration
--    can still safely add the unique index after this one runs.
--  - phone_raw is untouched: 20260924001300 already set it to each row's pre-normalization
--    phone_number, which is exactly the "original text" phone_raw exists to preserve.
--  - Runs as a plain migration-role DO block (auth.role() is null, not 'authenticated'),
--    so contacts_agent_update_scope (20260924001300) does not apply to it.

do $$
declare
  v_row record;
  v_digits text;
  v_new_phone text;
  v_normalized int := 0;
  v_skipped_collision int := 0;
  v_skipped_implausible int := 0;
begin
  for v_row in
    select id, org_id, phone_number
    from public.contacts
    where phone_number is not null
      and phone_number !~ '^\+1[0-9]{10}$'
  loop
    v_digits := regexp_replace(v_row.phone_number, '\D', '', 'g');

    if length(v_digits) = 10 then
      v_new_phone := '+1' || v_digits;
    elsif length(v_digits) = 11 and left(v_digits, 1) = '1' then
      v_new_phone := '+' || v_digits;
    else
      v_skipped_implausible := v_skipped_implausible + 1;
      continue;
    end if;

    if exists (
      select 1 from public.contacts c2
      where c2.org_id = v_row.org_id
        and c2.phone_number = v_new_phone
        and c2.id <> v_row.id
    ) then
      v_skipped_collision := v_skipped_collision + 1;
      continue;
    end if;

    update public.contacts set phone_number = v_new_phone where id = v_row.id;
    v_normalized := v_normalized + 1;
  end loop;

  raise notice 'contacts phone_number renormalization: % row(s) normalized, % skipped (would collide with another contact in the same org), % skipped (not a plausible 10/11-digit NANP number -- needs manual review).',
    v_normalized, v_skipped_collision, v_skipped_implausible;
end $$;

-- Re-run the timezone backfill for anything that just became strict-E.164 (and anything
-- else still null) -- same statement as 20260924001300, safe to repeat: idempotent, never
-- overwrites an already-set timezone.
update public.contacts c
set timezone = t.timezone
from private.area_code_timezones t
where c.timezone is null
  and c.phone_number ~ '^\+1[0-9]{10}$'
  and t.area_code = substring(c.phone_number from 3 for 3);

-- TASK-G21 item 1 (G05 review SHOULD): a contact that is already do-not-call when it FIRST gets a
-- ghl_contact_id (e.g. a GHL import matches an existing DNC contact by phone and links it) was never pushed,
-- because the trigger only reacted to dnc changing. Same guarded trigger, now also fires when ghl_contact_id goes
-- null -> set while dnc is true; enqueue_dnc_flag already dedupes against a queued/running job. No backfill.
-- Replaces the body from 20261019201027 (keeps the hyperdial.ghl_origin guard) and recreates the trigger with the
-- wider column list.

create or replace function private.contacts_dnc_push_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(current_setting('hyperdial.ghl_origin', true), '') = 'on' then
    return new;
  end if;
  if new.dnc is true and new.ghl_contact_id is not null
     and (tg_op = 'INSERT' or old.dnc is distinct from true or old.ghl_contact_id is null) then
    perform private.enqueue_dnc_flag(new.org_id, new.id, 'contacts.dnc');
  end if;
  return new;
exception when others then
  raise warning 'contacts_dnc_push_trigger failed for contact %: %', new.id, sqlerrm;
  perform private.log_trigger_failure(new.org_id, 'ghl_dnc_push', new.id, sqlstate || ': ' || sqlerrm);
  return new;
end;
$$;

drop trigger trg_contacts_dnc_push on public.contacts;
create trigger trg_contacts_dnc_push
  after insert or update of dnc, ghl_contact_id on public.contacts
  for each row execute function private.contacts_dnc_push_trigger();

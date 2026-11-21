-- TASK-G05 (spec section 4 + priority b, DNC HyperDial -> GHL on every source).
-- Before: a contact only got DND/tag in GHL when the DNC *disposition* ran (submit_disposition ->
-- 'disposition' job with is_dnc). Other ways a contact becomes DNC never reached GHL:
--   * contacts.dnc set directly (Contact detail toggle, agents/admins; supervisor tools),
--   * contacts inserted/imported already flagged dnc (contacts-import, GHL pull),
--   * a dnc_numbers row added by an admin (source manual / sms_stop / import) for a number that is a contact.
-- Now: a guarded AFTER trigger on each enqueues ONE 'dnc_flag' crm_sync_jobs row per change.
--   * Only for contacts that already have ghl_contact_id (linked to GHL). A contact without a GHL id is not
--     created in GHL just to carry a flag; the DNC disposition path (which upserts) is unchanged.
--   * Fires on a real change only (insert with dnc=true, or dnc false/null -> true), never on old.dnc = new.dnc.
--   * No-GHL orgs: enqueue_crm_job returns null when the org has no connected GHL integration.
--   * A dnc_flag already queued/running for the contact is not duplicated (the disposition path sets
--     contacts.dnc and inserts dnc_numbers in one transaction = one job, not three).
--   * The worker reads the GHL contact first and skips DND/tag that are already there, so a DNC that
--     originated in GHL (pull import) is not echoed back.
--   * Guarded: any failure is logged to trigger_failures (source ghl_dnc_push) and the write still commits.
-- No backfill: existing DNC contacts are NOT enqueued (would be a historical flood). Decision is the lead's.

alter table public.crm_sync_jobs drop constraint crm_sync_jobs_kind_check;
alter table public.crm_sync_jobs add constraint crm_sync_jobs_kind_check
  check (kind in (
    'disposition', 'contact_upsert', 'nurture_tag', 'voicemail_tag', 'no_answer_tag',
    'inbound_call_note', 'transfer_note', 'dnc_flag'
  ));

-- the source check was declared inline (system-generated name), so look the name up rather than assume it
do $$
declare
  v_name text;
begin
  select conname into v_name
  from pg_constraint
  where conrelid = 'public.trigger_failures'::regclass and contype = 'c'
    and pg_get_constraintdef(oid) like '%disposition_quality_checks%';
  if v_name is not null then
    execute format('alter table public.trigger_failures drop constraint %I', v_name);
  end if;
end;
$$;
alter table public.trigger_failures add constraint trigger_failures_source_check
  check (source in (
    'disposition_quality_checks', 'round_robin_distribution', 'shared_inbox', 'ghl_dnc_push'
  ));

-- Enqueue helper: linked contact only, no duplicate while one is pending.
create function private.enqueue_dnc_flag(p_org uuid, p_contact uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if exists (
    select 1 from public.contacts c where c.id = p_contact and c.ghl_contact_id is not null
  ) and not exists (
    select 1 from public.crm_sync_jobs j
    where j.contact_id = p_contact and j.kind = 'dnc_flag' and j.status in ('queued', 'running')
  ) then
    perform public.enqueue_crm_job(p_org, 'dnc_flag', p_contact, null, jsonb_build_object('reason', p_reason));
  end if;
end;
$$;

revoke all on function private.enqueue_dnc_flag(uuid, uuid, text) from public, anon, authenticated;

-- contacts.dnc false/null -> true (or inserted already true)
create function private.contacts_dnc_push_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.dnc is true and new.ghl_contact_id is not null
     and (tg_op = 'INSERT' or old.dnc is distinct from true) then
    perform private.enqueue_dnc_flag(new.org_id, new.id, 'contacts.dnc');
  end if;
  return new;
exception when others then
  raise warning 'contacts_dnc_push_trigger failed for contact %: %', new.id, sqlerrm;
  perform private.log_trigger_failure(new.org_id, 'ghl_dnc_push', new.id, sqlstate || ': ' || sqlerrm);
  return new;
end;
$$;

revoke all on function private.contacts_dnc_push_trigger() from public, anon, authenticated;

create trigger trg_contacts_dnc_push
  after insert or update of dnc on public.contacts
  for each row execute function private.contacts_dnc_push_trigger();

-- dnc_numbers row added: every linked contact with that number
create function private.dnc_numbers_push_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_contact uuid;
begin
  for v_contact in
    select c.id from public.contacts c
    where c.org_id = new.org_id and c.phone_number = new.e164 and c.ghl_contact_id is not null
  loop
    perform private.enqueue_dnc_flag(new.org_id, v_contact, 'dnc_numbers.' || new.source);
  end loop;
  return new;
exception when others then
  raise warning 'dnc_numbers_push_trigger failed for dnc_numbers %: %', new.id, sqlerrm;
  perform private.log_trigger_failure(new.org_id, 'ghl_dnc_push', new.id, sqlstate || ': ' || sqlerrm);
  return new;
end;
$$;

revoke all on function private.dnc_numbers_push_trigger() from public, anon, authenticated;

create trigger trg_dnc_numbers_push
  after insert on public.dnc_numbers
  for each row execute function private.dnc_numbers_push_trigger();

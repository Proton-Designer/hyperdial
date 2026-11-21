-- TASK-G31 (audit G23 F5): only an owner or admin can clear a contact's do-not-call flag.
-- Until now the agent-scope trigger let any assigned agent change `contacts.dnc` in BOTH directions, so a DNC contact
-- (including one marked from GHL's Do Not Disturb) could be made dialable again from the Contacts screen.
-- Setting dnc stays open to every role that may update the row; clearing (true -> false/null) is owner/admin only.
--
-- Same function and trigger as 20260924001300 (contacts_agent_update_scope), same enforcement scope: only a request whose JWT
-- role is 'authenticated'. Service-role Edge Functions and SECURITY DEFINER code with no end-user JWT are exempt -- none of
-- them clears dnc today (grep of migrations/functions: every write is `dnc = true`), and the GHL reconcile / import / pull
-- paths never clear it. dnc_numbers rows are already insert/delete for owner/admin only (policies in 20260925030000), and
-- contacts insert/delete are owner/admin only, so this closes the last agent-writable route.
-- Body of 20260924001300 verbatim plus the one new check; same signature, trigger and grants unchanged.
create or replace function private.enforce_agent_contact_update_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;

  if private.has_org_role(new.org_id, array['owner', 'admin']) then
    return new;
  end if;

  -- TASK-G31: an agent may mark a contact do-not-call but never clear it.
  if old.dnc is true and new.dnc is not true then
    raise exception 'only an owner or admin can clear do-not-call' using errcode = '42501';
  end if;

  -- Anyone else matching the row (an assigned agent, per the existing UPDATE policy) may
  -- only change dnc.
  if (to_jsonb(new) - 'dnc' - 'updated_at') is distinct from (to_jsonb(old) - 'dnc' - 'updated_at') then
    raise exception 'agents may only change the dnc flag on a contact' using errcode = '42501';
  end if;

  return new;
end;
$$;

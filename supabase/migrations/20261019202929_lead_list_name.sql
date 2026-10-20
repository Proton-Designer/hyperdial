-- TASK-G18 (spec section 1, "Lead list / batch ID -- ties results back to the scraped list it came from").
-- HyperDial stored no import batch, so the provider push (TASK-G11) could only send the campaign name.
-- Now every CSV import and GHL pull import records the name of the list it came from:
--   * campaign_leads.list_name -- the list a LEAD was queued from. The lead is what is dialed and a contact can be
--     in several lists over time (re-imported into another campaign), so this is the primary value. Set only when the
--     import creates the lead row (the existing upsert is ignoreDuplicates, an already-queued lead keeps its name).
--   * contacts.import_list -- the list a contact was FIRST created from (set on insert, never overwritten). Fallback
--     for leads created some other way (e.g. "add to campaign" from the Contacts screen) and for calls without a lead.
-- Push value (ghl-push-context.ts): lead.list_name -> contact.import_list -> campaign name.
-- Plain nullable text columns, no default, no backfill (existing rows stay null = campaign-name fallback).
-- No new table, no policy change: both tables keep their existing row-level policies (they have no column lists), and
-- the contacts agent-update scope trigger only allows agents to change dnc, so the new column is not agent-writable.

alter table public.campaign_leads add column list_name text
  check (list_name is null or char_length(list_name) between 1 and 120);

alter table public.contacts add column import_list text
  check (import_list is null or char_length(import_list) between 1 and 120);

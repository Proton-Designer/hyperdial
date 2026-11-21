-- GHL pull import dedupe key (TASK-P3-P2, design §7). Adds the column crm.md and
-- contacts.md's own Constraints sections already anticipated ("a future contacts
-- column (ghl_contact_id, per this task's own 'later, in Phase 3' note) is covered
-- automatically" -- 20260924001300's agent-update-scope trigger comment).
--
-- Unique per org, not globally: two different orgs' GHL sub-accounts can each have
-- their own contact carrying the same LeadConnector id only in theory (ids are
-- opaque per-location strings from GHL, not guaranteed globally unique across
-- locations by anything this schema can verify) -- scope the uniqueness the same way
-- phone_number's own dedupe index does (20260924001300).
--
-- No conditional fallback like phone_number's index needed: this column is brand
-- new and starts entirely null, so there is no pre-existing data that could already
-- violate uniqueness the way a phone backfill could.

alter table public.contacts add column ghl_contact_id text;

create unique index idx_contacts_org_ghl_contact_id
  on public.contacts (org_id, ghl_contact_id)
  where ghl_contact_id is not null;

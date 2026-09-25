---
id: domain.contacts
title: Contacts
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-24
sources:
  - supabase/functions/contacts-parse-csv/index.ts
  - supabase/functions/contacts-import/index.ts
  - supabase/functions/_shared/phone-normalize.ts
  - supabase/functions/_shared/area-code-tz.ts
  - supabase/functions/_shared/ghl-import.ts
  - supabase/functions/ghl-import/index.ts
  - supabase/migrations/20260924001600_contacts_ghl_contact_id.sql
  - apps/web/src/components/Contacts.tsx
  - apps/web/src/components/contacts/*.tsx
  - apps/web/src/lib/api.ts
  - apps/web/src/lib/phone-normalize.ts
  - apps/web/src/lib/area-code-tz.ts
  - supabase/migrations/*.sql
related:
  - domain.campaigns
  - domain.auth
  - arch.system-overview
answers:
  - "what are the canonical contact fields and which one is required"
  - "why are CSV parse and import two separate requests"
  - "what exactly counts as a duplicate on import"
  - "what are the allowed values of category and contact_status"
  - "why does the 'Contacted' filter never match anything"
  - "what happens when part of an import fails"
  - "how is a phone number validated and where does its timezone come from"
  - "who can edit a contact, and who can only mark it DNC"
covers: "The contacts table, two-step CSV import, strict E.164 phone normalisation, area-code timezone derivation, per-org de-duplication, real contact editing, org-wide DNC, and the category/contact_status labels."
excludes: "Per-call state (call_status, call_count, last_called_at) written by the dial loop — see domain.dialer. Campaign membership — see domain.campaigns."
tokens_est: 3290
source_hash: 62738fbb623c2e379609809908e501fe0d0848cd45c369afc7eaeaa205d58f59
---

# Contacts

## Purpose

Contacts are the call list. Everything the dialer consumes starts as a row in `public.contacts`, arriving via a CSV upload with interactive column mapping or a single
"Add contact" form, and can be edited afterward. A contact without a usable phone number is worthless here, and both the import path and editing enforce that with strict
E.164 validation (TASK-P2-P1, design §7).

## Key concepts

| Term | Means |
|---|---|
| Canonical field | One of 13 human-readable labels. The CSV UI speaks labels, the DB speaks snake_case; **three separate maps** translate between them. |
| Column mapping | `{ original_header, mapped_field, status }` per CSV column — a label, `'Skip this column'`, or `null`. |
| `category` vs `contact_status` | Two **separate** labels: a pipeline bucket chosen per import, and a contacted flag. Neither is the dialer's `call_status`. |
| `phone_number` vs `phone_raw` | `phone_number` is always strict E.164 (or null) — the dial target `dialer-engine.ts` reads directly. `phone_raw` preserves what was actually typed/imported, never overwritten to a normalized form. |
| `timezone` / `dnc` | IANA zone derived from the phone's NANP area code (overridable); an org-wide do-not-call flag any role, including agent, may set. `claim_next_leads` skips `dnc` rows. |
| Duplicate | A row whose digits-only phone already exists for this **org** — in the table, or earlier in the same CSV. A DB-level unique index backs this up when the org's existing data has no conflicting duplicates already (see Dedupe below). |
| `ghl_contact_id` | LeadConnector contact id (TASK-P3-P2), null unless the row was pulled from or linked to GHL. Unique per org, nullable. |

## Where the code lives

| What | Path | Notes |
|---|---|---|
| Table + RLS | `supabase/migrations/20250214000001_create_contacts_table.sql` | 4 policies, all `auth.uid() = user_id` (superseded by org-scoped policies, TASK-P1-01) |
| `phone_raw`, area-code timezone table, dedupe index, DNC trigger | `supabase/migrations/20260924001300_contacts_e164_tz_dnc.sql` | See Constraints below |
| Legacy phone renormalization | `supabase/migrations/20260924001400_contacts_phone_renormalize.sql` | One-time, best-effort; see Constraints |
| CSV parse + auto-map | `supabase/functions/contacts-parse-csv/index.ts` | `CANONICAL_FIELDS`, `ALIASES`, scoring, plus `invalid_phone_count` |
| CSV import | `supabase/functions/contacts-import/index.ts` | `CANONICAL_TO_DB`, phone normalize/dedupe/timezone, `phone_raw` |
| Phone + timezone (Deno) | `supabase/functions/_shared/phone-normalize.ts`, `_shared/area-code-tz.ts` | libphonenumber-js wrapper; 422-entry NANP→IANA table |
| Phone + timezone (browser) | `apps/web/src/lib/phone-normalize.ts`, `lib/area-code-tz.ts` | Duplicates of the above — Vite can't resolve the Deno copies' `npm:` specifier |
| Client contract | `apps/web/src/lib/api.ts` | `Contact`, `createContact`, `updateContact`, `CONTACT_CANONICAL_FIELDS` |
| List / filter UI | `apps/web/src/components/Contacts.tsx` | `CATEGORIES`, 50/page, DNC badge |
| Import wizard | `apps/web/src/components/contacts/ImportContactsModal.tsx` | `FIELD_OPTIONS`, invalid-phone warning |
| Add / edit / detail modal | `apps/web/src/components/contacts/` | `AddContactModal.tsx`; `ContactDetailModal.tsx` now has a real edit mode + DNC toggle |
| GHL pull import | `supabase/functions/_shared/ghl-import.ts` (pure paging/dedupe plan, deno-tested), `ghl-import/index.ts` (thin wrapper) | `ImportFromGhlModal.tsx`; GHL-API side → `.brain/domains/crm.md` |

## The canonical field set

13 labels: `Business Name`, `Business Link`, `Business Type`, `Rating`, `Review Count`, `Open Hours`, `Phone Number`, `Website`, `Notes`, `First Name`, `Last Name`,
`Owner Contact`, `Address` — declared identically in three places (`contacts-parse-csv/index.ts`, `contacts-import/index.ts`, `api.ts`), shared nowhere. `phone_raw`,
`timezone`, and `dnc` are **not** importable/mappable fields — they're derived or set separately (see How it works).

**Every column is nullable** — no DB-level required field. The *import* path makes `Phone Number` effectively required (a value that fails strict E.164 validation is
`skipped`); `createContact` does not, requiring only that *some* field is non-empty.

## How it works

1. **Parse** — the browser reads the file as text and POSTs `{ csv_text }` to `contacts-parse-csv`, which scores every (column, field) pair, returns a *proposed*
   mapping, and reports `invalid_phone_count` against the whole file (not just the 3-row preview) using the same `normalizePhoneStrict` import will use.
2. **Review** — the user corrects the mapping and picks one `category`. Import stays disabled until every column has a value ("Skip" counts).
3. **Import** — the browser POSTs the **original `csv_text` again** with the final mappings to `contacts-import`, which re-parses, normalizes each phone to strict
   E.164 (rejecting invalid ones into `skipped`, with `invalid` broken out separately), preserves the original text in `phone_raw`, derives `timezone` from the area
   code, de-duplicates, and does one bulk insert. Returns `{ imported, skipped, invalid, duplicates, skippedDnc, skippedActiveCampaign }` — the last two (TASK-L3)
   are only ever nonzero when `campaignId` was passed; see Campaign queueing below. A duplicate match against a real existing contact (not just another row earlier
   in the same CSV) is *also* a campaign-queue candidate now, not a pure no-op — re-importing an existing contact into a different campaign used to silently do
   nothing.
4. **Edit** — `ContactDetailModal` now supports real editing via `updateContact` (a direct client `.update()`, not an Edge Function): owner/admin can change any field,
   including a curated timezone dropdown that overrides the area-code guess; every role that can see the contact gets a DNC toggle. Both RLS and the
   `contacts_agent_update_scope` trigger (not just this UI) enforce that an agent's request may only touch `dnc` — see Constraints.

**Why two round-trips for import:** parse is a pure proposal the human then edits; the server keeps no state between calls, so the client re-sends the full CSV text.

## De-duplication

The key is **digits-only phone, scoped to the org** (TASK-P1-02). `contacts-import` still catches this at request time (including duplicates *within* the same CSV).
A DB-level `unique index on contacts(org_id, phone_number) where phone_number is not null` backs this up unconditionally as of TASK-L3
(`20260925000100_contacts_dedupe_dnc.sql`): the original migration (`20260924001300`) checked first and fell back to a plain (non-unique) index whenever the org's
existing data already had conflicting duplicates, and that fallback was permanent — the check only ever ran once, at that migration's own apply time, so the index
stayed missing on live regardless of later data changes (BUG-12 / audit/final.json). `20260925000100` finishes the job for real: for each surviving `(org_id,
phone_number)` duplicate group, the oldest row survives, `dnc` becomes `bool_or` across the group (a DNC row's flag is never lost to a merge), every null survivor
field is filled from the group's earliest non-null value, `call_count` is summed, every FK that references `contacts.id` (`campaign_leads`, `call_logs`,
`call_legs`, `crm_sync_jobs`) is repointed from the losers to the survivor, and only then is the unique index created — verified live: 0 duplicate groups existed on
live as of that migration, so it was a correctness-general no-op in practice, not exercised against real duplicate data.

**GHL pull import** (TASK-P3-P2) dedupes on `ghl_contact_id` first, then normalized phone — a `unique index on contacts(org_id, ghl_contact_id) where ghl_contact_id
is not null` (`20260924001600`) backs the id half; see `.brain/domains/crm.md` for the pull mechanics.

## Campaign queueing (DNC / paused / one-active-campaign, TASK-L3)

Both import paths can queue the contacts they touch onto a campaign (`campaignId` in the request). `_shared/campaign-queue.ts`'s `planCampaignQueue` is the single
shared gate both paths call before that upsert, so the same rules apply everywhere a contact might get queued:
- **`dnc=true` is never queued** (audit DSP-6/QUE-7's import-side half). For GHL pull, `dnc` is set from GHL's own `dnd` flag *or* a `dialer:dnc` tag — either is
  sufficient (`_shared/ghl-import.ts`).
- **A `dialer:paused` GHL tag is never queued either**, though the contact is still inserted/updated normally — "paused" is a queueing decision only, not a stored
  column; there's no `contacts.paused` field to persist it to (GHL-7).
- **One active campaign per contact at a time** (QUE-8): a contact already `queued`/`in_flight`/`callback` in a *different* campaign is skipped, not queued a
  second time — enforced at the DB level too, by a partial unique index on `campaign_leads(contact_id) where status in ('queued','in_flight','callback')`
  (`20260925000200_campaign_leads_one_active.sql`). Re-queuing within the *same* campaign (a callback coming due, a retry) is always an `UPDATE` of the existing
  row by the dial engine, never a second `INSERT`, so it can't hit this constraint — only a genuine cross-campaign double-queue (an import path) can, and both
  import paths check and skip that case before attempting the insert rather than relying on the constraint to reject it.
- Every skip is counted and returned to the caller (`skippedDnc`, `skippedPaused` (GHL only), `skippedActiveCampaign`) so the UI can report what happened, not just
  silently drop contacts from the campaign.

## Enums

`category` has 5 allowed values and `contact_status` 2. **Neither has a DB CHECK**, and **nothing ever writes `'Contacted'`**.

## Integration points & RLS

Depends on `domain.auth`; depended on by `domain.campaigns` (via `campaign_leads.contact_id`) and `domain.dialer` (which writes `call_status`, `last_called_at`,
`call_count`, and reads `dnc`/`timezone` at claim time). Owner/admin see and edit every contact in the org; an agent sees and edits only contacts reachable through a
campaign they're assigned to (`campaign_agents` → `campaign_leads`), and — as of TASK-P2-P1 — **an agent's UPDATE is now genuinely DNC-scoped**, not full-row: the
`contacts_agent_update_scope` trigger rejects any other column change with a `42501`, closing `.brain/memory/known-issues.md` #7. Import (INSERT) and delete stay
owner/admin only.

## Constraints & gotchas

- **Migration filenames are out of order.** `20250207000001`/`20250207100000` both sort before `20250214000001`'s `CREATE TABLE`. Do not "fix" by editing applied migrations.
- **The `Contacted` filter is dead** — nothing writes `contact_status = 'Contacted'`; the dialer writes the separate `call_status` column.
- **`Contact` in `api.ts` is hand-written**; nothing catches a drift from the DB shape.
- **Three copies of phone/timezone logic exist** (Deno `_shared/`, browser `apps/web/src/lib/`, plus a `private.area_code_timezones` SQL table for the one-time
  migration backfill) because Vite can't resolve the Deno copies' `npm:libphonenumber-js` specifier and SQL can't import either. Keep all three in sync by hand.
- **The area-code→timezone table is best-effort, not exhaustive** — most area codes map cleanly to one zone, but a handful of states split across zones by area code
  (documented exceptions: TX 915, IN 219, KY 270/364, TN 423/838/865); everything else uses that state/province's single dominant zone. This is why the edit UI's
  timezone field is an override, not a fixed value.
- **`20260924001400`'s renormalization is silent** — its skip counts (implausible numbers, would-collide-with-another-contact) only reach a `RAISE NOTICE` the lead
  sees when applying the migration, not anywhere in-app. No UI surfaces "N contacts still need a manual phone fix."
- **Trigger/migration ordering matters**: `contacts_agent_update_scope` is created *after* `20260924001300`'s own timezone backfill UPDATE in the same file — creating
  it first would make the migration reject its own backfill (caught by dry-running with the order deliberately swapped before shipping).
- **`Business Link` is special-cased** — matches only the exact headers `business link` or `link`, never a substring of `Business`.
- **Contacts paginate client-side**, 50/page, after `select('*')` of the whole table — large lists load entirely into the browser.
- **GHL pull import's "skipped" reuses CSV import's exact semantics**: always incremented when a GHL contact has no usable phone; `invalid` is the subset where a
  value was present but failed E.164 validation. "By tag" filters client-side (GHL's `GET /contacts/` has no server-side tag param) — see `.brain/domains/crm.md`.

## Not covered here

`call_status` / `call_count` / `last_called_at` and the dial loop → `.brain/domains/dialer.md`; `campaign_leads` and lead status → `.brain/domains/campaigns.md`; JWT
and service-role patterns → `.brain/domains/auth.md`; the GHL connection itself and pushing `dnc`/notes back to GHL (not yet built) → `.brain/domains/crm.md`.

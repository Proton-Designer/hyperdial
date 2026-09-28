---
id: domain.campaigns
title: Campaigns
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-27
sources:
  - apps/web/src/components/Campaigns.tsx
  - apps/web/src/components/campaigns/**
  - apps/web/src/lib/api.ts
  - supabase/migrations/20250207100000_create_campaigns_and_leads.sql
  - supabase/migrations/20260924000700_dialer_schema.sql
  - supabase/migrations/20260924001500_campaign_settings_agents_delete.sql
  - supabase/migrations/20260926070003_lead_assignment_control.sql
  - supabase/migrations/20260926070005_high_lines_drop_guard.sql
  - supabase/functions/dialer-session-start/index.ts
  - supabase/functions/campaign-lines-guard-check/index.ts
related:
  - domain.contacts
  - domain.dialer
  - arch.system-overview
answers:
  - "what are the legal campaign status values and who changes them"
  - "is CampaignWithStats a live query or a cached column"
  - "why do queued / completed / passthrough counts never move"
  - "what does dialer-session-start actually receive from a campaign"
  - "why does Start Parallel Dial fail with 'No dialable contacts in campaign'"
  - "how are campaigns and campaign_leads scoped per user"
covers: "The campaigns and campaign_leads tables, the campaigns_with_stats view, the campaign CRUD surface in the web client, and the handoff from a campaign to a parallel dial session."
excludes: "Contact records and CSV import mechanics (.brain/domains/contacts.md) and everything after the session row is inserted — batching, AMD, call_logs (.brain/domains/dialer.md)."
tokens_est: 3950
source_hash: f7c4fa7ab4c7aaef7f21b7456abe7a51c3d069875241177226f31a574d3132e5
---

# Campaigns

## Purpose

A campaign is a named, user-owned bucket of contacts to call — the unit an agent picks before dialing. Everything else in the
product (the contact list, the dialer, the dashboard) is either feeding a campaign or draining one.

## Key concepts

| Term | Means |
|---|---|
| Campaign | A row in `campaigns`. Owns a name, a status, and three display-only stat columns. |
| Lead | A row in `campaign_leads` — the join between one campaign and one contact, with its own `status`. Not a separate entity; the person's data lives on `contacts`. |
| Dialable | A lead whose contact's `call_status` is *not* `contacted` or `do_not_call`, and which has a phone number. This is a property of the **contact**, not of the lead. |
| `campaigns_with_stats` | A Postgres view, not a table — lead counts are computed per read, never cached. Also the only place the E1/P2-P2 dial-settings columns and the soft-delete filter are exposed to the client. |
| Passthrough | A `campaign_leads.status` value present in the CHECK constraint and the UI, never written by any code. |
| Dial settings | `lines`, `amd_mode`, `caller_id_number_id`, `max_attempts`, `retry_interval_minutes`, `calling_window_start`, `calling_window_end`, `abandon_message_enabled` — added by TASK-P2-E1 (`20260924000700`), editable via TASK-P2-P2's Settings section (admin+ only). |
| High-lines guard | `lines` up to 7 always allowed; 8–10 only while `high_lines_guard_enabled` is true (MISSION-4 TASK-S2, `20260926070005`). Enforced by a same-row CHECK on `campaigns` (`campaigns_lines_check`) and by the `dial_sessions` BEFORE INSERT trigger for session-start-time overrides — a client can't bypass it via a direct `updateCampaignSettings` call. A 5-minute cron (`check_high_lines_drop_rate_guard` / `campaign-lines-guard-check`) auto-resets both `lines` (→7) and the flag (→false) if the campaign's trailing-60-minute T8-style drop rate exceeds 3% on ≥10 human answers; a human must re-enable it. `high_lines_guard_last_triggered_at`/`_last_drop_rate_pct` are pure history, never cleared. |
| Soft delete | `campaigns.deleted_at` (TASK-P2-P2). Hard DELETE is no longer offered — the RLS delete policy was removed — so a "deleted" campaign is really "hidden and inert," not gone. |
| Per-lead assignment ("slice") | `campaign_leads.assigned_agent_id` (MISSION-4 TASK-T6, ADM-4 + NEW). Distinct from `campaign_agents` (which controls who may see/dial a campaign at all): this controls WHICH of a campaign's own leads a given agent's `claim_next_leads` call will pick up. Set by the `assign_campaign_leads` RPC (owner/admin only) — by rank, percentage, GHL-tag filter, or (MISSION-5 TASK-M5-B3) `by_current_agent` (bulk-move everything currently on one agent to another, or to the pool — the only mode that also picks up `'callback'` rows, not just `'queued'`) — which also auto-adds the target to `campaign_agents` (an assignee not already on the campaign could never claim what was just assigned). `priority` (high/normal/low, ordered ahead of attempts/`next_attempt_at`/position) and Skip (advances `next_attempt_at` without touching attempts/position) are plain column updates, no RPC. "Remove from campaign" is a `campaign_leads.status = 'removed'` flip, not a hard delete — deliberately distinct from `'passthrough'`, which already means something else in every campaign-stats view. |

## Where the code lives

| What | Path | Notes |
|---|---|---|
| Schema + view + RLS | `supabase/migrations/20250207100000_create_campaigns_and_leads.sql` | Both tables, all 8 policies, `campaigns_with_stats` |
| Dial settings columns | `supabase/migrations/20260924000700_dialer_schema.sql` | `lines`/`amd_mode`/`caller_id_number_id`/etc., plus `campaigns_check_caller_id_org` trigger |
| High-lines drop-rate guard | `supabase/migrations/20260926070005_high_lines_drop_guard.sql`, `supabase/functions/campaign-lines-guard-check/index.ts` | `campaigns_lines_check` widen, `check_high_lines_drop_rate_guard` RPC, pg_cron every 5 min |
| Per-lead assignment / priority / skip / remove | `supabase/migrations/20260926070003_lead_assignment_control.sql`, `apps/web/src/components/campaigns/AssignLeadsModal.tsx` | `assign_campaign_leads` RPC, `campaign_leads.assigned_agent_id`/`priority`, `'removed'` status. Wired in via `CampaignManageModal.tsx`'s "Assign leads" button on the Leads table. |
| Territory rules (state/area code → agent/pod, MISSION-5 TASK-M5-C4) | `supabase/migrations/20260927224036_territory_rules.sql`, `apps/web/src/components/campaigns/TerritoryRulesModal.tsx` | `org_territory_rules` (SELECT-only RLS; owner/admin/manager, manager scoped by pod) + CRUD RPCs + `private.resolve_territory_assignments` (set-based matcher, state derived from phone area code via `private.area_code_states`) + `preview_territory_rules`/`apply_territory_rules`. Apply groups resolved leads and calls `assign_campaign_leads`'s new `mode: 'lead_ids'` — the SAME path a manual assignment uses. Wired in via `CampaignManageModal.tsx`'s "Territory rules" button. |
| Soft delete, settings in the view, session-active guard | `supabase/migrations/20260924001500_campaign_settings_agents_delete.sql` | `deleted_at`, rebuilt `campaigns_with_stats`, `dial_sessions_require_active_campaign` trigger (TASK-P2-P2) |
| SQL acceptance tests | `supabase/tests/campaign_settings_agents.sql` | Settings RLS, agent assignment, soft-delete, session-guard — 16 assertions |
| Client data layer | `apps/web/src/lib/api.ts` | Campaigns section, `:354-496`; `startDialerSession` `:564-668`; `updateCampaignSettings`/`deleteCampaign`/`setCampaignAgents` (TASK-P2-P2) |
| Campaign list screen | `apps/web/src/components/Campaigns.tsx` | Grid, search, status filter, create-campaign dialog |
| Campaign detail | `apps/web/src/components/campaigns/CampaignManageModal.tsx` | 1,049 lines — see gotchas |
| Session handoff | `supabase/functions/dialer-session-start/index.ts` | Consumes `campaignId`; `:171-207` |
| Lead fetch for dialing | `supabase/functions/_shared/dialer-engine.ts` | `fetchDialableContacts()` `:93-118` |
| Import-time lead creation | `supabase/functions/contacts-import/index.ts` | `:144-162`, CSV rows land as `queued` leads |

## How it works

1. **Create** — `createCampaign(name)` inserts `status: 'active'` with the client's own `auth.uid()`
   (`apps/web/src/lib/api.ts:392-409`), then `Campaigns.tsx:63-67` immediately opens the manage modal for it.
2. **List** — `listCampaigns()` selects `*` from the view (`apps/web/src/lib/api.ts:383-390`). Search and the status filter are
   **client-side** over the full result (`apps/web/src/components/Campaigns.tsx:48-52`).
3. **Attach contacts** — `addLeadsToCampaign()` (upsert with `ignoreDuplicates`, `apps/web/src/lib/api.ts:466-474`) from the
   add-existing picker and the add-new-contact flow, or `contacts-import` during CSV upload.
4. **Read the detail** — the modal runs `getCampaign()` (view) plus `listCampaignLeads()`, which fetches leads, then a second
   `contacts` query by id, and stitches them in JS (`apps/web/src/lib/api.ts:432-464`).
5. **Hand off** — `handleConfirmStartParallelDialing` (`apps/web/src/components/campaigns/CampaignManageModal.tsx:164-223`) POSTs `{
   campaignId, linesCount, fromNumber, agentCallControlId?, agentCallbackNumber? }`. The campaign contributes **only its id**.
6. **Session start** — `dialer-session-start` verifies the from-number is the user's, rejects a second `active` session for the same
   campaign with `409 ACTIVE_SESSION_EXISTS` (`:112-139`), resolves dialable contacts, inserts a `dialer_sessions` row carrying
   `campaign_id`, and fires the first batch. Legacy path — see the status gotcha below for the new `dial_sessions` table.
7. **Edit settings / assign agents / delete** (TASK-P2-P2, admin+ only) — `CampaignManageModal.tsx`'s Settings and Assigned
   Agents sections call `updateCampaignSettings()`/`setCampaignAgents()` directly; RLS is the actual authority, not the UI's
   `canManage` check. `deleteCampaign()` sets `deleted_at`; there is no restore UI.

## Integration points

| Direction | With | Via |
|---|---|---|
| Depends on | `domain.contacts` | `campaign_leads.contact_id` → `contacts.id`; dialability is read off `contacts.call_status` |
| Depends on | `domain.auth` | `auth.uid()` RLS on both tables; `getUserFromRequest()` in the Edge Function |
| Depended on by | `domain.dialer` | `dialer_sessions.campaign_id`; `fetchDialableContacts()` re-reads `campaign_leads` on every batch |
| Depended on by | `domain.telephony` | Caller-ID choice comes from `usePhoneNumbers()` inside the start-dial modal |

## Constraints & gotchas

- **`campaign_leads.status` is write-once dead weight** — writes only ever insert `queued`, so `queued` always equals
  `total_contacts` and `completed`/`passthrough` are always `0`, yet the UI renders all three as if they moved. Call progress
  lives on `contacts.call_status`/`call_logs`, not here. `campaigns.total_calls_made`/`connect_rate`/`last_called_at` are never
  written either (the dialer's `last_called_at` updates `contacts`), so the campaign card always shows `0.0%`, `0`, `—`.
- **Status is cosmetic for the legacy dial path, enforced for the new one.** `active | paused | completed` (CHECK at migration
  `:6`); **any value may still move to any other**, no transition rules exist. Legacy `dialer-session-start` (writes
  `dialer_sessions`) never reads `campaigns.status`, so a `paused` campaign dials like an active one through that path. As of
  TASK-P2-P2, `public.dial_sessions` (TASK-P2-E1/E2's target table) has a BEFORE INSERT trigger
  (`dial_sessions_require_active_campaign`, `20260924001500`) refusing paused/completed/soft-deleted campaigns — only takes
  effect once E2's rewrite inserts into `dial_sessions` instead of the legacy table.
- **`dialer-session-start` never checks campaign ownership.** It takes `campaignId` on trust and uses the service-role key,
  bypassing RLS — the accidental guard is `fetchDialableContacts` filtering `contact.user_id` (`400`, not `403`).
- **`total_contacts > 0` does not mean dialable** — the view counts every lead; `fetchDialableContacts` excludes contacts
  already `contacted`/`do_not_call`, so a fully worked campaign still shows Start, then fails `400 "No dialable contacts..."`
- **`CampaignManageModal.tsx` is doing eight jobs in one file** (~1,400 lines as of TASK-P2-P2) and is the first thing to split:
  header + status, dial settings, agent assignment, lead table (filter/paginate/multi-select), import/add-contact wrappers, the
  start-dial config modal, the active-session conflict resolver, and three confirm dialogs — plus `AddExistingContactsModal`, a
  second component in the same file.
- **Pagination and selection are not reset**, and lead filters read contact fields, not lead ones. `leadsPage` only changes via
  prev/next — a filter change or a different campaign leaves the index where it was; `selectedLeadIds` survives `onClose` too.
  `categoryFilter`/`contactStatusFilter` match `lead.contact.category`/`contact_status` (CRM labels), unrelated to
  `campaign_leads.status`.
- **Delete is soft, as of TASK-P2-P2.** `deleteCampaign()` sets `deleted_at` via UPDATE; the RLS DELETE policy was **dropped**
  in `20260924001500` (a real `DELETE FROM campaigns` now matches zero rows under any role) because `dial_sessions`/`call_legs`
  are `ON DELETE CASCADE` on `campaign_id` — a hard delete would destroy call history, not "orphan" it. `campaigns_with_stats`
  filters `deleted_at is null` as a **plain view predicate, not RLS**: dry-run testing proved a SELECT-policy filter there
  instead breaks the very UPDATE that sets `deleted_at`, because Postgres implicitly ANDs a table's SELECT USING clause into
  an UPDATE's WITH CHECK. Relevant to any future "hide via a flag" column its own owner/admin must be able to set.
- **`UNIQUE(campaign_id, contact_id)`** makes the add path idempotent; both FKs `ON DELETE CASCADE`, so deleting a contact
  silently shrinks every campaign it was in.
- **`createCampaign()`/`addLeadsToCampaign()` set `org_id` explicitly** via `getActiveOrgId()` — `NOT NULL`, no DB default. RLS
  is the actual authorization boundary; the client value only needs to be *correct*, never *trusted* as the check.
- **RLS is org-scoped as of TASK-P1-01 (`20260924000300_rewrite_rls_org_scoped.sql`), not `auth.uid() = user_id` anymore.**
  `campaigns` SELECT is any org member (`private.is_org_member`); INSERT/UPDATE/DELETE-turned-soft-delete are owner/admin
  (`private.has_org_role(org_id, ['owner','admin'])`). `campaign_leads` SELECT lets an agent see leads only on a campaign
  they're assigned to via `campaign_agents`; INSERT also verifies `campaign_id`/`contact_id` both belong to the claimed
  `org_id`. The view is still `security_invoker = on`. Service-role Edge Functions still bypass all of it; `dialer-session-start`'s
  missing-ownership-check gotcha is **not yet fixed** (eng2's Phase 2 lane, not this doc's scope). Full inventory:
  `.brain/domains/auth.md`.
- **`campaign_agents`** (`campaign_id, user_id`, denormalized `org_id`): which agents may dial/see which campaign. A validation
  trigger rejects an `org_id` not matching the campaign's own org, even from a caller who legitimately owns that *different*
  org. As of TASK-P2-P2, `CampaignManageModal.tsx`'s Assigned Agents section is the first UI for it: `setCampaignAgents()`
  diffs the desired set against `listCampaignAgentIds()`, issuing one insert + one delete, not delete-all-then-reinsert. Still
  org-wide `campaigns` visibility underneath (known-issues #10) — this controls who's *assigned*, not row visibility.

## Not covered here

- Contacts, CSV import, `call_status` semantics → `.brain/domains/contacts.md`
- Batching, AMD, `call_logs`, session stop/advance → `.brain/domains/dialer.md`
- Caller-ID numbers, the WebRTC agent leg → `.brain/domains/telephony.md`; auth/Edge Function token verification → `.brain/domains/auth.md`

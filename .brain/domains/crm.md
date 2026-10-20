---
id: domain.crm
title: CRM Sync (GHL)
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-10-19
sources:
  - supabase/migrations/20260924000900_ghl_integration_outbox.sql
  - supabase/migrations/20260924001200_ghl_integration_fixes.sql
  - supabase/functions/ghl-connect/index.ts
  - supabase/functions/ghl-disconnect/index.ts
  - supabase/functions/_shared/ghl-client.ts
  - supabase/functions/_shared/ghl-import.ts
  - supabase/functions/ghl-import/index.ts
  - supabase/migrations/20260925080000_ghl_blocked_tags.sql
  - supabase/migrations/20260924001600_contacts_ghl_contact_id.sql
  - supabase/migrations/20260924002000_ghl_push_worker.sql
  - supabase/functions/_shared/ghl-sync-worker.ts
  - supabase/functions/ghl-sync-worker/index.ts
  - apps/web/src/components/Settings.tsx
  - apps/web/src/components/contacts/ImportFromGhlModal.tsx
  - apps/web/src/lib/api.ts
  - supabase/migrations/20261019200613_ghl_dnc_push.sql
  - supabase/migrations/20261019201027_ghl_reconcile.sql
  - supabase/migrations/20261019201849_call_top_objection.sql
  - supabase/functions/_shared/ghl-reconcile.ts
  - supabase/functions/_shared/ghl-reconcile-settings.ts
  - supabase/functions/ghl-reconcile-worker/index.ts
  - supabase/functions/ghl-reconcile-settings/index.ts
  - supabase/migrations/20261019210311_ghl_webhook.sql
  - supabase/functions/_shared/ghl-webhook.ts
  - supabase/functions/_shared/ghl-webhook-run.ts
  - supabase/functions/ghl-webhook/index.ts
  - supabase/functions/ghl-webhook-settings/index.ts
  - apps/web/src/components/settings/GhlWebhookCard.tsx
  - supabase/functions/_shared/ghl-push-context.ts
  - supabase/functions/_shared/ghl-field-mapping.ts
  - apps/web/src/components/settings/GhlReconcileCard.tsx
related:
  - domain.auth
  - domain.campaigns
  - arch.system-overview
answers:
  - "how does an org connect its GHL sub-account"
  - "where is the GHL Private Integration Token stored"
  - "how does a disposition reach GHL, and what runs the worker that pushes it"
  - "what payload shape does enqueue_crm_job expect for a disposition job"
  - "how does Import from GHL dedupe, and what happens if you run it twice"
  - "why does tag-based import page every contact instead of filtering server-side"
  - "how is a retried sync job kept from double-posting a note; what makes a GHL-tagged contact do-not-call or paused"
covers: "GHL (GoHighLevel) connect/disconnect, the org_integrations token store, the crm_sync_jobs push outbox (worker included), the pull-import (contacts by tag/search) path, and the 2026-10-19 data sync (per-call fields, DNC push, GHL reconcile sweep)."
excludes: "The disposition/wrap-up UI that calls enqueue_crm_job (see Not covered here)."
tokens_est: 5398
source_hash: cb3f047756eded64f18f0c71bcd88037271adb947b79fce3348552e4e0d122ed
---

# CRM Sync (GHL)

## Purpose

Each org can connect exactly one GoHighLevel (GHL) sub-account via a Private
Integration Token (design §6). Once connected, every call disposition pushes a
note, a tag, a callback task and a DND flag into that GHL sub-account via a
pg_cron-driven push worker (TASK-P3-P3); contacts can also be pulled the other
way, by tag or search (TASK-P3-P2). The disposition/wrap-up UI that actually
calls `enqueue_crm_job` is built (`dialer/WrapUpModal.tsx` -> `dialer-session-disposition` -> `submit_disposition`, which enqueues the job in the same
transaction). Since 2026-10-19 (the HyperDial -> GHL data sync, Kareem's spec) the push also covers per-call fields, automatic no-answer/voicemail legs, DNC from
every source, and a GHL -> HyperDial reconcile sweep; see "Data sync (2026-10-19)" below. Setup steps for the GHL admin: `docs/guides/ghl-data-sync-setup.md`.

## Key concepts

| Term | Means |
|---|---|
| Private Integration Token | A GHL-issued bearer token scoped to one sub-account (location), pasted in by the org owner. Not OAuth -- there is no refresh flow. |
| Location | GHL's term for a sub-account. `org_integrations.location_id` is confirmed against the token at connect time, not just trusted from user input. |
| Outbox | `crm_sync_jobs` -- rows enqueued by `enqueue_crm_job`, drained every 60s by `ghl-sync-worker`. Exists so a GHL outage never blocks the dialer. `progress` (jsonb) tracks which push steps already succeeded, so a retry never redoes one. |
| Disposition job | `kind='disposition'` outbox row. Its `payload` shape is fixed below; `submit_disposition` (SQL) is the caller. |
| Other job kinds | `crm_sync_jobs.kind` is checked against `disposition`, `contact_upsert`, `nurture_tag`, `voicemail_tag`, `no_answer_tag`, `inbound_call_note`, `transfer_note`, `dnc_flag` (`20261019200613_ghl_dnc_push.sql`). |
| Reconcile | The 5-minute GHL -> HyperDial sweep that takes DNC / signed-up / paused contacts off call lists (`ghl-reconcile-worker`). Off by default per org. |

## Where the code lives

| What | Path | Notes |
|---|---|---|
| Token storage + outbox schema | `supabase/migrations/20260924000900_ghl_integration_outbox.sql` | `org_integrations`, `crm_sync_jobs`, `enqueue_crm_job` |
| Vault-naming + dedupe fix | `supabase/migrations/20260924001200_ghl_integration_fixes.sql` | See Constraints below |
| Connect / disconnect functions | `supabase/functions/ghl-connect/`, `supabase/functions/ghl-disconnect/` | Owner-only, same shape as `telnyx-connect`/`telnyx-disconnect` |
| Typed LeadConnector client | `supabase/functions/_shared/ghl-client.ts` | contacts upsert/search, notes, tags, tasks, DND. Deno-tested (`ghl-client.test.ts`) with a stubbed `fetch`, no live GHL calls |
| Settings UI | `apps/web/src/components/Settings.tsx` (`IntegrationsTab`) | Connect form + status card + `SyncStatusList` (last 20 jobs), owner-only controls |
| Push worker | `supabase/functions/_shared/ghl-sync-worker.ts` (pure per-step processors, deno-tested), `ghl-sync-worker/index.ts` (claim + dispatch) | `20260924002000_ghl_push_worker.sql`: claim/complete/fail/progress RPCs + pg_cron |
| Client wrappers | `apps/web/src/lib/api.ts` | `getGhlIntegrationStatus`, `connectGhl`, `disconnectGhl`, `importFromGhl`, `listCrmSyncJobs` |
| Pull import + blocked tags (TASK-P3-P2, TASK-G7) | `_shared/ghl-import.ts`/`ghl-import/index.ts`; blocked tags: `org_integrations.ghl_dnc_tags`/`ghl_paused_tags` (`20260925080000`), `ghl-update-blocked-tags/`, `Settings.tsx`'s `GhlBlockedTagsEditor` | `Contacts.tsx`'s "Import from GHL"/"Re-sync"; contacts detail → `.brain/domains/contacts.md`. Tag lists owner/admin-editable via `set_org_ghl_blocked_tags` RPC (service-role only, same wrapper as `set_org_ghl_token`) |

## How it works

1. Owner pastes a Private Integration Token + location id into Settings → Integrations (`IntegrationsTab`).
2. `ghl-connect` (owner-only, checked directly against `org_members` like `telnyx-connect`) calls `GET /locations/{locationId}` through `_shared/ghl-client.ts` to confirm the token is live and actually resolves to that location.
3. On success, `set_org_ghl_token` (public wrapper → `private.set_org_ghl_token`) stores the token in Vault and upserts `org_integrations` (`status='connected'`, `token_last4`, `location_id`, `connected_at`).
4. The client never reads the base `org_integrations` table (zero client policies, same pattern as `org_telephony`) -- only the `org_integrations_status` view, scoped by `private.is_org_member`.
5. Once connected, a service-role caller (a future dispositions Edge Function) calls `enqueue_crm_job(org, kind, contact_id, call_leg_id, payload)`. It no-ops (returns `null`, writes nothing) when the org has no `status='connected'` row.
6. `ghl-disconnect` (owner-only) only flips `status` to `'disconnected'` -- it does not delete the row or the Vault secret, so reconnecting reuses the same secret via `set_org_ghl_token`'s existing-secret path.

### Disposition job payload shape

For `kind='disposition'`, `enqueue_crm_job`'s `payload` must be:

```json
{
  "disposition_key": "string",
  "disposition_label": "string",
  "notes": "string | null",
  "callback_at": "ISO 8601 timestamp | null",
  "agent_name": "string",
  "duration_seconds": "number",
  "recording_url": "string | null",
  "transcript_excerpt": "string | null",
  "ghl_tag": "string | null",
  "creates_task": "boolean",
  "is_dnc": "boolean",
  "top_objection": "string key | null (TASK-G13; absent on jobs queued before it)"
}
```

Maps onto `ghl-client.ts`'s `addNote`/`addTags`/`createTask`/`setDnd`. The authoritative list of keys is the `jsonb_build_object` in the latest `submit_disposition` (`20261019201849_call_top_objection.sql`, ~line 200) and `DispositionPayload` in `ghl-sync-worker.ts`.

### Pull import (TASK-P3-P2)

Admin+ only, same as CSV import. "By tag" and "by search" share one code path: `fetchAllGhlContacts` pages `GET /contacts/` (100/page, capped at 20 pages --
2,000 contacts/run), `query` for search mode or no query for tag mode (GHL's list endpoint has no server-side tag filter -- confirmed against its own spec).
`planGhlImport` (pure) filters by `GhlContact.tags` client-side for tag mode and dedupes on `ghl_contact_id` first, normalized phone second -- same order as
`contacts.md`'s De-duplication section. GHL `dnd:true` sets `dnc: true`; `dnd:false`/absent never forces it back to false. "Re-sync" replays the last
`{mode, value}` through the same call -- dedupe makes that idempotent. `truncated: true` in the response means the 2,000-contact cap was hit.
**Blocked tags (TASK-G7, GHL-7):** `GhlContact.tags` is also checked against the org's `ghl_dnc_tags`/`ghl_paused_tags` (`org_integrations`, defaults `["do not call","dnc","do-not-call"]`/`["paused","pause"]`, owner/admin-editable, exact case/whitespace-insensitive match). A matched DNC tag sets `contacts.dnc`, writes a `dnc_numbers` row (`note='GHL tag: <tag>'`), and -- like `submit_disposition`'s own DNC branch -- moves every active `campaign_leads` row for that contact, org-wide, to `status='dnc'`. A matched paused tag isn't stored (no `contacts.paused` column) but is re-derived every import: skipped from queueing, active `campaign_leads` rows move to `status='paused'` (distinct from the dedupe-loser `'passthrough'`). `contacts.ghl_tags` snapshots the raw tags so a re-import can detect "was paused, isn't now" -- surfaced as an `unpaused` count only, re-queueing is always manual. Verified the push worker never adds/removes these tags (no `removeTags` exists; `upsertContact` never sends `tags`).

### Push worker (TASK-P3-P3)

`ghl-sync-worker`, pinged every 60s: `cron.schedule('ghl-sync-worker', '* * * * *', ...)` -> `private.trigger_ghl_sync_worker()` -> `net.http_post` (pg_cron +
pg_net -- first use of either in this repo; `cron.schedule('<domain>-<purpose>', ...)` is the naming convention for any future job, e.g. E5's sweeper). Auth is
a shared `X-Cron-Secret` header, not a user JWT -- both the function's `CRM_SYNC_WORKER_SECRET` env var and the incoming header must be present and equal,
fail-closed. URL + secret are global Vault-backed config (`private.set_crm_sync_worker_config`, called once manually, not baked into the migration); until
configured the trigger no-ops instead of erroring every tick. Claims up to 10 due jobs (`claim_crm_sync_jobs`, `FOR UPDATE SKIP LOCKED`, same shape as
`claim_next_leads`), resolves each job's org's GHL client once per batch, and runs `disposition` jobs through upsert -> note -> tag -> task -> dnd in order,
skipping any step already marked done in `progress`. A failure partway persists progress via `update_crm_sync_job_progress` before `fail_crm_sync_job` applies
backoff (`least(2^attempts, 60)` minutes, `dead` at 8) -- a retry never re-posts a note that already landed. A resolved GHL contact id is stamped onto
`contacts.ghl_contact_id` regardless of the job's outcome, so a retry never re-upserts either. `contact_upsert` jobs are the simpler one-step case.

### Data sync (2026-10-19)

The run `run-20261019-1905` implemented Kareem's `ghl-data-sync` spec. What each piece does and where it lives:

- **Per-call fields on the provider contact** (`ghl-sync-worker.ts` `buildPushCustomFields`, ~line 85-130): `last_call_at` (call `ended_at`, falls back to disposition time, then leg creation), `last_call_outcome`, `call_attempts`, `callback_at`, `call_duration`, `recording_url` (an in-app, login-gated link), `called_by`, `called_by_ghl_user_id`, `lead_list` (TASK-G18: `campaign_leads.list_name` -> `contacts.import_list` -> campaign name; the name is typed on the CSV import screen (default the file name) or `GHL import <date>` for `ghl-import`; `_shared/list-name.ts`, resolved in `ghl-push-context.ts`), `top_objection` (label text), plus the older `license_number`/`service_zips`. A key only goes out when the org mapped it in `ghl_field_mapping` (Settings -> Integrations -> Custom field mapping; target keys in `ghl-field-mapping.ts` `GHL_FIELD_MAPPING_TARGET_KEYS`). Push-time lookups (caller name, GHL user id, campaign) are in `_shared/ghl-push-context.ts`.
- **Note policy:** a `no_answer`/`voicemail_left`/`voicemail` disposition with empty notes adds no GHL note (`shouldSkipDispositionNote`) (TASK-G02, spec "do not log every no-answer as a note"). The callback GHL task is assigned to the calling intern's `org_members.ghl_user_id` when known; the contact's GHL owner is never written.
- **Automatic no-answer / voicemail legs** (`voicemail_tag`/`no_answer_tag` jobs, `processTagJob`) also push `call_attempts` and `last_call_at`, still with no note (TASK-G03).
- **DNC HyperDial -> GHL** (TASK-G05): guarded AFTER triggers on `contacts` (dnc set) and `dnc_numbers` insert enqueue ONE `dnc_flag` job per change, only for contacts that already have `ghl_contact_id` and orgs with a connected GHL. The worker reads the GHL contact first and skips DND/tag already present. Trigger failures are logged to `trigger_failures` (source `ghl_dnc_push`) and never block the write. **No backfill** of pre-existing DNC contacts.
- **GHL -> HyperDial reconcile** (TASK-G08, migration `20261019201027_ghl_reconcile.sql`, `ghl-reconcile-worker`, `_shared/ghl-reconcile.ts`): cron `ghl-reconcile-worker` at `2-59/5 * * * *` -> `private.trigger_ghl_reconcile_worker()` -> secret `GHL_RECONCILE_WORKER_SECRET` (fails closed; `verify_jwt=false`). Per org with `org_integrations.ghl_reconcile_enabled`, `claim_ghl_reconcile_batch` leases contacts that have a `queued`/`callback` lead (oldest `contacts.ghl_reconciled_at` first, default batch 100, `GHL_RECONCILE_BATCH` max 300, 100 s budget checked between orgs), reads each from GHL, and `apply_ghl_reconcile` moves leads: DND on calls or a `ghl_dnc_tags` tag -> contact `dnc` + `dnc_numbers` row + leads `dnc`; a `ghl_exclude_tags` tag or an opportunity in `ghl_exclude_stage_ids` -> leads `completed`; a `ghl_paused_tags` tag -> leads `paused`. Only queued/callback leads move, never `in_flight`. A transaction-local flag `hyperdial.ghl_origin` makes the G05 triggers skip, so a GHL-origin DNC is not echoed back. Removal is one-way.
- **Settings UI** (TASK-G12): Settings -> Integrations -> "Remove from call lists" (`settings/GhlReconcileCard.tsx`) via `ghl-reconcile-settings` (`get`/`set`, owner/admin only through `requireOrgRole`, writes through `set_org_ghl_reconcile_settings`; deliberately not exposed in `org_integrations_status`, which every member can read). Audit action `ghl.update_reconcile_settings`.
- **Top objection** (TASK-G13): `call_legs.top_objection` (six keys shared with the shift survey), optional `p_top_objection` on `submit_disposition`, wrap-up select, pushed as `top_objection`.
- **Shift side** (intern contact): see `.brain/domains/shifts.md`; the outbox is separate (`shift_ghl_outbox`).

- **Owner routing** (TASK-G15, `20261019202452_ghl_owner_routing.sql`): the reconcile read's `assignedTo` goes to `apply_ghl_owner_routing(p_org, p_items)` (service_role only), which maps it through `org_members.ghl_user_id` (active members only), syncs the informational `contacts.assigned_user_id`, and sets `campaign_leads.assigned_agent_id` on that contact's `callback` leads when the member is on `campaign_agents` for the campaign. `claim_next_leads` already hands a callback only to its assigned agent. Runs after the DNC/exclude/paused decisions, same 5-minute tick, so it needs `ghl_reconcile_enabled`. GHL owner wins over the HyperDial-created callback assignee; a cleared owner changes nothing.

Not built (verified absent): a list name on leads queued by the scheduled GHL pull (`ghl-pull-run.ts`) or by the Contacts-screen "add to campaign" upsert (they fall back to `contacts.import_list`, then the campaign name), an instant GHL webhook receiver, a DNC backfill.

## Integration points

| Direction | With | Via |
|---|---|---|
| Depends on | `domain.auth` | `private.is_org_member`, `has_org_role`, the org-owner check |
| Depended on by | `domain.dispositions` | `enqueue_crm_job(org, 'disposition', ...)` from `submit_disposition` |
| Depended on by | `domain.contacts` | Pull import writes `contacts.ghl_contact_id`/`dnc`/`timezone`; the push worker also stamps `ghl_contact_id` |
| External | GHL LeadConnector API v2 | `https://services.leadconnectorhq.com`, bearer token, `Version: 2021-07-28` header, `net.http_post` every 60s via pg_cron |

## Constraints & gotchas

- **`vault.secrets.name` has a unique index `WHERE name IS NOT NULL`.** The first version of `set_org_ghl_token` named every secret deterministically (`'org_ghl_token_' || org_id`); a second `vault.create_secret` call under that same name (disconnect-then-reconnect, or two racing `ghl-connect` calls) would collide. Fixed in `20260924001200`: secrets are created with no name. Nothing looks a secret up by name, only by `org_integrations.token_secret_id`.
- **`crm_sync_jobs` dedupes on `(call_leg_id, kind)`**, via a unique partial index (`WHERE call_leg_id IS NOT NULL`) plus `ON CONFLICT ... DO NOTHING` in `enqueue_crm_job`. A retried disposition write for the same call leg is a no-op, not a duplicate GHL note. `contact_upsert` jobs (no `call_leg_id`) are never deduped by this index.
- **`GET /contacts/` is used for search, not `POST /contacts/search`.** GHL's own published OpenAPI spec (`GoHighLevel/highlevel-api-docs`) leaves `POST /contacts/search`'s request body completely undocumented (`SearchBodyV2DTO` has no declared properties); `GET /contacts/`'s query params (`locationId`, `query`, `limit`, `startAfterId`, `startAfter`) are fully typed in the same spec.
- **The docs *site* (`marketplace.gohighlevel.com/docs`) is not a reliable source for the `Version` header value** -- a client-rendered Docusaurus app; its own `docs-version-v3` can be misread as the API's required header. Confirmed from the OpenAPI spec instead: `2021-07-28` for every endpoint this client calls.
- **`ghl-connect`/`ghl-disconnect` are not wired through `_shared/auth.ts`'s `requireOrgRole`**, same reasoning as `telnyx-connect`/`telnyx-disconnect`: they do their own direct `org_members` owner check.

## Not covered here

- The dial engine, dispositions and the wrap-up UI that call `enqueue_crm_job` → `.brain/domains/dialer.md` and `.brain/domains/dispositions.md`. Shift pushes -> `.brain/domains/shifts.md`.
- Telnyx account connection → `.brain/domains/telephony.md`. Org/role/invite plumbing `ghl-connect` reuses → `.brain/domains/auth.md`.

## Unverified

- GHL's exact `contacts.dnd` channel-level (`dndSettings`) vs. blanket semantics — `setDnd` only ever writes the blanket flag, unexercised per-channel. Also unverified: `GET /contacts/`'s response schema in GHL's own spec omits `firstName`/`lastName`/`phone`/`dnd` (only `GET /contacts/{id}`'s schema has them) -- `ghl-import.ts` assumes the real response includes them anyway; fallback direction → `ghl-client.ts`'s header.

---
id: domain.crm
title: CRM Sync (GHL)
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-24
sources:
  - supabase/migrations/20260924000900_ghl_integration_outbox.sql
  - supabase/migrations/20260924001200_ghl_integration_fixes.sql
  - supabase/functions/ghl-connect/index.ts
  - supabase/functions/ghl-disconnect/index.ts
  - supabase/functions/_shared/ghl-client.ts
  - supabase/functions/_shared/ghl-import.ts
  - supabase/functions/ghl-import/index.ts
  - supabase/migrations/20260924001600_contacts_ghl_contact_id.sql
  - supabase/migrations/20260924002000_ghl_push_worker.sql
  - supabase/functions/_shared/ghl-sync-worker.ts
  - supabase/functions/ghl-sync-worker/index.ts
  - apps/web/src/components/Settings.tsx
  - apps/web/src/components/contacts/ImportFromGhlModal.tsx
  - apps/web/src/lib/api.ts
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
  - "how is a retried sync job kept from double-posting a note"
covers: "GHL (GoHighLevel) connect/disconnect, the org_integrations token store, the crm_sync_jobs push outbox (worker included), and the pull-import (contacts by tag/search) path."
excludes: "The disposition/wrap-up UI that will call enqueue_crm_job -- not yet built (see Not covered here)."
tokens_est: 3269
source_hash: 540085dae43bafb688ef37a220a540af5348d3551e81f4515b0971603e0960c1
---

# CRM Sync (GHL)

## Purpose

Each org can connect exactly one GoHighLevel (GHL) sub-account via a Private
Integration Token (design §6). Once connected, every call disposition pushes a
note, a tag, a callback task and a DND flag into that GHL sub-account via a
pg_cron-driven push worker (TASK-P3-P3); contacts can also be pulled the other
way, by tag or search (TASK-P3-P2). The disposition/wrap-up UI that actually
calls `enqueue_crm_job` isn't built yet (Phase 3, eng2) -- the worker exists
and is tested, but has nothing feeding it in production until then.

## Key concepts

| Term | Means |
|---|---|
| Private Integration Token | A GHL-issued bearer token scoped to one sub-account (location), pasted in by the org owner. Not OAuth -- there is no refresh flow. |
| Location | GHL's term for a sub-account. `org_integrations.location_id` is confirmed against the token at connect time, not just trusted from user input. |
| Outbox | `crm_sync_jobs` -- rows enqueued by `enqueue_crm_job`, drained every 60s by `ghl-sync-worker`. Exists so a GHL outage never blocks the dialer. `progress` (jsonb) tracks which push steps already succeeded, so a retry never redoes one. |
| Disposition job | `kind='disposition'` outbox row. Its `payload` shape is fixed below; dispositions code (Phase 3, eng2) is the intended caller. |

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
| Pull import (TASK-P3-P2) | `supabase/functions/_shared/ghl-import.ts` (pure paging/dedupe, deno-tested), `ghl-import/index.ts` (thin wrapper) | `Contacts.tsx`'s "Import from GHL"/"Re-sync"; contacts-side detail → `.brain/domains/contacts.md` |

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
  "transcript_excerpt": "string | null"
}
```

Maps onto `ghl-client.ts`'s `addNote`/`addTags`/`createTask`/`setDnd`. Written per TASK-P3-P1's requirement so dispositions (eng2, Phase 3) can call `enqueue_crm_job` without re-deriving this shape.

### Pull import (TASK-P3-P2)

Admin+ only, same as CSV import. "By tag" and "by search" share one code path: `fetchAllGhlContacts` pages `GET /contacts/` (100/page, capped at 20 pages --
2,000 contacts/run), `query` for search mode or no query for tag mode (GHL's list endpoint has no server-side tag filter -- confirmed against its own spec).
`planGhlImport` (pure) filters by `GhlContact.tags` client-side for tag mode and dedupes on `ghl_contact_id` first, normalized phone second -- same order as
`contacts.md`'s De-duplication section. GHL `dnd:true` sets `dnc: true`; `dnd:false`/absent never forces it back to false. "Re-sync" replays the last
`{mode, value}` through the same call -- dedupe makes that idempotent. `truncated: true` in the response means the 2,000-contact cap was hit.

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

## Integration points

| Direction | With | Via |
|---|---|---|
| Depends on | `domain.auth` | `private.is_org_member`, `has_org_role`, the org-owner check |
| Depended on by | Dispositions (not yet built) | `enqueue_crm_job(org, 'disposition', ...)` |
| Depended on by | `domain.contacts` | Pull import writes `contacts.ghl_contact_id`/`dnc`/`timezone`; the push worker also stamps `ghl_contact_id` |
| External | GHL LeadConnector API v2 | `https://services.leadconnectorhq.com`, bearer token, `Version: 2021-07-28` header, `net.http_post` every 60s via pg_cron |

## Constraints & gotchas

- **`vault.secrets.name` has a unique index `WHERE name IS NOT NULL`.** The first version of `set_org_ghl_token` named every secret deterministically (`'org_ghl_token_' || org_id`); a second `vault.create_secret` call under that same name (disconnect-then-reconnect, or two racing `ghl-connect` calls) would collide. Fixed in `20260924001200`: secrets are created with no name. Nothing looks a secret up by name, only by `org_integrations.token_secret_id`.
- **`crm_sync_jobs` dedupes on `(call_leg_id, kind)`**, via a unique partial index (`WHERE call_leg_id IS NOT NULL`) plus `ON CONFLICT ... DO NOTHING` in `enqueue_crm_job`. A retried disposition write for the same call leg is a no-op, not a duplicate GHL note. `contact_upsert` jobs (no `call_leg_id`) are never deduped by this index.
- **`GET /contacts/` is used for search, not `POST /contacts/search`.** GHL's own published OpenAPI spec (`GoHighLevel/highlevel-api-docs`) leaves `POST /contacts/search`'s request body completely undocumented (`SearchBodyV2DTO` has no declared properties); `GET /contacts/`'s query params (`locationId`, `query`, `limit`, `startAfterId`, `startAfter`) are fully typed in the same spec.
- **The docs *site* (`marketplace.gohighlevel.com/docs`) is not a reliable source for the `Version` header value** -- a client-rendered Docusaurus app; its own `docs-version-v3` can be misread as the API's required header. Confirmed from the OpenAPI spec instead: `2021-07-28` for every endpoint this client calls.
- **`ghl-connect`/`ghl-disconnect` are not wired through `_shared/auth.ts`'s `requireOrgRole`**, same reasoning as `telnyx-connect`/`telnyx-disconnect`: they do their own direct `org_members` owner check.

## Not covered here

- The dial engine, dispositions, and wrap-up UI that will actually call `enqueue_crm_job` → not yet built (Phase 3, eng2). The worker that would drain what they enqueue exists and is tested, but nothing calls it in production yet.
- Telnyx account connection → `.brain/domains/telephony.md`. Org/role/invite plumbing `ghl-connect` reuses → `.brain/domains/auth.md`.

## Unverified

- GHL's exact `contacts.dnd` channel-level (`dndSettings`) vs. blanket semantics — `setDnd` only ever writes the blanket flag, unexercised per-channel. Also unverified: `GET /contacts/`'s response schema in GHL's own spec omits `firstName`/`lastName`/`phone`/`dnd` (only `GET /contacts/{id}`'s schema has them) -- `ghl-import.ts` assumes the real response includes them anyway; fallback direction → `ghl-client.ts`'s header.

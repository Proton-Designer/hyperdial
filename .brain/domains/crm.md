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
  - apps/web/src/components/Settings.tsx
  - apps/web/src/lib/api.ts
related:
  - domain.auth
  - domain.campaigns
  - arch.system-overview
answers:
  - "how does an org connect its GHL sub-account"
  - "where is the GHL Private Integration Token stored"
  - "how does a disposition reach GHL"
  - "what payload shape does enqueue_crm_job expect for a disposition job"
  - "why is there no pg_cron worker draining crm_sync_jobs yet"
covers: "GHL (GoHighLevel) connect/disconnect, the org_integrations token store, and the crm_sync_jobs push outbox contract."
excludes: "The disposition/wrap-up UI that will call enqueue_crm_job, and the pg_cron worker that drains crm_sync_jobs into real GHL API calls -- both are separate, not-yet-built tasks (see Not covered here)."
tokens_est: 2419
source_hash: fba225d25be200d588e62cf158889e3d2bce0d110bd8763fceb94cc6c27e3766
---

# CRM Sync (GHL)

## Purpose

Each org can connect exactly one GoHighLevel (GHL) sub-account via a Private
Integration Token (design §6). Once connected, every call disposition is
meant to push a note, a tag, a callback task and a DND flag into that GHL
sub-account -- but this domain, as it exists today, only covers the
**connect/disconnect flow and the storage contract** a disposition write
lands in. Nothing drains that outbox into real GHL API calls yet.

## Key concepts

| Term | Means |
|---|---|
| Private Integration Token | A GHL-issued bearer token scoped to one sub-account (location), pasted in by the org owner. Not OAuth -- there is no refresh flow. |
| Location | GHL's term for a sub-account. `org_integrations.location_id` is confirmed against the token at connect time, not just trusted from user input. |
| Outbox | `crm_sync_jobs` -- rows enqueued by `enqueue_crm_job`, meant to be drained by a worker that doesn't exist yet. Exists so a GHL outage never blocks the dialer. |
| Disposition job | `kind='disposition'` outbox row. Its `payload` shape is fixed below; `apply_leg_outcome`/dispositions code (Phase 3, eng2) is the intended caller. |

## Where the code lives

| What | Path | Notes |
|---|---|---|
| Token storage + outbox schema | `supabase/migrations/20260924000900_ghl_integration_outbox.sql` | `org_integrations`, `crm_sync_jobs`, `enqueue_crm_job` |
| Vault-naming + dedupe fix | `supabase/migrations/20260924001200_ghl_integration_fixes.sql` | See Constraints below |
| Connect / disconnect functions | `supabase/functions/ghl-connect/`, `supabase/functions/ghl-disconnect/` | Owner-only, same shape as `telnyx-connect`/`telnyx-disconnect` |
| Typed LeadConnector client | `supabase/functions/_shared/ghl-client.ts` | contacts upsert/search, notes, tags, tasks, DND. Deno-tested (`ghl-client.test.ts`) with a stubbed `fetch`, no live GHL calls |
| Settings UI | `apps/web/src/components/Settings.tsx` (`IntegrationsTab`) | Connect form + status card, owner-only controls |
| Client wrappers | `apps/web/src/lib/api.ts` | `getGhlIntegrationStatus`, `connectGhl`, `disconnectGhl` |

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

This is the exact shape a future worker will map onto `ghl-client.ts`'s `addNote` (outcome, duration, agent, notes, recording link, transcript excerpt), `addTags` (the disposition as a tag), `createTask` (when `callback_at` is set) and `setDnd` (when the disposition is a DNC outcome). Written here per TASK-P3-P1's own requirement so the dispositions task (eng2, Phase 3) can call `enqueue_crm_job` without re-deriving this shape.

## Integration points

| Direction | With | Via |
|---|---|---|
| Depends on | `domain.auth` | `private.is_org_member`, `has_org_role`, the org-owner check |
| Depended on by | Dispositions (not yet built) | `enqueue_crm_job(org, 'disposition', ...)` |
| Depended on by | Contact import/pull (not yet built) | `ghl-client.ts`'s `searchContacts`/`upsertContact` |
| External | GHL LeadConnector API v2 | `https://services.leadconnectorhq.com`, bearer token, `Version: 2021-07-28` header |

## Constraints & gotchas

- **`vault.secrets.name` has a unique index `WHERE name IS NOT NULL`.** The first version of `set_org_ghl_token` named every secret deterministically (`'org_ghl_token_' || org_id`); a second `vault.create_secret` call under that same name (disconnect-then-reconnect, or two racing `ghl-connect` calls) would collide. Fixed in `20260924001200`: secrets are created with no name. Nothing looks a secret up by name, only by `org_integrations.token_secret_id`.
- **`crm_sync_jobs` dedupes on `(call_leg_id, kind)`**, via a unique partial index (`WHERE call_leg_id IS NOT NULL`) plus `ON CONFLICT ... DO NOTHING` in `enqueue_crm_job`. A retried disposition write for the same call leg is a no-op, not a duplicate GHL note. `contact_upsert` jobs (no `call_leg_id`) are never deduped by this index.
- **`GET /contacts/` is used for search, not `POST /contacts/search`.** GHL's own published OpenAPI spec (`GoHighLevel/highlevel-api-docs`) leaves `POST /contacts/search`'s request body completely undocumented (`SearchBodyV2DTO` has no declared properties); `GET /contacts/`'s query params (`locationId`, `query`, `limit`, `startAfterId`, `startAfter`) are fully typed in the same spec.
- **The docs *site* (`marketplace.gohighlevel.com/docs`) is not a reliable source for the `Version` header value.** It's a client-rendered Docusaurus app; fetching it without JS returns page-shell metadata whose `docs-version-v3` (the doc site's own version) can be misread as the API's required `Version` header. The real value, confirmed from the OpenAPI spec, is `2021-07-28` for every endpoint this client calls.
- **`ghl-connect`/`ghl-disconnect` are not wired through `_shared/auth.ts`'s `requireOrgRole`**, same reasoning as `telnyx-connect`/`telnyx-disconnect`: they do their own direct `org_members` owner check.

## Not covered here

- The dial engine, dispositions, and wrap-up UI that will actually call `enqueue_crm_job` → not yet built (Phase 3, eng2, per the design's build-plan table).
- The pg_cron worker that drains `crm_sync_jobs` into real `ghl-client.ts` calls with retry/backoff → not yet built. `crm_sync_jobs.status`/`attempts`/`next_run_at`/`last_error` exist for it to use.
- "Import from GHL" (pull by tag/search into `contacts`) → not yet built. `ghl-client.ts`'s `searchContacts`/`upsertContact` are ready for it.
- Telnyx account connection → `.brain/domains/telephony.md`.
- Org/role/invite plumbing `ghl-connect` reuses → `.brain/domains/auth.md`.

## Unverified

- GHL's exact `contacts.dnd` semantics when a location's DND settings distinguish channel-level DND (`dndSettings`) from the blanket `dnd` boolean this client sets — `setDnd` only ever writes the blanket flag, matching the design's "turns DND on for DNC" requirement; per-channel DND is unexercised.

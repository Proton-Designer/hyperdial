---
id: arch.service-map
title: Service Map
layer: L2
type: architecture
status: canonical
owner: maintainer
updated: 2026-09-27
sources:
  - supabase/functions/**
  - supabase/config.toml
related:
  - arch.system-overview
  - arch.dependency-graph
  - domain.auth
answers:
  - "what endpoints exist"
  - "which function handles X"
  - "which functions are authenticated"
  - "where do I add a new endpoint"
  - "which function is the biggest risk to change"
covers: "Every Edge Function: purpose, auth posture, dependencies, and risk"
excludes: "Public URLs and deploy commands (see docs/reference/edge-functions.md), dial-loop internals (see domain.dialer)"
tokens_est: 2400
---

# Service Map

**47 Edge Functions** as of Mission 4 (2026-09-27), all in
`supabase/functions/<name>/index.ts`, all Deno, all stateless. There are no
other services. (This doc previously said 16 — that count was stale by
several missions' worth of work; verified by diffing `ls supabase/functions/`
against this doc before rewriting.)

## Auth posture — read this first

Two independent layers, routinely confused:

| Layer | Mechanism | Where configured |
|---|---|---|
| **Gateway** | Supabase rejects the request before your code runs | `verify_jwt` in `supabase/config.toml` |
| **In-function** | The function validates the caller's token itself | `supabase/functions/_shared/auth.ts`, or a per-domain wrapper (`requireTelnyxOrgRole`) |

**Most functions in this repo now have `verify_jwt = false`** — not because
most are unauthenticated, but because almost every function does its own
in-function check (JWT-based for user-facing endpoints, a shared-secret
header for cron/webhook-triggered ones) rather than relying on the gateway.
Only `telnyx-webhook` is genuinely unauthenticated today (see
`.brain/memory/known-issues.md` #0 — its signature check fails open).

> Turning gateway verification off does **not** mean an endpoint is open. Read
> the function before concluding anything about its auth posture.

Two auth shapes, by caller:

- **User-facing** (a signed-in org member): JWT-based, via `_shared/auth.ts`'s
  `requireOrgRole` (generic) or `_shared/telnyx-org-context.ts`'s
  `requireTelnyxOrgRole` (also resolves the org's connected Telnyx client in
  the same call — used by every Telnyx-touching or dialer function).
- **System-triggered** (pg_cron/pg_net, or Telnyx itself): a shared secret
  header (`X-Cron-Secret` or similar), checked with `timingSafeEqual` and
  failing closed if the expected secret is unset. See
  `.brain/tooling/integrations.md` for the full list of secrets by name.

## Dialer — session lifecycle

| Function | Auth | Purpose | Risk |
|---|---|---|---|
| `dialer-session-start` | JWT | Creates a session, fires batch 1. Enforces the high-lines drop-rate guard (TASK-S2). | **High** |
| `dialer-session-stop` | JWT | Ends a session, returns a summary, clears state | **High** |
| `dialer-session-pause` / `dialer-session-resume` | JWT | Pause/resume batch advance | Low |
| `dialer-session-hangup-live` | JWT | Hangs up the bridged agent leg | Medium |
| `dialer-session-reconnect` | JWT | AUD-5: redials a fresh agent leg into an existing conference after `paused_agent_lost` | Medium |
| `dialer-session-disposition` | JWT | Submits a wrap-up disposition for a call leg; drives retry/callback/DNC effects | **High** |
| `dialer-session-recording` | JWT | TASK-T8: pause/resume recording mid-call (Telnyx `record_pause`/`record_resume`) | Medium |
| `dialer-session-get` | JWT | Reads current session + batch state | Low |
| `dialer-session-active` | JWT | Returns the caller's in-flight session; blocks a second concurrent one | Low |
| `dialer-coaching` | JWT (owner/admin) | TASK-T3: Listen/Whisper/Barge — dials the manager's own WebRTC leg into a member's live conference as a Telnyx supervisor participant. Orchestration in `_shared/coaching-core.ts`. | **High** |
| `dialer-transfer` | JWT (owner/admin/agent, own session only) | TASK-T4: hold + warm/cold transfer, built on conference-native join/leave/hold (not Telnyx's bridge-shaped `transfer` command — verified against spec3.json as unsafe for a persistent conference). Orchestration in `_shared/transfer-core.ts`. | **High** |
| `dialer-sweeper` | Shared secret (cron, 30s) | Reconciles state a lost webhook otherwise strands forever (`_shared/dialer-engine.ts`'s own carried gap) | Medium |

## Telephony

| Function | Auth | Gateway | Purpose | Risk |
|---|---|---|---|---|
| `telnyx-webhook` | **signature only (fails open — #0)** | `verify_jwt=false` | Receives all Telnyx call events; drives the dial loop | **Highest** |
| `telnyx-connect` / `telnyx-disconnect` | JWT (owner-only) | `verify_jwt=false` | Validates and stores/clears the org's own BYO Telnyx key + provisioned resources | **High** |
| `telnyx-webrtc-credentials` | JWT (in-function) | `verify_jwt=false` | Mints/reuses the agent's WebRTC login token (get-or-create, persisted per member) | Medium |
| `telnyx-search-numbers` / `telnyx-list-numbers` | JWT (in-function) | `verify_jwt=false` | Search/list purchasable or owned numbers | Low |
| `telnyx-purchase-number` | JWT (owner/admin) | `verify_jwt=false` | **Spends money.** Buys a number on the org's Telnyx account | **High** |
| `telnyx-spend-status` | JWT (owner/admin) | `verify_jwt=false` | Current balance + MTD spend (a live Telnyx call, not cached) | Low |
| `telnyx-billing` | JWT (owner/admin) | `verify_jwt=false` | TASK-BF1: add funds + auto-recharge. Thin shell; orchestration (validation, idempotency, audit rows) in `_shared/billing-core.ts` | **High — moves real money** |
| `number-health-check` | JWT (on-demand, owner/admin) or shared secret (weekly cron) | not set | TASK-T9 (CID-4): flags/rests a pool number whose 30-day human-answer rate is well below the pool median. Disabled by default. | Medium |
| `voicemail-upload` | JWT (`requireOrgRole`) | not set | VMD-1: upload/re-fetch a signed preview URL for a voicemail-drop recording | Low |
| `recording-url` | JWT (in-function, mirrors `call_legs` RLS) | not set | The ONLY read path for the private `recordings` Storage bucket — no direct client access exists otherwise | Medium |
| `recording-retention` | Shared secret (cron, daily 03:17) | not set | REC-6: deletes recordings older than 90 days via the Storage API | Medium |

## Contacts

| Function | Auth | Purpose | Risk |
|---|---|---|---|
| `contacts-parse-csv` | JWT | Parses CSV, proposes a column mapping. Writes nothing. | Low |
| `contacts-import` | JWT | Validates, de-duplicates, inserts | Medium — bulk writes |

## Analytics

| Function | Auth | Purpose | Risk |
|---|---|---|---|
| `dashboard-stats` | JWT (in-function) | Aggregate counters for the Dashboard, reads `call_leg_analytics` | Low |
| `team-performance` | JWT (in-function) | Time-series for the Team page live board + daily numbers | Low |
| `analytics-summary` | JWT (in-function) | The real backend for the Analytics screen (funnel/volume/dispositions/agent performance) | Low |
| `ensure-week-summary` | JWT (in-function) | Idempotently materializes the current week's summary | Low |

TASK-T11 (funnel/best-time-to-call heatmap/connect-rate-by-number-or-hour/CSV
export) added no new Edge Function — it's four `SECURITY DEFINER` SQL
functions (`funnel_summary`, `answer_rate_heatmap`, `connect_rate_by_number`,
`connect_rate_by_hour`) called directly via `supabase.rpc()` from
`analytics-summary`'s existing caller, `Analytics.tsx`. See
`.brain/domains/analytics.md`.

## GHL / CRM integration

| Function | Auth | Purpose | Risk |
|---|---|---|---|
| `ghl-connect` / `ghl-disconnect` | JWT (owner-only) | Validates and stores/clears the org's GHL Private Integration Token | **High** |
| `ghl-import` | JWT (admin+) | "Import from GHL" / "Re-sync": pages the connected sub-account by tag or search, dedupes, upserts into `contacts` | Medium — bulk writes |
| `ghl-update-blocked-tags` | JWT (owner/admin) | Edits the DNC/paused GHL tag lists (`org_integrations.ghl_dnc_tags`/`ghl_paused_tags`) | Medium |
| `ghl-field-suggestions` | JWT (owner/admin) | TASK-T1 (GHL-6): lists the connected location's real custom-field defs + a suggested target-key mapping. Read-only. | Low |
| `ghl-list-pipelines` | JWT (owner/admin) | TASK-T1 (GHL-4): lists the connected location's pipelines/stages, flattened, for the stage-mapping picker. Read-only. | Low |
| `ghl-update-pull-settings` | JWT (owner/admin) | TASK-T1 (GHL-5/6): edits `ghl_pull_enabled` + the custom field mapping | Medium |
| `ghl-pull-worker` | Shared secret (cron, 5 min) | TASK-T1 (GHL-5): the scheduled GHL pull, disabled per-org by default (`ghl_pull_enabled`) | Medium |
| `ghl-sync-now` | JWT (owner/admin) | TASK-T1 (GHL-5): on-demand "Sync now" — runs the same pull core as the cron worker, regardless of the enabled flag, synchronously | Medium |
| `ghl-sync-worker` | Shared secret (cron, 60s) | The GHL **push** outbox worker (disposition → note/tag/task/DND), claims `crm_sync_jobs` via `FOR UPDATE SKIP LOCKED` | Medium |

## Org / auth

| Function | Auth | Purpose | Risk |
|---|---|---|---|
| `org-invite-create` | JWT (owner/admin) | Creates a time-limited invite token | Medium |
| `org-invite-accept` | Public (token-based, not a JWT) | Accepts an invite, creates the membership | **High** — the one function that legitimately has no signed-in caller yet |
| `org-members` | JWT (owner/admin) | Lists/updates member roles | Medium |

## Reliability & spend guards (system-triggered, no user JWT)

All four of these share one shape: a `pg_cron` tick calls a `private.trigger_*`
SQL function, which does a shared-secret `net.http_post` to the Edge
Function; the function calls one `SECURITY DEFINER` RPC that decides-and-acts
atomically (so two overlapping cron runs can never double-act), then fans out
`notifications` rows to the affected org's owners/admins. New automatic
behavior in every case ships opt-in/disabled by default.

| Function | Cadence | Purpose | Risk |
|---|---|---|---|
| `reliability-alert-check` | 5 min (unset until the lead wires it) | TASK-T10: stuck-dial-session + webhook-error-spike alerts, both per-org opt-in | Low — read + notify only |
| `spend-alert-check` | Hourly | TASK-SP: low-balance alert (in-app notification only — no email integration exists in this repo, verified) | Low |
| `campaign-lines-guard-check` | 5 min | TASK-S2: auto-reduces a campaign's `lines` back to 7 (and disables the guard) if its trailing drop rate exceeds 3% | Medium — mutates campaign config automatically |

## Shared modules

Not deployable. Bundled into each function that imports them.

| Module | Imported by | Notes |
|---|---|---|
| `supabase/functions/_shared/dialer-engine.ts` | **11** functions (verified via grep, not the stale "4" this doc used to say — see `.brain/memory/known-issues.md` #36) | The dial loop. **The most consequential file in the repo.** |
| `supabase/functions/_shared/telnyx.ts` + `telnyx-org-context.ts` | 20 functions | Call Control client + org-scoped Telnyx client/role resolution (`requireTelnyxOrgRole`) |
| `supabase/functions/_shared/redis.ts` | several | Upstash REST client, key scheme, `claimHumanAnswer` |
| `supabase/functions/_shared/dialer-events.ts` | several | Realtime broadcast publisher |
| `supabase/functions/_shared/amd.ts` | via engine | Answering-machine-detection result interpretation |
| `supabase/functions/_shared/auth.ts` | 21 functions | JWT verification + `requireOrgRole`. Excludes `telnyx-*`/`dialer-*`, which use the Telnyx-aware wrapper instead. |
| `supabase/functions/_shared/cors.ts` | all 48 (every function) | CORS headers. **Must be returned on error paths too.** |
| `supabase/functions/_shared/coaching-core.ts` | `dialer-coaching` | TASK-T3 orchestration, deno-tested (the `index.ts` shell itself is not) |
| `supabase/functions/_shared/transfer-core.ts` | `dialer-transfer` | TASK-T4 orchestration, deno-tested |
| `supabase/functions/_shared/billing-core.ts` | `telnyx-billing` | TASK-BF1 orchestration, deno-tested |
| `supabase/functions/_shared/ghl-client.ts`, `ghl-pull-run.ts`, `ghl-import.ts`, `ghl-field-mapping.ts` | the `ghl-*` functions | GHL API client + pure planners (paging/dedupe/field-mapping), each independently deno-tested |

## Adding a function

1. `supabase/functions/<name>/index.ts`.
2. Import `corsHeaders` from `supabase/functions/_shared/cors.ts` and return them on **every** path,
   including errors — a function that omits them on a 500 turns a readable server
   error into an opaque CORS failure in the browser.
3. Import the auth helper from `supabase/functions/_shared/auth.ts` (`requireOrgRole`) unless the
   function is Telnyx-specific (use `requireTelnyxOrgRole` from `_shared/telnyx-org-context.ts`
   instead) or system-triggered (a shared-secret header, fail-closed if unset).
4. Add a typed wrapper in `apps/web/src/lib/api.ts`. There is no generated
   client; this is the only place the contract is written down.
5. A system-triggered function (cron/webhook) needs an explicit
   `[functions.<name>] verify_jwt = false` entry in `supabase/config.toml` —
   missing it means a real deployed gateway 401s before your own auth check
   ever runs, and nothing catches this locally (see
   `.brain/memory/known-issues.md`).
6. Deploy: `npx supabase functions deploy <name>`.

## Unverified

- Risk ratings are this author's judgment based on blast radius and side effects,
  not an incident history. There is no incident record in the repo.
- Exact `_shared` line counts were not individually re-measured this pass; only
  dependent-function counts were (via grep, listed above).

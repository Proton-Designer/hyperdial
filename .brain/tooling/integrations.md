---
id: tool.integrations
title: Integrations
layer: L2
type: tooling
status: canonical
owner: maintainer
updated: 2026-09-27
sources:
  - supabase/functions/_shared/**
  - apps/web/src/lib/**
  - supabase/functions/ghl-*/index.ts
  - supabase/functions/dialer-sweeper/index.ts
  - supabase/functions/ghl-sync-worker/index.ts
  - supabase/functions/spend-alert-check/index.ts
  - supabase/functions/recording-retention/index.ts
  - supabase/functions/ghl-pull-worker/index.ts
  - supabase/functions/reliability-alert-check/index.ts
  - supabase/functions/campaign-lines-guard-check/index.ts
  - supabase/functions/number-health-check/index.ts
related:
  - tool.registry
  - domain.telephony
  - arch.system-overview
answers:
  - "what external services does this use"
  - "where do I configure Telnyx"
  - "what happens if Redis goes down"
  - "what third-party accounts do I need"
  - "where is the Telnyx API reference"
covers: "Every external service this system depends on, how it is configured, and how it fails"
excludes: "Commands (see tool.registry), Telnyx call semantics (see domain.telephony), variable-by-variable detail (see docs/reference/environment-variables.md)"
tokens_est: 2100
source_hash: d4b4e79a54ac884b9b9fe6639e702c06d5ceeabb839ad59782d3cb9385314d65
---

# Integrations

Four external services. Three are required for the app to function at all.

## Supabase — required

Auth, Postgres, Realtime, and the Edge Function runtime. There is no server of
our own; Supabase *is* the backend.

| Piece | Used for |
|---|---|
| Auth | Email/password sessions; `auth.uid()` scopes every RLS policy |
| Postgres | Dozens of tables, all RLS-scoped (see `.brain/architecture/service-map.md` for the current count context) |
| Edge Functions | All 47 endpoints as of Mission 4 (2026-09-27; see `.brain/architecture/service-map.md`), Deno |
| Realtime | Broadcast channel `dialer:user:<userId>` for live dial events |

**Config:** `supabase/config.toml`, plus `VITE_SUPABASE_URL` /
`VITE_SUPABASE_ANON_KEY` in the client and `SUPABASE_SERVICE_ROLE_KEY` server-side.

**Fails:** total outage. Nothing works.

## Telnyx — required

Outbound dialing, answering-machine detection, call bridging, and the agent's
WebRTC audio leg.

| Product | Env var | Used by |
|---|---|---|
| Voice API / Call Control Application | `TELNYX_CONNECTION_ID` | Outbound dialing |
| SIP credential connection | `TELNYX_CREDENTIAL_CONNECTION_ID` | WebRTC agent leg |
| API key | `TELNYX_API_KEY` | All REST calls |
| Webhook signing secret | `TELNYX_WEBHOOK_SECRET` | Verifying inbound events |

> **The two connection IDs are different things from different Telnyx products
> and swapping them is the single most common misconfiguration in this project.**
> `TELNYX_CONNECTION_ID` must be the **Application ID** of a Voice API / Call
> Control Application that has a webhook URL set. Using the SIP credential
> connection ID makes Telnyx reject calls with `TELNYX_CONNECTION_REJECTED`
> (`_shared/telnyx.ts:68` raises this with an explanatory message).

**Webhook target:**
`https://<project-ref>.supabase.co/functions/v1/telnyx-webhook` — set as both the
primary and failover URL on the Call Control Application.

**Fails:** no outbound calls. If only WebRTC fails, calls connect but the agent
hears nothing.

**Setup guide:** `docs/guides/telnyx-call-control-setup.md`.

## Upstash Redis — required for the dialer

Live call and session state over the REST API (not a TCP client — Edge Functions
cannot hold a socket pool).

**Config:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`. Legacy
`REDIS_URL` / `REDIS_TOKEN` are still read as fallbacks (`_shared/redis.ts:50`).

**Fails:** new dial sessions cannot start; in-flight sessions lose the
single-winner claim that keeps two humans from being bridged to one agent.
**Durable history is unaffected** — Redis holds no system of record.

## GoHighLevel (GHL) — optional, per-org

CRM sync: pulling contacts in, pushing dispositions/notes/tags/tasks back out.
Entirely opt-in per org (`org_integrations.status`, `ghl_pull_enabled`) — an
org with no GHL connection is completely unaffected.

| Piece | Used for |
|---|---|
| Private Integration Token (Vault-stored) | All LeadConnector API calls, via `_shared/ghl-client.ts` |
| `org_integrations` | Connection status, location id/name, pull/push settings, blocked-tag lists |

**Config:** no env vars — the token is entered per-org through the UI
(`ghl-connect`) and stored in Supabase Vault, never in `.env`.

**Fails:** pull/push simply stop; nothing in the dial loop depends on GHL.

## pg_cron / pg_net workers — shared-secret, no user JWT

Every background worker below is triggered by a `pg_cron` schedule calling a
`private.trigger_*` SQL function, which does a `net.http_post` to its Edge
Function with a shared secret in a header (`X-Cron-Secret` or similar) — the
function fails closed if its expected secret env var is unset. **One-time
setup per worker** (the lead's job, not an engineer's): call
`private.set_<worker>_config(p_url, p_secret)` once with the deployed
function's real URL and a freshly generated secret matching the function's
own env var. Until that's run, the cron tick is a documented no-op.

| Worker (cron job name) | Schedule | Secret env var (name only — see the project's secret manager for values) | Config RPC |
|---|---|---|---|
| `dialer-sweeper` | every 30s | `DIALER_SWEEPER_SECRET` | `private.set_dialer_sweeper_config` |
| `ghl-sync-worker` | every 1 min | `CRM_SYNC_WORKER_SECRET` | `private.set_crm_sync_worker_config` |
| `spend-alert-check` | hourly (:23) | `SPEND_ALERT_SECRET` | `private.set_spend_alert_config` |
| `recording-retention` | daily 03:17 | `RECORDING_RETENTION_SECRET` | `private.set_recording_retention_config` |
| `ghl-pull-worker` (Mission 4, TASK-T1) | every 5 min | `GHL_PULL_WORKER_SECRET` | `private.set_ghl_pull_worker_config` |
| `reliability-alert-check` (Mission 4, TASK-T10) | every 5 min | `RELIABILITY_ALERT_SECRET` | `private.set_reliability_alert_config` — **not yet wired to the live project** |
| `campaign-lines-guard-check` (Mission 4, TASK-S2) | every 5 min | `HIGH_LINES_GUARD_SECRET` | `private.set_high_lines_guard_config` |
| `number-health-check` (Mission 4, TASK-T9) | weekly, Mon 08:00 | `NUMBER_HEALTH_CHECK_SECRET` | `private.set_number_health_check_config` |

All 8 secrets are independent (a separate Vault-backed config row and env var
each) — never reused across workers, since each points at a different
function URL.

## Figma — historical, not live

The web client began as a Figma Make export ("Parallel Dialer SaaS Web App").
`apps/web/src/components/figma/ImageWithFallback.tsx` is a leftover. There is no
live Figma integration and no design-token sync; `globals.css` is now the source
of truth for design tokens.

## Reference material in the repo

| Path | What |
|---|---|
| `vendor/` → telnyx-agent-skills | Telnyx's own API skill docs, 269 files, git submodule. Reference only — no code imports it. |
| `.cursor/skills/` | 12 Telnyx JavaScript skill docs for Cursor. Appears to be a subset of the above; see the *Smaller items* section of `.brain/memory/known-issues.md`. |
| `.cursor/rules/telnyx-integration.mdc` | Cursor rule file for Telnyx work |
| `vendor/` → agent-brain | This knowledge base's tooling |

## Not integrated

**Stale claim corrected (2026-09-27, code disagreed with this doc — CLAUDE.md's
own rule):** this used to say "no payment processor." There is no separate
payment processor (Stripe etc.), but `telnyx-billing` (TASK-BF1) DOES move
real money — it calls Telnyx's own balance/payment-method APIs directly to
add funds and manage auto-recharge, owner/admin only. See
`.brain/architecture/service-map.md`.

Still genuinely not integrated: no error-tracking service, no
analytics/telemetry SDK, no email provider beyond Supabase Auth's built-in
delivery, and no CI provider.

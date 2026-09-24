---
id: domain.telephony
title: Telephony
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-21
sources:
  - supabase/functions/_shared/telnyx.ts
  - supabase/functions/_shared/telnyx-client.ts
  - supabase/functions/_shared/telnyx-org-context.ts
  - supabase/functions/_shared/telnyx-provision.ts
  - supabase/functions/telnyx-*/index.ts
  - supabase/migrations/20250208000001_create_user_phone_numbers.sql
  - supabase/migrations/20260924000400_create_org_telephony.sql
  - apps/web/src/lib/useTelnyxCall.ts
  - apps/web/src/contexts/PhoneNumbersContext.tsx
related:
  - domain.dialer
  - domain.auth
  - arch.system-overview
answers:
  - "which Telnyx connection ID goes in which env var"
  - "why does dialing fail with TELNYX_CONNECTION_REJECTED / INVALID_TELNYX_CONNECTION"
  - "how is a WebRTC token minted for the agent's browser"
  - "why is telnyx-webhook deployed with --no-verify-jwt"
  - "how is the Telnyx webhook signature verified, and when does it fail open"
  - "how does a user buy a phone number and where is it stored"
  - "how does the agent's leg join the conference"
  - "what legacy Telnyx env var names are still honoured"
covers: "Telnyx account wiring (API key, the two connection IDs, webhook auth), phone-number search/purchase/listing, and the agent's WebRTC browser leg."
excludes: "The parallel dial loop itself — batching, AMD, call_logs state machine, Redis session state — see .brain/domains/dialer.md."
tokens_est: 4711
source_hash: fa8aad01699e4a27ccbf804d7858327fba81e966269e086c39e070d86a23cad3
---

# Telephony

## Purpose

Softdial places and receives real phone calls through Telnyx. This domain covers everything that touches the Telnyx account: authenticating to their API, owning the two different
"connection" objects Telnyx exposes, letting a user buy a caller-ID number, and putting the agent's own voice on the call from the browser.

## Key concepts

| Term | Means |
|---|---|
| Call Control Application | Telnyx "Voice API Application". Has a webhook URL; its **Application ID** is what `POST /calls` and `POST /conferences` want as `connection_id`. The **old** dial engine (`_shared/telnyx.ts`, still what actually runs calls today) reads it from `TELNYX_CONNECTION_ID`. The **new**, org-scoped functions (TASK-P1-06, see below) read the org's own `org_telephony.call_control_app_id` instead -- no env var. |
| Credential connection | A Telnyx **SIP credential connection**. Used only to mint WebRTC telephony credentials and to attach purchased numbers. Old engine: `TELNYX_CREDENTIAL_CONNECTION_ID` env var. New, org-scoped: `org_telephony.credential_connection_id`. |
| BYO Telnyx key (design §3) | Each org supplies its own Telnyx API key, provisioned once via `telnyx-connect` (`_shared/telnyx-provision.ts`) and stored in Vault (`org_telephony`, `private.set_org_telnyx_key`/`get_org_telnyx_key`). The four number/WebRTC functions below build a fresh `TelnyxClient` (`_shared/telnyx-client.ts`) per request from the org's own key -- never a global env var. |
| `call_control_id` | Telnyx's per-leg handle. Every action (`join_conference`, `hangup`) is `POST /calls/{call_control_id}/actions/...`. |
| Agent leg | The agent's audio. Two independent mechanisms: a **WebRTC** browser leg (click-to-dial) or a **PSTN callback leg** dialled to `agentCallbackNumber` and joined to the conference. |

## Where the code lives

| What | Path | Notes |
|---|---|---|
| Telnyx REST client (old engine) | `supabase/functions/_shared/telnyx.ts` | env-var API key + connection-ID resolution, `POST /calls`, conferences, hangup -- still what the running dial loop uses |
| Telnyx REST client (BYO key) | `supabase/functions/_shared/telnyx-client.ts` | Per-org client (TASK-P1-04/06); no env var, takes the key as an argument |
| Org context + connected-client helper | `supabase/functions/_shared/telnyx-org-context.ts` | `requireTelnyxOrgRole` (org+role resolution, telnyx-*/dialer-* don't use `_shared/auth.ts`'s `requireOrgRole`, TASK-P1-02's own scope note) + `getConnectedOrgTelnyxContext` (builds a `TelnyxClient` from `org_telephony`) |
| Org Telnyx connect/disconnect | `supabase/functions/telnyx-connect/`, `telnyx-disconnect/` | Owner-only; provisions/stores the org's key + resource ids (TASK-P1-05) |
| Number search | `supabase/functions/telnyx-search-numbers/index.ts` | Org-scoped (TASK-P1-06); any active org member; `_shared/telnyx-client.ts`'s `searchNumbers` |
| Number purchase | `supabase/functions/telnyx-purchase-number/index.ts` | Org-scoped, owner/admin only; orders against the org's `call_control_app_id`, inserts with `org_id` |
| Number listing | `supabase/functions/telnyx-list-numbers/index.ts` | Reads Postgres only — never Telnyx; filters by `org_id` |
| WebRTC token mint | `supabase/functions/telnyx-webrtc-credentials/index.ts` | Get-or-create per (org, member) via `org_members.telnyx_credential_id`; no more per-call credential leak |
| Webhook ingress | `supabase/functions/telnyx-webhook/index.ts` | Signature check `:32-73`; agent-leg join `:142-186` |
| Browser WebRTC leg | `apps/web/src/lib/useTelnyxCall.ts` | `@telnyx/webrtc` `TelnyxRTC`; consumed by `apps/web/src/components/Dialer.tsx` |
| Number cache (client) | `apps/web/src/contexts/PhoneNumbersContext.tsx` | Preloads once per sign-in; `usePhoneNumbers()` |
| Schema | `supabase/migrations/20250208000001_create_user_phone_numbers.sql` | `user_phone_numbers`, RLS per `auth.uid()` |
| Docs | `docs/reference/environment-variables.md`, `docs/guides/telnyx-call-control-setup.md` | Env table; portal walkthrough |

## How it works

1. **Connect the org's Telnyx account** — owner pastes an API key + webhook public key into Settings → Telephony; `telnyx-connect` validates the key, provisions (or reuses) the
   outbound voice profile / Call Control Application / credential connection (`_shared/telnyx-provision.ts`), and stores everything in `org_telephony` (key in Vault).
2. **Buy a number** — `telnyx-search-numbers` lists availability against the org's own key; `telnyx-purchase-number` (owner/admin only) orders it *against the org's Call Control
   Application* (`org_telephony.call_control_app_id` -- the same connection the webhook already routes through, not the WebRTC credential connection) and inserts a
   `user_phone_numbers` row with `org_id` + the purchasing member's `user_id` for attribution.
3. **Cache it** — `PhoneNumbersContext` calls `listPhoneNumbers()` (`apps/web/src/lib/api.ts`) once per sign-in; the dialer and campaign UIs pick a caller ID from it. This is a pure
   DB read, org-scoped, and works even if the org's Telnyx connection is later disconnected.
4. **Mint a WebRTC token** — `telnyx-webrtc-credentials` get-or-creates one telephony credential per (org, member), persisted in `org_members.telnyx_credential_id`, then
   `client.mintCredentialToken()` (`POST /telephony_credentials/{id}/token`, a raw JWT `text/plain` response). No credential is ever created twice for the same member.
5. **Connect the browser** — `connect()` fetches that token and builds `new TelnyxRTC({ login_token })` (`apps/web/src/lib/useTelnyxCall.ts:46-49`); `dial()` calls `client.newCall()`.
6. **Server-side dialing (old engine, still what actually runs calls)** — `dialOutboundCall()` posts to `/calls` with `connection_id` from `getTelnyxConnectionId()`
   (`TELNYX_CONNECTION_ID` env var, unrelated to the org-scoped `org_telephony.call_control_app_id` above) and `webhook_url` = `<SUPABASE_URL>/functions/v1/telnyx-webhook`
   (`supabase/functions/_shared/telnyx.ts:115-148`, `supabase/functions/dialer-session-start/index.ts:252`). TASK-P2-E2 is expected to switch this to the org-scoped client too.
7. **Webhook returns** — `telnyx-webhook` verifies the signature, ACKs `200` immediately and processes in a `queueMicrotask` (`:376-384`). An answered agent-callback leg is joined to the
   session's `conference_name` (`:142-186`), or hung up if the conference is unknown.

## Integration points

| Direction | With | Via |
|---|---|---|
| Depends on | `domain.auth` | `getUserFromRequest()` (`_shared/auth.ts`) guards every `telnyx-*` function, via `_shared/telnyx-org-context.ts`'s `requireTelnyxOrgRole` for the four number/WebRTC ones -- not `requireOrgRole` itself, which TASK-P1-02 excludes `telnyx-*`/`dialer-*` from |
| Depends on | Supabase Postgres | `user_phone_numbers`, `dialer_sessions.conference_name` |
| Depended on by | `domain.dialer` | `dialOutboundCall`, `createConference`, `joinCallToConference`, `hangupCall` |
| External | Telnyx | REST `https://api.telnyx.com/v2`, `npm:telnyx@4` SDK, `@telnyx/webrtc`, inbound webhooks |

## Constraints & gotchas

- **The two connection IDs are different Telnyx products and are not interchangeable.** `TELNYX_CONNECTION_ID` = the **Application ID** of a Call Control / Voice API Application *that has a
  webhook URL*, read by `getTelnyxConnectionId()` (`supabase/functions/_shared/telnyx.ts:29-34`) and used for `POST /calls` and `POST /conferences`. `TELNYX_CREDENTIAL_CONNECTION_ID` = a
  **SIP credential connection**, read only in `supabase/functions/telnyx-webrtc-credentials/index.ts:13` and `supabase/functions/telnyx-purchase-number/index.ts:24`. Put the credential
  connection in `TELNYX_CONNECTION_ID` and Telnyx answers `422 "Only Call Control Apps with valid webhook URL are accepted."`; `supabase/functions/_shared/telnyx.ts:66-70` rewrites that to
  `TELNYX_CONNECTION_REJECTED: …`, which `supabase/functions/dialer-session-start/index.ts:292-300` turns into HTTP `503 {code: "INVALID_TELNYX_CONNECTION"}` and
  `apps/web/src/lib/api.ts:642-647` renders. Unset entirely → `503 {code: "MISSING_TELNYX_CONNECTION_ID"}` (`supabase/functions/dialer-session-start/index.ts:157-164`).
- **Legacy fallback:** `TELNYX_CALL_CONTROL_CONNECTION_ID` is still honoured as an alias for `TELNYX_CONNECTION_ID` in both `supabase/functions/_shared/telnyx.ts:31` and
  `supabase/functions/dialer-session-start/index.ts:156`. It is checked *second* — if both are set, `TELNYX_CONNECTION_ID` wins.
- **`telnyx-webhook` is genuinely unauthenticated at both layers.** Telnyx has no Supabase session, so the gateway check is off (`supabase/config.toml:368-369`) and the function never calls
  `getUserFromRequest`. It must be deployed with `--no-verify-jwt` (`package.json:26` → `npm run functions:deploy:webhook`); a plain `functions deploy` re-enables gateway JWT and every
  Telnyx event starts 401-ing. The signature check is the *only* thing guarding the dial loop.
- **The signature check no longer fails open (TASK-P1-05, 2026-09-24, NEEDS-LIVE-VERIFY).** `telnyx-webhook/index.ts` reads `?org=` from the URL, loads that org's
  `webhook_public_key` from `org_telephony`, and verifies with `_shared/webhook-verify.ts`'s `verifyTelnyxSignature()` — real Ed25519 over `` `${timestamp}|${rawBody}` ``,
  a 300s replay window, and no fail-open branch (11 `deno test` cases in TASK-P1-04, including a positive control and a regression test that no such branch exists). A
  missing `?org=` is now also a hard 401, since there's no key to check against. Never tested against a real Telnyx account or against a running local DB — the
  `org_telephony` migration isn't applied yet. See known-issues #0. The legacy HMAC/shared-secret path described below no longer exists in the code.
- **The org-in-client_state cross-check has nothing to check yet for the current dial engine.** `decodeDialClientState` (new `{org, session, leg}` shape) is checked
  against `?org=` when it decodes, but today's engine (`_shared/dialer-engine.ts`) still builds the legacy `{userId, sessionId, contactId, campaignId, batchIndex}`
  shape, which has no `org` field — that only closes once Phase 2 rewrites the engine.
- **Historical, pre-fix behavior (context for the fix above):** the old `verifySignature` returned `true` when `TELNYX_WEBHOOK_SECRET` was unset, and returned `true`
  for ed25519-only requests after a `console.warn` — Telnyx Standard Webhooks sign with ed25519, not the shared-secret HMAC that code implemented. There was no replay
  window.
- **`joinCallToConference` calls a dead endpoint.** `_shared/telnyx.ts`'s `POST /calls/{id}/actions/join_conference` has zero matches in Telnyx's current OpenAPI spec
  (verified 2026-09-23). The correct call is `POST /conferences/{id}/actions/join` with `call_control_id` in the body — implemented correctly in the new
  `_shared/telnyx-client.ts` (TASK-P1-04), which Phase 2's engine rewrite switches to. See known-issues #0b.
- **The webhook ACKs before it works.** `200 {received:true}` is returned and processing happens in `queueMicrotask` (`:376-384`), so a handler throw is invisible to Telnyx and never
  retried. Conversely Telnyx retries are at-least-once — handlers must be idempotent.
- **WebRTC credentials leak.** `telephonyCredentials.create` runs on *every* call to `telnyx-webrtc-credentials` (`:25`) and nothing ever deletes the credential; each page load that connects
  adds one to the account. The minted token has a Telnyx-side lifetime the code does not track or refresh: `connect()` short-circuits when `clientRef.current` is already set
  (`apps/web/src/lib/useTelnyxCall.ts:41`), so a long-lived tab keeps one token forever. On expiry the symptom is `telnyx.error` on the existing client — `disconnect()` then `connect()` to
  re-mint.
- **Token parsing is deliberately tolerant** (`supabase/functions/telnyx-webrtc-credentials/index.ts:56-71`): Telnyx has returned `data` as a string, `data.token`, top-level `token`, and a
  bare `eyJ…` JWT. Do not collapse it to one shape.
- **`toE164()` strips the `+`** (`apps/web/src/lib/useTelnyxCall.ts:13-18`) — it yields `15551234567`, not `+15551234567`. Server-side dialing does not use this helper; don't assume one
  format.
- **`telnyx-list-numbers` never asks Telnyx** (`supabase/functions/telnyx-list-numbers/index.ts`) — it reads `user_phone_numbers`, so a number released in the portal still shows in the
  app until the row is deleted.
- **`telnyx_phone_number_id` is globally `UNIQUE`** (migration `:8`): the same Telnyx number cannot attach to two orgs; a second purchase fails with a constraint error, not a 4xx.
- **Purchase writes with the service-role key**, bypassing `user_phone_numbers`' own RLS policies -- `org_id` (from `requireTelnyxOrgRole`'s verified membership lookup, not client input)
  and the owner/admin role gate are the real guards against cross-org assignment; `user_id` is attribution only (any org member can dial with a number once purchased).
- **Number search quirks** (`supabase/functions/telnyx-search-numbers/index.ts`): `best_effort: true` is always set; the area code is sent as `national_destination_code` only when
  `country_code === 'US'`. A Telnyx `10031` / "No numbers found" error becomes `200` with an empty list.
- **Four code strings point at a docs path that no longer exists.** The real file is `docs/guides/telnyx-call-control-setup.md`. Users following the error message hit a dead path.
- **Fixed (TASK-P1-06, 2026-09-24): WebRTC credentials no longer leak.** `telnyx-webrtc-credentials` used to call `telephonyCredentials.create` on *every* invocation with nothing ever
  deleting the credential -- every page load or reconnect added one to the account, forever. It now get-or-creates exactly one credential per (org, member), persisted in
  `org_members.telnyx_credential_id`; a stale/deleted id falls back to a Telnyx-side find-by-name lookup (`softdial-member-<org>-<user>`) before creating a new one, mirroring
  `_shared/telnyx-provision.ts`'s org-level idempotent-provisioning pattern. `apps/web/src/lib/useTelnyxCall.ts`'s own token-lifetime behavior (a long-lived tab keeps one token
  forever; `disconnect()` then `connect()` to re-mint on expiry) is unchanged by this fix -- only the server-side credential churn is fixed.
- **Token parsing is now a straight text/plain read, not tolerant multi-shape parsing.** Telnyx's `/telephony_credentials/{id}/token` response is verified (spec3.json) to be a raw
  JWT `text/plain` body, not JSON. `_shared/telnyx-client.ts`'s `mintCredentialToken` returns `{ token: string | null }` from that text directly. The old
  `telnyx-webrtc-credentials/index.ts`'s defensive multi-shape parsing (string / `.token` / bare `eyJ…`) only existed because it hand-rolled the request instead of trusting the spec;
  it is gone from the new code, but `useTelnyxCall.ts`'s consumption of `{ token }` is unchanged.

## Not covered here

- Dial loop, batching, AMD, `call_logs`, Redis session state → `.brain/domains/dialer.md`
- `getUserFromRequest` and session tokens → `supabase/functions/_shared/auth.ts` (and the auth domain doc, if present)
- Deployment mechanics → `docs/guides/deploy-edge-functions.md`

## Unverified

- Telnyx's actual WebRTC token TTL is not asserted anywhere in this repo; the "expiry → `telnyx.error`" symptom above is inferred from the client wiring, not observed in code.

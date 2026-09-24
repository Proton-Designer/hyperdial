---
id: domain.auth
title: Auth & Access Control
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-24
sources:
  - supabase/functions/_shared/auth.ts
  - supabase/functions/_shared/cors.ts
  - supabase/config.toml
  - supabase/migrations/*.sql
  - apps/web/src/contexts/AuthContext.tsx
  - apps/web/src/components/AuthScreen.tsx
related:
  - domain.dialer
  - domain.contacts
  - domain.campaigns
  - arch.system-overview
answers:
  - "how is a user authenticated when calling an Edge Function"
  - "why is verify_jwt false on almost every function"
  - "which Edge Functions are actually unauthenticated"
  - "which tables have RLS and what do the policies allow"
  - "where does SUPABASE_SERVICE_ROLE_KEY bypass RLS"
  - "what user metadata is collected at signup"
  - "how does org/tenant scoping work now"
  - "what are the RLS helper functions and why do they exist"
covers: "Supabase auth, session handling, the two-layer Edge Function authorization model, service-role usage, org tenancy, and the per-table RLS inventory."
excludes: "Telnyx webhook signature mechanics (domain.telephony); dial-loop ownership checks (domain.dialer)."
tokens_est: 3880
source_hash: b8d3fd311248f16889b10f531365423ec36488c32179946d09361fb21c5ce0c5
---

# Auth & Access Control

## Purpose

**As of TASK-P1-01 (2026-09-24), HyperDial is org-multi-tenant**, not single-user: every contact, campaign, number, and call belongs to one `orgs` row; a user reaches an org via `org_members` (role `owner|admin|agent`). The single-user model this doc used to describe (10 tables on `auth.uid() = user_id`) is now historical — see `mem.decisions`, `domain.campaigns`, `domain.contacts`. This domain still covers *who* is calling and the two layers deciding *what they may touch*: in-function checks in Deno, and Postgres RLS — now org-scoped.

## Tenancy (new)

`orgs` (team/tenant) · `org_members(org_id, user_id, role, status, telnyx_credential_id)` · `org_invites` (hashed single-use token, `role`, `expires_at`) · `profiles(user_id, first_name, last_name, active_org_id)` · `campaign_agents(campaign_id, user_id, org_id)` (which agents may dial/see which campaign).

**RLS helpers**, schema `private` (not API-exposed — `authenticated` needs an explicit `GRANT USAGE ON SCHEMA private`; a non-`public` schema does not inherit `public`'s default grant, see `mem.lessons`): `private.is_org_member(org)`, `private.has_org_role(org, roles[])`, plus single-purpose cross-table lookups (`campaign_org_id`, `contact_org_id`, `agent_assigned_to_campaign`, `agent_has_contact_access`) used *inside other tables'* policies. All SECURITY DEFINER, STABLE, `search_path = ''`. **Every one exists to avoid RLS recursion**: an inline subquery on another RLS-protected table, used inside a policy, can cycle with that table's own policy (`infinite recursion detected in policy for relation ...`) — reproduced building the RLS test suite, see `mem.decisions`/`mem.lessons`. **Never write an inline cross-table `EXISTS` in a new policy** — add a `private.*` helper.

**New-signup trigger** `public.handle_new_user()`: no `invite_token` in signup metadata → `private.ensure_org_for_user()` creates an org (named from `company_name`, else the email domain, else `'My Team'`), an owner membership, and the profile. `invite_token` present → only the profile is created; `org-invite-accept` (TASK-P1-03) adds the `org_members` row and sets `active_org_id`. As of TASK-P1-03, `private.ensure_org_for_user`'s `EXECUTE` is revoked from `public`/`authenticated` (`20260924000600`) — it only ever runs from inside the SECURITY DEFINER trigger, which calls it as the owning role regardless of the grant; leaving it open let any signed-in user invoke it directly via `.rpc()`.

## Key concepts

| Term | Means |
|---|---|
| Gateway `verify_jwt` | Platform-level JWT check, set per function in `supabase/config.toml`. Rejects before your code runs **with no CORS headers** — which is why it is almost always off here. |
| In-function check | `getUserFromRequest(req)` in `supabase/functions/_shared/auth.ts`. Validates the bearer token itself and returns a CORS-bearing 401 on failure. |
| Anon key | `VITE_SUPABASE_ANON_KEY`, sent as the `apikey` header so the gateway accepts the request. It is **not** identity — RLS still applies. |
| Service-role key | `SUPABASE_SERVICE_ROLE_KEY`. A client built with it **bypasses all RLS**; ownership guards there are hand-written. |

## Where the code lives

| What | Path |
|---|---|
| Token validation | `supabase/functions/_shared/auth.ts` — the only auth primitive, 41 lines |
| CORS headers | `supabase/functions/_shared/cors.ts` — `Allow-Origin: '*'` (`:2`) |
| Gateway config | `supabase/config.toml` — `verify_jwt` `:360-396`, `[auth]` from `:150` |
| Browser session | `apps/web/src/contexts/AuthContext.tsx` — `getSession` + `onAuthStateChange` (`:34-50`) |
| Sign-up UI | `apps/web/src/components/AuthScreen.tsx` — collects `first_name`, `last_name`, `company_name` into `auth.users.raw_user_meta_data` (no profiles table) (`:45-58`) |
| Header attachment | `apps/web/src/lib/api.ts:36-49` — `getEdgeFunctionHeaders()`, also sets `X-Org-Id` via `getActiveOrgId()` (`:20-30`) · org+role check: `_shared/auth.ts:71` `requireOrgRole` |
| Invite/team functions | `supabase/functions/org-invite-create`, `org-invite-accept`, `org-members` (TASK-P1-03) |

## How it works

1. **Signup / session** — `supabase.auth.signUp` carries the metadata (`apps/web/src/contexts/AuthContext.tsx:54-64`); `AuthProvider` hydrates from `getSession()` and subscribes to `onAuthStateChange`
   (`:34-50`).
2. **Calling a function** — `getEdgeFunctionHeaders()` sets `apikey` and `Authorization: Bearer <access_token>` **only if a session exists** (`apps/web/src/lib/api.ts:20-27`); no session → no header →
   401.
3. **Layer 1 (gateway)** — `verify_jwt` is `false` for 15 of 16; only `dialer-session-hangup-live` keeps the `true` default.
4. **Layer 2 (in-function)** — `getUserFromRequest` requires a `Bearer ` prefix (`:9`) then validates via `supabase.auth.getUser(token)` on a service-role client (`:20-27`). As of TASK-P1-02,
   `contacts-import`/`-parse-csv`, `dashboard-stats`, `team-performance` and `ensure-week-summary` call `requireOrgRole(req, roles)` instead (wraps `getUserFromRequest`, resolves `orgId`/`role`
   from `org_members` via header `X-Org-Id` or `profiles.active_org_id`, 403s outside `roles`) and filter every query by `org_id`. `telnyx-*`/`dialer-*` (10 functions) still hand-filter by `user_id`
   only — eng2/Phase 2. Client writes (`api.ts`: `createContact`, `createCampaign`, `addLeadsToCampaign`) now set `org_id` too — it has no DB default and is `NOT NULL` as of TASK-P1-01.
5. **Invite / team management (TASK-P1-03)** — `org-invite-create` (`requireOrgRole(['owner','admin'])`) stores only a SHA-256 hash of a random token, returning the raw token once. `org-invite-accept`
   GETs an unauthenticated preview (re-hashes the caller's token, never trusts a client-supplied hash) and POSTs the accept behind `getUserFromRequest` (no org yet, so not `requireOrgRole`), rejecting
   an accepting email that doesn't case-insensitively match the invite. `org-members` re-implements owner-immutability in app code since its service-role client bypasses the RLS that enforces it.

## Authorization matrix (all 19 functions)

| Function | Gateway | In-function | Net |
|---|---|---|---|
| `dialer-session-hangup-live` | **true** (default) | `:22` | double-guarded |
| `dialer-session-start`/`-stop`/`-pause`/`-get`/`-active` | false | `:42`/`:22`/`:19`/`:15`/`:14` | guarded |
| `contacts-import`, `contacts-parse-csv` | false | `requireOrgRole(['owner','admin'])` | guarded + role-gated |
| `dashboard-stats`, `ensure-week-summary` | false | `requireOrgRole(['owner','admin','agent'])`, own-`user_id` only | guarded |
| `team-performance` | false | `requireOrgRole(['owner','admin','agent'])`; owner/admin org-wide, agent own-`user_id` only | guarded |
| `telnyx-list-numbers`/`-search-numbers`/`-purchase-number`/`-webrtc-credentials` | false | `:9`/`:8`/`:9`/`:8` | guarded |
| `org-invite-create`, `org-members` (POST) | false | `requireOrgRole(['owner','admin'])` | guarded + role-gated |
| `org-members` (GET) | false | `requireOrgRole(['owner','admin','agent'])` | guarded |
| `org-invite-accept` | false | GET: none (token-hash lookup only); POST: `getUserFromRequest` + email match | guarded (POST) / intentionally open (GET preview) |
| **`telnyx-webhook`** | false | **none** | **unauthenticated** |

`telnyx-webhook` has neither layer, and its `verifySignature()` **fails open on two paths** (`supabase/functions/telnyx-webhook/index.ts:33-46`) — see `.brain/memory/known-issues.md`
#0. **Treat it as fully unauthenticated**: it holds a service-role client and drives the
dial loop.

## Per-table RLS inventory

**Every table has `ENABLE ROW LEVEL SECURITY`. None is unprotected.** As of TASK-P1-01
(`20260924000100`–`300`), every business table's policies are org-scoped, written with the
`private.*` helpers above — no more `auth.uid() = user_id`. `user_preferences` and `notifications`
are the deliberate exceptions: personal, not org-shared (see `20260924000300`'s header comment).

| Table | Policies (migration `20260924000300` unless noted) |
|---|---|
| `orgs` | SELECT `is_org_member`; UPDATE/DELETE `has_org_role([owner])`. No client INSERT — orgs are created only by the signup trigger / backfill. |
| `org_members` | SELECT `is_org_member`; INSERT/UPDATE/DELETE `has_org_role([owner,admin]) AND role <> 'owner'` — admins manage non-owner rows only; ownership transfer is not built. |
| `org_invites` | SELECT/INSERT/UPDATE/DELETE `has_org_role([owner,admin])`; INSERT/UPDATE additionally `role <> 'owner'` (`20260924000600`, TASK-P1-03) — an invite can never grant ownership. |
| `profiles` | SELECT: own row, **or** (TASK-P1-03) any org co-member's, via `private.shares_org_with` — team-roster name lookups now go through RLS directly, not just an Edge Function. INSERT `user_id = auth.uid()`. UPDATE `user_id = auth.uid()` **and** (TASK-P1-03) `active_org_id is null or private.is_org_member(active_org_id)` — re-checked on *every* self-update, so a disabled member can't edit even unrelated fields until `active_org_id` is cleared or they're re-enabled; see `mem.known-issues`. |
| `campaign_agents` | SELECT `is_org_member`; INSERT/DELETE `has_org_role([owner,admin])`. A `BEFORE INSERT/UPDATE` trigger (`private.check_campaign_agent_org`) rejects an `org_id` that doesn't match the campaign's own `org_id`, even when the caller legitimately owns the claimed `org_id` (a different org) — RLS alone would have let that through. |
| `campaigns` | SELECT `is_org_member` (any role); INSERT/UPDATE/DELETE `has_org_role([owner,admin])`. |
| `campaign_leads` | SELECT: owner/admin see all, agent sees only leads on a campaign they're assigned to (`campaign_agents`). INSERT `has_org_role([owner,admin])` **and** both `campaign_id` and `contact_id` verified to belong to the same `org_id` — fixes the auth.md finding that the old policy only checked campaign ownership, never the contact's. UPDATE/DELETE `has_org_role([owner,admin])`. |
| `contacts` | SELECT/UPDATE: owner/admin see and edit all; agent sees/edits only contacts reachable through an assigned campaign (`campaign_agents` → `campaign_leads`). **The agent UPDATE is full-row, not DNC-scoped — there is no `dnc` column yet.** See known-issues #7. INSERT/DELETE `has_org_role([owner,admin])`. |
| `user_phone_numbers` | SELECT `is_org_member` (any role, to pick a caller ID); INSERT/UPDATE/DELETE `has_org_role([owner,admin])`. |
| `notifications` | Unchanged: SELECT/UPDATE `user_id = auth.uid()`. Personal, not org-scoped even though `org_id` was added to the table (FK/cascade hygiene only). |
| `user_preferences` | Unchanged: SELECT/INSERT/UPDATE `auth.uid() = user_id`. No `org_id` column — stays per-user. |
| `dialer_sessions` | SELECT: owner/admin see all; agent sees only their own. All writes via Edge Functions. |
| `call_logs` | Same shape as `dialer_sessions`. |
| `campaigns_with_stats` (view) | `security_invoker = on`, recreated to carry `org_id` through — caller's (now org-scoped) RLS on `campaigns` applies. |

## Constraints & gotchas

- **`verify_jwt = false` is deliberate** (`supabase/config.toml:358-359`): the gateway's 401 carries no CORS headers, so the browser sees an opaque network error.
- **A new function needs BOTH.** No `[functions.<name>]` block → silently inherits `verify_jwt = true`; a `false` block with no `getUserFromRequest` call → wide open.
- **`getUserFromRequest` round-trips to GoTrue every request** (`:20-27`), adding auth latency on the dial loop's critical path.
- **Service-role clients bypass RLS entirely** — the guard is hand-written scoping, and omitting it is a silent cross-tenant read with no second layer to catch it.
- **`notifications` UPDATE has `USING` but no `WITH CHECK`; verified fine** (Postgres falls back to `USING`). No INSERT policy by design — writes come only from `ensure-week-summary`'s service-role client.
- **`Access-Control-Allow-Origin: '*'`** (`supabase/functions/_shared/cors.ts:2`) — safe only because identity is a bearer token, not a cookie.
- **Email confirmation is off; password floor is 6 characters** (`supabase/config.toml:210`, `:175`) and the strength meter never blocks a weak one — anyone can create an account and immediately dial.
- **`raw_user_meta_data` is user-writable via the client SDK** — display-only, never an input to an authorization decision.

## Not covered here

Webhook signature mechanics → `.brain/domains/telephony.md`; dial-loop ownership checks → `.brain/domains/dialer.md`; CSV import validation → `.brain/domains/contacts.md`.

## Unverified

- **Whether production matches `supabase/config.toml`** — `verify_jwt`/`[auth]` are also settable in the hosted dashboard and can diverge; local migrations may lag the deployed schema.

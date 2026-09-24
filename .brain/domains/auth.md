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
tokens_est: 3594
source_hash: 0388cf2fab8c2f4385c37c045bcd52d5f426fb8b71680110776816f0c605c799
---

# Auth & Access Control

## Purpose

**As of TASK-P1-01 (2026-09-24), Softdial is org-multi-tenant**, not single-user: every contact, campaign, number, and call belongs to one `orgs` row; a user reaches an org via `org_members` (role `owner|admin|agent`). The single-user model this doc used to describe (10 tables on `auth.uid() = user_id`) is now historical — see `mem.decisions`, `domain.campaigns`, `domain.contacts`. This domain still covers *who* is calling and the two layers deciding *what they may touch*: in-function checks in Deno, and Postgres RLS — now org-scoped.

## Tenancy (new)

`orgs` (team/tenant) · `org_members(org_id, user_id, role, status, telnyx_credential_id)` · `org_invites` (hashed single-use token, `role`, `expires_at`) · `profiles(user_id, first_name, last_name, active_org_id)` · `campaign_agents(campaign_id, user_id, org_id)` (which agents may dial/see which campaign).

**RLS helpers**, schema `private` (not API-exposed — `authenticated` needs an explicit `GRANT USAGE ON SCHEMA private`; a non-`public` schema does not inherit `public`'s default grant, see `mem.lessons`): `private.is_org_member(org)`, `private.has_org_role(org, roles[])`, plus single-purpose cross-table lookups (`campaign_org_id`, `contact_org_id`, `agent_assigned_to_campaign`, `agent_has_contact_access`) used *inside other tables'* policies. All SECURITY DEFINER, STABLE, `search_path = ''`. **Every one exists to avoid RLS recursion**: an inline subquery on another RLS-protected table, used inside a policy, can cycle with that table's own policy (`infinite recursion detected in policy for relation ...`) — reproduced building the RLS test suite, see `mem.decisions`/`mem.lessons`. **Never write an inline cross-table `EXISTS` in a new policy** — add a `private.*` helper.

**New-signup trigger** `public.handle_new_user()`: no `invite_token` in signup metadata → `private.ensure_org_for_user()` creates an org (named from `company_name`, else the email domain, else `'My Team'`), an owner membership, and the profile. `invite_token` present → only the profile is created; `accept-invite` (TASK-P1-02) is expected to add the `org_members` row.

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
| Header attachment | `apps/web/src/lib/api.ts:14-28` — `getEdgeFunctionHeaders()` |

## How it works

1. **Signup / session** — `supabase.auth.signUp` carries the metadata (`apps/web/src/contexts/AuthContext.tsx:54-64`); `AuthProvider` hydrates from `getSession()` and subscribes to `onAuthStateChange`
   (`:34-50`).
2. **Calling a function** — `getEdgeFunctionHeaders()` sets `apikey` and `Authorization: Bearer <access_token>` **only if a session exists** (`apps/web/src/lib/api.ts:20-27`); no session → no header →
   401.
3. **Layer 1 (gateway)** — `verify_jwt` is `false` for 15 of 16; only `dialer-session-hangup-live` keeps the `true` default.
4. **Layer 2 (in-function)** — `getUserFromRequest` requires a `Bearer ` prefix (`supabase/functions/_shared/auth.ts:8`) then validates via `supabase.auth.getUser(token)` on a service-role client
   (`:19-26`). Functions then scope every service-role query by hand; the browser's direct reads use the anon-key client, where RLS enforces.

## Authorization matrix (all 16 functions)

| Function | Gateway | In-function | Net |
|---|---|---|---|
| `dialer-session-hangup-live` | **true** (default) | `:22` | double-guarded |
| `dialer-session-start`/`-stop`/`-pause`/`-get`/`-active` | false | `:42`/`:22`/`:19`/`:15`/`:14` | guarded |
| `contacts-import`, `contacts-parse-csv` | false | `:33`, `:193` | guarded |
| `dashboard-stats`, `team-performance`, `ensure-week-summary` | false | `:8`, `:36`, `:24` | guarded |
| `telnyx-list-numbers`/`-search-numbers`/`-purchase-number`/`-webrtc-credentials` | false | `:9`/`:8`/`:9`/`:8` | guarded |
| **`telnyx-webhook`** | false | **none** | **unauthenticated** |

`telnyx-webhook` has neither layer, and its `verifySignature()` **fails open on two paths** (`supabase/functions/telnyx-webhook/index.ts:33-46`) — see `.brain/memory/known-issues.md`
#0. **Treat it as fully unauthenticated**: it holds a service-role client and drives the
dial loop.

**Not yet done (TASK-P1-02):** the 13 service-role functions above still hand-filter by `user_id`, not `org_id` — `requireOrgRole(req, orgId, roles)` (design §2) does not exist yet in `supabase/functions/_shared/auth.ts`. Only the Postgres RLS layer below is org-scoped so far.

## Per-table RLS inventory

**Every table has `ENABLE ROW LEVEL SECURITY`. None is unprotected.** As of TASK-P1-01
(`20260924000100`–`300`), every business table's policies are org-scoped, written with the
`private.*` helpers above — no more `auth.uid() = user_id`. `user_preferences` and `notifications`
are the deliberate exceptions: personal, not org-shared (see `20260924000300`'s header comment).

| Table | Policies (migration `20260924000300` unless noted) |
|---|---|
| `orgs` | SELECT `is_org_member`; UPDATE/DELETE `has_org_role([owner])`. No client INSERT — orgs are created only by the signup trigger / backfill. |
| `org_members` | SELECT `is_org_member`; INSERT/UPDATE/DELETE `has_org_role([owner,admin]) AND role <> 'owner'` — admins manage non-owner rows only; ownership transfer is not built. |
| `org_invites` | SELECT/INSERT/UPDATE/DELETE, all `has_org_role([owner,admin])`. |
| `profiles` | SELECT/INSERT/UPDATE, all `user_id = auth.uid()`. Personal; no cross-user policy — team-roster lookups go through an Edge Function (TASK-P1-02), not raw SELECT. |
| `campaign_agents` | SELECT `is_org_member`; INSERT/DELETE `has_org_role([owner,admin])`. A `BEFORE INSERT/UPDATE` trigger (`private.check_campaign_agent_org`) rejects an `org_id` that doesn't match the campaign's own `org_id`, even when the caller legitimately owns the claimed `org_id` (a different org) — RLS alone would have let that through. |
| `campaigns` | SELECT `is_org_member` (any role); INSERT/UPDATE/DELETE `has_org_role([owner,admin])`. |
| `campaign_leads` | SELECT: owner/admin see all, agent sees only leads on a campaign they're assigned to (`campaign_agents`). INSERT `has_org_role([owner,admin])` **and** both `campaign_id` and `contact_id` verified to belong to the same `org_id` — fixes the auth.md finding that the old policy only checked campaign ownership, never the contact's. UPDATE/DELETE `has_org_role([owner,admin])`. |
| `contacts` | SELECT/UPDATE: owner/admin see and edit all; agent sees/edits only contacts reachable through an assigned campaign (`campaign_agents` → `campaign_leads`). **The agent UPDATE is full-row, not DNC-scoped — there is no `dnc` column yet.** See known-issues #7. INSERT/DELETE `has_org_role([owner,admin])`. |
| `user_phone_numbers` | SELECT `is_org_member` (any role, to pick a caller ID); INSERT/UPDATE/DELETE `has_org_role([owner,admin])`. |
| `call_events` | SELECT: owner/admin see all; agent sees only their own (`user_id = auth.uid()`). **`org_id` is nullable** (mirrors `user_id`, see `mem.decisions`). Writes stay service-role only. |
| `notifications` | Unchanged: SELECT/UPDATE `user_id = auth.uid()`. Personal, not org-scoped even though `org_id` was added to the table (FK/cascade hygiene only). |
| `user_preferences` | Unchanged: SELECT/INSERT/UPDATE `auth.uid() = user_id`. No `org_id` column — stays per-user. |
| `dialer_sessions` | SELECT: owner/admin see all; agent sees only their own. All writes via Edge Functions. |
| `call_logs` | Same shape as `dialer_sessions`. |
| `campaigns_with_stats` (view) | `security_invoker = on`, recreated to carry `org_id` through — caller's (now org-scoped) RLS on `campaigns` applies. |

## Constraints & gotchas

- **`verify_jwt = false` is deliberate** (`supabase/config.toml:358-359`): the gateway's 401 carries no CORS headers, so the browser sees an opaque network error.
- **A new function needs BOTH.** No `[functions.<name>]` block → silently inherits `verify_jwt = true`; a `false` block with no `getUserFromRequest` call → wide open.
- **`getUserFromRequest` round-trips to GoTrue every request** (`supabase/functions/_shared/auth.ts:20-21`) rather than verifying the JWT locally, putting auth latency on the dial loop's critical
  path.
- **Service-role clients bypass RLS entirely** — 13 functions plus `supabase/functions/_shared/dialer-events.ts:22`. The only guard there is a hand-written `.eq('user_id', user.id)`; every current
  call site scopes correctly, and omitting one is a silent cross-tenant read.
- **Fixed as of TASK-P1-01:** `campaign_leads` INSERT used to check only that the caller owned the campaign, never that the contact did — a crafted insert could link another org's contact in. The
  rewritten policy (`20260924000300`) verifies `campaign_id` and `contact_id` both belong to the claimed `org_id`; see the per-table inventory above.
- **`notifications` UPDATE has `USING` but no `WITH CHECK` — checked, and it is fine.** Postgres falls back to the `USING` expression for the check when `WITH CHECK` is omitted, so a user still cannot
  update a row into someone else's `user_id`. Recorded here so it is not re-raised as a finding. `notifications` also has no INSERT policy by design — inserts come from `ensure-week-summary` on the
  service-role client.
- **`call_events.user_id` is nullable** (`20250213000001:4`); once null the row is invisible to everyone — not a leak, but orphaned rows exist and are unreachable.
- **`Access-Control-Allow-Origin: '*'`** (`supabase/functions/_shared/cors.ts:2`) — safe only because identity is a bearer token, not a cookie.
- **Email confirmation is off; password floor is 6 characters** (`supabase/config.toml:210`, `:175`) and the strength meter never blocks a weak one — anyone can create an account and immediately dial.
- **`raw_user_meta_data` is user-writable via the client SDK** — display-only, never an input to an authorization decision.

## Not covered here

Webhook signature mechanics → `.brain/domains/telephony.md`; dial-loop ownership checks → `.brain/domains/dialer.md`; CSV import validation → `.brain/domains/contacts.md`.

## Unverified

- **Whether production matches `supabase/config.toml`** — `verify_jwt` and `[auth]` are also settable in the hosted dashboard and can diverge; and **whether every migration has been applied** — the
  inventory is read from SQL, not a live database.
- No password-reset flow was found; "Forgot password?" (`AuthScreen.tsx:333`) appears non-functional. Inferred from the absence of a handler.

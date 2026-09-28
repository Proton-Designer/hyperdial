---
id: domain.auth
title: Auth & Access Control
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-27
sources:
  - supabase/functions/_shared/auth.ts
  - supabase/functions/_shared/cors.ts
  - supabase/functions/_shared/audit.ts
  - supabase/functions/org-audit-log/index.ts
  - supabase/config.toml
  - supabase/migrations/*.sql
  - supabase/migrations/20260927080000_org_audit_log.sql
  - supabase/migrations/20260927080002_org_member_offboarding.sql
  - supabase/migrations/20260927160550_manager_role_and_pods.sql
  - supabase/migrations/20260927164816_goals_and_broadcasts.sql
  - supabase/migrations/20260927171355_call_review_library.sql
  - supabase/migrations/20260927171444_supervisor_alerts_and_pod_scoping.sql
  - supabase/functions/_shared/pod-scope.ts
  - supabase/functions/recording-url/index.ts
  - supabase/functions/_shared/recording-core.ts
  - supabase/functions/_shared/telnyx-org-context.ts
  - supabase/functions/org-members/index.ts
  - supabase/functions/_shared/dialer-engine.ts
  - apps/web/src/contexts/AuthContext.tsx
  - apps/web/src/components/AuthScreen.tsx
  - apps/web/src/components/Settings.tsx
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
  - "what happens when a team member is disabled or removed"
  - "what can a manager role do, and how is their pod scope enforced"
  - "what is the difference between org_members.pod_id and org_manager_pods"
  - "how are daily goals set and resolved (org vs pod vs agent level)"
  - "how do team broadcasts work, who can post one, and how does an agent dismiss it"
  - "who can see/flag/comment on/score a call recording, and how is a manager's pod scope enforced there"
  - "why does telnyx-org-context.ts have its own separate OrgRole type instead of importing _shared/auth.ts's"
  - "who gets notified about a supervisor alert, and can a person opt out of one"
covers: "Supabase auth, session handling, the two-layer Edge Function authorization model, service-role usage, org tenancy, the per-table RLS inventory, member offboarding (disable/remove/restore), the manager role's server-enforced pod scope, daily goals + team broadcasts, and the call review library's access model."
excludes: "Telnyx webhook signature mechanics (domain.telephony); dial-loop ownership checks (domain.dialer)."
tokens_est: 7550
source_hash: b8d3fd311248f16889b10f531365423ec36488c32179946d09361fb21c5ce0c5
---

# Auth & Access Control

## Purpose

**As of TASK-P1-01 (2026-09-24), HyperDial is org-multi-tenant**, not single-user: every contact, campaign, number, and call belongs to one `orgs` row; a user reaches an org via `org_members` (role `owner|admin|agent`). The single-user model this doc used to describe (10 tables on `auth.uid() = user_id`) is now historical — see `mem.decisions`, `domain.campaigns`, `domain.contacts`. This domain still covers *who* is calling and the two layers deciding *what they may touch*: in-function checks in Deno, and Postgres RLS — now org-scoped.

## Tenancy (new)

`orgs` (team/tenant) · `org_members(org_id, user_id, role, status, telnyx_credential_id)` · `org_invites` (hashed single-use token, `role`, `expires_at`) · `profiles(user_id, first_name, last_name, active_org_id)` · `campaign_agents(campaign_id, user_id, org_id)` (which agents may dial/see which campaign).

**RLS helpers**, schema `private` (not API-exposed — `authenticated` needs an explicit `GRANT USAGE ON SCHEMA private`; a non-`public` schema does not inherit `public`'s default grant, see `mem.lessons`): `private.is_org_member(org)`, `private.has_org_role(org, roles[])`, plus single-purpose cross-table lookups (`campaign_org_id`, `contact_org_id`, `agent_assigned_to_campaign`, `agent_has_contact_access`) used *inside other tables'* policies. All SECURITY DEFINER, STABLE, `search_path = ''`. **Every one exists to avoid RLS recursion**: an inline subquery on another RLS-protected table, used inside a policy, can cycle with that table's own policy (`infinite recursion detected in policy for relation ...`) — reproduced building the RLS test suite, see `mem.decisions`/`mem.lessons`. **Never write an inline cross-table `EXISTS` in a new policy** — add a `private.*` helper.

**New-signup trigger** `public.handle_new_user()` — **invite-only as of TASK-L4** (`20260925000300`, closes ADM-3). No `invite_token`, an unresolvable/garbage token, an expired invite, an already-accepted invite, or an email that doesn't match the invite → the trigger `raise exception`s and the whole `auth.users` insert (and therefore the signup) fails; there is no more self-serve "no token → create a new org" path — `private.ensure_org_for_user()` is now dead code from the trigger's perspective (still called by the one-time `20260924000200` backfill, left in place so that migration still replays against a fresh database). A valid, matching invite → only the profile is created, same as before; `org-invite-accept` still does the `org_members` insert and sets `active_org_id`, unchanged. **Any direct `insert into auth.users` fixture** (every `supabase/tests/*.sql` file, `scripts/dev/dialer-sim.ts`) now needs either a real matching `org_invites` row or `alter table auth.users disable/enable trigger on_auth_user_created` around the insert plus hand-built org/profile/membership rows — see `20260925000300`'s own header and `supabase/tests/rls_org_matrix.sql`/`invite_only_signup.sql` for the pattern. Only `rls_org_matrix.sql` has been updated for this so far; the rest are known-broken for re-runs, see `mem.known-issues`.

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
| Sign-in UI | `apps/web/src/components/AuthScreen.tsx` — sign-in + password reset only as of TASK-L4; no signup form here at all |
| Invite-signup UI | `apps/web/src/components/InviteLanding.tsx` — the only place `supabase.auth.signUp` is ever called with `invite_token` in metadata; reached only via `?invite=<token>` (`App.tsx`) |
| Header attachment | `apps/web/src/lib/api.ts:36-49` — `getEdgeFunctionHeaders()`, also sets `X-Org-Id` via `getActiveOrgId()` (`:20-30`) · org+role check: `_shared/auth.ts:71` `requireOrgRole` |
| Invite/team functions | `supabase/functions/org-invite-create`, `org-invite-accept`, `org-members` (TASK-P1-03) |
| Role-based nav (TASK-L4 / UI-4) | `MainApp.tsx` (`AGENT_ALLOWED_TABS`, guards every tab switch, not just the sidebar), `Sidebar.tsx` (filters the tab list + relabels Dashboard "My stats" for agents), `Contacts.tsx` (`canManage` hides import/add/edit/delete/bulk, row click into `ContactDetailModal` stays view+DNC-toggle only, unchanged from TASK-P2-P1) |

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
| `org-members` (GET) | false | `requireOrgRole(['owner','admin','agent','manager'])`; a manager's roster is filtered to their own pod scope in app code | guarded |
| `org-audit-log` (GET) | false | `requireOrgRole(['owner','admin','manager'])`; a manager's rows are filtered to their own pod scope in app code | guarded |
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
| `org_pods` (`20260927160550`, TASK-M5-A5) | SELECT `is_org_member`; INSERT/UPDATE/DELETE `has_org_role([owner,admin])`. Just a name — membership (`org_members.pod_id`) and a manager's scope (`org_manager_pods`) are separate tables. |
| `org_manager_pods` (`20260927160550`, TASK-M5-A5) | SELECT: the manager's own rows (`manager_user_id = auth.uid()`), or owner/admin see all. INSERT/UPDATE/DELETE `has_org_role([owner,admin])` — a manager can view but never edit their own scope. |
| `org_goals` (`20260927164816`, TASK-M5-A6) | SELECT: owner/admin see all; a manager sees org-wide rows plus pod/agent rows inside their own `org_manager_pods` scope; any agent sees their own agent-level row. **No client INSERT/UPDATE/DELETE policy at all** — writes only via `set_org_goal`/`delete_org_goal` (same reasoning as `org_audit_log`: the manager-tier pod-scope check is easier to express in plpgsql than a single RLS `WITH CHECK`). |
| `org_broadcasts` (`20260927164816`, TASK-M5-A6) | SELECT: `is_org_member` and (org-wide, or owner/admin, or the caller's own `org_members.pod_id` matches). No client write policy — `create_org_broadcast`/`delete_org_broadcast` only. |
| `org_broadcast_dismissals` (`20260927164816`, TASK-M5-A6) | ALL: `user_id = auth.uid()` only — a caller may only ever touch their OWN dismissal rows; no privileged check needed (dismissing a broadcast you can't otherwise see is harmless), so this is the one write in this task done as a plain client insert, not an RPC. |
| `call_legs` (new policy, `20260927171355`, TASK-M5-B5) | Additive THIRD permissive SELECT policy on top of the two pre-existing ones (owner/admin all; agent own) — a manager sees a leg whose session's agent is in their own `org_manager_pods` scope. Without this a manager could not see `call_legs` at all (it predates the manager role). |
| `recording_flags`/`recording_comments`/`call_scorecards`/`call_scorecard_scores` (`20260927171355`, TASK-M5-B5) | SELECT: `private.can_view_call_leg(call_leg_id)` (owner/admin any, manager pod-scoped, agent own) — one shared helper, not four hand-written copies. `recording_flags` is also client-writable (`for all`, same check + an org_id cross-check in `WITH CHECK`) — flag/unflag needs no server-side scope logic beyond visibility. `recording_comments` is INSERT-only client-side (append-only, `author_user_id = auth.uid()` enforced) — no update/delete policy. `call_scorecards`/`call_scorecard_scores` have NO client write policy at all — `set_call_scorecard` is the only writer (manager-write needs pod-scope + rubric/criterion validation, easier in plpgsql). |
| `org_supervisor_alert_settings` (`20260927171444`, TASK-M5-B4) | SELECT `is_org_member`; INSERT/UPDATE `has_org_role([owner,admin])`. Same singleton-per-org shape as `org_timezone_settings`/`org_reliability_alert_settings`. |
| `user_notification_preferences` (`20260927171444`, TASK-M5-B4) | SELECT/ALL: `user_id = auth.uid() OR has_org_role([owner,admin])` — the only table in this inventory where owner/admin may write a row keyed to someone ELSE's `user_id`, per the task's own explicit "owner/admin can set them for someone else" requirement. `WITH CHECK` additionally requires an `org_members` row to exist for that `(org_id, user_id)` pair, so this can't seed a preference for a non-member. |
| `scorecard_rubrics`/`scorecard_rubric_criteria` (`20260927171355`, TASK-M5-B5) | SELECT: any org member. INSERT/UPDATE/DELETE: owner/admin only (`for all`). |
| `notifications` | Unchanged: SELECT/UPDATE `user_id = auth.uid()`. Personal, not org-scoped even though `org_id` was added to the table (FK/cascade hygiene only). |
| `user_preferences` | Unchanged: SELECT/INSERT/UPDATE `auth.uid() = user_id`. No `org_id` column — stays per-user. |
| `dialer_sessions` | SELECT: owner/admin see all; agent sees only their own. All writes via Edge Functions. |
| `call_logs` | Same shape as `dialer_sessions`. |
| `campaigns_with_stats` (view) | `security_invoker = on`, recreated to carry `org_id` through — caller's (now org-scoped) RLS on `campaigns` applies. |

## Audit log (MISSION-5 TASK-A1)

`org_audit_log(id, org_id, actor_user_id, action, target_type, target_id, details jsonb, created_at)` — `20260927080000_org_audit_log.sql`. RLS: owner/admin SELECT their own org's rows only; **no client INSERT/UPDATE/DELETE policy exists at all** (writes only ever come from the two paths below, both bypassing RLS by construction) — verified live via `audit/M5-A1/dryrun-tests.sql` (an owner's own direct INSERT/UPDATE/DELETE against the table is denied/no-ops even though they can freely SELECT it).

**Two writers, add to both places when you add a new team-management action:**
1. **SQL RPCs**: `perform private.log_org_action(p_org, p_action, p_target_type, p_target_id, p_details, p_actor default auth.uid())`. SECURITY DEFINER, **deliberately not granted to `authenticated`** (unlike `is_org_member`/`has_org_role`) — it does no membership check of its own, so granting it to a signed-in client would let anyone forge a row in any org. Only reachable from another SECURITY DEFINER function already owned by the migration role (an internal call runs as the *owner*, which needs no grant) or directly by `postgres`/`service_role`. Wired into `assign_campaign_leads` today.
2. **Edge Functions**: `logOrgAction(supabase, {orgId, actorUserId, action, targetType?, targetId?, details?})` from `supabase/functions/_shared/audit.ts` — a plain service-role INSERT (service-role already bypasses RLS). Best-effort/fire-and-forget: call it AFTER your own mutation has already committed; a logging failure is swallowed (console.error only), never fails the caller's real action. Wired into `org-members` (all 5 actions), `org-invite-create`, `ghl-connect`/`-disconnect`/`-update-blocked-tags`/`-update-pull-settings`, and `dialer-coaching` (via `_shared/coaching-core.ts`'s `runStartCoachingAction`/`processTelnyxCoachingEvent`, actions `coaching.start`/`coaching.end`).
3. **Passive third source — settings-change trigger**: `private.audit_log_settings_change_trigger()`, one generic function attached (`after insert or update ... for each row execute function private.audit_log_settings_change_trigger('<action>', '<target_type>')`) to every per-org settings table an owner/admin (or, for `user_notification_preferences`, self-or-owner/admin) can write **directly** via RLS with no Edge Function in between: `org_spend_settings`, `org_reliability_alert_settings`, `org_recording_settings`, `org_transfer_settings`, `org_supervisor_alert_settings`, `user_notification_preferences` (the last two added `20260927194306`, MISSION-5 B4 follow-up — `user_notification_preferences` is per-`(org,user,alert_type)` rather than a per-org singleton, but the trigger only needs `new.org_id`/`old.org_id` to exist, and the embedded row already carries `user_id`/`alert_type`). Guarded by `auth.role() is distinct from 'authenticated'` so a system/service-role write (the seed-on-org-create triggers, a migration backfill) is never logged, only a real signed-in client's own save. Also no-ops on a byte-identical re-save (comparing `to_jsonb(new) - 'updated_at'` against the old row — `updated_at` is excluded on purpose, since every one of these tables' own `api.ts` upsert stamps a fresh one on *every* save, even a no-op one).

**Client read/write surface**: `supabase/functions/org-audit-log` — GET (owner/admin, filters: actor/action/date range, paged, resolves actor names via one bulk `profiles` lookup, never `auth.admin.getUserById` per row) backs Settings → **Activity** (`Settings.tsx`'s `ActivityTab`). POST accepts only an allowlisted `name` (`export.team_csv`, `export.analytics_csv` today) — the one gap neither writer above covers, since a CSV export never round-trips to a server on its own (`apps/web/src/lib/csv.ts`'s own header) — wired from `Team.tsx`/`Analytics.tsx`'s own export handlers via `api.ts`'s `logAuditEvent`.

**Action name registry** (add a row here — and to `Settings.tsx`'s `AUDIT_ACTION_LABELS` — whenever a new action is wired in): `member.role_change`, `member.disable`, `member.enable`, `member.remove`, `member.restore`, `member.release_queued_leads`, `member.set_ghl_user_id`, `invite.create`, `campaign_leads.assign`, `campaign_leads.callback_fallback_claim`, `coaching.start`, `coaching.end`, `session.remote_pause`, `session.remote_end`, `session.remote_hangup`, `ghl.connect`, `ghl.disconnect`, `ghl.update_blocked_tags`, `ghl.update_pull_settings`, `settings.spend.update`, `settings.reliability_alerts.update`, `settings.recording.update`, `settings.transfer.update`, `settings.supervisor_alerts.update`, `settings.notification_preferences.update`, `export.team_csv`, `export.analytics_csv`, `goal.set`, `goal.delete`, `broadcast.create`, `broadcast.delete`.
MISSION-5 TASK-M5-B2 added `session.remote_pause`/`session.remote_end`/`session.remote_hangup` (owner/admin acting on someone ELSE's dial session -- never logged for an agent's own routine pause/stop/hangup click) and reused `coaching.end` for two new triggers (`swept_stale` from the sweeper, `target_transferred`/`coach_offboarded` from the new coaching-end helpers) that previously went unlogged.

**Retention**: keep 1 year, documented not enforced — no cron yet (row volume is trivial at current org sizes; revisit with a scheduled prune if that changes).

## Member offboarding (MISSION-5 TASK-A3)

`org_members.status` gained a third value, `'removed'` (`20260927080002_org_member_offboarding.sql`), alongside a nullable `removed_at`. `private.is_org_member`/`private.has_org_role` already only ever match `status = 'active'`, so `'removed'` is refused everywhere `'disabled'` already was, with no code change to either helper — verified directly (authenticating as a freshly-removed member and calling both helpers) in `audit/M5-A3/dryrun-tests.sql`, not assumed from the pre-existing SQL.

**Soft-remove, not `.delete()`**: `org-members`'s `remove` action flips `status`/`removed_at`; the row (and the `profiles` row it joins to) is never deleted, so a removed member's name still resolves everywhere `team_daily_stats`/dispositions/recordings already look it up. **Restorable for 72h**: action `restore` flips back to `active`/`null` — enforced by comparing `now() - removed_at` in the Edge Function (`org-members/index.ts`, `RESTORE_WINDOW_MS`), not in SQL; past the window it 410s and the member stays `removed` permanently (no data is ever purged either way). GET on `org-members` hides `status = 'removed'` rows by default — pass `?include_removed=true` (`Settings.tsx`'s "Show removed members" toggle) to see them and reach Restore.

**Disable/remove cascade** (`org-members/index.ts`'s `cascadeOffboard`, both actions): (1) halts new-batch dialing immediately via `_shared/dialer-engine.ts`'s `haltIntakeForOffboarding` — finds the member's one non-terminal `dial_sessions` row (if any) and pauses it out of `ready_pending`/`ready`/`dialing`; `on_call`/`wrap_up` are deliberately left alone (a live call is allowed to finish) and can never resume on their own afterward since `requireOrgRole`/`requireTelnyxOrgRole` already refuse a non-`'active'` status on the member's own next request. (2) releases every `user_phone_numbers` row `assigned_user_id`-linked to them back to the pool (plain `assigned_user_id = null` UPDATE). Both best-effort/logged, never block the actual disable/remove write.

**Queued leads vs. callbacks — now both closed.** A dedicated RPC, `public.release_agent_queued_leads(p_org, p_agent)`, unassigns exactly this agent's own `campaign_leads.status = 'queued'` rows back to the pool (`assigned_agent_id = null`) — a distinct, explicitly-triggered action (`release_queued_leads`), not an automatic side effect of disable/remove, so an admin isn't forced to decide before clicking either button. **Deliberately does NOT reuse `assign_campaign_leads`** (TASK-T6): that RPC's own `candidates` CTE matches every queued lead in the campaign regardless of current assignment, so calling it with `p_agent_id := null` to "release just this agent" would also unassign every OTHER agent's own slice on a shared campaign — confirmed as a real, avoided bug via a dry-run fixture with two agents holding leads on the same campaign. Due/future **callbacks** (`campaign_leads.status = 'callback'`) are reassigned via B3's own new `assign_campaign_leads` filter mode, `by_current_agent` (`{ mode: 'by_current_agent', from_agent_id }`, to a chosen agent or the pool with `agentId: null`) — the offboarding wizard (`Settings.tsx`'s `OffboardWizardModal`) calls it once per campaign the member holds a callback in, right after B3 landed. Order-independent with `release_queued_leads`: `by_current_agent` re-checks each row's CURRENT `assigned_agent_id` at UPDATE time, so calling it after queued leads are already released just finds nothing left to move for those. NEEDS-LIVE-VERIFY: not exercised against a running QA org yet, only unit/dry-run-level.

**Admin lock-out guard** (`org-members/index.ts`'s `checkAdminGuard`, Edge-Function-level, not a DB trigger — the only client write path): acting on an `admin` target needs the ORG OWNER, unless the actor is acting on **themselves** (a self-demote is allowed to reach the next check instead of being blanket-refused); either way, the action is refused if it would drop the org's active `owner`+`admin` headcount to zero. The owner's own row remains fully untouchable through this endpoint (pre-existing check, unchanged).

**`team_daily_stats` historical-range fix**: its `members` CTE used to filter to `status = 'active'` only, so a member disabled/removed AFTER the fact would silently vanish from every past date-range query too — not just today's roster. Fixed to also include a non-active member whose own `dial_sessions` actually overlaps the queried `[p_start, p_end)` window (same overlap test the `hours` CTE already used) — a member removed long before an unrelated query window still doesn't clutter it. `team_live_board` (the CURRENT, right-now board) was correctly untouched: a disabled/removed agent isn't "live" and already renders as `'offline'`.

## Manager role + pods (MISSION-5 TASK-M5-A5)

`org_members.role` (and `org_invites.role`) gained a fourth value, `'manager'` (`20260927160550_manager_role_and_pods.sql`, sorted after eng2's B2 migration — see that migration's own header for why). A manager can see the Team page, coach, assign leads, see reports and the audit log for their own scope; they cannot buy numbers, change billing/spend, change roles, or edit org settings — enforced by simply never widening any of THOSE role checks, not by a separate "forbidden" list.

**Two distinct relationships, on purpose**: `org_members.pod_id` (nullable FK to the new `org_pods`) is the single pod an agent (or manager) belongs to *as a roster member* — zero or one. A manager's own **scope** — which pod(s) they may supervise — is a separate many-to-many table, `org_manager_pods(org_id, manager_user_id, pod_id)`. A manager typically has a `pod_id` too (their own "home" pod), but it plays no role in what they can see; only `org_manager_pods` does.

**The one new scoping primitive**: `private.is_agent_in_callers_pod_scope(org, agent)` — `true` unconditionally for an owner/admin caller (unchanged full visibility), `true` for a manager caller when the target agent's `pod_id` is one of the manager's own `org_manager_pods` rows, `false` otherwise. Composed into every touch point the task named that lives in this lane:
- `team_live_board`/`team_daily_stats`: role gate widened to `['owner','admin','manager']`; the `members` CTE gets `and private.is_agent_in_callers_pod_scope(p_org, m.user_id)` — a manager's query is scoped at the row level, not just admitted at the door (unlike owner/admin, passing the role check alone doesn't mean a manager can see a SPECIFIC row).
- `agent_time_in_state`: same role widen; the `events` CTE's WHERE gets `is_agent_in_callers_pod_scope(...) or (has_org_role(['agent']) and e.agent_id = auth.uid())` — composes with the existing agent-self-view path (the NULL-comparison privacy fix from A4/fix-A4) unchanged.
- `assign_campaign_leads` (eng2's B3 RPC): widened via a **further `create or replace` in THIS migration**, never touching B3's own file (same non-destructive layering convention used throughout M5) — a manager may only assign TO an agent in their own pod scope, and for `mode: 'by_current_agent'`, the SOURCE agent (`p_filter.from_agent_id`) must also be in scope.
- `org-members`'s roster GET and `org-audit-log`'s GET: both Edge Functions, scoped in application code (a manager only sees roster rows / audit rows for agents in their own pods, plus their own).

**Coaching and remote pause/stop/hangup are now scoped too, in TASK-M5-B4** (this section
originally deferred them — "manager after A5" — since B2 shipped owner/admin-only first). Both
live in `_shared/pod-scope.ts` rather than reusing `is_agent_in_callers_pod_scope` directly:
`isManagerScopedToAgent(supabase, orgId, managerId, agentId)` reimplements the SAME two-table
check in TypeScript (a `private.*` function can't be called via `supabase.rpc()`, and neither
call site is an RPC to begin with — see that file's own header). `dialer-session-pause`/`-stop`/
`-hangup-live` each call it when `role==='manager'` and the target isn't the manager's own
session; `runStartCoachingAction` (`coaching-core.ts`) calls it before ever dialing the manager's
own phone. `coaching_sessions`' SELECT RLS was widened to match (a manager sees only coaching
attempts they started) for consistency, though nothing client-side reads that table directly yet.

**Client-side tab visibility** (cosmetic only, real enforcement is server-side above): a manager gets Dashboard/Dialer/Contacts/Analytics/Team/Settings, same as owner/admin, **except Campaigns** — "assign leads" is enforced server-side but deliberately has no client entry point yet (Campaigns.tsx has other un-scoped surface — CSV import, campaign creation, agent-roster assignment — that would need its own manager-safe review first). Within Settings, a manager is further restricted to just the Activity (audit log) and Security (own profile) sub-tabs — not Telephony/Team/Integrations/Dispositions/DNC/Distribution, all billing/numbers/org-settings-adjacent.

## Supervisor alerts + notification preferences (MISSION-5 TASK-M5-B4)

Per-org opt-in alerts (agent stuck in wrap-up/paused/on-a-call too long, zero connects while
dialing) reuse `reliability-alert-check`'s own cron infra rather than a second cron/secret
entry — see `.brain/domains/dialer.md`'s own section for the SQL-side dedup mechanics
(`check_supervisor_alerts()`, two different episode-boundary shapes). The TS-side recipient
resolution is the auth-relevant half: `resolveAlertRecipients(supabase, orgId, agentId)` (also
`_shared/pod-scope.ts`) returns every owner/admin plus the alerted agent's own pod-scoped
manager — the SAME two-table shape as `isManagerScopedToAgent` above, generalized from "can THIS
caller act on THIS agent" to "who should be told about THIS agent" (also reused by the raise-hand
notifier, B2). `filterByNotificationPreference` then narrows that set against
`user_notification_preferences` (per-user, per-alert-type opt-out; absence of a row means on).

Two new tables, both following this schema's established "org member reads, owner/admin writes"
RLS shape except where noted: `org_supervisor_alert_settings` (thresholds, owner/admin only) and
`user_notification_preferences` (self OR owner/admin may write ANY row — "owner/admin can set
them for someone else" is the task's own explicit requirement — with a `WITH CHECK` `exists()`
guard so a row can never be written for a non-member).

## Daily goals + team broadcasts (MISSION-5 TASK-M5-A6)

`20260927164816_goals_and_broadcasts.sql`. Two independent features, same permission shape as
each other (and as pods/A5): owner/admin act on anything, a manager only within their own
`org_manager_pods` scope, an agent gets a resolved self-view only. Neither adds any new
call_legs/dial_sessions aggregation — actual counts still come from the existing
`agent_self_stats`/`team_daily_stats` RPCs, joined client-side by `agent_id`.

**Goals**: `org_goals` is a STANDING row per scope-key+metric (not a historical log) — a partial
unique index per scope tier (`(org_id, metric) where scope='org'`, `(org_id, pod_id, metric)
where scope='pod'`, `(org_id, agent_user_id, metric) where scope='agent'`) makes `set_org_goal`'s
`insert ... on conflict ... do update` a true upsert-in-place. Four metrics: `dials`,
`conversations`, `wins` (this app's "yes to profile" — same `is_win` disposition flag
`agent_self_stats`/`team_daily_stats` already use for their own `wins` column), `talk_minutes`.
**Resolution is most-specific-wins, independently PER METRIC**: agent-level row beats pod-level
beats org-level — an org can set a blanket `dials` goal while one pod also has its own
`conversations` goal and one agent has their own `talk_minutes` goal, and each agent's effective
target is assembled from whichever tier actually has a row for that metric. `my_goal_targets(p_org)`
resolves this for the caller themselves (self-view, any org member, same trust model as
`agent_self_stats` — no `p_agent` parameter); `team_goal_targets(p_org)` resolves it for every
pod-scoped agent (owner/admin/manager, same role gate + `is_agent_in_callers_pod_scope`
composition as `team_daily_stats`). Writes (`set_org_goal`/`delete_org_goal`) are owner/admin-any,
manager-own-scope-only — a manager can never set/delete an ORG-level goal, only pod (their own
supervised pod) or agent (an agent inside one of their own supervised pods).

**Broadcasts**: `org_broadcasts` (`pod_id` null = everyone) + `org_broadcast_dismissals`
(per-viewer, so one agent dismissing a broadcast never hides it from anyone else).
`create_org_broadcast`/`delete_org_broadcast` are owner/admin-any, manager-own-pod-scope-only —
unlike goals, a manager MAY post org-wide ("everyone" is open to all three roles per the task's
own wording; only a POD target is scope-checked). `active_org_broadcasts(p_org)` is the one read
path agents use (Dialer.tsx): pre-filtered to non-expired, visible-to-caller (their own pod or
everyone), not-yet-dismissed rows in one round trip. Dismissing is a plain client insert into
`org_broadcast_dismissals` (see the RLS table above), not an RPC — the only write in either
feature that isn't.

**UI**: Team.tsx gets a goal-setting + broadcast-composing panel (`TeamGoalsAndBroadcastPanel`,
owner/admin/manager — same "server enforces the pod scope, the UI doesn't try to pre-filter
options" trust model `assign_campaign_leads`'s own UI already uses) and a goal-attainment table
(`TeamGoalAttainment`, joins `team_goal_targets` with the daily-stats table Team.tsx already
fetches). Dashboard.tsx's My stats card and Dialer.tsx's header both render the caller's own
today-vs-goal progress bars via one shared component (`MyGoalHeader`/`GoalProgressBars`) — a
metric with no goal set anywhere is left out of the bars entirely, and the whole card/section
renders nothing if no goal is set at all.

## Call review library (MISSION-5 TASK-M5-B5)

`20260927171355_call_review_library.sql`. Same three-tier access everywhere (owner/admin any,
manager pod-scoped, agent own) — composed ONCE as `private.can_view_call_leg(p_leg_id)` (built
from `is_agent_in_callers_pod_scope` + a self-match, see its own header) rather than hand-written
per table, specifically to avoid the exact drift `org_broadcasts`' own fix-forward (this same
session, `20260927164816`) just proved happens when the same OR-chain is copied by hand more than
once. `call_legs` itself predates the manager role and had no manager-visibility policy at all
until this task added a third, additive permissive SELECT policy for it.

- **Recordings browser**: `recordings_search(p_org, p_agent_id?, p_campaign_id?, p_disposition_
  key?, p_min/max_duration_seconds?, p_start?/p_end?, p_flagged_only?, p_limit, p_offset)` — one
  RPC, pod-scoped row filter inlined (not a `can_view_call_leg` call per row, since the query
  already joins `dial_sessions` for other columns); narrowing to a specific `p_agent_id` outside
  the caller's own scope raises rather than returning an empty-looking result.
- **Signed URLs (eng2's lane, non-destructively extended)**: `recording-url/index.ts` reuses the
  SAME Storage/Telnyx machinery, only its own auth widened — `canAccessRecording` (`_shared/
  recording-core.ts`) gained a `manager` role + an `isAgentInCallerPodScope` flag the CALLER
  resolves (a plain `org_members.pod_id` + `org_manager_pods` JS query, since this function uses
  a service-role client and RLS never applies — same "manager pod-scoping done in JS" pattern
  `org-members`/`org-audit-log`'s own GET handlers established in A5). **Gotcha**: `_shared/
  telnyx-org-context.ts` has its OWN independent `OrgRole` type (`owner`/`admin`/`agent` — never
  imported `_shared/auth.ts`'s own widened one, see that file's own header on why the two lanes
  don't share this type) — it needed its own separate widening to admit `'manager'` here, purely
  additive and safe for every other `dialer-session-*`/`telnyx-*` function that imports it (none
  of them list `'manager'` in their own `roles` array yet, so none of them newly admit a manager
  caller just because the TYPE now allows it in principle).
- **Flag for review**: `recording_flags`, one row per call leg (upsert — re-flagging overwrites
  reason/flagger, unflagging deletes the row). Anyone who can view a leg may flag/unflag it
  (agent-flags-own-call included, not excluded — the task's "agent or manager" wording is
  illustrative of who actually uses this, not a role exclusion; owner/admin already have
  equal-or-greater access everywhere else in this app).
- **Timestamped comments**: `recording_comments` (`author_user_id`, `at_second`, `text`) —
  append-only (no update/delete policy, same convention as `org_audit_log`). An agent's own
  visibility already restricts them to their own calls, so "agents can reply on their own calls"
  needs no separate reply-vs-comment distinction — it's the same INSERT policy.
- **Scorecards, no AI**: owner/admin define `scorecard_rubrics` (named, `active` for retiring one
  without losing history) with `scorecard_rubric_criteria` (`scale_1_5` or `yes_no`). A manager
  (pod-scoped) or owner/admin scores a call via `set_call_scorecard` (upserts `call_scorecards` +
  fully replaces `call_scorecard_scores` for that call each time — simplest correct semantics,
  not a merge) — validates the target agent is in scope AND every criterion actually belongs to
  the rubric being scored against, then audit-logs `scorecard.set` (the task's own explicit
  requirement; flags/comments are NOT audit-logged, only scorecard edits are). `my_scorecard_
  trend(p_org)` is the agent's own self-view: blends `scale_1_5` (rescaled 0-100) and `yes_no`
  (100/0) into one comparable `score_pct` per scorecard, oldest to newest.
- **NOT done this task**: the Recordings page UI itself (`apps/web/src/components/Recordings.tsx`
  and the corresponding `api.ts` wrappers) — the full backend (schema, RLS, RPCs, the signed-URL
  widening) is complete and dry-run-tested (`audit/M5-B5/dryrun-tests.sql`), but no frontend was
  wired this session; NEEDS-LIVE-VERIFY for the same reason every DB-only task in this mission is
  (no QA browser access this pass).

## Constraints & gotchas

- **`verify_jwt = false` is deliberate** (`supabase/config.toml:358-359`): the gateway's 401 carries no CORS headers, so the browser sees an opaque network error.
- **A new function needs BOTH.** No `[functions.<name>]` block → silently inherits `verify_jwt = true`; a `false` block with no `getUserFromRequest` call → wide open.
- **`getUserFromRequest` round-trips to GoTrue every request** (`:20-27`), adding auth latency on the dial loop's critical path.
- **Service-role clients bypass RLS entirely** — the guard is hand-written scoping, and omitting it is a silent cross-tenant read with no second layer to catch it.
- **`notifications` UPDATE has `USING` but no `WITH CHECK`; verified fine** (Postgres falls back to `USING`). No INSERT policy by design — writes come only from `ensure-week-summary`'s service-role client.
- **`Access-Control-Allow-Origin: '*'`** (`supabase/functions/_shared/cors.ts:2`) — safe only because identity is a bearer token, not a cookie.
- **Email confirmation is off; password floor is 6 characters** (`supabase/config.toml:210`, `:175`) and the strength meter never blocks a weak one — but as of TASK-L4 an account can only be created from a real invite in the first place, so this now bounds what an *invited* user's password can be, not "anyone."
- **`raw_user_meta_data` is user-writable via the client SDK** — display-only, never an input to an authorization decision.

## Not covered here

Webhook signature mechanics → `.brain/domains/telephony.md`; dial-loop ownership checks → `.brain/domains/dialer.md`; CSV import validation → `.brain/domains/contacts.md`.

## Unverified

- **Whether production matches `supabase/config.toml`** — `verify_jwt`/`[auth]` are also settable in the hosted dashboard and can diverge; local migrations may lag the deployed schema.

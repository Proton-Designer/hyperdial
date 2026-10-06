---
id: mem.decisions
title: Decisions
layer: L2
type: memory
status: canonical
owner: maintainer
updated: 2026-09-21
related:
  - arch.system-overview
  - mem.known-issues
answers:
  - "why was X chosen"
  - "why do we do it this way"
  - "was Y considered"
  - "why is there a Redis and a Postgres"
  - "why is the webhook unauthenticated"
  - "why is components/ui not formatted"
covers: "Decisions made, alternatives considered, what superseded what"
excludes: "Work in progress (see mem.active-work), currently-broken behaviour (see mem.known-issues)"
tokens_est: 40396
---

# Decisions

Newest first. Each entry answers: what was decided, why, and what it rules out.

> Entries dated 2026-09-21 were recorded during the repository modernization and
> Agent-Brain install. Earlier decisions are **reconstructed from code**, not from
> a written record — they are labeled as such, and their "decided by" is unknown.

---

## 2026-10-06 — Shifts: reuse the org model, `agent_state_events` and the org's GHL connection instead of the spec's own tables and secrets

**Status:** Active · **Decided by:** lead (docs/design/shifts.md section 1, decisions D1, D5, D7, D8, D14); recorded by eng2 (TASK-D1). Domain: `.brain/domains/shifts.md`.

**D1 — no `profiles` table.** The spec assumed intern/manager/admin roles in a new table. Tenancy already lives in `org_members` (owner/admin/manager/agent) with pods and
`private.is_agent_in_callers_pod_scope`; a second role system would disagree with it. So intern = `agent`, "Henry" = manager (own pods) or admin, and every shifts table carries `org_id`.
Rules out: any `is_manager()` helper of its own. Consequence: if a manager must see every intern, make them `admin`.

**D5 — KPIs reuse `agent_state_events`.** The spec added a `dialer_session_events` table and edits to the dialer-session functions. The existing trigger/`transition_session` already write one row per
session state with the server clock, including engine-driven completion, so active dialing time is derived from those rows; open rows are closed at the last contact-leg end plus `open_session_tail_minutes`.
Rules out: touching `dialer-engine.ts` or any `dialer-session-*` function for Shifts (those paths are never local).

**D7 — GHL credentials come from the org's connection, not env secrets.** Token + location come from `org_integrations` and the Vault exactly as `ghl-sync-worker` reads them; the calendar id and the
manager's GHL user id are per-org columns on `shift_settings`. An org with no connection or no calendar leaves outbox rows pending with a clear `last_error`; it never crashes.

**D8 — a separate outbox and worker.** `shift_ghl_outbox` is drained by `shift-ghl-sync` (every minute plus a nudge after writes); `crm_sync_jobs`/`ghl-sync-worker` are untouched, so a Shifts bug
cannot stall disposition syncing. The worker enforces per-contact ordering, per-org 429/401/403 holds and timeouts.

**D14 — off-shift dialing is a guarded trigger, not an engine change.** An AFTER INSERT trigger on `dial_sessions` (swallowing all errors, so it can never block a session insert) queues the Off-shift
dialing event when Shifts is on, the agent participates and no scheduled shift is within 15 minutes. The dialer banner is purely client-side and informational.

---

## 2026-09-24 — Dial capacity (`lines`) is enforced inside `claim_next_leads`, under a row lock, not by the caller

**Status:** Active · **Decided by:** eng2 (TASK-P2-E2 fix-forward, item 1; lead's diff-read of the first version of this engine)

**Context:** The first version of `refillSession` computed `n = lines - activeLegs` in TS from its own read, then called `claim_next_leads(session, n)`. Two
leg-end webhooks for the same session processed concurrently each read the same active-leg count before either had inserted anything, so each independently
computed "room for N more" and together could dial past `lines` — the exact kind of race a same-process sequential acceptance script (`dialer-sim.ts`) cannot
exercise by construction, only a genuinely concurrent test can (see `run-dialer-concurrency-test.sh`'s scenario 2, which does, with two real overlapping psql
connections).

**Decision:** `claim_next_leads(p_session)` (no more `p_n`) now does the capacity check AND inserts each claimed lead's placeholder `call_legs` row itself, in
one statement, under a `select ... for update` lock on the `dial_sessions` row held for the whole call. A second concurrent call for the same session blocks on
that lock until the first commits, then recomputes capacity against the fresh, post-insert count. The caller (`refillSession`) no longer decides "how many" —
it only dials whatever the RPC handed back. The placeholder `call_control_id` is keyed on a fresh random uuid per attempt, not the lead id (a lead-id-keyed one
collided with a prior failed attempt's still-there dead row on the very next retry, aborting the whole claim for the session — caught in review before this
ever ran live).

**Consequences:** `refillCount` (`dialer-core.ts`) is now only a fast-path hint in `refillSession` (skip the RPC call when obviously full), not the source of
truth for capacity — its own deno tests still describe the right shape of "how many," just no longer the authoritative one. `dialer-session-get`'s leg list
needed a tie-break (`order by created_at, id`) since several legs from one refill now share the exact same `created_at` (one INSERT, `now()` stable within a
statement) — display-only, nothing reads `call_legs.created_at` for logic.

**Do not undo without understanding:** moving the capacity check back into TS (or splitting it from the leg insert into two separate RPC calls) reopens the
overdial race exactly as before, even if each individual call "looks" atomic — the lock has to span both the read and the write in one statement/transaction.

## 2026-09-24 — A conditional UPDATE in Postgres replaces Redis's SET NX for the single-winner claim

**Status:** Active · **Decided by:** eng2 (TASK-P2-E2, supersedes the "Redis alongside Postgres,
for live call state" entry below)

**Context:** Design §4.3 and TASK-P2-E1 already built `claim_leg(session, leg)` — a single
UPDATE (`set active_leg_id = p_leg ... where state = 'dialing' and active_leg_id is null`) that
gives exactly one caller `found = true` no matter how many legs answer at once, the same
single-winner guarantee `claimHumanAnswer()`'s Redis `SET NX` existed to provide. TASK-P2-E2's
engine rewrite is the point where the dial path actually stops calling the Redis-based legacy
engine at all — `_shared/dialer-engine.ts` is a full rewrite with zero Redis imports, and
`telnyx-webhook`/all six `dialer-session-*` functions were rewritten alongside it to match.

**Decision:** Redis leaves the dial path entirely. `_shared/redis.ts` itself is NOT deleted
(other, non-dial code may still reference it; Phase 4 is the planned removal) and the legacy
`dialer_sessions`/`call_logs` tables and their Redis-driven engine code path are left in place,
unused, per the design's own "keep them, don't write to them from new code" instruction — this
is an addition of a parallel org-scoped schema (`dial_sessions`/`call_legs`), not an in-place
migration of the old one.

**Consequences:** the single-winner claim is now a plain Postgres row lock + conditional UPDATE,
verified live under `functions serve` (`scripts/dev/dialer-sim.ts`) to correctly resolve exactly
one winner across concurrently-answered legs. No new latency concern versus Redis in practice —
the UPDATE is a single indexed row write, same order of magnitude as a Redis round trip, and it's
already in the same transaction as the rest of the leg's state change instead of a second
datastore to keep consistent with Postgres.

**Do not undo without understanding:** this only holds because `claim_leg`'s UPDATE is the *sole*
writer of `dial_sessions.active_leg_id` for the win decision — any future code path that sets
`active_leg_id` some other way (a raw UPDATE, a different RPC) reopens the exact race Redis's
`SET NX` was there to prevent.

## 2026-09-24 — TASK-P1-02: `requireOrgRole` queries `org_members` directly; dedup is now org-wide

**Status:** Active · **Decided by:** eng1

Reviewing TASK-P1-05 found `private.set_org_telnyx_key`/`get_org_telnyx_key` unreachable from a
service-role function (`private` not PostgREST-exposed; `service_role` lacks schema `USAGE`, only
`authenticated` has it) — both reproduced live. `requireOrgRole` (`supabase/functions/_shared/auth.ts`)
needs the same kind of check, so it queries `org_members` directly with a service-role client rather
than calling `private.is_org_member`/`has_org_role`: sidesteps the reachability bug and loses nothing,
since a service-role client already bypasses that table's RLS (the helpers stop recursion *inside
policies*, irrelevant here). Implemented as `requireOrgRole(req, roles)` — org resolved internally,
not passed in — correcting `docs/design/stage-1-architecture.md` §2's `requireOrgRole(req, orgId, roles)`.

Also: `contacts-import`'s phone-dedup check moved from per-importing-user to `org_id`-scoped, since
the shared pool under org tenancy is the org's contacts, not one member's. Verified live: a second
member importing a number a first already imported now reports it as a duplicate.

## 2026-09-24 — Every cross-table check inside an RLS policy goes through a SECURITY DEFINER helper

**Status:** Active · **Decided by:** eng1 (TASK-P1-01, overnight run 2026-09-23)

**Context:** The tenancy migration's design task explicitly banned inline subqueries on
`org_members` inside a policy, to avoid RLS recursion. While writing the RLS test matrix
(`supabase/tests/rls_org_matrix.sql`), the same failure mode showed up one hop further out:
`campaign_leads`' INSERT `WITH CHECK` queried `contacts` (plain subquery, invoker rights), and
`contacts`' own SELECT policy queries `campaign_leads` back for the agent-visibility branch. That
closed a cycle — Postgres detected it at runtime: `infinite recursion detected in policy for
relation "campaign_leads"`.

**Decision:** every policy that needs to read a *different* table now does it through a
`private.*` `SECURITY DEFINER STABLE` function (`campaign_org_id`, `contact_org_id`,
`agent_assigned_to_campaign`, `agent_has_contact_access` — alongside the original
`is_org_member`/`has_org_role`), never an inline `EXISTS (SELECT ... FROM <other table> ...)`. The
table owner (the migration role) bypasses RLS inside a SECURITY DEFINER function it owns, so the
referenced table's own policies never re-enter.

**Do not undo without understanding:** writing a new org-scoped policy that queries another
RLS-protected table inline is the same class of bug, just waiting for the right two tables to
reference each other. Add a `private.*` helper instead.

## 2026-09-24 — `call_events.org_id` stays nullable

**Status:** Active · **Decided by:** eng1 (TASK-P1-01), per `CLAUDE.md`'s "if the code proves a
design point wrong, choose the most reasonable fix and correct the design doc" instruction.

**Context:** `docs/design/stage-1-architecture.md` §2 calls for `org_id NOT NULL` on
`call_events` along with every other business table. But `call_events.user_id` has always been
nullable (`ON DELETE SET NULL`, `20250213000001`) and rows with a null `user_id` are already
unreachable under RLS — there is no user to derive an org from during backfill, and the live
project is real, recovered data of unknown shape.

**Decision:** `call_events.org_id` is nullable (`ON DELETE SET NULL`, mirroring `user_id`); every
other table in scope (`campaigns`, `campaign_leads`, `contacts`, `user_phone_numbers`,
`notifications`, `dialer_sessions`, `call_logs`) is `NOT NULL` as designed. The design doc is
corrected in the same commit as this migration.

## 2026-09-24 — A freshly created schema does not inherit `public`'s default `USAGE` grant

**Status:** Active · **Decided by:** eng1 (TASK-P1-01)

**Context:** The tenancy migration puts the RLS helper functions (`is_org_member`,
`has_org_role`, etc.) in a `private` schema so they are not API-exposed. Postgres grants `USAGE`
and `CREATE` on the `public` schema to `PUBLIC` by default, but that default is specific to
`public` — a newly created schema grants privileges to nobody but its owner. `authenticated`
therefore needs an explicit `grant usage on schema private to authenticated;`, or every policy
calling a `private.*` function fails with "permission denied for schema private" the moment a
real request hits it (caught while writing `supabase/tests/rls_org_matrix.sql`, before any commit
— see `mem.lessons`).

**Do not undo without understanding:** removing that grant (e.g. while "cleaning up" the schema)
silently breaks every RLS policy that calls a `private.*` helper.

## 2026-09-21 — Restore a real Tailwind build; delete the compiled CSS

**Status:** Active · **Decided by:** maintainer (approved during modernization)

**Context:** The web app's src/index.css was a 2,549-line *precompiled* Tailwind v4
artifact shipped by the original Figma Make export. Tailwind was not a
dependency, there was no config, and `apps/web/src/styles/globals.css` — the file holding
every design token — was imported by nothing. The practical effect: **any new
Tailwind utility class silently did nothing.** A developer writing `mt-5` on a new
component would see no margin and no error.

**Decision:** Install `tailwindcss` + `@tailwindcss/vite`, make `globals.css` the
single entry point, delete the compiled `index.css`.

**Why:** A styling system where new classes silently fail is worse than no system,
because the failure mode is invisible and gets attributed to the component.

**Alternatives considered:**
- *Leave it and document the limitation* — rejected: it preserves a trap.
- *Migrate off Tailwind entirely* — rejected: ~700 utility classes in use across
  the components; the cost is enormous and buys nothing.

**Consequences:**
- New utility classes work. Design tokens in `globals.css` are now live.
- CSS grew 55KB → 116KB uncompressed (17KB → 18KB gzipped) because the build now
  emits Tailwind preflight and every class actually used.
- Verified by building and rendering the app; output matches the previous UI.

**Do not undo without understanding:** reintroducing a checked-in compiled
stylesheet restores a build where `globals.css` is decorative and new classes fail
silently.

---

## 2026-09-21 — Add `tw-animate-css`

**Status:** Active · **Decided by:** maintainer

**Context:** shadcn/ui primitives depend on `animate-in`, `animate-out`,
`fade-in-0`, `zoom-in-95`, accordion-up / accordion-down, and `caret-blink`. **None of those
were present in the old compiled CSS either.** Every Radix enter/exit animation in
the app had been silently dead since the Figma export.

**Decision:** Add `tw-animate-css` (the Tailwind v4 successor to
`tailwindcss-animate`) and import it from `globals.css`.

**Why:** These aren't new features — they are the intended behaviour of components
already in the tree. This restores them rather than adding them.

**Consequences:** Dialogs, dropdowns, sheets, and accordions now animate. If a
transition looks wrong somewhere, this is why it changed.

---

## 2026-09-21 — `apps/web/src/components/ui/` is excluded from Prettier

**Status:** Active · **Decided by:** maintainer

**Decision:** Add `apps/web/src/components/ui/` to `.prettierignore`.

**Why:** These 48 files are generated shadcn/ui primitives. Reformatting them
makes every future upstream diff unreadable, which raises the cost of the thing we
most want to stay cheap: regenerating them.

**Consequences:** They keep their upstream double-quote style while the rest of the
repo is single-quoted. That inconsistency is deliberate. ESLint still checks them.

**Do not undo without understanding:** "formatting the whole repo consistently"
sounds obviously right and is the exact instinct this entry exists to stop.

---

## 2026-09-21 — `supabase/` stays at the repository root

**Status:** Active · **Decided by:** maintainer

**Context:** The restructure moved `Frontend/` to `apps/web/` under an npm
workspace. The symmetrical move would have been an apps/api or packages/supabase directory.

**Decision:** Leave `supabase/` at the root.

**Why:** The Supabase CLI resolves `supabase/config.toml`, `migrations/`, and
`functions/` relative to the project root. Moving it means fighting the tool on
every command for cosmetic symmetry.

**Do not undo without understanding:** a future tidy-up that "finishes the
monorepo migration" will break `supabase db push` and every function deploy.

---

## 2026-09-21 — Telnyx skills and Agent-Brain are git submodules, not vendored copies

**Status:** Active · **Decided by:** maintainer

**Context:** `telnyx-ext-agent-skills` existed as a gitlink with **no
`.gitmodules` entry** — a broken half-submodule. Anyone cloning the repo got an
empty directory and no error.

**Decision:** Register both vendor directories — telnyx-agent-skills and
agent-brain — as proper submodules.

**Alternatives considered:**
- *Vendor the 269 files in* — rejected: +3.1MB and immediate upstream drift.
- *Delete it* — rejected: it is actively useful Telnyx reference.

**Consequences:** `git clone --recurse-submodules` is now required for the full
tree. The build does not depend on either, so a plain clone still works.

---

## 2026-09-24 — `dialer-sweeper`: the second `pg_cron` job in this repo

**Status:** Active · **Decided by:** eng2 (TASK-P2-E5)

**Context:** `claim_next_leads`/`transition_leg`/`transition_session`/`apply_leg_outcome` are all
"only ever fires in response to a webhook or an API call" — nothing periodically re-checks
state a lost webhook can leave stranded (a leg with no event for minutes, an in_flight lead
whose leg already resolved but never got `apply_leg_outcome` applied, a session whose agent leg
died). TASK-P3-P3 had already built the first `pg_cron`/`pg_net` scaffolding in this repo
(`private.crm_sync_worker_config`/`trigger_ghl_sync_worker`, `20260924002000`) for the exact
same class of problem in the GHL outbox — a periodic reconciliation worker, not a request-driven
one.

**Decision:** Reuse that scaffolding's shape verbatim for a second, independent worker rather
than generalizing it into one shared "cron worker" abstraction: `private.dialer_sweeper_config`
(a second one-row Vault-backed config singleton), `private.trigger_dialer_sweeper()`, and
`cron.schedule('dialer-sweeper', '30 seconds', ...)` (`20260924001700_dialer_sweeper_cron.sql`).
**This repo now has two `pg_cron` jobs**: `ghl-sync-worker` (every 1 minute) and `dialer-sweeper`
(every 30 seconds, pg_cron 1.6.4's sub-minute `'N seconds'` schedule syntax, verified directly
against the local instance before relying on it). Two tables/two trigger functions instead of
one generalized "worker config" table was a deliberate choice: the two workers have different
polling cadences, different secret env vars, and no shared caller — a shared table would only
save a few lines of boilerplate at the cost of coupling two otherwise-independent lanes' schemas
together.

**Alternatives considered:**
- *One generic `private.cron_worker_config(name, url, secret)` table for all future workers* —
  rejected for now: two data points isn't enough to know the right shape for a third worker yet,
  and premature generalization here would touch TASK-P3-P3's already-shipped migration.

**Consequences:** any THIRD periodic worker this repo adds should look at both
`20260924002000_ghl_push_worker.sql` and `20260924001700_dialer_sweeper_cron.sql` before writing
a new one — if the shape is still identical a third time, that's the actual signal to
generalize, not before.

---

## Reconstructed from code — not from a written record

The following predate this install. The reasoning is **inferred from the
implementation** and was not confirmed with the original author. Recorded because
the constraints are real and easy to break; labeled because the *why* is
reconstructed.

### Redis alongside Postgres, for live call state

**Status: SUPERSEDED 2026-09-24, see "A conditional UPDATE in Postgres replaces
Redis's SET NX for the single-winner claim" below.** Kept for history: the
concern this entry raised (Edge Functions are stateless/concurrent, so the
webhook handler needs *some* atomic single-winner primitive) was correct — it's
exactly why the replacement is also a single atomic conditional UPDATE, just in
Postgres instead of Redis.

`claimHumanAnswer()` (`_shared/redis.ts:110`) is a Redis `SET NX` with a 300s TTL.
It is what guarantees that when several legs in a batch are answered by humans at
once, **exactly one** is bridged. Supabase Edge Functions are stateless and
concurrent, so the webhook handler has no in-process lock to use; Postgres could
express this but not at the per-webhook latency the dial loop needs.

**Do not undo without understanding:** removing Redis to "simplify to one
datastore" reintroduces a race in which two contacts are bridged to one agent, or
legs that should have been hung up keep ringing -- unless the single-winner
guarantee is coming from somewhere else (it now is, see the entry below).

### `telnyx-webhook` is deployed `--no-verify-jwt`

Telnyx has no Supabase session and cannot present a JWT. The endpoint substitutes
signature verification against `TELNYX_WEBHOOK_SECRET`.

**Do not undo without understanding:** the signature check is the *only* thing
protecting the dial engine from the open internet. Removing it while leaving
`--no-verify-jwt` in place exposes the loop entirely.

### Navigation is `useState`, not a router

`MainApp.tsx` switches screens on a `TabType` union. There is no `react-router`.

Consequence, stated because it is regularly rediscovered: **there are no URLs for
app state.** No deep links, no browser back, no refresh-in-place. Adding a router
later is a real migration, not a drop-in.

### The client/server contract is hand-written

`apps/web/src/lib/api.ts` (698 lines) declares every request and response type by
hand. No generated client, no shared types package.

**Consequence:** changing an Edge Function's response shape produces **no
TypeScript error** — only a runtime failure. Treat every function signature change
as a two-sided change.

### `telnyx-connect` idempotency is by our own stored IDs, not a Telnyx-side search

**Status: SUPERSEDED 2026-09-24, see the entry below.** Kept for history: the concern this entry raised (a retry with no stored IDs would duplicate Telnyx
resources) turned out not to be hypothetical — it's exactly what TASK-P1-05's eng1 review found happening in practice (`mem.known-issues` #0c), because the
key-storage step failed *before* IDs were ever persisted, on every attempt.

Design §3 says re-running "Connect Telnyx" should reuse existing resources "found
by tag or name." `_shared/telnyx-provision.ts` (TASK-P1-05) instead reuses whatever
IDs are already in `org_telephony` and only creates what's missing — we're the only
writer of that table, so our own stored state is a reliable idempotency key without
querying Telnyx to search for a same-named resource.

**Do not undo without understanding:** if `org_telephony`'s row for an org is ever
deleted or its IDs cleared without also deleting the underlying Telnyx resources,
reconnecting will create duplicate outbound voice profiles / Call Control
Applications / credential connections rather than finding the orphaned ones. A
future "resync" or "adopt existing resources" flow would need an actual Telnyx-side
search by name; this decision trades that for simplicity tonight.

### `telnyx-connect` provisioning does a real Telnyx-side find-by-name before creating (supersedes the entry above)

**Status:** Active · **Decided by:** eng2 (TASK-P1-05 fix, 2026-09-24)

**Context:** eng1's review of TASK-P1-05 found the key-storage RPC unreachable (`mem.known-issues` #0c), which meant every real connect attempt provisioned real
Telnyx resources and then failed *before* persisting their IDs — so the "reuse by stored ID" idempotency above never had an ID to find on retry, and would have
created duplicate resources on every single attempt, not just in the deleted-row edge case originally imagined.

**Decision:** `_shared/telnyx-provision.ts` now calls a Telnyx-side `find*ByName` lookup (new `TelnyxClient` methods, using each resource's list-endpoint name
filter — verified against `spec3.json`) for any resource with no ID in `existing`, before creating. This is the design's original "found by tag or name" (§3),
reinstated once the ID-only shortcut proved unsafe. Deterministic per-org names (`resourceNamesForOrg`) make the lookup exact enough in practice; the client-side
code still compares the returned name field for an exact match (the profile/app filters are substring `[contains]`, not exact).

**Consequences:** one extra GET per missing resource on every provisioning call (negligible latency next to the Telnyx account-key round trip already happening).
Reconnecting after a fully-deleted `org_telephony` row now correctly finds and reuses orphaned Telnyx resources instead of duplicating them, closing the gap the
superseded decision above knowingly accepted.

**Do not undo without understanding:** reverting to ID-only reuse silently reopens both the deleted-row case and — more importantly — the every-single-retry case a
future persistence failure (of any kind, not just this specific RPC bug) would reintroduce.

### "Dialing hours today" defaults to America/Chicago, not a per-org timezone

**Status:** Active · **Decided by:** eng2 (TASK-M1, 2026-09-25)

**Context:** the task's own spec said "use the org's timezone if one exists, else America/Chicago." Grepped every migration before writing `dialing_hours_today`
(`20260925020000_call_legs_duration_conversations.sql`) — no `orgs` table has a timezone column today, so there was nothing to prefer over the fallback.

**Decision:** hardcode America/Chicago for "today"'s midnight boundary (`date_trunc('day', now() at time zone 'America/Chicago') at time zone 'America/Chicago'`).
Verified against the code rather than assuming the task description's premise was current (CLAUDE.md's own standing instruction).

**Do not undo without understanding:** if an org timezone column is ever added, `dialing_hours_today` is the one place that needs to start reading it — every
agent's "today" currently resets at the same instant regardless of where they actually are.

### `dashboard-stats`'s new Conversations/hr fields keep the SAME per-agent scoping as every existing field on that endpoint, not an org-wide rollup for owner/admin

**Status:** Active · **Decided by:** eng2 (TASK-M1, 2026-09-25)

**Context:** TASK-M1's own task file said the new fields should scope "the same scoping dashboard-stats already uses for the other cards" and described that as
"an agent sees their own numbers; owner/admin see the whole org." Reading `dashboard-stats/index.ts` before writing anything showed that's not what the endpoint
actually does — every existing field (`callsToday`/`connectRate`/`talkTimeFormatted`) is filtered by `.eq('agent_id', userId)` unconditionally, for every role. Its
own comment says so explicitly: "this is the caller's own personal daily widget... every role can see their own numbers." The org-wide rollup is `team-performance`'s
job, a different endpoint.

**Decision:** matched the endpoint's REAL existing behavior (own-agent-only, every role) rather than the task description's assumption about it — CLAUDE.md: "when
a summary and the code disagree, the code is right — fix the summary." Noted in `.brain/domains/analytics.md`'s gotchas instead of silently building the org-wide
version the task file described.

**Do not undo without understanding:** if a FUTURE task wants an org-wide Conversations/hr for owner/admin, that's a new capability on `team-performance` (or a
new endpoint), not a scoping change to this one — changing `dashboard-stats` itself to vary by role would also change the three EXISTING fields' behavior for
every current caller of this endpoint.

### `campaign_retry_rules` is a real table, not a jsonb column on `campaigns`

**Status:** Active · **Decided by:** eng2 (TASK-F-T1, 2026-09-25)

**Context:** the task's own design section offered either shape and asked for the choice to be documented. Every other per-campaign/per-org config in this schema
(`dispositions`, the dial-settings columns on `campaigns` itself) is flat columns or a dedicated table, never a jsonb blob.

**Decision:** a table, one row per `(campaign_id, disposition_key)`. Gives the Settings/campaign-settings editor UI a normal row-per-disposition shape to list/edit
without JSON-path plumbing, and RLS-scopes cleanly per row via the existing `private.campaign_org_id` helper the same way every other campaign-scoped table does — a
jsonb column on `campaigns` would inherit `campaigns`' own row-level RLS instead of anything finer, and would need application-level validation for shape/uniqueness
that a `unique (campaign_id, disposition_key)` constraint gives for free here.

**Do not undo without understanding:** a future "make retry rules bulk-editable per org, not per campaign" ask is still cheap from a table (a second table, or a
nullable `campaign_id` with an org-level default row) — collapsing to jsonb now would make that harder, not easier.

### `campaign_retry_rules` is seeded against this build's REAL disposition keys, not QUE-2's literal PDF names

**Status:** Active · **Decided by:** eng2 (TASK-F-T1, 2026-09-25)

**Context:** QUE-2's own requirements table names `voicemail_left`, `do_not_call`, `gatekeeper`, and `already_on_platform`. Grepping `private.seed_default_dispositions`
(`20260924002200_dispositions.sql`) shows this build actually seeded a simpler 7-key set: `interested`/`callback`/`not_interested`/`wrong_number`/`dnc`/`voicemail`/
`no_answer`. CLAUDE.md's own standing instruction: when a summary/spec and the code disagree, the code is right.

**Decision:** mapped `voicemail_left → voicemail` and `do_not_call → dnc` (same disposition, different name), and deliberately did NOT fabricate rule rows for
`gatekeeper`/`already_on_platform` — no matching disposition exists in this build at all, and dispositions are org-editable, so an org that adds a real "Gatekeeper"
disposition later gets its own retry rule row seeded through the normal `disposition_key` lookup path with no schema change needed.

**Do not undo without understanding:** if `gatekeeper`/`already_on_platform` are ever added to the seeded set, they'll silently start participating in retry-rule
lookups the moment a matching `campaign_retry_rules` row is added — no code change needed on the consuming side, this was already designed for that.

### `dnc_numbers` and `contacts.dnc` are two independent signals, with no sync trigger between them

**Status:** Active · **Decided by:** eng2 (TASK-F-T1, 2026-09-25)

**Context:** QUE-7 says "checked at dial time... plus the existing flag" — read as endorsing two independent checks, not one flag driving the other. Neither this
task nor TASK-P2-P1 (which added `contacts.dnc`) asked for a sync trigger.

**Decision:** `claim_next_leads` and the import DNC-skip path both check `dnc_numbers` and `contacts.dnc`/GHL's `dnd`/`dialer:dnc` tag independently, with no trigger
keeping them in sync in either direction. See `.brain/domains/contacts.md`'s new DNC section for the full detail.

**Do not undo without understanding:** a future task that wants "adding a number to the DNC list also flips every matching contact's flag" (or the reverse) is a
new, explicit trigger — not a bug in this one. Don't add one silently as a "fix" without confirming which direction (or both) is actually wanted.

### `_shared/queue-retry-rules.ts` exists purely for testability — it is never called by runtime code

**Status:** Active · **Decided by:** eng2 (TASK-F-T1, 2026-09-25)

**Context:** the task asked for "a pure SQL helper, plus a TS twin in dialer-core if the engine needs it, with unit tests." Tracing every leg-creation and
disposition/outcome-write path confirmed each one already executes its retry/time-block decision atomically inside one SQL function call (`claim_next_leads`,
`apply_leg_outcome`, `submit_disposition`) — there's no "TS decides, then SQL enacts" step for this the way `dialer-core.ts`'s `legTransition` precedes
`transition_leg` for the dialer's other state transitions.

**Decision:** built the TS twin anyway (`supabase/functions/_shared/queue-retry-rules.ts`), purely so the block-rotation/retry-decision algorithm is deno-testable —
local Docker is retired, so the SQL side can only be verified via the live dry-run script, and the task's own verification section explicitly asked for unit tests
on this exact algorithm. Documented in the file's own header that it is never imported by runtime code.

**Do not undo without understanding:** the SQL functions (`private.time_block_for`/`private.rotated_retry_schedule`) are the only versions of this logic that ever
actually run. If the block boundaries or rotation order ever change, both copies need the same edit by hand — there is no single source of truth to update once.

### `campaign_retry_rules` RLS: member-read, admin-write (not admin-only-read)

**Status:** Active · **Decided by:** eng2 (TASK-F-T1, 2026-09-25)

**Context:** the task's own verification section describes the RLS assertion to write as "a member can read, an agent cannot delete" — the same member-read/
admin-write shape `dispositions` and the new `dnc_numbers` table both already use. A first draft of this migration made `campaign_retry_rules` admin-only for
SELECT too, reasoning that no agent-facing UI reads it directly.

**Decision:** changed the SELECT policy to `private.is_org_member(...)` before this migration was ever applied, matching the task's literal verification wording
and keeping the RLS shape consistent across all three per-org config tables this task and its neighbors touch (`dispositions`, `dnc_numbers`, `campaign_retry_rules`).
Every RPC that consults this table runs SECURITY DEFINER regardless, so the narrower admin-only-read would have bought nothing beyond a purely theoretical
tightening — not worth diverging from the established shape for.

**Do not undo without understanding:** if a future task genuinely wants retry rules hidden from non-admin members (e.g. a UI ever surfaces them to agents and
that turns out to be undesirable), that's a deliberate re-tightening decision to make explicitly, not something to "notice" and quietly revert.

### Call recording: call-level `record_start` (channels: dual), not conference-level

**Status:** Active · **Decided by:** eng2 (TASK-F-T2, 2026-09-25)

**Context:** the task asked to "confirm in the docs whether conference-level record_start would be better or cheaper" before picking one. Read spec3.json's real
`StartRecordingRequest` schema (not assumed): `channels: 'dual'`'s own description is "final audio file will be stereo recorded with the first leg on channel A,
and the rest on channel B" — meaning a single participant leg's own `record_start` already captures the whole bridge, not just that one leg's own audio.

**Decision:** `handleWin` (`_shared/dialer-engine.ts`) calls `client.recordStart` on the WINNING contact leg only, `channels: 'dual'`, right after the bridge
succeeds (after `bridged_at` is stamped). No conference-level `record_start` — it would be redundant (same audio) and would also complicate mapping the resulting
webhook back to a single `call_legs` row (a conference recording keys by `conference_id`, not a leg), for zero benefit since only the winner's own recording is
ever needed.

**Do not undo without understanding:** if a future task ever needs the LOSING legs' own audio too (not just the bridge), that's a materially different feature —
don't "fix" this into conference-level recording as a shortcut for that; it changes what gets captured.

### Call recording webhook: mapped via `client_state`, never `call_control_id` — and no `recording_id` field exists

**Status:** Active · **Decided by:** eng2 (TASK-F-T2, 2026-09-25)

**Context:** the task doc assumed `call.recording.saved`'s payload carries `recording_id`/`duration_millis` and could be correlated like other call events. Verified
against the real spec3.json (`CallRecordingSaved.payload`) and `webhook-events.json`: this event's payload has NO `call_control_id` and NO `recording_id` at all —
only `call_leg_id`/`call_session_id` (both different UUIDs from `call_control_id`), `recording_started_at`/`recording_ended_at` (duration is derived, not read off
a field), and `recording_urls.{mp3,wav}` (valid 10 minutes).

**Decision:** `record_start`'s own `client_state` param carries the SAME `{org,session,leg}` shape `encodeDialClientState` already produces for the dial itself
(a distinct, per-command client_state — Telnyx echoes it back only on webhooks resulting from that command). `processRecordingEvent` (`dialer-engine.ts`) looks the
leg up via the existing `loadLegByCallControlIdOrClientLeg` fallback, which already falls through to `clientState.leg` whenever the `call_control_id` lookup
misses — exactly what happens here since the lookup key it's given (`call_session_id`, telnyx-webhook/index.ts's own fallback) never matches a real
`call_legs.call_control_id`. Telnyx's own `call_leg_id` is stored as `call_legs.recording_telnyx_call_leg_id` (never called a "recording id" anywhere in code) —
kept only so a future manual retry beyond the 10-minute URL window could re-resolve the real recording resource via `GET /recordings?filter[call_leg_id]=`.

**Do not undo without understanding:** don't "simplify" this to match on `call_control_id` like every other call.* event — that field genuinely does not exist on
this webhook's payload; matching on it would silently never fire.

### Recording retention: an Edge Function deletes, not a raw SQL `DELETE FROM storage.objects`

**Status:** Active · **Decided by:** eng2 (TASK-F-T2, 2026-09-25), approved by the lead

**Context:** the task allowed either approach ("Verify that's supported, or else have the cron call an Edge Function"). Could not verify live, with local Docker
retired, whether a bare SQL delete of a `storage.objects` metadata row alone actually removes the underlying file from the backing store, or just orphans it.

**Decision:** `recording-retention` (Edge Function, triggered daily at 03:17 by the exact same pg_cron/pg_net shared-secret pattern as `dialer-sweeper`/
`ghl-sync-worker`) calls `supabase.storage.from('recordings').remove([path])` -- Supabase's own documented, always-correct way to delete both the object and its
metadata row -- then nulls `call_legs`' recording columns only after the storage delete is confirmed to have succeeded (never optimistically before).

**Do not undo without understanding:** if a future task wants this in pure SQL instead, first verify live (a real object, a real SQL delete, then check the
actual storage bucket contents) that the file is really gone, not just the metadata row — don't assume it works from the SQL alone.

### `org_recording_settings`: a new dedicated table, not `orgs` or `org_telephony`

**Status:** Active · **Decided by:** eng2 (TASK-F-T2, 2026-09-25)

**Context:** the task allowed "recording_enabled (default true) on orgs, or the settings table the code already uses," and wants owner+admin write.
`public.orgs`'s own UPDATE RLS policy is owner-only ("owner can update their org") — widening it for one column would either loosen it for everything or need
column-level grants layered on top of RLS, more machinery than one boolean warrants. `org_telephony` has ZERO client-facing RLS policies by design (the Telnyx key
must never be client-selectable at all) — adding a client-writable column there would break that invariant for the whole table.

**Decision:** a new table, `org_recording_settings` (org_id PK/FK, recording_enabled boolean default true), with member-read/owner-or-admin-write RLS -- the exact
same shape as `dnc_numbers`/`campaign_retry_rules` (TASK-F-T1). Auto-seeded per org via an AFTER INSERT trigger on `orgs`, same pattern as
`seed_default_dispositions`.

**Do not undo without understanding:** a missing row (pre-seed-trigger org, or a race) must default to `true` — both the column's own default and
`recording-core.ts`'s `isRecordingEnabled(null) === true` encode this twice, deliberately; don't "fix" one without the other if this is ever revisited.

### GHL note's recording link: a hardcoded app host, not a config value

**Status:** Active · **Decided by:** eng2 (TASK-F-T2, 2026-09-25)

**Context:** REC-5 wants the disposition note to link to the app (`https://hyperdial.myhomebasesolutions.com/contacts?leg=<id>`), never a raw signed URL (expires
in 10 minutes). `submit_disposition` (SQL) builds this string directly with the exact host the task named.

**Decision:** hardcoded in `submit_disposition`'s SQL, not read from an env var or a settings table -- Stage 1 is a single deployment with one fixed domain, no
per-org custom domain feature exists yet.

**Do not undo without understanding:** if a future task adds per-org custom domains, this string needs to become a real lookup (probably `org_telephony` or a
new org-settings column), not just a different hardcoded string -- don't patch in a second hardcoded host as a shortcut.

### REC-5's "contact history shows the recording link" — scope-cut, deferred to TASK-F-P4

**Status:** Active · **Decided by:** eng2 (TASK-F-T2, 2026-09-25), approved by the lead

**Context:** grepped the entire `apps/web/src` tree for any existing contact-call-history surface -- there is none; REC-5's second clause has nothing to attach to
yet. Building a whole new contact-history feature was out of scope for this task.

**Decision:** only the wrap-up modal's recording play button (REC-5's first clause) was built. Per the lead: expose a recording-available signal per leg for
whatever API TASK-F-P4's touch-history strip ends up using -- `call_legs.recording_path is not null` IS that signal already (no new column/API needed); F-P4
just needs to select it. Tracked as NOT-done in the task log, not silently dropped.

**Do not undo without understanding:** don't build a separate "recording available" boolean column -- `recording_path is not null` is already the single source
of truth; a redundant flag would just be another thing to keep in sync.

### TASK-F-P1 disposition-key renaming: ADD-only for existing orgs, never rename/migrate in place

**Status:** Active · **Decided by:** eng1 (TASK-F-P1, 2026-09-25)

**Context:** DSP-2's canonical 9-key set (`yes_build_profile`/`callback`/`not_interested`/`already_on_platform`/`wrong_number`/`gatekeeper`/`do_not_call`/
`voicemail_left`/`no_answer`) renames 3 of TASK-P3-E1's original 7 keys (`interested`→`yes_build_profile`, `dnc`→`do_not_call`, `voicemail`→`voicemail_left`)
and adds 2 new ones, resolving the gap TASK-F-T1's own decision record flagged ("if gatekeeper/already_on_platform are ever added to the seeded set, they'll
silently start participating in retry-rule lookups... this was already designed for that").

**Decision:** `seed_default_dispositions`/`seed_default_campaign_retry_rules` were redefined to the new key names for NEW orgs/campaigns. For EXISTING orgs/
campaigns, the migration re-runs the (redefined) seed function against every existing row -- `on conflict (org_id, key) do nothing` means only the missing new
keys get inserted; an org's old `interested`/`dnc`/`voicemail` rows (possibly already relabeled by that org) are left completely untouched. Chosen over an
UPDATE-based rename because an org may have already customized a seeded row's label/ghl_tag/active state, and renaming in place would silently discard that
customization with no way to recover it.

**Do not undo without understanding:** every pre-F-P1 org now has BOTH the old and new key for `interested`/`dnc`/`voicemail`-family dispositions active
simultaneously (e.g. "Interested / Meeting booked" AND "Yes - Build Profile" both selectable in the wrap-up modal) unless an admin deactivates one via
Settings. This is deliberate, not a bug -- see known-issues.md. `gatekeeper`'s lead_effect is `queued` (retry, same 4-day rotate-block cadence as
`no_answer`/`voicemail_left`) and `already_on_platform`'s is `exhausted` (no retry) -- both are eng1's own judgment calls, not from any literal spec text beyond
the two key names themselves.

### `submit_disposition`'s GHL payload carries `is_dnc` (derived from `lead_effect`), never the raw `disposition_key` string

**Status:** Active · **Decided by:** eng1 (TASK-F-P1, 2026-09-25)

**Context:** `ghl-sync-worker.ts`'s `processDispositionJob` used to gate `setDnd(...)` on `payload.disposition_key === 'dnc'`. Renaming the canonical DNC key
to `do_not_call` (see above) would have silently stopped DND from ever being set for any NEW org, since their disposition's key is never literally `'dnc'`.

**Decision:** `submit_disposition` now computes `'is_dnc', v_disposition.lead_effect = 'dnc'` into the enqueued job payload, and `processDispositionJob` checks
`payload.is_dnc` instead of the key string. Works for a legacy `'dnc'`-keyed org, a new `'do_not_call'`-keyed org, and any future org-custom-named disposition
with `lead_effect='dnc'`, with no special-casing anywhere.

**Do not undo without understanding:** never reintroduce a literal disposition-key string comparison for a semantic property that's really about `lead_effect`
-- dispositions are org-editable, so any hardcoded key string is one relabel away from silently breaking.

### DSP-9's per-contact disposition history is a narrower, wrap-up-modal-scoped surface -- not a replacement for TASK-F-P4's touch-history strip

**Status:** Active · **Decided by:** eng1 (TASK-F-P1, 2026-09-25)

**Context:** the entry above this one (REC-5 scope-cut) deferred a general contact-history UI to TASK-F-P4. DSP-9 asks for something narrower: the wrap-up
modal itself shows the last 3 dispositions for the contact being called right now.

**Decision:** built `public.contact_disposition_history(p_contact_id)`, a SECURITY DEFINER function callable directly by any authenticated org member --
NOT a service-role-only RPC like the dial-engine writes, because this is a same-shape "front door read" as team-performance, called straight from the browser
client. It bypasses `call_legs`' own per-session RLS on purpose (an agent can only SELECT their own sessions' legs directly; this function checks org
membership instead, since DSP-9 explicitly wants cross-agent history). `WrapUpModal` renders at most 3 entries with a recording play button
(`getRecordingUrl`, on click, same function REC-5 already built) when `has_recording` is true.

**Do not undo without understanding:** TASK-F-P4's own future touch-history strip (a fuller, contact-detail-page view, not modal-scoped) can and should reuse
`contact_disposition_history` (just drop the `limit 3`, or add a param) rather than building a second, parallel cross-agent-history query -- the RLS-bypass
reasoning above applies identically there.

### BUG-7: campaign AMD mode maps 1:1 to Telnyx's real enum (off/detect/detect_words/premium), and voicemail drop only works on two of the four

**Status:** Active · **Decided by:** eng2 (TASK-F-T3, 2026-09-25)

**Context:** the prior build's `amd_mode` only had `'on' | 'off'`, mapped to Telnyx's `disabled | premium` -- i.e. "on" always meant the most expensive tier.
Re-verified against `spec3.json`'s real `CallRequest.answering_machine_detection` enum: `premium | detect | detect_beep | detect_words | greeting_end |
disabled`. Pricing re-checked at telnyx.com/pricing/voice (fetched 2026-09-25): standard AMD (`detect`/`detect_words`/etc.) is ~$0.002/call; `premium` is
~$0.0065/call -- about **3.25x** the cost per call.

**Decision:** widened `amd_mode` to the 4 values this build actually surfaces -- `off` (`disabled`) / `detect` / `detect_words` / `premium` -- and fixed
`amdModeToTelnyxValue` to pass them straight through instead of collapsing everything non-off to `premium`. Campaign Manage's AMD select now shows a cost
hint per option so an org can knowingly trade detection quality for the 3.25x price gap.

Separately, and NOT a design choice: Telnyx only emits `call.machine.greeting.ended` for `detect_words`/`detect_beep`/`greeting_end` (standard) or an
actually-detected beep under `premium` -- plain `detect` NEVER emits it (spec3.json's own field description for that mode). Voicemail drop (TASK-F-T3) needs
that event as its "safe to play now" signal, so `amdModeSupportsVoicemailDrop` in `_shared/voicemail-core.ts` returns `true` only for `detect_words`/`premium`.
Under `detect` or `off`, a machine result always just hangs up plainly (`outcome: 'machine'`) regardless of the campaign's own `voicemail_drop_mode` --
there is no vendor signal to time a drop against, no matter which mode the campaign asks for.

**Do not undo without understanding:** don't "fix" voicemail drop not firing under plain `detect` by trying to guess a greeting-end time from a fixed
delay after `call.machine.detection.ended` -- Telnyx gives no event to validate that guess against under this mode, so it's an unbounded false-positive risk
(playing over a live human, or into dead air) with no way to detect the failure. If an org wants voicemail drop, the campaign must run `detect_words` or
`premium`; `detect`/`off` are for early answer/mute-tone speed only.

### GHL-7 (TASK-G7): a new `campaign_leads.status='paused'`, org-wide retroactive DNC/paused enforcement, and blocked tags gated behind an existing GHL connection

**Status:** Active · **Decided by:** eng1 (TASK-G7, 2026-09-25)

**Context:** the task file offered "use an existing status such as `passthrough`/`completed`, or add
a `paused` status if cleaner" for a GHL-paused contact's already-queued `campaign_leads` rows.
`passthrough` already means something specific and unrelated -- "this row lost a same-contact-
same-campaign dedupe collision" (`20260925000200`) -- reusing it would make a future "which leads
are GHL-paused" query indistinguishable from "which leads were dedupe losers."

**Decision:** added `'paused'` to `campaign_leads_status_check` (`20260925080000`), deliberately
NOT added to `campaign-queue.ts`'s `ACTIVE_CAMPAIGN_LEAD_STATUSES` (so `claim_next_leads` ignores
it like every other terminal status). Separately, the task's own DNC clause only said "never added
to a campaign queue" (no explicit already-queued case, unlike the paused clause) -- extended it to
also retroactively move a DNC-tagged contact's active leads to `status='dnc'`, mirroring
`submit_disposition`'s own disposition-driven DNC branch (`20260924002200`/`20260925060000`:
`update campaign_leads set status='dnc' where contact_id=...`, org-wide, not scoped to one
campaign). A contact left dialable in some other campaign after being marked DNC would be a real
compliance bug, and the existing disposition path already sets this precedent. Both the DNC and
paused retroactive updates apply org-wide (every campaign the contact is active in), not just the
optional `campaignId` the import call happened to pass.

**Also:** `ghl_dnc_tags`/`ghl_paused_tags` live on `org_integrations`, the same row `ghl-connect`
creates -- there's nothing to write them onto before an org's first GHL connect, so the Settings
editor is gated behind `isConnected` (same as the existing sync-status panel) and
`set_org_ghl_blocked_tags` raises if called with no row. Not worth a separate seeded row at
org-creation just to allow pre-configuring tags nobody can match against yet.

**Do not undo without understanding:** don't merge `'paused'` back into `'passthrough'` to "simplify"
the status enum -- see the Context paragraph above for why that collapses two different meanings.

### TASK-N1: caller-ID number pool tradeoffs (CID-1/CID-2/ADM-5/CID-5) -- legacy fallback stays uncapped, UTC day boundary, agent leg stays out of the pool entirely

**Status:** Active · **Decided by:** eng2 (TASK-N1, 2026-09-25)

**Context:** before this task, every contact dial in a session used ONE fixed number
(`campaigns.caller_id_number_id`), the root cause the user's own words called out: "several interns
each dialing 3-5 lines from one or two numbers will get those numbers labelled Spam Likely within
days." The new pool (`user_phone_numbers.assigned_user_id`/`status`/`daily_cap`/`resting_until`,
`number_daily_usage`, `org_number_pool_settings`) picks a DIFFERENT number per contact leg, capped
per number per day, resting for N days once capped.

**Decision 1 -- the legacy number is an UNCAPPED tier-3 fallback, not a "pool not configured yet"
special case.** The design's own priority order is explicit: assigned number, else pool, else the
campaign's legacy number. This is followed literally: even once a pool exists, if it's fully
exhausted (every number resting/capped) for a given agent, a campaign that still has
`caller_id_number_id` set keeps dialing FROM THAT NUMBER rather than pausing -- uncapped, untracked.
This can, in principle, push a busy org's legacy number toward the exact Spam-Likely risk this task
exists to fix, for whatever dials spill over onto it on a capped-out day. Accepted because (a) it's
literally what the task's own design specifies, in that exact order, and (b) "keep dialing on the
old number" is a strictly better failure mode than "silently stop working" for an org mid-migration
to the pool model. An org that wants the cap to be a hard ceiling with no spillover should clear
`caller_id_number_id` entirely once its pool is set up -- `refillSession` then genuinely pauses
(`pause_reason: 'no_numbers_available'`) once the pool is exhausted, no escape hatch.

**Decision 2 -- `number_daily_usage.day` is the UTC calendar date, not "the org's own timezone".**
The task's own design note says "day in the org tz" -- but no org-level timezone column exists
anywhere in this schema (contacts/campaigns use a per-CONTACT IANA timezone string for calling
windows, never a per-org one). Adding one just for this cap boundary would be scope creep past
what CID-2 actually asks for (a daily cap, not a specific reset-time guarantee). UTC calendar day is
the simplest defensible choice absent a real column to read -- documented here rather than silently
assumed, so a future task that DOES add an org timezone knows to revisit
`private.pick_and_reserve_dial_number`/`has_available_dial_number`'s `(now() at time zone 'utc')::date`
expressions.

**Decision 3 -- the agent leg's own dial stays completely outside the pool, on its own
`agentDialFromNumber` fallback (legacy number, else ANY org-owned number regardless of status).**
The pool exists to manage EXTERNAL spam-reputation risk from contact-facing dial volume; the agent
leg is an internal SIP dial to the agent's own WebRTC credential that no outside network ever sees
as a "from" number in the sense CID-1/CID-2 care about. Before this task, the agent leg's dial
required `campaign.caller_id_number_id` to be set at all (an existing constraint, not something
this task introduced) -- left as-is would have meant a pool-only org (no legacy number ever set)
could never even start a session. `agentDialFromNumber` closes that gap: legacy number if set, else
literally any phone number the org owns (no cap/rest/assignment check -- this dial is never
rate-limited or billed against). Only a genuinely number-less org (nothing ever purchased) still
fails to Go Ready, which is a real, correct failure, not a regression.

`dialer-session-start/index.ts` had its OWN, separate hard gate on `campaign.caller_id_number_id`
(pre-dating this task, `MISSING_CALLER_ID`) that would have rejected starting a session at all for
a pool-only campaign, making `agentDialFromNumber`'s fallback unreachable in practice -- widened to
also accept "the org owns at least one phone number at all" (any status), matching the fallback it
now needs to satisfy; the error CODE (`MISSING_CALLER_ID`) is kept for any existing client-side
handling, only its trigger condition changed.

**Decision 4 -- Settings' Telephony tab stays owner/admin-only; interns' own "your numbers" view
lives on the Dialer idle screen instead.** The task's own UI ask lists both "Interns see their own
numbers read-only" (Settings) and "the Dialer idle screen shows 'Your numbers: N active, M resting'"
(`StartSessionPanel.tsx`) as separate bullets. Settings.tsx's Telephony tab has a standing,
explicitly-documented invariant (`isAgent` excludes it entirely, with its own comment: "Team
management and number purchase... are owner/admin only... cosmetic tab-visibility narrowing")
predating this task. Restructuring that boundary to carve out a read-only intern sub-view is a
materially bigger, unrelated change to an existing documented boundary for a HIGH-risk task that
already touches the engine, RLS, and a migration. The Dialer idle screen bullet already gives
interns exactly the read-only summary the other bullet asks for, so it's treated as the one real
surface for this requirement -- not a silent gap.

**Do not undo without understanding:** don't "fix" decision 1 by capping the legacy fallback too --
that would remove the org's only continuity path while migrating onto the pool model, which is the
opposite of what an accepted, documented tradeoff should be casually reversed for.

**Fix-forward (eng1 review, same day): `private.has_available_dial_number`/
`private.pick_and_reserve_dial_number` were unreachable via `supabase.rpc(...)`.** PostgREST's
`.rpc()` only resolves against `config.toml`'s `[api].schemas` (`public`, `graphql_public`) -- a
`private.*` function is invisible to it no matter its grants, the exact bug class TASK-P1-05 already
hit once for `org_telephony`. Neither the FakeDb-backed deno tests (which mock `.rpc()` regardless of
schema) nor the dry-run (which calls `private.*` directly in raw SQL) could ever have caught this --
only a real PostgREST call against the deployed schema would 404. Fixed with `public.*` SECURITY
DEFINER wrapper functions of the identical name/signature, delegating straight to the `private.*`
implementation, revoked from `public/anon/authenticated`, granted to `service_role` only
(`20260925070001_number_pool_public_wrappers.sql`). A new deno guard test
(`rpc-schema-guard.test.ts`) now scans every non-test `.ts` file under `supabase/functions` for a
literal `rpc('<name>', ...)` call and fails if no migration defines a matching
`public.<name>(...)` function, so this exact class can't recur silently for any RPC in this repo.

Same review also found `dialLead`'s catch (a Telnyx dial rejected outright) never gave back the
`number_daily_usage` reservation `pick_and_reserve_dial_number` had already made for it -- repeated
rejections could rest a real number for a full rest period with zero actual calls placed. Fixed with
`private.release_reserved_dial_number`/its `public.*` wrapper (same migration): decrements, never
below 0, and reactivates a resting number only if THIS decrement is what drops it back under cap --
safe without a race check because a resting number is never selected again by
`pick_and_reserve_dial_number`, so its counter can't have moved for any other reason in the meantime.

### TASK-SP (monthly spend cap + low-balance alert, SEC-2 + the balance part of SEC-7)

**Context:** the task asked to verify the right Telnyx billing/MTD-spend API against the official
spec (not WebFetch, which truncates large docs) and cite it, then pick the cheapest accurate call,
falling back to an estimate only if no reliable API exists.

**Decision 1 -- real-time balance uses `GET /balance` (stable); month-to-date spend is an
ESTIMATE from our own `call_legs` data, not a live Telnyx number.** Verified against
`https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json` (2026-09-25,
curled directly per the task's own instruction -- WebFetch truncates a 7MB file):
- `GET /balance` (`UserBalance` schema): `balance`/`available_credit`/`credit_limit`/`currency`,
  every amount a decimal STRING -- exactly matches the task's own description. Stable, not BETA.
  This is the only endpoint `_shared/spend-gate.ts` actually calls live.
- `GET /usage_reports` (tag "Usage Reports (BETA)"): supports `product`+`dimensions`+`metrics`
  (e.g. `cost`) over up to a 31-day range -- looks promising, but (a) it's explicitly BETA, (b)
  the valid `product` string for voice calls is not enumerated in the spec at all -- only
  discoverable live via a separate `GET /usage_reports/options` call, so a wrong guess would 400,
  (c) `dimensions` is `required` with no documented minItems, so whether an empty array yields one
  clean aggregate row (vs. erroring, vs. needing a specific dimension) is unverified without a
  live key. Rejected for an hourly cron across every connected org: too much surface area to get
  silently wrong for something explicitly still BETA.
- `POST/GET /legacy/reporting/usage_reports/voice` (`CDR Usage Reports`): submit-a-report-request-
  then-poll-by-id, an async batch-job pattern (`operationId: submitCdrUsageReport` /
  `getCdrUsageReports`). Not a synchronous per-org call an hourly cron can cheaply make.
- `GET /detail_records`: real per-call CDRs with a `cost`-like field, but summing a month's worth
  means paginating every individual call record for every connected org, every hour -- not cheap.

Given none of the above is both reliable and cheap, the task's own fallback applies: MTD spend is
estimated from `call_legs.duration_seconds` (both `kind='contact'` and `'agent'` -- a parallel-dial
bridge places two real, separately-billed Telnyx calls per connected contact) × a configurable
`estimated_per_minute_rate_usd`, plus `user_phone_numbers` count × a configurable
`estimated_monthly_number_price_usd` (`org_spend_settings`, owner/admin-tunable in Settings). Always
labelled "estimated" in the UI (`SpendSettingsCard`, `Team.tsx`-adjacent, not the same component).

**Decision 2 -- fail OPEN when the balance can't be read, fail CLOSED (block) only on a CONFIRMED
~~low balance/~~over-cap spend** (struck-through half reversed by TASK-SP2 below, 2026-09-25).
Telnyx not connected, the stored key missing, or the `/balance` call itself erroring all return
"allowed" from `checkSpendGate`, with a `console.warn` only -- per the task's own suggested
default ("blocking a whole team on a Telnyx API blip is worse"). Every one of these branches is
deno-tested (`spend-gate.test.ts`).

**Decision 3 -- the spend gate runs at Go Ready and at number purchase, NOT at every refill
boundary.** `refillSession` (dialer-engine.ts) can run many times per minute during active
dialing; adding a live `GET /balance` call to that hot loop would add an external HTTP round trip
to every refill and risk rate-limiting Telnyx's billing endpoint under real multi-org load. A
running session is never killed mid-call for this -- the task's own explicit permission ("only if
that's cheap and safe. Otherwise check only at start, and document it"). The hourly alert
(`spend-alert-check`) plus the Dashboard/Settings banners are the compensating control for a
balance that drops mid-shift.

**Decision 4 -- both new RPCs `.rpc()` calls... there are none.** ~~Learning directly from the
lead's own N1-review finding (private-schema functions are unreachable via `supabase.rpc()`,
PostgREST only resolves `public`/`graphql_public`): `_shared/spend-gate.ts`/`spend-alert-check`
never call a NEW RPC at all~~ -- **stale as of the fix-forward below (2026-09-25): there is now
one, `public.org_mtd_billed_seconds`.** Every OTHER new write/read still goes through plain
`.from(table)` calls under the service-role client (which bypasses RLS, no SECURITY DEFINER
indirection needed) or the client's own RLS-scoped `.from('org_spend_settings')` reads/writes
(same shape as `org_number_pool_settings`). `get_org_telnyx_key` already had a verified
`public.*` wrapper (`20260924000500_add_org_telephony_service_wrappers.sql`) -- reused as-is, not
re-implemented.

**Fix-forward (2026-09-25, lead review of `1ec95bb`, HIGH): `getMonthToDateBilledSeconds` moved
from a client-side `.select('duration_seconds')` + reduce to a SQL aggregate RPC.** The original
implementation did `supabase.from('call_legs').select('duration_seconds').eq(...).gte(...)` with
no pagination -- PostgREST caps an unpaginated select at its `max-rows` config (1000 rows). A real
team's month can produce far more than 1000 billed legs, at which point the sum silently
undercounts and `SPEND_CAP_REACHED` never fires for exactly the busy orgs the cap most needs to
protect. New migration `20260925080201_org_mtd_billed_seconds.sql`:
`public.org_mtd_billed_seconds(p_org uuid) returns bigint`, `security definer`,
`set search_path = ''`, sums `duration_seconds` in SQL (no row cap), revoked from
`public`/`anon`/`authenticated`, granted to `service_role` only -- same "no existing `private.*`
function to forward to, so define the aggregate directly in `public`" shape as every other
service-role-only RPC in this task, not the `org_telephony` wrapper-forwarding shape (there's
nothing in `private` for this one to wrap). `getOrgNumberCount` was NOT changed -- it was already
a `head:true` count query, which has no row-data payload for `max-rows` to truncate; only a
row-returning `.select()` has this failure mode. Covered by the `rpc-schema-guard.test.ts`
filesystem check (every literal `.rpc('<name>', ...)` call needs a matching
`create function public.<name>(` in a migration), 2 new `spend-gate.test.ts` unit tests (RPC
result forwarded untouched; RPC error treated as zero, not thrown), and a SQL-level proof in
`audit/SP/dryrun-tests.sql` (1500 fixture `call_legs` this month, 60s each -> exact sum 90,000;
plus a null-duration leg and a last-month leg that must NOT be counted).

**Decision 5 -- Email is skipped entirely.** Grepped this whole project for an SMTP/email-sending
integration (Resend, SendGrid, Postmark, nodemailer, raw SMTP) and found none. The task's own spec:
"Email only if SMTP/email is already configured in the project. Don't add a provider." In-app
notification (`notifications` table, one row per owner/admin, `type='low_balance_alert'`) + the
Dashboard/Settings banners are the only alert surfaces built.

**Do not undo without understanding:** don't add a live Telnyx MTD-spend call without first
re-verifying `/usage_reports` has graduated out of BETA and confirming the `product` value for
voice via a real `/usage_reports/options` response -- guessing it risks a 400 on every cron tick
across every connected org, not just a wrong number.

**TASK-SP2 fix (2026-09-25, user order verbatim): "why is dialing blocked below $5 -- it
shouldn't be blocked at all, only warn below $2."** `checkSpendGate`'s `LOW_BALANCE` block is
removed entirely -- a low balance never blocks Go Ready or a number purchase anymore, only the
org's own opt-in `monthly_spend_cap_usd` (null by default, `SPEND_CAP_REACHED`) still does.
`min_balance_to_dial_usd` is no longer read by any code path; the column stays in
`org_spend_settings` (migrations are append-only) with a `deprecated` comment added in migration
`20260925080202`. The low-balance alert (`low_balance_alert_usd`) becomes the only balance-based
signal left: its default dropped from $20 to $2 (same migration, plus an `update ... where
low_balance_alert_usd = 20` for every org still on the old default -- a customized value is left
alone), and it now does double duty -- the pre-existing hourly cron/Dashboard banner (unchanged,
both already read `low_balance_alert_usd`, never `min_balance_to_dial_usd`) PLUS a new
non-blocking `warning` field `checkSpendGate` returns off the same snapshot it already fetches for
the cap check (no extra Telnyx round trip), surfaced by `dialer-session-start`'s 200 response and
shown as a `toast.warning` in `Dialer.tsx`. A balance-read failure (Telnyx not connected, key
missing, API error) produces no warning either -- same fail-open silence as the block used to
have, just with nothing left that can block.

## TASK-I1 -- Inbound callback routing (INB-1..4, CID-6), 2026-09-25

**Decision 1 -- a NEW `inbound_calls` table, not a repurposed `call_legs` row.**
`call_legs.session_id`/`campaign_id` are both `NOT NULL` and deeply assumed throughout the
existing outbound engine -- widening them for the common "no session, no campaign" inbound case
would touch a shared, heavily-relied-on table for an unrelated flow. `inbound_calls.
dial_session_id` (nullable) links it to a session ONLY when the caller is actually bridged into
one (the "intern is mid-batch" case), reusing `dial_sessions.conference_id`/`pauseSession`
directly rather than duplicating any session logic.

**Decision 2 -- two correlation mechanisms for inbound webhook events.** The ORIGINAL inbound leg
(the caller, `inbound_calls.call_control_id`, stable for the whole call -- matched by direct
lookup) vs. a fallback step's own NEW leg or a per-command webhook with no `call_control_id` at
all (`call.recording.saved/error`) -- matched by decoding a NEW `InboundClientState` (`{org,
inbound, step}`, distinct shape from the existing `DialClientState`, `client-state.ts`).

**Decision 3 -- the routing plan is recomputed fresh every time, never persisted.**
`inbound-core.ts`'s `planInboundSteps`/`nextInboundStep` take the CURRENT step plus a fresh read
of `org_members`/`org_inbound_settings`/`dial_sessions` and derive "what's next" -- nothing about
the inputs changes mid-call, so recomputation is always self-consistent; there is no
plan-drift-vs-reality bug class to worry about.

**Decision 4 -- `transfer`, not answer-then-dial-then-bridge, for every fallback step (intern/
cell/shared).** Verified against a freshly-fetched `spec3.json`'s `TransferCallRequest`
(`raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json`): does NOT require the
original leg to be answered first ("the original call will remain active" on a failed transfer),
creates a brand-new Leg B with its own `call.initiated`, and supports `target_leg_client_state`
(tags Leg B's own webhooks) + `timeout_secs` (the ring window) + `from` (caller ID shown to the
destination) directly. Materially simpler than answer+dial+bridge and matches the fallback-chain
shape exactly: a failed transfer leaves the original leg live, ready for the next attempt.
`from` is always the REAL caller's E.164 (`TransferCallRequest.from`: "the caller id presented to
the destination"), never the org's own number -- matches real call-forwarding UX and lets
`useTelnyxCall.ts`'s `remoteCallerNumber` (confirmed by reading `@telnyx/webrtc`'s compiled
bundle) show who is actually calling.

**Decision 5 -- `answer` (not `transfer`) for the voicemail sub-flow and for `bridging_session`.**
Both need to issue MORE commands on the SAME leg afterward (`speak`/`record_start`, or
`joinConference`) -- `AnswerRequest`'s own docs ("You must issue this command before executing
subsequent commands on an incoming call") make `answer` the right choice there, distinct from the
fallback steps which hand off to a brand-new leg instead.

**Decision 6 -- a bridged inbound call PAUSES the session (`pause_reason: 'inbound_call'`), it
does not literally drive `on_call`/`wrap_up`.** Reusing the outbound wrap-up/disposition state
machine for an inbound call would require the exact `call_legs` widening decision 1 already ruled
out. The agent manually resumes dialing afterward via the existing pause/resume UI -- the task's
own "it goes to wrap-up like a normal call" wording is read as describing the AGENT'S experience
(finish the call, then resume), not a literal requirement to reuse that DB state.
`pauseSession` (`dialer-engine.ts`) gained an optional `reason` param (backward compatible,
defaults to `null`) rather than a parallel pause function.

**Decision 7 -- a cheap `org_members.last_seen_at` heartbeat is the ONLY presence signal.** There
is no server-visible WebRTC-registration status anywhere in this schema, and querying Telnyx per
routing decision would add real latency to every inbound call. `INBOUND_PRESENCE_WINDOW_MS` is 2
minutes; `Dialer.tsx` calls `updateMyPresenceHeartbeat()` every 60s while mounted. The WebRTC
client itself (`useTelnyxCall`, owned by `Dialer.tsx`) was widened to connect whenever the tab
owns the agent line, not only during an active dialing session -- otherwise the heartbeat would
say "online" while the SIP client was actually unregistered, and `ringing_intern` would ring out
against nothing.

**Decision 8 -- the GHL note job reuses the existing `crm_sync_jobs`/`ghl-sync-worker` outbox
(`kind = 'inbound_call_note'`), not a parallel mechanism.** `call_leg_id` is documented as an
opaque reference with no FK (`20260924000900_ghl_integration_outbox.sql`'s own comment) --
`inbound_calls.id` passed through it is exactly what that column is for. Only enqueued when
`contact_id` resolves (an unrecognized caller has no GHL contact to note against).

**Decision 9 -- both new RPCs (`pick_inbound_route`, `transition_inbound_call`) were written as
`public.*` from the start, never `private.*`-only.** Direct application of the N1 fix-forward's
own lesson the same session (PostgREST's `supabase.rpc()` only resolves against `public`/
`graphql_public` per `config.toml`) -- verified clean against `rpc-schema-guard.test.ts`, the
guard test that same fix-forward added.

**Security fix-forward (2026-09-25, caught by a background review before the lead's own dry-run/
deploy step): `org_members`'s new self-service UPDATE policy was a privilege-escalation hole.**
"member can update own heartbeat and forward number" (070100) restricts WHICH ROW an unprivileged
member may touch (`user_id = auth.uid()`) but nothing restricted WHICH COLUMNS -- and RLS policies
for the same command combine with OR, so this was a second, independent path into `org_members`
alongside the existing, correctly-scoped "owner or admin can update non-owner members" policy.
Any authenticated member (agent, not just admin/owner) could `PATCH /rest/v1/org_members?
user_id=eq.<self>` with `{"role": "owner"}` (or flip their own `status`, or overwrite
`telnyx_credential_id`) and it would pass this policy's own check -- a full compromise of the
tenancy model, not a narrow bug. Fixed in a new migration, `20260925070101_org_members_self_
update_scope.sql` (append-only -- not by editing 070100 in place, matching the N1 fix-forward's
own precedent), with a BEFORE UPDATE trigger mirroring the ALREADY-REVIEWED, identical-shape fix
for exactly this problem class: `private.enforce_agent_contact_update_scope()`
(`20260924001300_contacts_e164_tz_dnc.sql`) locks an unprivileged actor to an explicit allowlist
of columns via `to_jsonb(new) - <allowed> is distinct from to_jsonb(old) - <allowed>` (a future
`org_members` column is column-locked by default, not silently member-writable), the same
`auth.role() is distinct from 'authenticated'` exemption for service-role/backend writes
(`telnyx_credential_id` is written by `_shared/agent-webrtc-credential.ts` via the service-role
client), and the same owner/admin exemption so the pre-existing "owner or admin can update
non-owner members" policy's own legitimate role/status changes are completely unaffected. Covered
by `audit/I1/dryrun-tests.sql` section 7 (the escalation attempt itself, a mixed-column update
rejected wholesale, and the legitimate admin path proven still working).

**Do not undo without understanding:** any FUTURE self-service column added to `org_members`
(another per-user preference, say) needs its name added to the trigger's allowlist explicitly --
the allowlist-via-denylist shape means a new column is column-LOCKED by default until then, which
is the safe failure direction, but it also means "the field won't save" is the expected symptom
to look for, not a mystery bug. And never add a second broad, role-unscoped self-row UPDATE
policy to any table without re-deriving whether every column it exposes is meant to be
self-writable -- that is exactly the mistake this entry fixes.

## TASK-BF1 -- Add funds + auto-recharge from inside HyperDial (owner AND admin), 2026-09-25

**User order (verbatim):** "go ahead and fully build out/integrate the add funds capbilty and the
abilty to turn on auto-recharge and control its settings as well like when it should auto
recharge, adn this capabilty should be avaiable for admins as well not just owner." HIGH risk
(charges real money on the customer's own stored payment method) -- built with Telnyx entirely
mocked in every test; the live dry-run (SQL only) and one real minimum-amount charge are the
lead's/owner's own responsibility, never run from here.

**Decision 1 -- verified live against spec3.json, 2026-09-25** (curled directly, not WebFetch,
same reason as every other Telnyx-spec citation in this file -- large specs get silently
truncated): `POST /v2/payment/stored_payment_transactions` (`StoredPaymentTransactionRequest`:
`{amount: "120.00"}`, a decimal string) and `GET`/`PATCH /payment/auto_recharge_prefs`
(`AutoRechargePref(Request)`: `threshold_amount`/`recharge_amount` decimal strings, `enabled`/
`invoice_enabled` booleans, `preference` enum `credit_paypal | ach`). The servers block is
`https://api.telnyx.com/v2` -- every OTHER path in the spec is relative to that (e.g.
`/payment/auto_recharge_prefs`), but the charge endpoint's own path literal is
`/v2/payment/stored_payment_transactions`, uniquely re-embedding the `/v2` the base URL already
ends in. `_shared/telnyx-client.ts`'s `addFunds` passes the DE-PREFIXED path
(`/payment/stored_payment_transactions`) to avoid a real `.../v2/v2/...` 404 -- proven by a
client-level test asserting the exact resulting URL, not just that SOME request went out.
Neither endpoint documents a min/max on the amount fields at all (plain decimal strings, no
`minimum`/`maximum` keywords in the schema) -- the $5-$1,000 add-funds bounds and the
$10-$5,000 auto-recharge-amount bounds are this task's own suggested defaults, not a Telnyx
limit. (Preset UI buttons were later changed by the user mid-build to $10/$25/$50/$100 -- since
$10 is still above the $5 server-side floor, no validation-bound change was needed, only the UI
constant.)

**Decision 2 -- idempotency + rate limiting live in a new audit table, `org_billing_events`
(migration `20260925080300`), not in application memory.** Same "owner/admin SELECT-only, no
client writes, service-role only" shape as `crm_sync_jobs` (`20260924000900`) -- RLS enabled with
only a SELECT policy and zero INSERT/UPDATE/DELETE policies is sufficient for a base TABLE (unlike
the `security_invoker=false` VIEW bug `20260925080000` fixed -- a view's owner-privilege bypass on
write never applies here, this is a plain table, RLS enforcement applies directly to the caller).
A `(org_id, idempotency_key)` unique partial index (`where idempotency_key is not null`) makes the
uniqueness PER ORG, not global, and lets every `auto_recharge_update` row (no charge, so no key)
coexist freely. The row is inserted `'pending'` BEFORE the Telnyx call and flipped to
`'succeeded'`/`'failed'` after -- a crash mid-charge leaves a visible pending row, never a silent
double charge; a client retry with the SAME idempotency key hits the unique constraint (23505) and
is refused WITHOUT a second Telnyx call, proven in `billing-core.test.ts` by asserting the fake
Telnyx client's call count stays 0.

**Decision 3 -- the orchestration logic (validation, rate limits, idempotency, the pending->
succeeded/failed transitions) was pulled out of `telnyx-billing/index.ts` into a new
`_shared/billing-core.ts`, breaking this repo's own stated convention that no Edge Function
`index.ts` has a test file (see `spend-estimate.ts`'s header).** `Deno.serve` runs as an
import-time side effect, so `index.ts` itself can never be imported by a test -- same "pure/
testable core, thin HTTP shell" split as `dialer-engine.ts`/`inbound-engine.ts`. This one earns
the split (unlike `telnyx-purchase-number`/`telnyx-spend-status`, which stay thin with no core
module) because the task's OWN verification list explicitly required deno tests for idempotency
and the pending/succeeded/failed audit-row behavior -- orchestration-level behavior no pure-math
module alone could prove.

**Decision 4 -- rate limits are enforced by querying `org_billing_events` directly in the request
path (two `SELECT`s per `add_funds` call: a 60s-window succeeded-row lookup, a 24h-window
succeeded-sum), not a separate counter/cache table.** At this feature's expected call volume
(a human clicking "Add funds," not a hot loop), the extra reads are cheap; a wrong/stale counter
that silently drifts from the audit table's own ground truth would be worse than the read cost.

**Decision 5 -- error mapping (`mapTelnyxBillingError`) is best-effort keyword matching on HTTP
status + the error body's `detail` text, not a verified enum.** Telnyx's spec documents the SHAPE
of `ErrorResponse` (`{errors: [{code, title, detail, ...}]}`) but not the exact wording for a
declined card / missing payment method / forbidden key on THIS specific endpoint -- 401/403 maps
to `FORBIDDEN_KEY`, a 422 containing "declin..." maps to `CARD_DECLINED`, a 422 mentioning
"payment method" maps to `NO_PAYMENT_METHOD`, anything else surfaces the raw Telnyx detail text
rather than guessing wrong. Verify this mapping against a REAL declined-card response the first
time a live charge actually fails, and correct the keyword matching then if it under/over-matches.

**Do not undo without understanding:** never call `client.addFunds`/`updateAutoRechargePrefs` with
an unvalidated amount/threshold -- `runAddFundsAction`/`runUpdateAutoRechargeAction`
(`_shared/billing-core.ts`) are the ONLY call sites that validate first; a new caller that
imports `_shared/telnyx-client.ts` directly and skips `_shared/billing-validation.ts` would charge
an arbitrary amount with no idempotency/rate-limit protection at all.

**TASK-BF1 fix-forward (2026-09-25, lead + eng2 review before deploy): the rate-limit/cap checks
were a check-then-act race, and every Telnyx failure permanently burned its idempotency key.**

1. **HIGH (money): two concurrent `add_funds` requests with DIFFERENT idempotency keys (two
   admins, or two tabs) could both charge Telnyx.** The old `runAddFundsAction` ran two separate
   `SELECT`s against `status='succeeded'` (never `'pending'`), then a separate `INSERT` -- neither
   step was atomic with the other, and neither one could see a request still in flight. Fixed by
   moving the checks + the insert into ONE atomic `public.reserve_add_funds(p_org, p_user,
   p_amount, p_key)` SQL function (migration `20260925080301`, service-role only), serialized per
   org with `pg_advisory_xact_lock(hashtextextended('add_funds:'||org_id, 0))`. It counts
   `status IN ('pending', 'succeeded', 'unknown')` -- never just `'succeeded'` -- for both the 60s
   interval and the $2,000/24h cap, and raises a distinct custom SQLSTATE per rejection
   (`BF001`=RATE_LIMITED, `BF002`=DAILY_CAP_EXCEEDED, `BF003`=DUPLICATE_REQUEST) that
   `billing-core.ts` maps to 429/400/409. `'failed'` never counts -- no charge was actually
   attempted, so it must not consume a slot. A true concurrent race can't be exercised in a
   single-threaded deno test; `audit/BF1/dryrun-tests.sql` section 5 proves the counting logic via
   two SEQUENTIAL calls (call #2 must see call #1's still-`'pending'` row), and
   `billing-core.test.ts` has a seeded-`'pending'`-row positive control for the same thing at the
   orchestration level.
2. **MEDIUM: a failed charge used to permanently burn its idempotency key, since the unique index
   was unconditional on `idempotency_key` regardless of status.** The dialog's own documented
   retry path (reuse the same key) always hit a false-positive 409 "already submitted" on the very
   next click, even for a plain declined card. Fixed by splitting the failure into two cases,
   *not* by scoping the unique index to `succeeded` (that would let a retry double-charge while
   the first attempt is still pending):
   - **(a) DEFINITE** -- a 4xx from Telnyx (declined, no payment method, forbidden key, invalid
     amount): no charge was attempted. Row stays `'failed'`, but `idempotency_key` is set to
     `null`, freeing the slot. `AddFundsDialog` mints a brand-new key and returns to the amount
     step.
   - **(b) AMBIGUOUS** -- a network error/timeout, or a 5xx: Telnyx may or may not have actually
     charged the card. Row is marked `'unknown'` (new status value, migration `20260925080301`'s
     constraint change) and KEEPS its key -- a same-key retry is refused (409), and the row still
     counts toward both rate limits (conservative, on purpose). The dialog disables Confirm
     entirely and tells the user to check the real balance/Telnyx portal before trying again; the
     only way out of the dialog at that point is closing it (which discards the burned key for
     good, by design -- there is no automatic recovery from an unconfirmed charge).
   - `classifyAddFundsFailure` (`_shared/billing-validation.ts`) does the 4xx-vs-other split by
     parsing the `(NNN)` status `telnyxRequest` always embeds in its thrown message; no status at
     all (a real network error) is treated the same as a 5xx -- ambiguous.
3. **LOW: Telnyx's `processor_status` on a successful charge was read then silently dropped.**
   Now stored in `request_snapshot` on the succeeded update (`{processorStatus: ...}`), so there's
   something to reconcile against if a 200 response is ever not a plain success in practice.

**Do not undo without understanding:** don't scope `org_billing_events_org_idempotency_key_key` to
`status='succeeded'` to "simplify" the retry story -- that was explicitly considered and rejected
(see MEDIUM above): it would let a retry fire a second real Telnyx charge while the first one is
still genuinely in flight (`'pending'`). The DEFINITE/AMBIGUOUS split is what actually keeps a
retry safe. Also don't hardcode a different daily cap or rate-limit window in
`reserve_add_funds` without updating `_shared/billing-validation.ts`'s
`ADD_FUNDS_DAILY_CAP_USD`/`ADD_FUNDS_MIN_INTERVAL_SECONDS` at the same time -- the SQL function's
own signature (fixed by the lead's review) has no way to receive them as parameters, so the two
numbers must be kept in sync by hand across SQL and TypeScript.

**TASK-BF2 (user order verbatim, 2026-09-25): "Change limit from $1,000 to $200 ... I think
that's a better safety limit for starting out since we don't have as much capital."**
`MAX_ADD_FUNDS_USD` (`_shared/billing-validation.ts`) lowered 1000 -> 200, with the duplicate
client-side constant of the same name (`Settings.tsx`) kept in sync by hand (still no shared
module between the Deno edge function and the browser app). The $10/$25/$50/$100 presets, the $5
minimum, the $2,000/24h cap, and the 60s interval are all unchanged -- $100 (the highest preset)
is still comfortably under the new $200 max. No migration needed: confirmed `reserve_add_funds`
(migration `20260925080301`) never checks the per-charge amount at all, only the rate-limit
interval and the 24h cap -- the per-charge bound is enforced purely by
`validateAddFundsAmount`, in TypeScript, before the RPC is ever called.

## MISSION-4 TASK-T1 -- GHL pull complete (GHL-3,4,5,6,8), 2026-09-26/27

**Context:** the pre-existing pull-import (`ghl-import`, TASK-P3-P2) already handled tag/search-
mode pulls, dedupe, and DNC/paused enforcement (TASK-G7). This task extends that same planner
rather than replacing it, and adds a SEPARATE config-driven entry point (a scheduled 5-minute pull
+ an on-demand "Sync now") on top.

**Decision 1 -- API surface verified directly against GHL's published OpenAPI specs (curled
`raw.githubusercontent.com/GoHighLevel/highlevel-api-docs/main/apps/{opportunities,users,
custom-fields}.json`, parsed with python, 2026-09-26 -- never WebFetch, which truncates these).**
`GET /opportunities/search?pipeline_stage_id=...` is the ONLY server-side pipeline-stage filter
(GHL-4) -- `GET /contacts/` has none, same as it has no tag filter. `GET /contacts/{contactId}`
(`GetContectByIdSchema`, sic) is the only schema confirmed to carry `assignedTo`/`dateUpdated`/
`customFields` all together -- the opportunity search's own nested `contact` is missing all
three, so a stage-mode pull does one `getContact` detail fetch per unique contact id found via
opportunity search, not per opportunity. `GET /custom-fields/object-key/contact?locationId` gives
the location's real custom field DEFINITIONS (id -> name) for GHL-6's "sensible defaults by field
name." `GET /users/?locationId` gives the location's real GHL users for GHL-8. Rate limits (100
req/10s, 200,000/day) are NOT in any OpenAPI spec (no `x-ratelimit-*` anywhere) -- cited from
GHL's marketplace docs SITE, which this codebase has already established is unreachable by a
plain fetch (client-rendered Docusaurus) -- `_shared/ghl-rate-limit.ts` flags this source
explicitly and should be corrected the first time a real 429's own headers are observed.

**Decision 2 -- `business_name`/`website`/`rating`/`review_count` already had DEDICATED
`contacts` columns (from the original CSV-import schema, predating this task) -- a mapped GHL
custom-field value for one of these four target keys is written onto that existing column
directly, never duplicated into the new `ghl_custom_fields` jsonb catch-all.** Only
`license_number`/`service_zips`/`tier`/`list_source` (and any future org-added target key --
`ghl_field_mapping` is an open-ended jsonb object, not a fixed enum) have no dedicated column and
go into `ghl_custom_fields`. `rating`/`review_count` are parsed from GHL's own string custom-
field value; an unparseable value is dropped, never written as NaN. See
`_shared/ghl-field-mapping.ts`'s `GHL_FIELD_MAPPING_KNOWN_COLUMNS`.

**Decision 3 -- a genuinely NEW config-driven orchestration (`_shared/ghl-pull-run.ts`), not a
retrofit of `ghl-import/index.ts`.** The existing on-demand ad-hoc tag/search pull (with an
optional manually-picked campaignId) is already reviewed/deployed and stays untouched; the new
scheduled/"Sync now" path is driven by the org's OWN saved `org_ghl_campaign_mappings` rows
instead. Both share the same lower-level modules (`planGhlImport` (extended, not duplicated),
`campaign-queue.ts`, `campaign-queue-io.ts`) so the dedupe/DNC/queueing RULES can never drift
between the two entry points, even though the orchestration glue around them is written twice.
`fetchAllExistingContactRows` was moved from being `ghl-import/index.ts`'s own private helper into
the shared `ghl-import.ts` module so both entry points share the exact same >1000-row pagination
fix, instead of a second hand-copied version.

**Decision 4 -- the HIGH-value fix from BF1's own review (an atomic RPC replacing a check-then-act
race) does NOT apply here.** There is no shared, contended resource across concurrent pull runs
the way `org_billing_events`' rate limit/cap was -- two pulls for the same org would at worst
double-plan the same GHL contacts (idempotent: `planGhlImport`'s own dedupe on `ghl_contact_id`/
phone makes a second run a no-op update, not a duplicate insert or a double charge). No advisory
lock was added for this task; revisit if a future change makes a genuinely non-idempotent side
effect possible here.

**Decision 5 -- the incremental cursor (GHL-5) is a CLIENT-SIDE filter, not a smaller GHL
request.** GHL has no server-side "updated since" filter on either endpoint (verified against
both specs) -- `runGhlPullMapping` still fetches everything a tag/stage mapping matches (bounded,
~2,000 contacts/20 pages, same cap `fetchAllGhlContacts` already used), then discards any contact
whose `dateUpdated` is at or before the org's stored cursor before planning/writing. Saves DB
writes on an unchanged contact, not GHL API calls. A contact with no `dateUpdated` at all is never
filtered out (silently dropping it forever would be worse than an occasional redundant re-plan).
One cursor per ORG (not per mapping) -- the max `dateUpdated` seen across every mapping in one
pull run advances it; a mapping added later starts by re-fetching everything matching it once,
same as a brand-new org.

**Decision 6 -- `contacts.user_id` (NOT NULL, pre-tenancy-era column) is attributed to the org's
OWNER for every pull-run-created contact, consistently regardless of entry point.** A cron-
triggered pull has no acting admin; "Sync now"'s own caller is deliberately not threaded through
either, so both paths always resolve and use the org's owner id (`resolveOrgOwnerUserId`) -- same
"match to the owner instead of relaxing NOT NULL" precedent `20260924000200`'s own tenancy
backfill already established for this exact column.

**Decision 7 -- one mapping/org failing never blocks the rest.** `runGhlPullForOrg` catches per-
mapping (a stage deleted in GHL since it was configured, a transient error) and still runs every
other mapping for that org; `ghl-pull-worker`'s own per-org loop applies the identical isolation
one level up (one org's revoked token/GHL outage doesn't skip every other enabled org's run this
tick).

**Do not undo without understanding:** don't "simplify" the stage-mode per-contact `getContact`
detail fetch away by reading fields off the opportunity's own nested `contact` object instead --
that object is missing `assignedTo`/`customFields`/`dateUpdated` entirely (verified against the
spec), so GHL-3/6/8 would silently stop working for every stage-sourced contact. Don't move the
rate-limit numbers out of `_shared/ghl-rate-limit.ts`'s own doc comment without re-verifying them
against a real GHL 429 response first (they were never confirmed against a machine-readable
source, only cited from the marketplace docs site).

## TASK-T3 -- Live coaching: listen / whisper / barge (MISSION-4), 2026-09-26

**User order (verbatim):** "give me everything that relates to the parallel dialer and making it
as powerful and industry level as possible." HIGH risk (real-time conference control on a live
call) -- built and deno-tested against a fake TelnyxClient; no real Telnyx call was made from
this session (NEEDS-LIVE-VERIFY, `docs/validation/launch-live-test.md` B20).

**Decision 1 -- verified live against spec3.json, 2026-09-26.** `POST /conferences/{id}/
actions/join`'s `supervisor_role` enum is `barge | monitor | none | whisper`, NOT the three
labels this feature exposes to the user -- "listen" maps to Telnyx's own `monitor` (muted,
hears everyone), "whisper" and "barge" map 1:1. Switching mode mid-call uses a DIFFERENT
endpoint, `POST /conferences/{id}/actions/update` (`call_control_id` + `supervisor_role` both
required) -- the participant-level `PATCH /conferences/{id}/participants/{id}` has NO
`supervisor_role` field at all, verified by reading its full schema, not assumed from the join
endpoint's shape.

**Decision 2 -- the manager's coaching leg is deliberately NOT a `call_legs` row at all.**
`call_legs.kind` is `'contact' | 'agent'` today, and this lane's own history
(`LANE-eng2.md`) has four separate incidents of a THIRD leg shape silently breaking a
kind-agnostic assumption written before it existed (`loadActiveLegs`, `refillCount`,
`loserActions`, the analytics views). Adding `'supervisor'` as a third kind would need every one
of those call sites re-audited for this one feature; instead, a new dedicated table
(`coaching_sessions`, migration `20260926070000`, same "owner/admin SELECT-only, service-role
writes" shape as `org_billing_events`) holds the manager's `call_control_id` and the audit
trail. Nothing in `dialer-engine.ts`, the sweeper, or any analytics view reads this table --
provably unable to affect the dial loop, not just believed to be.

**Decision 3 -- ending a coaching attempt has no server endpoint at all.** The coaching leg
lives on the manager's OWN already-connected WebRTC client (`useTelnyxCall.ts` -- "reuse
Dialer's single client" was the task's own instruction, and `Dialer.tsx` is permanently mounted
app-wide per `MainApp.tsx`'s existing FE-B fix, so this client is live regardless of which tab
is active). "Leave" is a plain client-side `hangup()` on that same call; the resulting real
Telnyx `call.hangup` webhook finalizes the `coaching_sessions` row. `runStartCoachingAction`/
`runSwitchCoachingModeAction` are the only two server actions (`dialer-coaching` edge function).

**Decision 4 -- "Manager listening" is enforced server-side, not just hidden client-side.**
`dialer-session-get`'s new `coachingMode` field can only ever be `'whisper' | 'barge' | null` --
the query itself filters `mode in ('whisper','barge')`, so a plain `'listen'` (the deliberate
industry-default "silent" mode, per the task's own spec line) can never leak through even if a
future screen forgot to filter it out again itself.

**Decision 5 (NOT-done, disclosed) -- coaching does not auto-end when the coached call ends.**
A manager coaching a session that then ends normally stays connected to the now-idle conference
until they click Leave. Closing this needed either a `dialer-engine.ts` hook (out of scope for
a feature this task deliberately kept OUT of that file's own blast radius -- see Decision 2) or
a poll-and-auto-hangup watcher that would only run while a specific tab stayed open, which felt
like a worse tradeoff than documenting the gap plainly. See `launch-live-test.md`'s "Known open
items" and B20.8.

**Decision 6 -- `agentSipUri` (`dialer-engine.ts`) was exported, not duplicated.** It resolves
ANY org member's WebRTC credential SIP URI, despite the agent-specific name -- the underlying
`getOrCreateMemberCredentialId` (`_shared/agent-webrtc-credential.ts`) already took a generic
`userId`. A one-word `export` addition (verified: no behavior change, confirmed by re-running
`npm run test:functions`) was preferred over a second copy of the same credential-lookup logic
in `coaching-core.ts`, per this lane's "reuse, don't reinvent" convention.

**Do not undo without understanding:** don't scope the manager-busy check to "does the manager
have an ACTIVE coaching row" alone -- `runStartCoachingAction` also checks the manager's own
`dial_sessions` state (`on_call` blocks) because `useTelnyxCall.ts` has exactly ONE
`activeCallRef` slot; a manager who is ALSO an agent and mid-call would collide with a second
inbound leg on the same WebRTC client if only the coaching-specific check existed. The partial
unique index `coaching_sessions_one_active_per_manager` closes the remaining race between that
check and the insert -- don't remove it as "redundant" with the earlier check, it isn't (the
check is advisory/racy, the index is the actual guarantee).

## MISSION-4 TASK-T2 -- GHL push complete (GHL-2,10,11,12,13,16), 2026-09-27

**Decision 1 -- GHL-10's tag gap was a FILL, not a rename.** Three of the 9 canonical seeded
dispositions (`gatekeeper`/`voicemail_left`/`no_answer`) had `ghl_tag = null` since
`20260925060000`; the other six already have admin-configured human-readable tags
(`'Interested'`, `'Callback'`, ...). The task file's own "keep the admin-configurable mapping
that exists; ensure every outcome has one" resolved the tension with `audit/requirements.md`'s
generic `call:<disposition>` format example: only the three nulls were filled (to
`'call:' || key`, migration `20260926080100`), the six existing custom tags were left completely
untouched. Don't "fix" the inconsistency later by renaming the six to match -- that would break
whatever GHL automations an org has already built against their existing tag names.

**Decision 2 -- GHL-11/12/13 needed ZERO changes to `submit_disposition`.** That RPC
(`20260925060000`, already live) is large and already reviewed; rather than editing it to embed
`last_call_at`/`call_attempts`/a resolved pipeline-stage target into its enqueue-time jsonb
payload, `ghl-sync-worker/index.ts` resolves all three AT PUSH TIME instead: `call_legs`
(`dispositioned_at`/`ended_at`/`lead_id`) + `campaign_leads.attempts` for the disposition case,
`dispositions.ghl_pipeline_id`/`ghl_pipeline_stage_id` (new nullable columns, same migration) for
the stage move. This means an admin changing a disposition's pipeline-stage mapping applies to
every future push of that disposition immediately, with no RPC redeploy needed, and kept a
large already-live PL/pgSQL function completely out of this task's blast radius. Inbound calls
(GHL-16) get `occurred_at` the same way -- a one-line addition to `inbound-engine.ts`'s own
TypeScript enqueue call (`row.ended_at ?? row.answered_at`), not a SQL change either.

**Decision 3 -- the SAME `org_integrations.ghl_field_mapping` jsonb serves both directions,
unchanged.** T1 built it as `target key -> GHL field id` for pull-direction enrichment (inverted
in TS to `field id -> target key` before use). Push needs the mapping in its NATURAL stored
direction, so `last_call_at`/`last_call_outcome`/`call_attempts` were simply added to
`GHL_FIELD_MAPPING_TARGET_KEYS` (three copies kept in sync: `_shared/ghl-field-mapping.ts`,
its own test file's assumptions, and `apps/web/src/components/Settings.tsx`'s duplicated literal
array -- same three-copies reasoning as `area-code-tz.ts`, Vite can't import the Deno module) --
no new column, no new migration for this part.

**Decision 4 -- GHL-2's rate limiter is the SAME shared `_shared/ghl-rate-limit.ts` T1 built for
pull, now also wrapping `ghl-sync-worker`'s push client.** "Backoff on 429" was NOT built as new,
429-specific logic -- `fail_crm_sync_job`'s existing exponential-ish backoff (any thrown error,
including a 429, requeues with a growing delay, dead after 8 attempts, `20260924002000`) already
covers it generically, same as every other transient GHL failure this outbox has always handled.
"Batching" is the existing `CLAIM_BATCH_SIZE = 10` per tick (unchanged) -- GHL-2 was a gap in
RATE LIMITING specifically (the push client had none at all until now), not in batching or
backoff, both of which already existed from TASK-P3-P3.

**Decision 5 -- `moveOpportunityStage` falls back to CREATE when no opportunity exists yet.**
GHL's opportunity-search has no "get by contact+pipeline" shortcut; a pulled contact (or one
that's never reached a stage-moving disposition before) commonly has no opportunity in the
target pipeline at all. Searching first (`GET /opportunities/search?contact_id=&pipeline_id=`),
then `PUT`-ing an existing one or `POST`-ing a new one already at the target stage, means GHL-12
works identically whether or not GHL-4/GHL-5's own pull ever created an opportunity for this
contact.

**Do not undo without understanding:** `processDispositionJob`'s custom-fields and stage-move
steps run unconditionally (marking themselves done even with no mapping/target configured) --
this is deliberate, matching every other optional step in this file (tag/task/dnd already do the
same "no-op but still done" thing). Don't add an early-return that skips setting the progress
flag when there's nothing to push; that would make a retry re-check the same no-op forever
instead of marking it complete once.

## TASK-T4 -- Warm/cold transfer + hold (AUD-6 + NEW, MISSION-4), 2026-09-27

**User order (verbatim):** "give me everything that relates to the parallel dialer and making it
as powerful and industry level as possible." HIGH risk (real-time conference control on a live
call, moving legs between conferences) -- built and deno-tested against a fake TelnyxClient; no
real Telnyx call was made from this session (NEEDS-LIVE-VERIFY, `launch-live-test.md` B22).

**Decision 1 -- Telnyx's `transfer` command was deliberately REJECTED as the transfer primitive,
in favor of conference-native join/leave/hold/unhold.** `transfer`'s own schema
(`TransferCallRequest`, verified against a fresh spec3.json) is entirely bridge-shaped (`to`/
`from`/`park_after_unbridge`) and says nothing about its behavior on a leg that's currently a
CONFERENCE PARTICIPANT -- the only existing usage in this codebase (`inbound-engine.ts`) is on a
PARKED, not-yet-conferenced leg, a structurally different case. The agent's own
`dial_sessions.conference_id` is a PERSISTENT room reused across the whole shift (created once,
around the agent leg); an unverified assumption about `transfer`'s conference-membership
side-effects could silently strand that room in a state a future contact gets wrongly bridged
into. Everything here is built instead from `join`/`leave`/`hold`/`unhold` -- primitives with
fully verified, unambiguous schemas -- even though it costs more Telnyx calls per transfer.

**Decision 2 -- Telnyx's conference hold is PER-PARTICIPANT, not conference-wide, and that fact
is what makes warm transfer work without a THIRD conference.** `ConferenceHoldRequest`'s own
field description ("When call_control_ids is empty, ALL participants... ") implies (and this
task relies on) the non-empty case holding ONLY the named participant(s) -- everyone else in the
same conference keeps talking normally. So warm transfer's "the intern talks to the target
privately while the prospect can't hear" need is met by holding the PROSPECT in the MAIN
conference and moving the AGENT (not the prospect) into a fresh "side" conference with the
target -- never a bridge/mute trick, never a third always-alive conference per org.

**Decision 3 -- cold and warm transfer share one mechanism, differing only in WHO moves into the
side conference and WHEN.** Cold: once the target answers, the PROSPECT moves straight into the
side conference (agent's own leg never touched at all -- literally the simplest case). Warm:
the AGENT moves into the side conference first (prospect held in main); "Complete transfer"
then moves the prospect INTO the side conference (unheld) and the agent BACK to main (empty,
ready for the next contact); "Cancel" hangs up the target and moves the agent back, unholding
the prospect in main -- the original call resumes untouched. One `processTelnyxTransferEvent`
webhook handler and one `unwindWarmTransferToMain` helper cover every resolution path.

**Decision 4 -- a failed/never-answered target leg needs NO explicit recovery step.** Neither
the prospect nor the agent's own leg is touched at all until the target actually ANSWERS (no
pre-emptive hold "just in case" during dialing) -- so "a failed target leg returns the prospect
to the intern" (the task's own explicit requirement) is satisfied by construction: there's
nothing to undo, since nothing was ever done. This also means no dead air during dialing --the
intern and prospect can keep talking normally while the target rings, exactly like a real phone
transfer.

**Decision 5 -- the target leg is deliberately NOT a `call_legs` row, same move as TASK-T3's
coaching leg.** Tracked only on `call_transfers.target_call_control_id`. This lane's own
documented history (LANE-eng2.md) of a new leg shape breaking kind-agnostic dial-loop code
(`loadActiveLegs`/`refillCount`/`loserActions`/analytics views) made this the obvious choice a
second time -- see TASK-T3's own Decision 2 for the fuller rationale, unchanged here.

**Decision 6 -- Hold (AUD-6) is a single nullable timestamp on the EXISTING `call_legs` row
(`held_at`), not a new table, not a new `state`/`kind` value.** It's pure side-metadata (like
`bridged_at`/`voicemail_drop_path` already are) with no CAS/state-machine implications -- setting
it twice, or clearing it when already clear, is harmless by construction. Shared unchanged by
both the standalone Hold button AND warm transfer's own "hold the prospect while I talk to the
target" step -- one primitive, two callers, per this lane's "reuse, don't reinvent" convention.

**Decision 7 (disclosed gap) -- no default hold-music asset exists.** `holdConferenceParticipants`
accepts an optional `audioUrl`; every call site in this task omits it, so a held prospect hears
Telnyx's own silence, not music. Building real audio-asset infrastructure (upload/storage) for
this one field felt out of scope for tonight; flagged here rather than silently shipped as if it
were a deliberate final choice.

**Decision 8 -- a sweeper safety net was added for stuck transfers, mirroring TASK-T3's own
review-fix-forward pattern for coaching.** `reap_stale_call_transfers` (SQL) + `dialer-sweeper`
reap a 'dialing' transfer whose target leg's own webhook was lost (a hangup that never arrived),
and a 'connected' (warm) transfer whose "Complete"/"Cancel" never got clicked (a crashed
manager tab) -- the latter matters because it leaves the AGENT stuck in a side conference,
unable to take their next contact, unlike a merely-slow real conversation.

**Do not undo without understanding:** the AGENT's own leg must NEVER be moved into (or left
inside) a conference other than `dial_sessions.conference_id` without a plan to move it back --
every code path that puts the agent into the side conference (warm transfer's own
`processTelnyxTransferEvent` branch) has a matching path back to main (`runCompleteTransferAction`/
`runCancelTransferAction`/the sweeper's `unwindWarmTransferToMain`). Adding a new warm-transfer
exit path later must preserve this invariant, or a future contact's winning leg can get bridged
into a conference the agent already abandoned.

### TASK-T4 review fix-forward (eng1's review-eng1.md, 2 BLOCKERs + 1 SHOULD)

**BLOCKER 1 fix -- the R-024 evidence table is a process artifact, not a code fix.**
`audit/T4/api-evidence.md` cites every Telnyx call this task makes against a freshly re-curled
`spec3.json`, by exact schema property line number (not the URL pattern, not a cached copy). Every
key checked out against the code's own prior comments -- the table exists because the rule
requires it, not because it found a wire-format bug. Two `telnyx-client.test.ts` gaps the review
implicitly exposed (no dedicated URL/body test for `leaveConference` or `hangup`) were closed
alongside it.

**BLOCKER 2 fix -- external-target transfers get their own guard stack, entirely separate from
member (internal) transfers.** A transfer target is normally a vetted contact (dialed) or an
org_members row (a teammate) -- but `targetKind: 'external'` is a free-form E.164 number the
agent types in, live, mid-call: a materially larger blast radius than either. Four independent
guards, all server-side (transfer-core.ts's `checkExternalTransferAllowed`, called from
`runStartTransferAction` before the `call_transfers` row is even inserted):
1. `org_transfer_settings.allow_external_transfers`, a new org-scoped table, default **false** --
   same "dedicated small table, member-read/owner-admin-write, its own seed trigger" shape as
   `org_recording_settings` (TASK-F-T2), not a column on `orgs` (that table's own UPDATE RLS is
   owner-only, and this needs owner+admin) and not `org_telephony` (zero client RLS, by design,
   since it's a Telnyx API key). `TransferModal.tsx` hides the option entirely when off -- UX
   only, the server check is what actually matters.
2. NANP-only + premium/toll rejection (`externalTransferRejectionReason`): NPA 900, NXX 976 (the
   older regional "976 pay-per-call" exchange code, which can sit under ANY area code --
   libphonenumber-js's own metadata does NOT universally flag this, confirmed empirically against
   `+12129761234`), and the N11 service codes, plus `libphonenumber-js`'s own `getType() ===
   'PREMIUM_RATE'` as a second signal. Toll-FREE numbers (800/888/etc.) are deliberately NOT
   rejected -- "premium/toll" in the dispatch means pay-per-call, not toll-free (an ordinary
   business line an agent might legitimately warm-transfer to).
3. The org's own `dnc_numbers` list -- same table `claim_next_leads` already checks for contact
   dialing, reused rather than reimplemented.
4. The existing `checkSpendGate` (spend-gate.ts) -- the SAME function `dialer-session-start`
   already calls for Go Ready, reused as-is rather than a second cap-checking implementation.
5. A per-agent rolling-hour rate limit (10/hr), DB-counted from `call_transfers` (never
   in-memory -- a fresh Edge Function invocation has no memory to count in), anchored by a new
   index (`idx_call_transfers_initiated_by_target_kind_created`).
Member transfers touch NONE of this (checked only inside the `targetKind === 'external'` branch)
-- per the dispatch's own item (e), by design, not an oversight.

**SHOULD fix -- an in-flight transfer is now cancelled the instant its own session's active leg
ends, instead of waiting on the sweeper's 5-minute timeout.** One new function
(`transfer-core.ts`'s `cancelInFlightTransferForSession`, injected `TelnyxClient` -- matches every
other function in that file, deliberately NOT a self-fetched-client design like
`dialer-engine.ts`'s own `hangupLeg`/`sendAbandonMessage`) is called from TWO places: `endLiveCall`
(the agent's own explicit Hang Up button, synchronous, using the client it already fetched) and
`processContactLegEvent`'s winner-ended branch (`result.next === 'ended' && currentLeg.id ===
session.active_leg_id`, purely webhook-driven -- covers "the customer hangs up" too, since BOTH
paths funnel through the exact same Telnyx `call.hangup` webhook on the prospect leg regardless of
who initiated it). Calling it from both is safe, not redundant: `transition_call_transfer`'s own
CAS guard makes the second call a harmless no-op once the first has already cancelled the row.
Writing the test that PROVED this wiring surfaced a real, separate bug in the test harness itself
(`dialer-fake-supabase.ts`'s `apply_leg_outcome` case was clearing `dial_sessions.active_leg_id` as
a side effect -- the REAL SQL function never touches `dial_sessions` at all, only
`call_legs.outcome_applied_at` and `campaign_leads`; fixed to match).

### TASK-T6: list & assignment control (ADM-4 + skip/remove/priority)

**Decision 1 -- ADM-4's "assign a campaign to one or more interns" needed ZERO new code.**
`campaign_agents` (TASK-P1, 20260924000200) already gates campaign-level visibility (RLS on
campaign_leads/contacts, dialer-session-start's own membership check) and the campaign picker.
Verified this by reading the code, not assuming it from the task's own framing -- the only
genuinely missing piece was PER-LEAD ("slice") assignment.

**Decision 2 -- reused `campaign_leads.assigned_agent_id` for slice assignment instead of adding a
second column.** It already existed but was only ever written for callback ownership (set by
submit_disposition, read by claim_next_leads' own callback-priority filter) -- never checked for
`status = 'queued'` at all. Widening claim_next_leads' WHERE clause to also respect it for
'queued' (null = today's "anyone on the campaign" behavior, unchanged) reuses the exact same
column/shape a callback already uses, rather than inventing a parallel mechanism.

**Decision 3 -- "a lead range/percentage/tag filter" is eager materialization, not an abstract
rule.** `assign_campaign_leads` computes the target lead set ONCE (ranked by `position` among
currently-queued leads) and writes `assigned_agent_id` directly -- no assignment-rules table, no
extra join in claim_next_leads' own hot path. Reassigning mid-day is just calling it again.
"One or more interns" for a slice (as opposed to a whole campaign, where campaign_agents already
supports many) means running it once per intern with non-overlapping filters -- the column stays
a single nullable FK, the simplest shape that already existed.

**Decision 4 -- `assign_campaign_leads` also auto-adds the target to `campaign_agents`.** Assigning
a slice to someone NOT already on the campaign would otherwise be a footgun: that agent's own
`listCampaigns()` filters to `campaign_agents`, and campaign_leads/contacts' own RLS SELECT policy
(`private.agent_assigned_to_campaign`) gates on the exact same table -- they could never see or
claim a lead assigned to them on a campaign they're not "on". One manager action does what
checking the box in "Assigned Agents" and running the assignment separately would otherwise
require as two steps.

**Decision 5 -- "tag" filter uses `contacts.ghl_tags` (already exists, TASK-F-T2/ghl_blocked_tags),
not a new column.** A real, already-synced GHL concept, not invented for this task.

**Decision 6 -- Priority and Skip are plain column updates through the EXISTING owner/admin-only
RLS policy on campaign_leads (20260924000300), not new RPCs.** Neither needs role logic beyond
what that policy already enforces -- an agent has zero write access to campaign_leads today, and
this task never asked to change that (these are manager-side list actions, same audience as the
pre-existing Remove button). "Skip... keeps its place/attempt" is satisfied literally: the skip
update only writes `next_attempt_at`, never `attempts` or `position`.

**Decision 7 -- Remove from campaign is now a status flip ('removed'), not a `.delete()`.** The
prior hard-delete contradicted this task's own "terminal status" ask and silently destroyed the
lead's own attempts/history (`call_legs.lead_id` is `on delete set null`, so the leg survives but
loses its link to the lead). 'removed' is a NEW, distinct status -- not a reuse of 'passthrough'
(TASK-N1's own multi-leg-dedup-loser concept, already baked into every campaign-stats view's own
`count(...) filter (where status='passthrough')`; conflating the two would corrupt those counts).
**Disclosed gap**: re-adding a previously-removed contact to the SAME campaign via
`addLeadsToCampaign` will NOT revive the row (its own upsert is `ON CONFLICT DO NOTHING`) -- this
is pre-existing behavior identical to re-adding an already-completed/exhausted/dnc contact today,
not a new gap this task introduces; left unchanged as out of this task's own scope.

**Decision 8 -- lead priority ordering sits between priority_requeue and attempts/next_attempt_at/
position in claim_next_leads' own ORDER BY, callback ownership still first.** A promised callback
time commitment outranks a manager's own priority tag; priority_requeue (an immediately-preceding
dropped/abandoned retry) still resurfaces before a merely "high"-tagged lead that hasn't been
touched yet.

## TASK-T8 (MISSION-4, compliance: drop-rate tracking, recording consent, pause/resume recording, QUE-2)

**Decision 1 -- drop-rate tracking, the abandon message, and "queue them first" were mostly ALREADY
BUILT before this task; only the analytics metric was missing.** Verified by reading the code, not
assumed: `apply_leg_outcome` (20260925050000_voicemail_drop.sql) already sets
`priority_requeue = (v_outcome in ('dropped','abandoned'))` and `next_attempt_at = now()` (attempts
NOT incremented) for a dropped/abandoned leg, and `sendAbandonMessage` (dialer-engine.ts) already
plays a short message gated on `campaigns.abandon_message_enabled` (default true). This task added
only the genuinely missing piece: `campaign_drop_rate_summary`, a new additive RPC (same
security/scoping shape as eng1's `funnel_summary`, 20260926080300 -- deliberately not editing that
already-applied function) + a "Drop rate (last 30 days)" card in Analytics.tsx with a >3% warning
banner.

**Decision 2 -- recording consent state is derived from the contact's area code, not a new stored
field.** No `contacts.state` column exists today; rather than add one, a new best-effort
`_shared/area-code-state.ts` (area code -> US state, same "best-effort, not authoritative" spirit
and sourcing discipline as the existing `area-code-tz.ts`) backs the decision. `announce_recording_
mode` ('never'/'all'/'all_party_consent_states') and an editable `all_party_consent_states` array
(seeded with a 14-state reference default, explicitly NOT legal advice) both live as new columns on
the existing `org_recording_settings` table -- same "widen the existing small settings table"
pattern `org_transfer_settings` already established. The announcement (`maybeAnnounceRecordingConsent`)
runs in `handleWin`, right AFTER recording starts (so the notice is itself part of what it discloses),
speaking to the winner leg via the same `client.speak()` wrapper `sendAbandonMessage` already uses.

**Fix-forward (eng1's T8 review, MUST-FIX) -- `'all_party_consent_states'` mode's unknown-state
handling was inverted from the legal requirement and has been corrected.** The original logic
treated `contactState == null` (an unparseable number, or an area code missing from
`area-code-state.ts`) as "doesn't match any configured state" and SKIPPED the announcement --
backwards for a consent disclosure, where an unresolved caller might well be in one of the org's
listed states. `shouldAnnounceRecordingConsent` (recording-core.ts) now fails TOWARD announcing on
`null`: only a state that resolves AND is confirmed absent from `all_party_consent_states` skips
the notice. Covered by unit tests for both a null-phone-number and an unmapped-area-code contact,
plus the corresponding `dialer-engine.test.ts` wiring-level cases.

**Fix-forward (eng1's T8 review, SHOULD) -- a hangup while recording is paused now closes the open
`recording_paused_spans` entry.** `endLiveCall` previously left `recording_paused_at` set (and no
matching `recording_paused_spans` entry ever appended) if the agent hung up without clicking
Resume first. `endLiveCall` now closes any open span at call-end time via a small best-effort
helper (`closeOpenPausedRecordingSpan`), same read-then-append shape as `resumeRecording`, and
never throws (the hangup itself must always complete regardless).

**Decision 3 -- recording pause/resume needed two new `TelnyxClient` methods
(`recordPause`/`recordResume`) and no CAS/race protection.** Verified against a freshly-curled
spec3.json (`audit/T8/api-evidence.md`): both `record_pause`/`record_resume` request bodies have
every property optional (no `recording_id` needed -- this lane only ever starts one recording per
leg) and neither has an associated webhook, so `dialer-session-recording/index.ts` updates
`call_legs` synchronously in the same request. Unlike `transition_leg`/`transition_session` (which
race real concurrent Telnyx webhooks), a single agent's own button click has no second writer to
race against -- `pauseRecording`/`resumeRecording` (dialer-engine.ts) do a plain read-then-act, not
an `.update().select().maybeSingle()` CAS read-back (which the shared test fake doesn't even
support returning rows for on `.update()` -- discovered while writing the positive-controlled
tests, fixed by simplifying the production code instead of the fake, since no real race exists
here to justify the CAS shape in the first place). Paused spans are recorded as an append-only
`call_legs.recording_paused_spans jsonb` array (`{paused_at, resumed_at}`), closed on resume.

**Decision 4 (QUE-2) -- gatekeeper's retry delay is seeded at 1440 minutes (1 day), not fixed via a
new "flat offset" retry mode.** Discovered while implementing this: `campaign_retry_rules.
rotate_block`'s own comment claims `rotate_block=false` means "a flat now()+delay_minutes offset",
but NEITHER `apply_leg_outcome` nor `submit_disposition` ever actually branches on it -- both
unconditionally call `private.rotated_retry_schedule`, which always rotates the block AND always
floors to `greatest(1, delay_minutes/1440)` days out, regardless of `rotate_block`'s value. So the
shortest a 'retry' rule can genuinely land is "tomorrow, in a different block" -- still correctly
SHORTER than no_answer/voicemail's 4-day cadence, so that's what gatekeeper now seeds. Fixing the
dead `rotate_block=false` path itself was deliberately out of scope (would mean re-deploying two
already-applied, security-definer core functions in an already-high-risk task) -- logged instead in
`.brain/memory/known-issues.md` for whoever picks it up. Existing campaigns' already-seeded
gatekeeper rows are backfilled to 1440 ONLY if still at the untouched 5760 default (an org that
already customized it is left alone) -- `seed_default_campaign_retry_rules`'s own `ON CONFLICT DO
NOTHING` re-confirmed idempotent (a manager's customization always survives a re-seed) in
`audit/T8/dryrun-tests.sql`.

**Decision (TASK-T9, CID-4) -- an auto-rested number is a REASON string on the existing
`resting`/`resting_until` mechanism, not a new status value.** `check_number_health` (weekly cron +
on-demand) flags a number whose 30-day human-answer rate is below half the pool's own median (min
20 sampled dials) by setting `status='resting'` + `resting_until` exactly as the existing
daily-cap-exhaustion path already does, plus two new observability-only columns
(`flagged_at`/`flagged_reason`). This means `pick_and_reserve_dial_number`'s own `status='active'`
filter needed zero changes to correctly exclude a flagged number, and the existing lazy
`reactivate_rested_numbers` reactivation path (already called by every caller of that function)
makes a flagged number naturally re-eligible for a fresh health check once its rest period elapses
-- no separate dedup/reset logic needed. Local-presence fallback (`private.area_code_states`, a
new NANP-only area-code->US-state table, 357 verified rows sourced the same way
`area_code_timezones` was) adds a third `pick_and_reserve_dial_number` ORDER BY tier behind the
existing same-area-code tier; signature and concurrency (`for update...skip locked`) unchanged.

## TASK-S2 part 1 (MISSION-4, lines up to 10 + the drop-rate guard -- voicemail rotation, inbound
## ring group, and AUD-4 are NOT built tonight)

**Decision 1 -- "8-10 lines needs the guard" is a same-row DB CHECK on `campaigns`, not just an
app-layer convention.** `updateCampaignSettings` (api.ts) writes straight to `campaigns` via
PostgREST with no edge function in front of it, so an app-layer-only rule would have been
trivially bypassable by a direct table update. `campaigns_lines_check` now reads
`lines between 1 and 7 or (lines between 8 and 10 and high_lines_guard_enabled)` -- evaluated
against the FINAL row after an UPDATE, so a client can flip both columns together in one call, but
setting `high_lines_guard_enabled=false` while leaving `lines` at 8-10 is rejected outright. This
gives a useful invariant for free: any row with `lines > 7` NECESSARILY has the guard on right
now, which is what lets `check_high_lines_drop_rate_guard` filter candidates on `lines > 7` alone
without also checking the flag.

**Decision 2 -- `dial_sessions.lines`'s own "8-10 needs the guard" rule is enforced by extending
the EXISTING `enforce_campaign_active_for_session` BEFORE INSERT trigger, not a new trigger or a
cross-table CHECK (which Postgres doesn't support).** `dial_sessions` has no client INSERT policy
at all (every write already goes through `startSession`/an RPC per 20260924000700's own comment),
so a trigger is the only real enforcement point -- same reasoning eng1's original trigger
(20260924001500, campaign-active check) already used. `create or replace function` on an
already-applied function in a NEW migration is the normal way to extend one later; the OLD
migration file itself is never edited.

**Decision 3 -- `campaigns_with_stats` needed a drop + recreate for the 3 new columns to be
visible at all.** Caught by checking the view's actual definition (explicit column list, not
`c.*` -- 20260924001500's own header already flagged this as a recurring gap, and 20260926080200
hit it again for `script_text`/`objection_sheet_text`) before assuming a plain `ALTER TABLE` was
enough. `getCampaign()`/`listCampaigns()` (api.ts) read this view, not the base table -- skipping
this would have left the guard columns silently `undefined` in the UI while everything else
looked done.

**Decision 4 -- the drop-rate window for the guard's own cron check is a hardcoded 60 minutes
with a 10-human-answer minimum sample, not a per-org settings table (unlike
`org_number_health_settings`).** The 3% threshold is this task's own literal spec, not a tunable;
a campaign-level `high_lines_guard_enabled` opt-in (default false) already satisfies "server-side
guard defaulting off" for this feature. A 30-day window (T8's own `campaign_drop_rate_summary`
window, used for the Analytics card) would be far too slow to react to or recover from a
currently-elevated-risk state -- this is a live safety guard, not a historical metric, so it
reuses the SAME drop-rate math but over a short trailing window computed fresh in its own RPC,
not a call into `campaign_drop_rate_summary` itself.

**Decision 5 -- tripping the guard snaps `lines` directly to 7, not a slow decrement.** A
circuit-breaker shape: once the drop rate crosses 3%, dialing above 7 is no longer provably safe
for this campaign, so it goes straight back to the last known-safe value and the flag turns off,
requiring a human to review and deliberately re-enable rather than the system quietly limping
along at 8 or 9.

## MISSION-5 TASK-M5-B1: agent state log + pause reasons

**Decision 1 -- hook the state-event log into `transition_session` itself (plus one `AFTER
INSERT` trigger for the session's very first state), not into every TypeScript call site.**
11 functions across `dialer-engine.ts` call `transition_session`; wiring event-logging into any
number of individual TS call sites would need every future call site to remember it too. Both
hooks are SQL, inside the two functions that are already the ONLY places a `dial_sessions.state`
change can happen at all -- structurally impossible to add a new state transition that skips the
log, matching the task's own "keep it inside the existing transition functions so it can't
drift" instruction as literally as possible.

**Decision 2 -- `agent_state_events.state`/`.reason` mirror `dial_sessions.state`/
`.pause_reason` verbatim, never a bucketed vocabulary written at insert time.** Any grouping a
consumer needs (e.g. "dialing" + "connecting" as one bucket for an attendance tab) is a read-time
`CASE`, the same way `team_live_board` already collapses `paused`/`paused_agent_lost` for
display. Keeping the write side a lossless 1:1 mirror means a future `dial_sessions` state
addition can't silently fall outside what gets logged, and a consumer that wants finer detail
later never has to backfill anything.

**Decision 3 -- a dedicated `org_pause_reason_settings` table, not a column on `orgs`.**
`orgs`' own UPDATE RLS policy is owner-only (`20260924000100`); the task wants owner+admin
editable. Widening `orgs`' UPDATE policy to admin for the sake of one column would also hand
admin write access to every other `orgs` column with no way to scope it back down. A dedicated
table gets its own narrow RLS instead, same `org_<feature>_settings` singleton shape already
established by `org_number_pool_settings`/`org_spend_settings`/etc. -- no new RPC needed, plain
`.from(...).upsert()` from the client, gated by RLS alone.

**Decision 4 -- `dialer-session-pause` does not validate an incoming `reason` against the org's
own configured list.** `dial_sessions.pause_reason` was already deliberately free-form text with
no CHECK constraint (`20260925070000`'s own comment: "only trusted engine code ever writes it");
`org_pause_reason_settings` is a UI data source for the picker, not a server-side enum -- an org
can edit the list at any time, and an old client's cached copy (or a stale reason value from
before an edit) should never become a 400. Defaults to `'Other'` when omitted, so an old client
that never sends the field keeps working exactly as before, just newly tagged.

**Decision 5 -- `agent_time_in_state` is owner/admin only; there is no agent self-view path in
this task.** TASK-M5-A4's own item is the agent-facing "my stats" self-view (TM-E6); B1 only
needed to prove the data model and expose the read RPC an attendance tab can build on. Same
`if not has_org_role(...) then return;` empty-result gate as `team_daily_stats`/`team_live_board`,
enforced server-side, not by the client choosing not to ask for someone else's `agent_id`.

## MISSION-5 TASK-M5-B3: distribution guards

**Decision 1 -- per-agent dial-cap overrides get a dedicated `org_agent_dial_caps` table, not a
column on `org_members`.** `org_members` is eng1's owned surface (board.md's lane split); a new
table with its own RLS avoids any cross-lane schema edit and mirrors `user_phone_numbers.
daily_cap`'s own existing per-resource-cap shape (just per-agent instead of per-number) rather
than inventing a new pattern.

**Decision 2 -- `claim_next_leads`' callback-fallback branch reassigns `assigned_agent_id` to the
claiming agent, it doesn't just claim once and leave ownership alone.** If ownership stayed with
the original (unavailable) owner, the very next disposition/requeue cycle would put the lead
right back into the identical stale state, and the Team page's "my callbacks" view would keep
showing it under someone who isn't actually working it. Logged via `private.log_org_action`
(`campaign_leads.callback_fallback_claim`, batched once per `claim_next_leads` call) precisely so
"who took it" is answerable from the Activity log, not just inferred from a changed column.

**Decision 3 -- `claim_next_leads` was restructured from `return query <select>` to `for v_row in
(<the same select>) loop return next ...; end loop;`.** Counting how many of a call's own claims
were fallback claims (to log once, batched) needs to inspect each returned row; a CTE like
`picked` is scoped to the single statement it's part of, so a separate query after `return query`
finishes can't reference it at all. The loop form returns the identical rows in the identical
order, just lets the function tally alongside emitting them.

**Decision 4 -- the EC-5 fix (re-checking `cl.status` directly on `assign_campaign_leads`'s own
UPDATE) was applied to every mode, not scoped to just the new `by_current_agent` one.** The gap
was already live in `20260926070003`'s original shipped version for `all`/`range`/`percentage`/
`tag` too -- a candidate computed via an earlier CTE snapshot, then written via `where cl.id =
candidates.id` with no re-check of the row's CURRENT status, could silently overwrite a row a
concurrent `claim_next_leads` had already moved to `in_flight`. Fixing it narrowly for one mode
would have left the other four modes with the exact same latent race.

**Decision 5 -- the daily dial cap counts `call_legs` across the WHOLE org-scoped day for that
agent, not per-session.** An agent who stops and restarts a session (or switches campaigns)
mid-day must not get a fresh cap each time -- `agent_daily_dial_status` joins `call_legs` to
`dial_sessions` on `agent_id` (not `session_id`), matching how TASK-M5-B1's `agent_time_in_state`
already treats "today" as spanning every session an agent has run.

## MISSION-5 TASK-M5-B2: supervisor controls

**Decision 1 -- remote pause/end/hang-up reuse the EXISTING sessionId-keyed dialer-session-*
endpoints, no new remote-control endpoint was built.** Reading `dialer-session-pause`/`-stop`/
`-hangup-live` before starting found all three already let an owner/admin act on ANY org session
by `sessionId` (only `role==='agent'` is self-restricted) -- the only real gaps were (a)
`team_live_board` not exposing `session_id` at all, so the client had no id to call them with, and
(b) no audit logging on the remote path. Building a parallel endpoint would have duplicated
already-correct, already-tested logic for no benefit.

**Decision 2 -- "end session, a live call is allowed to finish" is a `defer` flag on the existing
Stop endpoint, not a new state in the session state machine.** `stopSession` already had exactly
two outcomes when a live call is claimed (`force`: hang up now, or refuse with 409); a third
"wait" outcome just needed somewhere to park the request. Two new `dial_sessions` columns
(`remote_stop_requested_at/_by`) plus one new branch in `submit_disposition` (checked BEFORE the
existing auto-resume logic, since a manager's end-request outranks the agent's own pacing
preference) does this without adding a new `dial_sessions.state` value or touching
`transition_session`'s own state-transition contract.

**Decision 3 -- raised_hand_at auto-clears inside `transition_session` itself, not at each call
site that ends a call.** Referencing the bare `state` column on the right-hand side of
`transition_session`'s own SET list reads the PRE-UPDATE row (standard Postgres UPDATE semantics
-- every SET expression evaluates against the OLD row simultaneously) -- `raised_hand_at = case
when state = 'on_call' and p_new_state <> 'on_call' then null else raised_hand_at end` fires
exactly once, for every past AND future caller, with nothing to remember at any individual call
site. The other auto-clear trigger ("a manager starts coaching this target") is NOT a state
transition at all, so it's handled separately, inline in `runStartCoachingAction`'s own successful-
insert path.

**Decision 4 -- EC-8's "one coach per target" reuses the EXACT shape of the pre-existing "one
coach per manager" constraint (a partial unique index), not a re-check inside a transaction.**
`coaching_sessions_one_active_per_manager` already established the pattern (index + a pre-check +
a 23505 fallback for the TOCTOU race); the new `coaching_sessions_one_active_per_target` index is
its mirror image. The one real addition: since TWO different partial indexes can now both raise
23505 on the same insert, the handler distinguishes them by matching the constraint name inside
Postgres's own error message (it's embedded there), rather than adding a second round-trip query
to guess which one fired before deciding.

**Decision 5 -- coaching-end-on-transfer is hooked into `finalizeHandoff`, the ONE function
already shared by cold and warm transfer completion, not into `runCompleteTransferAction`
(warm-only) alone.** A first pass would have missed cold transfers entirely, and the underlying
gap (`dial_sessions.state` stays `'on_call'` throughout ANY transfer, so the sweeper's own
`state <> 'on_call'` staleness check never fires) applies identically to both transfer types --
fixing only the warm path would have left a real, silently-lingering-until-the-2h-hard-cap bug on
every cold transfer.

**Decision 6 -- EC-17's monitoring wording is a THIRD independent boolean on
`org_recording_settings`, appended to the existing consent message rather than replacing it.**
`announce_recording_mode`/`all_party_consent_states` already decide WHEN to announce; this only
changes WHAT the announcement says once that decision fires, keeping the two concerns (timing vs.
content) orthogonal instead of overloading the mode enum with a fourth "and monitored" variant
that would have doubled the mode list for a change that's really independent of it.

## MISSION-5 TASK-M5-B4: supervisor alerts + notification preferences + B2 manager/pod scoping

**Decision 1 -- two different dedup ("episode") mechanisms for the 4 alert conditions, not one
generic shape forced onto all of them.** Wrap-up/paused/call-too-long each map onto exactly one
OPEN row in `agent_state_events` (B1) -- a new `alerted_at` column on that table, set once per
row, is automatically the right dedup boundary because the table's own one-open-row-per-agent
invariant already IS the episode boundary (a fresh row only exists once the old one closed).
Zero-connects has no such row -- its "episode" is a derived property of `call_legs` history (the
stretch since the agent's last connect), so it needed its own marker
(`dial_sessions.zero_connects_alerted_at`) and its own boundary rule (blocked only while it falls
inside the SAME connect-free stretch, computed via `dry_streak_start`). Forcing zero-connects onto
the `agent_state_events` shape would have meant inventing a state that doesn't exist; forcing the
other three onto a call_legs-derived shape would have thrown away a boundary the schema already
gives for free.

**Decision 2 -- delivery reuses `reliability-alert-check` rather than a new cron worker.** The
task's own wording offered "extend reliability-alert-check OR a sibling worker" -- reusing it
avoids a second shared-secret/`config.toml`/pg_cron entry for the exact same "SQL decides+flips a
dedup marker, TS resolves recipients and inserts notifications" shape T10 already established.
`check_supervisor_alerts()` differs from T10's own checks only in reading its thresholds from a
per-org settings table instead of a hardcoded constant -- everything else about the split is
identical on purpose.

**Decision 3 -- pod-scoped recipient/authorization checks live in a NEW `_shared/pod-scope.ts`,
not by exposing `private.is_agent_in_callers_pod_scope` (A5) to `supabase.rpc()`.** That helper is
in the `private` schema specifically so it's callable only from other SQL functions
(RULES-CARD: every `rpc()` name must be a PUBLIC function) -- and none of B4's TS call sites
(remote dialer actions, coaching start, alert/raise-hand recipient resolution) are RPC calls to
begin with, they're plain Edge Function logic deciding who may act on or hear about an agent.
Reimplementing the same two-table shape (`org_members.pod_id` + `org_manager_pods`) in TypeScript,
once, in one shared file, is what A5's own `org-members`/`org-audit-log` GET handlers already did
ad hoc for their own two call sites -- this just gives it a name so a third and fourth caller
don't re-derive it a third and fourth time.

**Decision 4 -- `user_notification_preferences` stores only explicit overrides; absence of a row
means on.** Matches this schema's established "settings row absent means default" convention
(pause reasons, recording consent) rather than seeding a row per user per alert type on org/member
creation. This also makes "defaults = everything on for owner/admin" fall out for free -- and,
by the same absence-means-on rule, for a manager too, which the task didn't explicitly require but
is the only sensible default given the whole point of routing an alert to a pod manager is that
they see it without having to opt in first.

**Decision 5 -- no audit-log entry for either new settings write (org_supervisor_alert_settings
thresholds, user_notification_preferences).** Matches the established, if incomplete, precedent
of every other direct-table org-settings card in this codebase (`org_timezone_settings`,
`org_recording_settings`, `org_reliability_alert_settings` -- none of them audit-log their own
update today, despite pre-seeded `AUDIT_ACTION_LABELS` entries for some that nothing has ever
fired). Extending the client-only `logAuditEvent`/`org-audit-log` POST route to carry a
`targetId` for this one new case would have been a scope-creeping fix to a pre-existing gap this
task didn't introduce and wasn't asked to close.

## MISSION-5, six non-obvious decisions from across the mission (TASK-M5-D1 sweep)

**Decision 1 -- leg-scoped takeover via `coaching_sessions.taken_over_leg_id`, not a session-scoped
flag (TASK-M5-N1).** A supervisor's takeover applies to the ONE call-leg being coached, not to the
target's whole dial session -- the target session keeps running underneath (still `dialing`/queued
into its next contact) while the takeover leg is live. A session-level "taken over" boolean would
have had to explain what happens to every OTHER leg on that session; scoping the flag to the leg
itself needs no such story, and `reap_stale_coaching_sessions`'s own staleness check (which would
otherwise treat a never-`on_call`-again taken-over row as stuck) is guarded off that same column
rather than a second state.

**Decision 2 -- territory rules match with AND semantics across state and area code, not OR
(TASK-M5-C4).** A rule with both a state list and an area-code list narrows to leads matching BOTH,
not either -- read directly from the task's own worked example and confirmed against
`resolve_territory_assignments`'s matcher. OR would make a rule with two independent restriction
lists behave like two separate broader rules, which defeats the point of specifying both.

**Decision 3 -- round-robin distribution runs off a statement-level trigger plus a locked rotation
cursor, not a row-level trigger or client-side round-robin (TASK-M5-N4).** `AFTER INSERT ... FOR
EACH STATEMENT ... REFERENCING NEW TABLE` is the only shape that sees every entry path in one pass
(CSV import, `addLeadsToCampaign`'s raw upsert, a manual per-row insert) without N separate trigger
firings each re-locking the same cursor row. The cursor itself is `for update`-locked to serialize
fair advancement across concurrent batches -- but that lock only protects the cursor's own
advancement, not the rows the caller is about to write; a real TOCTOU steal race was found in
review (the shared `round_robin_assign_leads` never re-checked `assigned_agent_id is null` at
write time, so `rebalance_campaign_distribution`'s user-invoked, pre-existing-row path could steal
a lead an agent had just been assigned by a concurrent call) and fixed same-day (`1c8fdaf`) by
adding the guard to both the CTE and the UPDATE's own WHERE, not by trusting the trigger's own safe
call path to imply the RPC's was too.

**Decision 4 -- three separate "never block the write" trigger guards (E7/N4/G6), each wrapping its
OWN body in `exception when others then raise warning ...; return new/null`, rather than one shared
wrapper.** All three guards sit on a hot or webhook-driven write path (`call_legs` disposition
writes, `campaign_leads` inserts, `inbound_calls` ending) where a guard's own failure must never
roll back or block the real write it's attached to. A shared wrapper function can't itself be the
trigger (Postgres trigger functions have a fixed signature/calling convention per table), so each
guard repeats the same three-line pattern rather than factoring it out -- a real, intentional
duplication, not an oversight. TASK-M5-O1 (in progress) is adding a `private.trigger_failures` log
insert inside each guard's own exception branch, in its own nested `begin/exception`, specifically
so a failed log write can never itself escalate and defeat the guard's whole purpose.

**Decision 5 -- manager read-only contact access is keyed on `campaign_leads.assigned_agent_id`,
not `campaign_agents` membership (TASK-M5-P1).** Managers aren't attached to campaigns at all --
only agents are, via `campaign_agents` -- so the only way to express "a manager can see a contact
if an agent in their pod is working it" is through the assignment row, not campaign membership.
`private.manager_has_contact_access(p_org, p_contact_id)` checks `has_org_role(manager)` AND an
EXISTS over `campaign_leads` joined to `is_agent_in_callers_pod_scope` on `assigned_agent_id`, wired
into both the `contacts` SELECT policy and `private.contact_read_access` as a new OR-branch, every
existing owner/admin/agent branch left byte-identical, read-only for managers (explicitly called
out in the migration's own header as a lead decision, not to be re-litigated).

**Decision 6 -- disposition quality checks (E7) trigger on `call_legs`, not on `dispositions`
(TASK-M5-E7).** `dispositions` is the per-org CATALOG of disposition types (seeded once, rarely
touched) -- a trigger there would fire on catalog edits, never on an actual agent disposing of a
call. The real per-call event lives on `call_legs` (`disposition_id`/`notes`/`callback_at`/
`dispositioned_at`, all written by `submit_disposition`), so a trigger on THAT table's UPDATE is the
only shape that fires exactly once per real disposition and, as a side effect, "catches every write
path" for free -- `submit_disposition` is the sole function that ever sets `dispositioned_at`, so
one trigger there covers the ordinary agent path, a re-submit/retry, and N1's own supervisor-
takeover disposition path, with no separate wiring needed for any of them.

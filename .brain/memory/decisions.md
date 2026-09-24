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
tokens_est: 4299
---

# Decisions

Newest first. Each entry answers: what was decided, why, and what it rules out.

> Entries dated 2026-09-21 were recorded during the repository modernization and
> Agent-Brain install. Earlier decisions are **reconstructed from code**, not from
> a written record — they are labeled as such, and their "decided by" is unknown.

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

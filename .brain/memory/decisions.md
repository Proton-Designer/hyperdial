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
tokens_est: 6425
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

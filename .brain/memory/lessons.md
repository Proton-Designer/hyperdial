---
id: mem.lessons
title: Lessons
layer: L2
type: memory
status: canonical
owner: maintainer
updated: 2026-09-25
related:
  - mem.known-issues
  - mem.decisions
answers:
  - "what have we learned the hard way"
  - "what mistakes should I avoid here"
  - "what is surprising about this codebase"
  - "what did previous work get wrong"
covers: "Non-obvious things learned from working in this repository"
excludes: "Current defects (see mem.known-issues), the reasoning behind choices (see mem.decisions)"
tokens_est: 4449
---

# Lessons

Things that cost someone time, written down so they cost the next person none.

---

## A client-side filter that mirrors old RLS silently under-matches once RLS changes

`apps/web/src/lib/api.ts`'s `deleteContact`/`deleteContacts` (pre-TASK-P1-02) added `.eq('user_id',
user.id)` on top of the `id` filter — harmless when RLS itself was `auth.uid() = user_id`, since it
was redundant with what RLS already enforced. TASK-P1-01 changed `contacts` DELETE to
`private.has_org_role(org_id, ['owner','admin'])` — role-based, not literal-ownership-based — but the
client filter was never updated. The bug doesn't surface as an error: `supabase.from(...).delete()`
matching zero rows returns success with an empty result, so an owner deleting a contact an agent (or
another admin) had created would appear to succeed in the UI and silently do nothing. Found by
testing the actual RLS-governed path with curl, not by reading the code — reading it looked fine
since the extra filter looked like reasonable defense in depth. **Apply it:** whenever an RLS policy
moves from "the row's own `user_id` column" to any other authorization model (role, org membership),
grep the client for filters mirroring the *old* model and remove them — let RLS be the only
authority, since a client-side filter that used to be redundant can quietly become wrong.

## A denial-testing helper can swallow its own failure signal

Writing `supabase/tests/rls_org_matrix.sql` (TASK-P1-01), the first draft of `_test_expect_insert_denied()` did `EXECUTE p_query; RAISE EXCEPTION 'FAIL ...'; EXCEPTION WHEN insufficient_privilege
THEN RAISE NOTICE 'PASS ...'`. The bug: `RAISE EXCEPTION` is itself `raise_exception` (SQLSTATE P0001) — the very condition being widened for the campaign_agents trigger case — so an insert that
*unexpectedly succeeded* would raise its own FAIL, get caught by the handler meant to detect denial, and print a false PASS. Fixed by scoping the exception handler to a nested block around only
the `EXECUTE`, with the FAIL raise outside it. **Apply it:** in any "assert this raises" test helper, never let the helper's own "it didn't raise" failure signal share an exception class with what
it's trying to detect — check it against a boolean flag set inside a narrowly-scoped sub-block instead.

## RLS recursion is not limited to the table whose policy you're writing

The tenancy migration's task explicitly warned against an inline subquery on `org_members` inside a policy (self-recursion). Real recursion showed up a hop further out and was not self-referential
at all: `campaign_leads`' INSERT policy queried `contacts`, and `contacts`' SELECT policy queried `campaign_leads` back — two different tables, each fine in isolation, cyclic together. Postgres
caught it at runtime (`infinite recursion detected in policy for relation "campaign_leads"`), while running the RLS test suite, not while reading the SQL. **Apply it:** any inline `EXISTS (SELECT
... FROM <other RLS-protected table> ...)` inside a policy is a latent cycle waiting for the other table's policy to reference back — route it through a `SECURITY DEFINER` helper instead (see
`mem.decisions`), and don't trust a multi-table RLS design as correct until it's been exercised as a different role, not just read.

## A newly created Postgres schema is not `public`

`create schema private;` does **not** grant `USAGE` to `PUBLIC`/`authenticated` the way `public` does by default — that default is specific to the `public` schema. `GRANT EXECUTE ON FUNCTION` in
the new schema is not enough on its own; without `GRANT USAGE ON SCHEMA private TO authenticated` the role cannot even resolve `private.is_org_member(...)`, and every policy calling it fails
closed with "permission denied for schema private." Caught by the RLS test suite before any commit — would otherwise have surfaced as every single RLS policy silently rejecting real traffic.
**Apply it:** after `create schema <non-public>`, explicitly grant `USAGE` to whichever role needs to call into it.

## A UI can look finished and be a mock

`Analytics.tsx` renders polished charts from invented data, including five
fictional agent names. It sits in the main navigation next to `Dashboard.tsx`,
which is genuinely wired to the backend. **Visual completeness is not evidence of
a live data path** in this codebase.

**Apply it:** before trusting or debugging a screen's data, check whether the
component imports from `@/lib/api`. That one grep answers the question in seconds.

---

## Compiled artifacts can masquerade as source

The original export shipped a src/index.css — a 2,549-line file that *looked* like
a stylesheet and was actually Tailwind's compiled output, with no toolchain behind
it. It sat next to the real token file, `apps/web/src/styles/globals.css`, which
nothing imported. New utility classes silently did nothing.

**Apply it:** when a CSS file is thousands of lines and starts with a version
banner (`/*! tailwindcss v4.1.3 ... */`), it is build output. Find out what is
supposed to generate it before editing it.

---

## Check the whole path before believing "already broken"

The missing animation utilities (`animate-in`, `accordion-down`) looked like a
regression introduced by the Tailwind restoration. Comparing against the *old*
compiled CSS showed they had never been there — the animations had been dead since
the export.

**Apply it:** when something appears broken after a change, diff against the
actual prior artifact rather than against your assumption of what it contained.
The answer changes the fix from "revert" to "this was never wired up".

---

## A gitlink without `.gitmodules` fails silently

`telnyx-ext-agent-skills` was recorded in the index as a submodule gitlink with no
corresponding `.gitmodules` entry. `git status` reported a clean tree. Clones got
an empty directory and **no warning**.

**Apply it:** `git ls-files -s | grep ^160000` lists every gitlink. Each one
should have a matching `.gitmodules` entry. Mismatch means broken clones.

---

## `verify_jwt = false` does not mean unauthenticated

Five functions set `verify_jwt = false` in `supabase/config.toml`. Four of them
still verify the caller's token in-process via `supabase/functions/_shared/auth.ts`. Only
`telnyx-webhook` is genuinely open, and it checks a Telnyx signature instead.

**Apply it:** never infer an endpoint's auth posture from `config.toml` alone.
Read the function. Both layers are real and they are configured independently.

---

## Verification beat inference, twice, during this install

Two claims written into these documents were wrong on the first pass and caught
only by going to the code:

1. A backlog item said "grey out already-mapped import fields" was outstanding. It
   is implemented (`ImportContactsModal.tsx:374-386`).
2. A CSS coverage comparison reported 42 "missing" classes after the Tailwind
   restoration. They were variant-prefixed (`lg:grid-cols-4`) and present; the
   comparison script was wrong, not the build.

**Apply it:** in this repository, a plausible-sounding claim about current
behaviour is worth about as much as a coin flip. Spend the thirty seconds.

---

## The dial loop has no owner process

It is easy to read `dialer-session-start` and assume something continues running
after it returns. Nothing does. Every subsequent advance is driven by an inbound
Telnyx webhook.

**Apply it:** when reasoning about "what happens next" in a dial session, the
answer is always "the next webhook arrives, or nothing happens". Timeout handling
is swept on the next event, not on a schedule.

---

## Calling a revoked function as a role without EXECUTE segfaults this local Postgres 17.6 image

**Correction, 2026-09-24 (the lead's own repro):** the entry originally written here blamed the crashes on unrelated container instability, "independent of the
query." That was wrong — I only tested with a *different* trivial statement, not the actual triggering shape, and mistook a real, deterministic crash for a
coincidence. The actual trigger, reproduced by the lead with a minimal case: **querying a function as a role that has no EXECUTE on it** (i.e. a real "permission
denied for function" — not a table or schema denial, both of which are fine) segfaults this specific local Postgres image outright, taking the container down; it
restarts on its own ("database system was not properly shut down; automatic recovery in progress") a few seconds later.

This happened here while verifying TASK-P1-05's fix (`mem.known-issues` #0c): the negative-control check — calling the new `public.set_org_telnyx_key` wrapper as
`authenticated`, which has no EXECUTE on it by design — is exactly the crash shape, not an unrelated flake.

**Apply it:** never call a function as a role you expect to lack EXECUTE, even inside a `BEGIN...ROLLBACK` test — the crash happens before any transaction
semantics matter. Assert the *permission*, not the *denial*, with `select has_function_privilege('role_name', 'schema.fn(arg_types)', 'EXECUTE')` instead of
provoking the actual error. This generalizes past this one bug: any future negative-control test for a revoked function needs the same treatment, or it will take
the local DB down instead of proving the revoke works.

---

## A "loading just became false" check is unsafe if the provider can run more than one load cycle per mount

`OrgProvider` (`OrgContext.tsx`) mounts above `AppContent`'s own auth-loading gate (`App.tsx`), so
every fresh mount runs an unavoidable spurious first `load()` cycle with `user` still `null`
(`AuthContext`'s session restore hasn't resolved yet). That cycle resolves `loading` straight from
its initial `true` to `false` with `role=null` — often before a consumer's own effects run even
once, so `orgLoading` can already read `false` on that effect's very first invocation, well before
the REAL load cycle (for the actual signed-in user) has even started.

Found building TASK-B1's URL-sync deep-link promotion in `MainApp.tsx`: an effect that promoted a
manager-only deep link once `!orgLoading` treated this spurious tick as final and discarded the
pending tab before the real cycle ever got to use it — an admin deep-linking to `/campaigns`
stayed stuck on `/dialer` forever. Agents were masked from ever seeing it: `role=null` (spurious)
and `role='agent'` (real) both resolve to the same fallback, so the wrong cycle winning didn't
change their outcome — only a manager's promotion was actually lost. Caught only via live
verification (a `false` reading with the right final value by luck, and a stuck-forever value in
the actual bug case, look identical to code review — the bug is in the *ordering* of two cycles).

**Apply it:** when consuming `OrgContext.loading` (or any provider whose `load()` can legitimately
fire more than once per mount) to decide "the real data has arrived," don't trust a level read of
`loading === false`. Track whether the effect has also observed `loading === true` at some point
since mount, and only act on `false` once that's happened — i.e. wait for an actual transition, not
a value that might already be stale before the effect ever looked. The existing "gate on `role`,
not `loading`" pattern elsewhere in this codebase (Sidebar/TopNavigation/MainApp's tab-visibility
gates, `.brain/memory/known-issues.md`) is a *different* fix for a *different* symptom (that one is
about not re-hiding UI on every refetch); this one is about a one-time "has the real answer arrived
yet" promotion, which needs the transition-based guard instead.

---

## Dry-run fixture traps, learned the hard way across Mission 5 (R-039/R-041/R-042)

None of these are exotic — each one cost someone a confusing failure the first time, and costs
nothing once you know to check for it up front.

**A void RPC's result is never NULL, and a write's own read-back needs a separate statement.** A
function with no `RETURNS` still returns *something* to `.rpc()` — asserting `is not null` on a
void call's result is testing the wrong thing; cast to `::text` first if you need a real presence
check. And a statement that writes a row can't read back its own write in the same statement — the
write and the assertion belong in two separate statements (or two separate `DO` blocks) in the same
transaction, not one.

**Fixture pitfalls that only bite once you write past the happy path**: an `int` literal handed to
a `smallint` parameter needs an explicit `::smallint` cast (Postgres won't narrow it for you); every
temp table a fixture creates needs its own `grant all ... to authenticated` (temp tables don't
inherit the schema's default grants); a direct `insert` bypassing the normal RPC path must fill in
every NOT NULL column that would otherwise default to `auth.uid()` (the default only fires when the
column is omitted, not when a fixture's insert is otherwise "complete" some other way); and any
`plpgsql` function declared `RETURNS TABLE(<col> ...)` needs `#variable_conflict use_column` as the
very first line after `as $$`, or a query inside it that references a column with the same name as
an OUT parameter fails at runtime with "column reference is ambiguous" — a bug no unit test against
a fake client will ever catch, because the fake doesn't run real SQL.

**A row a validation trigger checks must be inserted already-valid, then changed — never inserted
invalid.** `campaign_agents` requires an ACTIVE member and territory rules require an active
target; a fixture that tries to insert the "before" state directly (e.g. an inactive member) just
gets rejected by the trigger before the test scenario ever begins. Insert valid, then UPDATE to the
state the test actually wants to exercise.

**Disposition keys drift with the seed function, not with memory.** `private.
seed_default_dispositions` is versioned (v2 renamed/added keys — `yes_build_profile`, `callback`,
`not_interested`, and others; `'interested'` no longer exists as of v2). A fixture that hardcodes a
disposition key from an earlier session's memory, rather than reading the CURRENT seed function,
silently inserts a key that doesn't exist in that org's own `dispositions` table.

**Give every fixture section its own phone-number prefix.** Multiple sections in the same dry-run
sharing a phone-number range makes it easy to accidentally reuse another section's row (the actual
cause of two separate dry-run bugs this run, both in the G6 inbox fixtures) — a wrong-row bug that
often still "passes" for the wrong reason, or aborts an unrelated later section outright. A
per-section prefix makes a stray literal impossible to confuse with a real fixture.

**Read RLS-governed tables only after `reset role`.** A fixture that stays as the role it just used
to set up state (often `postgres`/a superuser-equivalent) can read past RLS entirely and make a
broken policy look correct. `reset role` before every read that's meant to prove what a real client
would see.

**Every trigger on a hot or webhook-driven write path needs its own exception guard** — `exception
when others then raise warning ...; return new/null` — so a bug in the trigger's OWN logic can
never block or roll back the real write it's attached to. This is the same "never block the write"
shape behind three separate Mission-5 guards (E7/N4/G6, see `mem.decisions`), and it is a dry-run
requirement as much as a production one: a fixture that forces one of these guards to fail must
assert the base write still committed, not just that the guard behaved.

**A background poll must never drive a render gate.** `useDialerSession`'s 3s poll called the same
`loadSession` as a first load, which set `loading=true`, and `Dialer.tsx` swapped the whole session
UI for a spinner while `loading` was true -- so every poll unmounted and remounted the dialer, and the
wrap-up modal (picked disposition, notes, recording position) and the Log Close form were wiped every
few seconds (reported 2026-10-28, present since the initial import). Fix: polls pass
`{ background: true }` and never touch `loading`; the spinner shows only before the first snapshot;
a refetch that fails while a session is on screen sets `refreshError` (a warning line) instead of
`error` (which replaces the UI). Same "keep the last data, show the error beside it" rule applied to
Inbox and PowerHourBoard; Team's live board already followed it. Any new polled screen: loading /
error states are for "never loaded", not for "refreshing".

**Hand-copied state lists drift: "active session" was defined three ways.** `dialer-session-start`'s
409 check and `dial_sessions_one_active_per_agent` treat every state except stopped/completed as
active, but `dialer-session-active` (the Dialer's page-open restore) predated `paused_agent_lost`
and never got it. A session whose line dropped (closed tab, laptop asleep) was invisible on page
open -- the intern saw "Start a session", Start hit the 409, and an "A session is already active"
banner asked them to sort out a session they couldn't see; UI-6's auto-reconnect-on-refresh never
fired for the same reason. Line-lost sessions also never time out, so leftovers sat open overnight
(Kareem: 23h and 20h, 2026-10-27/28) and inflated dialing hours. Fix (2026-11-01): the restore
includes `paused_agent_lost` plus `stateSince`; the Dialer reconnects a line lost < 10 min ago,
quietly ends an older one, and on a Start 409 ends the old session and retries -- the banner is
gone. Nothing live is ever hung up: the stop endpoint (no `force`) refuses while a contact leg is
`claimed`, and then the Dialer opens that session instead. When adding a session state, grep every
`.in('state', [` list.

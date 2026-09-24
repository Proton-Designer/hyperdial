---
id: mem.lessons
title: Lessons
layer: L2
type: memory
status: canonical
owner: maintainer
updated: 2026-09-21
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
tokens_est: 2719
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

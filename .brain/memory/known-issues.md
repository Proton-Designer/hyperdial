---
id: mem.known-issues
title: Known Issues
layer: L2
type: memory
status: canonical
owner: maintainer
updated: 2026-09-23
related:
  - mem.active-work
  - mem.decisions
  - domain.analytics
answers:
  - "what is broken"
  - "what are the known issues"
  - "why is this behaving strangely"
  - "is the analytics screen real"
  - "what should I not trust"
covers: "Known defects, traps, and behaviour that looks intentional but is not"
excludes: "Planned work (see mem.active-work), deliberate design choices (see mem.decisions)"
tokens_est: 4032
---

# Known Issues

Ordered by how likely each is to waste someone's time, except #0 — ordered by consequence.

---

## 0. The Telnyx webhook signature check fails open — the dial loop is effectively unauthenticated

**Severity: critical — security. Fixed in code 2026-09-24 (TASK-P1-05). NEEDS-LIVE-VERIFY.**

Fixed: `telnyx-webhook/index.ts` no longer has a `verifySignature()` with a no-secret or unchecked-ed25519 fail-open branch. It now reads `?org=` from the request URL,
loads that org's `webhook_public_key` from `org_telephony`, and calls `_shared/webhook-verify.ts`'s `verifyTelnyxSignature()` — which fails closed on every branch
(missing header, missing key, bad encoding, stale timestamp, bad signature) and has no code path that returns `ok: true` without a real Ed25519 check (see its 11
`deno test` cases, TASK-P1-04, including a positive control and an explicit regression test that no such path exists). A request with no `?org=` is rejected before
signature checking even starts, since there is no key to check it against. `client_state.org` is cross-checked against `?org=` as defense in depth, for the new
`{org, session, leg}` client_state shape only — see the caveat below.

**NEEDS-LIVE-VERIFY**: this has never been checked against a real Telnyx account signing a real webhook. It also has never run against a real database, because
`org_telephony` (TASK-P1-05's own migration) is written but not yet applied — the lead applies it after TASK-P1-01. Until both are applied and exercised with
`supabase functions serve`, treat "fixed" as "fixed pending the local-DB and live-Telnyx checks this task couldn't do tonight."

**Caveat carried forward, not yet closed:** today's dial engine (`_shared/dialer-engine.ts`) still builds the legacy client_state shape
(`userId/sessionId/contactId/campaignId/batchIndex`), which has no `org` field — TASK-P1-05 explicitly leaves that dispatch intact and defers the engine rewrite to
Phase 2. So the `client_state.org` cross-check has nothing to check yet for calls the current engine places; only the *signature* check protects those today. Closes
when Phase 2 rewrites the engine to carry `{org, session, leg}` on every leg (`_shared/client-state.ts`, already built in TASK-P1-04).

Originally reported during the Agent-Brain install 2026-09-21.

---

## 0b. `_shared/telnyx.ts`'s `joinCallToConference` calls an endpoint that no longer exists

**Severity: high — verified against Telnyx's current OpenAPI spec 2026-09-23.** `POST /calls/{call_control_id}/actions/join_conference` (`supabase/functions/_shared/telnyx.ts:150-164`) has zero matches in Telnyx's published spec
(`https://raw.githubusercontent.com/team-telnyx/openapi/master/openapi/spec3.json`). Joining an existing call into a conference is a **conference-side** action:
`POST /conferences/{id}/actions/join` with `call_control_id` in the body. This was likely valid at some point and deprecated, or was never correct. The new
`_shared/telnyx-client.ts` (TASK-P1-04) implements the corrected endpoint. TASK-P1-05, which switches the dial engine over to the new client, inherits the fix; the
old `telnyx.ts` is untouched until then.

---

## 0c. `telnyx-connect` couldn't actually store the Telnyx key — PostgREST and `service_role` both refused the private RPCs

**Severity: high — found by eng1's review of TASK-P1-05, fixed in code 2026-09-24 (migration `20260924000500`). NEEDS-LIVE-VERIFY.**

`telnyx-connect/index.ts` calls `supabase.rpc('set_org_telnyx_key', ...)`, which PostgREST resolves only against `config.toml`'s exposed schemas
(`public`, `graphql_public` — `private` is deliberately not in that list, see TASK-P1-01). The RPC 404'd (`PGRST202`). Independently, even a direct SQL call as
`service_role` failed with "permission denied for schema private" — migration `20260924000100` granted `usage on schema private` to `authenticated` only (for the RLS
helpers), never to `service_role`. Net effect: every real "Connect Telnyx" attempt provisioned real Telnyx resources (voice profile, Call Control app, credential
connection) and then unconditionally 500'd before persisting anything, so a retry started from an empty `org_telephony` row every time.

**Fixed:** `public`-schema `SECURITY DEFINER` wrapper functions (`public.set_org_telnyx_key`, `public.get_org_telnyx_key`), owned by the migration role and therefore
able to reach `private.*` regardless of the caller's own schema grants, `revoke`d from `public`/`anon`/`authenticated` and `grant`ed to `service_role` only.
PostgREST resolves the public-schema wrapper by name; adding `private` itself to `config.toml`'s exposed schemas was rejected, since that would also turn
`is_org_member`/`has_org_role`/etc. into public REST endpoints. **Also fixed the retry-duplication risk this bug exposed**: `_shared/telnyx-provision.ts` now falls
back to a Telnyx-side find-by-name lookup (`find*ByName` on `TelnyxClient`) before creating any of the three resources, so a retry with no stored IDs reuses what a
prior (failed) attempt already created on Telnyx instead of creating a duplicate under the same deterministic name. This supersedes the "IDs only, no Telnyx-side
search" decision in `.brain/memory/decisions.md` — see that entry for why the ID-only shortcut wasn't actually safe across a failed-persist retry.

**2026-09-24 update:** the lead applied migration `20260924000500` and reviewed the wrapper ACLs and the find-by-name fix — both correct. Still owed before this
closes: the `functions serve` + curl acceptance run (signed POST → 200, unsigned/wrong-org/stale-timestamp → 401, `telnyx-connect` run twice against a mock →
second run reuses). Real Telnyx account check remains NEEDS-LIVE-VERIFY regardless.

Originally reported by eng1 (TASK-P1-05 review), fixed by eng2.

---

## 1. The Analytics screen is entirely fake data

**Severity: high — actively misleading.**

`apps/web/src/components/Analytics.tsx` imports **nothing** from `@/lib/api`. Every chart on it renders module-level constants hardcoded at `Analytics.tsx:17-38`:

`callVolumeData` (invented weekday call counts), `performanceData` (an invented disposition split), and `agentData` — **five invented people** ("Sarah Chen", "James Wilson", "Alex Kumar", "Maria
Garcia", "Tom Anderson").

The numbers never change, never load, and bear no relation to the account viewing them. It is a design mock wired into the navigation. **Do not** debug why analytics "aren't updating", and do not cite
any figure from it. Verified 2026-09-21.

**`Dashboard.tsx` is wired for real** — it calls `getDashboardStats()` and `getTeamPerformanceChart()` (`:64,74`). **But it reads an empty table.** All three analytics functions aggregate
`call_events`, and **nothing in this repository ever writes `call_events`** — the dial loop writes `call_logs`, a different table (`supabase/functions/_shared/dialer-engine.ts:195`). Verified
2026-09-21: `call_events` appears only in the migration and in one `SELECT` in each of the three functions.

So the Dashboard's zeros are **correct behaviour over an empty table**, not a bug in the functions. Fixing the metrics means writing `call_events` from the webhook (the unique index on
`telnyx_call_session_id` suggests that was the intent), not debugging `dashboard-stats`. The fourth Dashboard tile, "Revenue Pipeline", is the literal string `'Coming soon'` (`Dashboard.tsx:163`).

Net: **Analytics is fake data; Dashboard is real code over no data.** Neither screen shows a true number today.

---

## 1b. Dial-session bookkeeping bugs (verified in code)

**Severity: high.** Found during domain extraction, confirmed against the schema and the functions. Not fixed.

- **`dialer-session-active` can never find an active session.** `supabase/functions/dialer-session-active/index.ts:28` orders by `created_at`, but `dialer_sessions` has **no such column** — the schema
  defines `started_at` (`supabase/migrations/20260207000100_create_dialer_sessions_and_call_logs.sql`). The Postgres error is swallowed, so the endpoint reports "no active session" unconditionally.
  This is the guard meant to stop a second concurrent session.

- **Three of the four session counters are never written.** `dialer_sessions` declares `calls_made`, `calls_connected`, `calls_voicemail`, and `calls_no_answer`. Only `calls_made` is ever incremented
  (`_shared/dialer-engine.ts:234`). The other three are *read* by `dialer-session-stop` (`index.ts:70`) to build the end-of-session summary, so **every session summary reports zero connects, zero
  voicemails, zero no-answers.** The live UI numbers come from Realtime broadcasts and reset to the stored zeros on reload.

Recorded rather than fixed: fixing them changes dial-loop behaviour and needs the manual validation checklist, which requires live Telnyx credentials.

**The human-answer lock outlives its batch — verified in source.** `claimHumanAnswer` sets `session:{id}:humanClaimed` with `SET NX EX 300` (`supabase/functions/_shared/redis.ts:110`), but the key is
**per session, not per batch**, and is only deleted by `clearSessionState` on stop (`:119-124`). After batch 0's winner is bridged, **every later batch's human answer fails the claim and is hung up**
(`dialer-engine.ts:331-340`) until the 300s TTL lapses. Independently confirmed against source during the cold-agent verification pass.

Further findings from the same extraction — unguarded read-modify-write on batch state, losing legs never reaching `no_answer`, batch advance skipping contacts — are in `.brain/domains/dialer.md`
under *Constraints & gotchas*. **Specific and plausible, but not independently confirmed.** Treat as leads, not facts.

---

## 1c. Further findings from the 2026-09-23 audits (verified in source)

Superseded in design by `docs/design/stage-1-architecture.md`; recorded here until that lands.

- **The agent is never bridged by default.** `CampaignManageModal.tsx` sends no `agentCallControlId` (localStorage key written only by the manual single-dial flow) and `callbackNumber` defaults empty, so the winning contact joins a conference with nobody in it while `HUMAN_CONNECTED` / `contacted` / `connected` are all recorded (`dialer-engine.ts:530-538`).
- **Losing legs are stuck at `dialing` forever.** `handleCallHangup` deletes Redis `call:{id}` (`dialer-engine.ts:555`) before `markNoAnswerAndCleanup` re-reads it, which then no-ops (`:704-712`). Stop never marks legs terminal either.
- **Pause is a one-way dead end.** No resume endpoint; late webhooks for a paused session hang up legs without advancing the batch.
- **WebRTC credential leak.** `telnyx-webrtc-credentials` creates a new Telnyx credential per call and never deletes old ones.
- **Lines cap is 5, not 10** (`dialer-session-start/index.ts:63`, DB `CHECK BETWEEN 1 AND 5`).
- **`Settings.tsx` Profile / Billing / Team / Integrations tabs are mock** ("John Doe", fake $149 plan, "Coming Soon"). Same class as #1.
- **`dialer-session-start` never checks campaign ownership** or campaign status; `campaign_leads` INSERT RLS does not check contact ownership.

---

## 1d. The migrations cannot replay from an empty database

**Severity: high for local dev and any new environment.** Verified 2026-09-23 with `supabase start`, which fails. `20250207000001_add_contacts_category_status_address.sql` and `20250207100000_create_campaigns_and_leads.sql` reference `public.contacts`, which is only created by the later `20250214000001_create_contacts_table.sql` (a plain `CREATE TABLE`, not `IF NOT EXISTS`). The live project was evidently built out of order, and the files are append-only, so they are not edited.

**Local workaround:** `npm run db:local:reset` (`scripts/db-local-reset.sh`). It starts the local stack from an empty copy of `supabase/`, replays the legacy migrations in a working order, records them in `supabase_migrations.schema_migrations`, then runs `supabase migration up --local` for everything newer. **Never run a bare `supabase db reset` in the repo.**

**Long-term fix:** baseline the local and CI schema from the live project (`supabase db dump`, or a squashed baseline plus `migration repair`) once there is access to it. Until then, the live project's actual migration history is unverified.

---

## 2. Client/server contract is unenforced

**Severity: high — silent runtime failure.** `apps/web/src/lib/api.ts` hand-declares every Edge Function request and response type. There is no generated client and no shared types package, so
**changing a function's response shape produces no TypeScript error** — only a runtime failure, usually surfacing as `undefined` deep in a component. Update both sides in the same commit.

---

## 3. No automated tests, and no CI

**Severity: high.** Zero tests. `npm run check` and `npm run build` pass, but nothing runs them automatically. The only verification procedure is `docs/validation/parallel-dialer-checklist.md`, which
needs live Telnyx credentials and a real phone call. Every dial-loop change is validated by hand or not at all.

---

## 4. Two independent feature flags gate the dialer

**Severity: medium — confusing to diagnose.**

`VITE_PARALLEL_DIALER_ENABLED` (client) hides the UI; `PARALLEL_DIALER_ENABLED` (server) makes `dialer-session-start` reject requests. Unrelated variables in different environments — **both must be
on.** Setting only one gives a visible Start button that fails on click.

Defaults are asymmetric: the client flag is opt-*out* (anything but the string `"false"` enables it, `api.ts:9-12`); the server flag must be explicitly `true`. The server flag also gates **only**
`dialer-session-start` — webhook, pause, stop, and hangup stay live, so in-flight sessions keep running after it is turned off.

---

## 5. The dial loop only advances when a webhook arrives

**Severity: medium — by design, but surprising.**

No cron, no worker, no timer. If Telnyx never sends a terminal event for a leg, that batch does not advance. `resolveStaleBatchIfTimedOut()` (`_shared/dialer-engine.ts:744`) mitigates this but is
swept on the **next inbound event**, not on a schedule. A session whose events stop entirely stays wedged.

Related: webhooks are at-least-once. Every handler must tolerate the same event arriving twice, late, or out of order — and the only dedupe today is the `call_logs` upsert on `call_control_id`.

---

## 6. Smaller items

- **`CampaignManageModal.tsx` is 1,050 lines** — ~3× the next largest component. Campaign editing, lead listing, lead add/remove, and session launch in one file. Not broken; just expensive to change
  safely.
- **`.cursor/skills/` duplicates the Telnyx submodule.** 12 skill docs (~26k tokens) that appear to be a JavaScript subset of the telnyx-agent-skills submodule. Whether the copies were edited after
  copying was **not determined**.
- **Lint warnings are not errors.** `npm run lint` passes with 0 errors and 13 warnings: 11 react-refresh/only-export-components (mostly in the generated UI primitives) and 2
  react-hooks/exhaustive-deps in `useDialerSession.ts` flagging an unnecessary `state.session` dependency. The hooks ones are in the live dial-session state machine and are worth a look.
- **`ContactQueue.tsx` appears dead** — nothing imports it. Not confirmed.

---

## 7. Agent `contacts` UPDATE is full-row, not DNC-scoped

**Severity: low — narrower than ideal, not a cross-tenant leak.**

`docs/design/stage-1-architecture.md` §2's permission matrix gives every role, including Agent,
the ability to "mark a contact DNC" — but there is no `dnc` column yet (design §7, not built as of
TASK-P1-01). The tenancy migration (`20260924000300_rewrite_rls_org_scoped.sql`) therefore scopes
an agent's `contacts` UPDATE policy to *any* column on a contact reachable through a campaign they
are assigned to (`campaign_agents`), not just a DNC toggle — RLS `USING`/`WITH CHECK` cannot
restrict which columns a matching row may change without a trigger. An agent can currently edit
`business_name`, `notes`, etc. on any contact in their assigned campaigns, not only flag DNC.

**Fix when the `dnc` column lands** (design §7 / a future contacts task): either add a
`BEFORE UPDATE` trigger that rejects a non-owner/admin change touching any column other than
`dnc`, or split `dnc` into its own table with its own narrower policy.

---

## 8. Ten service-role functions still scope by `user_id` alone, not `org_id`/role

**Severity: medium — not a cross-org leak today** (`user_id` is globally unique, RLS still bounds
every table) **but wrong once a user belongs to more than one org, and narrower than design §2.**

TASK-P1-02 added `requireOrgRole` to `contacts-import`/`-parse-csv`, `dashboard-stats`,
`team-performance`, `ensure-week-summary` (`domain.auth`). Left out of scope (eng2's lane, logged per
the task's own instruction): `telnyx-list-numbers`/`-search-numbers`/`-purchase-number`/
`-webrtc-credentials`, all six `dialer-session-*` (`telnyx-connect`/`-disconnect`/`-webhook` are
already org-aware, TASK-P1-05). A multi-org user would see both orgs' numbers/sessions mixed
together from these; `telnyx-purchase-number` also has no owner/admin role check.

**Fix:** apply `requireOrgRole` the same way when these are next touched (Phase 2 for `dialer-*`;
alongside `telnyx-connect` for `telnyx-*`).

---

## Not issues — deliberate, documented elsewhere

- Redis alongside Postgres → `mem.decisions`
- `telnyx-webhook` unauthenticated at the gateway → `mem.decisions`, `domain.auth`
- the generated UI primitives left unformatted → `mem.decisions`
- No router / no URLs for app state → `mem.decisions`

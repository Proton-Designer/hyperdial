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
tokens_est: 6769
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

**2026-09-24 update — local-stack proof done, real-Telnyx proof still open:** ran `supabase functions serve` against the local DB (`org_telephony` now applied)
and posted real signed requests at `telnyx-webhook` with a generated ed25519 test keypair: correctly-signed request for the org holding that public key → `200
{"received":true}`; no signature headers → `401`; correct signature but a different `?org=` (whose `org_telephony` row has no matching key) → `401`; signature
over a timestamp 301s old → `401`. All four exactly as designed. Test org/keypair fixtures were inserted and deleted directly, not through a migration.
**Still NEEDS-LIVE-VERIFY**: a real Telnyx account actually signing a webhook with its own portal-issued key — everything above used a locally generated
keypair, not Telnyx's.

**Caveat closed 2026-09-24 (TASK-P2-E2):** the engine rewrite landed. `_shared/dialer-engine.ts` is a full rewrite that only ever builds `{org, session, leg}`
client_state (`_shared/client-state.ts`); the legacy org-less shape is no longer produced anywhere. The cross-check now actually protects every call the engine
places.

**Updated 2026-09-24 (TASK-P2-E2 fix-forward item 4):** a `call.*` event with no decodable or org-matching client_state is no longer a 401 — the signature already
authenticates the request as belonging to `orgId` (checked first, unchanged), so a mismatch here just means this specific event isn't one the engine tracks (an
inbound call to one of the org's numbers, or — once E3 lands — the agent's own WebRTC leg, which never carries this shape). It's accepted with 200 and ignored
(logged), so Telnyx doesn't retry into an endpoint that will never process it. A missing/invalid SIGNATURE is unaffected and still 401 — this only changed the
already-authenticated client_state check.

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

**2026-09-24 update:** the lead applied migration `20260924000500` and reviewed the wrapper ACLs and the find-by-name fix — both correct. Verified live against the
applied migration: `has_function_privilege()` confirms `service_role` alone can execute both wrappers (not `authenticated`/`anon` — see the corrected `mem.lessons`
entry on why this is checked, not called, as `authenticated`); a real `set_org_telnyx_key` → `org_telephony` row correct → `get_org_telnyx_key` round-trip, run
through a temporary test org and cleaned up afterward. The webhook's signed/unsigned/wrong-org/stale-timestamp acceptance is verified live too — see item #0's
2026-09-24 update. **Not verified live**: `telnyx-connect` run twice "against a mock" was proven at the `deno test` unit level only (`provisionTelnyxOrg`'s mock
`TelnyxClient`, including the specific retry-with-no-stored-IDs scenario) — there is no seam to redirect `telnyx-client.ts`'s hardcoded `api.telnyx.com` base URL
for a live HTTP mock without either a code change (out of scope tonight) or a real Telnyx sandbox key (not available). Real Telnyx account check remains
NEEDS-LIVE-VERIFY regardless.

Originally reported by eng1 (TASK-P1-05 review), fixed by eng2.

---

## 1. ~~The Analytics screen is entirely fake data~~ — SUPERSEDED by TASK-P4-P1 (2026-09-24)

Analytics.tsx and Dashboard.tsx now read real data (`call_leg_analytics`/`dial_session_hours`
views over `call_legs`/`dial_sessions`/`dispositions`), not `call_events` (still empty, still
unwritten, now also unread). See `.brain/domains/analytics.md`. "Revenue Pipeline" tile replaced
with the real conversations-per-agent-hour metric. `call_events` itself not yet deleted (a later
Phase-4 cleanup item).

---

## 1b. Dial-session bookkeeping bugs (verified in code)

**Status: describes the LEGACY engine only, superseded 2026-09-24 (TASK-P2-E2).** The
Redis/`dialer_sessions`/`call_logs` engine this entire entry is about no longer runs any real
call — `_shared/dialer-engine.ts` was fully rewritten onto the org-scoped `dial_sessions`/
`call_legs` schema (`.brain/domains/dialer.md`), and the legacy tables/code are left in place,
untouched, but dead for the dial path. Kept below for history; do not debug a live session
against these notes.

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

**Status: describes the LEGACY engine only.** Same caveat as #1b above — superseded 2026-09-24
by TASK-P2-E2's rewrite. The WebRTC-credential-leak line was independently fixed in TASK-P1-06
(`.brain/domains/telephony.md`); the rest describe engine code that no longer runs.

Superseded in design by `docs/design/stage-1-architecture.md`; recorded here until that lands.

- **The agent is never bridged by default.** `CampaignManageModal.tsx` sends no `agentCallControlId` (localStorage key written only by the manual single-dial flow) and `callbackNumber` defaults empty, so the winning contact joins a conference with nobody in it while `HUMAN_CONNECTED` / `contacted` / `connected` are all recorded (`dialer-engine.ts:530-538`).
- **Losing legs are stuck at `dialing` forever.** `handleCallHangup` deletes Redis `call:{id}` (`dialer-engine.ts:555`) before `markNoAnswerAndCleanup` re-reads it, which then no-ops (`:704-712`). Stop never marks legs terminal either.
- **Pause is a one-way dead end.** No resume endpoint; late webhooks for a paused session hang up legs without advancing the batch.
- **WebRTC credential leak.** `telnyx-webrtc-credentials` creates a new Telnyx credential per call and never deletes old ones.
- **Lines cap is 5, not 10** (`dialer-session-start/index.ts:63`, DB `CHECK BETWEEN 1 AND 5`).
- ~~`Settings.tsx` Profile / Billing / Team / Integrations tabs are mock~~ — Profile and Team are real as of TASK-P1-03; Billing is deleted (never a Stage 1 feature); Integrations stays a labeled "Phase 3" placeholder for GHL.
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

**Status: server-side flag dropped in the TASK-P2-E2 rewrite, not carried forward.** The
rewritten `dialer-session-start` (`.brain/domains/dialer.md`) does not check
`PARALLEL_DIALER_ENABLED` at all — it was never in this task's spec, and dropping it wasn't a
deliberate decision so much as a gap. The client flag (`VITE_PARALLEL_DIALER_ENABLED`) still
exists and still hides the UI (`apps/web/src/lib/api.ts`), so today there is effectively one
active flag, not two. A future task that wants the server-side kill switch back needs to add it
explicitly to the new function.

**Severity: medium — confusing to diagnose.** (Describes the pre-rewrite behavior; kept for
history.)

`VITE_PARALLEL_DIALER_ENABLED` (client) hides the UI; `PARALLEL_DIALER_ENABLED` (server) made `dialer-session-start` reject requests. Unrelated variables in different environments — **both had to be
on.** Setting only one gave a visible Start button that failed on click.

Defaults were asymmetric: the client flag is opt-*out* (anything but the string `"false"` enables it, `api.ts:9-12`); the server flag had to be explicitly `true`. The server flag also gated **only**
`dialer-session-start` — webhook, pause, stop, and hangup stayed live, so in-flight sessions kept running after it was turned off.

---

## 5. The dial loop only advances when a webhook arrives

**Status: still true of the current (TASK-P2-E2) engine** — the sweeper that would fix this is
E5, explicitly out of scope for E2, and not built yet. The specific mitigation named below
(`resolveStaleBatchIfTimedOut`) is legacy-engine-only and no longer runs; there is currently NO
mitigation at all for a leg Telnyx never sends a terminal event for. The at-least-once/dedupe
point is current and verified: `record_webhook_event` (E1's RPC) is the dedupe now, exercised
live by `scripts/dev/dialer-sim.ts`'s redelivered-event test.

**Severity: medium — by design, but surprising.**

No cron, no worker, no timer. If Telnyx never sends a terminal event for a leg, the session does not advance and never refills past that stuck leg. Nothing sweeps it today (E5, not built).

Related: webhooks are at-least-once. Every handler must tolerate the same event arriving twice, late, or out of order — `record_webhook_event` is the dedupe gate.

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

**Severity: low. Fixed in code 2026-09-24 (TASK-P2-P1).** `contacts_agent_update_scope`
(migration `20260924001300`) is the exact BEFORE UPDATE trigger fix this entry originally
proposed: an agent's UPDATE now raises `42501` unless the only column that changed is
`dnc`. Live-verified through a real PostgREST PATCH, not just SQL. Kept below for context.

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

## 9. A disabled org member can't edit even unrelated profile fields until reactivated

**Severity: low — surprising, not a leak.** `20260924000600` (TASK-P1-03) added `active_org_id is
null or private.is_org_member(active_org_id)` to `profiles`' UPDATE `WITH CHECK`, exactly as
specified. `WITH CHECK` re-evaluates the *whole new row* on every update, not just the changed
columns, so once a member's `org_members.status` flips to `disabled`, `is_org_member` goes false
for their still-set `active_org_id` and **every** self-update (even just editing `first_name`)
is rejected until an owner/admin re-enables them or `active_org_id` is nulled/repointed. Caught by
the pre-existing RLS matrix test ("agent can update own profile"), which started failing purely
because an earlier test in the same run had just disabled that fixture user.

**Fix if it becomes a real complaint:** a `BEFORE UPDATE` trigger comparing `OLD.active_org_id` to
`NEW.active_org_id` instead of a blanket `WITH CHECK`, so unrelated fields aren't gated on org
membership at all.

## 10. `listCampaigns()`'s agent filtering is UI-only, not enforced by `campaigns` RLS

**Severity: low.** Design §2 says an agent works only assigned campaigns, but `campaigns`' own
SELECT policy (`20260924000300`) is `is_org_member(org_id)` — every role sees every org campaign
row. TASK-P1-03 narrows this client-side in `api.ts`'s `listCampaigns()` (filters to
`campaign_agents` rows for the caller when `role === 'agent'`), which is fine per this task's own
invariant ("UI gating is cosmetic") since the sensitive content — `contacts`/`campaign_leads`
*inside* an unassigned campaign — is already properly denied by their own RLS regardless. An
agent calling `campaigns_with_stats` directly still gets every org campaign row (id/name/status,
no leads). Not fixed here: narrowing `campaigns` SELECT itself is a real RLS change, out of this
task's scope.

## 11. ~~`dialer-sweeper` never reaps a stuck-but-`claimed` (actively bridged) leg~~ — FIXED by TASK-L6 (2026-09-25)

Was deliberate (a real live call is silent on the webhook stream for its whole duration by
design, so webhook silence alone can't tell a genuine conversation apart from a lost hangup
webhook) -- closed exactly the way this entry's own "if this ever needs closing" note said it
would need to: a periodic Telnyx call-status poll (`GET /calls/{id}`, `is_alive`), not a longer
version of the same silence heuristic. Full writeup: entry #22 below.

## 12. `_shared/telnyx-client.ts` had 3 real request-shape bugs vs. the current Telnyx API

**Severity: high (would have failed against a live Telnyx account). Fixed in code 2026-09-24
(TASK-X2, phase 2).** A conformance audit against `developers.telnyx.com`'s own machine-readable
docs (`data/webhook-events.json`, `public/llms/calling.txt`, `api-reference/**/*.md` — the human
`/docs/api/...` pages still 404 through automated fetch) plus a fresh `spec3.json` pull found
three mismatches between this client's request shapes and what Telnyx's API actually accepts,
all fixed in the same commit with unit tests (positive-controlled: written to fail against the
pre-fix code first):
1. **`createConference`** sent a `connection_id` field that does not exist on
   `POST /conferences` (`CreateConferenceRequest`'s only fields are `call_control_id`+`name`,
   both required) and treated the real required field (`call_control_id`) as optional. Harmless
   in practice only because the one call site (`dialer-engine.ts`'s `handleWin`) always supplied
   it — fixed by dropping `connection_id` and making `callControlId` required in the type.
2. **`orderNumber`** sent `phone_numbers` as an array of plain strings; Telnyx's
   `CreateNumberOrderRequest.phone_numbers` is an array of `{phone_number}` objects. The real API
   would reject this — `telnyx-purchase-number` had never actually worked against a live Telnyx
   account. Fixed: each number is now wrapped `{phone_number: "..."}`.
3. **`searchNumbers`** built a flat querystring (`country_code=US&best_effort=true`);
   `GET /available_phone_numbers` takes one deepObject `filter` param
   (`filter[country_code]=US&filter[best_effort]=true`). Telnyx silently ignores unrecognized
   flat params, so number search was effectively unfiltered against the real API, and
   `telnyx-search-numbers`'s own "Telnyx error 10031, no results" handling could never trigger
   (the filter that would produce that error never reached Telnyx). Fixed: every filter key is
   now wrapped `filter[key]`.

Everything else audited in that pass (dial/AMD enums, `hangup_cause`, `record_start`,
`transcription_start`, `speak`, `hangup`, conference join/leave, all four provisioning
create-request bodies, `/balance`, `number_orders`/`phone_numbers` paths, the ed25519 signature
header names) matched the docs with no changes needed — see TASK-X2's board file for the full
match/mismatch table. **Also found, not fixed (out of this task's scope):** `recordStart`/
`transcriptionStart` are fully built and unit-tested but never called anywhere in
`dialer-engine.ts`, and nothing consumes `call.recording.saved`/`call.transcription` webhooks —
recording and transcription are not wired into the dial flow yet.

---

## 13. ~~`contacts`' unique-phone index was permanently skipped, and DNC/paused/one-active-campaign were never enforced on import~~ — FIXED by TASK-L3 (2026-09-25)

**BUG-12 / DSP-6 / QUE-7 / QUE-8 / GHL-7, audit/final.json.** Three related gaps, all closed in
the same task:
1. `20260924001300_contacts_e164_tz_dnc.sql`'s unique index on `contacts(org_id, phone_number)`
   only ran if the org had zero existing duplicate groups **at that migration's own apply time**
   — a one-time check, not a retry. On live, duplicates existed then, so the index was skipped
   permanently: no later cleanup could ever trigger it, since the migration never runs again.
   Live-verified at TASK-A1 (findings-eng1.md): the index genuinely did not exist. Fixed by
   `20260925000100_contacts_dedupe_dnc.sql`, which merges any real duplicate groups (oldest row
   survives, `dnc` OR'd across the group so a DNC flag is never lost, FKs repointed, verified
   live: 0 duplicate groups existed as of this fix, so it will run as a no-op in practice once
   the lead applies it -- not yet applied as of this writing) and then creates the index
   unconditionally.
2. Neither import path checked DNC (or, for GHL, the `dialer:paused` tag) before queueing a
   contact onto a campaign — a DNC'd contact re-imported into a campaign would get dialed again.
   Fixed: both paths now go through `_shared/campaign-queue.ts`'s shared `planCampaignQueue`
   before queueing, which skips (and counts) `dnc`/`paused` contacts.
3. Nothing enforced "one active campaign per contact at a time" (QUE-8) — a contact could be
   `queued` in two campaigns simultaneously via two separate imports. Fixed: a partial unique
   index (`20260925000200_campaign_leads_one_active.sql`) on
   `campaign_leads(contact_id) where status in ('queued','in_flight','callback')`, plus the same
   shared planner checking for an existing active-elsewhere row before queueing (so an import
   skips and counts the conflict instead of erroring on the constraint).

See `.brain/domains/contacts.md`'s De-duplication and Campaign queueing sections for the
mechanics. Not done (explicitly out of TASK-L3's scope): a separate E.164-keyed global DNC table
(DNC still lives on the `contacts` row itself, so a *new* contact row for an already-DNC'd phone
number, from a future import that somehow bypasses the org-scoped unique index, would not
automatically inherit it), SMS STOP handling, and GHL push of DNC (already existed).

**Real, pre-existing gap made more visible by QUE-8's new index (found in review, documented not
built — the reviewer offered either option):** a `campaign_leads` row can be `queued`/`in_flight`/
`callback` in a campaign that later gets paused, soft-deleted, or completed, or can sit
`in_flight` with no disposition ever recorded (an abandoned call). None of those states change the
row's own status, so `idx_campaign_leads_one_active_per_contact` still counts it as that contact's
one active slot — the contact is effectively stuck, unimportable into any other campaign, until
someone manually changes that row's status. This isn't new behavior QUE-8 introduced (a contact
could always get silently stuck like this); the new unique index just turns "silently stuck" into
"the next import attempt visibly skips it," which is strictly more honest but also more visible.
Not fixed here: doing so would mean campaign soft-delete/pause/complete cascading to release their
active leads (or a sweep for long-idle `in_flight` rows), which touches the dialer engine's
candidate-selection logic and campaign lifecycle — both bigger than a fix-forward on this task's
own migrations. Whoever picks this up next: releasing active leads on soft-delete is the more
clearly-correct default (a deleted/paused campaign has no business holding a contact hostage);
handling a stuck `in_flight` row without a disposition is closer to `dialer-sweeper`'s territory
(known-issues #11 is the same family of gap).

**TASK-L8 also closed 4 L3 re-review nits**: `idx_contacts_org_phone_unique`'s WHERE clause only
excluded a NULL `phone_number`, not junk/non-E.164 values -- inconsistent with the merge
migration's own `phone_number ~ '^\+'` dedupe criteria (fixed by a new migration,
`20260925000400_contacts_phone_unique_index_fix.sql`, since `20260925000100` is already applied
to live and append-only from here); `contacts-import`/`ghl-import`'s paginated existing-contacts
lookup had no explicit `.order()`, so `.range()` paging across separate requests wasn't guaranteed
stable (added `.order('id')` to both); `_shared/campaign-queue-io.ts`'s `upsertCampaignLeads`
silently dropped a contact that lost an "active elsewhere" race during the upsert itself without
telling the caller, so the response could under-report what was actually skipped (now returns
`raceDropped`, added to `skippedActiveCampaign` by both callers); `api.ts`'s `addLeadsToCampaign`
counted a contact already active in the target campaign as newly `added` (harmless no-op via
`ON CONFLICT DO NOTHING`, but a wrong count) -- now tracked separately and excluded.

---

## 14. ~~The agent audio path was 0% built — `DIALER_DEV_SKIP_AGENT_GATE` was the only reason the dialer could dial at all~~ — FIXED by TASK-L1 (2026-09-25)

**AUD-1/2/3/5/6/7, UI-6, BUG-8, SEC-8, audit/final.json.** Confirmed by the TASK-A2 audit
(`audit/findings-eng2.md`): no code created a `kind='agent'` `call_legs` row, joined a WebRTC
client into a session conference, or read a real agent `call_control_id` anywhere. With
`DIALER_DEV_SKIP_AGENT_GATE` unset (the only safe production setting), `refillCount` refused to
dial anything at all; with it set, nothing ever bridged the intern into a live call.

Fixed: `startSession` now dials the agent's own WebRTC on-demand credential SIP URI ("Go
Ready") before ever dialing a contact; the agent leg's own `call.answered`
(`processAgentLegEvent`/`handleAgentLegAnswered`, `_shared/dialer-engine.ts`) creates the
session's conference and cascades `ready_pending`/`paused_agent_lost` → `ready` →
`on_call`/`dialing`. `agentLegTransition` (`_shared/dialer-core.ts`) is the agent leg's own
tiny state machine. The agent leg's own `call.hangup` (`handleAgentLegLost`) moves the session
to `paused_agent_lost` and hangs up every active contact leg that is NOT `claimed` — a live,
bridged contact is never hung up for an agent-leg problem — and `dialer-session-reconnect`
re-dials a fresh agent leg into the same conference. `DIALER_DEV_SKIP_AGENT_GATE` no longer
exists anywhere in the codebase (`scripts/dev/dialer-sim.ts` still references it in comments —
that script is itself dead code now, see below).

A real, previously-shipping bug was caught building this: `handleWin`'s loser-resolution loop
(`loadActiveLegs` + `loserActions`, both written before an agent leg ever existed, kind-
agnostic by default) was treating the agent's own still-`answered` leg as a losing contact —
speaking to it / hanging it up the instant any real contact won. Fixed by filtering to
`kind==='contact'` before computing losers. Caught by `dialer-engine.test.ts`'s first run, not
by inspection.

**Also newly true, worth remembering:** an agent can now have only one non-terminal
`dial_sessions` row, GLOBALLY (not per campaign) — enforced by a partial unique index
(`dial_sessions_one_active_per_agent`, `20260925005000`). This is a real invariant, not just a
race-closing nicety: one agent has exactly one WebRTC/SIP endpoint, so they physically cannot be
bridged into two sessions' conferences at once.

**Also newly relevant for whoever next touches `dialer-sweeper`:** its own agent-leg-lost
reconciliation (`run_dialer_sweep`'s step 2, previously a documented no-op "until E3 lands") is
now a genuine, live lost-webhook safety net, not a no-op — but its states-to-check list
(`array['dialing','connecting','on_call','wrap_up']`) doesn't yet match the webhook-driven
path's own `AGENT_ACTIVE_SESSION_STATES` (which also treats `ready_pending`/`ready`/`paused` as
in-scope). Flagged for TASK-L6, not fixed in TASK-L1 (out of that task's file list).

**Acceptance note:** the task's original "mock-sim script" acceptance style
(`scripts/dev/dialer-sim.ts`, `functions serve` + a real local Postgres) requires `supabase
start`, which is now forbidden — local Docker is retired (RULES-CARD, this run's launch-
blockers phase). Replaced with `dialer-engine.test.ts`: `deno test` against an in-memory fake
Supabase client + the real `createTelnyxClient` with `fetch` stubbed. `dialer-sim.ts` itself is
left as unrunnable dead code, not deleted — fixing/removing it is out of scope here.

---

## 17. ~~The dialer UI showed the old optimistic "connected" instead of the real session state, and a manually-paused session had no way back~~ — FIXED by TASK-L2b (2026-09-25)

**UI-7/UI-8, BASE-10, audit/final.json.** `ParallelDialerUI`/`useDialerSession.ts` had no
concept of a "big visible state" keyed on `dial_sessions.state` — no `wrap_up` disposition
gate, no `paused`/`paused_agent_lost` surfacing beyond TASK-L1's own connection-status banner,
and `LiveCallPanel`'s call timer reset to 0 on every remount instead of tracking the real
`answered_at`.

Fixed: `DialerStateBanner.tsx` (renamed/broadened from TASK-L1's `AgentConnectionStatus.tsx`) is
now the single big-state banner for every `dial_sessions.state` value ("Ready — waiting to
dial", "Ringing N lines", "Connected — `<name>` `<timer>`", "Wrapping up", "Paused", "Agent
audio lost — Reconnect"). `WrapUpModal` (TASK-L2a) is wired in on `wrap_up` with no bypass —
`submit_disposition` (SQL) is what actually returns the session to `dialing`; the UI just
re-polls. `LiveCallPanel`'s timer now derives from the leg's real `answered_at`. UI-8: a short
Web-Audio chime (no asset) on human connect.

Two real, previously-shipping bugs caught building this (both from TASK-L1 putting a real
`kind='agent'` leg into `call_legs`, composed incorrectly by code that predates it):
1. `useDialerSession.ts`'s derived stats (`callsMade`, the current-batch grid, etc.) had no
   `kind==='contact'` filter, mirroring the exact `handleWin` bug TASK-L1 already found and
   fixed server-side (known-issues.md #14) — the client-side equivalent was still there. Every
   agent leg inflated "Calls Made" and showed as an "Unknown contact" card with no phone number
   whenever it was `answered`/`ringing`.
2. There was no way to resume a manually `paused` session at all — `resumeToDialing`
   (`_shared/dialer-engine.ts`) already accepted `paused` as a valid starting state (built for
   the wrap_up/disposition path), but no HTTP endpoint ever called it for that case. Fixed with
   a new, minimal `dialer-session-resume/index.ts`.

**Not done / out of scope:** `LiveCallPanel`'s own notes textarea is still local-state-only,
disconnected from any submit path (pre-existing, `WrapUpModal`'s own Notes field is the real
one) — not touched, since fixing it wasn't asked for and two separate "notes" fields on screen,
while a little confusing, isn't new mock data introduced by this task.

---

## 16. ~~Open self-signup was live in production, contradicting the documented invite-only design~~ — FIXED by TASK-L4 (2026-09-25)

**ADM-3, audit/final.json.** `AuthScreen.tsx` exposed a public "Start Crushing Quota" signup
form and the `on_auth_user_created` trigger's own comment admitted the self-serve path ("when
absent [no invite_token], this trigger runs the normal self-serve path: new org, owner
membership, profile") — live-verified at TASK-A1: anyone could sign up and create their own org
on `hyperdial.myhomebasesolutions.com`.

Fixed by `20260925000300_invite_only_signup.sql`: `handle_new_user()` now rejects any signup
whose `invite_token` is missing, doesn't match a real `org_invites.token_hash`, is expired,
is already accepted, or whose email doesn't match the invite — no carve-out for a first/owner
signup either, that is the point. `AuthScreen.tsx` is sign-in + password reset only now; the
only signup path left is `InviteLanding.tsx` via `?invite=<token>`. Role-based nav (UI-4) landed
in the same task: `MainApp.tsx`'s `AGENT_ALLOWED_TABS` guards every tab switch (not just the
sidebar) so a hidden tab always falls back to Dialer; `Sidebar.tsx` filters Campaigns/
Analytics/Settings out for `agent` and relabels Dashboard "My stats"; `Contacts.tsx` hides
import/add/edit/delete/bulk actions for agents (row-click-through to `ContactDetailModal` was
already view+DNC-toggle-only for non-owner/admin roles since TASK-P2-P1, untouched).

**Real, cross-cutting consequence** — ~~was only partly fixed~~ **FIXED by TASK-L8 (2026-09-25)**:
every `supabase/tests/*.sql` fixture that bootstraps a test user via a direct `insert into
auth.users` needed either a real matching `org_invites` row, or a way to bypass the trigger's new
validation for the fixture insert (the old "no token = self-serve" and "any non-null token =
already invited" shortcuts both silently relied on behavior this migration removes). `alter table
auth.users disable trigger ...` (used in `rls_org_matrix.sql`/`invite_only_signup.sql`) works
locally but **fails on live** -- `postgres` is not the owner of `auth.users` there (owner is
`supabase_auth_admin`), only of the trigger *function*. TASK-L8 fixed the remaining 7 files
(`contacts_e164_tz_dnc.sql`, `dispositions.sql`, `ghl_integration_outbox.sql`,
`campaign_settings_agents.sql`, `analytics_real_data.sql`, `dialer_schema_rpcs.sql`,
`dialer_sweeper.sql`) with the live-runnable technique instead (first used in the L4 reviewer's
own `audit/L4/dryrun.sql`): temporarily `create or replace function public.handle_new_user()` with
a no-op pass-through (`postgres` DOES own that), insert the fixture users with no trigger side
effects, build `orgs`/`profiles`/`org_members` by hand (what `org-invite-accept` would have done
after a real invited signup -- inserting into `orgs` directly still fires that table's own
unrelated AFTER INSERT triggers, e.g. TASK-P3-E1's dispositions auto-seed, exactly as a real
signup would), then restore the real trigger function. `scripts/dev/dialer-sim.ts` was never
affected in practice; it's already unrunnable dead code for an unrelated reason (#14 above, local
Docker retired). `tenancy_backfill_assertions.sql` never needed fixing -- it asserts against
already-applied backfill data and contains no `auth.users` insert of its own.

**Also found, not fixed here — a real gap in the "per-intern setup" flow (design intent, not
literally in TASK-L4's own acceptance criteria)**: `dialer-session-start` sets the new
`dial_sessions.agent_id` to whoever calls it, and the only UI that calls it —
`CampaignManageModal`'s **Start Session** button — is reachable only from the Campaigns screen,
which this same task hides for agents. An intern therefore has no way to start their own
parallel-dial session today; an owner/admin clicking Start Session on their behalf starts it
under the *owner's* `agent_id`, not the intern's, so it never shows up in the intern's Dialer via
`getActiveDialerSession`. Needs a lightweight "start dialing my assigned campaign" control inside
`Dialer.tsx` itself (dialer lane) — see `docs/guides/inviting-and-assigning-interns.md`.

---

## 18. TASK-L1 stage-03 review: 2 blockers, 6 majors — all fixed (2026-09-25)

A fresh Opus reviewer FAILed TASK-L1 (#14 above) with 2 blockers and 6 majors before it could
merge. Full findings: `audit/L1/review-notes.md` (this run's own folder). All fixed in the
same task, before TASK-L1 closed for real — summary here, not repeated in full:

- **B1**: `dialAgentLegInternal` threw OUTSIDE its own try/catch on 5 different failure
  points (Telnyx context, campaign/caller-ID lookup, the credential lookup, the leg insert),
  stranding the session in `ready_pending` forever -- and with SEC-8's unique index live,
  every later Start for that agent then 409'd against a session that could never recover.
  Root cause of "first Start always fails for a new member": `agentSipUri` only ever READ
  `org_members.telnyx_credential_id`, which only the BROWSER's own connect call ever sets --
  but the browser can't connect until it knows a session exists, i.e. after `dialer-session-
  start` (which dials the agent) already returned. Fixed by extracting the credential get-or-
  create into `_shared/agent-webrtc-credential.ts` so the server creates it too, and wrapping
  the whole function body in one try/catch that terminates the leg and stops the session.
- **B2**: a failed conference join/create was swallowed and the session still cascaded to
  ready/dialing with NOTHING confirmed bridged (Telnyx conferences expire once every
  participant leaves). Fixed: `ensureAgentConference` now falls back to creating a fresh
  conference on a failed join and only returns success once one is actually confirmed.
  **Caught a second bug while writing this fix's own regression test**: the fallback-create's
  own CAS used `AGENT_ACTIVE_SESSION_STATES`, which deliberately excludes `paused_agent_lost`
  (the very state Reconnect runs in) -- the CAS silently failed every time, so `conference_id`
  was logged as "created" but never actually persisted. Fixed to CAS on the exact current
  state instead.
- **M1**: `dial_sessions.agent_leg_id` used to link AFTER dialing, racing a fast auto-answer
  two ways (refill saw no agent leg; a race-lost link hung up the agent's own live leg as an
  "orphan"). Fixed: link at INSERT time, before dialing. Conference calls also now use the raw
  webhook event's own `call_control_id`, not the DB row's (which can still be the
  `pending-agent-*` placeholder if found via the clientState fallback).
- **M2**: no check that an event's leg was still `dial_sessions.agent_leg_id`; Reconnect had
  no guard against a double-click/two-tab double-dial. Fixed: `processAgentLegEvent` ignores
  any non-current agent leg; `reconnectAgentLeg` refuses if the existing agent leg isn't
  `ended` yet (not a perfect atomic CAS, said plainly).
- **M3**: agent-lost hung up an already-answered human SILENTLY (no abandon message -- a TCPA
  safe-harbor gap) and could cut off an already-in-progress abandon message. Fixed: reuses
  `loserActions` (the same speak_then_hangup/hangup split `handleWin` already uses), skipping
  legs already `abandoned`/`dropped`/`machine`.
- **M4**: Reconnect only ever checked `active_leg_id` to decide on_call-vs-dialing, so
  reconnecting from a manually `paused` session (or one where `wrap_up` was entered AFTER the
  agent already dropped) resumed dialing anyway -- overriding Pause / skipping the mandatory
  disposition. Fixed: a new `dial_sessions.paused_agent_lost_from` column disambiguates
  `paused`; an undispositioned-connected-leg check (not the remembered field) catches `wrap_up`
  in BOTH orderings. Migration `20260925005100`.
- **M5**: `useTelnyxCall.ts`'s inbound-call handler closed over `options.sessionId` from
  whichever `connect()` call first established the WebSocket -- a second session in the same
  mount never got its own INVITEs auto-answered. Fixed: a ref updated every render, read
  inside the handler instead of the closure.
- **m2/m3/n1/n2 (minor)**: SEC-8's 409 now detects Postgres SQLSTATE `23505` (not a message
  substring) and includes `existingSessionId`; `useTelnyxCall`'s docstring now matches its own
  behavior (rejects, doesn't "leave alone", when no session is expected); the
  `inboundCallDecisionsRef` Map is pruned on call end.
- **A third, unrelated-but-same-root-cause bug found while regression-testing B2**:
  `refillSession`'s fast-path capacity hint counted the agent leg itself (kind-agnostic
  `loadActiveLegs().length`) as if it were a dialed contact -- with `lines===1`, this made the
  hint compute exactly 0 the instant the agent leg answered, so a single-line session could
  NEVER dial a single contact (the hint skipped before ever calling `claim_next_leads`, whose
  own RPC-level capacity check IS correctly `kind='contact'`-scoped). Same root cause as
  `handleWin`'s and `useDialerSession.ts`'s own kind-agnostic bugs (#14) -- a fourth instance
  of the same class, in a fourth place. Fixed with the same one-line filter.
- Not fixed, disclosed as-is: m1 (Telnyx `sip_uri_calling_preference`, NEEDS-LIVE-VERIFY only),
  m4 (Telnyx's own 4h hard caps -- already degrades gracefully via the existing agent-lost/
  Reconnect path, not a new mechanism), n1 (a shared-file commit-attribution quirk, nothing to
  fix).

**Pattern worth remembering across this whole task and its review**: every real bug found in
TASK-L1 and its review, across FOUR separate call sites (`handleWin`, `useDialerSession.ts`,
`refillSession`, `ensureAgentConference`'s CAS), was some variant of "code written before the
agent leg existed doesn't know a new kind of row can appear, or a new state can be entered,
now that it does." When a task makes a previously-impossible case real, grep every consumer of
the affected data, not just the one call site the task itself is building.

## 19. TASK-L1 re-review round 2 (engine/migration/test half): 1 blocker (shared with #20), 1 major, 1 minor — fixed (2026-09-25)

The SAME reviewer re-reviewed #18's fixes (`5df7d97`+`55da3ab`) and FAILed again:
`audit/L1/review-notes-r2.md`. That review's blocker (the L1×L5 client-ownership redesign) and
its own third MAJOR (mic-permission check) are covered under #20 (TASK-L7, the commit that
actually redesigns the Start flow) — this entry is the engine/migration/test half, fixed and
committed separately per the lead's "commit L1 and L7 separately if practical":

- **MAJOR (M4 was not actually effective in prod)**: `transition_session`
  (`20260924000800_dialer_rpcs.sql`) only ever wrote
  `agent_leg_id`/`active_leg_id`/`conference_id`/`ended_at` — the `paused_agent_lost_from` key
  #18's own M4 fix started sending in `p_fields` was silently dropped by Postgres's own
  `case when p_fields ? 'x' then ... else x end`, so the column stayed permanently null and
  Reconnect from a manual `paused` always resumed dialing instead. The bug went unnoticed by
  every existing test because the FAKE Supabase client's `transition_session` used a blind
  `Object.assign(session, p_fields)`, which happily accepted the field the real SQL function
  didn't know about. Fixed: new migration `20260925005200` (`create or replace function`, same
  signature/grants) adds the missing case-when arm; the fake's `Object.assign` is replaced with
  an explicit allowlist (`TRANSITION_SESSION_FIELDS`) that throws on any unrecognized key, so a
  future field added to the engine without a matching SQL migration fails a test immediately
  instead of silently no-op'ing in prod. New regression test: pause → agent-lost → Reconnect →
  still `paused` (not `dialing`).
- **minor (`ensureAgentConference` fallback)**: a failed join against the existing conference
  unconditionally created a fresh one, even when a contact was still `claimed`/live in the old
  (now presumably dead) conference — splitting agent and customer across two conferences while
  the session shows `on_call`. Fixed: the fallback-create now only runs when
  `session.active_leg_id` is null; otherwise it fails the attempt (the caller hangs up the
  reconnecting agent leg and leaves the session recoverable) rather than stranding the live
  customer. New regression test confirms no second `/v2/conferences` POST and the live claimed
  leg stays untouched.
- **MAJOR, answer()-half only (the mic-permission-check half is #20)**: `useTelnyxCall.ts`'s
  inbound handler called `call.answer(...)` without awaiting or catching it — a denied/
  unavailable mic surfaced as nothing but a silent ~25s ring, then agent-lost. Fixed: the
  promise is now awaited and any rejection hangs the call up cleanly instead.

Checks: `npm run test:functions` 220 passed / 0 failed / 1 pre-existing ignored (up from 208 at
#18); `npm run check`/`npm run build` clean.

## 20. ~~No agent could start their own session (only entry point was CampaignManageModal, hidden from agents by #16) + the L1×L5 client-ownership blocker~~ — FIXED by TASK-L7 (2026-09-25)

Two things landed in one commit because the re-reviewer's fix (see #19) and eng1's own L4 finding
turned out to need the exact same redesign: `audit/L1/review-notes-r2.md`'s BLOCKER,
`audit/L5/review-notes.md` (independently reconfirming the same blocker), and
`board/01-assigned/TASK-L7-agent-start-from-dialer.md`.

- **The BLOCKER**: `CampaignManageModal.tsx` used to run its own `useTelnyxCall()` pre-flight
  client (no `sessionId`) the moment its Start modal opened, then call `startDialerSession`
  itself. `dialer-session-start` dials the agent leg SYNCHRONOUSLY, before its HTTP response
  returns — so for that whole window the pre-flight client was the ONLY registered client, and
  it rejected the real agent-leg INVITE (its inbound handler hangs up anything that doesn't
  match a `sessionId` it was told to expect, and it was never told one). Every Start landed on
  "Your line dropped" (`ready_pending` → `paused_agent_lost`) before the intern ever saw a
  connected line.
- **The redesign (fixes the blocker AND delivers TASK-L7 in the same commit)**: exactly one
  `TelnyxRTC` client per tab now, owned entirely by `Dialer.tsx`. `CampaignManageModal.tsx` no
  longer registers a client or calls `startDialerSession` at all — its Start button just hands
  off which campaign to start (`lib/dialerLaunchIntent.ts`, a same-tab in-memory intent, chosen
  over threading a new prop through `MainApp.tsx`, which is eng1's file and out of this lane) and
  navigates to the Dialer. The Dialer registers its client FIRST (mic-permission check via
  `getUserMedia`, then `connect()`), and only THEN calls `startDialerSession` — closing most of
  the race. The remaining sliver (the server may still dial before this hook's own `sessionId`
  option has taken effect in a committed render) is closed by
  `useTelnyxCall.ts`'s new `beginAgentLegExpectation`/`endAgentLegExpectation`: while "expecting"
  is on, ANY inbound `kind:'agent'` call is answered regardless of exact session match (nothing
  else can plausibly be inviting this member's own credential to an agent-kind call in that
  window) — cleared only once an effect confirms the real `sessionId` has actually committed in
  a render, not immediately on the API response (an earlier draft of this fix cleared it right
  after `setState`, which only QUEUES a re-render — reopening the same race for one more tick).
- **TASK-L7 itself**: `Dialer.tsx` now shows a `StartSessionPanel` (name/lines/caller-ID/queued
  count + a Start button) whenever no session is active, for every role — `listCampaigns()`
  already agent-filters vs. returns everything for owner/admin, so no new endpoint was needed.
  Empty state for an unassigned agent: "No campaigns assigned yet — ask your manager." A 409
  existing-session conflict offers "Open it" (opens the existing session in place) instead of
  CampaignManageModal's old "Stop & start new" flow (dropped — TASK-L7's spec only asked for
  "offer Open it"; a manager who really wants to stop-and-restart still can from the Dialer once
  it's open).
- **UI-6 (auto re-join on refresh), delivered as a side effect of the same redesign**: a refresh
  that restores a session already sitting in `paused_agent_lost` now calls Reconnect
  automatically once (guarded by session id, not a plain boolean, so a later genuinely-new
  agent-lost event still gets its own attempt) — the manual Reconnect button stays as the
  fallback/retry path.
- **The other MAJOR half of #19 (mic-permission check)**: landed here since Start now lives in
  `Dialer.tsx` — `navigator.mediaDevices.getUserMedia({audio:true})` runs before registering the
  client, surfacing a denied/unavailable mic as a clear error instead of a silent ~25s ring.
- **Dead code removed**: `CampaignManageModal.tsx`'s own `AGENT_NOT_REGISTERED` message-mapping
  was unreachable on both paths it covered (per `audit/L5/review-notes.md`) — removed along with
  the ~250 lines of now-dead Start-modal/conflict-dialog state and JSX this redesign obsoleted.

Checks: `npm run check && npm run build` clean; `npm run test:functions` unaffected (frontend-
only diff). Dev fixture harnesses: `?dev_start_session=1` (`StartSessionHarness.tsx`, this
task's own `no_campaigns`/`list`/`preflight_failing`/`starting`/`conflict` states) and the
existing `?dev_dialer_states=1`. **NEEDS-LIVE-VERIFY** (no real browser/WebRTC/mic in this
environment, and the Claude-in-Chrome extension was not connected this session either —
verified only via `npm run check`/`build`/a dev-server module-transform smoke curl): the actual
INVITE timing race this fix closes, real mic-permission prompts, and the full Start → ring →
answer path from both entry points (Dialer's own list, and CampaignManageModal → navigate →
Dialer).

## 21. TASK-L1/L7 round-3 review: 3 majors -- fixed (2026-09-25, TASK-L1r4, temporary cross-lane by eng1)

`audit/L1/review-notes-r3.md` (no blocker; the r2 blocker was confirmed fixed). eng2 was on L6,
so eng1 fixed these under a lead-approved, temporary cross-lane grant (own file:
`board/05-completed/TASK-L1r4-start-flow-fixes.md`).

- **MAJOR 1 (any org campaign startable by an agent)**: `dialer-session-start/index.ts` only
  ever checked the campaign's own `org_id` -- there was no `campaign_agents` membership check,
  so a crafted request (or a stale client-side campaign id) let an agent start dialing on a
  campaign they were never assigned to; the Dialer's own list already filtered correctly, but
  nothing enforced it server-side. Fixed: `role === 'agent'` now requires a `campaign_agents`
  row for `(campaign_id, user_id)` -> 403 `NOT_ASSIGNED_TO_CAMPAIGN` otherwise. Owner/admin
  unchanged (no assignment concept for them). Not also added to the `dial_sessions_require_
  active_campaign` insert trigger (the task's own "ideally" stretch goal) -- that migration is
  outside this task's granted file ownership; the edge function is the only real entry point a
  browser client can reach anyway.
- **MAJOR 2 (auto-reconnect fires before the line is registered)**: `Dialer.tsx`'s UI-6
  auto-reconnect effect used to fire as soon as the polled session read `paused_agent_lost`,
  with no check that `useTelnyxCall`'s client had actually finished registering -- right after a
  page refresh the connect effect is still in flight, so the reconnect's INVITE went out before
  anything could auto-answer it and immediately failed. Its once-guard was also keyed on the
  session id, so a SECOND agent-leg drop later in the same page visit was silently ignored
  forever (the ref already "remembered" that session from the first drop). Fixed: gated on
  `agentLineReady`, and re-keyed on `session.agent_leg_id` (the lost leg's own id, which only
  changes once a NEW leg is established) instead of the session id -- each distinct drop now
  gets exactly one auto-reconnect, and only once the line is genuinely ready.
- **MAJOR 3 (tab switch drops the agent line)**: `MainApp.tsx` only rendered `<Dialer/>` while
  `activeTab === 'dialer'`, so switching tabs mid-call unmounted it -- `useTelnyxCall`'s cleanup
  effect called `disconnect()`, dropping the agent's own WebRTC leg while the customer stayed
  connected hearing nobody (-> `paused_agent_lost`). Fixed by keeping `Dialer` permanently
  mounted and CSS-hiding it (`display:none`) when another tab is active, instead of
  conditionally rendering it -- preserves "exactly one client per tab" trivially (it now only
  ever mounts once for the whole app session) and removes it from the tab order/a11y tree while
  hidden, same as not rendering it at all. Verified the mechanism itself empirically in a
  temporary (not committed) Playwright-driven harness reproducing both the old
  conditional-render pattern and the new mounted-but-hidden pattern side by side: the old one
  mounted/unmounted on every toggle (reproducing the bug), the new one mounted exactly once and
  never unmounted across repeated toggles.
- **minor (connect() in-flight/error handling)**: `useTelnyxCall.ts`'s `connect()` treated any
  truthy `clientRef` as "already connected" -- but that ref is set synchronously right after
  `client.connect()`, well before `telnyx.ready` fires, so a second call made while a connection
  was still in flight resolved immediately instead of waiting for the real result, and a FAILED
  connection left the same dead client sitting there forever, so every later `connect()` call
  kept resolving immediately against it with no way to actually retry. Fixed: an in-flight
  promise ref is returned to a concurrent caller instead of a fresh one, and the client ref is
  cleared on error.
- **minor (409 "Open it" opened the wrong campaign)**: sessions are per-agent, not per-campaign
  (SEC-8), so the existing session a `dialer-session-start` 409 refers to can belong to a
  different campaign than the one just clicked -- `Dialer.tsx`'s conflict banner used the
  ATTEMPTED campaign's own name/id instead of the real one. Fixed: looks up the actual existing
  session (`getDialerSession`) to resolve its real `campaign_id` (and name, from the
  already-loaded assigned-campaigns list) before showing the conflict banner or letting "Open
  it" navigate.
- **nit**: removed the dead `AGENT_NOT_REGISTERED` string-matching in
  `dialer-session-reconnect/index.ts` and `Dialer.tsx` (nothing throws that string anymore --
  `dialer-engine.ts`'s `agentSipUri` has been self-healing via get-or-create since #18's B1);
  also corrected a stale comment in `Dialer.tsx` still describing a since-removed
  `AGENT_NOT_REGISTERED` server backstop and a since-moved "owned by the other lane" Start
  button.
- **NOT done**: the multi-tab-open detection minor (BroadcastChannel/localStorage lock + a
  warning banner) -- out of scope for this pass given the 3 majors were the trigger; every open
  tab still silently registers the same credential.

Checks: `npm run check`/`npm run build` clean (0 errors; only pre-existing warnings, none in
this diff). `npm run test:functions`/`deno test --allow-all supabase/functions/_shared` could
NOT be run to completion -- eng2's own concurrent uncommitted TASK-L6 work
(`_shared/telnyx-client.ts`'s new `getCallStatus`, not yet wired into
`telnyx-provision.test.ts`'s fixture) fails the directory-wide type-check this command does
before running anything, unrelated to this diff. Verified instead: `deno check` on both touched
Deno files individually (clean), full `npm run check`/`build` clean. NEEDS-LIVE-VERIFY (no
`functions serve`/real Telnyx in this environment): the campaign-assignment 403 against a real
DB, the reconnect timing fix against a real refresh-mid-agent-lost, and the tab-switch fix
against the real `Dialer`/`useTelnyxCall` (only the underlying React mount pattern was
hands-on-verified, in isolation).

## 22. TASK-L6: sweeper now reconciles a lost-hangup-webhook `claimed` leg + the agent-lost states-list fix from #14 — fixed (2026-09-25)

`board/*/TASK-L6-sweeper-claimed-legs.md`. Two independent fixes, one migration
(`20260925010000_dialer_sweeper_claimed_legs.sql`):

- **The `claimed`-leg reconciliation (#11)**: `run_dialer_sweep` (SQL) gained a new SELECT-only
  step -- claimed contact legs silent (by `claimed_at`) longer than
  `p_claimed_check_after_seconds` (default 300s/5min) are returned as `stale_claimed_legs`,
  never mutated (SQL can't ask Telnyx anything). All the actual DECIDING happens in TS
  (`_shared/dialer-sweeper-core.ts`'s `reconcileStaleClaimedLeg`, called from
  `dialer-sweeper/index.ts`):
  1. Older than `time_limit_secs` (1800, `CONTACT_DIAL_TIME_LIMIT_SECS` -- exported from
     `dialer-engine.ts` so this can't independently drift from the value every contact dial
     actually uses) + a 5-minute grace -- Telnyx guarantees the call ended by then (BUG-8's own
     `time_limit_secs`); reaped unconditionally, Telnyx is never even asked.
  2. Otherwise, ask Telnyx directly: `_shared/telnyx-client.ts`'s new `getCallStatus` (`GET
     /calls/{call_control_id}`, verified against spec3.json's `RetrieveCallStatus` operation --
     "Returns the status of a call...", response requires `is_alive: boolean`). Not alive (or a
     404 -- Telnyx has no record of the call at all, no less gone than one it reports dead) ->
     reap. Alive, or any other error/malformed response -> **left alone** -- a Telnyx error (or
     a genuinely live call) must never end a leg.
  - Reaping either way calls the same new SQL primitive, `reap_dead_claimed_leg(p_leg,
    p_hangup_cause)` -- replicates `processContactLegEvent`'s own `result.next === 'ended'`
    branch exactly (dialer-engine.ts): `transition_leg` -> ended (outcome stays `'connected'`,
    set by `claim_leg`'s own win transition, untouched here), `apply_leg_outcome`, and -- only
    if this leg was actually the session's `active_leg_id` -- `transition_session` -> `wrap_up`.
    Race-safe the same way every RPC in this codebase is: its own `where ... and state =
    'claimed'` guard means a real webhook that resolves the leg first just makes this a no-op.
  - Tests (this task's own acceptance line, verbatim): `_shared/dialer-sweeper-core.test.ts` --
    alive (untouched, positive control: RPC never called), not-alive (reaps, RPC called with
    `call_not_alive`), 404 (same as not-alive), API error/rejected promise (untouched, RPC never
    called), older-than-time_limit+grace (reaped unconditionally, positive control: Telnyx
    never even asked), the exact boundary (still asks), the RPC itself returning false (race
    loss, surfaces as inconclusive not a false success), and no Telnyx client available.
    `_shared/telnyx-client.test.ts` gained 5 tests for `getCallStatus` itself (alive/not-alive/
    404/other-error/malformed-response).
- **The agent-lost states-list fix (#14's own follow-up)**: `run_dialer_sweep`'s step 2 states
  list was `['dialing','connecting','on_call','wrap_up']` -- never matched the webhook-driven
  path's own `AGENT_ACTIVE_SESSION_STATES` (dialer-engine.ts), which also treats
  `ready_pending`/`ready`/`paused` as in-scope. An agent-leg-lost webhook lost while a session
  sat in any of those three states was never reconciled by this safety net. Fixed to match
  exactly (still deliberately excluding `paused_agent_lost` itself, the target state).
- **Migration note**: `run_dialer_sweep`'s signature changed (`int` -> `int, int`) -- Postgres
  identifies a function by argument TYPES, so `create or replace` alone would have created a
  SECOND, overloaded function and silently left the original one-arg version callable too. The
  migration explicitly `drop function if exists public.run_dialer_sweep(int)` first.

Checks: `npm run test:functions` 234 passed / 0 failed / 1 pre-existing ignored (up from 220);
`npm run check && npm run build` clean. **NEEDS-LIVE-VERIFY**: the whole migration
(`supabase/tests/dialer_sweeper.sql` gained new fixtures/assertions for this, but -- like every
SQL-level test in this run -- could not be executed; local Docker is retired) and the real
Telnyx `GET /calls/{id}` response shape against a real call (only verified against spec3.json's
schema, never a live request).

**Fix-forward (independent reviewer, `audit/L6/review-notes.md`, CHANGES REQUESTED -- 2 major, 3
minor; design confirmed sound) -- migration edited in place (not yet applied live):**

- **MAJOR 1**: `reap_dead_claimed_leg`'s own UPDATE never wrote `outcome` -- if `claim_leg`'s win
  committed but the SEPARATE `transition_leg(claimed->claimed, outcome:'connected')` patch
  right after it (`processContactLegEvent`, dialer-engine.ts:1023-1028) never landed (a crash or
  timeout between the two HTTP round-trips), the leg ended with `outcome` NULL. `apply_leg_outcome`
  then no-ops on a null outcome, `active_leg_id` stays pointed at the now-dead leg, and the
  NEXT sweep's own step 3b requeues that human-answered lead at attempts+0 (a real answered call
  gets redialed). The reviewer's own live dry-run (real PG16, a stub schema) reproduced this.
  Fixed: `outcome = coalesce(outcome, 'connected')`, matching what the real `call.hangup` path
  always computes for a claimed leg (`hangupOutcome`, dialer-core.ts) regardless.
- **MAJOR 2**: step 2's states-list fix (above) added `'paused'` to the list but still passed
  `'{}'::jsonb` to `transition_session` -- silently dropping `paused_agent_lost_from` for every
  session THIS sweeper (rather than a real webhook) reconciles, re-opening the L1 M4 bug
  through this specific path: Reconnect would resume dialing instead of returning to the
  intern's own remembered Pause. Also reproduced by the dry-run. Fixed:
  `jsonb_build_object('paused_agent_lost_from', v_row.state)`.
- **minor 3**: neither reap branch (`dialer-sweeper-core.ts`) sent a real Telnyx hangup after a
  successful reap -- a false "dead" read (a stale/rotated key after a BYO-account swap, a wrong
  `TELNYX_API_BASE`, or any other reason the read was wrong) would leave a live customer parked
  in the conference while our own bookkeeping had already moved on to `wrap_up`/dialing, and the
  NEXT winner would join the same (still-occupied) conference. Fixed: a best-effort
  `client.hangup(call_control_id)` after every successful reap (swallowed on failure, same
  non-fatal shape as `dialer-sweeper/index.ts`'s existing `reaped_legs` hangup loop). Also skips
  any candidate whose `call_control_id` starts with `pending-` (a placeholder never actually
  dialed) before asking Telnyx anything about it.
- **minor 4**: `getCallStatus` had no request timeout -- one hung GET could stall every LATER
  candidate in the same sweeper invocation, and the cron ticks every 30s, so stalled invocations
  would pile up. Fixed: `signal: AbortSignal.timeout(5000)` -- the existing `.catch(() => null)`
  at the call site already treats any rejection (including an abort) as inconclusive.
- **minor 5**: `supabase/tests/dialer_sweeper.sql`'s new L6 fixtures put several MORE active
  sessions on the single pre-existing agent `...0b`, violating `dial_sessions_one_active_per_agent`
  -- fixed by giving each new session its own distinct agent (5 new synthetic agent users).
  Also added the previously-missing assertions: `attempts`/`active_leg_id` explicitly checked
  after each reap (not just session/lead status), a genuinely fresh ("negative control") claimed
  leg that must be absent from `stale_claimed_legs` entirely, and a new claimed-leg-with-NULL-
  outcome fixture exercising MAJOR 1's own fix end-to-end (including a second sweep proving the
  lead is NOT requeued afterward).
- `audit/L6/dryrun.sql`'s embedded pre-apply migration body kept byte-for-byte in sync with both
  MAJOR fixes, per the reviewer's own instruction -- its 4 `findings` flags should now read
  `false` (all four were `true`/reproduced pre-fix).

Checks after the fix-forward: `npm run test:functions` 235 passed / 0 failed / 1 pre-existing
ignored (up from 234 -- one new deno test, the `pending-*` skip); `npm run check && npm run
build` clean. **NEEDS-LIVE-VERIFY unchanged**: the migration (still not applied anywhere) and
the SQL test file could not be executed (local Docker retired); the reviewer's own live dry-run
against a real PG16 stub schema is the closest this has come to real verification, and that ran
against the PRE-fix migration (confirming the bugs existed), not the post-fix one.

## 23. TASK-L1r4 round 4 review (review-notes-r4.md): 1 major + 2 required minors -- fixed (2026-09-25, round 5, eng1)

Round-4 review of `ca0e705` (#21) PASSed with nits: campaign-403, Open-it, and the always-mounted
Dialer were all confirmed correct, but found one new MAJOR the always-mounted-Dialer fix itself
exposed, plus 2 minors it upgraded from deferred to required.

- **MAJOR (auto-reconnect double-fires)**: `reconnectAgentLeg` (`dialer-engine.ts`) relinks
  `dial_sessions.agent_leg_id` to the NEW leg at INSERT time, not once it answers -- #21's own
  fix comment had this backwards. So the poll right after calling reconnect still reads
  `state === 'paused_agent_lost'` (that only flips once the new leg answers) but a DIFFERENT
  `agent_leg_id`, and the id-keyed once-guard saw a "new" id and fired a SECOND reconnect
  immediately -- hitting the server's own re-entrancy guard (409
  `RECONNECT_ALREADY_IN_FLIGHT`, an error toast on every single drop), or dialing a genuine
  third leg if the second failed fast enough (a ring loop bounded only by leg-failure speed).
  Fixed with two independent changes in `Dialer.tsx`: (1) only auto-fire when the CURRENTLY
  referenced agent leg's own `state` is `'ended'` (true for the just-lost leg, false for one
  this same effect just redialed, regardless of its different id); (2) a per-drop attempt
  budget (`autoReconnectAttemptedRef`, a plain boolean cleared only when the session actually
  LEAVES `paused_agent_lost`) instead of a per-leg-id one -- exactly one automatic attempt per
  drop, the manual Reconnect button is the only way to retry after that. `reconnectDialerSession`
  (`api.ts`) also now throws a typed `ReconnectAlreadyInFlightError` for the 409 specifically, so
  `handleReconnectAgentLine` can swallow that one case silently instead of alarming the intern
  for an expected race.
- **minor (`useTelnyxCall.ts` connect() error cleanup + timeout)**: the error path nulled
  `clientRef` without calling `client.disconnect()` first -- if the failed client's socket
  somehow survived (e.g. an error right as the WebSocket was still negotiating), a retry left
  TWO registered clients sharing one notification handler. Also had no timeout at all: a client
  that never fires `telnyx.ready` OR `telnyx.error` pinned `connectPromiseRef` forever, hanging
  every later `connect()` (including a fresh Start). Fixed: `pendingClient?.disconnect()` before
  clearing the ref; a 15s connect timeout (`CONNECT_TIMEOUT_MS`) with a `settled` guard so a
  late `telnyx.ready`/`telnyx.error` after the timeout already fired is a no-op, not a stale
  state update.
- **Multi-tab lock, deferred in #21, now REQUIRED**: the always-mounted Dialer (#21's own M3 fix)
  means EVERY open browser tab now proactively registers the agent's WebRTC line whenever a
  parallel session is active, not just the one the intern happens to be looking at -- a second
  tab could answer the same agent-kind inbound call. New `apps/web/src/lib/useSingleTabLock.ts`:
  a BroadcastChannel (near-instant handoff) + localStorage-heartbeat (durable source of truth
  for a late-joining tab, and the fallback that lets a new tab reclaim the lock if the owner
  tab's process crashed without running its `beforeunload` cleanup) single-owner election.
  `Dialer.tsx` gates the proactive-connect effect, the auto-reconnect effect, `handleDial`, and
  `handleStartSessionForCampaign` on `isOwner`, and replaces its ENTIRE render with a "HyperDial
  is open in another tab" message when another tab already holds the lock -- the non-owner tab
  never even renders the Start button or manual dialer, not just guards their handlers.
  Hands-on verified in a temporary (not committed) Playwright session with two real tabs against
  the same origin: tab 1 claimed ownership immediately; tab 2 opened to the same URL correctly
  read `isOwner:false, otherTabOpen:true`; closing tab 1 (firing its real `beforeunload`)
  handed ownership to tab 2 within one heartbeat tick.
- **Decided by the lead, no change**: the `WrapUpModal` portal covering every tab during
  `wrap_up` is intentional (wrap-up is mandatory); the Dialer registering the line at app load
  (before the intern ever opens the Dialer tab) is acceptable.

Checks: `npm run check`/`npm run build` clean (0 errors; only pre-existing warnings).
`npm run test:functions`/`deno test --allow-all supabase/functions/_shared`: unaffected, this
round touched no `_shared`/Deno files at all (frontend + `api.ts` only). NEEDS-LIVE-VERIFY (no
real Telnyx/multi-machine test in this environment): the reconnect fix against a real
agent-lost-while-reconnecting sequence, and the tab lock against two genuinely separate browser
processes/machines rather than two tabs of the same automated browser session.

## 24. TASK-L1r4 round 5 review (review-notes-r5.md, eng2): 1 major -- fixed (2026-09-25, round 6, eng1)

- **MAJOR (follower tab still polled and played the connect chime)**: `Dialer.tsx`'s
  `otherTabOpen && !isAgentLineOwner` early return (#23) sat at the END of the component body,
  AFTER every hook -- React runs every hook top-to-bottom on every render regardless of a later
  `return`, so a non-owner ("follower") tab still called `useDialerSession`, whose own internal
  3s poll kept hitting `dialer-session-get` indefinitely, and the UI-8 connect-chime effect
  (no ownership guard at all) played `playConnectChime()` OUT LOUD the instant a contact
  connected on the OWNER tab's real call -- audible from a tab simultaneously showing "HyperDial
  is open in another tab" and that never registered a WebRTC client. The two effects that could
  register a REAL second client or place a real call (the eager-connect effect, the
  auto-reconnect effect) were already correctly gated and stayed that way -- this was about
  background network/audio activity a fully-inert follower tab should not have, not a
  reopening of the core two-live-clients danger.
  Fixed structurally, not just with another guard: `Dialer` is now a thin outer component that
  calls ONLY `useSingleTabLock` and decides whether to mount a new `DialerBody` component (every
  other hook in the file, including `useDialerSession`'s poll and the chime effect, now lives
  there) -- a non-owner tab never mounts `DialerBody` at all, so none of its hooks run, not just
  "run but produce different JSX."
- **2 of 3 `useSingleTabLock.ts` minors fixed, cheap**: the dead `'heartbeat'` broadcast branch
  (nothing ever sent one, only the fallback poll covered staleness) now actually sends one from
  the owner's heartbeat interval, delivering on the file's own "near-instant handoff" claim
  instead of relying solely on the ~1.5s poll; the false-positive "other tab open" window after
  a non-clean tab close (a killed process, not a normal close) now has an explicit comment at
  `STALE_AFTER_MS` naming it as an accepted tradeoff rather than an implicit one. The third
  minor (a brief dual-owner window when two tabs open at nearly the same instant) is left as
  documented, self-correcting behavior -- eliminating it needs a real leader-election handshake,
  not a cheap fix, and per the review it only affects the first seconds after opening, before
  either tab could plausibly have an active call yet.

Checks: `npm run check`/`npm run build` clean (0 errors; only pre-existing warnings). This round
touched no `_shared`/Deno files. NEEDS-LIVE-VERIFY: unchanged from #23 (the tab lock against two
genuinely separate browser processes/machines).

---

## 25. ~~`call_legs.duration_seconds` was never written -- Talk Time always showed 0m~~ -- FIXED by TASK-M1 (2026-09-25)

- **The gap**: the transition RPCs supported `duration_seconds` (`transition_leg`'s own
  `p_fields` case-when, `20260924000800_dialer_rpcs.sql:179`), but `dialer-engine.ts` never
  passed it on any leg-ending path -- `call_leg_analytics.duration_seconds` was always null, so
  the Dashboard's Talk Time card always rendered `0m` regardless of real call activity. Also
  blocked the user's own ask to replace the ambiguous "Revenue Pipeline" card ("Coming soon",
  `Dashboard.tsx`) with something genuinely useful -- "Conversations / hr" needs a real duration
  to know which connected legs actually count as a conversation (>= 30s).
- **Fix**: a new `call_legs.bridged_at` column, stamped by `handleWin` (dialer-engine.ts) right
  after the winning leg's conference create/join actually succeeds -- never on a failed join.
  `duration_seconds = ended_at - (bridged_at ?? answered_at ?? claimed_at)`, computed on all
  THREE leg-ending paths that can produce a `connected` outcome: the real `call.hangup` webhook
  (`applyLegTransition`, gated on `result.outcome === 'connected'`), the sweeper's
  `reap_dead_claimed_leg` (SQL-only -- no TS event exists for this path), and an agent-lost
  claimed leg (which was never directly touched by `handleAgentLegLost` -- it becomes a stale
  candidate the sweeper's reap path picks up, same as any other timed-out claimed leg). See
  `.brain/domains/dialer.md` and `.brain/domains/analytics.md` for the full mechanism and the
  fallback-chain rationale (the winning leg's own `call.answered` never gets `answered_at`
  written -- it's the claim-win branch that resolves it, not the generic event path -- so
  `claimed_at` is a REAL second fallback, not a defensive no-op one).
- Fixed the SAME masking-bug class (M4, #21/#22) one more time while here: the fake
  `transition_leg` in `dialer-engine.test.ts` was still a blind `Object.assign` (unlike
  `transition_session`'s fake, already fixed to an allowlist after M4) -- would have silently
  accepted a `p_fields` key the real SQL doesn't write. Now allowlisted the same way.
- `supabase/functions/_shared/analytics-core.ts` (new): pure `isConversation`/
  `computeConversationsPerHour`, deno-tested directly, since Edge Function `index.ts` handlers
  have no test files of their own in this repo (`dashboard-stats/index.ts` just calls in).
- ~~Deferred, not wired: `Analytics.tsx`'s per-agent table is still fully mock data~~ -- **stale,
  checked 2026-09-25 (TASK-B1 Phase 4):** `analytics-summary/index.ts` already computes and
  returns a real `agentPerformance` array (calls/connections/rate per agent, real `profiles`
  names) and `Analytics.tsx` renders it with no mock data left in the file. What's still true: no
  per-agent Conv/hr (agent-hours) breakdown exists, only calls/connections/rate -- that part of
  this note was accurate, the "still fully mock data" framing was not (by the time this was
  written or since, superseded either way). CLAUDE.md's own paragraph corrected in the same
  commit.
- Checks: `deno test` 240 -> 247 (0 failed); `npm run check`/`npm run build` clean.
  `supabase/tests/dialer_sweeper.sql` extended with `duration_seconds` assertions on the reap
  path (NEEDS-LIVE-VERIFY, same as the rest of that file -- local Docker is retired). The new
  migration (`20260925020000_call_legs_duration_conversations.sql`) is committed but not yet
  applied anywhere.

## 26. ~~`apply_leg_outcome` incremented `attempts` for an `abandoned` losing leg exactly like a real no-answer~~ -- FIXED by TASK-F-T1 (2026-09-25)

- **The bug**: the live `apply_leg_outcome`'s attempts formula only excluded the `'dropped'`
  outcome from the `+1` increment (`case when v_outcome = 'dropped' then 0 else 1 end`).
  `'abandoned'` — the OTHER losing-leg outcome (a leg that had answered, then lost the race to
  another leg in the same batch and was hung up with the abandon message) — fell into the
  `else` branch and was incremented every time, silently burning a real attempt on a lead that
  never actually got a chance to answer or not-answer. This is a genuine BUG-3 instance found
  by cross-referencing `hangupOutcome`'s (`dialer-core.ts`) full outcome vocabulary against the
  live SQL's `case` list, not by guessing — `dropped` and `abandoned` are both losing-leg
  outcomes per BUG-3's own wording ("losing legs... attempts unchanged"), and only one of the
  two was ever handled.
- **Fix**: `case when v_outcome in ('dropped', 'abandoned') then 0 else 1 end`. Also gave losing
  legs `next_attempt_at = now()` (was `+15 minutes`) and a new `priority_requeue` flag (QUE-4's
  "front of the queue," not just "soon") — see `.brain/domains/dialer.md`'s Queue v2 section.
- Checks: `deno test` 247 -> 265 (0 failed, +15 `queue-retry-rules.test.ts`, +3
  `ghl-sync-worker.test.ts` nurture_tag tests); `npm run check`/`npm run build` clean. The SQL
  half (this fix, DNC exclusion, retry rules, block rotation) is NEEDS-LIVE-VERIFY via
  `audit/FT1/dryrun.sql` — local Docker is retired, same as every other high-risk SQL task this
  session.

## 27. TASK-F-T2's own task doc assumed webhook fields that don't exist on `call.recording.saved` — CORRECTED before any code was written (2026-09-25)

- **The doc's assumption**: "store `recording_url`, `duration_seconds`" implied the webhook
  payload carries a duration field and (per REC-6's "keep the Telnyx `recording_id`") a
  `recording_id` field. Verified against the real spec3.json (`CallRecordingSaved.payload`) and
  `webhook-events.json`: neither exists. The payload has `call_leg_id`/`call_session_id`
  (neither is `call_control_id`), `recording_started_at`/`recording_ended_at` (duration is
  derived, not read off a field), and `recording_urls.{mp3,wav}`.
- **Consequence for the webhook→row mapping**: `telnyx-webhook/index.ts`'s existing
  `callControlId = payload.call_control_id || payload.call_session_id` fallback means this event
  is ALWAYS looked up by `call_session_id` (since `call_control_id` is absent) — which never
  matches a real `call_legs.call_control_id`. This is not a bug: `loadLegByCallControlIdOrClientLeg`
  (`dialer-engine.ts`, TASK-P2-E2) already falls back to `clientState.leg` on a miss, and
  `record_start`'s own `client_state` param carries exactly that. Working as designed, but worth
  knowing if this ever needs debugging — the `call_control_id` lookup for this ONE event type is
  expected to always miss.
- Not fixed-forward as a bug because nothing shipped with the wrong assumption — caught during
  the pre-build Telnyx-docs verification pass (`.brain/memory/decisions.md` has the full
  writeup) before `recording-core.ts`/`dialer-engine.ts` were written.

## 28. REC-5's "contact history shows the recording link" — not built, no contact-history UI exists yet

- Grepped the whole `apps/web/src` tree: there is no per-contact call-history surface anywhere in
  this app today. Only the wrap-up modal's recording play button (REC-5's other clause) was
  built. Deferred to TASK-F-P4 (eng1's future touch-history strip) — the underlying signal
  (`call_legs.recording_path is not null`) already exists; F-P4 just needs to select it, no new
  column or API required. See `.brain/memory/decisions.md`.

## 29. `cn()`/twMerge silently drops a custom `text-meta`/`text-body`/`text-page-title`/`text-section-title`
class whenever it's combined in the SAME `cn()` call with a `text-text-*`/`text-accent-*`/etc colour class

- Found live (TASK-F-P1's FE-B nits): Contacts' filter chips rendered at 16px/600-weight instead of
  the intended 12px `.text-meta`, confirmed via `getComputedStyle` in a headless Playwright check —
  the `text-meta` token was missing from the DOM entirely. Root cause: twMerge pattern-matches any
  `text-XXX` class as belonging to Tailwind's built-in "text color" class group unless XXX is a
  recognized font-size keyword; `.text-meta` (a plain custom CSS class defined directly in
  `globals.css`, not a Tailwind-generated utility) doesn't match that keyword list, so twMerge
  treats `text-meta` and `text-text-secondary` as two conflicting color utilities and keeps only
  whichever comes later in the `cn()` argument list, silently dropping the other. A plain
  `className="text-meta text-text-secondary"` (no `cn()`) is unaffected -- the properties don't
  actually collide (font-size vs color) -- only a `cn()`/twMerge merge is at risk.
  `grep -rn "text-meta\|text-body\|text-page-title\|text-section-title" apps/web/src/components
  --include="*.tsx" | grep -E "text-text-|text-accent-|text-danger|text-success|text-warning"`
  found ~150 occurrences repo-wide; NOT all are inside a `cn()` call (many are plain className
  strings, unaffected) and this wasn't audited call-by-call -- only the Contacts chip instance was
  confirmed broken and fixed (switched to `text-[13px]`, a Tailwind arbitrary-value font-size util,
  which twMerge groups separately from color and never conflicts with `text-text-*`). Worth a
  dedicated sweep before trusting any other `cn(...'text-meta'...'text-text-*'...)` combination.

## 30. FIXED — Settings → Dispositions up/down reorder (B1-009) was a no-op for any existing org
whose migrated-in canonical dispositions collided in `sort` with its pre-existing rows

- Found live during TASK-F-P1's post-deploy UI verification against the QA sandbox org (which
  pre-dated the migration, same shape as every real org). `seed_default_dispositions`'s ADD-only
  backfill DO block (`20260925060000_dispositions_v2.sql`) inserts each new canonical-key row with
  the seed function's own fixed `sort` constants (10/20/30/40/50/60/70/80) -- the same constants
  the ORIGINAL seed used for that org's pre-existing rows. Any org whose custom dispositions still
  sit at those original sort values (the common case -- nothing in this app lets an org compact
  sort gaps) ends up with ties: confirmed live at `sort=10` (`interested` / `yes_build_profile`),
  `sort=40` (`wrong_number` / `already_on_platform`), `sort=60` (`voicemail` / `gatekeeper`),
  `sort=70` (`no_answer` / `do_not_call`) in the QA org's `dispositions` table.
- Impact: `Settings.tsx`'s `moveDisposition` swaps two adjacent rows' `sort` values
  (`updateDisposition(current.id, {sort: neighbor.sort})` / vice versa) -- when the two already
  share the same `sort`, the swap PATCHes both to the identical value, so the button visibly does
  nothing. Confirmed via live network capture: clicking "Move down" on `interested` fired two
  `PATCH .../dispositions?id=eq...` requests, both bodies `{"sort":10}`, and the re-fetched list
  came back in the same order. Separately, `order=sort.asc` with real ties has no defined
  secondary sort key, so row order among tied dispositions is not guaranteed stable across loads.
- Not a regression in the pairwise-swap idea itself (it was correct when sort values differed) --
  the bug was upstream, in the backfill's blind reuse of fixed sort constants without checking
  what an existing org already occupies at those values. Only ever affected orgs that existed
  before the migration; a brand-new org's canonical set is seeded once, with no collision
  possible.
- **Fixed forward** (same day, code-only, no migration): `moveDisposition` no longer swaps just
  the two neighbors' existing `sort` values. It now re-derives the WHOLE order from the swapped
  local array and writes `sort = (position+1)*10` to every row whose value actually changes --
  self-healing any collision, old or new, the moment an admin reorders anything. Verified live
  against the QA org via `npm run dev` (same live Supabase backend): before the fix, `sort=10`
  was shared by `interested`/`yes_build_profile`, `sort=40` by `wrong_number`/`already_on_platform`,
  `sort=60` by `voicemail`/`gatekeeper`, `sort=70` by `no_answer`/`do_not_call`; one "move down"
  click fired 11 PATCH requests (every row except the one whose target position already matched
  its current sort) and left all 12 rows at unique `sort` values 10..120; a second "move down" on
  the same item, then a hard reload, confirmed the new order persists. No migration and no data
  backfill involved -- a real org's `dispositions.sort` only changes when a user reorders it.
  `apps/web/src/lib/api.ts` needed no change (`updateDisposition` already accepts a partial
  `{sort}` patch; this was always a direct Supabase client call, never an Edge Function/RPC).

## 31. FIXED (before ever applied) — `org_integrations_status`/`org_telephony_status` were
writable directly by any authenticated user, bypassing their base tables' zero-policy RLS

- Found by the lead during TASK-G7 review, before `20260925080000` was ever applied to live.
  `org_integrations_status` and `org_telephony_status` are plain single-table `SELECT` views (no
  `DISTINCT`/`GROUP BY`/join) -- which Postgres treats as automatically updatable
  (`information_schema.views.is_updatable = 'YES'`) -- and both are deliberately
  `security_invoker = false` (see each view's own header: needed so the view itself can read past
  its base table's intentional zero client policies). An `INSERT`/`UPDATE`/`DELETE` issued directly
  against either view therefore ran with the VIEW OWNER's privileges, not the caller's, completely
  defeating the "zero client policies" protection both base tables (`org_integrations`,
  `org_telephony`) were built around. Only `grant select ... to authenticated` was ever added on
  top of Supabase's project-level default privileges (which grant `INSERT`/`UPDATE`/`DELETE`/
  `TRUNCATE`/`TRIGGER`/`REFERENCES` on every `public`-schema relation, views included, to
  `anon`/`authenticated` by default) -- that select grant does not remove the rest. Proven live
  (rolled back): an intern-level `authenticated` session's
  `update org_telephony_status set call_control_app_id = ...` updated the real `org_telephony`
  base-table row. TASK-G7 widened the same hole -- an intern could otherwise clear
  `ghl_dnc_tags`/`ghl_paused_tags` straight through `org_integrations_status`, bypassing the
  owner/admin check `ghl-update-blocked-tags` enforces.
- **Fixed inside `20260925080000` itself** (never applied with the hole present):
  `revoke insert, update, delete, truncate, trigger, references on org_integrations_status,
  org_telephony_status from anon, authenticated` (both views, same root cause), plus `revoke
  select ... from anon` on both (belt and braces -- `is_org_member(...)` already returns false
  for `anon`, so this changes nothing functionally, it just removes the question). `authenticated`
  keeps `SELECT` on both -- the legitimate read path (`getGhlIntegrationStatus`/
  `getTelnyxConnectionStatus` in `api.ts`, both `.select()`-only, grepped to confirm neither client
  path nor anything else ever writes through either view) is unaffected.
- **Reusable check for any future `security_invoker = false` view over a zero-client-policy
  table**: check `information_schema.views.is_updatable` for that view, and if it's `YES`, revoke
  `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`/`TRIGGER`/`REFERENCES` from `anon`/`authenticated`
  explicitly -- `grant select` alone is not sufficient, Supabase's default privileges already gave
  those roles everything else.

## 32. `campaign_retry_rules.rotate_block = false`'s own documented behaviour ("a flat
now()+delay_minutes offset") does not exist in either of its two callers

- Found while implementing TASK-T8's QUE-2 (gatekeeper's own shorter retry delay). The column's
  comment (`20260925030000_queue_v2_retry_dnc.sql`) says: "a non-rotating retry (action='retry',
  rotate_block=false) is a flat now()+delay_minutes offset instead -- not used by either seeded
  retry rule today, but a future org-added rule can choose it." That branch was never actually
  written. Both `apply_leg_outcome` (`20260925050000_voicemail_drop.sql`) and `submit_disposition`
  (`20260926080500_auto_resume_pref.sql`) have their own copy of the same `retry` branch, and BOTH
  unconditionally call `private.rotated_retry_schedule(...)` for ANY row with `action = 'retry'`,
  never reading `rotate_block` at all. `rotated_retry_schedule` itself always rotates the time
  block AND always floors to `greatest(1, p_delay_days)` -- i.e. at minimum "tomorrow, in a
  different block" -- regardless of how small `delay_minutes` is (`240/1440` integer-divides to
  `0`, floored back up to `1`, so 4 hours and 4 days both currently mean "one day out" for a
  `rotate_block=true` row, and `rotate_block=false` changes nothing since it's never checked).
- **Practical effect**: there is currently no way to configure a genuinely same-day (sub-24-hour)
  campaign retry via `campaign_retry_rules`, no matter what `rotate_block`/`delay_minutes` combo is
  set. TASK-T8 worked around this rather than fixing it (out of scope to re-deploy two already-
  applied, security-definer core functions in an already-high-risk task): gatekeeper is seeded at
  `delay_minutes = 1440` (reads as "1 day" for a future maintainer, though any value 1..2879 would
  produce the identical live behaviour today) -- still genuinely shorter than no_answer/voicemail's
  4-day default, which is all QUE-2 actually asked for.
- **If a future task needs a real same-day retry**: implement the missing `rotate_block = false`
  branch in BOTH `apply_leg_outcome` and `submit_disposition` (`create or replace`, new migration,
  same pattern every other change to these functions already uses) -- a flat
  `now() + make_interval(mins => v_rule.delay_minutes)`, skipping `rotated_retry_schedule`
  entirely when `rotate_block` is false. Test both call sites; they're separate copies of the same
  logic, not one shared function.

---

## Not issues — deliberate, documented elsewhere

- Redis alongside Postgres → `mem.decisions`
- `telnyx-webhook` unauthenticated at the gateway → `mem.decisions`, `domain.auth`
- the generated UI primitives left unformatted → `mem.decisions`
- No router / no URLs for app state → `mem.decisions`
- `dnc_numbers` and `contacts.dnc` are two independent DNC signals with no sync trigger between
  them → `mem.decisions`, `domain.contacts`
- Call recording uses call-level `record_start` (channels: dual), not conference-level, and its
  webhook is mapped via `client_state` (never `call_control_id`, which doesn't exist on that
  payload) → `mem.decisions`
- Recording retention deletes via the `recording-retention` Edge Function's Storage API call,
  never a raw SQL `DELETE FROM storage.objects` → `mem.decisions`
- B1-009's own text says dispositions reorder "persisting `sort_order`" -- the live column has
  always been named `sort` (TASK-P3-E1); reorder persists to `sort`, not a renamed column →
  `mem.decisions`
- An existing org that had a pre-F-P1 disposition (e.g. `interested`/`dnc`/`voicemail`) now also
  has the new canonical key alongside it (e.g. `yes_build_profile`/`do_not_call`/`voicemail_left`)
  -- deliberately ADD-only, per the task's own instruction; an admin deactivates whichever set
  they don't want via the existing Settings editor → `mem.decisions`

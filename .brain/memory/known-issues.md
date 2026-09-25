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

## 11. `dialer-sweeper` never reaps a stuck-but-`claimed` (actively bridged) leg

**Severity: low, deliberate.** `run_dialer_sweep`'s staleness check (TASK-P2-E5,
`20260924001700_dialer_sweeper_cron.sql`) excludes `call_legs.state = 'claimed'` entirely,
regardless of age. Reasoning: a real live call is silent on the webhook stream for its whole
duration by design — only `call.hangup` fires at the end — so "no webhook event in 60s" can't
distinguish a genuinely-ongoing conversation from a `claimed` leg whose hangup webhook got lost.
Forcibly hanging up a live call on that false positive is worse than leaving the rare true-dead-
`claimed`-leg case unresolved until Telnyx's own eventual timeout/`time_limit` hangup delivery.
If this ever needs closing, it needs a real signal a lost webhook can't fake — e.g. a periodic
Telnyx call-status poll (`GET /calls/{id}`) — not a longer staleness window on the same webhook-
silence heuristic, which would just make real long calls false-positive instead.

**Downstream consequence, flagged by the lead in review:** since `handleWin`'s winning leg is
the one that carries `dial_sessions.active_leg_id`, a WINNER whose own `call.hangup` webhook is
lost leaves that leg stuck at `claimed` forever — and because the sweeper never reaps `claimed`,
the SESSION also stays stuck in `on_call` forever (never reaches `wrap_up`, so no disposition is
ever possible for it). **Follow-up, not yet built:** either (a) reap a `claimed` leg specifically
once it's been silent for a much longer window than the pre-connect threshold (e.g. 2 hours —
long enough that no real conversation is still running, short enough to actually recover), or
(b) a periodic Telnyx call-status poll for any session parked in `on_call`/`connecting` past a
similar threshold. Neither is implemented; this is the honest gap, not a silent assumption.

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

---

## Not issues — deliberate, documented elsewhere

- Redis alongside Postgres → `mem.decisions`
- `telnyx-webhook` unauthenticated at the gateway → `mem.decisions`, `domain.auth`
- the generated UI primitives left unformatted → `mem.decisions`
- No router / no URLs for app state → `mem.decisions`

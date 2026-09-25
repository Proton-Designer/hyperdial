---
id: domain.dialer
title: Parallel Dialer
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-24
sources:
  - supabase/functions/_shared/dialer-core.ts
  - supabase/functions/_shared/dialer-engine.ts
  - supabase/functions/_shared/client-state.ts
  - supabase/functions/dialer-session-*/**
  - supabase/functions/telnyx-webhook/**
  - apps/web/src/hooks/useDialerSession.ts
  - apps/web/src/lib/api.ts
  - apps/web/src/components/dialer/**
  - supabase/migrations/20260924000700_dialer_schema.sql
  - supabase/migrations/20260924000800_dialer_rpcs.sql
  - supabase/migrations/20260924001000_dialer_rpc_fixes.sql
  - supabase/migrations/20260924001900_dialer_engine_fix_forward.sql
  - scripts/dev/dialer-sim.ts
  - supabase/tests/run-dialer-concurrency-test.sh
related:
  - domain.telephony
  - domain.campaigns
  - arch.system-overview
answers:
  - "how does the dialer pick which answered call the agent talks to, and what counts as human"
  - "how does the rolling-refill dial loop work, and what keeps two legs from both winning"
  - "what happened to the Redis-based engine / dialer_sessions / call_logs"
  - "why did a dial session stall, or stay in wrap_up, or a webhook replay break it"
  - "how do I test the dial engine without a real Telnyx account"
covers: "The org-scoped dial engine (TASK-P2-E2): rolling-refill queueing over campaign_leads, single-winner claim resolution, AMD triage, conference bridging, wrap_up, and the webhook that drives it."
excludes: "Telnyx API wrappers, number purchase/search and WebRTC credentials (domain.telephony); campaign and lead list construction (domain.campaigns); the agent's own WebRTC leg (E3, not built yet); dispositions (Phase 3, not built yet)."
tokens_est: 5856
source_hash: 30b4f8a2b005496e438e762a20c2579966e1779eeea3b4ad44ec1d24f5754809
---

# Parallel Dialer

## Purpose

Lets one agent work a campaign list far faster by ringing several contacts at once and
connecting the agent only to the first real human who picks up; voicemail, silence and
no-answer are hung up and recorded silently. A "session" is one agent × one campaign × one run,
scoped to an org.

**This document describes the current, org-scoped engine (TASK-P2-E2), which replaced the
legacy Redis-based engine for the dial path entirely.** The legacy `dialer_sessions`/`call_logs`
tables and their engine code are still in the repo, untouched, but nothing in this lane writes to
them anymore — see "Not covered here" for what's actually dead versus still real.

## Key concepts

| Term | Means |
|---|---|
| `dial_sessions` row | One session: `org_id`, `campaign_id`, `agent_id`, `state`, `lines`, `amd_mode`, `agent_leg_id`, `active_leg_id`, `conference_id`. States: `ready_pending → ready → dialing → connecting → on_call → wrap_up`, plus `paused`/`paused_agent_lost`/`stopped`/`completed`. |
| `call_legs` row | One phone call (a "leg"): `kind` (`contact`/`agent`), `state` (`initiated → ringing → answered → amd_pending → claimed/dropped/abandoned/machine → ended`), `outcome` (`no_answer`/`busy`/`machine`/`dropped`/`abandoned`/`failed`/`connected`). |
| Rolling refill | Not fixed "batches" like the legacy engine — the session keeps exactly `lines` active legs going at all times, refilling one at a time as legs end. Driven by `claim_next_leads` + `refillCount` (design §4.1's safety invariant: only refills while the session is `dialing` AND the agent leg reads `answered`). `refillSession`'s own fast-path capacity hint counts only `kind='contact'` active legs (TASK-L1 review fix) — counting the agent leg too made the hint compute exactly 0 the instant it answered whenever `lines===1`, silently skipping refill forever; `claim_next_leads`' own RPC-level capacity check was always correctly scoped, only the TS-side hint wasn't. |
| Single-winner claim | `claim_leg(session, leg)` — one atomic conditional UPDATE (`active_leg_id is null → set it`). Exactly one caller ever gets `true`, no matter how many legs answer at once. Replaces the legacy engine's Redis `SET NX` lock; see `mem.decisions`. |
| `client_state` | Base64 `{org, session, leg}` (`_shared/client-state.ts`), round-tripped through every Telnyx call. `telnyx-webhook` hard-rejects any `call.*` event whose client_state doesn't decode and name the request's own `org`. |
| AMD modes | `off` (every `call.answered` claims immediately) or `on` (holds at `amd_pending` until the leg's own `call.machine.(premium.)detection.ended` resolves it — claim on human, reject to `machine` otherwise). |
| Agent leg | `kind='agent'` `call_legs` row, one per session (TASK-L1), linked to `dial_sessions.agent_leg_id` at INSERT time (before dialing, TASK-L1 review fix M1 -- not after). Dialed via the member's own WebRTC on-demand credential's SIP URI (`sip:<sip_username>@sip.telnyx.com`), get-or-created server-side (`_shared/agent-webrtc-credential.ts`, shared with `telnyx-webrtc-credentials/index.ts` — doesn't require the browser to have connected first) with `client_state{kind:'agent'}` + a `custom_headers` session marker. Its own `call.answered` confirms a real conference (creating one, or falling back to a fresh one if joining the existing id fails — Telnyx conferences expire once empty) before cascading `ready_pending`/`paused_agent_lost` → `ready` → `on_call` (a contact is still `claimed`), `wrap_up` (an undispositioned connected leg exists — can happen even after the loss, review fix M4), a remembered `paused` (`dial_sessions.paused_agent_lost_from`), or `dialing` (+ an immediate refill). Every event is checked against `leg.id === session.agent_leg_id` (review fix M2) — a stale/superseded leg's own webhook is ignored. The `DIALER_DEV_SKIP_AGENT_GATE` dev flag this row used to replace no longer exists anywhere in the codebase. |

## Where the code lives

| What | Path | Notes |
|---|---|---|
| Pure decision logic | `supabase/functions/_shared/dialer-core.ts` | No I/O. `legTransition`/`amdDecision`/`hangupOutcome`/`refillCount`/`loserActions`/`leadOutcomeUpdate`. Deno-tested. |
| Engine (orchestration) | `supabase/functions/_shared/dialer-engine.ts` | Calls the RPCs below + the org's own `TelnyxClient`. Read its header comment first — it documents every non-obvious design decision. |
| `client_state` codec | `supabase/functions/_shared/client-state.ts` | `encodeDialClientState`/`decodeDialClientState`. |
| Telnyx REST (BYO key) | `supabase/functions/_shared/telnyx-client.ts`, `_shared/telnyx-org-context.ts` | `createTelnyxClient(apiKey, {apiBase?})`; `getConnectedOrgTelnyxContext` builds one from the org's own stored key. `apiBase` exists only for `scripts/dev/dialer-sim.ts`'s mock server. |
| Schema + RPCs | `supabase/migrations/20260924000700/000800/001000/001900`, `20260925005000/005100/005200` | `dial_sessions`, `call_legs`, `webhook_events`; `claim_next_leads`/`claim_leg`/`transition_leg`/`transition_session`/`apply_leg_outcome`/`record_webhook_event`. `005100` adds `dial_sessions.paused_agent_lost_from`; `005200` (fix-forward) adds it to `transition_session`'s own writable-field allowlist -- the column existing and the RPC actually persisting it were two separate migrations, see `mem.known-issues` #19. |
| Session control | `supabase/functions/dialer-session-{start,stop,pause,resume,reconnect,get,active,hangup-live,disposition}/index.ts` | Org-scoped auth via `requireTelnyxOrgRole`; owner/admin can act on any session in the org, an agent only their own. `-reconnect` (TASK-L1) re-dials the agent leg from `paused_agent_lost`. `-resume` (TASK-L2b) is the counterpart to `-pause` -- resumes a manually `paused` session (there was no way back before this task). |
| Webhook ingress | `supabase/functions/telnyx-webhook/index.ts` | Signature-verifies, requires `client_state` on `call.*` events, acks 200, processes async via `processTelnyxDialerEvent`. |
| Client | `apps/web/src/hooks/useDialerSession.ts`, `apps/web/src/lib/useTelnyxCall.ts`, `apps/web/src/lib/useSingleTabLock.ts`, `apps/web/src/lib/api.ts` | Polls `dialer-session-get` (no realtime push — see gotchas). `useTelnyxCall`'s optional `sessionId` (TASK-L1) makes it auto-answer the agent leg's own inbound call for that session and reject every other inbound call. `useSingleTabLock` (TASK-L1r4 round 5) elects exactly one "owner" browser tab (BroadcastChannel + a localStorage heartbeat) -- required once the Dialer is permanently mounted (below), since every open tab would otherwise register its own WebRTC client for the same agent; a non-owner tab renders a blocking "open in another tab" message instead of the Dialer. `Dialer.tsx` (TASK-L1r4 round 6) is split into a thin outer component that calls only `useSingleTabLock` and a `DialerBody` inner component holding every other hook (`useDialerSession`'s poll, the connect-chime effect, etc.) -- a non-owner tab never mounts `DialerBody`, so none of its hooks run at all, not just "render different JSX" (`mem.known-issues` #24). |
| UI | `apps/web/src/components/Dialer.tsx`, `apps/web/src/components/dialer/*.tsx`, `CampaignManageModal.tsx` | TASK-L2b: `DialerStateBanner.tsx` (renamed/broadened from TASK-L1's `AgentConnectionStatus.tsx`) is the single "big visible state" (UI-7) keyed on `dial_sessions.state`; `WrapUpModal` (TASK-L2a) is wired in on `wrap_up`, no bypass; `ParallelDialerUI`/`LiveCallPanel` show real `lines`/`amd_mode` and a real answered_at-derived timer (not a local reset-on-mount counter). TASK-L7: `Dialer.tsx` is now the ONLY place that ever registers a `TelnyxRTC` client or calls `startDialerSession` -- `StartSessionPanel.tsx` lists the signed-in member's assigned campaigns (owner/admin see all) with a Start button per campaign, for every role. `CampaignManageModal.tsx`'s Start button no longer starts anything itself; it hands off which campaign via `lib/dialerLaunchIntent.ts` (a same-tab, in-memory intent -- not a prop through `MainApp.tsx`, eng1's file) and navigates to the Dialer. This was also the fix for the L1×L5 blocker (`mem.known-issues` #20): a second, unsynchronized WebRTC client used to race the server's own synchronous agent-leg dial. **TASK-L1r4**: `MainApp.tsx` keeps `Dialer` permanently mounted (CSS `display:none` when another tab is active) instead of conditionally rendering it, so the one `TelnyxRTC` client this task established survives every tab switch -- it used to unmount (and `disconnect()`) whenever the intern left the Dialer tab mid-call, dropping the agent's own leg while the customer stayed connected (`mem.known-issues` #21). |
| Acceptance | `supabase/functions/_shared/dialer-engine.test.ts` | `deno test`, in-memory fake Supabase client + the real `createTelnyxClient` with `fetch` stubbed — no DB, no Docker. `scripts/dev/dialer-sim.ts` (the old `functions serve` + real local Postgres script) is now UNRUNNABLE — local Docker is retired (RULES-CARD) — and is left as dead code, not deleted. |

## How it works

1. `dialer-session-start` resolves the org's connected `TelnyxClient`, validates the campaign
   (`active`, not `deleted_at`, has a `caller_id_number_id`), checks no active session already
   exists for this AGENT (TASK-L1/SEC-8: globally, not per-campaign — one SIP endpoint per
   agent, backed by a live partial unique index), inserts a `dial_sessions` row
   (`state='ready_pending'`, the schema's own default), then dials the agent's own WebRTC
   credential SIP URI ("Go Ready" — `dialAgentLeg`). Dialing contacts does NOT start here
   anymore; it waits for the agent leg's own `call.answered` (see step 1b).
1b. The agent leg's `call.answered` (`processAgentLegEvent`/`handleAgentLegAnswered`) creates the
   session's conference around it (first time) or joins it (Reconnect), then cascades
   `ready_pending`/`paused_agent_lost` → `ready` → `on_call` (a contact leg is still `claimed` —
   rejoining a live call after Reconnect) or `dialing` + an immediate `refillSession` (the normal
   case). The agent leg's own `call.hangup` (`handleAgentLegLost`) moves the session to
   `paused_agent_lost` and hangs up every active CONTACT leg that is NOT `claimed` — a live,
   bridged contact is never hung up for an agent-leg problem. `dialer-session-reconnect` /
   `reconnectAgentLeg` (Reconnect button) is the only way back from `paused_agent_lost`: it dials
   a FRESH agent leg into the SAME conference.
2. `refillSession`: `refillCount` is a fast-path hint only (zero unless `state='dialing'` AND the
   agent leg reads `answered` — real code now, no dev-flag bypass exists) — the real capacity
   decision now lives
   entirely inside `claim_next_leads(session)` (fix-forward, migration `20260924001900`): under
   a `dial_sessions` row lock held for the whole call, it computes `lines - active contact legs`
   itself and, in the SAME statement, inserts each claimed lead's `call_legs` row with a
   placeholder `call_control_id` (`pending-<random uuid>` — NOT the lead id, see gotchas) before
   returning. Two concurrent refills for the same session now serialize on that lock instead of
   each reading a stale count and together dialing past `lines` (verified live with two real
   overlapping psql connections, `supabase/tests/run-dialer-concurrency-test.sh` scenario 2).
   `refillSession` then only dials each returned leg (`client.dial(...)` with
   `client_state={org,session,leg}`) and overwrites the placeholder with the real id — it no
   longer inserts into `call_legs` itself.
3. Telnyx posts to `telnyx-webhook`. The outer handler verifies the signature, resolves `orgId`
   from `?org=`, accepts-and-ignores (200, logged) a `call.*` event with no decodable or
   org-matching `client_state` (fix-forward item 4 — the signature already authenticates the
   org; a mismatch just means the event isn't one this engine tracks, e.g. an inbound call or
   the agent's own future WebRTC leg — a 401 there only makes Telnyx retry into nothing), acks
   200, then dispatches into `processTelnyxDialerEvent` via `EdgeRuntime.waitUntil` (fix-forward
   item 3 — the Edge Runtime can recycle the isolate right after the response ships, killing a
   bare `queueMicrotask`; falls back to awaiting before responding when `EdgeRuntime` is
   undefined, e.g. under a test harness) → `record_webhook_event` dedupe → maps the raw event to
   `dialer-core.ts`'s typed union → looks up the leg → `processContactLegEvent`.
4. **Claim resolution**, when the event could resolve one (`call.answered` in AMD-off mode, or a
   detection-ended event in AMD-on mode): `claim_leg` runs first. **`claim_leg`'s own SQL already
   sets the winning leg's `call_legs.state='claimed'`** as part of the atomic win — the engine only
   patches in `outcome='connected'` afterward, it does not run the leg through the generic
   `legTransition`+`transition_leg` path for the win (a real bug this session's own acceptance
   script caught: that generic path always lost the race against `claim_leg`'s own write).
5. **`handleWin`** (right after a win): creates the conference (first winner ever) or joins it
   (later winners), then resolves every *other* active leg in the session from a snapshot — still-
   ringing legs go straight to `dropped` (silent hangup); already-answered/amd_pending legs go to
   `abandoned` (speak the abandon message, then hang up once `call.speak.ended` confirms it played
   — sending the message a SECOND time on that confirmation event was a real bug, fix-forward
   item 6: the dispatch gates on `result.next === 'abandoned' && result.outcome === 'abandoned'`
   together, not `next` alone, since the confirmation no-op also has `next: 'abandoned'` but no
   `outcome`, and a later `call.hangup` on an already-abandoned leg has `outcome: 'abandoned'`
   too but `next: 'ended'` — either half of that pair alone reopens one of the two bugs).
   A losing leg's *own* `call.answered`/detection-ended event can independently reach the same
   `abandoned` conclusion if it arrives before `handleWin` gets to it — both paths guard their
   `transition_leg` call with the leg's expected pre-resolution state, so whichever gets there
   first wins and the other is a safe no-op.
6. **On any leg reaching `ended`** (natural `call.hangup`, or one the engine commanded): `transition_leg`
   persists the outcome (`hangupOutcome` — a `machine`/`dropped`/`abandoned`/`claimed` state short-
   circuits to preserve that decision regardless of `hangup_cause`; otherwise the cause maps to
   `busy`/`no_answer`/`failed`), then `apply_leg_outcome` (E1's RPC — the single source of truth for
   the lead's `status`/`attempts`/`next_attempt_at`; never recomputed in TS for a live write). If
   the ended leg was the session's own winner, the session moves to `wrap_up` (no more refill);
   otherwise, if still `dialing`, `refillSession` runs again. **If `transition_leg` loses a race**
   (its expected-state check fails, e.g. a concurrent claim/AMD decision moved the leg first),
   `applyLegTransition` reloads the leg's now-current row and retries the decision against it
   (bounded, 3 attempts) instead of dropping the event — fix-forward item 2: dropping a race-lost
   TERMINAL event (most notably the leg's own `call.hangup`) used to leave it stuck non-terminal
   forever. Exercised live with two genuinely concurrent (not sequentially-awaited) HTTP requests
   in `dialer-sim.ts`'s step 7.
7. **`wrap_up` → `dialing`** has no dedicated HTTP endpoint for THAT transition specifically --
   `submit_disposition` (SQL, TASK-P3-E1) does it directly as part of the same call that writes
   the disposition, then `dialer-session-disposition/index.ts` calls `refillSession`.
   `resumeToDialing` (`_shared/dialer-engine.ts`) is the shared primitive both that path and
   `paused` → `dialing` use -- TASK-L2b added `dialer-session-resume/index.ts` as the first (and
   only) dedicated HTTP endpoint for the OTHER case `resumeToDialing` always accepted
   (`paused` → `dialing`, the Resume button): there was previously no way back from a manually
   `paused` session at all.

## Integration points

| Direction | With | Via |
|---|---|---|
| Depends on | domain.telephony | `_shared/telnyx-client.ts`/`telnyx-org-context.ts` — every Telnyx call uses the org's own BYO key, never an env var |
| Depends on | domain.campaigns | `claim_next_leads` reads `campaign_leads` ⋈ `contacts`; `campaigns.lines`/`amd_mode`/`caller_id_number_id`/`abandon_message_enabled`/`calling_window_*` (TASK-P2-P1) |
| Depended on by | Web UI | `dialer-session-get`, polled — see gotchas for why not realtime |
| Supersedes | Upstash Redis (dial path only) | `mem.decisions`: the single-winner claim is now `claim_leg`'s conditional UPDATE, not `SET NX` |

## Constraints & gotchas

- **A placeholder `call_control_id` must be keyed on something unique per ATTEMPT, not per
  lead.** `claim_next_leads` used to key it on the lead id — a lead id is reused every time that
  same lead is claimed again after a failed dial (the error path ends the leg but never
  overwrites its placeholder), so the second attempt's insert collided with the first attempt's
  still-there dead row and raised a unique violation, aborting the WHOLE claim for the session,
  not just that one lead. Caught in review before this ever ran live (fix-forward item 1); now
  a fresh random uuid per attempt. Covered by a dedicated SQL test (failed dial → same lead
  reclaimed → succeeds).
- **Several legs from one `claim_next_leads` call can share the exact same `created_at`.** It's
  one INSERT statement now (fix-forward item 1), and `now()` is stable within a statement.
  `dialer-session-get`'s leg list orders by `created_at, id` for a deterministic (not
  necessarily priority-matching) display order — this is display-only, nothing reads
  `call_legs.created_at` for actual logic.
- **`handleWin`'s loser-resolution loop predates the agent leg and is kind-agnostic by
  default.** `loadActiveLegs` returns every active leg regardless of `kind`, and `loserActions`
  (dialer-core.ts) has no concept of `kind` at all — without an explicit `.filter(l => l.kind
  === 'contact')` before computing losers, the agent's own still-`answered` leg gets treated as
  a losing contact and gets spoken to / hung up the instant any contact wins. A real bug, caught
  by `dialer-engine.test.ts`'s first run (TASK-L1) before it ever shipped — any FUTURE change to
  `loadActiveLegs`'s call sites needs the same filter if it doesn't want the agent leg mixed in.
- **No realtime push.** The legacy engine's `_shared/dialer-events.ts`/`publishDialerEvent`
  broadcast (`dialer:user:{userId}`) has nothing publishing to it anymore — the new engine never
  calls it. `useDialerSession.ts` polls `dialer-session-get` every 3s instead while the session is
  active. A future task can add a real realtime channel if push updates turn out to matter enough
  to build.
- **`hungUpByEngine` (needed by `hangupOutcome`) has no DB column.** Derived at hangup-processing
  time instead: true iff the session's `active_leg_id` already names a *different* leg (someone
  else already won, so this leg's hangup was necessarily commanded), or the session is already
  past `dialing`/`connecting`. See `_shared/dialer-engine.ts`'s header for why this covers every
  real case without needing to persist the flag.
- **Judgment calls on the outcome table (design §4.2), logged so nobody re-derives them
  differently:** `call_rejected` exhausts the lead permanently (a callee decline counts as a
  real, final "no"). `dropped` never increments `attempts` (the lead was only rung because of our
  own parallelism, not a real attempt reaching them) — it can requeue indefinitely, every 15
  minutes, which is intentional.
- **Testing against a mock Telnyx server needs `host.docker.internal`, not `127.0.0.1`.**
  `supabase functions serve` runs the edge runtime inside its own Docker container — found live
  while building `scripts/dev/dialer-sim.ts`: pointing `TELNYX_API_BASE` at `127.0.0.1` resolved
  to the container's own loopback and every dial failed with a connection-refused error.
- **The calling-window check can make a test's outcome depend on the real wall-clock hour.**
  `private.is_lead_callable_now` falls back to requiring the window to hold in *both*
  America/New_York and America/Los_Angeles for a contact with no `timezone` set — a fixture
  seeded with a narrow default `calling_window_start`/`end` can silently claim zero leads
  depending on what time it is when the test happens to run. `dialer-sim.ts` opens the window all
  day in its fixture campaign for exactly this reason.
- **Legacy `dialer_sessions`/`call_logs` and their Redis-driven engine still exist, untouched,
  and are dead code for the dial path** — kept per the design's own "don't drop them, just stop
  writing to them from new code" instruction. Every constraint the *previous* version of this
  document described (the Redis TTL limits, the per-session human-lock bug, the missing
  `no_answer` writes, etc.) applied to that engine, which no longer runs any real call. Don't debug
  a live session against those old notes.
- RLS on `dial_sessions`/`call_legs` grants **SELECT only** (owner/admin see the whole org, an
  agent only their own session/legs); every write goes through the SECURITY DEFINER RPCs or the
  service-role client, matching the migration's own "no client INSERT/UPDATE/DELETE policy
  anywhere" design.

## dialer-sweeper (TASK-P2-E5): the safety net for a lost webhook

- `public.run_dialer_sweep(p_stuck_after_seconds default 60, p_claimed_check_after_seconds
  default 300)` (SQL RPC, `20260924001700_dialer_sweeper_cron.sql` +
  `20260925010000_dialer_sweeper_claimed_legs.sql`, TASK-L6), called every 30s by
  `pg_cron`/`pg_net` (`private.trigger_dialer_sweeper`, configured via
  `private.set_dialer_sweeper_config(url, secret)` -- same Vault-backed global config shape as
  `ghl-sync-worker`'s cron, a no-op until configured) and directly by the `dialer-sweeper` Edge
  Function (shared-secret `X-Cron-Secret` header, service role, not a user JWT -- the caller is
  Postgres itself).
- Reconciles several things a lost webhook can strand forever, all built on the engine's OWN
  idempotent primitives (`transition_leg`/`transition_session`'s expected-state no-op,
  `apply_leg_outcome`'s `outcome_applied_at` gate) rather than a new locking scheme -- a leg or
  session a REAL webhook resolves in the tiny window between the sweep's own SELECT and its
  transition call simply loses that race safely, exactly like any other caller of these RPCs:
  1. A pre-connect/hangup-pending contact leg (anything non-terminal except `claimed`) with no
     `webhook_events` row (or none ever, falling back to `created_at`) for over the threshold --
     ended as `failed`/`no_answer`, then `apply_leg_outcome`.
  2. A session whose agent leg independently reached `ended` -- `paused_agent_lost`. States list
     now matches `AGENT_ACTIVE_SESSION_STATES` (dialer-engine.ts) exactly -- `ready_pending`/
     `ready`/`dialing`/`connecting`/`on_call`/`wrap_up`/`paused` (TASK-L6 fix; previously missed
     the first, second and last of those, known-issues #14's own follow-up).
  3. In_flight leads a leg can no longer speak for: an ended leg with a decided outcome that
     never got applied (TASK-P2-E2's own carried item 5 -- `record_webhook_event` commits its
     dedupe row before processing runs, so a webhook whose processing throws after that commit
     is lost outright), and a lead whose latest leg ended with no outcome at all or has no leg
     row -- requeued directly at attempts **+0** (bookkeeping catching up, not a real attempt).
     A `connected` outcome is excluded by construction (never null), so a completed call's lead
     correctly stays `in_flight` until Phase 3's disposition submission, not requeued out from
     under it.
  4. **TASK-L6 (known-issues #11):** a `claimed` (bridged) contact leg whose own `call.hangup`
     webhook was lost -- previously a deliberate, permanent gap (a real live call is silent on
     the webhook stream for its whole duration by design, so webhook silence alone can't tell
     it apart from a lost hangup webhook). Closed with a real signal instead of a longer
     silence window: `run_dialer_sweep` only SELECTs candidates (`claimed_at` older than
     `p_claimed_check_after_seconds`, returned as `stale_claimed_legs`) -- the actual decision
     is TS-side (`_shared/dialer-sweeper-core.ts`'s `reconcileStaleClaimedLeg`, called from
     `dialer-sweeper/index.ts`): past `CONTACT_DIAL_TIME_LIMIT_SECS` (1800, exported from
     `dialer-engine.ts`) + a 5-minute grace -> reap unconditionally (Telnyx guarantees the call
     ended by then, BUG-8); otherwise ask Telnyx directly (`_shared/telnyx-client.ts`'s
     `getCallStatus`, `GET /calls/{id}`, `is_alive`) and only reap on a DEFINITIVE not-alive/404
     -- an API error or a genuinely live call is left alone. Either path reaps through the same
     new `reap_dead_claimed_leg` SQL primitive, which replicates the normal `call.hangup`
     outcome path exactly (`transition_leg` -> ended, `apply_leg_outcome`, and -- only if this
     leg was the session's `active_leg_id` -- `transition_session` -> `wrap_up`).

## Not covered here

- Telnyx numbers, WebRTC credentials, raw API wrappers → `.brain/domains/telephony.md`; campaigns
  and lead lists → `.brain/domains/campaigns.md`; cross-service flow and deployment →
  `.brain/architecture/system-overview.md`.
- The agent's own WebRTC leg and joining it to the conference (E3), the dialer UI's own redesign
  around the new `legs`-array contract (E4), and dispositions submitting a session out of
  `wrap_up` for real (Phase 3) are all explicitly out of scope for the engine described here and
  not yet built.

## Unverified

- Telnyx's webhook retry policy is portal config, not in this repo; at-least-once delivery is a
  safe assumption (and `record_webhook_event`'s dedupe assumes it), not a confirmed observation.
- `apps/web/src/components/dialer/ContactQueue.tsx`'s status (dead code or not) was not
  re-checked for this rewrite — see the previous version of this document's note; nothing new
  contradicts it.
- The three-way manual-sync duplication of any shared vocabulary between `dialer-core.ts`'s
  TS unions and the `call_legs`/`dial_sessions` CHECK constraints (both hand-copied from the same
  design table, not generated from one source) is a real, ongoing drift risk on any future
  addition to either — not new information, just still true.

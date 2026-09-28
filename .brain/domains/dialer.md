---
id: domain.dialer
title: Parallel Dialer
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-27
sources:
  - supabase/functions/_shared/dialer-core.ts
  - supabase/functions/_shared/dialer-engine.ts
  - supabase/functions/_shared/client-state.ts
  - supabase/functions/_shared/coaching-core.ts
  - supabase/functions/_shared/transfer-core.ts
  - supabase/functions/dialer-session-*/**
  - supabase/functions/dialer-coaching/**
  - supabase/functions/dialer-transfer/**
  - supabase/functions/dialer-sweeper/**
  - supabase/functions/reliability-alert-check/**
  - supabase/functions/telnyx-webhook/**
  - supabase/migrations/20260926070000_live_coaching.sql
  - supabase/migrations/20260926070003_lead_assignment_control.sql
  - supabase/migrations/20260926070005_high_lines_drop_guard.sql
  - supabase/migrations/20260926080400_reliability_alerts.sql
  - supabase/migrations/20260927151747_supervisor_controls.sql
  - supabase/migrations/20260927171444_supervisor_alerts_and_pod_scoping.sql
  - supabase/functions/_shared/pod-scope.ts
  - apps/web/src/hooks/useDialerSession.ts
  - apps/web/src/lib/api.ts
  - apps/web/src/components/dialer/**
  - supabase/migrations/20260924000700_dialer_schema.sql
  - supabase/migrations/20260924000800_dialer_rpcs.sql
  - supabase/migrations/20260924001000_dialer_rpc_fixes.sql
  - supabase/migrations/20260924001900_dialer_engine_fix_forward.sql
  - supabase/migrations/20260925020000_call_legs_duration_conversations.sql
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
tokens_est: 8250
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
| UI | `apps/web/src/components/Dialer.tsx`, `apps/web/src/components/dialer/*.tsx`, `CampaignManageModal.tsx` | TASK-L2b: `DialerStateBanner.tsx` (renamed/broadened from TASK-L1's `AgentConnectionStatus.tsx`) is the single "big visible state" (UI-7) keyed on `dial_sessions.state`; `WrapUpModal` (TASK-L2a) is wired in on `wrap_up`, no bypass; `ParallelDialerUI`/`LiveCallPanel` show real `lines`/`amd_mode` and a real answered_at-derived timer (not a local reset-on-mount counter). TASK-L7: `Dialer.tsx` is now the ONLY place that ever registers a `TelnyxRTC` client or calls `startDialerSession` -- `StartSessionPanel.tsx` lists the signed-in member's assigned campaigns (owner/admin see all) with a Start button per campaign, for every role. `CampaignManageModal.tsx`'s Start button no longer starts anything itself; it hands off which campaign via `lib/dialerLaunchIntent.ts` (a same-tab, in-memory intent -- not a prop through `MainApp.tsx`, eng1's file) and navigates to the Dialer. This was also the fix for the L1×L5 blocker (`mem.known-issues` #20): a second, unsynchronized WebRTC client used to race the server's own synchronous agent-leg dial. **TASK-L1r4**: `MainApp.tsx` keeps `Dialer` permanently mounted (CSS `display:none` when another tab is active) instead of conditionally rendering it, so the one `TelnyxRTC` client this task established survives every tab switch -- it used to unmount (and `disconnect()`) whenever the intern left the Dialer tab mid-call, dropping the agent's own leg while the customer stayed connected (`mem.known-issues` #21). **MISSION-4 TASK-T5b**: the connected-call card (`ParallelDialerUI.tsx`, below `LiveCallPanel`) gained three panels, all sourced from `dialer-session-get`'s own widened response (one batched query each, same 3s-poll "pre-loaded, not per-card" shape CRD-1's contact join already used) -- business details (rating/review count/owner-contact/license #/service ZIPs/tier/website, `license_number`/`service_zips`/`tier` read out of `contacts.ghl_custom_fields`, every field individually omitted when null), a "Previous attempts" strip (up to 3 past `call_legs` for that contact, most-recent-first, on-click recording playback mirroring `WrapUpModal`'s own `DispositionHistory`), and a collapsible "Call script & objections" (the campaign's own `script_text`/`objection_sheet_text`, T5a). **MISSION-4 TASK-T7 (hotkeys slice only -- auto-resume and INB-7 click-to-call are separate, unstarted pieces of the same task)**: a global `keydown` listener in `Dialer.tsx`, gated on `isParallelMode` and `isTypingTarget` (`apps/web/src/lib/keyboard.ts`, a deliberate fresh copy of `WrapUpModal.tsx`'s own private helper, not a refactor) -- `M` toggles mute (gated `on_call`), `H` toggles hold (gated `on_call`, and NOT while parked in a warm-connected transfer's side conference, mirroring `LiveCallPanel`'s own UI gate for that state), `Space` resumes dialing while `paused` (Resume-only for now -- auto-resume's own countdown doesn't exist yet), `?` toggles `HotkeyHelpOverlay.tsx` (same portal/focus-trap shape as `StopConfirmDialog`, plus its own Escape handler). `muted` was lifted out of `LiveCallPanel`'s own local state into a required prop so this listener and the Mute button share one source of truth. Deliberately does NOT close `TransferModal`/`StopConfirmDialog` on Escape (scope cut, see the task's own commit message) -- a hotkey could still fire while a modal is open if focus isn't on one of that modal's own inputs, a known, deliberate gap. |
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
   (later winners) and, TASK-M1, stamps `call_legs.bridged_at` right after that actually succeeds
   (never on a thrown error) — the moment the winner's audio is genuinely live in the agent's
   conference, and the start of its "talk duration" for analytics (`.brain/domains/analytics.md`).
   Then resolves every *other* active leg in the session from a snapshot — still-
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
   `busy`/`no_answer`/`failed`). TASK-M1: exactly when that outcome comes out `connected`,
   `applyLegTransition` also computes `duration_seconds` as `ended_at - (bridged_at ?? answered_at
   ?? claimed_at)` — the winning contact leg's OWN `call.answered` never sets `answered_at` (it's
   handled by the claim-win branch directly, not this generic path), so `claimed_at` is the real
   second fallback, not just a defensive one. Every other outcome (dropped/abandoned/machine/busy/
   no_answer/failed) never gets a `duration_seconds` at all. Then `apply_leg_outcome` (E1's RPC — the single source of truth for
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

## Queue v2 (TASK-F-T1): retry rules, time blocks, loser requeue

Migration `20260925030000_queue_v2_retry_dnc.sql`. `claim_next_leads`/`apply_leg_outcome`/
`submit_disposition` are all `create or replace`d in place (same signatures as their prior
fix-forward versions) rather than a fresh migration adding new RPCs, since the retry/requeue
logic has to live inside the exact same atomic writes those functions already do.

- **`campaign_retry_rules`** (a real table, not a jsonb column — see `mem.decisions`): one row
  per `(campaign_id, disposition_key)`, seeded on campaign creation (a trigger, mirroring
  `private.seed_default_dispositions`'s own shape) with `action` one of `retry`/`out`/
  `exact_time`. Both `apply_leg_outcome` (keyed on the raw engine outcome string, e.g.
  `no_answer`) and `submit_disposition`'s `'queued'` lead_effect branch (keyed on the
  disposition's own `key`) look up this table before falling back to the campaign's flat
  `retry_interval_minutes` — a lookup miss (any outcome/disposition with no seeded row) is a
  silent no-op, so nothing about the pre-existing flat-interval behavior changed for those. In
  both functions, `max_attempts` is checked and can force `exhausted` BEFORE a `'retry'` rule is
  ever consulted — a rule can never override the hard attempt ceiling.
- **Time blocks (QUE-5)**: `call_legs.time_block` is stamped by `claim_next_leads` at dial time
  (`private.time_block_for(now(), contact.timezone)` — the same five-slot cascade as
  `private.safe_timezone`'s own tz-fallback-to-America/Chicago convention). A rotating retry
  (`rotate_block=true`) computes its next slot via `private.rotated_retry_schedule`, which always
  lands in the block immediately AFTER the leg's last one in the fixed cycle morning → lunch →
  afternoon → drive → evening → morning, at that block's start hour, `delay_minutes/1440` (floored
  to at least 1) days out. `supabase/functions/_shared/queue-retry-rules.ts` is a deno-tested TS
  twin of both SQL helpers — it exists purely because the algorithm needed to be unit-testable
  (local Docker is retired); it is never imported or called by any runtime code. Keep both in
  sync by hand if the block boundaries or rotation order ever change.
- **QUE-3 (max attempts → nurture tag)**: `private.enqueue_nurture_tag_if_exhausted` is the one
  place every write site that can set `campaign_leads.status='exhausted'` calls into
  (`apply_leg_outcome`'s failed/max-attempts/rule-out branches, `submit_disposition`'s
  `'exhausted'` lead_effect, and its `'queued'`-branch max-attempts path) — it re-reads the
  lead's own just-written status and, if `'exhausted'`, enqueues a `crm_sync_jobs` row of the new
  `kind='nurture_tag'`. `ghl-sync-worker/index.ts`'s `processJob` dispatches that kind to
  `processNurtureTagJob` (`_shared/ghl-sync-worker.ts`), which mirrors `processDispositionJob`'s
  own upsert step exactly, then tags the GHL contact `nurture` (a hardcoded string, deliberately
  not configurable yet — "keep it minimal" per the task's own words; F-P2 is expected to make it
  editable).
- **BUG-3/QUE-4 (loser requeue)**: `apply_leg_outcome`'s `dropped`/`abandoned` branch (legs that
  lost the claim race to another leg in the same batch, or were abandoned after `handleWin`) now
  sets `next_attempt_at = now()` (was `+15 minutes`) and a new `campaign_leads.priority_requeue`
  boolean to true — consulted by `claim_next_leads`' own `ORDER BY` as a tier right after
  `is_priority_callback desc` and before `attempts asc`, so a requeued loser is picked ahead of a
  same-attempts fresh lead rather than merely tying with it on `next_attempt_at`. Attempts are
  NOT incremented for either outcome (the live version before this task only excluded `dropped`
  — `abandoned` fell into the generic +1 branch and was incremented exactly like a real
  no-answer; this was the actual bug, not just a QUE-4 feature gap). `priority_requeue` is reset
  to false the moment `claim_next_leads` claims the row again.
- **QUE-7 (org-wide DNC)**: `claim_next_leads`' `picked` CTE excludes a contact whose E.164 is in
  `dnc_numbers` for the org, in addition to (never merged with) the existing `not ct.dnc` check —
  see `.brain/domains/contacts.md` for why the two signals are deliberately independent.

## Dispositions v2 (TASK-F-P1): canonical 9-key set, required fields, wins, history

Migration `20260925060000_dispositions_v2.sql`. `submit_disposition`'s signature changed (two new
trailing params), so the old 6-arg overload is explicitly `drop function`-ed first — see
`mem.decisions` for why key renaming for EXISTING orgs is add-only, never an in-place rename.

- **Canonical keys**: `yes_build_profile`/`callback`/`not_interested`/`already_on_platform`/
  `wrong_number`/`gatekeeper`/`do_not_call`/`voicemail_left`/`no_answer` — `private
  .seed_default_dispositions`/`private.seed_default_campaign_retry_rules` both seed this set now
  (org-creation / campaign-creation triggers, same shape as before). `gatekeeper` is `queued`
  (retry, same rotate-block cadence as `no_answer`/`voicemail_left`); `already_on_platform` is
  `exhausted` (no retry) — both eng1 judgment calls, see `mem.decisions`.
- **`dispositions.required_fields text[]`** (DSP-4): a generic "these extra fields must be filled
  before this disposition can be submitted" list. Only two field names are actually wired up:
  `license_number`, `zips` (both text on `call_legs`, `zips` a `text[]`). Enforced in
  `submit_disposition` itself (raises if missing) AND client-side in `WrapUpModal` (the `canSubmit`
  gate) — same "server is authoritative, client just improves UX" split as the pre-existing
  `callback_at` requirement. `yes_build_profile` is seeded with both required; nothing else is.
  On a successful submit, both are written to the leg AND merged (via `||`, never overwriting
  other keys) into `contacts.custom_fields jsonb` — a new column, `'{}'::jsonb` default.
- **`dispositions.is_win boolean`** (Wins): true only for the seeded `yes_build_profile` by
  default, org-editable at creation time (Settings' create form; not editable after, same
  "immutable after creation" precedent as `key`/`lead_effect`). `call_leg_analytics` (the
  Dashboard/Analytics view) gained a trailing `is_win` column (`coalesce(d.is_win, false)`);
  `dashboard-stats/index.ts` sums it into `winsToday`, the Dashboard's 5th StatCard.
- **`contact_disposition_history(p_contact_id)`** (DSP-9): a SECURITY DEFINER function, callable
  directly by any authenticated org member (not service-role-only) — see `mem.decisions` for why
  it deliberately bypasses `call_legs`' own per-session agent RLS. Returns the last 3 dispositions
  for a contact across every agent, each with `agent_name`/`disposition_label`/`notes`/
  `has_recording`. `WrapUpModal` renders it above the disposition picker; a "Play recording"
  button calls `getRecordingUrl` (REC-5's function) on click, not on mount.
- **`submit_disposition`'s GHL payload gains `is_dnc` (derived from `lead_effect`, never the key
  string)** — see `mem.decisions`; `ghl-sync-worker.ts`'s DND step checks `payload.is_dnc`, not
  `disposition_key === 'dnc'`. Also gains `license_number`/`zips` (carried for F-P2 to map to GHL
  custom fields; `buildDispositionNote` already appends them as extra note lines today).

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
     leg was the session's `active_leg_id` -- `transition_session` -> `wrap_up`). TASK-M1:
     `reap_dead_claimed_leg` also computes `duration_seconds` itself (SQL-side, `bridged_at ??
     answered_at ?? claimed_at` fallback) since this is the one leg-ending path with no TS-side
     `call.hangup` event to compute it from -- the leg was never told to hang up, the sweeper
     decided it must already be dead. This is also how an agent-lost claimed leg's
     `duration_seconds` gets written: `handleAgentLegLost` deliberately never touches the still-
     `claimed` leg (see its own step 1/2 above), so it becomes exactly this kind of stale
     candidate, reaped and given a duration the same way any other timed-out claimed leg is.

## Call recording (TASK-F-T2)

Records the WINNING contact leg only, never a loser, starting the moment it's actually bridged.

- **Starting**: `handleWin` (`dialer-engine.ts`), right after `bridged_at` is stamped, calls
  `maybeStartRecording` -- checks `org_recording_settings.recording_enabled` (default `true`,
  missing row also means `true`), then `client.recordStart(winnerLeg.call_control_id, {format:
  'mp3', channels: 'dual', clientState})`. `channels: 'dual'` on a call-level (not
  conference-level) command already captures the whole bridge from this one leg's perspective
  (verified against spec3.json -- see `.brain/memory/decisions.md`). Never blocks or fails the
  bridge: wrapped in its own try/catch, logged, never rethrown. `call_legs.recording_status`
  becomes `'recording'` on success.
- **The webhook**: `call.recording.saved`/`call.recording.error` are intercepted in
  `processTelnyxDialerEvent` right after the existing dedup check, BEFORE `mapToDialerEvent`
  (which would otherwise just drop them as unhandled -- they're not part of the leg state
  machine at all). Mapped back to the row via `client_state` (the SAME `{org,session,leg}` shape
  `encodeDialClientState` already produces for the dial itself, passed as `record_start`'s own
  `client_state` param) -- NEVER `call_control_id`, which this event's real payload does not
  carry (see `.brain/memory/known-issues.md` #27). `call.recording.saved` fetches
  `recording_urls.mp3` (valid 10 minutes) and uploads it to the private `recordings` Storage
  bucket at `{org_id}/{call_leg_id}.mp3` (our own `call_legs.id`, not Telnyx's), synchronously,
  in the same webhook call. Duration is derived from `recording_started_at`/`recording_ended_at`
  (no duration field exists on the payload). Telnyx's own `call_leg_id` is kept as
  `recording_telnyx_call_leg_id` for a possible future manual retry, never called a "recording
  id" (the payload has none). A download/upload failure sets `recording_status='download_failed'`
  and is never auto-retried by this function.
- **Pure logic split into `_shared/recording-core.ts`** (same "split I/O from decisions" pattern
  as `campaign-queue-io.ts`/`dialer-sweeper-core.ts`): `isRecordingEnabled`,
  `parseRecordingSavedPayload`/`parseRecordingErrorPayload`, `recordingStoragePath`,
  `canAccessRecording` (REC-4's auth matrix, reused by `recording-url`), `isPastRetention`.
- **Playback (REC-4)**: `recording-url` Edge Function mints a 10-minute signed URL. Auth mirrors
  `call_legs`' own RLS exactly (owner/admin see any leg in-org; an agent only their own session's
  leg) -- done in TS because this function uses the service-role client. Anything disallowed is a
  plain 404, never a 403 (never confirms a leg id exists in another org).
- **The wrap-up modal** (`WrapUpModal.tsx`) polls `recording-url` lightly (every 5s, up to ~3
  minutes) and shows an inline `<audio>` player once available -- never blocks wrap-up submission
  on it.
- **The GHL note**: `submit_disposition`'s `recording_url` payload field (already read by
  `buildDispositionNote`, `ghl-sync-worker.ts` -- that part predates this task) is now a stable
  app link (`https://hyperdial.myhomebasesolutions.com/contacts?leg=<id>`), never a raw signed
  URL, since it's written well before the recording may have finished processing.
- **Retention (REC-6)**: `recording-retention` Edge Function, triggered daily at 03:17 by the
  same pg_cron/pg_net shared-secret pattern as `dialer-sweeper`/`ghl-sync-worker`. Anchored on
  `recording_saved_at` (when the recording was actually confirmed saved), not the leg's
  `created_at`. Deletes via the Storage API (`storage.from('recordings').remove(...)`), never a
  raw SQL delete of `storage.objects` -- see `.brain/memory/decisions.md` for why.
- **Not built**: a contact-history UI showing the recording link per leg (REC-5's second clause)
  -- no such surface exists anywhere in the app yet. Deferred to TASK-F-P4; the signal it would
  need (`call_legs.recording_path is not null`) already exists.

### Recording consent notice, pause/resume, drop-rate, gatekeeper retry (MISSION-4 TASK-T8)

- **Consent notice**: `org_recording_settings.announce_recording_mode` ('never'/'all'/
  'all_party_consent_states', default 'never') + an editable `all_party_consent_states` text[]
  (seeded with a 14-state reference default, NOT legal advice). Decided by
  `shouldAnnounceRecordingConsent` (`recording-core.ts`, pure), applied in `handleWin`'s
  `maybeAnnounceRecordingConsent`, right AFTER `maybeStartRecording` -- the notice, if spoken, is
  itself part of the recording. State comes from the contact's phone number via
  `_shared/area-code-state.ts` (`stateForE164`, best-effort, same caveats as `area-code-tz.ts`).
  **Fail-safe direction (fixed post-review, eng1's T8 review MUST-FIX)**: an unmapped/non-`+1`
  number resolves to null state, and `shouldAnnounceRecordingConsent` treats null as "might be a
  consent state" -- it fails TOWARD announcing, never away from it. Only a state that resolves
  AND is confirmed absent from the org's list skips the notice. Speaks via the SAME `client.speak()`
  wrapper the abandon message already uses.
- **Pause/resume recording**: two new `TelnyxClient` methods, `recordPause`/`recordResume`
  (`POST /calls/{id}/actions/record_{pause,resume}`, empty body -- see `audit/T8/api-evidence.md`).
  `pauseRecording`/`resumeRecording` (dialer-engine.ts) act on the session's `active_leg_id`; no
  CAS needed (a single agent's own button click, no concurrent webhook racing it, unlike
  `transition_leg`/`transition_session`). New Edge Function `dialer-session-recording` (mirrors
  `dialer-session-hangup-live`'s shape) is the intern-facing endpoint. `call_legs.recording_status`
  gained `'paused'`; `recording_paused_at` (the currently-open span, if any) + append-only
  `recording_paused_spans jsonb` (closed `{paused_at, resumed_at}` pairs, written on resume) record
  the history. `endLiveCall` also closes any still-open span at call-end time (`closeOpenPaused
  RecordingSpan`, review fix-forward) -- an agent hanging up without clicking Resume first no
  longer leaves a dangling open span. UI: `LiveCallPanel`'s "Pause/Resume recording" button (next
  to Hold), wired through `ParallelDialerUI` -> `useDialerSession`'s `toggleRecording`.
- **Drop-rate tracking**: mostly already existed before this task (verify, don't assume) --
  `apply_leg_outcome` already sets `priority_requeue`+`next_attempt_at=now()` for dropped/abandoned
  (queues them first, next batch) and `sendAbandonMessage` already plays a short message gated on
  `campaigns.abandon_message_enabled`. Only the metric was missing: `campaign_drop_rate_summary`
  (new, additive RPC, same scoping shape as eng1's `funnel_summary` -- that function itself is
  untouched), surfaced as a "Drop rate (last 30 days)" card in `Analytics.tsx` with a >3% warning
  banner (`DROP_RATE_WARNING_PCT`).
- **QUE-2 (gatekeeper's own shorter retry)**: seeded at 1440 minutes (not the no_answer/voicemail
  4-day default) -- see `.brain/memory/known-issues.md` #32 for why 1440 specifically, and why a
  genuinely same-day retry isn't actually possible today regardless of the value chosen.

### Lines up to 10 + the drop-rate guard (MISSION-4 TASK-S2, part 1 -- lines/guard only; voicemail
### rotation, inbound ring group, and AUD-4 are NOT built)

- **`campaigns.lines` widened 1-7 -> 1-10, but 8-10 only with `high_lines_guard_enabled`.**
  Enforced at the DB level, not just in the UI/edge function: `campaigns_lines_check` is a
  same-row CHECK (`lines between 1 and 7 or (lines between 8 and 10 and high_lines_guard_
  enabled)`), evaluated against the FINAL row after an UPDATE -- so a client can flip both columns
  in one `updateCampaignSettings` call, but can never disable the guard while leaving lines above
  7 (that update is rejected outright). `dial_sessions.lines` widened the same way, but its own
  "needs the guard" rule is enforced by extending the existing `dial_sessions` BEFORE INSERT
  trigger (`enforce_campaign_active_for_session`, originally 20260924001500) rather than a second
  CHECK, since `dial_sessions` has no `high_lines_guard_enabled` column of its own to check
  against inline. `dialer-session-start/index.ts` also checks proactively for a clean 400
  (`HIGH_LINES_GUARD_REQUIRED`), same "proactive + DB-enforced defense in depth" shape as the
  existing deleted/paused-campaign checks.
- **`check_high_lines_drop_rate_guard`**: a 5-minute cron (`campaign-lines-guard-check`, same
  pg_cron/pg_net/vault-secret shape as `reliability-alert-check`/`number-health-check`) watches
  every campaign currently `lines > 7` (implies the guard is on, per the invariant above) and
  computes the SAME drop-rate definition as T8's `campaign_drop_rate_summary` (dropped+abandoned
  over connected+dropped+abandoned human answers) over a hardcoded trailing 60-minute window, with
  a minimum 10-human-answer sample (avoids tripping on a handful of unlucky calls right after
  enabling the guard). Over 3% -> atomically resets that campaign to `lines=7`,
  `high_lines_guard_enabled=false`, and stamps `high_lines_guard_last_triggered_at`/
  `_last_drop_rate_pct` (pure history, shown in `CampaignManageModal.tsx`, never auto-cleared) in
  the SAME update RETURNING the rows the edge function notifies owners/admins about. A human must
  re-enable the guard (and re-raise lines) after reviewing what happened -- not self-healing.
- **Known limitation (documented, not fixed -- see `.brain/memory/known-issues.md`)**: reducing
  `campaigns.lines` only changes the default for FUTURE session starts. A `dial_sessions` row
  already `on_call` at 8-10 lines when the guard trips keeps dialing at its own already-copied
  `lines` value until that session ends -- consistent with how changing `campaigns.lines` has
  always behaved (never live-pushed to a running session), not a new gap this task introduced.

### Live coaching: listen / whisper / barge (MISSION-4 TASK-T3)

- An owner/admin, from the Team page's live board, dials their OWN WebRTC credential (the same
  agent-leg mechanism, reused unchanged) into a target member's live session conference as a
  Telnyx supervisor participant — `barge`/`monitor`/`whisper` (Telnyx's own "listen" maps to
  `monitor`, verified against `spec3.json`). Switching mode mid-call uses the conference-level
  `/actions/update` command, not a rejoin. New `coaching_sessions` table (not `call_legs`) holds
  the manager's coaching leg deliberately — nothing in the dial loop's own state machine treats a
  supervisor participant as a contact/agent leg. Edge Function `dialer-coaching`, orchestration in
  `_shared/coaching-core.ts` (deno-tested; the `index.ts` shell isn't). Review fix-forward: the
  coaching leg now auto-ends when the coached call itself ends, rather than lingering.
- **EC-8, MISSION-5 TASK-M5-B2: at most one active coaching session per TARGET call, not just per
  manager.** `coaching_sessions_one_active_per_target` (unique partial index on
  `target_session_id`) is the real guarantee; `runStartCoachingAction` also pre-checks it before
  ever dialing, and a 23505 from either partial index (manager's own, or this one) is
  distinguished by matching the constraint name in the Postgres error message, so a genuine race
  still returns "Already being coached by X" rather than a generic busy message. Coaching also
  now ends cleanly (hangs up the manager leg, marks the row `ended`) in two cases the sweeper's
  own 60s staleness check cannot catch: (1) **the target call is transferred** — a transfer moves
  the CUSTOMER out of `dial_sessions.conference_id` but `state` stays `'on_call'` throughout, so
  `reap_stale_coaching_sessions`' `state <> 'on_call'` condition never fires; closed by hooking
  `endActiveCoachingForTargetSession` into `finalizeHandoff` (transfer-core.ts), the ONE function
  shared by both cold and warm transfer completion; (2) **the coach is disabled/removed** —
  `endActiveCoachingSessionsForManager`, called from `org-members/index.ts`'s `cascadeOffboard`.
  The sweeper path itself (`reap_stale_coaching_sessions`) also gained an audit-log call it never
  had (`coaching.end`, reason `swept_stale`) — the A1 review's own carried SHOULD.

### Supervisor controls (MISSION-5 TASK-M5-B2)

- **Remote pause/end/hang-up all reuse the EXISTING sessionId-keyed endpoints** — `dialer-
  session-pause`/`-stop`/`-hangup-live` already let an owner/admin act on any org session by
  `sessionId` (role==='agent' is the only restriction, gating self-only); `team_live_board` was
  widened to also return `session_id` so the live board can call them directly. **Manager+pod
  scoping landed in TASK-M5-B4** (below): each of these three endpoints now also admits
  `role==='manager'`, gated by `pod-scope.ts`'s `isManagerScopedToAgent` when the target isn't
  the manager's own session — a manager may act on any agent in their own managed pod(s), never
  outside them.
- **Pause**: `pauseDialerSession(sessionId, 'Paused by manager')` — `pauseSession`'s own expected-
  state list widened to include `ready_pending` (a remote click, unlike the agent's own Pause
  button, can plausibly land in that transient window). Audit-logged (`session.remote_pause`)
  only when the actor isn't the session's own agent.
- **End session, "a live call is allowed to finish"**: `stopDialerSession(sessionId, {defer:
  true})` — if no live call is in progress, stops immediately like a normal Stop; if one IS in
  progress, instead of refusing (409) it writes `dial_sessions.remote_stop_requested_at/_by` (no
  state change yet) and returns 202. `submit_disposition`'s own wrap_up branch checks that column
  FIRST (ahead of the agent's own auto-resume preference) and transitions straight to `stopped`
  the moment that in-progress call's disposition is saved, tagging `pause_reason:
  'remote_end_by_manager'` so the client can tell this apart from a self-service Stop and show its
  own "ended by a manager" toast (the poll-driven path a self-stop's own local reset never covered
  before this task, since `ACTIVE_SESSION_STATES` stops polling once `state === 'stopped'`).
  Audit-logged either way (`session.remote_end`), from `dialer-session-stop` for the immediate
  case and from `dialer-session-disposition` (reading `submit_disposition`'s widened RPC result)
  for the deferred-then-executed case.
- **Hang up the contact leg only**: `hangupLiveCall(sessionId)` — no new backend logic at all,
  `dialer-session-hangup-live` already permitted this; only gained the same remote-only audit log
  (`session.remote_hangup`). The confirm step is client-side only (Team.tsx).
- **Raise hand**: agent-only, hotkey R or a button (ParallelDialerUI); `dial_sessions.
  raised_hand_at`, a new `dialer-session-raise-hand` endpoint, and a `notifications` row per
  recipient (reusing the exact shape `notifyOwnersAndAdminsOfDailyCap` already established).
  **TASK-M5-B4**: the recipient set widened from "every owner/admin" to `pod-scope.ts`'s
  `resolveAlertRecipients` — owner/admin unconditionally, plus the raising agent's own pod-scoped
  manager (an agent with no pod still reaches owner/admin, just no manager). Auto-clears at TWO
  single choke points, not scattered call sites: inside
  `transition_session` itself the instant a transition leaves `on_call` (reads the PRE-UPDATE
  row's own `state` in the SET list — standard Postgres semantics, needs no separate read), and
  inside `runStartCoachingAction`'s successful-insert path the instant a manager actually starts
  coaching that target. The live board shows the flag (`team_live_board.raised_hand_at`); the
  notification's new `data` jsonb column carries a click-through (`TopNavigation.tsx` routes to
  the Team tab, not to auto-starting a coaching call with no WebRTC client mounted there).
- **EC-17**: `org_recording_settings.mention_monitoring` (boolean, default off) appends "...and
  monitored..." to the T8 consent announcement (`recordingConsentMessage`) — for an org using live
  coaching in an all-party-consent state, "may be recorded" alone doesn't disclose a supervisor
  silently listening in. Not legal advice, same scope as the rest of that setting.

### Supervisor alerts + notification preferences (MISSION-5 TASK-M5-B4)

- **Per-org opt-in, per-condition editable thresholds** (`org_supervisor_alert_settings`, all off
  by default): agent in wrap-up too long, paused too long, on a call too long, zero connects in
  the last N minutes of active dialing. Same select-any-member/write-owner-admin RLS shape as
  `org_timezone_settings`.
- **Delivery reuses `reliability-alert-check`** (the T10 cron worker) rather than a second
  cron/secret/config.toml entry for the same "SQL decides+flips, TS notifies" shape — a new
  `check_supervisor_alerts()` RPC (no params; reads each org's own thresholds via a join, unlike
  T10's hardcoded constants) runs alongside the existing stuck-session/webhook-spike checks every
  5 minutes.
- **Dedup ("one alert per agent per condition per episode") uses two different mechanisms**,
  because an "episode" means something different for each: wrap-up/paused/call-too-long fire off
  one OPEN row in `agent_state_events` (B1) — a new `alerted_at` column on that table is set once
  per row, and naturally re-arms the moment that row closes and a fresh one opens (the table's
  own one-open-row-per-agent shape IS the episode boundary, no separate recovery check needed).
  Zero-connects has no single row to key off — its episode is "the stretch since the agent's last
  CONNECTED leg (or since the session started, if they've never connected)"; `dial_sessions.
  zero_connects_alerted_at` only blocks a re-fire while it falls inside that SAME stretch, so a
  later connect re-arms it for the next dry spell in that session.
- **Recipients**: owner/admin always, plus the alerted agent's own pod-scoped manager
  (`pod-scope.ts`'s `resolveAlertRecipients`, shared with raise-hand above), each then filtered
  through `user_notification_preferences` (per-user opt-out per alert type; absence of a row means
  on — "everything on by default" falls out of this for free, for every role, not just owner/
  admin). Settings → Team gains two owner/admin-only cards (`SupervisorAlertSettingsCard`,
  `NotificationPreferencesCard`) for the thresholds and the per-person opt-outs respectively.
- **Manager/pod scoping for coaching**: `dialer-coaching`'s role gate now admits `manager`;
  `runStartCoachingAction` (coaching-core.ts) checks `isManagerScopedToAgent` before ever dialing
  the manager's own phone when the caller isn't owner/admin. `coaching_sessions`' own SELECT RLS
  was widened to match (a manager sees only coaching attempts they themselves started) — not
  currently exercised by any client read (the UI only ever gets a `coachingId` back from the start
  action's own response), pure consistency hardening.
- **NOT built**: no self-service notification-preferences UI for an agent to manage their own
  prefs — `MainApp.tsx`'s tab gate already excludes `'settings'` for a plain agent entirely (a
  pre-existing gap, not one this task introduced), so only owner/admin can reach either new card
  today, same as every other Settings → Team card. No audit-log entry for either new settings
  write, matching the established (if imperfect) precedent of every other direct-table org-
  settings card in this file (`org_recording_settings`, `org_reliability_alert_settings`,
  `org_timezone_settings` — none of them audit-log their own update either, despite pre-seeded
  `AUDIT_ACTION_LABELS` entries for some of them that nothing has ever actually fired).

### Supervisor call takeover (MISSION-5 TASK-M5-N1, deferred backlog item)

- **Promotes an ALREADY-active coaching attempt** (listen/whisper/barge, TASK-T3) into a
  takeover — not a 5th mode requested at coaching-start time. `dialer-coaching`'s new
  `'takeover'` action (`coaching-core.ts`'s `runTakeoverAction`), given the same `coachingId`
  `startCoaching` returned. `taken_over_at` on `coaching_sessions` (nullable, also the CAS
  race-guard for two clicks landing at once) distinguishes "coaching" from "took over" — `mode`
  itself is NOT widened with a 4th value, since the supervisor's real Telnyx conference role
  after a takeover is just `barge` (Telnyx has no "takeover" `supervisor_role`).
- **Mechanism is `leave` (parks the agent's leg) then `hangup` (ends it) — verified against
  `spec3.json` that Telnyx has no "kick" endpoint at all.** `POST /conferences/{id}/actions/leave`
  only moves a leg back to `parked`; a separate `POST /calls/{id}/actions/hangup` actually ends
  it. Both are pre-existing `TelnyxClient` methods, reused unmodified.
- **DB transitions happen BEFORE any Telnyx command — load-bearing, not incidental.** Clearing
  `dial_sessions.agent_leg_id` to null (via `transition_leg` + `transition_session`) before
  issuing `leaveConference`/`hangup` means the REAL webhook for the agent leg's eventual hangup
  hits `processAgentLegEvent`'s existing stale-leg guard (`if (leg.id !== session.agent_leg_id)
  return`) and no-ops — avoiding a double-cascade race with the generic "agent leg lost" handling,
  with ZERO changes to `dialer-engine.ts`. `conference_id` is also cleared to null in the same
  transition (`ensureAgentConference`'s existing null-conference-id fallback creates a fresh one
  if the agent ever dials again) — a session's `conference_id` must never point at an abandoned
  conference.
- **Target session lands in `paused`, `pause_reason: 'call_taken_over_by_manager'`,
  `taken_over_by_manager_id` set — permanently, for that session.** The agent's existing Resume
  button works for free: `resumeToDialing` already accepts ANY `pause_reason` string from any
  `'paused'`/`'wrap_up'` starting state. `DialerStateBanner.tsx` shows "Your call was taken over
  by \<name\>" (name resolved server-side by `dialer-session-get`, new `takenOverByManagerName`
  field, from `profiles` — never trusted from the client).
- **The sweeper needed a fix-forward found by reasoning, not a live failure**:
  `reap_stale_coaching_sessions`'s staleness condition (`state <> 'on_call' and updated_at <
  now() - stuck_after`) would eventually match ANY taken-over `coaching_sessions` row too, since
  the target session's `state` is deliberately never `on_call` again post-takeover — without a
  fix, the sweeper would eventually hang up the SUPERVISOR's own live leg. Fixed by adding
  `taken_over_at is null` to the staleness CTE (both the stuck-after and hard-cap branches).
- **Disposition ownership: the supervisor, scoped to EXACTLY the leg they took over — not a
  general pod-scope grant.** `dialer-session-disposition` admits `role==='manager'` now, but only
  when a `coaching_sessions` row exists with `manager_id = caller` and `taken_over_at is not
  null` for that target session; `submit_disposition`'s own SQL needed no change (its trailing
  `transition_session(..., ['wrap_up'], ...)` call is a harmless CAS-miss no-op for a takeover
  leg's session, which is never in `wrap_up`).
- **`org_call_takeover_settings`** (org_id pk, `enabled boolean default false`) — OFF by default,
  owner/admin only (same select-any-member/write-owner-admin RLS shape as
  `org_supervisor_alert_settings`), reuses the existing generic `audit_log_settings_change_trigger`.
  A dedicated table, not a column on an existing settings table, because this gates an ACTION's
  authorization, not an alert threshold or a consent disclosure. `runTakeoverAction` re-checks it
  server-side (403 `TAKEOVER_DISABLED`) — the Settings → Team `CallTakeoverSettingsCard` toggle is
  not the only enforcement. `CoachingBanner.tsx`'s "Take over" button is itself hidden when the
  org has this off (fetched once on mount), not just disabled-with-a-tooltip.
- **`CoachingBanner.tsx`'s existing 4s poll (the T3/review-fix-forward auto-hangup — see this
  file's own coaching section above) had to be taught about takeover explicitly**: that poll
  already calls `onLeave()` (hangs up the MANAGER'S OWN leg) the moment the target session leaves
  `on_call` — which a successful takeover ALSO does, by design. A `tookOverRef` guard added to
  that same effect skips the auto-hangup once `handleTakeover` has resolved, so the supervisor's
  own leg survives past the moment they take over (they end it deliberately later, via the same
  Hang up button, now relabeled).
- **NOT built this pass**: no UI retry surfaced for a Telnyx-side `updateConferenceSupervisorRole`
  failure beyond the banner's own inline "Retry" link (calls `switchCoachingMode('barge')`
  again) — `takeoverCall`'s `roleUpdateFailed: true` response flag exists specifically so the
  client can offer this, never silently. NEEDS-LIVE-VERIFY: the exact real-call timing/audio
  behavior around the takeover moment — see `docs/validation/launch-live-test.md` B25.

### Hold + warm/cold transfer (MISSION-4 TASK-T4, AUD-6 + NEW)

- **Hold**: the prospect leg is held IN PLACE in the session's own persistent conference (Telnyx
  conference hold is per-participant, not conference-wide) via a plain `held_at` timestamp on the
  existing `call_legs` row — no new leg kind, no new table.
- **Transfer**: deliberately NOT built on Telnyx's `transfer` command — its schema is bridge-shaped
  and says nothing about a leg that's currently a conference participant, and using it
  unverified risked stranding the agent's own persistent, shift-long conference. Built instead
  from conference-native join/leave/hold/unhold primitives, each independently verified against
  `spec3.json`. Cold transfer hands the prospect to a teammate's WebRTC or an external E.164
  number and ends the intern's own participation (session → `wrap_up`); warm transfer holds the
  original agent in a side conversation first. Edge Function `dialer-transfer`, orchestration in
  `_shared/transfer-core.ts`. Review fix-forward: an in-flight transfer is now cancelled if the
  intern hangs up before it completes, plus an external-transfer guard stack (mirrors the
  existing `Allow transfers to external numbers` org setting, off by default) and an API-evidence
  table for the conference primitives used.

### Per-lead assignment, priority, skip, remove (MISSION-4 TASK-T6, ADM-4 + NEW)

- Campaign-level agent assignment (`campaign_agents`) already existed (TASK-P2-P2) — the new piece
  is per-LEAD ("slice") assignment. Reuses the existing `campaign_leads.assigned_agent_id` column
  (previously callback-ownership-only); `claim_next_leads`' own WHERE clause now respects it for
  `queued` leads too. New `assign_campaign_leads` RPC (owner/admin only) computes the target lead
  set once — by rank/percentage/GHL-tag filter — and writes `assigned_agent_id` directly;
  reassigning mid-day is just calling it again. It also auto-adds the target to `campaign_agents`
  (an assignee not already on the campaign could never see or claim what was just assigned to
  them). `AssignLeadsModal.tsx` is the UI (Campaigns → a campaign → Leads → "Assign leads").
  **Priority** (high/normal/low, ordered ahead of attempts/`next_attempt_at`/position in
  `claim_next_leads`) and **Skip** (pushes `next_attempt_at` forward without touching
  attempts/position — "keeps its place") are both plain column updates through the existing
  owner/admin-only RLS policy, no new RPC needed. **Remove from campaign** now flips `status` to a
  new `'removed'` value instead of a hard `DELETE` (which silently lost the lead's own
  attempts/history and contradicted this task's own "terminal status" ask) — deliberately not a
  reuse of `'passthrough'`, which already has its own distinct meaning baked into every
  campaign-stats view.

### Reliability alerts: stuck session + webhook error spike (MISSION-4 TASK-T10, SEC-7 rest)

- Two per-org opt-in alert types (`org_reliability_alert_settings`, both flags default `false`),
  delivered through the existing generic `notifications` table/bell (same shape as TASK-SP's own
  low-balance alert) — no new UI surface needed beyond a Settings toggle.
  **Stuck dial session**: `check_stuck_dial_sessions` (SQL, decide+flip atomically, same shape as
  `reap_stale_call_transfers`/`check_number_health`) flags a session in `dialing`/`connecting`/
  `on_call` whose own `updated_at` AND most-recent `call_legs.created_at` are both older than 20
  minutes (deliberately much longer than the 30s sweeper interval — this is a "something is
  structurally stuck" alert, not a routine reap). **Webhook error spike**: counts
  `telnyx-webhook` processing failures over a trailing 15-minute window; above a threshold, an
  in-app alert deduped for 1 hour. Edge Function `reliability-alert-check`, triggered by
  `private.trigger_reliability_alert_check` — pg_cron config not yet wired to the live project
  (see `.brain/tooling/integrations.md`). Review fix-forward: `record_webhook_processing_error`
  is now tracked under `EdgeRuntime.waitUntil`, not a bare `queueMicrotask` (the same
  background-work risk TASK-P2-E2's own review already flagged for a different call site).

### Agent state log + pause reasons (MISSION-5 TASK-M5-B1)

- `agent_state_events(org_id, agent_id, session_id, state, reason, started_at, ended_at)` mirrors
  `dial_sessions.state` 1:1 (never a bucketed vocabulary) -- one open row (`ended_at is null`) per
  agent, enforced by a partial unique index, not just convention. Written from exactly two
  choke points, both already the sole place any `dial_sessions.state` change happens, so no
  future call site can drift out of sync: an `AFTER INSERT` trigger on `dial_sessions` (the
  session's very first state, `'ready_pending'`, is a plain `.insert()`, not `transition_session`)
  and `transition_session` itself (every other transition -- 11 functions across
  `dialer-engine.ts` call it). Both close the agent's currently-open row before opening the new
  one. RLS: agent sees own, owner/admin see the org, same twin-policy shape as `dial_sessions`.
- `reason` is populated from the same `pause_reason` key already flowing through
  `p_fields`/`pauseSession` (pre-existing since TASK-I1's `'inbound_call'` reason) -- never a
  second, independently-maintained value. `dialer-session-pause` now accepts an optional `reason`
  in its body (trimmed, capped at 80 chars, defaults `'Other'` so an old client keeps working
  unchanged); `pauseSession`'s own reason param is unchanged (still `string | null = null`,
  still used as-is by `inbound-engine.ts`'s system-initiated pause).
- `org_pause_reason_settings(org_id, reasons text[])`: the org's own editable list (defaults
  Break/Lunch/Training/Meeting/Admin/Other), seeded on org creation by a trigger, same
  `org_<feature>_settings` singleton shape as `org_number_pool_settings`/`org_spend_settings`
  (select: any member; insert/update: owner/admin) -- deliberately NOT a column on `orgs` itself,
  since `orgs`' own UPDATE policy is owner-only and widening it to admin for one column would
  also hand admin write access to every other `orgs` column. `dialer-session-pause` does NOT
  validate an incoming reason against this list server-side -- `dial_sessions.pause_reason` is
  already free-form text with no CHECK constraint by design (20260925070000's own comment); this
  table is a UI picker data source, not a server-side enum.
- `agent_time_in_state(org, from, to[, agent], tz default 'America/Chicago')`: per agent/day
  seconds by state and pause reason, owner/admin only (same `has_org_role` return-empty gate as
  `team_daily_stats`/`team_live_board` -- an agent-facing self-view is explicitly TASK-M5-A4's own
  item, not this one). Day-buckets a row that spans a civil-day boundary via
  `generate_series` + per-day overlap clipping, in the given timezone (not a fixed 24h offset --
  correct across a DST transition inside the queried range).
- `team_live_board` gained a `pause_reason` column (from `dial_sessions.pause_reason`, null unless
  the session is actually `paused`/`paused_agent_lost`) -- server-side only; wiring it into
  `Team.tsx`'s own rendering is TASK-M5-A4's job (eng1 owns `Team.tsx`).
- The Dialer's Pause button is now a small dropdown (`ParallelDialerUI.tsx`, shadcn
  `DropdownMenu`) listing the org's own `org_pause_reason_settings.reasons`, fetched once per
  `Dialer.tsx` mount and falling back to the hardcoded default list on any fetch failure --
  never blocks the button on that fetch succeeding.

### Distribution guards: callback fallback, bulk reassign, daily dial cap (MISSION-5 TASK-M5-B3)

- `org_distribution_settings` (org-wide, both OFF by default): `callback_fallback_enabled` +
  `callback_fallback_minutes` (default 30), `daily_dial_cap_enabled` + `daily_dial_cap_default`
  (default 300). `org_agent_dial_caps` holds a per-agent override (absence = org default). Both
  reuse TASK-M5-A1's generic settings-change audit trigger verbatim -- no new logging code.
- **Callback fallback**: `claim_next_leads`' own `picked`/candidate WHERE clause gained a third
  branch alongside "queued, unowned or mine" and "callback, mine" -- a `'callback'` row NOT owned
  by the requesting agent becomes claimable when fallback is enabled AND it's been overdue
  (`next_attempt_at`) for at least the configured window AND (the owner is disabled/removed from
  the org OR the owner currently holds no non-terminal `dial_sessions` row at all). The claiming
  agent becomes the new `assigned_agent_id` (ownership transfers, not just a one-time claim) --
  logged once per `claim_next_leads` call (`campaign_leads.callback_fallback_claim`, batched
  count) via `private.log_org_action`. Implemented as a `for ... in (<the same select>) loop
  return next ...` instead of the original `return query <select>` shape specifically so the
  function can count fallback claims and log once, AFTER the loop -- a CTE like `picked` is only
  visible inside the single statement it's part of, so a separate post-hoc query referencing it
  is not possible.
- **Bulk reassign "from agent X"**: `assign_campaign_leads` gained a `by_current_agent` filter
  mode (`{"mode": "by_current_agent", "from_agent_id": "..."}`) -- the only mode whose candidate
  pool also includes `'callback'` rows (every other mode stays `'queued'`-only, unchanged).
  `p_agent_id: null` reassigns to the pool (that half of the signature already existed).
- **EC-5 fix** (applies to every `assign_campaign_leads` mode, not just the new one): the
  function's own UPDATE now re-checks `cl.status in ('queued', 'callback')` directly against the
  row it's about to write, not just the earlier `candidates` CTE snapshot. Postgres re-evaluates
  an `UPDATE ... FROM`'s join condition against the row's latest committed version once it
  acquires the row's lock -- a row a concurrent `claim_next_leads` call already flipped to
  `'in_flight'` while this UPDATE was waiting is now correctly excluded, instead of being
  silently reassigned out from under a live dial. This was a real, pre-existing gap since
  `20260926070003` first shipped `assign_campaign_leads`; this task's own dry-run is the first
  thing to prove it either way.
- **Daily dial cap**: `agent_daily_dial_status(org, agent, tz)` (service_role only) reads the
  settings + override + counts today's `kind='contact'` legs for that agent, org-timezone-aware
  (same placeholder-'America/Chicago' convention as TASK-M5-B1's `agent_time_in_state`, pending a
  real org timezone from TASK-M5-A4). `refillSession` calls it BEFORE `claim_next_leads` (same
  "pause before claiming, never fail mid-claim" shape as the existing numbers-availability
  check) -- if the cap is already met, the session pauses (`pause_reason:
  'daily_dial_cap_reached'`, a DialerStateBanner case exists for it) and owners/admins get one
  `notifications` row, gated on `transition_session`'s own CAS actually succeeding (so a later
  refill attempt while already paused can't double-notify -- no separate dedup needed, same
  free "only fires once" property `no_numbers_available` already relies on).
- **Fake-Supabase fix found while testing this** (`dialer-fake-supabase.ts`): `FakeQuery.insert()`
  only ever handled a single-row payload -- a bulk `.insert([row, row, ...])` (the
  `notifyOwnersAndAdmins` shape already used by `reliability-alert-check`/
  `campaign-lines-guard-check`) silently stored the WHOLE ARRAY as one fake row (arrays have no
  `.id`, so it landed under one random uuid key), making every row inside it invisible to a
  normal table scan. Fixed generically (handles both shapes); this is the first deno test in
  this shared fake to exercise a bulk insert, so nothing caught it before.

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

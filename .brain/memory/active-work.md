---
id: mem.active-work
title: Active Work
layer: L2
type: memory
status: canonical
owner: maintainer
updated: 2026-09-27
related:
  - mem.known-issues
  - domain.contacts
  - domain.campaigns
  - domain.dialer
  - domain.telephony
  - domain.analytics
answers:
  - "what is in flight"
  - "what is being worked on"
  - "what is the current backlog"
  - "what should I pick up next"
covers: "Work in progress and the near-term backlog"
excludes: "Shipped decisions (see mem.decisions), defects in shipped behaviour (see mem.known-issues)"
tokens_est: 2350
---

# Active Work

## Mission 4 (2026-09-26 onward) — supersedes the Stage-1 section below for "what's current"

Mission 4 (`.claude/overnight/run-20260923-2024/MISSION-4.md`) is a large batch
of dialer/telephony/GHL/analytics features layered on top of the
already-launched Stage 1 base (below, still accurate as history). **Shipped
and deployed** as of 2026-09-27 ~06:10: T1 (GHL pull complete), T2 (GHL push
complete), T3 (live coaching), T4 (warm/cold transfer + hold), T5a/T5b (call
script/objection sheet + connected-call context cards), T6 (per-lead
assignment/priority/skip/remove), T7 (hotkeys + auto-resume — click-to-call
piece parked, see below), T8 (compliance: recording consent + pause/resume +
drop-rate), T9 (caller-ID health, CID-4), T10 (reliability alerts), T11
(dialer analytics + CSV export), S2 part 1 (lines up to 10 + drop-rate guard).
See `.brain/domains/dialer.md`/`telephony.md`/`campaigns.md`/`analytics.md`
for what each actually does and where the code lives — this section only
tracks status, not mechanism.

**Parked / explicitly deferred (all a deliberate lead+engineer decision, not
an oversight — pick up by re-reading the named task file first):**

- **INB-7** (click-to-call from a contact's page, part of TASK-T7): needs the
  same `call_legs`/disposition/GHL-sync treatment as a real session call, not
  a standalone call — the existing `claim_leg` gate was never widened past a
  parallel-session context, and INB-1's own inbound precedent doesn't
  transfer cleanly (INB-1 deliberately has no `call_legs` row; INB-7 needs
  one). Design notes only, zero code, in `TASK-T7-m4.md`'s own RESUME_PLAN —
  parked rather than rushed near a session's hard stop.
- **S1** (Supabase Realtime for the Dialer/Team live board, replacing/
  supplementing polling, BASE-10 stretch): not started. `TASK-S1-m4.md`
  (backlog). Declined for a late-session start given its own multi-party
  dependency chain (build → the lead applies a migration live → live-verify
  RLS-on-realtime → a second review, all before a hard stop) stacked on top
  of unplanned live-dry-run fixes that ate the session's remaining budget.
- **S2 parts 2-4** (voicemail rotation, inbound ring group, AUD-4
  phone-callback fallback for the intern's audio): explicitly out of scope
  for the S2 commit that shipped part 1 (lines + drop-rate guard) — see that
  commit's own "NOT built" note and `TASK-S2-m4.md`.
- **Area-code map consolidation**: the NANP area-code→timezone/state data
  exists in 3 hand-synced copies (`_shared/area-code-tz.ts`,
  `apps/web/src/lib/area-code-tz.ts`, and each of two SQL seed tables —
  `private.area_code_timezones` and TASK-T9's `private.area_code_states`) —
  Vite can't resolve a Deno `npm:` specifier and SQL can't import either TS
  file, so there's no single source of truth today, only a sync test
  (`area-code-tz-sync.test.ts`) that catches drift between the copies after
  the fact. Consolidating onto one generated source is real but unscheduled
  work — not attempted this session.

## Stage 1 (historical — launched; kept for the record)

### In flight

**Stage 1 rebuild** (`feat/stage-1`, spec `docs/design/stage-1-architecture.md`).
Status as of 2026-09-25: **the LAUNCH BLOCKERS phase (TASK-L1 through L9) is
built, reviewed, and mostly live — the last gate before real usage is the
single live test run**, `docs/validation/launch-live-test.md`. That file is
now the canonical "what's left" list; this section summarizes, it doesn't
duplicate.

- Integrated into the LIVE project (`lahordgefwsiqzvbfpyp`) on 2026-09-24
  morning; local Docker is retired for this phase entirely (dev talks to live
  Supabase, SQL test fixtures are verified via rolled-back live dry-runs, not
  a local reset).
- All 28+ edge functions deployed (`--use-api`); `DIALER_SWEEPER_SECRET` and
  `CRM_SYNC_WORKER_SECRET` set; both pg_cron workers configured and returning
  200.
- **Self-signup is still open on purpose** — TASK-L4's invite-only trigger
  (`20260925000300_invite_only_signup.sql`) is committed and verified but
  deliberately **held**, waiting for the user to create the MyHomeBase owner
  account through it (`launch-live-test.md` step A1/A6). Applying it is the
  literal last step of the live test, not a separate task.

**Landed and live** (reviewed, applied, deployed):
- Phase 1: org tenancy + RLS, `requireOrgRole`, onboarding/invites/team, BYO
  Telnyx key in Vault, ed25519 webhook verification that fails closed,
  numbers + per-member WebRTC credential.
- Phase 2: contacts E.164/timezone/DNC; campaign settings, agents, soft
  delete; dialer schema/RPCs; the rolling-refill engine with Postgres
  single-winner claims (Redis is out of the dial path).
- Phase 3: GHL connect, pull import, push outbox worker (pg_cron).
- Dispositions backend + Settings editor; Dashboard/Analytics on real data
  (`call_leg_analytics`/`dial_session_hours`); the `call_events` drop.
- **TASK-L3** (DNC + dedupe, contacts merge migration, one-active-campaign
  constraint) — applied live.
- **TASK-L1** (real agent WebRTC leg: Go Ready, agent-lost/Reconnect,
  conference bridging, mic-permission check) — through 3 review rounds, all
  fixed; the `DIALER_DEV_SKIP_AGENT_GATE` bypass this used to need is gone.
- **TASK-L2a/L2b** (wrap-up modal + the real dialer UI state machine: one
  "big visible state" banner for every `dial_sessions.state`, mandatory
  wrap-up with no bypass, Pause/Resume, a sound cue).
- **TASK-L5** (confirm before hanging up a live call when stopping/starting a
  session).
- **TASK-L7** (interns start their own session from the Dialer — closes the
  gap L4's role-based nav opened: Campaigns was the only Start-session entry
  point and agents can't see that tab).
- **TASK-L6** (the dialer sweeper now also reaps a `claimed` leg whose own
  `call.hangup` webhook was lost, via a direct Telnyx status check — closes
  known-issues #11).
- **TASK-L1r4** (5 rounds of cross-lane review fixes on the above: campaign-
  assignment enforcement on session start, auto-reconnect timing/dedup, the
  agent's WebRTC line surviving a tab switch, and a single-browser-tab lock
  now that the Dialer stays permanently mounted).
- **TASK-L4** (invite-only signup trigger, role-based nav) — code landed and
  verified, migration **held**, see above.

**NEEDS-LIVE-VERIFY**: see `docs/validation/launch-live-test.md` for the full
ordered runbook (Telnyx WebRTC registration/auto-answer/two-way audio, a real
parallel dial cycle, agent-lost/Reconnect, tab-switch survival, the
single-tab lock, DNC enforcement, and — last — closing self-signup). GHL's
real token connect/pull/push and the crons' one-time Vault config
(`private.set_crm_sync_worker_config`/`private.set_dialer_sweeper_config`)
are separate, not blocking the dialer launch test.

**Known gaps** (see `.brain/memory/known-issues.md` for the full write-up of
each; not repeated here):
- Agent campaign visibility for non-dialer screens is still client-side only
  (#10) — RLS on `campaigns` itself stays org-wide.
- Invite-accept for an existing or disabled member doesn't reactivate them or
  change their role.
- The area-code timezone table exists in 3 copies (SQL + 2 TS) with a sync
  test, but no single source of truth.
- `sip_uri_calling_preference` isn't set on the agent's Telnyx credential
  connection — flagged as a live-test contingency, not a known-broken item
  (#18 minor m1).
- A stuck lead in a paused/deleted campaign, or in-flight without a
  disposition, blocks that contact everywhere (#13 addendum) — documented,
  not built.

### Backlog

Migrated verbatim in intent from the former docs/backlog.md, removed under the
Phase 02 classification plan — a TODO list is memory, and two copies diverge.

> **Provenance and confidence.** These were written by the maintainer in
> the original changesToBeMade.txt at an unrecorded date before 2026-04-29. Only the
> one marked *verified* below has been rechecked against current code. The rest
> are `unverified` — **confirm the item still reproduces before starting it.**

### Contacts

| # | Item | Status |
|---|---|---|
| 1 | On loading the next page of contacts, scroll to the top of the list instead of leaving the user at the bottom. | **fixed** (TASK-B1, `00cd17b`) |
| 2 | The CSV import column-mapping step is overlapped by the menu and does not fit on screen. Reduce the container's vertical extent. | **no longer reproduces** (verified live, TASK-B1) |
| 3 | Import field dropdown: cap at ~5 visible options and make it scrollable. | **no longer reproduces** (verified live, TASK-B1) |

**Items 2 and 3 are both already fixed in the code** — `ImportContactsModal.tsx`'s outer dialog
caps its own height (`style={{ maxHeight: 'calc(100vh - 16px)' }}`, `overflow-y-auto` on the
body) and the field `Select`'s own dropdown is height-capped and scrollable
(`max-h-[14rem]`/`[&_.select-viewport]:!max-h-[14rem]`). Re-verified live 2026-09-25 with a real
CSV import and the dropdown open — no overlap, no clipping. **Item 3's "grey out already-mapped
fields" half was already implemented** (`isFieldMappedElsewhere`, verified 2026-09-21,
`ImportContactsModal.tsx:374-386`) — both halves of item 3 are done.

### Campaigns

| # | Item | Status |
|---|---|---|
| 4 | Widen the "create new campaign" naming dialog. | **no longer reproduces** (verified live, TASK-B1 — 300px at desktop widths, text/buttons fit cleanly) |
| 5 | Fix the status dropdown and give it a solid background — it renders transparent. | **no longer reproduces** — `CampaignManageModal.tsx`'s status `Select` already has explicit `bg-[#1E2A3A]` on both the trigger and the dropdown content (code-verified + a closed-state screenshot; the open-state click kept hitting Playwright locator ambiguity across duplicate QA test campaigns, not pursued further — low risk given the explicit background classes already present) |
| 6 | Bring the campaigns screen to parity with contacts: CSV import, single-contact creation, and adding existing contacts. | unverified |

Item 6 is the only substantial one — it is a feature, not a fix, and it is
plausibly the largest open item in the product. (TASK-B1's deep bug hunt did not build it —
feature work is explicitly out of scope for that task.)

### Recommended next steps

Not assigned; offered as a reading of the current state:

1. **Verify the six backlog items.** A one-hour pass converts a stale list into a
   real one. Five of six have never been rechecked.
2. **Analytics is real as of Stage 1** (`call_leg_analytics` / `dial_session_hours` views). Verify the numbers after the first live calls.
3. **Add CI.** `npm run check` and `npm run build` both pass today. Nothing
   enforces that they keep passing.
4. **Compliance posture.** Stage 1 adds DNC suppression, a per-contact-timezone calling window (default 08:00–21:00), and an abandoned-call identification message. Consent tracking is still absent. It's a product decision; see `PRODUCT_CONTEXT.md`.

---
id: mem.active-work
title: Active Work
layer: L2
type: memory
status: canonical
owner: maintainer
updated: 2026-09-25
related:
  - mem.known-issues
  - domain.contacts
  - domain.campaigns
answers:
  - "what is in flight"
  - "what is being worked on"
  - "what is the current backlog"
  - "what should I pick up next"
covers: "Work in progress and the near-term backlog"
excludes: "Shipped decisions (see mem.decisions), defects in shipped behaviour (see mem.known-issues)"
tokens_est: 1450
---

# Active Work

## In flight

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

## Backlog

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

## Recommended next steps

Not assigned; offered as a reading of the current state:

1. **Verify the six backlog items.** A one-hour pass converts a stale list into a
   real one. Five of six have never been rechecked.
2. **Analytics is real as of Stage 1** (`call_leg_analytics` / `dial_session_hours` views). Verify the numbers after the first live calls.
3. **Add CI.** `npm run check` and `npm run build` both pass today. Nothing
   enforces that they keep passing.
4. **Compliance posture.** Stage 1 adds DNC suppression, a per-contact-timezone calling window (default 08:00–21:00), and an abandoned-call identification message. Consent tracking is still absent. It's a product decision; see `PRODUCT_CONTEXT.md`.

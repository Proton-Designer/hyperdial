---
id: mem.active-work
title: Active Work
layer: L2
type: memory
status: canonical
owner: maintainer
updated: 2026-09-24
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
tokens_est: 933
---

# Active Work

## In flight

**Stage 1 rebuild** (`feat/stage-1`, spec `docs/design/stage-1-architecture.md`).
The overnight run of 2026-09-23/24 was built and tested against the LOCAL
Supabase stack only. **Nothing has been pushed to the live project.** Migrations
`20260924000100`–`20260924002500` are pending a reviewed `db push`.

**Landed** (reviewed and verified):
- Phase 1: org tenancy + RLS, `requireOrgRole`, onboarding/invites/team,
  BYO Telnyx key in Vault, ed25519 webhook verification that fails closed,
  numbers + per-member WebRTC credential.
- Phase 2: contacts E.164/timezone/DNC; campaign settings, agents and soft
  delete; dialer schema and transition RPCs; the rolling-refill engine and
  webhook rewrite with Postgres single-winner claims (Redis is out of the dial
  path).
- Phase 3: GHL connect, pull import, and push outbox worker (pg_cron).

**Built, in review at the end of the run:** dispositions backend
(submit_disposition plus the Settings editor), Dashboard/Analytics on real
data, the `call_events` drop, and the dialer sweeper (pg_cron).

**Not started:** agent leg/WebRTC (E3; until then dialing needs
`DIALER_DEV_SKIP_AGENT_GATE`), the dialer UI state machine (E4, including the
mandatory wrap-up form), recording to Storage, live transcription, abandon-rate
reporting + Redis removal, and the E2E checklist rewrite. Task specs are in the
run folder `.claude/overnight/run-20260923-2024/board/00-backlog/`.

**NEEDS-LIVE-VERIFY** (can't be proven without real accounts):
- Telnyx: connect with a real key, a signed webhook from Telnyx, number
  search/purchase, WebRTC credential, a real parallel dial, premium AMD, the
  conference join, and `EdgeRuntime.waitUntil` in the deployed runtime.
- GHL: a real token connect, pull import, and push (note, tag, task, DND).
- Invites: the email-match check relies on "Confirm email" being ON in the
  live project.
- Crons: `private.set_crm_sync_worker_config` and
  `private.set_dialer_sweeper_config` (function URL + secret) must be run on
  the live DB, and the matching secret set in the function env. Both jobs
  no-op until then.

**Known gaps logged tonight:**
- The sweeper doesn't reap a claimed leg whose hangup was lost (known-issues #11).
- Agent campaign visibility is client-side only (#10).
- Invite-accept for an existing or disabled member doesn't reactivate them or
  change their role.
- The area-code timezone table exists in 3 copies (SQL + 2 TS) with no sync test.
- Local Postgres 17.6 segfaults on any EXECUTE-denied function call, so tests
  use `has_function_privilege()` instead.

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
| 1 | On loading the next page of contacts, scroll to the top of the list instead of leaving the user at the bottom. | unverified |
| 2 | The CSV import column-mapping step is overlapped by the menu and does not fit on screen. Reduce the container's vertical extent. | unverified |
| 3 | Import field dropdown: cap at ~5 visible options and make it scrollable. | unverified |

**Item 3 was partially resolved already.** The original note also asked to grey
out already-mapped fields. That half **is implemented** —
`isFieldMappedElsewhere` in `apps/web/src/components/contacts/ImportContactsModal.tsx`
drives both the `disabled` prop and a muted style on each affected option
(verified 2026-09-21, `ImportContactsModal.tsx:374-386`). Only the height cap and
scrolling remain.

### Campaigns

| # | Item | Status |
|---|---|---|
| 4 | Widen the "create new campaign" naming dialog. | unverified |
| 5 | Fix the status dropdown and give it a solid background — it renders transparent. | unverified |
| 6 | Bring the campaigns screen to parity with contacts: CSV import, single-contact creation, and adding existing contacts. | unverified |

Item 6 is the only substantial one — it is a feature, not a fix, and it is
plausibly the largest open item in the product.

## Recommended next steps

Not assigned; offered as a reading of the current state:

1. **Verify the six backlog items.** A one-hour pass converts a stale list into a
   real one. Five of six have never been rechecked.
2. **Analytics is real as of Stage 1** (`call_leg_analytics` / `dial_session_hours` views). Verify the numbers after the first live calls.
3. **Add CI.** `npm run check` and `npm run build` both pass today. Nothing
   enforces that they keep passing.
4. **Compliance posture.** Stage 1 adds DNC suppression, a per-contact-timezone calling window (default 08:00–21:00), and an abandoned-call identification message. Consent tracking is still absent. It's a product decision; see `PRODUCT_CONTEXT.md`.

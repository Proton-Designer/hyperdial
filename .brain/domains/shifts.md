---
id: domain.shifts
title: Shifts (intern weekly commitments)
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-10-19
sources:
  - docs/design/shifts.md
  - docs/design/shifts-build-spec.txt
  - supabase/migrations/20261006114226_shifts_schema.sql
  - supabase/migrations/20261006120116_shifts_intern_rpcs.sql
  - supabase/migrations/20261006124500_shifts_ghl_outbox_rpcs.sql
  - supabase/migrations/20261006130000_shifts_admin_rpcs.sql
  - supabase/migrations/20261006131500_shifts_ghl_hardening.sql
  - supabase/migrations/20261006143000_shifts_admin_followups.sql
  - supabase/migrations/20261006144500_shifts_open_hours_scope.sql
  - supabase/migrations/20261006140000_shifts_kpi_jobs.sql
  - supabase/migrations/20261006140100_shifts_cron.sql
  - supabase/migrations/20261019195842_shifts_signups_metric.sql
  - supabase/migrations/20261019200743_shifts_push_v2.sql
  - supabase/migrations/20261019201136_shifts_threshold_week_flag.sql
  - supabase/migrations/20261019201422_shifts_push_at_end_shift.sql
  - supabase/migrations/20261019204239_shifts_scheduled_times.sql
  - supabase/functions/_shared/shifts-core.ts
  - supabase/functions/_shared/shifts-io.ts
  - supabase/functions/_shared/shifts-admin.ts
  - supabase/functions/_shared/shift-ghl.ts
  - supabase/functions/_shared/shift-kpi-core.ts
  - apps/web/src/lib/api.ts
  - apps/web/src/components/Shifts.tsx
  - apps/web/src/components/TeamShifts.tsx
  - apps/web/src/contexts/ShiftsContext.tsx
  - apps/web/src/dev/ShiftsHarness.tsx
related:
  - domain.auth
  - domain.dialer
  - domain.crm
  - domain.analytics
answers:
  - "how do Shifts work"
  - "what is the weekly minimum and the pick deadline"
  - "who can see or edit whose shifts (pod scope)"
  - "how does a request to move, drop, add or lighten a week get approved"
  - "what counts toward the weekly hours"
  - "how are shift KPIs and Power weeks computed"
  - "how do shifts get into GoHighLevel"
  - "which edge functions and cron jobs belong to Shifts"
  - "where is the Shifts UI and how do I test it without a backend"
  - "what is still unverified live for Shifts"
covers: "The Shifts subsystem end to end: roles and pod scope, the week/deadline/minimum rules, change requests, tables and RPCs, the edge functions and cron jobs, shift KPIs, the GHL outbox, and the two frontend surfaces with their dev harness."
excludes: "The exact request/response JSON (docs/design/shifts.md section 3 is the contract; apps/web/src/lib/api.ts is its hand-synced client copy). The dial loop (.brain/domains/dialer.md). The generic GHL push/pull sync (.brain/domains/crm.md). Pod and role administration (.brain/domains/auth.md)."
tokens_est: 3820
source_hash: ab35ed2f491d1c81528f69b9798610957d4e9b4afdf3efbdbc10221d3207cdde
---

# Shifts

## Purpose

Interns (role `agent`) commit to dialing shifts for next week, the team sees coverage of the busiest hours, and managers approve
changes. Each shift is later scored from real dialing (KPIs), and everything is mirrored to the intern's GoHighLevel contact and
calendar. Off by default per org (`shift_settings.enabled`).

## Key concepts

| Term | Means |
|---|---|
| Intern / Henry | Intern = org member with role `agent` who participates (`shift_members.participates`, default true for agents). Henry = whoever manages them: `manager` (own pods only), `admin` or `owner` (whole org). Decision D1. |
| Pod scope | A manager sees and acts only on members of pods they manage (`org_manager_pods`, `org_members.pod_id`), via `private.shift_actor_sees`. Pods are assigned in Settings -> Team, not in Shifts. |
| Week | Monday-start local date (`week_start`) in `shift_settings.timezone`. All shift math and display use that zone, never the browser's. |
| Pick deadline | `lock_weekday` + `lock_time` (default Sunday 18:00). After it, next week's picks are locked; changes go through requests. |
| Weekly minimum | `min_weekly_hours` (default 8), overridable per week (`week_commitments.min_hours_override`, e.g. a light week). Counted hours = shifts in status `scheduled`, `completed`, `missed`; `excused` and `cancelled` do not count. |
| High leverage window | `power_windows`: times the team most wants covered. `shifts.power_minutes` is the overlap; coverage alerts below `power_coverage_alert` people; Power week = at least `power_week_pct` of active dialing inside windows. UI copy for Power weeks is positive only. |
| Change request | `shift_change_requests`: `move`, `drop`, `add`, `light_week`; reason at least 20 trimmed chars; `is_late` when closer than `change_notice_hours`; one pending request per shift. |
| Outbox | `shift_ghl_outbox`: queued GHL work (appointment, contact fields, note, tag) written in the same transaction as the change. |

## Rules that are easy to get wrong

- Roles come from `org_members`, there is no profiles table (D1). `enabled` and `timezone` are owner/admin only; manager-level may write the other settings, open hours and high leverage windows. That config is org-wide by design (one config per org, the manager owns it), so a pod-scoped manager's change applies to every pod. A manager cannot decide their own request (403 `self_review`); owner/admin can.
- Request approval (`review_shift_request`, one transaction): `move` updates the SAME shift row (keeps `ghl_appointment_id`) and stays inside its week; `drop` sets `excused` and, if it takes counted hours under the week's effective minimum, needs an explicit acknowledgement (409 `under_minimum_needs_ack {hoursAfter, minimum}`) and then sets `min_hours_override` to the new total; `add` inserts `source='request'`; `light_week` sets the flag + override. Always recompute week hours, notify the intern, enqueue the GHL event. A non-pending request is 409 `not_pending`.
- Overlaps are impossible: a gist exclusion constraint on scheduled shifts per user; SQL maps it to 422 `overlap`.
- Intern functions refuse with 409 `shifts_disabled` while the org has it off. Names: interns see "First L.", manager-level callers see full names.
- Every admin RPC takes the caller as an argument and re-checks role + pod scope itself (service_role-only EXECUTE), so a function-level bug cannot widen access.

## Where the code lives

| What | Path | Notes |
|---|---|---|
| Schema, config seeding | `supabase/migrations/20261006114226_shifts_schema.sql` | 9 tables, all with `org_id` + RLS; `private.ensure_shift_config` seeds defaults on the first read |
| Intern RPCs | `.../20261006120116_shifts_intern_rpcs.sql` | `submit_week`, `create_shift_request`, `withdraw_shift_request`, `shift_week_roster` |
| Admin RPCs | `.../20261006130000_shifts_admin_rpcs.sql` | `review_shift_request`, `admin_update_shift`, setup upserts, `shift_admin_members`, `admin_retry_shift_outbox` |
| KPI + week jobs (S05) | `.../20261006140000_shifts_kpi_jobs.sql`, `_shared/shift-kpi-core.ts` | `shift_kpi_due/inputs/save`, `shifts_week_lock_run`, `shifts_week_close_run`, off-shift dialing trigger (D14) |
| Cron | `.../20261006140100_shifts_cron.sql` | reuses the ghl-sync-worker config and secret; no new secret |
| Edge functions | `supabase/functions/` | intern: `shifts-week-get`, `shifts-submit-week`, `shift-requests-create`, `shift-requests-withdraw`. admin: `admin-shifts-overview`, `admin-shift-requests-review`, `admin-shift-update`, `admin-shift-settings-update`, `admin-open-hours-upsert`, `admin-power-windows-upsert`, `admin-profiles-upsert`, `admin-ghl-find-contact`, `admin-ghl-retry`. jobs: `shift-ghl-sync`, `shift-kpi-compute`, `shifts-week-lock`, `shifts-week-close` |
| Shared edge code | `_shared/shifts-core.ts` (mappers, error codes), `shifts-io.ts` (auth shell, hydration), `shifts-admin.ts` (parsers, rollup) | the client contract is hand-synced with `apps/web/src/lib/api.ts` |
| Intern UI | `apps/web/src/components/Shifts.tsx`, `components/shifts/*` | My Shifts, Pick Next Week (drag grid, phone day view), Requests, request modal |
| Manager UI | `apps/web/src/components/TeamShifts.tsx`, `components/team-shifts/*` | Coverage heatmap, Requests queue, Shift KPIs, Setup |
| Dialer banner | `components/shifts/ShiftDialerBanner.tsx`, `contexts/ShiftsContext.tsx` | informational only, never blocks dialing |
| Dev harness | `apps/web/src/dev/ShiftsHarness.tsx` + `ShiftsTeamFixtures.ts` | `?dev_shifts=1&view=intern|team|dialer&scenario=...`; a fixture backend for every function |

## How it flows

1. Intern opens Pick Next Week, paints half-hour slots inside open hours, submits (`submit_week`): shifts + commitment, event "Week submitted" queued.
2. Hourly `shifts-week-lock` (after the deadline, once per org per week) flags Not submitted / Under minimum. After the deadline changes are requests; Henry approves or denies (Requests tab), or edits a shift directly (`admin_update_shift`, source `admin`).
3. `shift-kpi-compute` (every 15 min) derives KPIs per shift from `agent_state_events` (active dialing time, D5) and `call_legs` of kind contact (dials, connects, conversations, D6), flags late start / idle / low adherence, finalises shifts that ended more than 2 hours ago (`completed` or `missed`).
4. Monday after 00:30 local `shifts-week-close` computes `power_dial_pct` and `power_week`, queues Week closed / Power week.
5. Every change queues outbox rows; `shift-ghl-sync` (every minute, also nudged after writes) drains them per org through the org's own GHL connection. Appointments use GHL API Version 2021-04-15, contacts 2021-07-28. A 429 delays that row (60 s, or Retry-After up to 1 h) and releases the rest of the org's batch; a run stops after 100 s; a 401/403 pauses that org; failures show in Setup -> Sync health with Retry.

## GHL data sync additions (2026-10-19)

From Kareem's `ghl-data-sync` spec (§2, §3); the field list he follows is `docs/guides/ghl-data-sync-setup.md` §2b.

- **Sign-ups and conversion** (`20261019195842`): `shift_kpis.sign_ups` and `conversion_rate_pct`; a sign-up is a leg whose disposition has `dispositions.is_win` (`shift_kpi_inputs` legs carry `is_win`, `shift_kpi_save` stores it; `shift-kpi-core.ts`). Conversion = sign-ups ÷ conversations, null when there are no conversations. `private.shift_week_sign_totals` holds the week totals. API: `ShiftKpi.signUps/conversionRatePct` (`mapKpi` in `shifts-core.ts`, `api.ts`), the Sign-ups and Conversion columns in `ShiftKpiTable.tsx`, and Sign-ups in the weekly rollup (`buildRollup` in `shifts-admin.ts`, `AdminShiftRollupRow`).
- **Conversation threshold default is 30 s** (was 60; `20261019201136` also moved org rows still at 60). The Setup field ("Conversation length", `SettingsForm.tsx`) shows whatever the org stores; `docs/guides/shifts-setup.md` now says 30.
- **Pushed per shift** (`private.shift_last_fields`, `private.enqueue_shift_event`, latest definitions in `20261019201136` + `20261019201422`; chain: `20261006114226` → `20261019200743` → `20261019201136` → `20261019201422`): `last_shift_sign_ups`, `last_shift_connect_rate_pct`, `last_shift_conversion_rate_pct`, `last_shift_scheduled_start` / `_scheduled_end` (TASK-G24, `20261019204239`: the shift's own start/end, same ISO format, `private.shift_last_fields` carries them for shift_ended, completed and missed), `last_shift_clock_in_at` / `_clock_out_at` (org-zone ISO text via `private.shift_iso_local`), `last_shift_clock_in_late_minutes`, the six survey keys (`last_shift_top_objection`, `_objection_note`, `_what_worked`, `_slowed_by`, `_slowed_note`, `_list_quality`; only when a survey exists), and the tag `shift-evt-late-start`.
- **Pushed per week:** `week_sign_ups`, `week_connects`; at Week closed also `week_hours_vs_min` (active dialing hours minus the week's effective minimum) and `week_under_minimum` (Yes/No). No tag is added for it; `shift-evt-under-minimum` stays the Sunday scheduled-hours signal.
- **End shift pushes immediately.** `clock_shift('end')` queues a `shift_ended` event inside its own exception block (it can never fail End shift): contact fields only (clock times, survey, the last `shift_kpis` row's counts as of the last 15-minute pass, week totals), no appointment, note or tags, and no `last_shift_status`. The full push at finalize (>2 h after `ends_at`) is unchanged and alone adds the completed/missed tags.
- **Missing GHL custom fields are skipped** (`shift-ghl.ts:513-521`): the row completes, with `skippedFields`; `shift-ghl-sync/index.ts:101-104` logs a `console.warn`. Not shown in Sync health.

## Testing without a backend

Open `http://localhost:3000/?dev_shifts=1&view=team` (or `view=intern`, `view=dialer&scenario=live|soon|outside|none`). Scenarios (default, unsubmitted, under_minimum, deadline_passed, power_week, empty, disabled, error, slow, review_error, ...) are listed in `dev/ShiftsHarness.tsx`. The two harness files import each other: never read harness exports at module load in the fixtures file (blank page, no error).

## NEEDS-LIVE-VERIFY (state at 2026-10-06)

- GHL: (custom-field keys without a definition are skipped and logged, never an error: `shift-ghl.ts:513-521`; the 2026-10-19 push fields are verified only by rolled-back SQL runs and unit tests) calendar id, custom-field definition ids, tags and the contact search by email (`GET /contacts/?query=`) have not run against a real location; `""` for a cleared NUMERICAL/DATE field is untested. See `.brain/memory/known-issues.md`.
- KPI jobs and cron (S05) and the live Team Shifts screens have only been exercised by dry-runs and the harness; the real-shell checks (tab-bar offset of the sticky footer, Manage-pods deep link, banner inside the real Dialer) are unverified.
- Only the QA org has Shifts enabled; never switch it on for another org without the owner's say.

Decisions behind the shape: `.brain/memory/decisions.md` (Shifts entry).

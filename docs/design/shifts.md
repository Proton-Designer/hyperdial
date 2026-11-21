# Shifts subsystem: design mapping (lead, 2026-10-06)

The product spec is `docs/design/shifts-build-spec.txt` (Kareem, Oct 6 2026). It was written against an
old public commit (single-user tables, `Frontend/`, `call_logs`). **This file maps it onto the current
codebase and wins wherever the two disagree.** Anything the spec says that is not overridden here is
required as written (rules, KPIs, flags, event map, GHL field keys, tags, acceptance checklist).

## 1. Mapping decisions (D-numbers are referenced from task files)

| #   | Spec says                                                                     | We build                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Why                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | `profiles` table with role intern/manager/admin, `is_manager()`               | **No profiles table.** Tenancy = `org_members` (roles owner/admin/manager/agent). intern = `agent`; Henry = `manager` or `admin`; Kareem/Ayman = `owner`/`admin`. "Manager-level" = `private.has_org_role(org, array['owner','admin','manager'])`. Manager visibility over other people's rows follows the codebase rule `private.is_agent_in_callers_pod_scope(org, user)` (owner/admin = whole org, manager = own pods), same as `list_agent_schedules`.                                                                                                                                                                                                                                       | The org/pod model already exists; a 2nd role system would conflict. If Henry must see every intern, make him `admin` (OPEN_QUESTIONS).                                                |
| D2  | Global single-row settings, global open_hours/power_windows                   | **Every new table has `org_id`** (FK orgs, on delete cascade). `shift_settings` PK = `org_id`; `open_hours` PK `(org_id, iso_weekday)`; `power_windows.org_id`. Rows are created lazily by `private.ensure_shift_config(org)` (inserts the spec defaults if missing; idempotent), called by every shifts function.                                                                                                                                                                                                                                                                                                                                                                               | Multi-tenant app.                                                                                                                                                                     |
| D3  | Feature on for everyone                                                       | `shift_settings.enabled boolean not null default false`. The intern **Shifts** tab shows only when enabled. **Team Shifts** shows to owner/admin/manager always; when disabled it shows an "Enable Shifts" setup card (owner/admin). Every intern function returns 409 `shifts_disabled` when off.                                                                                                                                                                                                                                                                                                                                                                                               | Off-by-default convention for new features in this repo.                                                                                                                              |
| D4  | `profiles.ghl_contact_id`, `profiles.active`                                  | New table `shift_members(org_id, user_id, ghl_contact_id text, participates boolean not null, created_at, updated_at, PK(org_id,user_id), unique(org_id, ghl_contact_id))`. Missing row = participates if role = 'agent'. "Interns" in lock/close/coverage jobs = active org members who participate. Names/emails come from the existing member-name source (find it: `20260929154003_name_email_fallbacks.sql` / org-members function) — never a new name column.                                                                                                                                                                                                                              | Keeps org_members untouched.                                                                                                                                                          |
| D5  | New `dialer_session_events` + edits to dialer-session-start/pause/resume/stop | **Reuse `agent_state_events`** (migration 20260927070000): one row per dial_sessions state, server clock, written by the dial_sessions insert trigger + `transition_session` (covers start, pause, resume, stop AND engine-driven completion). Active interval = a row whose `state` is NOT in (`paused`,`paused_agent_lost`,`stopped`,`completed`). Unclosed row (ended_at null) whose session is no longer live, or still live at compute time → close at min(now, last contact-leg ended_at in that session + `open_session_tail_minutes`) (if no legs: started_at + tail). _*No change to dialer-engine.ts or any dialer-session-* function._*                                               | Same data, already in production; avoids touching the 4-function shared engine (hard constraint). Answers spec open question 2 (resume = dialer-session-resume → transition_session). |
| D6  | `call_logs` (started_at, amd_result, status, duration_seconds, disposition)   | `call_legs` where `kind='contact'`, agent = `dial_sessions.agent_id` via `session_id`. Dial time = `call_legs.created_at`. ended = `ended_at`. **connect** = `outcome = 'connected'` OR `amd_result in ('human','not_sure','human_residence','human_business')`. conversation = connect with `duration_seconds >= conversation_min_seconds`. voicemail = `amd_result = 'machine'` OR `outcome = 'machine'`. no_answer = `outcome = 'no_answer'`. talk = sum(duration_seconds of connects)/60. Dispositions = `dispositions.label` via `call_legs.disposition_id`. Cross-check these against `call_leg_analytics` and reuse its definitions if they differ (note any difference in the task log). | Current schema. Answers spec open question 1: dispositions live in Postgres (`call_legs.disposition_id`).                                                                             |
| D7  | `GHL_TOKEN`, `GHL_LOCATION_ID` env secrets                                    | Token + location come from the org's existing GHL connection (`org_integrations` + Vault; read it exactly the way `ghl-sync-worker` does). Calendar id and Henry's GHL user id are **per-org columns** `shift_settings.ghl_calendar_id`, `ghl_owner_user_id` (Setup screen). No new env secrets. Org not connected or calendar unset → outbox rows stay `pending`/`error` with a clear `last_error`, never a crash.                                                                                                                                                                                                                                                                              | Per-org BYO GHL already exists.                                                                                                                                                       |
| D8  | `ghl_outbox`                                                                  | Table **`shift_ghl_outbox`** (spec columns + `org_id`), drained by new function **`shift-ghl-sync`** (pg_cron every minute + invoked after writes). HTTP via `_shared/ghl-client.ts` patterns (extend it or add `_shared/shift-ghl.ts`; reuse the rate limiter). Do not touch `crm_sync_jobs`/`ghl-sync-worker`.                                                                                                                                                                                                                                                                                                                                                                                 | Separate concern (intern contact, not lead contact).                                                                                                                                  |
| D9  | Notifications for managers/intern                                             | Existing `public.notifications` (has `org_id`, `user_id`, `data jsonb`). Read its columns/types before inserting; reuse its type vocabulary or add values in the same migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Exists.                                                                                                                                                                               |
| D10 | Cron via pg_cron + pg_net                                                     | Same pattern as existing cron migrations (e.g. `20260924001700_dialer_sweeper_cron.sql`, `20260926080400_reliability_alerts.sql`): copy their auth/secret approach exactly. Cron-invoked functions get `verify_jwt = false` in `supabase/config.toml` and check the cron secret. Jobs are idempotent per org/week: `shift_settings.last_locked_week date`, `last_closed_week date`.                                                                                                                                                                                                                                                                                                              | Exists.                                                                                                                                                                               |
| D11 | Tab ids `shifts`, `team`                                                      | `shifts` (CalendarClock, "Shifts") and **`team_shifts`** (UsersRound is taken by Team → use `CalendarRange`, "Team Shifts", minRole manager). `team` already exists. Add both to `TabType`, TAB_PATHS (`/shifts`, `/team-shifts`), AGENT/MANAGER allowed lists.                                                                                                                                                                                                                                                                                                                                                                                                                                  | Collision.                                                                                                                                                                            |
| D12 | `Frontend/src/...`                                                            | `apps/web/src/components/Shifts.tsx`, `components/shifts/*`, `components/TeamShifts.tsx`, `components/team-shifts/*`. Client calls go in `apps/web/src/lib/api.ts`, types matching §3 exactly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Current layout.                                                                                                                                                                       |
| D13 | Existing related features                                                     | `agent_schedules` (manager-set recurring hours) and `power_hours` (sprints) are separate features and stay untouched. Shifts' "power windows" are unrelated to power_hours; never reuse those names in UI copy.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Avoid scope creep.                                                                                                                                                                    |
| D14 | Off-shift dialing queued in dialer-session-start                              | A guarded AFTER INSERT trigger on `dial_sessions` (`exception when others` → never blocks the insert, R-042) calls `private.enqueue_off_shift_dialing(session)`: if shifts enabled for the org and the agent participates and has no scheduled shift overlapping [now-15min, now+15min] → queue the Off-shift dialing event. No edge-function change. The Dialer banner is client-side.                                                                                                                                                                                                                                                                                                          | Keeps the dialer path untouched.                                                                                                                                                      |

## 2. Database (one schema migration + one cron migration; real-time names `date +%Y%m%d%H%M%S`)

Spec DDL applies with D2/D4/D8 changes: drop `profiles`; add `org_id` everywhere; FKs to `auth.users(id)`
instead of `profiles`; `shift_settings` gains `org_id PK, enabled, ghl_calendar_id, ghl_owner_user_id,
last_locked_week, last_closed_week, updated_at`; `ghl_outbox` → `shift_ghl_outbox` (+org_id, +event text
for the human-readable event name); `shift_kpis` + `org_id`; no `dialer_session_events`; no `call_logs`
alter. Keep every spec check constraint (30-min marks, ≥30 min, reason ≥20 trimmed chars, request-shape
checks), the gist exclusion (scope it `(org_id with =, user_id with =, tstzrange with &&) where status='scheduled'`),
and the partial unique index one_open_request_per_shift.

RLS (every table): SELECT own rows (`user_id = auth.uid()` and member of org) OR manager-level in
pod scope; config tables (settings/open_hours/power_windows) SELECT for any active org member; **no
client INSERT/UPDATE/DELETE policies**; `shift_ghl_outbox`: no policies. All writes go through
service-role edge functions / security-definer SQL. Revoke execute on write RPCs from anon/authenticated
(service_role only).

SQL functions (security definer, `set search_path = ''` or `public`, fully qualified):

- `submit_week(p_org, p_user, p_week_start, p_blocks jsonb)` — spec algorithm verbatim (deadline,
  bad_block with index, merge, overlap, per-date tz conversion, under_minimum, power_minutes, diff on
  exact (starts_at, ends_at, activity), commitments upsert, outbox events). Errors raised with
  `raise exception using errcode = 'P0001', message = '<code>', detail = '<json>'` so the edge function can
  return `{ error: code, ... }`; the UI turns codes into sentences.
- `private.shift_power_minutes(p_org, p_starts_at, p_ends_at)` — computed in local tz per date.
- `review_shift_request(...)`, `admin_update_shift(...)`, `create_shift_request(...)`,
  `withdraw_shift_request(...)` — each one transaction, spec rules, outbox events.
- `private.enqueue_shift_event(p_org, p_user, p_event text, p_shift uuid, ...)` — the ONE place that
  turns an event-map row into outbox rows in order: appointment → contact_fields → contact_note →
  tags (remove then add). Field values are computed in SQL from current data at enqueue time, BUT
  `shift-ghl-sync` re-reads the shift for appointment rows (spec rule).

## 3. API contract (edge functions; all JSON; times ISO-8601 UTC unless named `date`/`start`/`end`)

Errors: non-2xx with `{ "error": "<code>", "message": "<human sentence>", ...detail }`. Codes: `unauthorized`
401, `forbidden` 403, `shifts_disabled` 409, `deadline_passed` 409, `bad_block` 422 `{index}`, `overlap` 422
`{index}`, `under_minimum` 422 `{hours, minimum}`, `outside_open_hours` 422, `bad_time_step` 422,
`reason_too_short` 422, `shift_started` 409, `request_pending` 409, `under_minimum_needs_ack` 409
`{hoursAfter, minimum}`, `not_found` 404, `ghl_not_connected` 409.

**Additions from S01/S02 (eng1, lead-approved 12:2x; full list in the run's audit/S02/notes.md):**
`bad_week` 422 (week is not a Monday) · `bad_request` 422 `{reason}` (bad_type, missing_time, bad_activity,
light_week_hours, past_week, missing_shift, bad_date, bad_time, bad_shift_id) · `not_pending` 409 · `server_error` 500 ·
`method_not_allowed` 405. `bad_block` detail = `{index, reason}` on submit (reason: bad_format, outside_week, bad_time_step,
end_before_start, bad_activity, outside_open_hours); a request's new time gives `{reason:'in_the_past'}` with no index.
`overlap` may omit `index` (`{reason:'conflicts_with_existing_shift'}`). `under_minimum` counts every counted shift that week
(picks + request/admin shifts; counted = scheduled, completed, missed). light_week takes an optional `date` (any day of the
target week, default next week); requestedMinHours > 0 and below the org minimum. Every timestamp in a response is UTC `...Z`;
`weekStart`/`date` are plain `YYYY-MM-DD`. `myShifts` holds every status (the client hides cancelled); roster = scheduled +
completed shifts. hoursBefore/hoursAfter use the counted-hours rule above.

**Additions from the live UI QA (lead, 15:4x; TASK-QF):** `WeekInfo.beforeLaunch: boolean` (the week's pick deadline is before
`shift_settings.enabled_at`, the moment Shifts was first switched on; such weeks are neutral: no red under-minimum, no "not submitted",
no coverage alarms, and the lock/close jobs never flag them). `ShiftRequest.weekMinimum: number` (the effective minimum for that
request's week, after any override). `syncHealth.pendingCount: number` (all pending outbox rows of the org) and
`syncHealth.ghlConnected: boolean`. admin overview `requests` = every pending request (oldest first) + requests decided in the last 14
days (newest first), regardless of the week being viewed.

Shared types (mirror exactly in `api.ts`):

```ts
type Activity = 'dialing' | 'follow_up' | 'social';
type ShiftStatus = 'scheduled' | 'cancelled' | 'completed' | 'missed' | 'excused';
interface ShiftSettings {
  enabled: boolean;
  timezone: string;
  minWeeklyHours: number;
  lockWeekday: number;
  lockTime: string /*HH:MM*/;
  changeNoticeHours: number;
  graceMinutes: number;
  conversationMinSeconds: number;
  idleFlagMinutes: number;
  adherenceFlagPct: number;
  openSessionTailMinutes: number;
  powerCoverageAlert: number;
  powerWeekPct: number;
  ghlCalendarId: string | null;
  ghlOwnerUserId: string | null;
}
interface OpenHours {
  isoWeekday: number;
  openFrom: string;
  openUntil: string;
} // 'HH:MM'
interface PowerWindow {
  id: string;
  label: string;
  isoWeekdays: number[];
  startTime: string;
  endTime: string;
  active: boolean;
}
interface Shift {
  id: string;
  userId: string;
  weekStart: string;
  activity: Activity;
  startsAt: string;
  endsAt: string;
  hours: number;
  powerMinutes: number;
  status: ShiftStatus;
  source: 'pick' | 'request' | 'admin';
  ghlSyncStatus: 'pending' | 'synced' | 'error';
  hasPendingRequest: boolean;
}
interface RosterEntry {
  userId: string;
  name: string /* "Sara K." for agents, full name for manager-level callers */;
  activity: Activity;
  startsAt: string;
  endsAt: string;
  isMe: boolean;
}
interface WeekCommitment {
  weekStart: string;
  submittedAt: string | null;
  scheduledHours: number;
  powerHours: number;
  powerDialPct: number | null;
  powerWeek: boolean;
  lightWeek: boolean;
  minHoursOverride: number | null;
}
interface ShiftKpi {
  shiftId: string;
  userId: string;
  final: boolean;
  computedAt: string;
  scheduledMinutes: number;
  activeDialMinutes: number;
  powerActiveMinutes: number;
  adherencePct: number;
  firstDialAt: string | null;
  lastCallEndAt: string | null;
  lateStartMinutes: number;
  earlyEndMinutes: number;
  longestIdleMinutes: number;
  dials: number;
  connects: number;
  conversations: number;
  voicemails: number;
  noAnswers: number;
  talkMinutes: number;
  dialsPerActiveHour: number | null;
  connectRatePct: number | null;
  dispositions: Record<string, number>;
  flags: string[];
}
interface ShiftRequest {
  id: string;
  userId: string;
  userName: string;
  weekStart: string;
  type: 'move' | 'drop' | 'add' | 'light_week';
  fromShift: Shift | null;
  toStartsAt: string | null;
  toEndsAt: string | null;
  toActivity: Activity | null;
  requestedMinHours: number | null;
  reason: string;
  isLate: boolean;
  status: 'pending' | 'approved' | 'denied' | 'withdrawn';
  reviewerName: string | null;
  reviewerNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  hoursBefore: number;
  hoursAfter: number; /* the intern's week hours if approved */
}
interface WeekInfo {
  weekStart: string;
  timezone: string;
  deadlineAt: string;
  deadlinePassed: boolean;
  isCurrentWeek: boolean;
  isNextWeek: boolean;
  minHours: number; /* effective, after override */
}
```

| Function                                                  | Method                                                  | Input                                                                                                                                        | Output                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shifts-week-get`                                         | GET `?week=YYYY-MM-DD` (Monday; omitted = current week) | —                                                                                                                                            | `{ role, week: WeekInfo, settings, openHours, powerWindows, roster: RosterEntry[], myShifts: Shift[], commitment: WeekCommitment                                                                                                                                                                                                                                                                                                                                                                                    | null, kpis: ShiftKpi[], myRequests: ShiftRequest[] /* last 60 days, newest first */, powerWeekHistory: {weekStart:string, sentence:string}[], liveShift: Shift | null /* in progress or starting within 15 min, for the dialer banner */ }` |
| `shifts-submit-week`                                      | POST                                                    | `{ weekStart, blocks: {date,start,end,activity}[] }`                                                                                         | `{ shifts: Shift[], commitment }` then fire-and-forget invoke `shift-ghl-sync`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `shift-requests-create`                                   | POST                                                    | `{ type, fromShiftId?, date?, start?, end?, toActivity?, requestedMinHours?, reason }` (move/add times as local date + HH:MM, same as picks) | `{ request: ShiftRequest }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `shift-requests-withdraw`                                 | POST                                                    | `{ requestId }`                                                                                                                              | `{ request }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `shift-kpi-compute`                                       | POST                                                    | cron: `{}` (all orgs); client: `{ shiftId }` (own shift, or manager in scope) → live numbers, never finalizes from a client call             | `{ kpis: ShiftKpi[] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `admin-shifts-overview`                                   | GET `?week=`                                            | —                                                                                                                                            | `{ week, settings, openHours, powerWindows, members: {userId,name,email,role,participates,ghlContactId,podId,podName}[], shifts: (Shift & {userName})[], commitments: (WeekCommitment & {userId})[], requests: ShiftRequest[] /* pending (any week) oldest first + this week's decided */, kpis: ShiftKpi[], rollup: {userId,name,hoursScheduled,hoursDialing,powerDialPct,dials,conversations,missedShifts,powerWeek}[], powerWeekCallouts: {userId, sentence}[], syncHealth: {errorCount:number, lastError:string | null, rows:{id,kind,event,userName,lastError,attempts,createdAt}[]} }`                                                                                         |
| `admin-shift-requests-review`                             | POST                                                    | `{ requestId, decision: 'approve'                                                                                                            | 'deny', note?, allowUnderMinimum? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `{ request }`                                                                                                                                                  |
| `admin-shift-update`                                      | POST                                                    | `{ action: 'create'                                                                                                                          | 'move'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 'cancel'                                                                                                                                                       | 'excuse', shiftId?, userId?, date?, start?, end?, activity? }`             | `{ shift }` |
| `admin-power-windows-upsert`                              | POST                                                    | `{ id?, label, isoWeekdays, startTime, endTime, active }`                                                                                    | `{ powerWindow }` (recompute power_minutes for scheduled shifts in weeks not yet started)                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `admin-open-hours-upsert`                                 | POST                                                    | `{ rows: OpenHours[] }` (full replace)                                                                                                       | `{ openHours }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `admin-shift-settings-update`                             | POST                                                    | `Partial<ShiftSettings>` (owner/admin only for `enabled`)                                                                                    | `{ settings }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `admin-profiles-upsert`                                   | POST                                                    | `{ userId, ghlContactId?: string                                                                                                             | null, participates?: boolean }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `{ member }`                                                                                                                                                   |
| `admin-ghl-find-contact`                                  | POST                                                    | `{ email }`                                                                                                                                  | `{ contacts: {id,name,email}[] }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `admin-ghl-retry`                                         | POST                                                    | `{ outboxId? }` (omitted = all error rows of the org)                                                                                        | `{ reset: number }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `shifts-week-lock`, `shifts-week-close`, `shift-ghl-sync` | POST (cron)                                             | `{}`                                                                                                                                         | `{ ok, ... }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Admin functions: manager-level role check server-side → 403 otherwise; pod scope applies to which
interns a manager may see/act on. Settings/open-hours/power-windows writes: owner/admin/manager (spec gives
Henry this), `enabled` owner/admin only.

## 4. Display rules (frontend)

- **All times render in `settings.timezone`** (Intl `timeZone`), never the browser zone. Week grid slots
  are built from `openHours` rows (no row = day hidden; Sunday closed by default).
- Interns see roster names as "First L."; manager-level callers get full names (server decides).
- Power-week copy is positive only. Never show a shortfall below the threshold.
- Use existing `components/ui/*` (tabs, table, dialog, badge, progress, tooltip, sheet, select) and the
  current dark theme tokens. Match existing screens (Team.tsx, schedules/*) for spacing/typography.
  Every surface ships loading / empty / error states and works at 390 px.

## 4b. Clock in/out + end-of-shift survey (user request 2026-10-06, after the spec)

Interns press **Start shift** when they begin and **End shift** when they finish. Henry sees whether they started on time
against the time they picked, and every ended dialing shift carries a short survey.

Rules (server-enforced):

- Start is allowed from 15 min before `starts_at` until `ends_at`, only for the caller's own `scheduled` shift, once (idempotent:
  a second start returns the existing clock-in). Server clock only. `clockInLateMinutes = max(0, clockedInAt - startsAt)` in
  whole minutes; > `grace_minutes` adds the KPI flag `late_clock_in`. No clock-in by the time the shift is finalized adds
  `no_clock_in` (not for shifts that are excused/cancelled). A `no_show` shift (zero dials) keeps the single flag `no_show`; the clock flags are not added to it.
- End is allowed any time after Start (an early end is fine; it shows as early). For a **dialing** shift End REQUIRES the survey in the
  same call; for follow_up/social shifts End takes no survey. A shift never ended is closed by the KPI finalize step at `ends_at`
  (`clockedOutAt` stays null, `survey` stays null, flag `no_clock_out`).
- Survey: `topObjection` one of `too_busy | enough_work | fees | dont_trust_apps | not_interested_app_jobs | other` + `objectionNote`
  (required, 3..500 chars trimmed: "how they handled it"); `whatWorked` (required, 3..500: the opener, line or rebuttal that kept someone on
  the phone); `slowedBy` one of `bad_numbers | dialer_issue | didnt_know_answer | script_off | nothing` + `slowedNote` (required unless
  `nothing`, max 500); `listQuality` integer 1..5. Stored once per shift (`shift_surveys`, RLS like shift_kpis: own or manager in pod scope).
- GHL: no new custom fields or tags (they'd need Kareem's setup). The clock-in time, lateness and the survey answers go into the
  existing Shift completed / Shift missed **note** body.

API:

| Function                                                                                                                 | Method | Input                                                                                     | Output             |
| ------------------------------------------------------------------------------------------------------------------------ | ------ | ----------------------------------------------------------------------------------------- | ------------------ |
| `shift-clock`                                                                                                            | POST   | `{ shiftId, action: 'start' }` or `{ shiftId, action: 'end', survey?: ShiftSurveyInput }` | `{ shift: Shift }` |
| Errors: `not_found` 404, `shift_not_scheduled` 409, `too_early` 409 `{opensAt}`, `shift_over` 409, `not_clocked_in` 409, |
| `survey_required` 422, `bad_survey` 422 `{field}`, `already_ended` 409.                                                  |

```ts
type TopObjection =
  'too_busy' | 'enough_work' | 'fees' | 'dont_trust_apps' | 'not_interested_app_jobs' | 'other';
type SlowedBy = 'bad_numbers' | 'dialer_issue' | 'didnt_know_answer' | 'script_off' | 'nothing';
interface ShiftSurveyInput {
  topObjection: TopObjection;
  objectionNote: string;
  whatWorked: string;
  slowedBy: SlowedBy;
  slowedNote: string | null;
  listQuality: 1 | 2 | 3 | 4 | 5;
}
interface ShiftSurvey extends ShiftSurveyInput {
  submittedAt: string;
}
// Shift gains: clockedInAt: string|null; clockedOutAt: string|null; clockInLateMinutes: number|null; survey: ShiftSurvey|null
// ShiftKpi gains: clockedInAt, clockedOutAt, clockInLateMinutes (same meaning); flags may include late_clock_in, no_clock_in, no_clock_out
// admin overview gains: surveySummary: { responses: number, topObjections: Record<TopObjection, number>,
//   slowedBy: Record<SlowedBy, number>, avgListQuality: number|null } for the viewed week (pod-scoped)
```

`liveShift` (shifts-week-get) carries the clock fields, so the dialer banner can show Start / End.

## 5. Not in this build

Spec out-of-scope list, the optional event_webhook kind, the optional GHL→app webhook. GHL workflows are
built by Kareem in GHL (no code). Live GHL verification needs Kareem's calendar + custom fields + a connected
org → NEEDS-LIVE-VERIFY until then.

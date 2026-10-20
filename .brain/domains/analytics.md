---
id: domain.analytics
title: Analytics & Notifications
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-27
sources:
  - supabase/migrations/20260924002400_analytics_real_data.sql
  - supabase/migrations/20260925020000_call_legs_duration_conversations.sql
  - supabase/migrations/20260926080300_dialer_analytics_v2.sql
  - supabase/functions/dashboard-stats/index.ts
  - supabase/functions/team-performance/index.ts
  - supabase/functions/analytics-summary/index.ts
  - supabase/functions/ensure-week-summary/index.ts
  - supabase/functions/_shared/analytics-core.ts
  - apps/web/src/components/Dashboard.tsx
  - apps/web/src/components/Analytics.tsx
  - apps/web/src/components/Team.tsx
  - supabase/migrations/20260925080100_team_view.sql
  - supabase/migrations/20260927144900_org_timezone_and_stats_fixes.sql
  - apps/web/src/lib/api.ts
related:
  - domain.dialer
  - domain.dispositions
  - domain.auth
answers:
  - "is the Analytics screen real data or a mock"
  - "where do the Dashboard's Calls Today / Connect Rate / Talk Time / Conversations-per-hr numbers come from"
  - "how is live conversations per agent-hour computed"
  - "what counts as a conversation"
  - "why was Talk Time always 0m"
  - "how is the weekly summary notification created and when"
  - "how are in-app notifications listed, counted and marked read"
  - "where does the manager Team page's live board / per-intern daily table get its data"
  - "how does an org set its own timezone, and what uses it"
  - "where does the Team page's Attendance tab / Fairness metric / My stats self-view get its data"
covers: "The Dashboard metrics, the Analytics screen, the call_leg_analytics/dial_session_hours views behind them, the weekly-summary job, the in-app notification bell, org timezone settings, and the Team page's Attendance/Fairness/My-stats additions (MISSION-5 TASK-M5-A4)."
excludes: "The dial loop and call_legs state machine that produces the source data — see .brain/domains/dialer.md. Dispositions themselves — see .brain/domains/dispositions.md."
tokens_est: 6795
source_hash: ad1df443285e98847f145fb368d226dd30e6672ef1eb8f505c233845da8c7cd9
---

# Analytics & Notifications

## Purpose

HyperDial exists to raise live conversations per agent hour (CLAUDE.md/design §8), so the Dashboard and Analytics screens surface that number and its supporting metrics from real call data — no
mock data, no empty-by-construction tables, as of TASK-P4-P1.

## Key concepts

| Term | Means |
|---|---|
| `call_leg_analytics` | A `security_invoker` view over `call_legs` (kind='contact') joined to `dial_sessions` (for `agent_id`) and `dispositions`. Every analytics query reads this now, not `call_events`. |
| `dial_session_hours` | A `security_invoker` view: one row per dial session, `session_hours` = wall-clock `ended_at - started_at`, null while a session is still running. The agent-hours denominator for the north-star metric. |
| Conversations / agent-hour | `count(is_connected) / sum(session_hours)` over a date range — the literal north-star metric. **Approximation**: `session_hours` is the WHOLE session span, including any paused/wrap_up time within it — there's no per-state-transition duration log to subtract that out precisely. |
| `call_events` | The OLD analytics table. **Dropped in TASK-P4-P2** (`20260924002500`) — it never appears in `\d` output on a schema built after that migration; mentioned here only for history. |
| **Talk duration** (`call_legs.duration_seconds`, TASK-M1) | Seconds from when a contact leg was BRIDGED into the agent's conference (`call_legs.bridged_at`, stamped by `handleWin`, dialer-engine.ts, right after a successful conference create/join — never on a failed join) to the leg's hangup. Falls back to `answered_at`, then `claimed_at`, when `bridged_at` is null (the leg never got bridged into live audio, or — for a winning contact leg specifically — `answered_at` itself is never written either, since the winner's own `call.answered` is handled by the claim-win branch directly, not the generic event handler that stamps it). Written on all three leg-ending paths: the real `call.hangup` webhook (`dialer-engine.ts`'s `applyLegTransition`), the sweeper's `reap_dead_claimed_leg` (SQL-only — there is no TS event for this path), and an agent-lost claimed leg (which always ends up going through the sweeper's reap path too, since `handleAgentLegLost` deliberately never touches the still-`claimed` leg — see `.brain/domains/dialer.md`). |
| **Conversation** (TASK-M1) | A contact leg with `outcome = 'connected'` and `duration_seconds >= 30`. Losing/abandoned/machine legs never get a `duration_seconds` at all (not 0) — the connected gate is on `outcome`, not `state`. |
| **Dialing hours (today)** (`dialing_hours_today(org_id, agent_id)` RPC) | `sum(coalesce(ended_at, now()) - started_at)`, clipped to `[start of today, now]`, over the agent's `dial_sessions` — **includes a still-RUNNING session** (unlike `dial_session_hours` below, which only counts ended ones), so the number is live during the day, not just after a session ends. "Today" is midnight in the **org's own real timezone** (MISSION-5 TASK-M5-A4: `org_timezone_settings.timezone`, coalesced back to `'America/Chicago'` if a row is somehow missing) — every org gets a seeded row (an `orgs`-insert trigger, same shape as `org_pause_reason_settings`), owner/admin editable via `getOrgTimezone`/`updateOrgTimezone` (`apps/web/src/lib/api.ts`). Before A4 this hardcoded `'America/Chicago'` for every org. |
| **Conversations / hr** (TASK-M1, replaces the old "Revenue Pipeline" Dashboard card) | `conversations / dialing_hours_today`, rounded to 1 decimal, or `null` (UI renders "—") when `dialing_hours_today < 0.1` — avoids a nonsense spike right after Go Ready. Pure math lives in `_shared/analytics-core.ts` (`computeConversationsPerHour`/`isConversation`), unit-tested directly since `dashboard-stats/index.ts` itself has no test file (no Edge Function `index.ts` in this repo does). |
| **Wins (today)** (TASK-F-P1) | Count of today's own `call_leg_analytics` rows where `is_win = true` — `dispositions.is_win` (new column, default false, true for the seeded `yes_build_profile`), joined into the view as `coalesce(d.is_win, false)`. Same today+own-agent scoping as every other `dashboard-stats` field; the Dashboard's 5th StatCard. |
| **Callbacks (today)** (MISSION-5 TASK-M5-A4) | Count of today's own `call_leg_analytics` rows where `disposition_lead_effect = 'callback'` — the view gained this column (a straight `d.lead_effect` passthrough) so `dashboard-stats` doesn't need a second query. Backs the agent self-view's "my callbacks today". |
| **Fairness** (MISSION-5 TASK-M5-A4, Team.tsx) | Conversations per 100 dials (`conversations / dials * 100`, null with zero dials) — the task's own explicitly-offered alternative to a connects-per-line-hour metric, chosen because it's derivable client-side from `team_daily_stats`' EXISTING `dials`/`conversations` columns with no schema change, unlike line-hours (which would need a new `lines`-weighted time aggregate — since built, see **Per line-hr** below). Lives in `Team.tsx`'s own `fairnessScore()`, not the SQL layer. |
| **Per line-hr** (MISSION-5 TASK-M5-E13, Team.tsx) | `conversations / line_hours`, null when `line_hours < 0.1` (same floor as `conversations_per_hr`) — the line-count-weighted fairness metric Fairness's own entry above flags as needing schema work. `team_daily_stats` gained 2 columns: `line_hours` (`sum(dial_sessions.lines * clipped_session_hours)` per agent) and `conversations_per_line_hour`. `dial_sessions.lines` is fixed for a session's whole life (verified by grep across every migration + edge function, `audit/M5-E13/notes.md`) — nothing in this codebase updates it after `dialer-session-start` sets it, so `line_hours` is an exact sum, not a time-weighted approximation. Deliberately NOT added to `power_hour_board` (a single-metric ranked leaderboard, not a multi-column table — see the task's own notes for why). |
| **agent_self_stats(org, start, end)** (MISSION-5 TASK-M5-A4) | The Dashboard's "My stats" self-view RPC — any active org member may call this for THEIR OWN numbers (no `p_agent` parameter at all; `auth.uid()` inside the function is the only identity used), plus a `team_median_conversations_per_hr` computed server-side across every active member for the same window. No other agent's individual numbers or identity are ever returned — the per-agent rows that feed the median never leave the function (`percentile_cont` over an internal CTE). |
| **agent_time_in_state** (MISSION-5 TASK-M5-A4 fix, formalizing the B1 review's own finding) | Now excludes `'stopped'`/`'completed'` state time from its base query — before this fix, a stopped session's own event row stayed open (unbounded) until the agent's next session, so it silently accumulated as ordinary "state time" in any range query touching it. Also gained an agent-self-view path: an agent-role caller may pass `p_agent = auth.uid()` (their own id, exactly) to get their own rows back; any other `p_agent` (including null) from an agent caller returns nothing, same fail-closed shape as every other gate in this file. Backs Team.tsx's new Attendance tab. |

## Where the code lives

| What | Path | Notes |
|---|---|---|
| The two views | `supabase/migrations/20260924002400_analytics_real_data.sql` | `security_invoker=on` — RLS on `call_legs`/`dial_sessions` (already agent-vs-admin scoped) is what actually enforces visibility, not a filter re-implemented here |
| Today's metrics | `supabase/functions/dashboard-stats/index.ts` | Single-user (every role sees only their own numbers — this is the personal daily widget, not team-performance's org-wide rollup); TASK-M1 adds `conversationsToday`/`dialingHoursToday`/`conversationsPerHour`, TASK-F-P1 adds `winsToday`, MISSION-5 TASK-M5-A4 adds `callbacksToday` and fixes "today" to use the org's real timezone (`localDayBoundsUtc`, `_shared/analytics-core.ts`) instead of a hardcoded UTC-midnight boundary |
| Conversations/hr math | `supabase/functions/_shared/analytics-core.ts` | Pure, deno-tested (`analytics-core.test.ts`) — the 30s conversation gate and the 0.1h floor rule live here, not inline in the handler |
| Duration write + dialing-hours RPC | `supabase/migrations/20260925020000_call_legs_duration_conversations.sql` | `bridged_at` column, `transition_leg`/`reap_dead_claimed_leg` updated to write `duration_seconds`, new `dialing_hours_today(org_id, agent_id)` function |
| Trend chart | `supabase/functions/team-performance/index.ts` | Day buckets, 7d/30d/custom, same response shape as before |
| **New**: full Analytics backend | `supabase/functions/analytics-summary/index.ts` | Totals + period-over-period deltas, call volume, disposition breakdown, agent leaderboard |
| Weekly recap job | `supabase/functions/ensure-week-summary/index.ts` | Fridays only, unchanged shape |
| **Real** Dashboard UI | `apps/web/src/components/Dashboard.tsx` | TASK-M1: the 4th hero card ("Revenue Pipeline", hardcoded "Coming soon") is now "Conversations / hr" with a subtext line and an info tooltip. TASK-F-P1 adds a 5th card, "Wins today" (5-across at `xl:` 1280px+, wraps to 3-across below that, 2×2 on mobile) |
| **Real** Analytics UI | `apps/web/src/components/Analytics.tsx` | Full rewrite — real data, loading + empty states, a 7d/30d toggle |
| **New**: manager Team page (TASK-M2, extended MISSION-5 TASK-M5-A4) | `apps/web/src/components/Team.tsx`, `20260925080100_team_view.sql` | ADM-6 (per-intern daily dials/connects/conversations/wins/callbacks/talk-time/dialing-hours/**Fairness** (A4), sortable + totals + CSV) and ADM-7 (a live board polled every 5s: status/lines/contact/calls-today/pause-reason (B1)/**campaign** (A4), now client-side sortable + filterable by status/campaign). A4 also adds an **Attendance** tab (per agent per day: dialing/on-call/wrap-up/paused-by-reason time + productive %, date range, CSV — built on `agent_time_in_state`; "first activity" as a literal clock time is NOT built, said explicitly rather than faked). `team_daily_stats`/`team_live_board` are `SECURITY DEFINER` **but granted to `authenticated` directly** (not `service_role`-only like every other function here) — each checks the caller's own `private.has_org_role` itself and is called straight from the client (`supabase.rpc(...)`, no edge function), same "front door read" shape as `contact_disposition_history` (dispositions domain) but for owner/admin instead of any member. A non-owner/admin caller, or a `p_org` the caller doesn't manage, gets an empty array back, not an error. `agent_time_in_state` and the new `agent_self_stats` are the two exceptions to "owner/admin only" — see Key concepts above. |
| Client contract | `apps/web/src/lib/api.ts` | `DashboardStats`/`TeamPerformancePoint` unchanged; `AnalyticsSummary` new; `TeamDailyStatsRow`/`TeamLiveBoardRow` new (TASK-M2) |
| Notification bell | `apps/web/src/components/TopNavigation.tsx` | Unchanged |
| Schema + RLS | `supabase/migrations/20250213000001_create_call_events_and_notifications.sql` | `notifications`/`user_preferences` still relevant; the `call_events` half of this file is dropped as of `20260924002500` |
| **New**: per-campaign drop rate (MISSION-4 TASK-T8) | `supabase/migrations/20260926070004_compliance_drop_consent_pause.sql` (`campaign_drop_rate_summary`), `Analytics.tsx`'s "Drop rate (last 30 days)" card | Same additive-RPC, same-scoping-shape convention as `funnel_summary` (org-scoped, owner/admin see the whole campaign, an agent only their own legs) — that function itself is untouched. Always a trailing 30-day window, independent of the page's own 7d/30d toggle. `dropped / human_answers`, a >3% guideline warning banner, not a hard limit. |
| **New**: funnel + best-time-to-call heatmap + connect rate by number/hour + CSV export (MISSION-4 TASK-T11, ADM-8) | `supabase/migrations/20260926080300_dialer_analytics_v2.sql`, `Analytics.tsx`'s `FunnelAndInsights` component | 4 new `SECURITY DEFINER` "front door read" RPCs (`funnel_summary`, `answer_rate_heatmap`, `connect_rate_by_number`, `connect_rate_by_hour`), same shape as `team_daily_stats`/`team_live_board` — called directly via `supabase.rpc()`, each checks the caller's own org role inside itself, no edge function involved. Funnel: dials → human answers (`outcome in ('connected','dropped','abandoned')`) → conversations (≥30s) → wins. Heatmap: weekday × hour of human-answer rate, bucketed in the CONTACT's own local timezone (not the org's or the server's) — `call_leg_analytics` widened with `contact_timezone` for this. Connect-rate-by-number/-hour are owner/admin only (the RPCs return empty for an agent, by design, not an error). CSV export is a client-side download of the funnel's own rows, disabled while `funnel.dials === 0`. Review fix: `answer_rate_heatmap` must bucket ALL dials into its denominator, not just answered ones (an early draft silently excluded no-answers/voicemails from the rate's own denominator, inflating it). |
| **New**: power hour / call blitz sprint board (MISSION-5 TASK-M5-E2) | `supabase/migrations/20260928114928_power_hours.sql`, `apps/web/src/components/power-hour/{PowerHourPanel,PowerHourBoard,PowerHourLiveBanner}.tsx` | `power_hours` (org- or pod-scoped, `create_power_hour`/`cancel_power_hour` write RPCs, owner/admin any scope, a manager only their own `org_manager_pods`) + `power_hour_board(p_id)`, a `SECURITY DEFINER` read RPC ranking active in-scope agents by the power hour's own `metric` (`conversations`/`connects`/`appointments` = `is_win`) within `[starts_at, least(now,ends_at))`, bucketed on `cl.created_at` same as every other windowed query here (**not** `answered_at`/`bridged_at` — see the migration's own header + `audit/M5-E2/notes.md` for why, given the codebase itself is inconsistent between `funnel_summary`'s `human_answers` and `agent_self_stats`'s narrower `connects`, and this picked the latter). Per-dialing-hour normalization reuses `agent_self_stats`' own clipped-overlap `hours` CTE verbatim (`least(coalesce(ended_at,now()),window_end) - greatest(started_at,window_start)`, summed per agent, `>=0.1h` floor before dividing) — **not** `dial_session_hours` (whole-session, null while running, no window clipping — doesn't fit a live bounded slice at all). Status (`upcoming`/`live`/`ended`/`cancelled`) is computed client-side from `starts_at`/`ends_at`/`cancelled_at`, never stored. Team page: create/cancel card + per-hour board (last 20). Dialer page: a compact top-3 live banner, renders nothing when no power hour is live in the caller's scope. |

## How it works

1. **Dashboard mounts** — `getDashboardStats()` hits `dashboard-stats`, which selects today's `call_leg_analytics` rows for the caller's own `agent_id` and derives calls/connect-rate/talk-time, then (TASK-M1) reuses that same rowset for `conversationsToday` and calls the `dialing_hours_today` RPC for the denominator.
2. **Trend chart** — `getTeamPerformanceChart()` calls `team-performance`, org-wide for owner/admin or own-only for an agent (`requireOrgRole`'s role, same split as before), bucketed by day.
3. **Analytics mounts** — `getAnalyticsSummary(range)` calls `analytics-summary`: loads the current range's legs AND the immediately-preceding equal-length range (for `%ChangePct` deltas), plus `dial_session_hours` for the agent-hour denominator, then computes totals, a zero-filled day-bucketed call-volume series (`voicemails` = `outcome='machine'`, not a disposition key — available even before a leg is ever dispositioned), a disposition/outcome breakdown, and an agent leaderboard (org-wide for owner/admin, a single self-row for an agent).
4. **Week summary** — unchanged mechanics, now reads `call_leg_analytics` instead of `call_events`.

## Integration points

| Direction | With | Via |
|---|---|---|
| Depends on | domain.dialer | `call_legs`/`dial_sessions` and their existing RLS |
| Depends on | domain.dispositions | `call_leg_analytics.disposition_label`/`disposition_key` |
| Depended on by | Dashboard.tsx, Analytics.tsx | `apps/web/src/lib/api.ts` |

## Constraints & gotchas

- **`session_hours` is a wall-clock approximation, not precise agent-active-time** — see Key concepts. If a future task adds a state-transition duration log, this is the place to make the
  denominator exact instead.
- **A session only counts toward agent-hours once it has `ended_at` set** — a live, still-`dialing` session contributes nothing to the metric yet (avoids a moving-target denominator mid-query).
- **The call-volume chart's "voicemails" bucket is `outcome='machine'`, not a disposition key** — chosen deliberately so the chart has real data even before the mandatory wrap-up form (E4, not
  built yet) exists to let anyone actually disposition a call as "Left voicemail".
- **`analytics-summary`'s agent leaderboard is a single row for an agent role** (their own numbers only), a full ranked list for owner/admin — design §2's permission matrix, same split
  `team-performance` already used.
- **`analytics-summary`/`team-performance`'s day buckets are still UTC-bucketed** (unchanged from before this task) — a UTC-8 agent's evening calls land on tomorrow's bucket. `dashboard-stats`' own "today" and `team_live_board`/`dialing_hours_today`'s own "today" are NOT (MISSION-5 TASK-M5-A4: all three now use the org's real `org_timezone_settings.timezone`) — this UTC-bucketing gap is now narrower than it was, not gone.
- **`call_events` is gone** (`20260924002500`, TASK-P4-P2) — a schema built from these migrations never has it. Redis itself is a separate, still-open Phase-4 line item (design §8's "remove
  Redis and call_events") — `_shared/redis.ts` still exists, untouched by this task.
- **`notifications` has no INSERT policy at all**, and its UPDATE policy has no `WITH CHECK` — unchanged pre-existing behavior, not touched by this task.
- **The three edge functions still use `requireOrgRole` + a service-role client + explicit `org_id`/`agent_id` filters**, not a new user-JWT-forwarded PostgREST client — `security_invoker` on
  the two views makes them RLS-correct for a FUTURE direct client query, but service_role always bypasses RLS regardless, so these functions' own explicit filters are still what scopes their
  results today. A deliberate choice to avoid introducing an auth pattern nothing else in this repo uses, not an oversight.
- **`dashboard-stats` scopes EVERY field, including the new ones, to the caller's own `agent_id` — for every role, including owner/admin.** There is no org-wide rollup on this endpoint; that's
  `team-performance`'s job. TASK-M1's own task file assumed this endpoint already varied scope by role the way the OTHER dashboard cards do — it does not; verified by reading the code, not
  assumed from the task description (CLAUDE.md: "when a summary and the code disagree, the code is right"). The new fields simply match the existing, real behavior.
- **Stale claim removed (MISSION-5 TASK-M5-A4):** this used to say no `orgs` table has a timezone column and `dialing_hours_today` hardcodes America/Chicago — as of A4, `org_timezone_settings`
  (singleton table, owner/admin editable) exists and `dialing_hours_today`/`team_live_board`/`dashboard-stats` all read it, coalescing back to `'America/Chicago'` only if a row is somehow
  missing (shouldn't happen — every org gets one seeded via an `orgs`-insert trigger + a one-time backfill).
- **The whole TASK-T11 funnel/heatmap/by-number/by-hour/CSV-export block only mounts when the page's own top-level `hasData` is true** (`Analytics.tsx`'s `FunnelAndInsights` sits inside the same `!hasData ? <EmptyState/> : (...)` branch as the StatCard row) — an org with zero calls in the selected range never renders `FunnelAndInsights` at all, not even its own internal empty states (found live during the Mission 4 QA sweep, 2026-09-27, checking a QA sandbox org with no dial history). Not a bug: the component's own internal empty states (`!funnel || funnel.dials === 0`, `!heatmap || heatmap.length === 0`) exist for a real gap this doesn't cover — a range with SOME calls overall but none for a specific selected campaign — they're just unreachable when the org has literally zero calls anywhere, same case the outer `EmptyState` already covers.
- **Stale claim removed (TASK-M2):** this used to say `Analytics.tsx`'s per-agent table was still mock data — it is not; `analytics-summary`'s real `agentPerformance` leaderboard has been wired
  in since TASK-P4-P1 (calls/connections/rate only, code-verified while building this task, CLAUDE.md's "code is right" rule). The genuinely-missing per-agent breadth (wins/callbacks/dialing
  hours/conversations-per-hr) is what TASK-M2's separate Team page (above) adds — not a fix to Analytics.tsx, a dedicated screen, so the two don't duplicate each other.

## Not covered here

- Dial loop, AMD, batching, and the `call_legs`/`dial_sessions` state machine → `.brain/domains/dialer.md`
- The disposition list and `submit_disposition`'s effects → `.brain/domains/dispositions.md`
- Auth, `getUserFromRequest()`, and RLS conventions → `.brain/domains/auth.md`

## Unverified

- A live browser render check of Dashboard/Analytics against real seeded data was not done this
  task (skipped as not cheap given session time constraints, not because it was judged
  unnecessary) — `npm run build`'s clean `tsc --noEmit` plus the SQL test suite's metric-math
  positive control are what's actually been verified. NEEDS-LIVE-VERIFY.
- Whether `analytics-summary`'s period-over-period deltas feel right on a real, noisy dataset
  (small-number percentage swings can look dramatic) was not checked against real data — only
  the arithmetic itself (`pctChange`) was reasoned through, not empirically observed.
- TASK-M1's `20260925020000` migration (bridged_at, transition_leg/reap_dead_claimed_leg
  duration writes, dialing_hours_today) is committed but NOT yet applied anywhere — local
  Docker is retired, so its SQL correctness rests on `supabase/tests/dialer_sweeper.sql`'s new
  assertions (NEEDS-LIVE-VERIFY, same as the rest of that file) plus the deno-tested TS side
  (`dialer-engine.test.ts`) for the real call.hangup path. Ask the lead to run a manual
  post-live-test-call check: every connected leg has a non-null `duration_seconds`, and the
  Dashboard's Conversations/hr matches a manual `call_leg_analytics` count.

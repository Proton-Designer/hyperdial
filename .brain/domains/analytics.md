---
id: domain.analytics
title: Analytics & Notifications
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-25
sources:
  - supabase/migrations/20260924002400_analytics_real_data.sql
  - supabase/migrations/20260925020000_call_legs_duration_conversations.sql
  - supabase/functions/dashboard-stats/index.ts
  - supabase/functions/team-performance/index.ts
  - supabase/functions/analytics-summary/index.ts
  - supabase/functions/ensure-week-summary/index.ts
  - supabase/functions/_shared/analytics-core.ts
  - apps/web/src/components/Dashboard.tsx
  - apps/web/src/components/Analytics.tsx
  - apps/web/src/components/Team.tsx
  - supabase/migrations/20260925080100_team_view.sql
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
covers: "The Dashboard metrics, the Analytics screen, the call_leg_analytics/dial_session_hours views behind them, the weekly-summary job, and the in-app notification bell."
excludes: "The dial loop and call_legs state machine that produces the source data — see .brain/domains/dialer.md. Dispositions themselves — see .brain/domains/dispositions.md."
tokens_est: 2340
source_hash: 92c5f07e1add58d757f9884b6b977bb0aec9a816553c9d612afb6b4e39381c9a
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
| **Dialing hours (today)** (`dialing_hours_today(org_id, agent_id)` RPC) | `sum(coalesce(ended_at, now()) - started_at)`, clipped to `[start of today, now]`, over the agent's `dial_sessions` — **includes a still-RUNNING session** (unlike `dial_session_hours` below, which only counts ended ones), so the number is live during the day, not just after a session ends. "Today" is midnight **America/Chicago** — no org has a timezone column yet (checked every migration); this is a hardcoded default until one exists. |
| **Conversations / hr** (TASK-M1, replaces the old "Revenue Pipeline" Dashboard card) | `conversations / dialing_hours_today`, rounded to 1 decimal, or `null` (UI renders "—") when `dialing_hours_today < 0.1` — avoids a nonsense spike right after Go Ready. Pure math lives in `_shared/analytics-core.ts` (`computeConversationsPerHour`/`isConversation`), unit-tested directly since `dashboard-stats/index.ts` itself has no test file (no Edge Function `index.ts` in this repo does). |
| **Wins (today)** (TASK-F-P1) | Count of today's own `call_leg_analytics` rows where `is_win = true` — `dispositions.is_win` (new column, default false, true for the seeded `yes_build_profile`), joined into the view as `coalesce(d.is_win, false)`. Same today+own-agent scoping as every other `dashboard-stats` field; the Dashboard's 5th StatCard. |

## Where the code lives

| What | Path | Notes |
|---|---|---|
| The two views | `supabase/migrations/20260924002400_analytics_real_data.sql` | `security_invoker=on` — RLS on `call_legs`/`dial_sessions` (already agent-vs-admin scoped) is what actually enforces visibility, not a filter re-implemented here |
| Today's metrics | `supabase/functions/dashboard-stats/index.ts` | Single-user (every role sees only their own numbers — this is the personal daily widget, not team-performance's org-wide rollup), UTC day for the existing fields; TASK-M1 adds `conversationsToday`/`dialingHoursToday`/`conversationsPerHour`, TASK-F-P1 adds `winsToday` |
| Conversations/hr math | `supabase/functions/_shared/analytics-core.ts` | Pure, deno-tested (`analytics-core.test.ts`) — the 30s conversation gate and the 0.1h floor rule live here, not inline in the handler |
| Duration write + dialing-hours RPC | `supabase/migrations/20260925020000_call_legs_duration_conversations.sql` | `bridged_at` column, `transition_leg`/`reap_dead_claimed_leg` updated to write `duration_seconds`, new `dialing_hours_today(org_id, agent_id)` function |
| Trend chart | `supabase/functions/team-performance/index.ts` | Day buckets, 7d/30d/custom, same response shape as before |
| **New**: full Analytics backend | `supabase/functions/analytics-summary/index.ts` | Totals + period-over-period deltas, call volume, disposition breakdown, agent leaderboard |
| Weekly recap job | `supabase/functions/ensure-week-summary/index.ts` | Fridays only, unchanged shape |
| **Real** Dashboard UI | `apps/web/src/components/Dashboard.tsx` | TASK-M1: the 4th hero card ("Revenue Pipeline", hardcoded "Coming soon") is now "Conversations / hr" with a subtext line and an info tooltip. TASK-F-P1 adds a 5th card, "Wins today" (5-across at `xl:` 1280px+, wraps to 3-across below that, 2×2 on mobile) |
| **Real** Analytics UI | `apps/web/src/components/Analytics.tsx` | Full rewrite — real data, loading + empty states, a 7d/30d toggle |
| **New**: manager Team page (TASK-M2) | `apps/web/src/components/Team.tsx`, `20260925080100_team_view.sql` | ADM-6 (per-intern daily dials/connects/conversations/wins/callbacks/talk-time/dialing-hours, sortable + totals) and ADM-7 (a live board polled every 5s: status/lines/contact/calls-today). `team_daily_stats`/`team_live_board` are `SECURITY DEFINER` **but granted to `authenticated` directly** (not `service_role`-only like every other function here) — each checks the caller's own `private.has_org_role` itself and is called straight from the client (`supabase.rpc(...)`, no edge function), same "front door read" shape as `contact_disposition_history` (dispositions domain) but for owner/admin instead of any member. A non-owner/admin caller, or a `p_org` the caller doesn't manage, gets an empty array back, not an error. |
| Client contract | `apps/web/src/lib/api.ts` | `DashboardStats`/`TeamPerformancePoint` unchanged; `AnalyticsSummary` new; `TeamDailyStatsRow`/`TeamLiveBoardRow` new (TASK-M2) |
| Notification bell | `apps/web/src/components/TopNavigation.tsx` | Unchanged |
| Schema + RLS | `supabase/migrations/20250213000001_create_call_events_and_notifications.sql` | `notifications`/`user_preferences` still relevant; the `call_events` half of this file is dropped as of `20260924002500` |

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
- **Everything is still UTC-bucketed** (unchanged from before this task) — a UTC-8 agent's evening calls land on tomorrow's bucket.
- **`call_events` is gone** (`20260924002500`, TASK-P4-P2) — a schema built from these migrations never has it. Redis itself is a separate, still-open Phase-4 line item (design §8's "remove
  Redis and call_events") — `_shared/redis.ts` still exists, untouched by this task.
- **`notifications` has no INSERT policy at all**, and its UPDATE policy has no `WITH CHECK` — unchanged pre-existing behavior, not touched by this task.
- **The three edge functions still use `requireOrgRole` + a service-role client + explicit `org_id`/`agent_id` filters**, not a new user-JWT-forwarded PostgREST client — `security_invoker` on
  the two views makes them RLS-correct for a FUTURE direct client query, but service_role always bypasses RLS regardless, so these functions' own explicit filters are still what scopes their
  results today. A deliberate choice to avoid introducing an auth pattern nothing else in this repo uses, not an oversight.
- **`dashboard-stats` scopes EVERY field, including the new ones, to the caller's own `agent_id` — for every role, including owner/admin.** There is no org-wide rollup on this endpoint; that's
  `team-performance`'s job. TASK-M1's own task file assumed this endpoint already varied scope by role the way the OTHER dashboard cards do — it does not; verified by reading the code, not
  assumed from the task description (CLAUDE.md: "when a summary and the code disagree, the code is right"). The new fields simply match the existing, real behavior.
- **No `orgs` table has a timezone column** (checked every migration) — `dialing_hours_today` hardcodes **America/Chicago** for "today"'s midnight boundary. If an org timezone column is ever
  added, this function is the one place that needs to start reading it instead.
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

---
id: domain.analytics
title: Analytics & Notifications
layer: L2
type: domain
status: canonical
owner: maintainer
updated: 2026-09-24
sources:
  - supabase/migrations/20260924002400_analytics_real_data.sql
  - supabase/functions/dashboard-stats/index.ts
  - supabase/functions/team-performance/index.ts
  - supabase/functions/analytics-summary/index.ts
  - supabase/functions/ensure-week-summary/index.ts
  - apps/web/src/components/Dashboard.tsx
  - apps/web/src/components/Analytics.tsx
  - apps/web/src/lib/api.ts
related:
  - domain.dialer
  - domain.dispositions
  - domain.auth
answers:
  - "is the Analytics screen real data or a mock"
  - "where do the Dashboard's Calls Today / Connect Rate / Talk Time numbers come from"
  - "how is live conversations per agent-hour computed"
  - "how is the weekly summary notification created and when"
  - "how are in-app notifications listed, counted and marked read"
covers: "The Dashboard metrics, the Analytics screen, the call_leg_analytics/dial_session_hours views behind them, the weekly-summary job, and the in-app notification bell."
excludes: "The dial loop and call_legs state machine that produces the source data — see .brain/domains/dialer.md. Dispositions themselves — see .brain/domains/dispositions.md."
---

# Analytics & Notifications

## Purpose

Softdial exists to raise live conversations per agent hour (CLAUDE.md/design §8), so the Dashboard and Analytics screens surface that number and its supporting metrics from real call data — no
mock data, no empty-by-construction tables, as of TASK-P4-P1.

## Key concepts

| Term | Means |
|---|---|
| `call_leg_analytics` | A `security_invoker` view over `call_legs` (kind='contact') joined to `dial_sessions` (for `agent_id`) and `dispositions`. Every analytics query reads this now, not `call_events`. |
| `dial_session_hours` | A `security_invoker` view: one row per dial session, `session_hours` = wall-clock `ended_at - started_at`, null while a session is still running. The agent-hours denominator for the north-star metric. |
| Conversations / agent-hour | `count(is_connected) / sum(session_hours)` over a date range — the literal north-star metric. **Approximation**: `session_hours` is the WHOLE session span, including any paused/wrap_up time within it — there's no per-state-transition duration log to subtract that out precisely. |
| `call_events` | The OLD analytics table. Still exists, still empty, **nothing reads it anymore as of this task** — not deleted here (that's Phase 4's own later "remove call_events" line item). |

## Where the code lives

| What | Path | Notes |
|---|---|---|
| The two views | `supabase/migrations/20260924002400_analytics_real_data.sql` | `security_invoker=on` — RLS on `call_legs`/`dial_sessions` (already agent-vs-admin scoped) is what actually enforces visibility, not a filter re-implemented here |
| Today's metrics | `supabase/functions/dashboard-stats/index.ts` | Single-user, UTC day, same response shape as before this task |
| Trend chart | `supabase/functions/team-performance/index.ts` | Day buckets, 7d/30d/custom, same response shape as before |
| **New**: full Analytics backend | `supabase/functions/analytics-summary/index.ts` | Totals + period-over-period deltas, call volume, disposition breakdown, agent leaderboard |
| Weekly recap job | `supabase/functions/ensure-week-summary/index.ts` | Fridays only, unchanged shape |
| **Real** Dashboard UI | `apps/web/src/components/Dashboard.tsx` | Unchanged this task (its two endpoints kept their response shape) |
| **Real** Analytics UI | `apps/web/src/components/Analytics.tsx` | Full rewrite — real data, loading + empty states, a 7d/30d toggle |
| Client contract | `apps/web/src/lib/api.ts` | `DashboardStats`/`TeamPerformancePoint` unchanged; `AnalyticsSummary` new |
| Notification bell | `apps/web/src/components/TopNavigation.tsx` | Unchanged |
| Schema + RLS | `supabase/migrations/20250213000001_create_call_events_and_notifications.sql` | `notifications`/`user_preferences` (still relevant); `call_events` (now unread) |

## How it works

1. **Dashboard mounts** — `getDashboardStats()` hits `dashboard-stats`, which selects today's `call_leg_analytics` rows for the caller's own `agent_id` and derives calls/connect-rate/talk-time.
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
- **`call_events` still exists and is still empty** — nothing in this repo writes OR reads it anymore as of this task. Deleting the table itself is a separate, later Phase-4 cleanup item (design
  §8's own "remove Redis and call_events" line), out of this task's scope.
- **`notifications` has no INSERT policy at all**, and its UPDATE policy has no `WITH CHECK` — unchanged pre-existing behavior, not touched by this task.
- **The three edge functions still use `requireOrgRole` + a service-role client + explicit `org_id`/`agent_id` filters**, not a new user-JWT-forwarded PostgREST client — `security_invoker` on
  the two views makes them RLS-correct for a FUTURE direct client query, but service_role always bypasses RLS regardless, so these functions' own explicit filters are still what scopes their
  results today. A deliberate choice to avoid introducing an auth pattern nothing else in this repo uses, not an oversight.

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

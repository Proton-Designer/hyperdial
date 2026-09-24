-- TASK-P4-P2 (design §8 Phase 4: "delete the mock UI, remove Redis and call_events"). TASK-P4-P1
-- moved every analytics reader (dashboard-stats, team-performance, ensure-week-summary,
-- analytics-summary) onto call_leg_analytics/dial_session_hours; nothing in the repo has read or
-- written call_events since. Confirmed via a full-repo grep immediately before writing this
-- migration -- the only remaining hits were this table's own original migration, the two
-- tenancy migrations that added org_id/RLS to it (both append-only, left as historical record),
-- and explanatory code comments in the four functions above (mention it by name, never query it).
--
-- `drop table if exists`, per the task's own note: a real deployed project may hold an empty
-- call_events table (or none at all, if this is the first environment it's ever run against) --
-- either way this is a no-op-safe, idempotent drop, not a data-loss risk (the table has been
-- write-dead since the day this repo's dial loop was built, per known-issues.md's own history).

drop table if exists public.call_events;

# Parallel Dialer Validation Checklist (superseded)

This file described the original Redis/`BATCH_FIRING`-event engine
(`PARALLEL_DIALER_ENABLED`, Upstash Redis, `DIALER_SESSION_STARTED`/
`HUMAN_CONNECTED`/`CAMPAIGN_COMPLETE` events). None of that exists anymore —
Phase 2 rewrote the dial loop onto the org-scoped `dial_sessions`/`call_legs`
schema with Postgres single-winner claims (Redis is out of the dial path
entirely), and the launch-blockers phase (TASK-L1/L2b/L1r4) replaced the UI
and session lifecycle on top of it.

**The current manual/live-verification checklist is
[`launch-live-test.md`](launch-live-test.md).** Use that one.

Kept here (not deleted) only so old links/history don't 404.

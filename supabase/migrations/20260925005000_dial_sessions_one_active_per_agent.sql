-- TASK-L1 / SEC-8: an agent can have only one non-terminal dial_sessions row, globally (not
-- just per campaign). This is a genuinely new invariant, not just a race-closing nicety: once
-- the agent leg is real (this task), an agent has exactly one WebRTC credential/SIP endpoint --
-- they physically cannot be bridged into two sessions' conferences at once. The pre-existing
-- check in dialer-session-start (SELECT ... WHERE campaign_id = ? AND agent_id = ?) only ever
-- checked per-campaign, which this migration supersedes with the correct, stricter rule.
--
-- Partial unique index, not a CHECK/trigger: the two terminal states ('stopped', 'completed')
-- are explicitly excluded from the index so an agent's history of past sessions never conflicts
-- with a new one -- only currently-active rows compete for uniqueness.
--
-- dialer-session-start (_shared/dialer-engine.ts's startSession) maps this constraint's unique
-- violation to a clean 409, closing the check-then-insert TOCTOU race the same way SEC-8 asks.
--
-- Before applying to live: check read-only for any agent currently holding more than one
-- non-terminal dial_sessions row (across different campaigns) -- if the live data violates this
-- constraint, the index creation itself will fail and those rows need reconciling first. Example
-- check:
--   select agent_id, count(*) from public.dial_sessions
--   where state not in ('stopped', 'completed') group by agent_id having count(*) > 1;

create unique index dial_sessions_one_active_per_agent
  on public.dial_sessions (agent_id)
  where state not in ('stopped', 'completed');

-- TASK-L1 review fix (M4): Reconnect used to decide on_call-vs-dialing purely from whether
-- `active_leg_id` was still set, which can never tell "the agent dropped while manually
-- paused" or "the agent dropped while wrap_up was already entered" apart from "the agent
-- dropped while dialing" -- all three look identical (no active_leg_id) by the time Reconnect
-- runs. Concretely: Reconnect from a `paused` session resumed dialing anyway (overriding the
-- intern's own Pause); Reconnect from `wrap_up` also resumed dialing, skipping the mandatory
-- disposition step entirely.
--
-- This column remembers which state the agent-lost transition came FROM, read by
-- processAgentLegEvent's answered cascade and cleared the moment it's consumed. It only
-- disambiguates the `paused` case -- the `wrap_up` case is actually caught more robustly by a
-- direct check for an undispositioned connected leg (dialer-engine.ts), since a session can
-- reach `wrap_up` AFTER the agent already left (the customer's own hangup completing while
-- paused_agent_lost, at which point the wrap_up transition's own CAS silently no-ops against
-- the already-changed state) -- this column alone would have recorded the WRONG pre-loss
-- state in that ordering, so it is deliberately not the only signal used.
--
-- No CHECK constraint: this is internal engine bookkeeping, always written by
-- dialer-engine.ts from its own SESSION_STATES vocabulary, never client-facing.

alter table public.dial_sessions
  add column paused_agent_lost_from text;

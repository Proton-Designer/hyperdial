-- TASK-P4-P1 (dashboard/analytics on real data, design §8 Phase 4). CLAUDE.md's own known-issue:
-- Dashboard.tsx/Analytics.tsx currently read `call_events`, which nothing in this repo writes --
-- the dial loop writes `call_legs` (TASK-P2-E2) and TASK-P3-E1 added dispositions on top of it.
-- `call_events` itself is untouched here (still exists, still empty, still read by nothing after
-- this migration) -- deleting it is Phase 4's own later "remove call_events" line item, out of
-- this task's scope.
--
-- Two security_invoker views (same pattern as campaigns_with_stats/crm_sync_jobs_recent): the
-- heavy joins/derived columns live here in SQL, and RLS on the underlying tables (call_legs/
-- dial_sessions, already agent-vs-admin scoped since TASK-P2-E1/E2) is what actually enforces
-- "agents see only their own numbers; owner/admin see the whole org" for any query against them,
-- direct or otherwise -- not a query-time filter this migration has to reinvent.
--
-- The Edge Functions that read these views (dashboard-stats/team-performance/ensure-week-summary/
-- analytics-summary, all committed alongside this migration) still use the existing
-- requireOrgRole + service-role-client + explicit org_id/agent_id filter pattern every other
-- function in this lane uses, rather than a new user-JWT-forwarded PostgREST client this repo
-- has never used anywhere -- service_role bypasses RLS regardless of security_invoker, so the
-- explicit filter is still what actually scopes those functions' results. The views being
-- correctly security_invoker is what makes them also safe to query directly from an authenticated
-- client in the future (same as crm_sync_jobs_recent already is), not something these functions
-- currently rely on.

create view public.call_leg_analytics with (security_invoker = on) as
select
  cl.id as leg_id,
  cl.org_id,
  cl.session_id,
  ds.agent_id,
  cl.campaign_id,
  cl.contact_id,
  cl.state,
  cl.outcome,
  (cl.outcome = 'connected') as is_connected,
  cl.duration_seconds,
  cl.disposition_id,
  d.key as disposition_key,
  d.label as disposition_label,
  cl.created_at,
  cl.answered_at,
  cl.ended_at
from public.call_legs cl
join public.dial_sessions ds on ds.id = cl.session_id
left join public.dispositions d on d.id = cl.disposition_id
where cl.kind = 'contact';

-- "Live conversations per agent-hour" (CLAUDE.md/design §8's north-star metric) needs a
-- denominator: how many hours an agent actually spent dialing. Approximated as a completed dial
-- session's whole wall-clock span (started_at -> ended_at) -- this INCLUDES any time paused or
-- in wrap_up within that session, since dial_sessions has no per-state-transition duration log to
-- subtract that out precisely. Said plainly as a known approximation (not silently precise) in
-- .brain/domains/analytics.md. Only ended sessions count (session_hours is null while a session is
-- still running) -- an in-progress session's hours are a moving target mid-query, and this metric
-- is meant to summarize completed work over a date range, not live-tick.
create view public.dial_session_hours with (security_invoker = on) as
select
  ds.id as session_id,
  ds.org_id,
  ds.agent_id,
  ds.campaign_id,
  ds.state,
  ds.started_at,
  ds.ended_at,
  case when ds.ended_at is not null
    then round((extract(epoch from (ds.ended_at - ds.started_at)) / 3600.0)::numeric, 2)
    else null
  end as session_hours
from public.dial_sessions ds;

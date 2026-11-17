-- TASK-H31: campaigns_with_stats showed dead numbers. campaigns.total_calls_made / connect_rate /
-- last_called_at are legacy columns nothing writes (0 / 0 / null on every campaign), and Progress
-- counted only status='completed' leads (called leads waiting for a retry go back to 'queued').
-- The view now derives them from real data and keeps every existing column name, so api.ts stays
-- compatible; one column (called) is appended.
--   called           leads with attempts > 0 (how far through the list the team is)
--   total_calls_made contact legs for the campaign (call_legs.kind = 'contact')
--   connect_rate     connected contact legs / all contact legs, percent, 1 decimal. Same definition
--                    as dashboard-stats (connectedCount / callsToday over call_leg_analytics).
--   last_called_at   newest contact leg created_at
-- Legs and leads are aggregated in separate lateral subqueries (no fan-out join).

create index if not exists call_legs_campaign_contact_created_idx
  on public.call_legs (campaign_id, created_at)
  where kind = 'contact';

drop view public.campaigns_with_stats;

create view public.campaigns_with_stats as
select
  c.id,
  c.user_id,
  c.org_id,
  c.name,
  c.status,
  coalesce(lg.legs, 0)::integer as total_calls_made,
  case when coalesce(lg.legs, 0) > 0
    then round(100.0 * lg.connected / lg.legs, 1)
    else 0
  end::numeric as connect_rate,
  lg.last_leg_at as last_called_at,
  c.lines,
  c.amd_mode,
  c.voicemail_drop_mode,
  c.caller_id_number_id,
  c.max_attempts,
  c.retry_interval_minutes,
  c.calling_window_start,
  c.calling_window_end,
  c.abandon_message_enabled,
  c.script_text,
  c.objection_sheet_text,
  c.high_lines_guard_enabled,
  c.high_lines_guard_last_triggered_at,
  c.high_lines_guard_last_drop_rate_pct,
  c.distribution_mode,
  c.created_at,
  c.updated_at,
  coalesce(ls.total, 0)::integer as total_contacts,
  coalesce(ls.queued, 0)::integer as queued,
  coalesce(ls.completed, 0)::integer as completed,
  coalesce(ls.passthrough, 0)::integer as passthrough,
  coalesce(ls.called, 0)::integer as called
from public.campaigns c
left join lateral (
  select
    count(*) as total,
    count(*) filter (where cl.status = 'queued') as queued,
    count(*) filter (where cl.status = 'completed') as completed,
    count(*) filter (where cl.status = 'passthrough') as passthrough,
    count(*) filter (where cl.attempts > 0) as called
  from public.campaign_leads cl
  where cl.campaign_id = c.id
) ls on true
left join lateral (
  select
    count(*) as legs,
    count(*) filter (where l.outcome = 'connected') as connected,
    max(l.created_at) as last_leg_at
  from public.call_legs l
  where l.campaign_id = c.id and l.kind = 'contact'
) lg on true
where c.deleted_at is null;

alter view public.campaigns_with_stats set (security_invoker = on);

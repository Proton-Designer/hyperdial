-- TASK-H35: a plain Good / Watch / At risk badge per number, from free signals only (no carrier
-- reputation lookup). Defined once, here, as a security_invoker view over user_phone_numbers and
-- call_legs (kind='contact'), so the existing org-scoped RLS applies; the Settings panel is admin-only.
--
-- Signals (all per number, last 7 days = "this week"; UTC days):
--   answer rate   connected contact legs / contact legs (same definition as number_health_stats,
--                 dashboard-stats and call_leg_analytics)
--   own baseline  the same rate over days 8-30 (the 23 days BEFORE this week, so the two windows do not overlap)
--   pool median   median this-week rate of the org's numbers that have enough dials
--   quick hangups share of connected legs shorter than 5 s (a person picked up and left: the pattern a
--                 spam label produces)
--   absolute floor 100+ dials this week and under 5% answered (a whole pool can decay together, and a
--                 new number has no baseline): Watch
--   pacing        busiest UTC day this week against the number's own daily_cap (the pool already enforces
--                 it): ABOVE the cap = At risk (the cap leaked); AT the cap = an info note only (at_daily_cap,
--                 no level change: the cap is doing its job); a cap raised to 150+ also warns (Watch) at 150
-- Minimums: org_number_health_settings.min_sample_dials (default 20) dials this week to show a level at all,
-- else 'unknown' ("Not enough calls yet"). The RELATIVE signals (trend, pool) need 50+ dials this week (and
-- 50+ in the baseline for trend), and quick hang-ups need 10+ connected calls: at 20 dials the answer rate
-- is too noisy to compare. Level is the worst signal that fired; reasons[] is ordered worst first and
-- reason is reasons[1], so the sentence shown is the one that set the level.

create index if not exists call_legs_number_contact_created_idx
  on public.call_legs (from_number_id, created_at)
  where kind = 'contact';

create view public.number_health_badges with (security_invoker = on) as
with legs as (
  select
    cl.from_number_id as number_id,
    (cl.created_at at time zone 'utc')::date as day,
    (cl.created_at >= now() - interval '7 days') as this_week,
    (cl.outcome = 'connected') as connected,
    (cl.outcome = 'connected' and cl.duration_seconds is not null and cl.duration_seconds < 5) as quick
  from public.call_legs cl
  where cl.kind = 'contact'
    and cl.from_number_id is not null
    and cl.created_at >= now() - interval '30 days'
),
per_day as (
  select number_id, day, count(*) as n
  from legs
  where this_week
  group by number_id, day
),
peak as (
  select number_id, max(n) as peak_day_dials, round(avg(n), 0) as avg_day_dials
  from per_day
  group by number_id
),
agg as (
  select
    number_id,
    count(*) filter (where this_week) as dials_7d,
    count(*) filter (where this_week and connected) as connected_7d,
    count(*) filter (where this_week and quick) as quick_7d,
    count(*) filter (where not this_week) as dials_base,
    count(*) filter (where not this_week and connected) as connected_base
  from legs
  group by number_id
),
base as (
  select
    upn.id as number_id,
    upn.org_id,
    upn.phone_number,
    upn.status,
    upn.flagged_reason,
    upn.daily_cap,
    coalesce(s.min_sample_dials, 20) as min_sample,
    coalesce(a.dials_7d, 0) as dials_7d,
    coalesce(a.connected_7d, 0) as connected_7d,
    coalesce(a.quick_7d, 0) as quick_7d,
    coalesce(a.dials_base, 0) as dials_base,
    coalesce(a.connected_base, 0) as connected_base,
    coalesce(p.peak_day_dials, 0) as peak_day_dials,
    coalesce(p.avg_day_dials, 0) as avg_day_dials
  from public.user_phone_numbers upn
  left join public.org_number_health_settings s on s.org_id = upn.org_id
  left join agg a on a.number_id = upn.id
  left join peak p on p.number_id = upn.id
),
rates as (
  select
    b.*,
    case when b.dials_7d > 0 then b.connected_7d::numeric / b.dials_7d end as rate_7d,
    case when b.dials_base > 0 then b.connected_base::numeric / b.dials_base end as rate_base
  from base b
),
medians as (
  select org_id, (percentile_cont(0.5) within group (order by rate_7d))::numeric as median_7d
  from rates
  where dials_7d >= min_sample
  group by org_id
),
scored as (
  select
    r.*,
    m.median_7d,
    greatest(r.min_sample, 50) as rel_min,
    case when r.connected_7d >= 10 then r.quick_7d::numeric / r.connected_7d end as quick_share,
    -- one level per signal: 2 = at risk, 1 = watch, 0 = fine
    case when r.dials_7d < greatest(r.min_sample, 50) or m.median_7d is null or m.median_7d <= 0 then 0
      when r.rate_7d < m.median_7d * 0.5 then 2
      when r.rate_7d < m.median_7d * 0.75 then 1
      else 0 end as pool_level,
    case when r.dials_7d < greatest(r.min_sample, 50) or r.dials_base < greatest(r.min_sample, 50)
        or r.rate_base is null or r.rate_base <= 0 then 0
      when r.rate_7d < r.rate_base * 0.5 and r.rate_base - r.rate_7d >= 0.05 then 2
      when r.rate_7d < r.rate_base * 0.75 and r.rate_base - r.rate_7d >= 0.03 then 1
      else 0 end as trend_level,
    case when r.dials_7d < r.min_sample or r.connected_7d < 10 then 0
      when r.quick_7d::numeric / r.connected_7d >= 0.6 then 2
      when r.quick_7d::numeric / r.connected_7d >= 0.4 then 1
      else 0 end as quick_level,
    case when r.dials_7d >= 100 and r.rate_7d < 0.05 then 1 else 0 end as floor_level,
    case when r.peak_day_dials > r.daily_cap then 2
      when r.peak_day_dials >= 150 then 1
      else 0 end as pacing_level
  from rates r
  left join medians m on m.org_id = r.org_id
),
reasoned as (
  select
    s.*,
    (s.peak_day_dials >= s.daily_cap and s.pacing_level = 0) as at_daily_cap,
    (select coalesce(array_agg(v.txt order by v.lvl desc, v.ord), array[]::text[])
     from (values
       (1, case when s.status = 'resting' and s.flagged_reason is not null then 2 else 0 end, s.flagged_reason),
       (2, s.pacing_level, format('%s calls from this number on its busiest day this week%s; spread calls across more numbers',
          s.peak_day_dials, case when s.pacing_level = 2 then ', above its daily limit of ' || s.daily_cap else '' end)),
       (3, s.trend_level, format('Answer rate fell from %s%% to %s%% this week', round(s.rate_base * 100), round(s.rate_7d * 100))),
       (4, s.pool_level, format('Answer rate %s%% is well below your other numbers (median %s%%)', round(s.rate_7d * 100), round(s.median_7d * 100))),
       (5, s.quick_level, format('%s%% of answered calls hung up within 5 seconds', round(100.0 * s.quick_7d / nullif(s.connected_7d, 0)))),
       (6, s.floor_level, format('Only %s%% of calls were answered this week (%s dials)', round(s.rate_7d * 100), s.dials_7d))
     ) as v(ord, lvl, txt)
     where v.lvl > 0 and v.txt is not null) as reasons
  from scored s
)
select
  number_id,
  org_id,
  phone_number,
  status,
  case
    when status = 'resting' and flagged_reason is not null then 'at_risk'
    when dials_7d < min_sample then 'unknown'
    when greatest(trend_level, pool_level, quick_level, floor_level, pacing_level) = 2 then 'at_risk'
    when greatest(trend_level, pool_level, quick_level, floor_level, pacing_level) = 1 then 'watch'
    else 'good'
  end as level,
  case
    when dials_7d < min_sample and not (status = 'resting' and flagged_reason is not null)
      then format('Not enough calls yet (%s of %s needed this week)', dials_7d, min_sample)
    when cardinality(reasons) > 0 then reasons[1]
    when at_daily_cap then 'Reached its daily call limit; add numbers if you need more volume'
    else 'Answer rate and pacing look normal'
  end as reason,
  reasons,
  dials_7d::integer as dials_7d,
  round(rate_7d, 4) as answer_rate_7d,
  round(rate_base, 4) as answer_rate_prior,
  round(median_7d, 4) as pool_median_7d,
  round(quick_share, 4) as quick_hangup_share,
  peak_day_dials::integer as peak_day_dials,
  avg_day_dials::integer as avg_day_dials,
  daily_cap,
  at_daily_cap
from reasoned;

alter view public.number_health_badges set (security_invoker = on);

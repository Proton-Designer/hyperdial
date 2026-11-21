-- TASK-H40: number health v2 (free signals only, no carrier lookup). Builds on H35 (number_health_badges)
-- and CID-4 (the existing 'resting' / resting_until / flagged_at / flagged_reason mechanism).
--
-- 1. number_health_scores (security_invoker view): three 0-100 scores per number, defined once here.
--      answer_score   this week's answer rate against the better of the pool median and the number's own
--                     earlier baseline. 100 = at or above that reference, 50 = half of it. null when the
--                     number has fewer than min_sample_dials dials this week.
--      stay_score     share of answered calls (last 30 days) that lasted 10 s or more, as a percentage.
--                     null with fewer than 10 answered calls that have a duration.
--      history_score  how much call history the number has: 60% dials in the last 30 days (200+ = full),
--                     40% days with at least one dial in the last 30 days (14+ = full). Never null: a
--                     brand-new number is simply 0.
--    plus likely_flagged / likely_flagged_reason: a sharp drop, needing BOTH this week's rate under half of
--    the number's own baseline (and 5+ points lower) AND under half of the pool median, with 50+ dials this
--    week and 50+ in the baseline. Only an ACTIVE number that was not already flagged in the last 7 days
--    (one rest per spell: after the rest the bad week is still inside the 7-day window).
-- 2. org_number_health_settings.auto_rest_likely_flagged (default ON, owner/admin can turn it off) and
--    auto_rest_days (default 3).
-- 3. public.auto_rest_likely_flagged_numbers(p_org_id): rests every likely-flagged number of an org that has
--    the setting on, using the existing rest mechanism (status='resting', resting_until, flagged_at,
--    flagged_reason). It only rests a number if every agent who can dial from it keeps another active usable number (own, or unassigned pool); otherwise the warning stays and the admins are told. Writes
--    one org_audit_log row ('number.auto_rest') and notifies the owners/admins. service_role only.
-- 4. pg_cron: every 6 hours, SQL only (no edge function, nothing to deploy).
--
-- Rested numbers come back through the existing lazy private.reactivate_rested_numbers, or by an admin tapping
-- Reactivate (setPhoneNumberStatus 'active').

-- ---------------------------------------------------------------------------------------------------------
-- 1. org settings
-- ---------------------------------------------------------------------------------------------------------
alter table public.org_number_health_settings
  add column if not exists auto_rest_likely_flagged boolean not null default true,
  add column if not exists auto_rest_days int not null default 3
    check (auto_rest_days between 1 and 30);

-- ---------------------------------------------------------------------------------------------------------
-- 2. the scores view
-- ---------------------------------------------------------------------------------------------------------
create view public.number_health_scores with (security_invoker = on) as
with legs as (
  select
    cl.from_number_id as number_id,
    (cl.created_at >= now() - interval '7 days') as this_week,
    (cl.created_at at time zone 'utc')::date as day,
    (cl.outcome = 'connected') as connected,
    cl.duration_seconds
  from public.call_legs cl
  where cl.kind = 'contact'
    and cl.from_number_id is not null
    and cl.created_at >= now() - interval '30 days'
),
agg as (
  select
    number_id,
    count(*) as dials_30d,
    count(*) filter (where not this_week) as dials_base,
    count(*) filter (where connected and duration_seconds is not null) as answered_timed,
    count(*) filter (where connected and duration_seconds >= 10) as answered_10s,
    count(*) filter (where this_week and connected and duration_seconds is not null) as timed_7d,
    count(*) filter (where this_week and connected and duration_seconds >= 10) as ten_7d,
    count(*) filter (where not this_week and connected and duration_seconds is not null) as timed_base,
    count(*) filter (where not this_week and connected and duration_seconds >= 10) as ten_base,
    count(distinct day) as active_days
  from legs
  group by number_id
),
j as (
  select
    b.number_id, b.org_id, b.phone_number, b.status,
    upn.resting_until, upn.flagged_at, upn.flagged_reason,
    coalesce(s.min_sample_dials, 20) as min_sample,
    b.dials_7d, b.answer_rate_7d as rate_7d, b.answer_rate_prior as rate_base, b.pool_median_7d as median_7d,
    coalesce(a.dials_30d, 0) as dials_30d,
    coalesce(a.dials_base, 0) as dials_base,
    coalesce(a.answered_timed, 0) as answered_timed,
    coalesce(a.answered_10s, 0) as answered_10s,
    coalesce(a.timed_7d, 0) as timed_7d, coalesce(a.ten_7d, 0) as ten_7d,
    coalesce(a.timed_base, 0) as timed_base, coalesce(a.ten_base, 0) as ten_base,
    b.quick_hangup_share,
    coalesce(a.active_days, 0) as active_days
  from public.number_health_badges b
  join public.user_phone_numbers upn on upn.id = b.number_id
  left join public.org_number_health_settings s on s.org_id = b.org_id
  left join agg a on a.number_id = b.number_id
),
scored as (
  select
    j.*,
    -- reference rate: the better of the pool median and the number's own baseline (baseline only if it has
    -- enough dials to mean something)
    greatest(
      coalesce(j.median_7d, 0),
      case when j.dials_base >= greatest(j.min_sample, 50) then coalesce(j.rate_base, 0) else 0 end
    ) as ref_rate,
    (j.dials_7d >= greatest(j.min_sample, 50)
      and j.dials_base >= 50
      and j.rate_base is not null and j.rate_base > 0
      and j.rate_7d is not null
      and j.rate_7d < j.rate_base * 0.5
      and j.rate_base - j.rate_7d >= 0.05
      and j.median_7d is not null and j.median_7d > 0
      and j.rate_7d < j.median_7d * 0.5
      and j.status = 'active'
      and (j.flagged_at is null or j.flagged_at < now() - interval '7 days')
    ) as likely_flagged,
    -- number-level confirmation for AUTO-rest (a bad week for an agent's list also looks like a drop against
    -- other agents' numbers): people who answer hang up quickly (5 s share 40%+), or the share of answered
    -- calls that stay 10 s+ fell by 15+ points against the earlier weeks (10+ timed answers in each window).
    (coalesce(j.quick_hangup_share, 0) >= 0.4
      or (j.timed_7d >= 10 and j.timed_base >= 10
          and j.ten_base::numeric / j.timed_base - j.ten_7d::numeric / j.timed_7d >= 0.15)
    ) as confirm_signal
  from j
)
select
  number_id,
  org_id,
  phone_number,
  status,
  resting_until,
  flagged_at,
  flagged_reason,
  case
    when dials_7d < min_sample or rate_7d is null then null
    when ref_rate <= 0 then case when rate_7d > 0 then 100 end
    else round(100 * least(1, rate_7d / ref_rate))::int
  end as answer_score,
  case when answered_timed >= 10 then round(100.0 * answered_10s / answered_timed)::int end as stay_score,
  round(60.0 * least(dials_30d, 200) / 200 + 40.0 * least(active_days, 14) / 14)::int as history_score,
  likely_flagged,
  (likely_flagged and confirm_signal) as auto_rest_confirmed,
  case when likely_flagged then
    format('Answer rate fell from %s%% to %s%% this week, and your other numbers are at %s%%',
      round(rate_base * 100), round(rate_7d * 100), round(median_7d * 100))
  end as likely_flagged_reason,
  dials_7d,
  dials_30d,
  active_days,
  answered_timed as answered_30d,
  answered_10s as answered_10s_30d
from scored;

alter view public.number_health_scores set (security_invoker = on);

-- ---------------------------------------------------------------------------------------------------------
-- 3. auto-rest
-- ---------------------------------------------------------------------------------------------------------
create function public.auto_rest_likely_flagged_numbers(p_org_id uuid default null)
returns table (number_id uuid, org_id uuid, phone_number text, reason text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_org record;
  v_cand record;
  v_safe boolean;
  v_body text;
  v_reason text;
begin
  for v_org in
    select s.org_id, s.auto_rest_days
    from public.org_number_health_settings s
    where s.auto_rest_likely_flagged
      and (p_org_id is null or s.org_id = p_org_id)
  loop
    -- serialise per org so two runs never both rest "the second to last" number
    perform 1 from public.user_phone_numbers upn
      where upn.org_id = v_org.org_id and upn.status = 'active'
      for update;

    for v_cand in
      select sc.number_id, sc.phone_number, sc.likely_flagged_reason, sc.auto_rest_confirmed,
             upn.assigned_user_id
      from public.number_health_scores sc
      join public.user_phone_numbers upn on upn.id = sc.number_id
      where sc.org_id = v_org.org_id and sc.likely_flagged
      order by sc.answer_score nulls last, sc.dials_7d desc
    loop
      -- a likely-flagged number with no second sign (see confirm_signal) only keeps its warning
      continue when not v_cand.auto_rest_confirmed;

      -- Every agent who can dial from this number must keep another usable number (same rule as
      -- private.has_available_dial_number / pick_and_reserve_dial_number: active, and assigned to the agent
      -- or unassigned). Re-evaluated per candidate, so earlier rests in this run count.
      if v_cand.assigned_user_id is not null then
        v_safe := exists (
          select 1 from public.user_phone_numbers n2
          where n2.org_id = v_org.org_id and n2.id <> v_cand.number_id and n2.status = 'active'
            and (n2.assigned_user_id is null or n2.assigned_user_id = v_cand.assigned_user_id));
      else
        v_safe := exists (
          select 1 from public.user_phone_numbers n2
          where n2.org_id = v_org.org_id and n2.id <> v_cand.number_id and n2.status = 'active'
            and n2.assigned_user_id is null)
        or not exists (
          select 1 from public.org_members m
          where m.org_id = v_org.org_id and m.status = 'active'
            and not exists (select 1 from public.user_phone_numbers n3
              where n3.org_id = v_org.org_id and n3.status = 'active' and n3.assigned_user_id = m.user_id));
      end if;

      if not v_safe then
        -- keep the warning, tell the admins once a week
        v_body := v_cand.phone_number || ' looks flagged but could not be rested automatically: it is '
          || case when v_cand.assigned_user_id is not null then 'its assigned agent''s only number'
                  else 'the only number in the shared pool' end
          || ' (' || v_cand.likely_flagged_reason || '). Add a number in Settings > Telephony > Numbers.';
        insert into public.notifications (org_id, user_id, type, title, body)
        select v_org.org_id, m.user_id, 'number_auto_rest_blocked', 'A flagged number could not be rested', v_body
        from public.org_members m
        where m.org_id = v_org.org_id and m.status = 'active' and m.role in ('owner', 'admin')
          and not exists (select 1 from public.notifications n
            where n.user_id = m.user_id and n.type = 'number_auto_rest_blocked' and n.body = v_body
              and n.created_at > now() - interval '7 days');
        continue;
      end if;

      v_reason := 'Likely flagged: ' || v_cand.likely_flagged_reason;
      update public.user_phone_numbers upn
      set status = 'resting',
          resting_until = now() + make_interval(days => v_org.auto_rest_days),
          flagged_at = now(),
          flagged_reason = v_reason
      where upn.id = v_cand.number_id and upn.status = 'active';

      if found then
        perform private.log_org_action(
          v_org.org_id, 'number.auto_rest', 'phone_number', v_cand.number_id,
          jsonb_build_object('phone_number', v_cand.phone_number, 'reason', v_reason,
                             'rest_days', v_org.auto_rest_days),
          null
        );
        insert into public.notifications (org_id, user_id, type, title, body)
        select v_org.org_id, m.user_id, 'number_auto_rested',
               'A phone number was rested automatically',
               v_cand.phone_number || ' looks flagged (' || v_cand.likely_flagged_reason || '). It is resting for '
                 || v_org.auto_rest_days || ' days. You can reactivate it in Settings > Telephony > Numbers.'
        from public.org_members m
        where m.org_id = v_org.org_id and m.status = 'active' and m.role in ('owner', 'admin');

        number_id := v_cand.number_id;
        org_id := v_org.org_id;
        phone_number := v_cand.phone_number;
        reason := v_reason;
        return next;
      end if;
    end loop;
  end loop;
end;
$$;

revoke all on function public.auto_rest_likely_flagged_numbers(uuid) from public, anon, authenticated;
grant execute on function public.auto_rest_likely_flagged_numbers(uuid) to service_role;

-- ---------------------------------------------------------------------------------------------------------
-- 4. cron: every 6 hours, SQL only
-- ---------------------------------------------------------------------------------------------------------
create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('h40-auto-rest-likely-flagged', '20 */6 * * *',
  $$select public.auto_rest_likely_flagged_numbers(null);$$);

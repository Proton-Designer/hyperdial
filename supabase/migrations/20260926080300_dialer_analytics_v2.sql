-- MISSION-4 TASK-T11 (ADM-8 + NEW): dialer analytics -- per-campaign funnel, best-time-to-call
-- heatmap (contact-local time), connect rate by caller-ID number and by hour. Timestamp from
-- eng1's own assigned range (20260926080000-089999), next unused slot after 080000/080100/080200.
--
-- All four functions below are "front door read" SECURITY DEFINER functions, same shape as
-- 20260925080100_team_view.sql's team_daily_stats/team_live_board (see that file's own header for
-- the full rationale) -- callable directly by the client via supabase.rpc(), granted to
-- `authenticated` directly, each checks the caller's own org role INSIDE the function
-- (private.has_org_role/is_org_member, meaningful here since auth.uid() is the real caller's JWT,
-- not a service-role edge function's). An agent gets their OWN legs only (scoped by
-- ds.agent_id = auth.uid()); owner/admin get the whole org, optionally narrowed by p_campaign_id.
-- A caller who isn't even a member of p_org gets zero rows back, never an error.

-- ---- 1. call_leg_analytics: widen with from_number_id (connect-rate-by-number) + the contact's
-- own timezone (the heatmap's "in the CONTACT's local time" requirement) -- byte-identical to the
-- live 20260925060000 definition otherwise. -----------------------------------------------------

create or replace view public.call_leg_analytics with (security_invoker = on) as
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
  cl.ended_at,
  coalesce(d.is_win, false) as is_win,
  cl.from_number_id,
  unp.phone_number as caller_id_phone_number,
  ct.timezone as contact_timezone
from public.call_legs cl
join public.dial_sessions ds on ds.id = cl.session_id
left join public.dispositions d on d.id = cl.disposition_id
left join public.user_phone_numbers unp on unp.id = cl.from_number_id
left join public.contacts ct on ct.id = cl.contact_id
where cl.kind = 'contact';

-- ---- 2. funnel_summary: dials -> human answers -> conversations (>=30s) -> wins ----------------
-- "Human answer" = the AMD state machine actually reached a post-answer, non-machine outcome
-- (call_legs' own state machine: answered -> amd_pending -> claimed/dropped/abandoned/machine --
-- dropped/abandoned only happen AFTER amd_pending cleared the leg as non-machine, same as
-- 'connected'; 'machine'/'voicemail_left' are the AMD-detected-machine branch, never a human).
-- no_answer/busy/failed never reached amd_pending at all. See .brain/domains/dialer.md's own
-- state-machine listing -- not assumed, read directly from there before writing this predicate.

create function public.funnel_summary(
  p_org uuid, p_campaign_id uuid, p_start timestamptz, p_end timestamptz
)
returns table (dials integer, human_answers integer, conversations integer, wins integer)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_is_admin boolean;
begin
  if not private.is_org_member(p_org) then
    return;
  end if;
  v_is_admin := private.has_org_role(p_org, array['owner', 'admin']);

  return query
  select
    count(*)::integer as dials,
    count(*) filter (where cl.outcome in ('connected', 'dropped', 'abandoned'))::integer
      as human_answers,
    count(*) filter (where cl.outcome = 'connected' and cl.duration_seconds >= 30)::integer
      as conversations,
    count(*) filter (where d.is_win)::integer as wins
  from public.call_legs cl
  join public.dial_sessions ds on ds.id = cl.session_id
  left join public.dispositions d on d.id = cl.disposition_id
  where cl.org_id = p_org
    and cl.kind = 'contact'
    and cl.created_at >= p_start
    and cl.created_at < p_end
    and (p_campaign_id is null or cl.campaign_id = p_campaign_id)
    and (v_is_admin or ds.agent_id = auth.uid());
end;
$$;

revoke all on function public.funnel_summary(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.funnel_summary(uuid, uuid, timestamptz, timestamptz) to authenticated;

-- ---- 3. answer_rate_heatmap: weekday (0=Sunday, per Postgres extract(dow)) x hour, in the
-- CONTACT's own local time (falls back to UTC when a contact has no timezone set, same fallback
-- dialing_hours_today already uses for "no orgs.timezone column" -- here it's per-CONTACT, not
-- per-org, so a null just means "assume UTC for this one row" rather than a hardcoded org-wide
-- zone). Bucketed on cl.created_at (the DIAL time, not answered_at) -- a "best time to call"
-- heatmap answers "if I dial during THIS bucket, what fraction of dials reach a human?", so the
-- denominator (dials) must be EVERY contact leg dialed in that bucket, including no_answer/busy/
-- failed/machine ones -- bucketing on answered_at and filtering to answered-only (an earlier
-- revision of this function) silently answered a different, narrower question ("of the calls
-- that got far enough to be answered, human vs machine") and is wrong for this feature's actual
-- purpose. Caught by the T11 dry-run's own total-dials assertion expecting all 5 seeded legs and
-- getting only 3 (the answered ones) -- fixed here rather than in the fixture, since the fixture's
-- expectation (all 5) was the correct spec, not the bug. -----------------------------------------

create function public.answer_rate_heatmap(
  p_org uuid, p_campaign_id uuid, p_start timestamptz, p_end timestamptz
)
returns table (weekday integer, hour integer, dials integer, human_answers integer)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_is_admin boolean;
begin
  if not private.is_org_member(p_org) then
    return;
  end if;
  v_is_admin := private.has_org_role(p_org, array['owner', 'admin']);

  return query
  select
    extract(dow from timezone(coalesce(ct.timezone, 'UTC'), cl.created_at))::integer as weekday,
    extract(hour from timezone(coalesce(ct.timezone, 'UTC'), cl.created_at))::integer as hour,
    count(*)::integer as dials,
    count(*) filter (where cl.outcome in ('connected', 'dropped', 'abandoned'))::integer
      as human_answers
  from public.call_legs cl
  join public.dial_sessions ds on ds.id = cl.session_id
  left join public.contacts ct on ct.id = cl.contact_id
  where cl.org_id = p_org
    and cl.kind = 'contact'
    and cl.created_at >= p_start
    and cl.created_at < p_end
    and (p_campaign_id is null or cl.campaign_id = p_campaign_id)
    and (v_is_admin or ds.agent_id = auth.uid())
  group by 1, 2;
end;
$$;

revoke all on function public.answer_rate_heatmap(uuid, uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.answer_rate_heatmap(uuid, uuid, timestamptz, timestamptz) to authenticated;

-- ---- 4. connect_rate_by_number: which pool/legacy caller-ID number is converting -- NUMBER
-- HEALTH, not a per-agent metric, so this one is org-wide for owner/admin and refuses an agent
-- entirely (an agent doesn't choose or manage caller-ID numbers, same reasoning team_daily_stats'
-- own owner/admin-only gate uses) rather than silently scoping to "their own calls on a number,"
-- which would misrepresent a number's real health. from_number_id is null for a leg dialed via the
-- legacy campaigns.caller_id_number_id path (pre-number-pool) -- grouped separately as a null row
-- (label resolved client-side to "Campaign default"), not dropped, since that path is still live
-- for any campaign that never adopted the pool. --------------------------------------------------

create function public.connect_rate_by_number(p_org uuid, p_start timestamptz, p_end timestamptz)
returns table (from_number_id uuid, phone_number text, dials integer, human_answers integer)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    return;
  end if;

  return query
  select
    cl.from_number_id,
    unp.phone_number,
    count(*)::integer as dials,
    count(*) filter (where cl.outcome in ('connected', 'dropped', 'abandoned'))::integer
      as human_answers
  from public.call_legs cl
  left join public.user_phone_numbers unp on unp.id = cl.from_number_id
  where cl.org_id = p_org
    and cl.kind = 'contact'
    and cl.created_at >= p_start
    and cl.created_at < p_end
  group by cl.from_number_id, unp.phone_number;
end;
$$;

revoke all on function public.connect_rate_by_number(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.connect_rate_by_number(uuid, timestamptz, timestamptz) to authenticated;

-- ---- 5. connect_rate_by_hour: SERVER (UTC) hour of day, matching this app's own established
-- "everything is still UTC-bucketed" convention (.brain/domains/analytics.md) for every OTHER
-- chart -- deliberately NOT contact-local like the heatmap above, since this one is about which
-- hour of the agent's/org's own clock tends to convert (staffing/scheduling), not the contact's.
-- Same admin-only, org-wide gate as connect_rate_by_number for the same "number/schedule health,
-- not a personal metric" reasoning. -----------------------------------------------------------

create function public.connect_rate_by_hour(p_org uuid, p_start timestamptz, p_end timestamptz)
returns table (hour integer, dials integer, human_answers integer)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    return;
  end if;

  return query
  select
    extract(hour from cl.created_at)::integer as hour,
    count(*)::integer as dials,
    count(*) filter (where cl.outcome in ('connected', 'dropped', 'abandoned'))::integer
      as human_answers
  from public.call_legs cl
  where cl.org_id = p_org
    and cl.kind = 'contact'
    and cl.created_at >= p_start
    and cl.created_at < p_end
  group by 1;
end;
$$;

revoke all on function public.connect_rate_by_hour(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.connect_rate_by_hour(uuid, timestamptz, timestamptz) to authenticated;

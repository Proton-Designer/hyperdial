-- MISSION-5 TASK-M5-A4 (Team cockpit v2), eng1 range.
--
-- 1. org_timezone_settings: a real per-org IANA timezone (owner/admin editable), replacing every
--    hardcoded 'America/Chicago' "today" boundary this codebase had. Same "org_<feature>_settings"
--    singleton-table shape as org_pause_reason_settings (20260927070001) -- see that file's own
--    header for why this is a dedicated table with its own RLS rather than a column on `orgs`
--    itself (`orgs`' own UPDATE policy is owner-only; widening it to admin for one column would
--    hand admin write access to every other orgs column too).
-- 2. dialing_hours_today / team_live_board: read the org's real timezone from that table instead
--    of the hardcoded literal (coalesced back to 'America/Chicago' if a row is somehow missing --
--    defense in depth, the seed trigger + backfill below should make that unreachable).
--    team_live_board also gains campaign_id/campaign_name (A4: "filters (status, campaign)" needs
--    something to filter ON -- Team.tsx does the actual filtering client-side over these).
-- 3. agent_time_in_state (B1 review, formalized by the lead as a required A4 fix): exclude
--    'stopped'/'completed' time from the base events CTE (today a stopped session's own event row
--    stays open -- unbounded -- until the agent's next session, so it silently accumulates as
--    ordinary "state time" in any range query touching it); add an agent-self-view path (an agent
--    may query only their own agent_id -- fails closed for anything else, including a null/other
--    p_agent from an agent-role caller).
-- 4. call_leg_analytics: add disposition_lead_effect (dashboard-stats' new "my callbacks today").
-- 5. agent_self_stats: new RPC, any org member (not just owner/admin) callable for THEIR OWN
--    numbers only (auth.uid(), never a p_agent param -- there is no way to ask for anyone else's
--    row), plus a team_median_conversations_per_hr computed server-side so the client never sees
--    any other agent's individual numbers or identity. Backs A4's "My stats: today and this week
--    vs the team median" (Dashboard.tsx).

-- =================================================================================================
-- 1. org_timezone_settings
-- =================================================================================================

create table public.org_timezone_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  timezone text not null default 'America/Chicago',
  updated_at timestamptz not null default now()
);

alter table public.org_timezone_settings enable row level security;

create policy "org members can view timezone settings"
  on public.org_timezone_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert timezone settings"
  on public.org_timezone_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update timezone settings"
  on public.org_timezone_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create function private.seed_default_timezone_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.org_timezone_settings (org_id)
  values (new.id)
  on conflict (org_id) do nothing;
  return new;
end;
$$;

create trigger orgs_seed_default_timezone_settings
  after insert on public.orgs
  for each row execute function private.seed_default_timezone_settings_trigger();

insert into public.org_timezone_settings (org_id)
select id from public.orgs
on conflict (org_id) do nothing;

-- =================================================================================================
-- 2a. dialing_hours_today: same signature/return type, just reads the org's real timezone now.
-- =================================================================================================

create or replace function public.dialing_hours_today(p_org_id uuid, p_agent_id uuid)
returns numeric
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    sum(
      extract(epoch from (
        coalesce(ds.ended_at, now())
        - greatest(
            ds.started_at,
            date_trunc(
              'day',
              now() at time zone coalesce(
                (select ots.timezone from public.org_timezone_settings ots where ots.org_id = p_org_id),
                'America/Chicago'
              )
            ) at time zone coalesce(
              (select ots.timezone from public.org_timezone_settings ots where ots.org_id = p_org_id),
              'America/Chicago'
            )
          )
      )) / 3600.0
    ),
    0
  )::numeric
  from public.dial_sessions ds
  where ds.org_id = p_org_id
    and ds.agent_id = p_agent_id
    and coalesce(ds.ended_at, now()) > (
      date_trunc(
        'day',
        now() at time zone coalesce(
          (select ots.timezone from public.org_timezone_settings ots where ots.org_id = p_org_id),
          'America/Chicago'
        )
      ) at time zone coalesce(
        (select ots.timezone from public.org_timezone_settings ots where ots.org_id = p_org_id),
        'America/Chicago'
      )
    )
    and ds.started_at < now();
$$;

revoke all on function public.dialing_hours_today(uuid, uuid) from public, anon, authenticated;
grant execute on function public.dialing_hours_today(uuid, uuid) to service_role;

-- =================================================================================================
-- 2b. team_live_board: read the org's real timezone; add campaign_id/campaign_name (a return-type
--     change -- DROP + recreate, same shape 20260927070003 already used, grants repeated verbatim
--     since DROP FUNCTION also drops them).
-- =================================================================================================

drop function public.team_live_board(uuid);

create function public.team_live_board(p_org uuid)
returns table (
  agent_id uuid,
  name text,
  role text,
  status text,
  lines smallint,
  contact_name text,
  state_since timestamptz,
  session_started_at timestamptz,
  calls_today integer,
  conversations_today integer,
  pause_reason text,
  campaign_id uuid,
  campaign_name text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_today_start timestamptz;
  v_today_end timestamptz;
  v_tz text;
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    return;
  end if;

  select coalesce(ots.timezone, 'America/Chicago') into v_tz
  from public.org_timezone_settings ots
  where ots.org_id = p_org;
  v_tz := coalesce(v_tz, 'America/Chicago');

  v_today_start := date_trunc('day', now() at time zone v_tz) at time zone v_tz;
  v_today_end := v_today_start + interval '1 day';

  return query
  with members as (
    select
      m.user_id,
      m.role as member_role,
      coalesce(
        nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
        u.email,
        'Member'
      ) as full_name
    from public.org_members m
    left join public.profiles p on p.user_id = m.user_id
    left join auth.users u on u.id = m.user_id
    where m.org_id = p_org and m.status = 'active'
  ),
  current_session as (
    select distinct on (ds.agent_id)
      ds.agent_id, ds.state, ds.lines, ds.started_at, ds.updated_at, ds.active_leg_id,
      ds.pause_reason, ds.campaign_id
    from public.dial_sessions ds
    where ds.org_id = p_org
      and ds.state not in ('stopped', 'completed')
    order by ds.agent_id, ds.started_at desc
  ),
  today_legs as (
    select
      ds.agent_id,
      count(*) as calls_today,
      count(*) filter (where cl.outcome = 'connected' and cl.duration_seconds >= 30) as conversations_today
    from public.call_legs cl
    join public.dial_sessions ds on ds.id = cl.session_id
    where cl.org_id = p_org
      and cl.kind = 'contact'
      and cl.created_at >= v_today_start
      and cl.created_at < v_today_end
    group by ds.agent_id
  )
  select
    mem.user_id,
    mem.full_name,
    mem.member_role,
    case
      when cs.agent_id is null then 'offline'
      when cs.state in ('ready_pending', 'ready') then 'ready'
      when cs.state in ('dialing', 'connecting') then 'dialing'
      when cs.state = 'on_call' then 'on_call'
      when cs.state = 'wrap_up' then 'wrap_up'
      when cs.state in ('paused', 'paused_agent_lost') then 'paused'
      else 'offline'
    end,
    cs.lines,
    nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
    cs.updated_at,
    cs.started_at,
    coalesce(tl.calls_today, 0)::int,
    coalesce(tl.conversations_today, 0)::int,
    case when cs.state in ('paused', 'paused_agent_lost') then cs.pause_reason else null end,
    cs.campaign_id,
    camp.name
  from members mem
  left join current_session cs on cs.agent_id = mem.user_id
  left join public.call_legs al on al.id = cs.active_leg_id
  left join public.contacts c on c.id = al.contact_id
  left join public.campaigns camp on camp.id = cs.campaign_id
  left join today_legs tl on tl.agent_id = mem.user_id
  order by mem.full_name;
end;
$$;

revoke all on function public.team_live_board(uuid) from public, anon;
grant execute on function public.team_live_board(uuid) to authenticated;

-- =================================================================================================
-- 3. agent_time_in_state: exclude 'stopped'/'completed' time; add the agent-self-view path.
--    Same signature/return type -- create or replace is enough.
-- =================================================================================================

create or replace function public.agent_time_in_state(
  p_org uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_agent uuid default null,
  p_tz text default 'America/Chicago'
)
returns table (
  agent_id uuid,
  day date,
  state text,
  reason text,
  seconds bigint
)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    -- A4 (formalizing the B1 review's S3/qb finding): an agent may query ONLY their own rows,
    -- p_agent must be exactly their own auth.uid() -- never null, never someone else's -- or this
    -- fails closed (no rows), same "return with no rows rather than raise" shape as every other
    -- gate in this file.
    --
    -- REAL BUG, caught by the lead's live dry-run before this ever deployed: `p_agent =
    -- auth.uid()` is NULL (not false) when p_agent is NULL -- SQL's three-valued logic -- so
    -- `not (true and null)` is also NULL, and a plpgsql `if` treats a NULL condition as FALSE
    -- (doesn't fire). An agent-role caller omitting p_agent entirely sailed straight past this
    -- guard and into the main query, whose own `(p_agent is null or e.agent_id = p_agent)` filter
    -- then matched EVERY agent's rows -- the exact opposite of "an agent may query only their
    -- own rows". `is distinct from` is NULL-safe (never itself NULL), so this now correctly
    -- fails closed on a null, wrong, or missing p_agent.
    if not private.has_org_role(p_org, array['agent'])
      or p_agent is null
      or p_agent is distinct from auth.uid()
    then
      return;
    end if;
  end if;

  return query
  with events as (
    select
      e.agent_id,
      e.state,
      e.reason,
      least(coalesce(e.ended_at, now()), p_to) as clipped_end,
      greatest(e.started_at, p_from) as clipped_start
    from public.agent_state_events e
    where e.org_id = p_org
      and (p_agent is null or e.agent_id = p_agent)
      and e.state not in ('stopped', 'completed')
      and e.started_at < p_to
      and coalesce(e.ended_at, now()) > p_from
  ),
  spanned_days as (
    select
      ev.agent_id, ev.state, ev.reason, ev.clipped_start, ev.clipped_end,
      d.day_start
    from events ev
    cross join lateral generate_series(
      date_trunc('day', ev.clipped_start at time zone p_tz),
      date_trunc('day', ev.clipped_end at time zone p_tz),
      interval '1 day'
    ) as d(day_start)
  )
  select
    sd.agent_id,
    (sd.day_start)::date as day,
    sd.state,
    sd.reason,
    sum(
      extract(epoch from (
        least(sd.clipped_end, (sd.day_start + interval '1 day') at time zone p_tz)
        - greatest(sd.clipped_start, sd.day_start at time zone p_tz)
      ))
    )::bigint as seconds
  from spanned_days sd
  group by sd.agent_id, (sd.day_start)::date, sd.state, sd.reason
  having sum(
      extract(epoch from (
        least(sd.clipped_end, (sd.day_start + interval '1 day') at time zone p_tz)
        - greatest(sd.clipped_start, sd.day_start at time zone p_tz)
      ))
    ) > 0
  order by 1, 2, 3;
end;
$$;

-- =================================================================================================
-- 4. call_leg_analytics: add disposition_lead_effect (dashboard-stats' "my callbacks today").
--    Appending a column at the end -- create or replace view, no drop needed.
-- =================================================================================================

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
  ct.timezone as contact_timezone,
  d.lead_effect as disposition_lead_effect
from public.call_legs cl
join public.dial_sessions ds on ds.id = cl.session_id
left join public.dispositions d on d.id = cl.disposition_id
left join public.user_phone_numbers unp on unp.id = cl.from_number_id
left join public.contacts ct on ct.id = cl.contact_id;

-- =================================================================================================
-- 5. agent_self_stats: an agent's own numbers + a team median, no other agent's identity exposed.
--    Any active org member may call this for themselves (private.is_org_member, not
--    has_org_role(['owner','admin']) -- unlike team_daily_stats, this is a self-view, not a
--    manager rollup); there is no p_agent parameter, so there is no way to ask for anyone else's
--    row. team_median_conversations_per_hr is computed across every active member's own
--    conversations_per_hr for the SAME window server-side and returned as a single scalar --
--    the per-agent rows that feed it never leave this function.
-- =================================================================================================

create function public.agent_self_stats(p_org uuid, p_start timestamptz, p_end timestamptz)
returns table (
  dials integer,
  connects integer,
  connect_rate numeric,
  conversations integer,
  conversations_per_hr numeric,
  wins integer,
  callbacks_set integer,
  talk_time_seconds integer,
  dialing_hours numeric,
  team_median_conversations_per_hr numeric
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
begin
  if not private.is_org_member(p_org) then
    return;
  end if;

  return query
  with active_members as (
    select m.user_id
    from public.org_members m
    where m.org_id = p_org and m.status = 'active'
  ),
  legs as (
    select ds.agent_id, cl.outcome, cl.duration_seconds, cl.disposition_id
    from public.call_legs cl
    join public.dial_sessions ds on ds.id = cl.session_id
    where cl.org_id = p_org
      and cl.kind = 'contact'
      and cl.created_at >= p_start
      and cl.created_at < p_end
  ),
  agg as (
    select
      l.agent_id,
      count(*) as dials,
      count(*) filter (where l.outcome = 'connected') as connects,
      count(*) filter (where l.outcome = 'connected' and l.duration_seconds >= 30) as conversations,
      coalesce(sum(l.duration_seconds) filter (where l.outcome = 'connected'), 0) as talk_time_seconds,
      count(*) filter (where d.is_win) as wins,
      count(*) filter (where d.lead_effect = 'callback') as callbacks_set
    from legs l
    left join public.dispositions d on d.id = l.disposition_id
    group by l.agent_id
  ),
  hours as (
    select
      ds.agent_id,
      coalesce(sum(
        extract(epoch from (
          least(coalesce(ds.ended_at, now()), p_end) - greatest(ds.started_at, p_start)
        )) / 3600.0
      ), 0) as dialing_hours
    from public.dial_sessions ds
    where ds.org_id = p_org
      and ds.started_at < p_end
      and coalesce(ds.ended_at, now()) > p_start
    group by ds.agent_id
  ),
  per_agent as (
    select
      am.user_id as agent_id,
      coalesce(a.dials, 0)::int as dials,
      coalesce(a.connects, 0)::int as connects,
      coalesce(a.conversations, 0)::int as conversations,
      coalesce(a.wins, 0)::int as wins,
      coalesce(a.callbacks_set, 0)::int as callbacks_set,
      coalesce(a.talk_time_seconds, 0)::int as talk_time_seconds,
      coalesce(h.dialing_hours, 0)::numeric as dialing_hours,
      case when coalesce(h.dialing_hours, 0) >= 0.1
        then round((coalesce(a.conversations, 0)::numeric / h.dialing_hours) * 100) / 100
        else null
      end as conversations_per_hr
    from active_members am
    left join agg a on a.agent_id = am.user_id
    left join hours h on h.agent_id = am.user_id
  )
  select
    pa.dials,
    pa.connects,
    case when pa.dials > 0 then round((pa.connects::numeric / pa.dials) * 1000) / 10 else 0 end,
    pa.conversations,
    pa.conversations_per_hr,
    pa.wins,
    pa.callbacks_set,
    pa.talk_time_seconds,
    round(pa.dialing_hours, 2),
    (
      select round((percentile_cont(0.5) within group (order by pa2.conversations_per_hr))::numeric, 2)
      from per_agent pa2
      where pa2.conversations_per_hr is not null
    ) as team_median_conversations_per_hr
  from per_agent pa
  where pa.agent_id = v_caller;
end;
$$;

revoke all on function public.agent_self_stats(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.agent_self_stats(uuid, timestamptz, timestamptz) to authenticated;

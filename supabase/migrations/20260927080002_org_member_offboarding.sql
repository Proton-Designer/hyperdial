-- MISSION-5 TASK-M5-A3: deactivate/remove/offboard, done right. B3 (eng2's reassign RPC for
-- due/future callbacks) has not landed yet -- this migration + its edge-function counterpart
-- build everything that does NOT depend on it: the disable/remove cascade (halt new-batch
-- dialing, release numbers to the pool), soft-remove with a 72h restore window, the admin
-- lock-out guard, releasing an offboarded agent's own QUEUED leads back to the pool, and fixing
-- team_daily_stats so a disabled/removed member's PAST performance doesn't vanish from a
-- historical date-range query the moment they're taken off the roster.
--
-- Reassigning QUEUED leads specifically to the pool (not to a chosen agent) does NOT reuse
-- TASK-T6's `assign_campaign_leads(p_campaign_id, p_agent_id, p_filter)`: that RPC's own
-- `candidates` CTE selects EVERY currently-queued lead in the campaign matching `p_filter`,
-- regardless of who (if anyone) currently holds it -- calling it with `p_agent_id := null` to
-- "release just this agent's leads" would also unassign every OTHER agent's own slice on the
-- same campaign, since there is no "currently assigned to X" filter mode. Wrong tool for this
-- job; `release_agent_queued_leads` below is a new, narrowly-scoped RPC instead (WHERE
-- assigned_agent_id = p_agent, not a campaign-wide sweep). Reassigning due/future CALLBACKS
-- (campaign_leads.status = 'callback') has no RPC at all yet -- that step of the offboarding
-- wizard is deliberately left for B3.

-- =================================================================================================
-- 1. org_members: a real 'removed' status (soft-remove, not `.delete()`), with a restore window.
-- =================================================================================================

alter table public.org_members drop constraint org_members_status_check;
alter table public.org_members add constraint org_members_status_check
  check (status in ('active', 'disabled', 'removed'));

alter table public.org_members add column removed_at timestamptz;

comment on column public.org_members.removed_at is
  'TASK-M5-A3: set when status is flipped to ''removed'' (org-members edge function, action
   ''remove''). Restorable (action ''restore'', status back to ''active'', this column cleared)
   only while now() - removed_at < 72 hours -- enforced in the edge function, not here, since the
   check needs no new SQL (a plain UPDATE through the same RLS this table already has); the
   ''permanent'' half of ''restorable for 72h, then permanent'' is simply that restore stops being
   offered after the window, never a second status value or a data-deletion sweep -- the row (and
   every join to it) is kept forever either way, which is exactly what keeps historical stats/
   dispositions/recordings attributed to the right name.';

-- private.is_org_member / private.has_org_role (20260924000100) both already filter
-- `m.status = 'active'`, so a 'removed' member (same as an already-'disabled' one) is already
-- correctly refused by every RLS policy and by `requireOrgRole`/`requireTelnyxOrgRole` (both
-- Edge-Function-side gates independently filter `.eq('status', 'active')`, confirmed by reading
-- their current source, not assumed) -- "can't start a session or call any function" needed no
-- change here.

-- =================================================================================================
-- 2. team_daily_stats: a historical, date-ranged rollup must not silently drop a member's own
--    PAST rows just because their org_members row is no longer 'active' today. team_live_board
--    (the CURRENT, right-now board) is correctly untouched -- a disabled/removed agent isn't
--    "live" and 070003 (M5-B1) already treats a non-active current_session as plain 'offline' via
--    its own left join, nothing to fix there.
--
--    Fix: the `members` CTE now includes every 'active' member (unchanged, so an active member
--    with zero activity in range still shows a zeroed row, same as before) PLUS any
--    disabled/removed member who actually had a dial_sessions row touching [p_start, p_end) --
--    the exact same overlap test the `hours` CTE below already uses to decide "did this agent do
--    anything in this window", so a member removed years before an unrelated query window still
--    doesn't clutter it, but shows up correctly for any range that covers when they worked.
--    Same signature/return type as before (`create or replace` is enough, no drop+recreate
--    needed -- unlike 070003/080101, this doesn't add or remove a returned column).

create or replace function public.team_daily_stats(p_org uuid, p_start timestamptz, p_end timestamptz)
returns table (
  agent_id uuid,
  name text,
  role text,
  dials integer,
  connects integer,
  connect_rate numeric,
  conversations integer,
  conversations_per_hr numeric,
  wins integer,
  callbacks_set integer,
  talk_time_seconds integer,
  dialing_hours numeric
)
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
    where m.org_id = p_org
      and (
        m.status = 'active'
        or exists (
          select 1 from public.dial_sessions ds2
          where ds2.org_id = p_org
            and ds2.agent_id = m.user_id
            and ds2.started_at < p_end
            and coalesce(ds2.ended_at, now()) > p_start
        )
      )
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
  )
  select
    mem.user_id,
    mem.full_name,
    mem.member_role,
    coalesce(a.dials, 0)::int,
    coalesce(a.connects, 0)::int,
    case when coalesce(a.dials, 0) > 0
      then round((coalesce(a.connects, 0)::numeric / a.dials) * 1000) / 10
      else 0
    end,
    coalesce(a.conversations, 0)::int,
    case when coalesce(h.dialing_hours, 0) >= 0.1
      then round((coalesce(a.conversations, 0)::numeric / h.dialing_hours) * 100) / 100
      else null
    end,
    coalesce(a.wins, 0)::int,
    coalesce(a.callbacks_set, 0)::int,
    coalesce(a.talk_time_seconds, 0)::int,
    round(coalesce(h.dialing_hours, 0)::numeric, 2)
  from members mem
  left join agg a on a.agent_id = mem.user_id
  left join hours h on h.agent_id = mem.user_id
  order by mem.full_name;
end;
$$;

revoke all on function public.team_daily_stats(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.team_daily_stats(uuid, timestamptz, timestamptz) to authenticated;

-- =================================================================================================
-- 3. release_agent_queued_leads: the offboarding wizard's "release queued leads to the pool"
--    step. Owner/admin only (checked inside, same convention as assign_campaign_leads). Scoped
--    by `assigned_agent_id = p_agent` directly -- never touches another agent's own slice on a
--    shared campaign, unlike calling `assign_campaign_leads(..., null)` would (see this file's
--    own header comment). `cl.org_id = p_org` (campaign_leads has its own org_id, backfilled and
--    set NOT NULL in 20260924000200 -- not a join through campaigns) keeps this from releasing a
--    same-named agent's leads in a DIFFERENT org (not reachable today -- assigned_agent_id is
--    only ever set by assign_campaign_leads, which already checks the target is an active member
--    of the SAME org -- but the direct column check costs nothing and removes the need to trust
--    that invariant here too).
-- =================================================================================================

create function public.release_agent_queued_leads(p_org uuid, p_agent uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    raise exception 'only an owner or admin can release a member''s queued leads';
  end if;

  with updated as (
    update public.campaign_leads cl
    set assigned_agent_id = null, updated_at = now()
    where cl.org_id = p_org
      and cl.assigned_agent_id = p_agent
      and cl.status = 'queued'
    returning cl.id
  )
  select count(*) into v_count from updated;

  return v_count;
end;
$$;

revoke all on function public.release_agent_queued_leads(uuid, uuid) from public, anon;
grant execute on function public.release_agent_queued_leads(uuid, uuid) to authenticated;

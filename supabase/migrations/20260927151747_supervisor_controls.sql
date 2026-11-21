-- MISSION-5 TASK-M5-B2: supervisor controls -- EC-8 (one coach per TARGET call), remote pause/
-- end/hang-up, raise hand, EC-17 (monitoring wording). Plus two fix-forwards the lead folded in
-- at B2's own task-file note (R-037): B3's org_agent_dial_caps SELECT RLS (eng1's review, SHOULD
-- 1) and the fallback-claim audit payload (SHOULD 2, audit/M5-B3/review-eng1.md), and the A1
-- review's own SHOULD (reap_stale_coaching_sessions not audit-logged, audit/M5-A1/review-eng2.md).

-- =================================================================================================
-- 1. EC-8: at most one active/starting coaching session per TARGET call, not just per manager.
--    `coaching_sessions_one_active_per_manager` (20260926070000) already closes "one manager,
--    one coaching attempt" -- this is the OTHER half: two different managers cannot both coach
--    the SAME target session at once. Same partial-index shape (only 'starting'/'active' rows
--    participate, so a row that already ended never blocks a fresh attempt).
-- =================================================================================================

create unique index coaching_sessions_one_active_per_target
  on public.coaching_sessions (target_session_id)
  where status in ('starting', 'active');

-- =================================================================================================
-- 2. dial_sessions: three new columns for this task.
--    - remote_stop_requested_at/_by: an owner/admin asked to END this session while a live call
--      was in progress ("a live call is allowed to finish" -- see submit_disposition's own new
--      branch below, which is the ONLY place these are ever read). Never touched by
--      transition_session itself -- these are bookkeeping for a FUTURE transition, not part of
--      the state machine's own field list.
--    - raised_hand_at: the agent's own "raise hand" button (hotkey R). Not a session STATE (it
--      doesn't change `state`), so it is deliberately NOT part of transition_session's
--      p_fields -- see the function body below for how it's still auto-cleared "when the call
--      ends" at that same single choke point, without adding a new p_fields key every future
--      caller would have to remember not to accidentally clobber.
-- =================================================================================================

alter table public.dial_sessions
  add column remote_stop_requested_at timestamptz,
  add column remote_stop_requested_by uuid references auth.users(id),
  add column raised_hand_at timestamptz;

comment on column public.dial_sessions.remote_stop_requested_at is
  'MISSION-5 TASK-M5-B2: set when an owner/admin asks to end this session while a live call is in
   progress (dialer-session-stop, defer:true) -- "a live call is allowed to finish". Read (and
   cleared) exactly once, by submit_disposition''s own wrap_up -> stopped branch, the moment the
   in-progress call''s disposition is saved. Never set while there is no live call: that case
   stops immediately instead (stopSession succeeds synchronously, nothing to defer).';

comment on column public.dial_sessions.raised_hand_at is
  'MISSION-5 TASK-M5-B2: the agent''s own raise-hand button. Cleared by transition_session itself
   the moment the underlying call ends (state was on_call, p_new_state is not), and by
   coaching-core.ts the moment a manager actually starts coaching this target -- both "auto-
   clears" the task asked for. Not part of p_fields: unlike pause_reason/agent_leg_id/etc., this
   is orthogonal to which state a transition targets, not a per-call optional field of it.';

-- =================================================================================================
-- 3. transition_session: same signature/return type as 20260927070000 (B1) -- create or replace
--    is enough. The ONLY change: raised_hand_at auto-clears the instant a call that had it set
--    stops being on_call. Referencing bare `state` on the right-hand side of a SET list reads the
--    PRE-UPDATE row (standard Postgres UPDATE semantics -- every SET expression evaluates against
--    the OLD row simultaneously, regardless of list order), so this correctly fires exactly once,
--    at the real "the call just ended" transition, for every existing and future caller of this
--    function -- no call site anywhere has to remember to clear it itself.
-- =================================================================================================

create or replace function public.transition_session(
  p_session uuid,
  p_expected_states text[],
  p_new_state text,
  p_fields jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_org_id uuid;
  v_agent_id uuid;
  v_reason text;
begin
  update public.dial_sessions
  set
    state = p_new_state,
    updated_at = now(),
    agent_leg_id = case when p_fields ? 'agent_leg_id' then (p_fields ->> 'agent_leg_id')::uuid else agent_leg_id end,
    active_leg_id = case when p_fields ? 'active_leg_id' then (p_fields ->> 'active_leg_id')::uuid else active_leg_id end,
    conference_id = case when p_fields ? 'conference_id' then (p_fields ->> 'conference_id') else conference_id end,
    ended_at = case when p_fields ? 'ended_at' then (p_fields ->> 'ended_at')::timestamptz else ended_at end,
    paused_agent_lost_from = case when p_fields ? 'paused_agent_lost_from' then (p_fields ->> 'paused_agent_lost_from') else paused_agent_lost_from end,
    pause_reason = case when p_fields ? 'pause_reason' then (p_fields ->> 'pause_reason') else pause_reason end,
    -- MISSION-5 TASK-M5-B2: `state` here is the OLD value (the row this UPDATE is about to
    -- replace) -- the auto-clear fires exactly on an on_call -> anything-else transition.
    raised_hand_at = case when state = 'on_call' and p_new_state <> 'on_call' then null else raised_hand_at end
  where id = p_session
    and state = any(p_expected_states)
  returning id, org_id, agent_id into v_id, v_org_id, v_agent_id;

  if v_id is not null then
    v_reason := case when p_fields ? 'pause_reason' then (p_fields ->> 'pause_reason') else null end;

    update public.agent_state_events
    set ended_at = now()
    where agent_id = v_agent_id and ended_at is null;

    insert into public.agent_state_events (org_id, agent_id, session_id, state, reason, started_at)
    values (v_org_id, v_agent_id, v_id, p_new_state, v_reason, now());
  end if;

  return v_id is not null;
end;
$$;

-- =================================================================================================
-- 4. team_live_board: adds session_id (so the client can call the EXISTING sessionId-keyed
--    dialer-session-pause/-stop/-hangup-live endpoints against a REMOTE target -- all three
--    already permit owner/admin to act on any org session, see those functions' own review) and
--    raised_hand_at (the live-board flag). Return-type change from 20260927144900's own shape --
--    drop + recreate, grants repeated verbatim (DROP FUNCTION drops them).
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
  campaign_name text,
  session_id uuid,
  raised_hand_at timestamptz
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
      ds.id, ds.agent_id, ds.state, ds.lines, ds.started_at, ds.updated_at, ds.active_leg_id,
      ds.pause_reason, ds.campaign_id, ds.raised_hand_at
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
    camp.name,
    cs.id,
    cs.raised_hand_at
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
-- 5. Fix-forward (R-037, lead's own note on TASK-M5-B2.md, from audit/M5-B3/review-eng1.md SHOULD
--    1): org_agent_dial_caps' SELECT policy was org-wide -- any signed-in agent could read every
--    OTHER agent's individual cap override. Narrowed to "owner/admin see every row, an agent sees
--    only their own" -- matches the review's own suggested fix exactly.
-- =================================================================================================

drop policy "org members can view agent dial caps" on public.org_agent_dial_caps;

create policy "owner or admin sees all agent dial caps, an agent sees only their own"
  on public.org_agent_dial_caps for select
  using (private.has_org_role(org_id, array['owner', 'admin']) or agent_id = auth.uid());

-- =================================================================================================
-- 6. Fix-forward (R-037, SHOULD 2, audit/M5-B3/review-eng1.md): claim_next_leads' fallback-claim
--    audit entry recorded who took a lead but never who LOST it. `previous_agent_id` was already
--    computed in the `updated` CTE and sitting unused -- threaded through into the final select
--    (re-joining `updated`, which stays visible for the rest of this one statement) and into an
--    array of {lead_id, previous_agent_id} on the log payload. Same signature/return type
--    (`setof public.claimed_dial_leg`, unchanged) -- create or replace is enough.
-- =================================================================================================

create or replace function public.claim_next_leads(p_session uuid)
returns setof public.claimed_dial_leg
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_campaign_id uuid;
  v_agent_id uuid;
  v_lines int;
  v_window_start time;
  v_window_end time;
  v_capacity int;
  v_fallback_enabled boolean;
  v_fallback_minutes int;
  v_fallback_cutoff timestamptz;
  v_fallback_count int := 0;
  v_fallback_details jsonb := '[]'::jsonb;
  v_row record;
begin
  select ds.org_id, ds.campaign_id, ds.agent_id, ds.lines
    into v_org_id, v_campaign_id, v_agent_id, v_lines
  from public.dial_sessions ds
  where ds.id = p_session and ds.state = 'dialing'
  for update;

  if v_campaign_id is null then
    return;
  end if;

  select count(*) into v_capacity
  from public.call_legs
  where session_id = p_session and kind = 'contact'
    and state not in ('ended', 'voicemail_dropping');

  v_capacity := greatest(0, v_lines - v_capacity);
  if v_capacity = 0 then
    return;
  end if;

  select c.calling_window_start, c.calling_window_end into v_window_start, v_window_end
  from public.campaigns c
  where c.id = v_campaign_id;

  select coalesce(ods.callback_fallback_enabled, false), ods.callback_fallback_minutes
    into v_fallback_enabled, v_fallback_minutes
  from public.org_distribution_settings ods
  where ods.org_id = v_org_id;
  v_fallback_cutoff := now() - make_interval(mins => coalesce(v_fallback_minutes, 30));

  for v_row in
  with picked as (
    select
      cl2.id,
      cl2.assigned_agent_id,
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) as is_priority_callback,
      (
        cl2.status = 'callback'
        and cl2.assigned_agent_id is distinct from v_agent_id
        and v_fallback_enabled
        and cl2.next_attempt_at <= v_fallback_cutoff
        and (
          not exists (
            select 1 from public.org_members om
            where om.org_id = v_org_id and om.user_id = cl2.assigned_agent_id and om.status = 'active'
          )
          or not exists (
            select 1 from public.dial_sessions ds3
            where ds3.agent_id = cl2.assigned_agent_id and ds3.state not in ('stopped', 'completed')
          )
        )
      ) as is_fallback_claim,
      cl2.priority_requeue,
      case cl2.priority when 'high' then 2 when 'normal' then 1 else 0 end as priority_rank,
      cl2.attempts,
      cl2.next_attempt_at,
      cl2.position,
      cl2.contact_id
    from public.campaign_leads cl2
    join public.contacts ct on ct.id = cl2.contact_id
    where cl2.campaign_id = v_campaign_id
      and cl2.next_attempt_at <= now()
      and not ct.dnc
      and not exists (
        select 1 from public.dnc_numbers dn
        where dn.org_id = v_org_id and dn.e164 = ct.phone_number
      )
      and (
        (cl2.status = 'queued' and (cl2.assigned_agent_id is null or cl2.assigned_agent_id = v_agent_id))
        or (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id)
        or (
          cl2.status = 'callback'
          and cl2.assigned_agent_id is distinct from v_agent_id
          and v_fallback_enabled
          and cl2.next_attempt_at <= v_fallback_cutoff
          and (
            not exists (
              select 1 from public.org_members om
              where om.org_id = v_org_id and om.user_id = cl2.assigned_agent_id and om.status = 'active'
            )
            or not exists (
              select 1 from public.dial_sessions ds3
              where ds3.agent_id = cl2.assigned_agent_id and ds3.state not in ('stopped', 'completed')
            )
          )
        )
      )
      and private.is_lead_callable_now(ct.timezone, v_window_start, v_window_end)
    order by
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) desc,
      cl2.priority_requeue desc,
      (case cl2.priority when 'high' then 2 when 'normal' then 1 else 0 end) desc,
      cl2.attempts asc,
      cl2.next_attempt_at asc,
      cl2.position asc
    limit v_capacity
    for update of cl2 skip locked
  ),
  updated as (
    update public.campaign_leads cl
    set
      status = 'in_flight',
      updated_at = now(),
      priority_requeue = false,
      assigned_agent_id = case when picked.is_fallback_claim then v_agent_id else cl.assigned_agent_id end
    from picked
    where cl.id = picked.id
    returning cl.id, cl.contact_id, picked.is_fallback_claim, picked.assigned_agent_id as previous_agent_id
  ),
  new_legs as (
    insert into public.call_legs (org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state, time_block)
    select
      v_org_id, p_session, v_campaign_id, u.contact_id, u.id, 'contact', 'pending-' || gen_random_uuid()::text, 'initiated',
      private.time_block_for(now(), (select ct3.timezone from public.contacts ct3 where ct3.id = u.contact_id))
    from updated u
    returning id, lead_id, contact_id, call_control_id
  )
  select
    nl.id as leg_id,
    nl.lead_id,
    nl.contact_id,
    (select ct2.phone_number from public.contacts ct2 where ct2.id = nl.contact_id) as phone_number,
    nl.call_control_id,
    p.is_fallback_claim,
    p.is_priority_callback, p.priority_requeue, p.priority_rank, p.attempts, p.next_attempt_at, p.position,
    upd.previous_agent_id
  from new_legs nl
  join picked p on p.id = nl.lead_id
  join updated upd on upd.id = nl.lead_id
  order by
    p.is_priority_callback desc, p.priority_requeue desc, p.priority_rank desc,
    p.attempts asc, p.next_attempt_at asc, p.position asc
  loop
    if v_row.is_fallback_claim then
      v_fallback_count := v_fallback_count + 1;
      v_fallback_details := v_fallback_details || jsonb_build_object(
        'lead_id', v_row.lead_id,
        'previous_agent_id', v_row.previous_agent_id
      );
    end if;
    return next row(v_row.leg_id, v_row.lead_id, v_row.contact_id, v_row.phone_number, v_row.call_control_id)::public.claimed_dial_leg;
  end loop;

  if v_fallback_count > 0 then
    perform private.log_org_action(
      v_org_id,
      'campaign_leads.callback_fallback_claim',
      'campaign',
      v_campaign_id,
      jsonb_build_object('agent_id', v_agent_id, 'lead_count', v_fallback_count, 'claims', v_fallback_details),
      v_agent_id
    );
  end if;
end;
$$;

revoke all on function public.claim_next_leads(uuid) from public, anon, authenticated;
grant execute on function public.claim_next_leads(uuid) to service_role;

-- =================================================================================================
-- 7. Fix-forward (the A1 review's own SHOULD, audit/M5-A1/review-eng1.md -- wait, audit/M5-A1/
--    review-eng2.md): reap_stale_coaching_sessions swept a stale coaching session but never
--    audit-logged the end, unlike the manager's own hangup path (processTelnyxCoachingEvent's
--    manager_hangup branch). The SQL side can't call the Edge-Function-side logOrgAction --
--    widened the RETURNING instead (manager_id, target_session_id) so dialer-sweeper/index.ts
--    (TS) can log it the exact same "after the mutation, fire-and-forget" way every other
--    logOrgAction call already does. Return-type change -- drop + recreate, grants repeated.
-- =================================================================================================

drop function public.reap_stale_coaching_sessions(int, int);

create function public.reap_stale_coaching_sessions(
  p_stuck_after_seconds int,
  p_hard_cap_seconds int
)
returns table (
  id uuid,
  org_id uuid,
  manager_call_control_id text,
  manager_id uuid,
  target_session_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with stale as (
    select cs.id
    from public.coaching_sessions cs
    join public.dial_sessions ds on ds.id = cs.target_session_id
    where cs.status in ('starting', 'active')
      and (
        (ds.state <> 'on_call'
          and ds.updated_at < now() - make_interval(secs => p_stuck_after_seconds))
        or cs.created_at < now() - make_interval(secs => p_hard_cap_seconds)
      )
  )
  update public.coaching_sessions cs
  set status = 'ended', ended_at = now(), ended_reason = 'target_ended'
  from stale
  where cs.id = stale.id
  returning cs.id, cs.org_id, cs.manager_call_control_id, cs.manager_id, cs.target_session_id;
end;
$$;

revoke all on function public.reap_stale_coaching_sessions(int, int) from public, anon, authenticated;
grant execute on function public.reap_stale_coaching_sessions(int, int) to service_role;

-- =================================================================================================
-- 8. submit_disposition: the "end an agent's session remotely, but let a live call finish" half.
--    Same signature -- but RETURNS TABLE gains two columns (remote_stop_applied,
--    remote_stop_requested_by), a return-type change -- drop + recreate, grants repeated. The
--    ONLY behavioural change from 20260926080500's own body: a new branch, checked BEFORE the
--    existing auto-resume logic (it takes priority -- a manager asked this session to end, that
--    outranks the agent's own pacing preference), which transitions wrap_up -> stopped instead of
--    -> dialing/paused when remote_stop_requested_at is set, and clears both remote-stop columns
--    (tidiness only -- the session is terminal either way, nothing will read them again).
-- =================================================================================================

drop function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz, text, text[]);

create function public.submit_disposition(
  p_leg uuid,
  p_org uuid,
  p_caller_user_id uuid,
  p_disposition text,
  p_notes text,
  p_callback_at timestamptz,
  p_license_number text default null,
  p_zips text[] default null
)
returns table (
  session_id uuid,
  already_submitted boolean,
  remote_stop_applied boolean,
  remote_stop_requested_by uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_leg public.call_legs;
  v_session public.dial_sessions;
  v_disposition public.dispositions;
  v_caller_role text;
  v_effective_callback_at timestamptz;
  v_already boolean;
  v_agent_name text;
  v_max_attempts int;
  v_retry_minutes int;
  v_rule public.campaign_retry_rules;
  v_current_attempts int;
  v_next_status text;
  v_next_attempt_at timestamptz;
  v_schedule record;
  v_contact_tz text;
  v_license_number text;
  v_zips text[];
  v_auto_resume_seconds int;
  v_remote_stop_applied boolean := false;
  v_remote_stop_requested_by uuid;
begin
  select * into v_leg from public.call_legs where id = p_leg and org_id = p_org for update;
  if v_leg is null then
    raise exception 'call leg not found for this org';
  end if;

  select * into v_session from public.dial_sessions where id = v_leg.session_id and org_id = p_org;
  if v_session is null then
    raise exception 'dial session not found for this leg';
  end if;

  select role into v_caller_role
  from public.org_members
  where org_id = p_org and user_id = p_caller_user_id and status = 'active';
  if v_caller_role is null then
    raise exception 'caller is not an active member of this org';
  end if;
  if v_caller_role = 'agent' and v_session.agent_id <> p_caller_user_id then
    raise exception 'only the session''s own agent (or an admin) may submit this disposition';
  end if;

  select * into v_disposition
  from public.dispositions
  where org_id = p_org and key = p_disposition and active;
  if v_disposition is null then
    raise exception 'unknown or inactive disposition key: %', p_disposition;
  end if;

  v_effective_callback_at := case when v_disposition.lead_effect = 'callback' then p_callback_at else null end;
  if v_disposition.lead_effect = 'callback' and v_effective_callback_at is null then
    raise exception 'callback_at is required for a callback disposition';
  end if;

  v_license_number := nullif(trim(coalesce(p_license_number, '')), '');
  v_zips := case when p_zips is null or cardinality(p_zips) = 0 then null else p_zips end;
  if v_disposition.required_fields is not null then
    if 'license_number' = any(v_disposition.required_fields) and v_license_number is null then
      raise exception 'license_number is required for disposition: %', v_disposition.key;
    end if;
    if 'zips' = any(v_disposition.required_fields) and v_zips is null then
      raise exception 'zips is required for disposition: %', v_disposition.key;
    end if;
  end if;

  if v_disposition.lead_effect = 'callback' and not exists (
    select 1 from public.org_members
    where org_id = p_org and user_id = v_session.agent_id and status = 'active'
  ) then
    raise exception 'the session agent is not an active member of this org, so a callback cannot be assigned to them';
  end if;

  v_already := v_leg.dispositioned_at is not null;

  update public.call_legs
  set disposition_id = v_disposition.id,
      notes = p_notes,
      callback_at = v_effective_callback_at,
      dispositioned_by = p_caller_user_id,
      dispositioned_at = coalesce(v_leg.dispositioned_at, now()),
      license_number = coalesce(v_license_number, v_leg.license_number),
      zips = coalesce(v_zips, v_leg.zips)
  where id = p_leg;

  if not v_already and v_leg.contact_id is not null and (v_license_number is not null or v_zips is not null) then
    update public.contacts
    set custom_fields = custom_fields
      || case when v_license_number is not null then jsonb_build_object('license_number', v_license_number) else '{}'::jsonb end
      || case when v_zips is not null then jsonb_build_object('zips', to_jsonb(v_zips)) else '{}'::jsonb end,
      updated_at = now()
    where id = v_leg.contact_id;
  end if;

  if not v_already and v_leg.lead_id is not null then
    if v_disposition.lead_effect = 'completed' then
      update public.campaign_leads set status = 'completed', updated_at = now() where id = v_leg.lead_id;
    elsif v_disposition.lead_effect = 'exhausted' then
      update public.campaign_leads set status = 'exhausted', updated_at = now() where id = v_leg.lead_id;
      perform private.enqueue_nurture_tag_if_exhausted(p_org, v_leg.lead_id, v_leg.contact_id, p_leg);
    elsif v_disposition.lead_effect = 'callback' then
      update public.campaign_leads
      set status = 'callback',
          next_attempt_at = v_effective_callback_at,
          assigned_agent_id = v_session.agent_id,
          updated_at = now()
      where id = v_leg.lead_id;
    elsif v_disposition.lead_effect = 'queued' then
      select max_attempts, retry_interval_minutes into v_max_attempts, v_retry_minutes
      from public.campaigns where id = v_leg.campaign_id;
      select attempts into v_current_attempts from public.campaign_leads where id = v_leg.lead_id;
      select timezone into v_contact_tz from public.contacts where id = v_leg.contact_id;
      select * into v_rule from public.campaign_retry_rules
      where campaign_id = v_leg.campaign_id and disposition_key = v_disposition.key;

      if v_current_attempts >= coalesce(v_max_attempts, 3) then
        v_next_status := 'exhausted';
        v_next_attempt_at := null;
      elsif v_rule.id is not null and v_rule.action = 'out' then
        v_next_status := 'exhausted';
        v_next_attempt_at := null;
      elsif v_rule.id is not null and v_rule.action = 'retry' then
        select * into v_schedule
        from private.rotated_retry_schedule(v_leg.time_block, v_contact_tz, greatest(1, v_rule.delay_minutes / 1440));
        v_next_status := 'queued';
        v_next_attempt_at := v_schedule.next_attempt_at;
      else
        v_next_status := 'queued';
        v_next_attempt_at := now() + make_interval(mins => coalesce(v_retry_minutes, 120));
      end if;

      update public.campaign_leads cl
      set status = v_next_status, next_attempt_at = v_next_attempt_at, priority_requeue = false, updated_at = now()
      where cl.id = v_leg.lead_id;

      perform private.enqueue_nurture_tag_if_exhausted(p_org, v_leg.lead_id, v_leg.contact_id, p_leg);
    end if;
  end if;

  if not v_already and v_disposition.lead_effect = 'dnc' and v_leg.contact_id is not null then
    update public.contacts set dnc = true, updated_at = now() where id = v_leg.contact_id;
    update public.campaign_leads set status = 'dnc', updated_at = now() where contact_id = v_leg.contact_id;
    insert into public.dnc_numbers (org_id, e164, source, added_by, note)
    select p_org, ct.phone_number, 'disposition', p_caller_user_id, 'via disposition: ' || v_disposition.label
    from public.contacts ct
    where ct.id = v_leg.contact_id and ct.phone_number is not null
    on conflict (org_id, e164) do nothing;
  end if;

  select trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))
  into v_agent_name
  from public.profiles p where p.user_id = v_session.agent_id;

  perform public.enqueue_crm_job(
    p_org,
    'disposition',
    v_leg.contact_id,
    p_leg,
    jsonb_build_object(
      'disposition_key', v_disposition.key,
      'disposition_label', v_disposition.label,
      'notes', p_notes,
      'callback_at', v_effective_callback_at,
      'ghl_tag', v_disposition.ghl_tag,
      'creates_task', v_disposition.creates_task,
      'agent_name', coalesce(nullif(v_agent_name, ''), 'Agent'),
      'duration_seconds', coalesce(v_leg.duration_seconds, 0),
      'recording_url', 'https://hyperdial.myhomebasesolutions.com/contacts?leg=' || p_leg::text,
      'transcript_excerpt', null,
      'license_number', v_license_number,
      'zips', case when v_zips is null then null else to_jsonb(v_zips) end,
      'is_dnc', v_disposition.lead_effect = 'dnc'
    )
  );

  -- MISSION-5 TASK-M5-B2: takes priority over auto-resume -- a manager's own "end this session"
  -- request outranks the agent's per-user pacing preference. Only ever true here because a
  -- remote end that DIDN'T land mid-call already stopped the session synchronously (dialer-
  -- session-stop's own defer branch) and never gets here at all -- this is exactly, and only,
  -- the "was mid-call when asked" case.
  if v_session.remote_stop_requested_at is not null then
    perform public.transition_session(
      v_session.id, array['wrap_up'], 'stopped',
      jsonb_build_object('ended_at', now(), 'pause_reason', 'remote_end_by_manager')
    );
    update public.dial_sessions
    set remote_stop_requested_at = null, remote_stop_requested_by = null
    where id = v_session.id;
    v_remote_stop_applied := true;
    v_remote_stop_requested_by := v_session.remote_stop_requested_by;
  else
    select auto_resume_seconds into v_auto_resume_seconds
    from public.user_preferences
    where user_id = v_session.agent_id;

    if v_auto_resume_seconds is null then
      perform public.transition_session(v_session.id, array['wrap_up'], 'dialing', '{}'::jsonb);
    else
      perform public.transition_session(
        v_session.id, array['wrap_up'], 'paused',
        jsonb_build_object('pause_reason', 'post_wrapup')
      );
    end if;
  end if;

  return query select v_session.id, v_already, v_remote_stop_applied, v_remote_stop_requested_by;
end;
$$;

revoke all on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz, text, text[]) from public, anon, authenticated;
grant execute on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz, text, text[]) to service_role;

-- =================================================================================================
-- 9. EC-17: extend the T8 consent announcement with an optional "recorded and may be monitored"
--    wording. Plain boolean, org-wide, same upsert-through-existing-RLS shape as
--    announce_recording_mode/all_party_consent_states -- no new policy needed (org_recording_
--    settings' existing owner/admin-write, any-member-read RLS already covers every column).
-- =================================================================================================

alter table public.org_recording_settings
  add column mention_monitoring boolean not null default false;

-- =================================================================================================
-- 10. notifications: a nullable `data` jsonb column so the raise-hand notification can carry a
--     click-through target (TopNavigation.tsx reads `data.targetUserId` to route straight to
--     Team). Nullable, no default -- every EXISTING notification-insert call site (reliability
--     alerts, campaign-lines guard, the daily-cap notifier) keeps inserting with no `data` key at
--     all, reads back null, unchanged behaviour.
-- =================================================================================================

alter table public.notifications add column data jsonb;

comment on column public.org_recording_settings.mention_monitoring is
  'MISSION-5 TASK-M5-B2 (EC-17): when true, the T8 consent announcement (recording-core.ts''s
   recordingConsentMessage) also mentions the call may be MONITORED, not just recorded -- for a
   coaching (listen/whisper/barge) feature to be legally sound in an all-party-consent state, the
   consent notice must disclose monitoring, not only recording, since a supervisor silently
   listening in is exactly the kind of third-party presence those states require the caller be
   told about. This is NOT legal advice and does not itself decide when disclosure is required --
   same "decides WHEN, not what a compliant script must say" scope as the rest of this org
   setting; an org operating in (or calling into) an all-party-consent state and using live
   coaching should turn this on, same reasoning `all_party_consent_states` already documents for
   announce_recording_mode.';

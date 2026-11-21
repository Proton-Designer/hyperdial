-- TASK-M1: call_legs.duration_seconds is never written today (the RPC supports it,
-- 20260924000800_dialer_rpcs.sql:179, but dialer-engine.ts never passes it), so
-- call_leg_analytics.duration_seconds is always null and the dashboard's Talk Time card always
-- shows 0m. Fixing that is a prerequisite for the new "Conversations / hr" metric replacing the
-- ambiguous "Revenue Pipeline" card.
--
-- Talk duration (per the task's own definition): the seconds from when the contact leg joined
-- the agent's conference (the bridge) to the leg's hangup. That needs a bridge timestamp that
-- doesn't exist yet -- `bridged_at`, set by dialer-engine.ts's handleWin right after the winner
-- successfully creates/joins the agent's conference (never on a failed join, so a genuinely
-- unbridged claimed leg still falls back to answered_at below rather than lying about a bridge
-- that never happened).
--
-- 20260925010000 (reap_dead_claimed_leg, run_dialer_sweep) is already applied live -- this is a
-- NEW migration, not an edit to that one (CLAUDE.md: migrations are append-only once applied).

alter table public.call_legs add column bridged_at timestamptz;

-- transition_leg (20260924000800_dialer_rpcs.sql): same argument signature, so `create or
-- replace` really does replace it (no overload risk -- that only bites when the argument LIST
-- changes, not the body). Adds the one new case-when arm for bridged_at; every other column is
-- byte-identical to the version currently live.
create or replace function public.transition_leg(
  p_call_control_id text,
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
begin
  update public.call_legs
  set
    state = p_new_state,
    outcome = case when p_fields ? 'outcome' then (p_fields ->> 'outcome') else outcome end,
    amd_result = case when p_fields ? 'amd_result' then (p_fields ->> 'amd_result') else amd_result end,
    hangup_cause = case when p_fields ? 'hangup_cause' then (p_fields ->> 'hangup_cause') else hangup_cause end,
    answered_at = case when p_fields ? 'answered_at' then (p_fields ->> 'answered_at')::timestamptz else answered_at end,
    claimed_at = case when p_fields ? 'claimed_at' then (p_fields ->> 'claimed_at')::timestamptz else claimed_at end,
    bridged_at = case when p_fields ? 'bridged_at' then (p_fields ->> 'bridged_at')::timestamptz else bridged_at end,
    ended_at = case when p_fields ? 'ended_at' then (p_fields ->> 'ended_at')::timestamptz else ended_at end,
    duration_seconds = case when p_fields ? 'duration_seconds' then (p_fields ->> 'duration_seconds')::int else duration_seconds end
  where call_control_id = p_call_control_id
    and state = any(p_expected_states)
  returning id into v_id;

  return v_id is not null;
end;
$$;

-- reap_dead_claimed_leg (20260925010000): same argument signature as the live version -- adds
-- duration_seconds to the same UPDATE, computed the same way the sweeper path has to (there is
-- no TS-side call.hangup event for this path -- the leg was never told to hang up, the sweeper
-- decided it must already be dead). Falls back bridged_at -> answered_at -> claimed_at, in that
-- order, exactly matching the task's own "fall back to answered_at only for legs without
-- bridged_at" rule -- claimed_at is a last-resort guard only (every row reaching this UPDATE
-- already has claimed_at set by claim_leg, so the fallback chain never actually bottoms out at
-- null in practice for a genuinely claimed leg).
create or replace function public.reap_dead_claimed_leg(p_leg uuid, p_hangup_cause text default 'timeout')
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
  v_session_active_leg_id uuid;
  v_ended_id uuid;
begin
  select cl.session_id, ds.active_leg_id
    into v_session_id, v_session_active_leg_id
  from public.call_legs cl
  join public.dial_sessions ds on ds.id = cl.session_id
  where cl.id = p_leg and cl.kind = 'contact' and cl.state = 'claimed';

  if v_session_id is null then
    return false; -- already resolved by a real webhook (or not actually a claimed leg) -- no-op
  end if;

  update public.call_legs
  set
    state = 'ended',
    hangup_cause = p_hangup_cause,
    ended_at = now(),
    outcome = coalesce(outcome, 'connected'),
    duration_seconds = greatest(
      0,
      round(extract(epoch from (now() - coalesce(bridged_at, answered_at, claimed_at))))::int
    )
  where id = p_leg and state = 'claimed'
  returning id into v_ended_id;

  if v_ended_id is null then
    return false; -- lost the race to a real webhook between the select above and this update
  end if;

  perform public.apply_leg_outcome(p_leg);

  if v_session_active_leg_id = p_leg then
    perform public.transition_session(v_session_id, array['on_call', 'connecting'], 'wrap_up', '{}'::jsonb);
  end if;

  return true;
end;
$$;

-- "Dialing hours" (task definition): sum over the agent's sessions of
-- (coalesce(ended_at, now()) - started_at), clipped to [start of today, now], INCLUDING running
-- sessions so the number is live during the day -- unlike dial_session_hours (analytics_real_
-- data.sql), which only counts ENDED sessions and is meant for a historical date-range chart, not
-- a live "right now" figure. No org has a timezone column today (grepped every migration) --
-- defaults to America/Chicago per the task's own fallback rule; documented in
-- .brain/domains/analytics.md. A session that started yesterday and is still running (or ended
-- after midnight) is clipped to the part that falls on today, not double counted and not
-- excluded outright.
create function public.dialing_hours_today(p_org_id uuid, p_agent_id uuid)
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
        - greatest(ds.started_at, date_trunc('day', now() at time zone 'America/Chicago') at time zone 'America/Chicago')
      )) / 3600.0
    ),
    0
  )::numeric
  from public.dial_sessions ds
  where ds.org_id = p_org_id
    and ds.agent_id = p_agent_id
    and coalesce(ds.ended_at, now()) > (date_trunc('day', now() at time zone 'America/Chicago') at time zone 'America/Chicago')
    and ds.started_at < now();
$$;

revoke all on function public.dialing_hours_today(uuid, uuid) from public, anon, authenticated;
grant execute on function public.dialing_hours_today(uuid, uuid) to service_role;

-- TASK-L6 (known-issues #11 / BUG-9 + the #14 agent-lost-states follow-up): a winner leg whose
-- own call.hangup webhook is lost stays 'claimed' forever, and because run_dialer_sweep's own
-- staleness check deliberately EXCLUDES 'claimed' (a real live call is silent on the webhook
-- stream for its whole duration by design), the session also stays stuck in 'on_call' forever
-- -- no wrap-up, no disposition ever possible. Design (per the task's own spec):
--   - Silent > N minutes (webhook silence since claimed_at) is NOT enough on its own to end a
--     live conversation -- ask Telnyx directly (GET /v2/calls/{id}, is_alive) before touching
--     anything. That HTTP call can only happen from TS (dialer-sweeper/index.ts,
--     _shared/telnyx-client.ts's new getCallStatus + _shared/dialer-sweeper-core.ts's
--     reconcileStaleClaimedLeg), so this migration's own job is split in two:
--       1. `run_dialer_sweep` SELECTs (never mutates) claimed legs silent longer than
--          p_claimed_check_after_seconds, returning them as `stale_claimed_legs` for the Edge
--          Function to check.
--       2. `reap_dead_claimed_leg` is the one atomic, idempotent primitive TS calls once it has
--          a DEFINITIVE answer (Telnyx confirms not-alive, OR the leg is older than
--          time_limit_secs+grace -- Telnyx's own hard cap on the call's duration, so no
--          question needs asking at all past that point) -- it replicates exactly the "normal
--          hangup outcome path" a real call.hangup webhook would have run
--          (processContactLegEvent's own `result.next === 'ended'` branch, dialer-engine.ts):
--          transition_leg -> ended, apply_leg_outcome, and (only if this leg was actually the
--          session's active_leg_id) transition_session -> wrap_up. Race-safe the same way
--          every other RPC here already is: its own `where ... and state = 'claimed'` guard
--          means a real webhook that resolves the leg first just makes this a no-op (returns
--          false), never a double-transition.
--   - Separately (known-issues #14's own follow-up, not previously fixed): step 2's own
--     agent-leg-lost states list (`dialing`/`connecting`/`on_call`/`wrap_up`) never matched
--     the webhook-driven path's own AGENT_ACTIVE_SESSION_STATES (dialer-engine.ts), which also
--     treats `ready_pending`/`ready`/`paused` as in-scope -- fixed to match exactly (still
--     deliberately excluding `paused_agent_lost` itself, the target state, same reasoning as
--     every other CAS in this codebase that targets it).

alter type public.dialer_sweep_result add attribute stale_claimed_legs jsonb;

-- Postgres identifies a function by its ARGUMENT TYPES, not just its name -- adding the new
-- p_claimed_check_after_seconds parameter makes this a different signature
-- (run_dialer_sweep(int, int)) from the original run_dialer_sweep(int), so `create or replace`
-- alone would create a second, overloaded function and silently leave the old one-arg version
-- in place too (still callable, still granted). Drop it explicitly first.
drop function if exists public.run_dialer_sweep(int);

create function public.run_dialer_sweep(
  p_stuck_after_seconds int default 60,
  p_claimed_check_after_seconds int default 300
)
returns public.dialer_sweep_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_applied boolean;
  v_result public.dialer_sweep_result;
begin
  v_result.reaped_legs := '[]'::jsonb;
  v_result.paused_agent_sessions := 0;
  v_result.applied_orphaned_outcomes := 0;
  v_result.requeued_leads := 0;
  v_result.stale_claimed_legs := '[]'::jsonb;

  -- 1. Stuck non-terminal contact legs -----------------------------------------------------
  for v_row in
    select cl.id, cl.call_control_id, cl.state, cl.answered_at, cl.org_id
    from public.call_legs cl
    where cl.kind = 'contact'
      and cl.state not in ('ended', 'claimed')
      and coalesce(
        (select max(we.received_at) from public.webhook_events we
         where we.call_control_id = cl.call_control_id),
        cl.created_at
      ) < now() - make_interval(secs => p_stuck_after_seconds)
    for update of cl skip locked
  loop
    select public.transition_leg(
      v_row.call_control_id,
      array[v_row.state],
      'ended',
      jsonb_build_object(
        'outcome', case when v_row.answered_at is not null then 'failed' else 'no_answer' end,
        'hangup_cause', 'timeout',
        'ended_at', now()
      )
    ) into v_applied;

    if v_applied then
      perform public.apply_leg_outcome(v_row.id);
      v_result.reaped_legs := v_result.reaped_legs
        || jsonb_build_object('org_id', v_row.org_id, 'call_control_id', v_row.call_control_id);
    end if;
  end loop;

  -- 1b. Claimed (bridged) contact legs silent longer than the check-after window -- SELECT
  -- only. Deliberately does not distinguish here whether a candidate is also already past
  -- time_limit_secs+grace (a definitive, Telnyx-guaranteed timeout that needs no API call at
  -- all) -- that decision needs `created_at` (returned below) but not a live Telnyx call, so
  -- it belongs in the TS orchestration next to the one that DOES need Telnyx, not duplicated
  -- into a second SQL branch here.
  for v_row in
    select cl.id, cl.call_control_id, cl.org_id, cl.created_at
    from public.call_legs cl
    where cl.kind = 'contact'
      and cl.state = 'claimed'
      and cl.claimed_at < now() - make_interval(secs => p_claimed_check_after_seconds)
  loop
    v_result.stale_claimed_legs := v_result.stale_claimed_legs || jsonb_build_object(
      'id', v_row.id,
      'call_control_id', v_row.call_control_id,
      'org_id', v_row.org_id,
      'created_at', v_row.created_at
    );
  end loop;

  -- 2. Sessions whose agent leg has ended ---------------------------------------------------
  -- TASK-L6 fix (known-issues #14): this list now matches AGENT_ACTIVE_SESSION_STATES
  -- (dialer-engine.ts) exactly -- it previously missed ready_pending/ready/paused, so an
  -- agent-leg-lost webhook lost in those states was never reconciled by this safety net.
  for v_row in
    select ds.id, ds.state
    from public.dial_sessions ds
    join public.call_legs al on al.id = ds.agent_leg_id
    where al.state = 'ended'
      and ds.state in ('ready_pending', 'ready', 'dialing', 'connecting', 'on_call', 'wrap_up', 'paused')
  loop
    select public.transition_session(v_row.id, array[v_row.state], 'paused_agent_lost', '{}'::jsonb)
      into v_applied;
    if v_applied then
      v_result.paused_agent_sessions := v_result.paused_agent_sessions + 1;
    end if;
  end loop;

  -- 3a. Ended legs with a recorded outcome that never got applied --------------------------
  for v_row in
    select id from public.call_legs
    where kind = 'contact' and state = 'ended' and outcome is not null and outcome_applied_at is null
    for update skip locked
  loop
    perform public.apply_leg_outcome(v_row.id);
    v_result.applied_orphaned_outcomes := v_result.applied_orphaned_outcomes + 1;
  end loop;

  -- 3b. In_flight leads with nothing left to apply -- direct requeue at attempts+0 ---------
  with latest_leg as (
    select
      cl.id as lead_id,
      (select l.id from public.call_legs l where l.lead_id = cl.id order by l.created_at desc limit 1)
        as leg_id
    from public.campaign_leads cl
    where cl.status = 'in_flight'
  ),
  stuck_leads as (
    select ll.lead_id
    from latest_leg ll
    left join public.call_legs l on l.id = ll.leg_id
    where ll.leg_id is null or (l.state = 'ended' and l.outcome is null)
  )
  update public.campaign_leads cl
  set status = 'queued', next_attempt_at = now(), updated_at = now()
  from stuck_leads
  where cl.id = stuck_leads.lead_id;
  get diagnostics v_result.requeued_leads = row_count;

  return v_result;
end;
$$;

revoke all on function public.run_dialer_sweep(int, int) from public, anon, authenticated;
grant execute on function public.run_dialer_sweep(int, int) to service_role;

-- reap_dead_claimed_leg: the ONE atomic primitive TS calls once it has a definitive answer
-- (Telnyx confirms not-alive, or the leg is past time_limit_secs+grace). Mirrors
-- processContactLegEvent's own `result.next === 'ended'` branch (dialer-engine.ts) exactly:
-- end the leg (outcome is already 'connected' from claim_leg's own win transition, left
-- untouched here), apply_leg_outcome (clears active_leg_id if this leg still held it), and --
-- only if THIS leg was actually the session's active_leg_id -- move the session to wrap_up.
-- Reads the session's active_leg_id BEFORE mutating anything (matching the engine's own
-- read-then-decide order) rather than inferring it from apply_leg_outcome's side effect.
create function public.reap_dead_claimed_leg(p_leg uuid, p_hangup_cause text default 'timeout')
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
  set state = 'ended', hangup_cause = p_hangup_cause, ended_at = now()
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

revoke all on function public.reap_dead_claimed_leg(uuid, text) from public, anon, authenticated;
grant execute on function public.reap_dead_claimed_leg(uuid, text) to service_role;

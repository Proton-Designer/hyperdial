-- TASK-T3 review fix-forward (eng1's audit/T3/review-eng1.md finding #1; lead's
-- wip/msg-fix-T3.txt): a manager's coaching leg (real Telnyx billing) kept running
-- indefinitely after the coached call ended -- nothing observed the TARGET session's own
-- lifecycle. Two layers close this: (a) CoachingBanner.tsx polls the target session and
-- auto-hangs-up client-side (the fast path, this migration doesn't touch that); (b) this
-- sweeper safety net covers a crashed/backgrounded manager tab.
--
-- Unlike run_dialer_sweep's stale-claimed-leg check, reaping a coaching session needs no live
-- Telnyx call at all -- staleness is derived purely from the TARGET session's own state/
-- updated_at, already in our own bookkeeping (dial_sessions). dialer-sweeper/index.ts (TS side)
-- calls this, then does the actual best-effort Telnyx hangup per returned
-- manager_call_control_id, the same split of responsibility as reaped_legs/stale_claimed_legs.
--
-- Two independent staleness conditions (either one reaps): (1) the target session is not
-- currently on_call AND has been in its current state for more than p_stuck_after_seconds
-- (covers "the coached call ended/dropped a while ago"); (2) the coaching session itself is
-- older than p_hard_cap_seconds regardless of target state (covers a target session that
-- somehow never leaves on_call, or any other pathological case -- an absolute ceiling on a
-- manager's own real-money leg). Only rows still in ('starting','active') are ever touched, so
-- re-running this on every 30s sweeper tick is naturally idempotent -- a session this already
-- ended on a prior tick simply won't match the WHERE clause again.

create function public.reap_stale_coaching_sessions(
  p_stuck_after_seconds int,
  p_hard_cap_seconds int
)
returns table (
  id uuid,
  org_id uuid,
  manager_call_control_id text
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
  returning cs.id, cs.org_id, cs.manager_call_control_id;
end;
$$;

revoke all on function public.reap_stale_coaching_sessions(int, int) from public, anon, authenticated;
grant execute on function public.reap_stale_coaching_sessions(int, int) to service_role;

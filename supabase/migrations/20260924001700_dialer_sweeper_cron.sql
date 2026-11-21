-- dialer-sweeper safety net (design §4.7, TASK-P2-E5): reconciles state a lost webhook can
-- otherwise strand forever. Also closes TASK-P2-E2's own carried item 5: record_webhook_event
-- (20260924001000/000800) commits its dedupe row before processing runs, so a webhook whose
-- processing throws AFTER that commit is lost outright -- Telnyx already got its 200 and will
-- never redeliver an event it thinks succeeded.
--
-- Three independent reconciliations, all built on the SAME idempotent primitives the engine
-- itself already uses (transition_leg/transition_session's expected-state no-op, apply_leg_
-- outcome's outcome_applied_at gate) rather than any new locking scheme:
--   1. A pre-connect or hangup-pending contact leg (initiated/ringing/answered/amd_pending/
--      dropped/abandoned/machine -- everything non-terminal EXCEPT 'claimed') with no
--      webhook_events row (or none at all, falling back to created_at) for more than
--      p_stuck_after_seconds -- ended as failed/no_answer, then the normal apply_leg_outcome
--      accounting. 'claimed' (bridged, actively talking) is deliberately EXCLUDED: a real live
--      call is silent on the webhook stream for its whole duration by design (only call.hangup
--      fires at the end), so webhook silence alone can't distinguish "on a real call" from
--      "the hangup webhook got lost" -- forcibly hanging up a live conversation on that false
--      positive is worse than leaving the rare true-dead-claimed-leg case to Telnyx's own
--      eventual hangup delivery (it has its own time_limit/timeout handling). Logged as a known
--      gap in known-issues.md, not silently assumed away.
--   2. A session whose agent leg has independently reached 'ended' (no agent legs exist yet --
--      E3's job -- so this is a no-op in production until then; exercised here with a
--      synthetic kind='agent' leg row).
--   3. In_flight leads a leg can no longer speak for: (3a) a leg that reached 'ended' with an
--      outcome recorded but never applied (the exact item-5 gap above -- apply_leg_outcome is
--      already idempotent, so this is just "run it"), and (3b) a lead whose latest leg ended
--      with NO outcome at all, or has no leg row whatsoever -- nothing for apply_leg_outcome to
--      compute, so this is a direct requeue at attempts+0 (the engine's own bookkeeping
--      catching up, not a real dial attempt that reached the contact). A CONNECTED leg's lead
--      deliberately stays in_flight until Phase 3's disposition submission resolves it --
--      excluded by construction (outcome='connected' is never null), not by a special case.
--
-- Reusing transition_leg/transition_session for the actual mutations (rather than a raw UPDATE
-- against call_legs/dial_sessions) means a leg or session a REAL webhook resolves in the tiny
-- window between this function's SELECT and its transition call simply fails the expected-
-- state check and is skipped -- the same safe race-loss shape as every other caller of these
-- RPCs (dialer-engine.ts's applyLegTransition, claim_leg's win path, ...), not a new one.

create type public.dialer_sweep_result as (
  reaped_legs jsonb,
  paused_agent_sessions int,
  applied_orphaned_outcomes int,
  requeued_leads int
);

create function public.run_dialer_sweep(p_stuck_after_seconds int default 60)
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

  -- 2. Sessions whose agent leg has ended ---------------------------------------------------
  for v_row in
    select ds.id, ds.state
    from public.dial_sessions ds
    join public.call_legs al on al.id = ds.agent_leg_id
    where al.state = 'ended'
      and ds.state in ('dialing', 'connecting', 'on_call', 'wrap_up')
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

revoke all on function public.run_dialer_sweep(int) from public, anon, authenticated;
grant execute on function public.run_dialer_sweep(int) to service_role;

-- pg_cron + pg_net: ping dialer-sweeper every 30s -----------------------------------------------
-- Same shape as 20260924002000's ghl-sync-worker scaffolding (private.crm_sync_worker_config /
-- set_crm_sync_worker_config / trigger_ghl_sync_worker) -- global (not per-org) config, a shared
-- secret in Vault checked by the Edge Function via an X-Cron-Secret header (not a user JWT), a
-- silent no-op until private.set_dialer_sweeper_config(url, secret) is called (fresh installs
-- never error every tick). This is the SECOND cron job in this repo; naming stays consistent
-- with the first: cron.schedule('<domain>-<purpose>', ...).

create table private.dialer_sweeper_config (
  id boolean primary key default true,
  url text,
  secret_secret_id uuid,
  constraint dialer_sweeper_config_singleton check (id)
);

create function private.set_dialer_sweeper_config(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select secret_secret_id into v_existing_secret_id from private.dialer_sweeper_config where id = true;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret);
  end if;

  insert into private.dialer_sweeper_config (id, url, secret_secret_id)
  values (true, p_url, v_secret_id)
  on conflict (id) do update set url = excluded.url, secret_secret_id = excluded.secret_secret_id;
end;
$$;

revoke all on function private.set_dialer_sweeper_config(text, text) from public;
grant execute on function private.set_dialer_sweeper_config(text, text) to service_role, postgres;

create function private.trigger_dialer_sweeper()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret_id uuid;
  v_secret text;
begin
  select url, secret_secret_id into v_url, v_secret_id from private.dialer_sweeper_config where id = true;

  if v_url is null or v_secret_id is null then
    return; -- not configured yet (fresh install) -- no-op, not an error every tick.
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    return;
  end if;

  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
    timeout_milliseconds := 20000
  );
end;
$$;

-- Explicit, not assumed already enabled (TASK-P3-P3's own fix-forward lesson: don't rely on a
-- real deployed project having pg_net on just because local dev happens to).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('dialer-sweeper', '30 seconds', $$select private.trigger_dialer_sweeper();$$);

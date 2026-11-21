-- TASK-P3-E1 fix-forward, from the lead's review of 20260924002200 (2 items):
--
-- 1. DOUBLE-SUBMIT RACE (high). `submit_disposition` read call_legs without a row lock, so two
--    concurrent submits for the same leg (a double-click, or a client retry racing its own first
--    attempt) both see dispositioned_at is null and both run the "apply the lead effect" block --
--    the idempotency guard only works against a SEQUENTIAL re-submit, not a concurrent one. Fix:
--    `select ... for update` the call_legs row (same "lock, then decide" shape as
--    claim_next_leads' dial_sessions row lock, TASK-P2-E2 fix-forward item 1) -- the second
--    concurrent call now blocks until the first commits, then re-reads a row whose
--    dispositioned_at is already set and correctly takes the re-submit (no-op-effect) path.
--
-- 2. THE 'queued' EFFECT DOUBLE-COUNTS ATTEMPTS AND REDIALS IMMEDIATELY (high). Every leg
--    `submit_disposition` is ever called on already went through `apply_leg_outcome('connected')`
--    when it won and hung up (dialer-engine.ts's wrap_up transition) -- that RPC's own outcome
--    table already does `attempts + 1` for a 'connected' outcome (leaving `status` alone
--    specifically "for the disposition" and `next_attempt_at` UNCHANGED, i.e. still <= now() from
--    whenever it was originally due). `submit_disposition`'s old 'queued' branch then added a
--    SECOND `attempts + 1` on top of that, AND never touched `next_attempt_at` -- so a
--    "Left voicemail"/"No answer (manual)" disposition double-counted the attempt AND left the
--    lead immediately re-claimable in the very same dialing session (next_attempt_at was already
--    <= now()). Fix: no extra increment here (apply_leg_outcome already did the one real
--    increment); read the now-current `attempts` (post apply_leg_outcome) against the campaign's
--    own `max_attempts` to decide `exhausted` vs `queued`, and push `next_attempt_at` out by the
--    campaign's `retry_interval_minutes` from now.
--
-- Append-only: 20260924002200 is not edited. Timestamp assigned by the lead.

create or replace function public.submit_disposition(
  p_leg uuid,
  p_org uuid,
  p_caller_user_id uuid,
  p_disposition text,
  p_notes text,
  p_callback_at timestamptz
)
returns table (session_id uuid, already_submitted boolean)
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
begin
  -- Item 1: lock this leg's row for the whole call. A second concurrent submit_disposition for
  -- the SAME leg blocks here until this transaction commits or rolls back, then sees the
  -- now-current dispositioned_at instead of racing this transaction's own not-yet-committed read.
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
      dispositioned_at = coalesce(v_leg.dispositioned_at, now())
  where id = p_leg;

  if not v_already and v_leg.lead_id is not null then
    if v_disposition.lead_effect = 'completed' then
      update public.campaign_leads set status = 'completed', updated_at = now() where id = v_leg.lead_id;
    elsif v_disposition.lead_effect = 'exhausted' then
      update public.campaign_leads set status = 'exhausted', updated_at = now() where id = v_leg.lead_id;
    elsif v_disposition.lead_effect = 'callback' then
      update public.campaign_leads
      set status = 'callback',
          next_attempt_at = v_effective_callback_at,
          assigned_agent_id = v_session.agent_id,
          updated_at = now()
      where id = v_leg.lead_id;
    elsif v_disposition.lead_effect = 'queued' then
      -- Item 2: apply_leg_outcome('connected') already incremented attempts once for this leg
      -- (see this migration's own header) -- do NOT increment again here, just re-derive
      -- status/next_attempt_at from the campaign's own retry policy against the current attempts.
      select max_attempts, retry_interval_minutes into v_max_attempts, v_retry_minutes
      from public.campaigns where id = v_leg.campaign_id;
      update public.campaign_leads cl
      set status = case when cl.attempts >= coalesce(v_max_attempts, 3) then 'exhausted' else 'queued' end,
          next_attempt_at = now() + make_interval(mins => coalesce(v_retry_minutes, 120)),
          updated_at = now()
      where cl.id = v_leg.lead_id;
    end if;
  end if;

  if not v_already and v_disposition.lead_effect = 'dnc' and v_leg.contact_id is not null then
    update public.contacts set dnc = true, updated_at = now() where id = v_leg.contact_id;
    update public.campaign_leads set status = 'dnc', updated_at = now() where contact_id = v_leg.contact_id;
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
      'recording_url', null,
      'transcript_excerpt', null
    )
  );

  perform public.transition_session(v_session.id, array['wrap_up'], 'dialing', '{}'::jsonb);

  return query select v_session.id, v_already;
end;
$$;

revoke all on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz) to service_role;

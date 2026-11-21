-- Fix-forward for TASK-P2-E1's dialer RPCs (20260924000700/000800), per the lead's diff-read.
-- Append-only: 000700/000800 are left untouched. Five independent fixes:
--
--   A. apply_leg_outcome was not idempotent -- a webhook redelivery or the sweeper racing the
--      webhook could apply the same outcome twice, double-incrementing attempts and resetting
--      next_attempt_at a second time.
--   B. call_legs.hangup_cause/amd_result CHECK constraints hardcoded a subset of Telnyx's own
--      enums. Telnyx has more hangup causes than the nine listed (e.g. destination_out_of_order,
--      unallocated_number, invalid_number_format); an unlisted value made transition_leg RAISE,
--      so the leg could never reach 'ended'. These columns store Telnyx's raw value; the engine
--      normalizes for logic, the DB shouldn't gatekeep a vocabulary it doesn't control.
--   C. claim_leg didn't check that p_leg actually belongs to p_session or is still live. A leg
--      that ended in a race (e.g. the contact hung up a beat before the claim) could still win
--      the session, leaving it stuck in 'connecting' with a dead leg.
--   D. is_lead_callable_now raised "time zone not recognized" on a bad contacts.timezone value
--      (e.g. a bad CSV import row), which aborted claim_next_leads for the ENTIRE campaign -- one
--      bad row stopped all dialing, not just that one lead.
--   E. claim_next_leads didn't check dial_sessions.state at all; defense in depth to never claim
--      leads for a session that isn't actually 'dialing'.

-- A. outcome_applied_at: idempotency gate for apply_leg_outcome -------------------------------

alter table public.call_legs add column outcome_applied_at timestamptz;

create or replace function public.apply_leg_outcome(p_leg uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome text;
  v_lead_id uuid;
  v_session_id uuid;
  v_campaign_id uuid;
  v_max_attempts int;
  v_retry_minutes int;
begin
  -- The conditional UPDATE is the single winner, exactly like claim_leg's session claim: a second
  -- call (redelivery, sweeper racing the webhook) finds outcome_applied_at already set and is a
  -- no-op, never a double-apply.
  update public.call_legs
  set outcome_applied_at = now()
  where id = p_leg and outcome_applied_at is null and outcome is not null
  returning outcome, lead_id, session_id, campaign_id
  into v_outcome, v_lead_id, v_session_id, v_campaign_id;

  if not found then
    return;
  end if;

  if v_lead_id is not null then
    select max_attempts, retry_interval_minutes into v_max_attempts, v_retry_minutes
    from public.campaigns where id = v_campaign_id;

    update public.campaign_leads cl
    set
      status = case
        when v_outcome = 'failed' then 'exhausted'
        when v_outcome = 'connected' then cl.status
        when cl.attempts + (case when v_outcome = 'dropped' then 0 else 1 end) >= v_max_attempts
          then 'exhausted'
        else 'queued'
      end,
      attempts = cl.attempts + (case when v_outcome = 'dropped' then 0 else 1 end),
      last_outcome = v_outcome,
      next_attempt_at = case
        when v_outcome in ('dropped', 'abandoned') then now() + interval '15 minutes'
        when v_outcome in ('no_answer', 'busy', 'machine') then now() + make_interval(mins => coalesce(v_retry_minutes, 120))
        else cl.next_attempt_at
      end,
      updated_at = now()
    where cl.id = v_lead_id;
  end if;

  if v_session_id is not null then
    update public.dial_sessions
    set active_leg_id = null, updated_at = now()
    where id = v_session_id and active_leg_id = p_leg;
  end if;
end;
$$;

-- B. drop the Telnyx-controlled-vocabulary CHECKs -----------------------------------------------

alter table public.call_legs drop constraint call_legs_hangup_cause_check;
alter table public.call_legs drop constraint call_legs_amd_result_check;

-- C. claim_leg: lock and validate the leg before claiming the session --------------------------

create or replace function public.claim_leg(p_session uuid, p_leg uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_leg_ok boolean;
  v_won boolean;
begin
  select true into v_leg_ok
  from public.call_legs
  where id = p_leg
    and session_id = p_session
    and kind = 'contact'
    and state in ('initiated', 'ringing', 'answered', 'amd_pending')
  for update;

  if v_leg_ok is not true then
    return false;
  end if;

  update public.dial_sessions
  set active_leg_id = p_leg, state = 'connecting', updated_at = now()
  where id = p_session and state = 'dialing' and active_leg_id is null;

  v_won := found;

  if v_won then
    update public.call_legs
    set state = 'claimed', claimed_at = now()
    where id = p_leg;
  end if;

  return v_won;
end;
$$;

-- D. an unrecognized timezone falls back to the both-coasts rule, never aborts the caller -------

create function private.safe_timezone(p_timezone text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_timezone is not null
      and exists (select 1 from pg_catalog.pg_timezone_names where name = p_timezone)
    then p_timezone
    else null
  end;
$$;

create or replace function private.is_lead_callable_now(p_timezone text, p_window_start time, p_window_end time)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when private.safe_timezone(p_timezone) is not null then
      (now() at time zone private.safe_timezone(p_timezone))::time >= p_window_start
      and (now() at time zone private.safe_timezone(p_timezone))::time < p_window_end
    else
      (now() at time zone 'America/New_York')::time >= p_window_start
      and (now() at time zone 'America/New_York')::time < p_window_end
      and (now() at time zone 'America/Los_Angeles')::time >= p_window_start
      and (now() at time zone 'America/Los_Angeles')::time < p_window_end
  end;
$$;

-- E. claim_next_leads: only ever claim for a session that is actually dialing -------------------

create or replace function public.claim_next_leads(p_session uuid, p_n int)
returns setof public.claimed_lead
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign_id uuid;
  v_agent_id uuid;
  v_window_start time;
  v_window_end time;
begin
  select ds.campaign_id, ds.agent_id into v_campaign_id, v_agent_id
  from public.dial_sessions ds
  where ds.id = p_session and ds.state = 'dialing';

  if v_campaign_id is null then
    return;
  end if;

  select c.calling_window_start, c.calling_window_end into v_window_start, v_window_end
  from public.campaigns c
  where c.id = v_campaign_id;

  return query
  with picked as (
    select
      cl2.id,
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) as is_priority_callback,
      cl2.attempts,
      cl2.next_attempt_at,
      cl2.position
    from public.campaign_leads cl2
    join public.contacts ct on ct.id = cl2.contact_id
    where cl2.campaign_id = v_campaign_id
      and cl2.next_attempt_at <= now()
      and not ct.dnc
      and (
        cl2.status = 'queued'
        or (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id)
      )
      and private.is_lead_callable_now(ct.timezone, v_window_start, v_window_end)
    order by
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) desc,
      cl2.attempts asc,
      cl2.next_attempt_at asc,
      cl2.position asc
    limit p_n
    for update of cl2 skip locked
  ),
  updated as (
    update public.campaign_leads cl
    set status = 'in_flight', updated_at = now()
    from picked
    where cl.id = picked.id
    returning cl.id, cl.contact_id, cl.attempts, cl.status
  )
  select
    u.id,
    u.contact_id,
    (select ct2.phone_number from public.contacts ct2 where ct2.id = u.contact_id),
    u.attempts,
    u.status
  from updated u
  join picked p on p.id = u.id
  order by p.is_priority_callback desc, p.attempts asc, p.next_attempt_at asc, p.position asc;
end;
$$;

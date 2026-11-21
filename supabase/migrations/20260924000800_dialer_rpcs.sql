-- Dialer schema (2/2): the transition/claim RPCs from docs/design/stage-1-architecture.md
-- §4.2-4.4, §7. All SECURITY DEFINER, search_path='', public schema (so PostgREST/`.rpc()` can
-- reach them -- see the TASK-P1-05 finding that `private.*` is unreachable from a service-role
-- client), execute revoked from public/anon/authenticated and granted to service_role only. The
-- owning edge function (TASK-P2-E2, out of scope here) is responsible for its own org-membership
-- check before calling any of these -- these RPCs trust their caller, the way
-- set_org_telnyx_key/get_org_telnyx_key already do (TASK-P1-05).

-- Calling window (§7): the contact's own timezone if known; otherwise callable only when the
-- window holds in BOTH America/New_York and America/Los_Angeles, so an unknown-timezone US number
-- is never called outside a compliance-safe hour on either coast. `timestamptz AT TIME ZONE
-- <iana zone>` is DST-correct (unlike a fixed UTC offset), which is why this takes a zone name.

create function private.is_lead_callable_now(p_timezone text, p_window_start time, p_window_end time)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when p_timezone is not null then
      (now() at time zone p_timezone)::time >= p_window_start
      and (now() at time zone p_timezone)::time < p_window_end
    else
      (now() at time zone 'America/New_York')::time >= p_window_start
      and (now() at time zone 'America/New_York')::time < p_window_end
      and (now() at time zone 'America/Los_Angeles')::time >= p_window_start
      and (now() at time zone 'America/Los_Angeles')::time < p_window_end
  end;
$$;

-- claim_next_leads (§4.2): the rolling-refill selection + claim, one FOR UPDATE SKIP LOCKED pass
-- so several agents on the same campaign never claim the same lead twice. A due callback assigned
-- to this session's own agent sorts ahead of everything else; ties within a priority tier follow
-- attempts, then next_attempt_at, then position (import order) -- "everyone gets pass 1 before
-- anyone gets pass 2."

create type public.claimed_lead as (
  lead_id uuid,
  contact_id uuid,
  phone_number text,
  attempts int,
  status text
);

create function public.claim_next_leads(p_session uuid, p_n int)
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
  where ds.id = p_session;

  if v_campaign_id is null then
    return;
  end if;

  select c.calling_window_start, c.calling_window_end into v_window_start, v_window_end
  from public.campaigns c
  where c.id = v_campaign_id;

  -- UPDATE ... RETURNING has no defined output order, so the priority order has to be carried
  -- through explicitly and re-applied in a final SELECT -- `picked` freezes the pre-update
  -- attempts/next_attempt_at/position/callback-priority (status flips to 'in_flight' for every
  -- claimed row, which would otherwise erase the callback-vs-queued distinction the sort needs).
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

-- claim_leg (§4.3): the single-winner conditional UPDATE, verbatim. Exactly one caller can ever
-- win a given session's active_leg_id, because the UPDATE's WHERE clause is checked and applied
-- atomically -- no separate SELECT-then-UPDATE race. The winning leg is marked claimed in the same
-- call; a losing leg's own terminal state (dropped/abandoned) is the caller's job via
-- transition_leg, matching dialer-core.ts's loserActions (TASK-P2-E0).

create function public.claim_leg(p_session uuid, p_leg uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_won boolean;
begin
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

-- transition_leg / transition_session (§4.4): every transition checks the expected prior state and
-- is a no-op (never an error) when it doesn't match, so webhook redelivery or out-of-order events
-- are harmless. `p_fields` carries only the columns this transition actually sets; omitted keys are
-- left alone, and a key present with a JSON null explicitly clears that column (used to null out
-- active_leg_id when a call ends).

create function public.transition_leg(
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
    ended_at = case when p_fields ? 'ended_at' then (p_fields ->> 'ended_at')::timestamptz else ended_at end,
    duration_seconds = case when p_fields ? 'duration_seconds' then (p_fields ->> 'duration_seconds')::int else duration_seconds end
  where call_control_id = p_call_control_id
    and state = any(p_expected_states)
  returning id into v_id;

  return v_id is not null;
end;
$$;

create function public.transition_session(
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
begin
  update public.dial_sessions
  set
    state = p_new_state,
    updated_at = now(),
    agent_leg_id = case when p_fields ? 'agent_leg_id' then (p_fields ->> 'agent_leg_id')::uuid else agent_leg_id end,
    active_leg_id = case when p_fields ? 'active_leg_id' then (p_fields ->> 'active_leg_id')::uuid else active_leg_id end,
    conference_id = case when p_fields ? 'conference_id' then (p_fields ->> 'conference_id') else conference_id end,
    ended_at = case when p_fields ? 'ended_at' then (p_fields ->> 'ended_at')::timestamptz else ended_at end
  where id = p_session
    and state = any(p_expected_states)
  returning id into v_id;

  return v_id is not null;
end;
$$;

-- apply_leg_outcome (§4.2 outcome table): recomputes the same table dialer-core.ts's pure
-- leadOutcomeUpdate() implements, but as an atomic UPDATE against the live row -- deliberately not
-- "compute in TS, then write the computed fields," which would read-then-write across two RPC
-- calls and race against a concurrent outcome on the same lead. leadOutcomeUpdate stays useful for
-- preview/tests; the engine (TASK-P2-E2) should call this RPC for the actual write. Logged in
-- OPEN_QUESTIONS.md so E2 doesn't reintroduce the duplicated, racy path.
--
-- "failed" always exhausts. "connected" leaves status to the disposition (Phase 3, out of scope).
-- Every other outcome increments attempts except "dropped" (+0 -- it was never really attempted),
-- and exhausts once attempts would reach max_attempts, per the table's last row.

create function public.apply_leg_outcome(p_leg uuid)
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
  select outcome, lead_id, session_id, campaign_id
    into v_outcome, v_lead_id, v_session_id, v_campaign_id
  from public.call_legs
  where id = p_leg;

  if v_outcome is null then
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

-- record_webhook_event: dedupe gate. Returns false (and writes nothing) when the event_id was
-- already seen, so the caller can short-circuit before touching call_legs/dial_sessions at all.

create function public.record_webhook_event(
  p_org uuid,
  p_event_id uuid,
  p_event_type text,
  p_call_control_id text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.webhook_events (org_id, event_id, event_type, call_control_id)
  values (p_org, p_event_id, p_event_type, p_call_control_id)
  on conflict (event_id) do nothing;

  return found;
end;
$$;

-- Grants: service_role only. None of these are a UI-facing read helper.

revoke all on function public.claim_next_leads(uuid, int) from public, anon, authenticated;
revoke all on function public.claim_leg(uuid, uuid) from public, anon, authenticated;
revoke all on function public.transition_leg(text, text[], text, jsonb) from public, anon, authenticated;
revoke all on function public.transition_session(uuid, text[], text, jsonb) from public, anon, authenticated;
revoke all on function public.apply_leg_outcome(uuid) from public, anon, authenticated;
revoke all on function public.record_webhook_event(uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.claim_next_leads(uuid, int) to service_role;
grant execute on function public.claim_leg(uuid, uuid) to service_role;
grant execute on function public.transition_leg(text, text[], text, jsonb) to service_role;
grant execute on function public.transition_session(uuid, text[], text, jsonb) to service_role;
grant execute on function public.apply_leg_outcome(uuid) to service_role;
grant execute on function public.record_webhook_event(uuid, uuid, text, text) to service_role;

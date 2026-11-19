-- TASK-H36: nothing ever ended an inbound_calls row whose terminal webhook was lost or whose
-- transfer command failed, so the caller never reached the Inbox (the trigger only fires on
-- state -> 'ended' with outcome missed/voicemail).
--
-- Round 2 (eng2 review MUST): the reaper must NEVER end or hang up a call that is still alive on
-- Telnyx (a live forwarded conversation can have a null answered_at if its answer webhook was
-- lost). So SQL only LISTS candidates and ENDS one row on request; dialer-sweeper asks Telnyx
-- (GET /calls/{id} is_alive) per candidate and decides. Neither function hangs anything up.

create function public.list_stale_inbound_calls(
  p_unanswered_after_seconds int default 180,
  p_voicemail_after_seconds int default 600,
  p_answered_after_seconds int default 1800
)
returns table (
  id uuid, org_id uuid, call_control_id text, state text,
  answered_at timestamptz, created_at timestamptz, dial_session_id uuid
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  select c.id, c.org_id, c.call_control_id, c.state, c.answered_at, c.created_at, c.dial_session_id
  from public.inbound_calls c
  where c.state <> 'ended'
    and (
      (c.answered_at is null
        and c.created_at < now() - make_interval(secs => p_unanswered_after_seconds))
      or (c.answered_at is not null
        and c.answered_at < now() - make_interval(
          secs => case when c.state = 'voicemail' then p_voicemail_after_seconds
                       else p_answered_after_seconds end))
    )
  order by c.created_at
  limit 100;
end;
$$;

-- Ends ONE row (the caller already established the Telnyx leg is gone, or has hung it up).
-- Returns the outcome, or null if the row had already ended (lost a race to a real event).
create function public.end_stale_inbound_call(p_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome text;
begin
  update public.inbound_calls c
  set state = 'ended',
      ended_at = now(),
      outcome = case
        when c.answered_at is null then 'missed'
        when c.state = 'voicemail' then 'voicemail'
        when c.state in ('bridging_session', 'ringing_intern') then 'answered_by_agent'
        else 'forwarded'
      end
  where c.id = p_id and c.state <> 'ended'
  returning c.outcome into v_outcome;
  return v_outcome;
end;
$$;

revoke all on function public.list_stale_inbound_calls(int, int, int) from public, anon, authenticated;
grant execute on function public.list_stale_inbound_calls(int, int, int) to service_role;
revoke all on function public.end_stale_inbound_call(uuid) from public, anon, authenticated;
grant execute on function public.end_stale_inbound_call(uuid) to service_role;

-- One-off cleanup, deliberately NOT the general reaper: only rows created before this
-- migration's own date (the 16-17 rows the TASK-H36 diagnosis found stuck; every one is days
-- old, so none can be a live call). ended_at is the row's own creation time + 3 minutes (its
-- real chain length), not now(), so old callers do not look like "just now" in the Inbox.
-- The UPDATE fires the Inbox trigger: each of those callers appears as a missed call.
update public.inbound_calls c
set state = 'ended',
    ended_at = c.created_at + interval '3 minutes',
    outcome = case
      when c.answered_at is null then 'missed'
      when c.state = 'voicemail' then 'voicemail'
      when c.state in ('bridging_session', 'ringing_intern') then 'answered_by_agent'
      else 'forwarded'
    end
where c.state <> 'ended'
  and c.created_at < timestamptz '2026-11-19 00:00:00+00';

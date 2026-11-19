-- TASK-H36: nothing ever ended an inbound_calls row whose terminal webhook was lost or whose
-- transfer command failed, so the caller never reached the Inbox (the trigger only fires on
-- state -> 'ended' with outcome missed/voicemail). This reaper is called by dialer-sweeper.
--
-- Never-answered rows (answered_at is null) are dead after p_unanswered_after_seconds: the whole
-- ring chain is 3 x 20 s of ringing plus the voicemail answer. Rows that did connect (answered_at
-- set) can legitimately run long (a forwarded conversation, a voicemail recording), so they only
-- get an absolute ceiling and keep their connected outcome.
create function public.sweep_stuck_inbound_calls(
  p_unanswered_after_seconds int default 180,
  p_answered_after_seconds int default 14400
)
returns table (id uuid, org_id uuid, call_control_id text, outcome text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with reaped as (
    update public.inbound_calls c
    set state = 'ended',
        ended_at = now(),
        outcome = case
          when c.answered_at is null then 'missed'
          when c.state = 'voicemail' then 'voicemail'
          when c.state in ('bridging_session', 'ringing_intern') then 'answered_by_agent'
          else 'forwarded'
        end
    where c.state <> 'ended'
      and (
        (c.answered_at is null and c.created_at < now() - make_interval(secs => p_unanswered_after_seconds))
        or (c.answered_at is not null and c.answered_at < now() - make_interval(secs => p_answered_after_seconds))
      )
    returning c.id, c.org_id, c.call_control_id, c.outcome
  )
  select r.id, r.org_id, r.call_control_id, r.outcome from reaped r;
end;
$$;

revoke all on function public.sweep_stuck_inbound_calls(int, int) from public, anon, authenticated;
grant execute on function public.sweep_stuck_inbound_calls(int, int) to service_role;

-- One-off cleanup of the rows stuck before this existed (the TASK-H36 diagnosis found 16):
-- the UPDATE inside the function fires the Inbox trigger, so each of those callers now shows up
-- as a missed call.
select count(*) from public.sweep_stuck_inbound_calls(180, 14400);

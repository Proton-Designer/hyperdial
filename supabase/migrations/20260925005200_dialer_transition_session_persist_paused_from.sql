-- TASK-L1 re-review (audit/L1/review-notes-r2.md, MAJOR M4-not-effective-in-prod): the
-- original transition_session (20260924000800_dialer_rpcs.sql) only ever wrote
-- agent_leg_id/active_leg_id/conference_id/ended_at -- the paused_agent_lost_from key
-- dialer-engine.ts's handleAgentLegLost/handleAgentLegAnswered has been sending in p_fields
-- since 20260925005100 was silently dropped, so the column stayed permanently null in prod
-- and Reconnect from a manually 'paused' session always resumed dialing instead of returning
-- to paused. Append-only fix-forward: same signature/grants/security definer, one more
-- case-when arm. Must be applied AFTER 20260925005100 (the column itself).

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
begin
  update public.dial_sessions
  set
    state = p_new_state,
    updated_at = now(),
    agent_leg_id = case when p_fields ? 'agent_leg_id' then (p_fields ->> 'agent_leg_id')::uuid else agent_leg_id end,
    active_leg_id = case when p_fields ? 'active_leg_id' then (p_fields ->> 'active_leg_id')::uuid else active_leg_id end,
    conference_id = case when p_fields ? 'conference_id' then (p_fields ->> 'conference_id') else conference_id end,
    ended_at = case when p_fields ? 'ended_at' then (p_fields ->> 'ended_at')::timestamptz else ended_at end,
    paused_agent_lost_from = case when p_fields ? 'paused_agent_lost_from' then (p_fields ->> 'paused_agent_lost_from') else paused_agent_lost_from end
  where id = p_session
    and state = any(p_expected_states)
  returning id into v_id;

  return v_id is not null;
end;
$$;

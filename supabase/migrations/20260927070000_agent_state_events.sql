-- MISSION-5 TASK-M5-B1: agent_state_events -- one open row per agent, mirroring
-- dial_sessions.state 1:1 (never a bucketed/derived vocabulary, so no future dial_sessions
-- state addition can silently fall outside what this table records). Written from exactly two
-- places, both already the sole choke points for every dial_sessions state change in this
-- codebase, so no per-call-site wiring can drift out of sync:
--   1. A trigger on dial_sessions AFTER INSERT (the only place a session's FIRST state,
--      'ready_pending', is ever written -- startSession's plain .insert(), never through
--      transition_session).
--   2. transition_session itself (every state change after that -- 11 functions across
--      dialer-engine.ts call it, per the lead's own note in TASK-M5-B1.md; hooking the RPC once
--      here covers all of them for free, matching this task's own "keep it inside the existing
--      transition functions so it can't drift" instruction).
-- Both close the agent's currently-open row (if any) before opening the new one -- the partial
-- unique index below makes "more than one open row for the same agent" a hard DB error, not just
-- a design intent.

create table public.agent_state_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  agent_id uuid not null references auth.users(id) on delete cascade,
  session_id uuid not null references public.dial_sessions(id) on delete cascade,
  state text not null,
  reason text,
  started_at timestamptz not null default now(),
  ended_at timestamptz
);

create index idx_agent_state_events_org_id on public.agent_state_events(org_id);
create index idx_agent_state_events_agent_started on public.agent_state_events(agent_id, started_at);

-- Enforces "one open row per agent" as a real constraint, not just an intent every write site
-- has to remember -- a bug that tried to open a second row for an already-open agent fails loudly
-- at INSERT time instead of silently leaving two open rows (which would double-count time in
-- agent_time_in_state below).
create unique index agent_state_events_one_open_per_agent
  on public.agent_state_events (agent_id) where ended_at is null;

alter table public.agent_state_events enable row level security;

-- No client INSERT/UPDATE/DELETE policy, same shape as dial_sessions's own header comment: every
-- write goes through the SECURITY DEFINER trigger function / transition_session below.

create policy "owner or admin can view org agent_state_events"
  on public.agent_state_events for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

create policy "agent can view own agent_state_events"
  on public.agent_state_events for select
  using (private.has_org_role(org_id, array['agent']) and agent_id = auth.uid());

-- 1. The INSERT-time hook: dial_sessions' very first row (state='ready_pending') is a plain
--    .insert() (startSession, _shared/dialer-engine.ts), never transition_session. Defensively
--    closes any stray already-open row for this agent first (should never exist, given
--    dial_sessions_one_active_per_agent already guarantees one non-terminal session per agent --
--    but cheap insurance against this table ever getting out of sync with that invariant).

create function private.log_initial_agent_state_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.agent_state_events
  set ended_at = now()
  where agent_id = new.agent_id and ended_at is null;

  insert into public.agent_state_events (org_id, agent_id, session_id, state, reason, started_at)
  values (new.org_id, new.agent_id, new.id, new.state, null, new.started_at);

  return new;
end;
$$;

create trigger trg_log_initial_agent_state_event
  after insert on public.dial_sessions
  for each row execute function private.log_initial_agent_state_event();

-- 2. The transition-time hook: same UPDATE this function has always run (20260924000800,
--    20260925005200, 20260925070000), unchanged, with an added close-old/open-new event pair on
--    a successful transition. `create or replace` keeps the existing grants (service_role only)
--    intact -- unlike the 080101 team-view drop+recreate, this function's signature/return type
--    is unchanged, so a plain replace is sufficient and doesn't need the grants repeated.
--
--    Reason handling: agent_state_events.reason is populated from the SAME `pause_reason` key in
--    p_fields that already writes dial_sessions.pause_reason (pauseSession/resumeToDialing's own
--    existing convention -- resumeToDialing already explicitly clears it with `pause_reason:
--    null`), so the per-event reason and the session-row's own current pause_reason never
--    disagree. A transition that doesn't touch pause_reason at all (e.g. dialing -> on_call)
--    correctly logs reason = null for that event.

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
  v_org_id uuid;
  v_agent_id uuid;
  v_reason text;
begin
  update public.dial_sessions
  set
    state = p_new_state,
    updated_at = now(),
    agent_leg_id = case when p_fields ? 'agent_leg_id' then (p_fields ->> 'agent_leg_id')::uuid else agent_leg_id end,
    active_leg_id = case when p_fields ? 'active_leg_id' then (p_fields ->> 'active_leg_id')::uuid else active_leg_id end,
    conference_id = case when p_fields ? 'conference_id' then (p_fields ->> 'conference_id') else conference_id end,
    ended_at = case when p_fields ? 'ended_at' then (p_fields ->> 'ended_at')::timestamptz else ended_at end,
    paused_agent_lost_from = case when p_fields ? 'paused_agent_lost_from' then (p_fields ->> 'paused_agent_lost_from') else paused_agent_lost_from end,
    pause_reason = case when p_fields ? 'pause_reason' then (p_fields ->> 'pause_reason') else pause_reason end
  where id = p_session
    and state = any(p_expected_states)
  returning id, org_id, agent_id into v_id, v_org_id, v_agent_id;

  if v_id is not null then
    v_reason := case when p_fields ? 'pause_reason' then (p_fields ->> 'pause_reason') else null end;

    update public.agent_state_events
    set ended_at = now()
    where agent_id = v_agent_id and ended_at is null;

    insert into public.agent_state_events (org_id, agent_id, session_id, state, reason, started_at)
    values (v_org_id, v_agent_id, v_id, p_new_state, v_reason, now());
  end if;

  return v_id is not null;
end;
$$;

-- Backfill: any dial_sessions row already non-terminal at the moment this migration applies
-- (a session started before tonight's deploy) gets its "current state" opening row created now,
-- using dial_sessions.updated_at as the started_at approximation (exactly what transition_session
-- itself sets on every real transition, so this is the correct value, not a guess) -- otherwise
-- an agent already mid-session at deploy time would show a gap in agent_time_in_state until their
-- NEXT transition.

insert into public.agent_state_events (org_id, agent_id, session_id, state, reason, started_at)
select ds.org_id, ds.agent_id, ds.id, ds.state,
       case when ds.state in ('paused', 'paused_agent_lost') then ds.pause_reason else null end,
       ds.updated_at
from public.dial_sessions ds
where ds.state not in ('stopped', 'completed')
  and not exists (
    select 1 from public.agent_state_events e where e.agent_id = ds.agent_id and e.ended_at is null
  );

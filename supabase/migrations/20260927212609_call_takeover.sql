-- MISSION-5 TASK-M5-N1 (deferred backlog item): supervisor call takeover -- a supervisor already
-- monitoring/whispering/barging (T3/B2) on a live call can "Take over": their own conference role
-- is promoted to `barge` (if not already) and the AGENT's own leg leaves the conference and hangs
-- up, leaving the supervisor as the only agent-side party with the prospect. OFF by default per
-- org (audit/M5-N1/notes.md has the full edge-case + design writeup; audit/M5-N1/api-evidence.md
-- has the Telnyx command evidence -- no "kick" endpoint exists, so this is `leave` then `hangup`,
-- both pre-existing TelnyxClient methods, reused unmodified).
--
-- =================================================================================================
-- 1. org_call_takeover_settings -- OFF by default, owner/admin only. A dedicated table (not a
--    column bolted onto org_supervisor_alert_settings/org_recording_settings) because this gates
--    an action's AUTHORIZATION, not an alert threshold or a consent disclosure -- a different
--    semantic home than either existing settings table, same "one setting, one clear home" shape
--    org_supervisor_alert_settings itself already established for its own 4 alert toggles.
-- =================================================================================================

create table public.org_call_takeover_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.org_call_takeover_settings enable row level security;

create policy "org members can view call takeover settings"
  on public.org_call_takeover_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert call takeover settings"
  on public.org_call_takeover_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update call takeover settings"
  on public.org_call_takeover_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.org_call_takeover_settings from anon;

create function private.seed_default_call_takeover_settings(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.org_call_takeover_settings (org_id)
  values (p_org)
  on conflict (org_id) do nothing;
$$;

create function private.seed_default_call_takeover_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_call_takeover_settings(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_call_takeover_settings
  after insert on public.orgs
  for each row execute function private.seed_default_call_takeover_settings_trigger();

do $$
declare
  v_org record;
begin
  for v_org in select id from public.orgs loop
    perform private.seed_default_call_takeover_settings(v_org.id);
  end loop;
end;
$$;

-- Reuses the EXISTING generic settings-change audit trigger (20260927080000_org_audit_log.sql)
-- unmodified -- same pattern this session's own B4 follow-up just added for
-- org_supervisor_alert_settings/user_notification_preferences.
create trigger org_call_takeover_settings_audit
  after insert or update on public.org_call_takeover_settings
  for each row execute function private.audit_log_settings_change_trigger('settings.call_takeover.update', 'org_call_takeover_settings');

-- =================================================================================================
-- 2. coaching_sessions.taken_over_at -- null until a takeover happens on this row. Doubles as the
--    race-guard for "two clicks land at once": the app claims it with a conditional UPDATE
--    (`where status = 'active' and taken_over_at is null`), so a second concurrent click (or a
--    double-tap) gets zero rows back and a clean rejection instead of a second Telnyx command
--    against an already-detached leg. `mode` itself is NOT widened with a 4th value -- Telnyx's
--    own supervisor_role enum has no "takeover", the supervisor's real conference role after a
--    takeover is just `barge`; `taken_over_at` is what actually distinguishes "coaching" from
--    "took over" for anything that needs to tell them apart (UI, audit, analytics).
--
--    N1 fix-forward #2 (the lead's own BLOCKER, found after eng1's re-verify): `taken_over_at`
--    alone is SESSION-scoped, not LEG-scoped -- once a takeover happens, `isSessionTakenOver`
--    (coaching-core.ts) and the manager-branch lookup in dialer-session-disposition/index.ts both
--    read it as "this session was EVER taken over", which wrongly blocks the agent (and wrongly
--    lets the manager in) for every LATER leg of the same session too, after a successful Rejoin.
--    `taken_over_leg_id` records WHICH contact leg (the one the agent was on at takeover time,
--    `dial_sessions.active_leg_id` as read by runTakeoverAction before it clears it) was actually
--    taken over -- both call sites now scope on this column, not just `target_session_id`. `on
--    delete set null` (not cascade) for the same reason as `dial_sessions.taken_over_by_manager_id`
--    below: this is a breadcrumb, the coaching_sessions row's own history shouldn't disappear if
--    the call_legs row it points at is ever purged.
-- =================================================================================================

alter table public.coaching_sessions add column taken_over_at timestamptz;
alter table public.coaching_sessions add column taken_over_leg_id uuid references public.call_legs(id) on delete set null;

-- =================================================================================================
-- 3. dial_sessions.taken_over_by_manager_id -- nullable audit breadcrumb (same nullable + `on
--    delete set null` precedent as dispositions.dispositioned_by, not `coaching_sessions.
--    manager_id`'s not-null+cascade shape -- this column's whole point is to survive independently
--    of whether that user row still exists). Lets the agent's own Dialer banner resolve and show
--    a real name ("Your call was taken over by <name>") rather than a bare pause_reason string.
-- =================================================================================================

alter table public.dial_sessions add column taken_over_by_manager_id uuid references auth.users(id) on delete set null;

-- =================================================================================================
-- 4. transition_session: additive `taken_over_by_manager_id` field-setter branch, same shape as
--    every other optional field this function already supports. Byte-identical to the current
--    live body (20260927151747_supervisor_controls.sql) except for that one new `case when`
--    line -- every existing caller that never passes this key is completely unaffected (an absent
--    key falls through to `else <column> end`, i.e. "leave it alone"). Same signature, same
--    `returns boolean` -- a plain `create or replace`, no drop needed (R-038 is for a RETURNS
--    TABLE/OUT-column shape change, not this).
-- =================================================================================================

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
    pause_reason = case when p_fields ? 'pause_reason' then (p_fields ->> 'pause_reason') else pause_reason end,
    taken_over_by_manager_id = case when p_fields ? 'taken_over_by_manager_id' then (p_fields ->> 'taken_over_by_manager_id')::uuid else taken_over_by_manager_id end,
    -- MISSION-5 TASK-M5-B2: `state` here is the OLD value (the row this UPDATE is about to
    -- replace) -- the auto-clear fires exactly on an on_call -> anything-else transition.
    raised_hand_at = case when state = 'on_call' and p_new_state <> 'on_call' then null else raised_hand_at end
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

-- =================================================================================================
-- 5. reap_stale_coaching_sessions fix-forward: a taken-over coaching_sessions row must NEVER be
--    swept as "stale." Found by reasoning through the interaction, not by a live failure --
--    `taken_over_at` was designed so `target_session.state` moves to `paused` PERMANENTLY the
--    moment a takeover happens (the whole point: the agent's session is done with this call). The
--    sweeper's own staleness condition (`ds.state <> 'on_call' and ds.updated_at < now() -
--    stuck_after`) is EXACTLY this, unconditionally, for any coaching row whose target isn't
--    on_call -- without this exclusion, `p_stuck_after_seconds` after a successful takeover the
--    sweeper would reap the row and `dialer-sweeper/index.ts` would hang up the SUPERVISOR's own
--    live leg, ending their call with the prospect out from under them. `taken_over_at is null`
--    added to BOTH the stuck-after and the hard-cap branches (the same `and` wraps the whole `or`
--    group) -- a legitimate takeover call is expected to run long; it should only ever end via
--    the manager's own real hangup (processTelnyxCoachingEvent's existing `call.hangup` branch,
--    unchanged, already correctly finalizes a taken-over row the same way as any other). Same
--    OUT columns as the live version -- plain `create or replace`, no drop needed.
-- =================================================================================================

create or replace function public.reap_stale_coaching_sessions(
  p_stuck_after_seconds int,
  p_hard_cap_seconds int
)
returns table (
  id uuid,
  org_id uuid,
  manager_call_control_id text,
  manager_id uuid,
  target_session_id uuid
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
      and cs.taken_over_at is null
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
  returning cs.id, cs.org_id, cs.manager_call_control_id, cs.manager_id, cs.target_session_id;
end;
$$;

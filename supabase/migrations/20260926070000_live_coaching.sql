-- TASK-T3 (Mission 4): live coaching -- listen / whisper / barge. User order: "give me
-- everything that relates to the parallel dialer and making it as powerful and industry level as
-- possible."
--
-- coaching_sessions: an audit trail of every coaching attempt, same "owner/admin SELECT only, no
-- client writes at all (service role only)" shape as org_billing_events (20260925080300) --
-- RLS enabled with only a SELECT policy, zero INSERT/UPDATE/DELETE policies.
--
-- Deliberately NOT a call_legs row, even though the manager's coaching leg is a real Telnyx call:
-- `call_legs.kind` is `'contact' | 'agent'` today, and every kind-agnostic consumer in this
-- codebase (loadActiveLegs, refillCount, loserActions, the analytics views, the sweeper) assumes
-- exactly those two values -- this lane's own history (LANE-eng2.md) has FOUR separate incidents
-- of a third leg shape silently breaking a kind-agnostic assumption written before it existed.
-- Adding a third `kind` value would require auditing every one of those call sites for this task
-- alone; keeping the coaching leg's own call_control_id in this dedicated table instead makes it
-- provably invisible to the dial loop -- nothing in dialer-engine.ts, dialer-sweeper, or the
-- analytics views ever reads this table at all.
create table public.coaching_sessions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- The dial_sessions row being coached. ON DELETE CASCADE: dial_sessions rows are never
  -- actually deleted in this schema (ended sessions just transition to 'stopped'/'completed'),
  -- but if that ever changes, a coaching audit row for a session that no longer exists is noise,
  -- not a record worth keeping (unlike org_billing_events' money trail).
  target_session_id uuid not null references public.dial_sessions(id) on delete cascade,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  manager_id uuid not null references auth.users(id) on delete cascade,
  mode text not null check (mode in ('listen', 'whisper', 'barge')),
  -- The manager's own Telnyx call_control_id for their coaching leg -- set once dial() returns
  -- (null for the brief window between the pending-row insert and that response, same
  -- insert-before-dial ordering as dialAgentLegInternal/reserve_add_funds use elsewhere).
  manager_call_control_id text,
  status text not null default 'starting' check (status in ('starting', 'active', 'ended')),
  -- Set by processTelnyxCoachingEvent's call.answered handler, once the manager's leg has
  -- actually joined the target conference as a supervisor -- distinct from `started_at` (when
  -- the attempt began) for the same reason call_legs keeps answered_at separate from created_at.
  joined_at timestamptz,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  -- 'manager_left' (explicit Leave / mode-switch-then-leave), 'manager_hangup' (webhook
  -- call.hangup with no explicit end call first -- e.g. the browser tab closed), 'target_ended'
  -- (the coached session left on_call before/while the manager's leg was joining), 'error'.
  ended_reason text,
  created_at timestamptz not null default now()
);

-- A manager can only run ONE coaching attempt at a time -- they have exactly one WebRTC client
-- (useTelnyxCall's single activeCallRef), so a second concurrent coaching leg would collide with
-- it client-side. Partial: only 'starting'/'active' rows participate: a manager who has ended one
-- coaching session is free to start a new one immediately.
create unique index coaching_sessions_one_active_per_manager
  on public.coaching_sessions (manager_id)
  where status in ('starting', 'active');

-- runStartCoachingAction's own "is someone already coaching this session" + the webhook's lookup
-- of the active row for a target_session_id both filter on this triple.
create index idx_coaching_sessions_target_session_status
  on public.coaching_sessions (target_session_id, status);

alter table public.coaching_sessions enable row level security;

create policy "owner or admin can view coaching_sessions"
  on public.coaching_sessions for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- Belt and braces, same reasoning as org_billing_events' identical revoke.
revoke all on public.coaching_sessions from anon;

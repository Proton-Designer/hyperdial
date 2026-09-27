-- MISSION-4 TASK-T4: warm/cold transfer + hold (AUD-6 + NEW).
--
-- Design (see LANE-eng2.md's own TASK-T4 note for why `transfer` was rejected as the primitive):
-- everything here is built from conference-native actions (join/leave/hold/unhold) already
-- verified against a fresh spec3.json, never Telnyx's `transfer` command -- that command's own
-- schema says nothing about its behavior on a leg that's currently a CONFERENCE PARTICIPANT
-- (every field/example is bridge-shaped, matching inbound-engine.ts's own parked-leg usage), so
-- relying on it to atomically detach a leg from the agent's PERSISTENT, shift-long conference
-- would be an unverified assumption exactly where this task can least afford one.
--
-- The agent's own `dial_sessions.conference_id` is a PERSISTENT room reused across every contact
-- for the whole shift (created once, around the agent leg) -- nothing here may ever leave it
-- pointing at a conference the agent isn't in, or a future winner would get bridged into a
-- stranger's leftover call. So:
--   - HOLD (standalone, AUD-6): the prospect leg is held IN PLACE, in the main conference
--     (Telnyx's own hold is per-participant, not conference-wide -- verified against
--     ConferenceHoldRequest's own "when call_control_ids is empty, ALL participants" wording,
--     confirmed the non-empty case holds ONLY the named ones). Tracked by a single `held_at`
--     timestamp on the EXISTING `call_legs` row -- no new leg kind, no new table for this part.
--   - COLD transfer: once the dialed target answers, the PROSPECT leaves the main conference and
--     joins a brand-new, per-transfer "side" conference created around the target -- the agent's
--     own leg is never touched at all.
--   - WARM transfer: once the target answers, the PROSPECT is held in the MAIN conference (silent
--     to the agent+target's conversation) and the AGENT temporarily leaves the main conference to
--     talk to the target in the side conference. "Complete transfer" moves the prospect into the
--     side conference (unheld) and the agent back to the main one (empty, ready for the next
--     contact). "Cancel" hangs up the target and moves the agent back, unholding the prospect in
--     place -- the original call resumes exactly where it left off.
-- A failed/never-answered target leg touches NOTHING (per the above, prospect+agent are never
-- disturbed until the target actually answers) -- "returns the prospect to the intern" is
-- satisfied by construction, not by an explicit recovery step.
--
-- The target leg itself is tracked ONLY on `call_transfers.target_call_control_id`, kept OUT of
-- `call_legs` entirely -- the exact same "new real-time participant, dedicated table, not a third
-- `call_legs.kind`" move TASK-T3's own coaching leg made (LANE-eng2.md's own documented history:
-- four prior incidents of a new leg shape silently breaking kind-agnostic dial-loop code).

-- call_legs: HOLD bookkeeping + transfer disposition ---------------------------------------------

alter table public.call_legs
  add column held_at timestamptz,
  add column transferred_to text,
  add column transfer_type text check (transfer_type in ('cold', 'warm'));

comment on column public.call_legs.held_at is
  'AUD-6 + TASK-T4 warm transfer: set while this leg is held (silent) in whichever Telnyx conference it currently sits in. Null when not held. Drives the UI''s "On hold mm:ss" timer.';
comment on column public.call_legs.transferred_to is
  'TASK-T4: the transfer destination once this leg''s call was cold/warm transferred away -- an org member''s user id (text) for a member target, or an E.164 number for an external one. Null until a transfer actually completes.';

-- call_transfers -----------------------------------------------------------------------------------

create table public.call_transfers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  session_id uuid not null references public.dial_sessions(id) on delete cascade,
  contact_leg_id uuid not null references public.call_legs(id) on delete cascade,
  type text not null check (type in ('cold', 'warm')),
  target_kind text not null check (target_kind in ('member', 'external')),
  -- Exactly one of these two is set, matching target_kind -- enforced in application code (the
  -- edge function validates the request shape before insert), not a CHECK here, same choice
  -- `coaching_sessions`' mode/manager_call_control_id pairing already made for a similar
  -- one-of-two-optional-columns shape.
  target_user_id uuid references auth.users(id) on delete set null,
  target_number text,
  target_call_control_id text,
  side_conference_id text,
  status text not null default 'dialing'
    check (status in ('dialing', 'connected', 'completed', 'cancelled', 'failed')),
  -- Nullable + on delete set null (audit-only, same shape as dispositions.dispositioned_by) --
  -- NOT "not null ... on delete set null", a self-contradictory pairing that would fail the
  -- moment the referenced user is ever deleted.
  initiated_by uuid references auth.users(id) on delete set null,
  ended_at timestamptz,
  ended_reason text,
  created_at timestamptz not null default now()
);

-- One active (dialing/connected) transfer per session at a time -- the same TOCTOU-closing shape
-- as coaching_sessions_one_active_per_manager (20260926070000).
create unique index call_transfers_one_active_per_session
  on public.call_transfers (session_id)
  where status in ('dialing', 'connected');

create index idx_call_transfers_session_status on public.call_transfers (session_id, status);
-- Anchors the sweeper's own staleness scan (created_at-based, see reap_stale_call_transfers below).
create index idx_call_transfers_status_created on public.call_transfers (status, created_at);

alter table public.call_transfers enable row level security;

-- Same shape as call_legs' own two SELECT policies (20260924000700): owner/admin see every
-- transfer in their org, an agent sees only their own session's. No INSERT/UPDATE/DELETE policy
-- of any kind -- only the service-role edge function/sweeper ever writes this table.
create policy "owner or admin can view all call_transfers"
  on public.call_transfers for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

create policy "agent can view own call_transfers"
  on public.call_transfers for select
  using (
    private.has_org_role(org_id, array['agent'])
    and private.dial_session_agent_id(call_transfers.session_id) = auth.uid()
  );

revoke all on public.call_transfers from anon;

-- transition_call_transfer: same CAS shape as transition_leg/transition_session
-- (20260924000800) -- every status change checks the expected prior status and is a no-op
-- (never an error) when it doesn't match, so webhook redelivery is harmless by construction.

create function public.transition_call_transfer(
  p_transfer uuid,
  p_org uuid,
  p_expected_statuses text[],
  p_new_status text,
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
  update public.call_transfers
  set
    status = p_new_status,
    target_call_control_id = case when p_fields ? 'target_call_control_id'
      then (p_fields ->> 'target_call_control_id') else target_call_control_id end,
    side_conference_id = case when p_fields ? 'side_conference_id'
      then (p_fields ->> 'side_conference_id') else side_conference_id end,
    ended_at = case when p_fields ? 'ended_at'
      then (p_fields ->> 'ended_at')::timestamptz else ended_at end,
    ended_reason = case when p_fields ? 'ended_reason'
      then (p_fields ->> 'ended_reason') else ended_reason end
  where id = p_transfer and org_id = p_org and status = any(p_expected_statuses)
  returning id into v_id;

  return v_id is not null;
end;
$$;

revoke all on function public.transition_call_transfer(uuid, uuid, text[], text, jsonb) from public, anon, authenticated;
grant execute on function public.transition_call_transfer(uuid, uuid, text[], text, jsonb) to service_role;

-- reap_stale_call_transfers: the sweeper's safety net (dialer-sweeper/index.ts wires this), same
-- "SQL decides + flips state, TS does the best-effort Telnyx cleanup" split as
-- reap_stale_coaching_sessions (20260926070001). Two independent staleness conditions:
--   1. 'dialing' older than p_dialing_after_seconds -- the target leg's own dial timeout/webhook
--      should have resolved this long before; a lost webhook is the only way it's still here.
--   2. 'connected' older than p_connected_hard_cap_seconds -- a warm transfer whose "Complete"/
--      "Cancel" never got clicked (crashed tab) leaves the AGENT stuck in the side conference,
--      unable to take their next contact -- an absolute ceiling, not a webhook-loss case.
-- Both are marked 'failed'/'stale_timeout' here; the caller reads `old_status` (captured BEFORE
-- the update) to decide which cleanup actions are needed -- a 'dialing' row never touched the
-- agent/prospect at all (nothing to unwind beyond hanging up the target leg, if it even has a
-- call_control_id yet), a 'connected' row needs the full warm-transfer unwind (move the agent
-- back to the main conference, unhold the prospect).

create function public.reap_stale_call_transfers(
  p_dialing_after_seconds int,
  p_connected_hard_cap_seconds int
)
returns table (
  id uuid,
  org_id uuid,
  session_id uuid,
  contact_leg_id uuid,
  old_status text,
  target_call_control_id text,
  side_conference_id text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with stale as (
    select
      ct.id, ct.org_id, ct.session_id, ct.contact_leg_id, ct.status as old_status,
      ct.target_call_control_id, ct.side_conference_id
    from public.call_transfers ct
    where
      (ct.status = 'dialing'
        and ct.created_at < now() - make_interval(secs => p_dialing_after_seconds))
      or (ct.status = 'connected'
        and ct.created_at < now() - make_interval(secs => p_connected_hard_cap_seconds))
  ),
  updated as (
    update public.call_transfers ct
    set status = 'failed', ended_at = now(), ended_reason = 'stale_timeout'
    from stale
    where ct.id = stale.id
    returning ct.id
  )
  select s.id, s.org_id, s.session_id, s.contact_leg_id, s.old_status,
    s.target_call_control_id, s.side_conference_id
  from stale s
  join updated u on u.id = s.id;
end;
$$;

revoke all on function public.reap_stale_call_transfers(int, int) from public, anon, authenticated;
grant execute on function public.reap_stale_call_transfers(int, int) to service_role;

-- crm_sync_jobs: a new kind for the GHL transfer note ("Transfers are logged ... in GHL (a note,
-- via the outbox)") -- same drop/re-add-CHECK widening 20260925030000/20260925050000/
-- 20260925070100 already established for this exact column. Payload contract (fixed by the
-- lead): {note_body, transfer_type, call_leg_id} -- eng1's own processing branch in
-- ghl-sync-worker.ts (commit b97ff33, out of this lane's file ownership) posts `note_body` as a
-- GHL contact note; this migration only needs to make the row insertable.

alter table public.crm_sync_jobs drop constraint crm_sync_jobs_kind_check;
alter table public.crm_sync_jobs add constraint crm_sync_jobs_kind_check
  check (kind in (
    'disposition', 'contact_upsert', 'nurture_tag', 'voicemail_tag', 'no_answer_tag',
    'inbound_call_note', 'transfer_note'
  ));

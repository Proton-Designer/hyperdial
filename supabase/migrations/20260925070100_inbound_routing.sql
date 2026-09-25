-- TASK-I1 (MISSION-3): inbound callback routing (INB-1..4, CID-6). Append-only. Depends on
-- TASK-N1's user_phone_numbers.assigned_user_id (20260925070000).
--
-- Design (full reasoning in decisions.md's TASK-I1 entry):
-- - A NEW inbound_calls table, not a repurposed call_legs row: call_legs.session_id/campaign_id
--   are both NOT NULL, deeply assumed by the whole outbound engine -- widening them for the
--   "not in any session" inbound case (the common one) would touch a shared, heavily-relied-on
--   table for an unrelated flow. inbound_calls.dial_session_id (nullable) links it to a session
--   ONLY when the caller was actually bridged into one (the "intern is mid-batch" case).
-- - org_members gains forward_phone_number (the per-user cell fallback) and last_seen_at (a
--   cheap presence heartbeat -- there is no existing server-visible "agent online" signal
--   anywhere in this schema; WebRTC registration status is not queryable without a Telnyx round
--   trip per routing decision).
-- - org_inbound_settings mirrors org_number_pool_settings/org_recording_settings exactly (member
--   read, owner/admin write, seed-on-org-create + backfill).

-- =================================================================================================
-- 1. org_members: presence heartbeat + personal forward number.
-- =================================================================================================

alter table public.org_members
  add column forward_phone_number text,
  add column last_seen_at timestamptz;

-- A member may update ONLY their own row's heartbeat/forward number -- never someone else's
-- (ADM-5's own "an intern can't reassign" spirit: a member's own presence/forward number is
-- self-service, but nobody else's is). The existing org_members table has no client-facing
-- update policy at all today (checked: `20260924000100_create_org_tenancy_tables.sql` only adds
-- select policies), so this is a net-new capability, not a widening of an existing one.
create policy "member can update own heartbeat and forward number"
  on public.org_members for update
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- =================================================================================================
-- 2. org_inbound_settings: the org-level shared fallback destination + editable voicemail
--    greeting. Same shape as org_number_pool_settings (20260925070000) -- member read, owner/
--    admin write, seed-on-org-create + one-time backfill. `{org_name}` in the default greeting is
--    a literal substitution token (there is no org-name column reachable from SQL defaults);
--    the caller substitutes the real org name when building the `speak` payload.
-- =================================================================================================

create table public.org_inbound_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  shared_destination_number text,
  voicemail_greeting_text text not null default 'You''ve reached {org_name}. Please leave a message.',
  updated_at timestamptz not null default now()
);

alter table public.org_inbound_settings enable row level security;

create policy "org members can view inbound settings"
  on public.org_inbound_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert inbound settings"
  on public.org_inbound_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update inbound settings"
  on public.org_inbound_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create function private.seed_default_inbound_settings(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.org_inbound_settings (org_id)
  values (p_org)
  on conflict (org_id) do nothing;
$$;

create function private.seed_default_inbound_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_inbound_settings(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_inbound_settings
  after insert on public.orgs
  for each row execute function private.seed_default_inbound_settings_trigger();

do $$
declare
  v_org record;
begin
  for v_org in select id from public.orgs loop
    perform private.seed_default_inbound_settings(v_org.id);
  end loop;
end;
$$;

-- =================================================================================================
-- 3. inbound_calls: one row per inbound call, from the very first call.initiated through
--    whichever fallback step finally answers it (or exhausts). `state` is the CURRENT in-flight
--    step (a state machine, per the task's own "idempotent under webhook redelivery" ask);
--    `outcome` is the terminal classification (INB-4's exact 4 values), written only once
--    `state` reaches 'ended'.
-- =================================================================================================

create table public.inbound_calls (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  call_control_id text not null unique,
  telnyx_call_leg_id text,
  to_number_id uuid references public.user_phone_numbers(id) on delete set null,
  from_e164 text not null,
  contact_id uuid references public.contacts(id) on delete set null,
  routed_to_user_id uuid references auth.users(id) on delete set null,
  dial_session_id uuid references public.dial_sessions(id) on delete set null,
  state text not null default 'ringing' check (state in (
    'ringing', 'ringing_intern', 'bridging_session', 'ringing_cell', 'ringing_shared',
    'voicemail', 'ended'
  )),
  outcome text check (outcome in ('answered_by_agent', 'forwarded', 'voicemail', 'missed')),
  answered_at timestamptz,
  ended_at timestamptz,
  duration_seconds int check (duration_seconds >= 0),
  recording_status text check (recording_status in (
    'recording', 'saved', 'download_failed', 'recording_failed', 'deleted'
  )),
  recording_path text,
  recording_duration_seconds int check (recording_duration_seconds >= 0),
  recording_telnyx_call_leg_id text,
  ghl_note_queued_at timestamptz,
  created_at timestamptz not null default now()
);

create index idx_inbound_calls_org_id on public.inbound_calls(org_id);
create index idx_inbound_calls_dial_session_id on public.inbound_calls(dial_session_id);
create index idx_inbound_calls_routed_to_user_id on public.inbound_calls(routed_to_user_id);

alter table public.inbound_calls enable row level security;

-- Same shape as call_legs' own RLS (20260924000700): owner/admin see every inbound call in the
-- org; an agent sees only the ones actually routed to them (never someone else's, and never a
-- team-pool call that fell through to the shared line without ever naming an intern). No client
-- write policy at all -- every write is server-side (the webhook/engine), same as call_legs.
create policy "owner or admin can view all inbound_calls"
  on public.inbound_calls for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

create policy "agent can view own routed inbound_calls"
  on public.inbound_calls for select
  using (routed_to_user_id = auth.uid());

grant select, insert, update on public.inbound_calls to service_role;

-- =================================================================================================
-- 4. transition_inbound_call: the state-machine RPC (same CAS-on-expected-states shape as
--    transition_leg/transition_session) -- webhook redelivery replays the same command, and this
--    makes replaying it a no-op instead of double-transferring or double-recording.
-- =================================================================================================

create function public.transition_inbound_call(
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
  v_updated boolean;
begin
  update public.inbound_calls
  set
    state = p_new_state,
    routed_to_user_id = case when p_fields ? 'routed_to_user_id'
      then (p_fields->>'routed_to_user_id')::uuid else routed_to_user_id end,
    dial_session_id = case when p_fields ? 'dial_session_id'
      then (p_fields->>'dial_session_id')::uuid else dial_session_id end,
    contact_id = case when p_fields ? 'contact_id'
      then (p_fields->>'contact_id')::uuid else contact_id end,
    outcome = case when p_fields ? 'outcome' then p_fields->>'outcome' else outcome end,
    answered_at = case when p_fields ? 'answered_at'
      then (p_fields->>'answered_at')::timestamptz else answered_at end,
    ended_at = case when p_fields ? 'ended_at'
      then (p_fields->>'ended_at')::timestamptz else ended_at end,
    duration_seconds = case when p_fields ? 'duration_seconds'
      then (p_fields->>'duration_seconds')::int else duration_seconds end,
    recording_status = case when p_fields ? 'recording_status'
      then p_fields->>'recording_status' else recording_status end,
    recording_path = case when p_fields ? 'recording_path'
      then p_fields->>'recording_path' else recording_path end,
    recording_duration_seconds = case when p_fields ? 'recording_duration_seconds'
      then (p_fields->>'recording_duration_seconds')::int else recording_duration_seconds end,
    recording_telnyx_call_leg_id = case when p_fields ? 'recording_telnyx_call_leg_id'
      then p_fields->>'recording_telnyx_call_leg_id' else recording_telnyx_call_leg_id end,
    ghl_note_queued_at = case when p_fields ? 'ghl_note_queued_at'
      then (p_fields->>'ghl_note_queued_at')::timestamptz else ghl_note_queued_at end
  where call_control_id = p_call_control_id
    and state = any(p_expected_states)
  returning true into v_updated;

  return coalesce(v_updated, false);
end;
$$;

revoke all on function public.transition_inbound_call(text, text[], text, jsonb) from public, anon, authenticated;
grant execute on function public.transition_inbound_call(text, text[], text, jsonb) to service_role;

-- =================================================================================================
-- 5. private.pick_inbound_route: pure routing-target lookup (CID-1's "assigned_user_id, else the
--    org's shared destination" for WHICH number was called; the busy/online/session decision
--    itself needs Telnyx-side state (WebRTC registration is not in this DB) and stays in
--    TypeScript, see _shared/inbound-core.ts). This function answers only "which user_phone_
--    numbers row did the caller reach, and who does it belong to" -- a plain lookup, not
--    reservation-worthy (no cap/rest/concurrency concern the way the dial pool has).
-- =================================================================================================

create function private.pick_inbound_route(p_org_id uuid, p_to_e164 text)
returns table (number_id uuid, assigned_user_id uuid)
language sql
security definer
set search_path = ''
stable
as $$
  -- Deliberately no `status` filter: N1's active/resting/retired distinction only gates who a
  -- number can be picked FOR as an OUTBOUND caller ID (the daily-cap concept). Inbound routing
  -- cares only about who the number is currently assigned to -- a resting (or even retired, if
  -- Telnyx still rings it because it hasn't actually been released from the account) number's
  -- calls still belong to whoever owns it.
  select id, assigned_user_id
  from public.user_phone_numbers
  where org_id = p_org_id and phone_number = p_to_e164
  limit 1;
$$;

create function public.pick_inbound_route(p_org_id uuid, p_to_e164 text)
returns table (number_id uuid, assigned_user_id uuid)
language sql
security definer
set search_path = ''
stable
as $$
  select * from private.pick_inbound_route(p_org_id, p_to_e164);
$$;

revoke all on function private.pick_inbound_route(uuid, text) from public, anon, authenticated;
revoke all on function public.pick_inbound_route(uuid, text) from public, anon, authenticated;
grant execute on function private.pick_inbound_route(uuid, text) to service_role;
grant execute on function public.pick_inbound_route(uuid, text) to service_role;

-- =================================================================================================
-- 6. INB-4's GHL note job: a new crm_sync_jobs kind, reusing the EXISTING enqueue_crm_job/
--    claim_crm_sync_jobs/ghl-sync-worker pipeline (20260924000900/20260925050000) rather than a
--    parallel outbox. `call_leg_id` is documented as an opaque reference (no FK) -- passing
--    inbound_calls.id through it is exactly what that column is for.
-- =================================================================================================

alter table public.crm_sync_jobs drop constraint crm_sync_jobs_kind_check;
alter table public.crm_sync_jobs add constraint crm_sync_jobs_kind_check
  check (kind in (
    'disposition', 'contact_upsert', 'nurture_tag', 'voicemail_tag', 'no_answer_tag',
    'inbound_call_note'
  ));

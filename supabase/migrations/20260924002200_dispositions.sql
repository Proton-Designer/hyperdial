-- TASK-P3-E1 (dispositions backend, design §5): per-org disposition list, seeded for every org;
-- call_legs gains disposition fields; submit_disposition applies the lead effect, propagates DNC,
-- enqueues the GHL push job (P3-P1/P3-P3's outbox), and moves the session wrap_up -> dialing.
--
-- Out of scope here (per the task file and the lead's reassignment note): the mandatory wrap-up
-- form UI lives in apps/web/src/components/dialer/** (eng2/E4's territory) and waits for E4 to
-- land. This migration + the RPC + the Settings editor are the backend E4's future form will call.

-- dispositions ------------------------------------------------------------------------------

create table public.dispositions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  key text not null,
  label text not null,
  -- The five distinct lead-outcome shapes design §5's table actually uses. 'queued' covers both
  -- "Left voicemail" and "No answer (manual)" (same effect, different key/label/ghl_tag).
  lead_effect text not null check (lead_effect in ('completed', 'callback', 'exhausted', 'dnc', 'queued')),
  -- Nullable: "Left voicemail"/"No answer (manual)" have no GHL tag per design §5's table (note-only
  -- or no GHL effect at all). ghl-sync-worker.ts skips the tag-add step when this is null.
  ghl_tag text,
  creates_task boolean not null default false,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, key)
);

create index idx_dispositions_org_id on public.dispositions(org_id);

alter table public.dispositions enable row level security;

-- "members read their org's dispositions; admin+ manage them" (task spec). Read includes
-- inactive rows deliberately -- the Settings editor needs to list/re-enable them, and the
-- wrap-up form filters to active=true client-side (same shape as campaigns_with_stats hiding
-- deleted_at in the view rather than RLS -- TASK-P2-P2's lesson: never make a row invisible to
-- its own admin via the SELECT policy, since that same admin must be able to toggle it back).
create policy "org members can view dispositions"
  on public.dispositions for select
  using (private.is_org_member(org_id));

create policy "admin can insert dispositions"
  on public.dispositions for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "admin can update dispositions"
  on public.dispositions for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "admin can delete dispositions"
  on public.dispositions for delete
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- Seed + trigger ------------------------------------------------------------------------------
-- design §5's default table, verbatim. Shared by the org-creation trigger (new orgs) and a
-- one-time backfill loop below (existing orgs) so there is exactly one place the defaults are
-- defined, not two copies to keep in sync.

create function private.seed_default_dispositions(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.dispositions (org_id, key, label, lead_effect, ghl_tag, creates_task, sort)
  values
    (p_org, 'interested', 'Interested / Meeting booked', 'completed', 'Interested', false, 10),
    (p_org, 'callback', 'Callback', 'callback', 'Callback', true, 20),
    (p_org, 'not_interested', 'Not interested', 'completed', 'Not Interested', false, 30),
    (p_org, 'wrong_number', 'Wrong number', 'exhausted', 'Wrong Number', false, 40),
    (p_org, 'dnc', 'Do not call', 'dnc', 'DNC', false, 50),
    (p_org, 'voicemail', 'Left voicemail', 'queued', null, false, 60),
    (p_org, 'no_answer', 'No answer (manual)', 'queued', null, false, 70)
  on conflict (org_id, key) do nothing;
$$;

create function private.seed_default_dispositions_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_dispositions(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_dispositions
  after insert on public.orgs
  for each row execute function private.seed_default_dispositions_trigger();

do $$
declare r record;
begin
  for r in select id from public.orgs loop
    perform private.seed_default_dispositions(r.id);
  end loop;
end $$;

-- call_legs: disposition fields ----------------------------------------------------------------

alter table public.call_legs
  add column disposition_id uuid references public.dispositions(id) on delete set null,
  add column notes text,
  add column callback_at timestamptz,
  add column dispositioned_by uuid references auth.users(id) on delete set null,
  add column dispositioned_at timestamptz;

-- submit_disposition --------------------------------------------------------------------------
-- Same "service-role-only primitive, called from a thin edge function" shape as claim_leg/
-- transition_leg/transition_session/apply_leg_outcome (TASK-P2-E1/E2) -- NOT the literal 4-arg
-- signature the task file sketched (p_leg, p_disposition, p_notes, p_callback_at), because that
-- sketch implicitly assumes auth.uid()/RLS context, and every other dial-engine write RPC in
-- this schema is called from a service-role Edge Function instead (auth.uid() is null there).
-- This needs p_org + p_caller_user_id for the same reason those do. The caller-identity check
-- ("the leg's agent, or admin+") happens both here (defense in depth, so a direct psql/service-
-- role misuse is still safe) AND in dialer-session-disposition/index.ts (the same "ownership
-- check in TS before calling the RPC" pattern as dialer-session-hangup-live).
--
-- Idempotent on a re-submit: a second call for an already-dispositioned leg updates notes/
-- disposition/callback_at but does NOT re-apply the lead effect a second time (guarded by
-- call_legs.dispositioned_at already being set) -- re-running e.g. "queued +1" would otherwise
-- double-increment attempts. enqueue_crm_job is safe to call unconditionally every time: its own
-- (call_leg_id, kind) unique index (20260924001200) makes the second call a no-op. Known
-- simplification, said plainly: changing the disposition KEY on a re-submit does not undo the
-- first call's lead effect and apply the new one instead -- the first submission's lead effect is
-- permanent. Nothing in the task spec asks for effect-switching, and the wrap-up form is a
-- single-shot mandatory step in the normal flow (a "re-submit" is a retry/network-blip case, not
-- a change-my-mind UI), so this is judged acceptable rather than adding un-asked-for complexity.
create function public.submit_disposition(
  p_leg uuid,
  p_org uuid,
  p_caller_user_id uuid,
  p_disposition text,
  p_notes text,
  p_callback_at timestamptz
)
returns table (session_id uuid, already_submitted boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_leg public.call_legs;
  v_session public.dial_sessions;
  v_disposition public.dispositions;
  v_caller_role text;
  v_effective_callback_at timestamptz;
  v_already boolean;
  v_agent_name text;
begin
  select * into v_leg from public.call_legs where id = p_leg and org_id = p_org;
  if v_leg is null then
    raise exception 'call leg not found for this org';
  end if;

  select * into v_session from public.dial_sessions where id = v_leg.session_id and org_id = p_org;
  if v_session is null then
    raise exception 'dial session not found for this leg';
  end if;

  select role into v_caller_role
  from public.org_members
  where org_id = p_org and user_id = p_caller_user_id and status = 'active';
  if v_caller_role is null then
    raise exception 'caller is not an active member of this org';
  end if;
  if v_caller_role = 'agent' and v_session.agent_id <> p_caller_user_id then
    raise exception 'only the session''s own agent (or an admin) may submit this disposition';
  end if;

  select * into v_disposition
  from public.dispositions
  where org_id = p_org and key = p_disposition and active;
  if v_disposition is null then
    raise exception 'unknown or inactive disposition key: %', p_disposition;
  end if;

  v_effective_callback_at := case when v_disposition.lead_effect = 'callback' then p_callback_at else null end;
  if v_disposition.lead_effect = 'callback' and v_effective_callback_at is null then
    raise exception 'callback_at is required for a callback disposition';
  end if;

  -- Lead's review note (task log, 22:34): the disposition that first writes
  -- campaign_leads.assigned_agent_id must check the assignee is an active member of the lead's
  -- org -- campaign_leads itself has no such check yet. The assignee is always this session's own
  -- agent (never an arbitrary id from the caller), but that agent could have been disabled after
  -- the session started, so re-check membership status fresh here rather than trust the session
  -- row's staleness.
  if v_disposition.lead_effect = 'callback' and not exists (
    select 1 from public.org_members
    where org_id = p_org and user_id = v_session.agent_id and status = 'active'
  ) then
    raise exception 'the session agent is not an active member of this org, so a callback cannot be assigned to them';
  end if;

  v_already := v_leg.dispositioned_at is not null;

  update public.call_legs
  set disposition_id = v_disposition.id,
      notes = p_notes,
      callback_at = v_effective_callback_at,
      dispositioned_by = p_caller_user_id,
      dispositioned_at = coalesce(v_leg.dispositioned_at, now())
  where id = p_leg;

  if not v_already and v_leg.lead_id is not null then
    if v_disposition.lead_effect = 'completed' then
      update public.campaign_leads set status = 'completed', updated_at = now() where id = v_leg.lead_id;
    elsif v_disposition.lead_effect = 'exhausted' then
      update public.campaign_leads set status = 'exhausted', updated_at = now() where id = v_leg.lead_id;
    elsif v_disposition.lead_effect = 'callback' then
      update public.campaign_leads
      set status = 'callback',
          next_attempt_at = v_effective_callback_at,
          assigned_agent_id = v_session.agent_id,
          updated_at = now()
      where id = v_leg.lead_id;
    elsif v_disposition.lead_effect = 'queued' then
      update public.campaign_leads set status = 'queued', attempts = attempts + 1, updated_at = now() where id = v_leg.lead_id;
    end if;
    -- 'dnc' is intentionally not handled per-lead here -- the contact-wide block below covers
    -- the current lead_id too (it's one of "every campaign_leads of that contact").
  end if;

  if not v_already and v_disposition.lead_effect = 'dnc' and v_leg.contact_id is not null then
    update public.contacts set dnc = true, updated_at = now() where id = v_leg.contact_id;
    -- Task spec, verbatim: "every campaign_leads of that contact dnc" -- no carve-out for
    -- already-completed/exhausted rows. DNC is a compliance signal that should override a stale
    -- prior outcome, not the other way around.
    update public.campaign_leads set status = 'dnc', updated_at = now() where contact_id = v_leg.contact_id;
  end if;

  select trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))
  into v_agent_name
  from public.profiles p where p.user_id = v_session.agent_id;

  -- Safe to call unconditionally on a re-submit -- enqueue_crm_job's own (call_leg_id, kind)
  -- dedupe index makes the second call a no-op (returns null), same as every other retry path in
  -- this outbox. recording_url/transcript_excerpt are always null: design §5's Recording/
  -- Transcription feature (Storage bucket, transcript_segments table) doesn't exist yet -- said
  -- plainly, not silently dropped.
  perform public.enqueue_crm_job(
    p_org,
    'disposition',
    v_leg.contact_id,
    p_leg,
    jsonb_build_object(
      'disposition_key', v_disposition.key,
      'disposition_label', v_disposition.label,
      'notes', p_notes,
      'callback_at', v_effective_callback_at,
      'ghl_tag', v_disposition.ghl_tag,
      'creates_task', v_disposition.creates_task,
      -- DispositionPayload.agent_name is a required (non-null) string -- fall back rather than
      -- pass jsonb null, which would decode to TS `null` against that non-nullable field.
      'agent_name', coalesce(nullif(v_agent_name, ''), 'Agent'),
      'duration_seconds', coalesce(v_leg.duration_seconds, 0),
      'recording_url', null,
      'transcript_excerpt', null
    )
  );

  -- Idempotent: transition_session's own expected_states check makes this a safe no-op if the
  -- session already left wrap_up (a re-submit, or the agent hung up and started a new session).
  perform public.transition_session(v_session.id, array['wrap_up'], 'dialing', '{}'::jsonb);

  return query select v_session.id, v_already;
end;
$$;

revoke all on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz) to service_role;

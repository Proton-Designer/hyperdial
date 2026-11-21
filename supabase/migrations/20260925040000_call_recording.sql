-- Call recording (TASK-F-T2, REC-1..6). Timestamp assigned by the lead (20260925040000).
--
-- Telnyx details below were verified against the real spec3.json + webhook-events.json, not
-- assumed from the task's own doc -- two corrections worth flagging up front (full writeup in
-- decisions.md):
--   1. call.recording.saved's real payload has NO call_control_id and NO recording_id field at
--      all -- only call_leg_id/call_session_id (both different UUIDs from call_control_id) and
--      recording_started_at/recording_ended_at (duration is derived from these, not a
--      duration_millis field). The webhook is mapped back to our row via client_state (the
--      existing {org,session,leg} shape, round-tripped through record_start's own client_state
--      param), not callControlId matching -- see _shared/recording-core.ts's header.
--   2. record_start is call-level (channels:'dual'), not conference-level -- confirmed via
--      StartRecordingRequest's own description ("dual: first leg on channel A, the rest on
--      channel B") that a single participant leg's record_start already captures the whole
--      bridge.
--
-- REC-3: the PDF's storage path used {user_id}; this uses {org_id}/{call_leg_id}.mp3 instead --
-- a user has no fixed 1:1 relationship to a recording (whichever agent is on shift), and
-- org+leg is already how every other org-scoped resource in this schema is addressed.

-- call_legs: recording columns -----------------------------------------------------------------

alter table public.call_legs
  add column recording_status text check (recording_status in (
    'recording', 'saved', 'download_failed', 'recording_failed', 'deleted'
  )),
  add column recording_path text,
  add column recording_duration_seconds int check (recording_duration_seconds >= 0),
  -- Telnyx's OWN call_leg_id (never a "recording id" -- the webhook payload has none), kept so
  -- a future manual retry beyond the 10-minute recording_urls window can re-resolve the real
  -- recording resource via GET /recordings?filter[call_leg_id]=.
  add column recording_telnyx_call_leg_id text,
  -- Retention (REC-6) anchors on this, not created_at -- a leg can exist well before its
  -- recording is confirmed saved (ringing/AMD time, or a delayed webhook).
  add column recording_saved_at timestamptz,
  add column recording_deleted_at timestamptz;

-- org_recording_settings ---------------------------------------------------------------------
-- Per-org opt-out (default true). A dedicated small table, not a new `orgs` column (its own
-- UPDATE RLS policy is owner-only, and this needs owner+admin write) and not `org_telephony`
-- (zero client-facing RLS policies by design -- the Telnyx key must never be client-selectable).
-- Same member-read/admin-write shape as dnc_numbers/campaign_retry_rules (TASK-F-T1).

create table public.org_recording_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  recording_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table public.org_recording_settings enable row level security;

create policy "org members can view recording settings"
  on public.org_recording_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert recording settings"
  on public.org_recording_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update recording settings"
  on public.org_recording_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

-- Seed + trigger: same "one function, shared by the org-creation trigger and a one-time
-- backfill" shape as private.seed_default_dispositions (20260924002200).

create function private.seed_default_recording_settings(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.org_recording_settings (org_id, recording_enabled)
  values (p_org, true)
  on conflict (org_id) do nothing;
$$;

create function private.seed_default_recording_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_recording_settings(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_recording_settings
  after insert on public.orgs
  for each row execute function private.seed_default_recording_settings_trigger();

do $$
declare
  v_org record;
begin
  for v_org in select id from public.orgs loop
    perform private.seed_default_recording_settings(v_org.id);
  end loop;
end;
$$;

-- Storage bucket: recordings (private) -----------------------------------------------------
-- No client-facing storage.objects policy at all, for this bucket or any other -- RLS on
-- storage.objects is on by default with zero policies meaning zero access except service_role.
-- Playback goes ONLY through the recording-url Edge Function below (service role, its own
-- auth check). Deliberately not `security_invoker`/RLS-policy-based: this is a deny-everything-
-- by-omission bucket, same "no policy at all" shape org_telephony already uses for its base
-- table.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('recordings', 'recordings', false, 104857600, array['audio/mpeg'])
on conflict (id) do nothing;

-- submit_disposition (create or replace, SAME signature as the live 20260925030000 version):
-- the ONLY change is recording_url, which now points at the app (never a raw signed URL, which
-- expires) instead of the hardcoded null placeholder. A stable link works regardless of whether
-- the recording has finished processing yet by the time the disposition is submitted.

create or replace function public.submit_disposition(
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
  v_max_attempts int;
  v_retry_minutes int;
  v_rule public.campaign_retry_rules;
  v_current_attempts int;
  v_next_status text;
  v_next_attempt_at timestamptz;
  v_schedule record;
  v_contact_tz text;
begin
  select * into v_leg from public.call_legs where id = p_leg and org_id = p_org for update;
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
      perform private.enqueue_nurture_tag_if_exhausted(p_org, v_leg.lead_id, v_leg.contact_id, p_leg);
    elsif v_disposition.lead_effect = 'callback' then
      update public.campaign_leads
      set status = 'callback',
          next_attempt_at = v_effective_callback_at,
          assigned_agent_id = v_session.agent_id,
          updated_at = now()
      where id = v_leg.lead_id;
    elsif v_disposition.lead_effect = 'queued' then
      -- QUE-2: consult this campaign's rule for THIS disposition key (voicemail/no_answer today)
      -- instead of always falling back to the flat retry_interval_minutes -- max_attempts stays
      -- the hard ceiling regardless of what the rule says (a 'retry' rule never overrides it).
      select max_attempts, retry_interval_minutes into v_max_attempts, v_retry_minutes
      from public.campaigns where id = v_leg.campaign_id;
      select attempts into v_current_attempts from public.campaign_leads where id = v_leg.lead_id;
      select timezone into v_contact_tz from public.contacts where id = v_leg.contact_id;
      select * into v_rule from public.campaign_retry_rules
      where campaign_id = v_leg.campaign_id and disposition_key = v_disposition.key;

      if v_current_attempts >= coalesce(v_max_attempts, 3) then
        v_next_status := 'exhausted';
        v_next_attempt_at := null;
      elsif v_rule.id is not null and v_rule.action = 'out' then
        v_next_status := 'exhausted';
        v_next_attempt_at := null;
      elsif v_rule.id is not null and v_rule.action = 'retry' then
        select * into v_schedule
        from private.rotated_retry_schedule(v_leg.time_block, v_contact_tz, greatest(1, v_rule.delay_minutes / 1440));
        v_next_status := 'queued';
        v_next_attempt_at := v_schedule.next_attempt_at;
      else
        v_next_status := 'queued';
        v_next_attempt_at := now() + make_interval(mins => coalesce(v_retry_minutes, 120));
      end if;

      update public.campaign_leads cl
      set status = v_next_status, next_attempt_at = v_next_attempt_at, priority_requeue = false, updated_at = now()
      where cl.id = v_leg.lead_id;

      perform private.enqueue_nurture_tag_if_exhausted(p_org, v_leg.lead_id, v_leg.contact_id, p_leg);
    end if;
  end if;

  if not v_already and v_disposition.lead_effect = 'dnc' and v_leg.contact_id is not null then
    update public.contacts set dnc = true, updated_at = now() where id = v_leg.contact_id;
    update public.campaign_leads set status = 'dnc', updated_at = now() where contact_id = v_leg.contact_id;
    -- DSP-6/QUE-7: the global DNC table, not just this one contact's flag.
    insert into public.dnc_numbers (org_id, e164, source, added_by, note)
    select p_org, ct.phone_number, 'disposition', p_caller_user_id, 'via disposition: ' || v_disposition.label
    from public.contacts ct
    where ct.id = v_leg.contact_id and ct.phone_number is not null
    on conflict (org_id, e164) do nothing;
  end if;

  select trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))
  into v_agent_name
  from public.profiles p where p.user_id = v_session.agent_id;

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
      'agent_name', coalesce(nullif(v_agent_name, ''), 'Agent'),
      'duration_seconds', coalesce(v_leg.duration_seconds, 0),
      -- TASK-F-T2 (REC-5): a stable app link, not a raw signed URL (expires in 10 minutes) --
      -- works regardless of whether the recording has finished processing by the time this
      -- disposition is submitted. Hardcoded host: Stage 1 is a single deployment, no per-org
      -- custom domain yet -- revisit if that changes.
      'recording_url', 'https://hyperdial.myhomebasesolutions.com/contacts?leg=' || p_leg::text,
      'transcript_excerpt', null
    )
  );

  perform public.transition_session(v_session.id, array['wrap_up'], 'dialing', '{}'::jsonb);

  return query select v_session.id, v_already;
end;
$$;

revoke all on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz) to service_role;

-- pg_cron + pg_net: recording-retention, daily at 03:17 -------------------------------------
-- Same shared-secret shape as ghl-sync-worker/dialer-sweeper (20260924002000/20260924001700):
-- global config, a Vault-stored secret checked via X-Cron-Secret, a silent no-op until
-- private.set_recording_retention_config(url, secret) is called (fresh installs never error
-- every tick). Deletion is delegated to the recording-retention Edge Function (service-role
-- Storage API call, which reliably removes the physical object) rather than a raw SQL DELETE
-- FROM storage.objects -- unverified live whether that alone actually removes the underlying
-- file versus just the metadata row, and this cron-worker pattern is already proven twice.

create table private.recording_retention_config (
  id boolean primary key default true,
  url text,
  secret_secret_id uuid,
  constraint recording_retention_config_singleton check (id)
);

create function private.set_recording_retention_config(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select secret_secret_id into v_existing_secret_id from private.recording_retention_config where id = true;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret);
  end if;

  insert into private.recording_retention_config (id, url, secret_secret_id)
  values (true, p_url, v_secret_id)
  on conflict (id) do update set url = excluded.url, secret_secret_id = excluded.secret_secret_id;
end;
$$;

revoke all on function private.set_recording_retention_config(text, text) from public;
grant execute on function private.set_recording_retention_config(text, text) to service_role, postgres;

create function private.trigger_recording_retention()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret_id uuid;
  v_secret text;
begin
  select url, secret_secret_id into v_url, v_secret_id from private.recording_retention_config where id = true;

  if v_url is null or v_secret_id is null then
    return; -- not configured yet (fresh install) -- no-op, not an error every tick.
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    return;
  end if;

  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
    timeout_milliseconds := 20000
  );
end;
$$;

-- Explicit, not assumed already enabled (TASK-P3-P3's own fix-forward lesson).
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('recording-retention', '17 3 * * *', $$select private.trigger_recording_retention();$$);

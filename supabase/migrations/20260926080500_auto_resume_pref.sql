-- MISSION-4 TASK-T7 (auto-resume piece): after saving a disposition, the next batch should start
-- automatically after a per-user N-second delay (0/5/10/15; 0 = manual, no timer at all), with a
-- visible countdown + Cancel in the UI. `submit_disposition` (20260925060000_dispositions_v2.sql)
-- currently ALWAYS transitions wrap_up -> dialing unconditionally, in its own last line -- there
-- is no existing pause/manual-resume concept for this path at all today.
--
-- Backward-compat / "ships disabled by default" (CLAUDE.md's own rule for new automatic
-- behaviour): a user with NO row in `user_preferences`, or an explicit NULL
-- `auto_resume_seconds`, gets the EXACT prior behaviour -- immediate transition straight to
-- `dialing`, no pause, nothing new happens. Only once a user has explicitly picked a value
-- (including the literal `0`, which means "manual: pause and wait for me to click Resume, no
-- timer") does this new pause-then-resume flow engage for THEIR sessions. This is a one-line,
-- surgical change to `submit_disposition`'s own final `perform` -- nothing else in that function
-- (the lead-effect/CRM-sync/DNC logic above it) is touched at all.
--
-- The actual resume call (client-side countdown expiring, or the agent clicking Resume/pressing
-- Space) already has a working endpoint: `resumeToDialing` (_shared/dialer-engine.ts, wired to
-- `dialer-session-resume/index.ts`) already accepts `paused` as a valid starting state (built for
-- exactly this future caller, per that file's own header comment) and already calls
-- `refillSession` after flipping the state -- no new RPC/edge function needed for the resume half,
-- only for reading the session back into `dialing` at the right moment.
--
-- pause_reason = 'post_wrapup' (a new, distinct reason string -- `pause_reason` has no CHECK
-- constraint, see 20260925070000_number_pool.sql) lets the UI distinguish "paused because a
-- disposition was just saved" from a manual pause or `no_numbers_available`, without changing the
-- `paused` state itself or any other pause-reason's own handling.

alter table public.user_preferences
  add column auto_resume_seconds int check (auto_resume_seconds in (0, 5, 10, 15));

comment on column public.user_preferences.auto_resume_seconds is
  'MISSION-4 TASK-T7: per-user wrap-up auto-resume delay in seconds (0/5/10/15; 0 = manual, no
  timer). NULL (the default -- no row, or never set) means the OLD behaviour: submit_disposition
  transitions straight to dialing, no pause at all. Read by submit_disposition, keyed on the
  SESSION''S OWN AGENT (v_session.agent_id), not the submitting caller -- an owner/admin
  submitting on an agent''s behalf still follows that agent''s own pacing preference.';

create or replace function public.submit_disposition(
  p_leg uuid,
  p_org uuid,
  p_caller_user_id uuid,
  p_disposition text,
  p_notes text,
  p_callback_at timestamptz,
  p_license_number text default null,
  p_zips text[] default null
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
  v_license_number text;
  v_zips text[];
  v_auto_resume_seconds int;
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

  -- DSP-4: generic required_fields check, server-side (defense in depth -- the modal validates
  -- this too, but a direct service-role/psql call must not be able to skip it).
  v_license_number := nullif(trim(coalesce(p_license_number, '')), '');
  v_zips := case when p_zips is null or cardinality(p_zips) = 0 then null else p_zips end;
  if v_disposition.required_fields is not null then
    if 'license_number' = any(v_disposition.required_fields) and v_license_number is null then
      raise exception 'license_number is required for disposition: %', v_disposition.key;
    end if;
    if 'zips' = any(v_disposition.required_fields) and v_zips is null then
      raise exception 'zips is required for disposition: %', v_disposition.key;
    end if;
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
      dispositioned_at = coalesce(v_leg.dispositioned_at, now()),
      license_number = coalesce(v_license_number, v_leg.license_number),
      zips = coalesce(v_zips, v_leg.zips)
  where id = p_leg;

  -- DSP-1: also copy onto the contact (jsonb merge, never clobbers other custom_fields keys).
  -- Guarded by "not v_already" like every other lead-effect write below -- a re-submit doesn't
  -- re-derive this.
  if not v_already and v_leg.contact_id is not null and (v_license_number is not null or v_zips is not null) then
    update public.contacts
    set custom_fields = custom_fields
      || case when v_license_number is not null then jsonb_build_object('license_number', v_license_number) else '{}'::jsonb end
      || case when v_zips is not null then jsonb_build_object('zips', to_jsonb(v_zips)) else '{}'::jsonb end,
      updated_at = now()
    where id = v_leg.contact_id;
  end if;

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
      'recording_url', 'https://hyperdial.myhomebasesolutions.com/contacts?leg=' || p_leg::text,
      'transcript_excerpt', null,
      -- TASK-F-P1: carried now, F-P2 maps them to GHL custom fields later.
      'license_number', v_license_number,
      'zips', case when v_zips is null then null else to_jsonb(v_zips) end,
      -- Derived from lead_effect, never the key string -- an org's DNC disposition can be
      -- 'dnc' (legacy) or 'do_not_call' (new canonical) or any future custom key; ghl-sync-
      -- worker.ts must not special-case a specific key name to decide whether to set DND.
      'is_dnc', v_disposition.lead_effect = 'dnc'
    )
  );

  -- MISSION-4 TASK-T7 (auto-resume): the ONLY change from the prior version of this function --
  -- everything above is byte-for-byte identical to 20260925060000_dispositions_v2.sql's own body.
  -- NULL preference (no row, or never configured) = old behaviour, unconditionally. A configured
  -- preference (including literal 0 = manual) pauses instead; the client decides whether to show
  -- a countdown (5/10/15) or a bare manual Resume button (0), and either calls
  -- dialer-session-resume (resumeToDialing already accepts 'paused', see this migration's own
  -- header) when the countdown lapses or the agent clicks/presses Resume.
  select auto_resume_seconds into v_auto_resume_seconds
  from public.user_preferences
  where user_id = v_session.agent_id;

  if v_auto_resume_seconds is null then
    perform public.transition_session(v_session.id, array['wrap_up'], 'dialing', '{}'::jsonb);
  else
    perform public.transition_session(
      v_session.id, array['wrap_up'], 'paused',
      jsonb_build_object('pause_reason', 'post_wrapup')
    );
  end if;

  return query select v_session.id, v_already;
end;
$$;

-- CREATE OR REPLACE preserves an existing function's ACL (same signature) -- these two lines are
-- defensive/redundant, not strictly required, kept so a reviewer never has to just trust that.
revoke all on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz, text, text[]) from public, anon, authenticated;
grant execute on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz, text, text[]) to service_role;

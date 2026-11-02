-- TASK-H09: "Callback time" at wrap-up is optional. submit_disposition (same 9-arg signature) = 20261019203749 body with:
--  * the "callback_at is required for a callback disposition" exception removed;
--  * a callback disposition WITH a time is unchanged (lead -> 'callback', next_attempt_at = that time, assigned to the session agent);
--  * a callback disposition with NO time takes the 'queued' branch: the campaign's retry rule / retry_interval_minutes /
--    max_attempts decide next_attempt_at, as for a no-answer. call_legs.callback_at stays null; the CRM job carries callback_at null.

create or replace function public.submit_disposition(
  p_leg uuid,
  p_org uuid,
  p_caller_user_id uuid,
  p_disposition text,
  p_notes text,
  p_callback_at timestamptz,
  p_license_number text default null,
  p_zips text[] default null,
  p_top_objection text default null
)
returns table (
  session_id uuid,
  already_submitted boolean,
  remote_stop_applied boolean,
  remote_stop_requested_by uuid
)
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
  v_top_objection text;
  v_auto_resume_seconds int;
  v_remote_stop_applied boolean := false;
  v_remote_stop_requested_by uuid;
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
  -- TASK-H09: callback time is optional. With none, the lead is rescheduled by the campaign's own retry rule (the
  -- 'queued' branch below), exactly as a no-answer would be. (A disposition that lists 'callback_at' in
  -- required_fields still demands it, in the quality-check trigger on call_legs.)

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

  -- TASK-G13: optional per-call top objection (same 6 keys as the shift survey's top_objection);
  -- blank = none, anything else not in the list is rejected.
  v_top_objection := nullif(btrim(coalesce(p_top_objection, '')), '');
  if v_top_objection is not null
     and v_top_objection not in ('too_busy', 'enough_work', 'fees', 'dont_trust_apps', 'not_interested_app_jobs', 'other') then
    raise exception 'invalid top_objection: %', v_top_objection;
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
      zips = coalesce(v_zips, v_leg.zips),
      top_objection = coalesce(v_top_objection, v_leg.top_objection)
  where id = p_leg;

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
    elsif v_disposition.lead_effect = 'callback' and v_effective_callback_at is not null then
      update public.campaign_leads
      set status = 'callback',
          next_attempt_at = v_effective_callback_at,
          assigned_agent_id = v_session.agent_id,
          updated_at = now()
      where id = v_leg.lead_id;
    elsif v_disposition.lead_effect = 'queued' or v_disposition.lead_effect = 'callback' then
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

      -- campaign_leads.next_attempt_at is NOT NULL: an exhausted lead keeps its old value (it is never dialed
      -- again). Writing the null crashed every 'queued'/'callback' wrap-up on a lead's last attempt (found
      -- 2026-11-01 by the H09 test; latent on prod, where no lead had reached max_attempts yet).
      update public.campaign_leads cl
      set status = v_next_status, next_attempt_at = coalesce(v_next_attempt_at, cl.next_attempt_at),
          priority_requeue = false, updated_at = now()
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
      'license_number', v_license_number,
      'zips', case when v_zips is null then null else to_jsonb(v_zips) end,
      'top_objection', coalesce(v_top_objection, v_leg.top_objection),
      'is_dnc', v_disposition.lead_effect = 'dnc'
    )
  );

  -- TASK-G21 (G13 review SHOULD): re-submitting a disposition only to ADD a top objection never reached GHL --
  -- the disposition job is unique per (call_leg_id, kind) and its payload was fixed at the first submit. Queue
  -- one small 'objection_field' job (just the custom field) when a re-submit newly sets/changes the objection.
  -- One per leg: a second later change to the objection is not re-pushed (the unique key); enqueue is a no-op
  -- when GHL is not connected.
  if v_already and v_top_objection is not null
     and v_leg.top_objection is distinct from v_top_objection then
    perform public.enqueue_crm_job(
      p_org, 'objection_field', v_leg.contact_id, p_leg,
      jsonb_build_object('top_objection', v_top_objection)
    );
  end if;

  -- MISSION-5 TASK-M5-B2: takes priority over auto-resume -- a manager's own "end this session"
  -- request outranks the agent's per-user pacing preference. Only ever true here because a
  -- remote end that DIDN'T land mid-call already stopped the session synchronously (dialer-
  -- session-stop's own defer branch) and never gets here at all -- this is exactly, and only,
  -- the "was mid-call when asked" case.
  if v_session.remote_stop_requested_at is not null then
    perform public.transition_session(
      v_session.id, array['wrap_up'], 'stopped',
      jsonb_build_object('ended_at', now(), 'pause_reason', 'remote_end_by_manager')
    );
    update public.dial_sessions
    set remote_stop_requested_at = null, remote_stop_requested_by = null
    where id = v_session.id;
    v_remote_stop_applied := true;
    v_remote_stop_requested_by := v_session.remote_stop_requested_by;
  else
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
  end if;

  return query select v_session.id, v_already, v_remote_stop_applied, v_remote_stop_requested_by;
end;
$$;

revoke all on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz, text, text[], text) from public, anon, authenticated;
grant execute on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz, text, text[], text) to service_role;

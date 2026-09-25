-- TASK-F-P1: Dispositions v2 (DSP-1, DSP-2, DSP-4, DSP-9) + "Wins today" + B1-009.
--
-- DSP-2 disposition-key naming: this build's real seeded set (TASK-P3-E1) was a simpler 7-key
-- set (interested/callback/not_interested/wrong_number/dnc/voicemail/no_answer) that TASK-F-T1's
-- own decision record (.brain/memory/decisions.md, "campaign_retry_rules is seeded against this
-- build's REAL disposition keys, not QUE-2's literal PDF names") deliberately left un-renamed,
-- with an explicit note: "if gatekeeper/already_on_platform are ever added to the seeded set,
-- they'll silently start participating in retry-rule lookups... this was already designed for
-- that." This migration is that follow-up: the canonical seeded set for NEW orgs becomes the
-- full 9-key PDF set (yes_build_profile/callback/not_interested/already_on_platform/
-- wrong_number/gatekeeper/do_not_call/voicemail_left/no_answer). For EXISTING orgs, per the task's
-- own instruction ("ADD the missing keys... without removing their custom ones"), this is
-- INSERT-only against the new key names -- an existing org's 'interested'/'dnc'/'voicemail' rows
-- (possibly already relabeled/re-tagged by that org) are left exactly as they are, and the new
-- canonical keys are added alongside. An admin can deactivate whichever set they don't want via
-- the existing Settings editor. Same story for campaign_retry_rules against the new key names.

-- dispositions: is_win + required_fields -----------------------------------------------------

alter table public.dispositions
  add column is_win boolean not null default false,
  -- A generic "this disposition needs these extra fields before it can be submitted" config
  -- (DSP-4), enforced both client-side (WrapUpModal) and server-side (submit_disposition below).
  -- Only two field names are actually wired up today: 'license_number' and 'zips'. Deliberately a
  -- flat text[] of field names, not a jsonb schema -- nothing in this task asks for more than
  -- "is this field present or not" per disposition.
  add column required_fields text[];

-- call_legs: DSP-1's per-call fields -----------------------------------------------------------

alter table public.call_legs
  add column license_number text,
  add column zips text[];

-- contacts: DSP-1's "also copy to contacts.custom_fields" -------------------------------------

alter table public.contacts
  add column custom_fields jsonb not null default '{}'::jsonb;

-- seed_default_dispositions: new canonical 9-key set for NEW orgs -----------------------------

create or replace function private.seed_default_dispositions(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.dispositions
    (org_id, key, label, lead_effect, ghl_tag, creates_task, sort, is_win, required_fields)
  values
    (p_org, 'yes_build_profile', 'Yes - Build Profile', 'completed', 'Interested', false, 10,
      true, array['license_number', 'zips']),
    (p_org, 'callback', 'Callback', 'callback', 'Callback', true, 20, false, null),
    (p_org, 'not_interested', 'Not interested', 'completed', 'Not Interested', false, 30, false, null),
    (p_org, 'already_on_platform', 'Already on platform', 'exhausted', 'Already On Platform', false, 40, false, null),
    (p_org, 'wrong_number', 'Wrong number', 'exhausted', 'Wrong Number', false, 50, false, null),
    -- 'queued' (retry), same as no_answer/voicemail_left -- couldn't get past a screener this
    -- attempt, worth trying again rather than treating as a dead end. Judgment call, not from the
    -- PDF (which only names the key, not its retry behavior); documented in decisions.md.
    (p_org, 'gatekeeper', 'Gatekeeper', 'queued', null, false, 60, false, null),
    (p_org, 'do_not_call', 'Do not call', 'dnc', 'DNC', false, 70, false, null),
    (p_org, 'voicemail_left', 'Left voicemail', 'queued', null, false, 80, false, null),
    (p_org, 'no_answer', 'No answer (manual)', 'queued', null, false, 90, false, null)
  on conflict (org_id, key) do nothing;
$$;

-- Existing orgs: add the missing (new-named) keys, touch nothing already there.
do $$
declare r record;
begin
  for r in select id from public.orgs loop
    perform private.seed_default_dispositions(r.id);
  end loop;
end $$;

-- seed_default_campaign_retry_rules: mapped onto the new key names ----------------------------
-- (QUE-2's own retry/out shape is unchanged -- only the disposition_key values move to match the
-- renamed/added dispositions above. 'gatekeeper' gets the same rotate-block retry cadence as
-- no_answer/voicemail_left, matching its lead_effect='queued' above.)

create or replace function private.seed_default_campaign_retry_rules(p_campaign uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.campaign_retry_rules (campaign_id, disposition_key, action, delay_minutes, rotate_block)
  values
    (p_campaign, 'no_answer', 'retry', 5760, true),
    (p_campaign, 'voicemail_left', 'retry', 5760, true),
    (p_campaign, 'gatekeeper', 'retry', 5760, true),
    (p_campaign, 'callback', 'exact_time', null, false),
    (p_campaign, 'yes_build_profile', 'out', null, false),
    (p_campaign, 'not_interested', 'out', null, false),
    (p_campaign, 'already_on_platform', 'out', null, false),
    (p_campaign, 'wrong_number', 'out', null, false),
    (p_campaign, 'do_not_call', 'out', null, false)
  on conflict (campaign_id, disposition_key) do nothing;
$$;

do $$
declare r record;
begin
  for r in select id from public.campaigns loop
    perform private.seed_default_campaign_retry_rules(r.id);
  end loop;
end $$;

-- submit_disposition: signature change (adds p_license_number/p_zips), so the OLD 6-arg overload
-- is dropped explicitly first -- "create or replace" with a different arg list would otherwise
-- leave BOTH overloads live (the task's own "never leave an overload ambiguity" instruction).
-- Same body as the live 20260925040000 version, plus: required_fields validation (DSP-4), writing
-- license_number/zips onto the leg (DSP-1), copying them into contacts.custom_fields (DSP-1,
-- merged via ||, never overwriting other keys already there), carrying them in the GHL job
-- payload (per the task's own Notes), and is_dnc (derived from lead_effect, not the key string --
-- see the ghl-sync-worker.ts fix in this same commit for why).

drop function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz);

create function public.submit_disposition(
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

  perform public.transition_session(v_session.id, array['wrap_up'], 'dialing', '{}'::jsonb);

  return query select v_session.id, v_already;
end;
$$;

revoke all on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz, text, text[]) from public, anon, authenticated;
grant execute on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz, text, text[]) to service_role;

-- contact_disposition_history (DSP-9) ----------------------------------------------------------
-- Cross-agent read: "the modal shows the last 3 dispositions + notes for this contact" means
-- whichever agent worked this contact before, not just the caller's own sessions -- but
-- call_legs' own RLS ("agent can view own call_legs") scopes an agent to legs from their OWN
-- sessions only. Rather than loosen that RLS policy org-wide (a bigger blast radius than this
-- narrow need), a SECURITY DEFINER function callable directly by any authenticated org member --
-- same "front door read" shape as team-performance -- checks org membership itself and returns
-- only the 3 fields the modal needs, not the whole call_legs row.
create function public.contact_disposition_history(p_contact_id uuid)
returns table (
  leg_id uuid,
  dispositioned_at timestamptz,
  agent_name text,
  disposition_label text,
  notes text,
  has_recording boolean
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    cl.id,
    cl.dispositioned_at,
    trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')),
    d.label,
    cl.notes,
    cl.recording_path is not null
  from public.call_legs cl
  join public.contacts c on c.id = cl.contact_id
  left join public.dispositions d on d.id = cl.disposition_id
  left join public.profiles p on p.user_id = cl.dispositioned_by
  where cl.contact_id = p_contact_id
    and cl.dispositioned_at is not null
    and private.is_org_member(c.org_id)
  order by cl.dispositioned_at desc
  limit 3;
$$;

grant execute on function public.contact_disposition_history(uuid) to authenticated;

-- call_leg_analytics: append is_win (Wins today's StatCard) -----------------------------------
-- create or replace view can only APPEND columns, never reorder/remove -- every existing column
-- stays in the same position, is_win is new at the end.

create or replace view public.call_leg_analytics with (security_invoker = on) as
select
  cl.id as leg_id,
  cl.org_id,
  cl.session_id,
  ds.agent_id,
  cl.campaign_id,
  cl.contact_id,
  cl.state,
  cl.outcome,
  (cl.outcome = 'connected') as is_connected,
  cl.duration_seconds,
  cl.disposition_id,
  d.key as disposition_key,
  d.label as disposition_label,
  cl.created_at,
  cl.answered_at,
  cl.ended_at,
  coalesce(d.is_win, false) as is_win
from public.call_legs cl
join public.dial_sessions ds on ds.id = cl.session_id
left join public.dispositions d on d.id = cl.disposition_id
where cl.kind = 'contact';

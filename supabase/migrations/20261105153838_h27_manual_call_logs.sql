-- TASK-H27: a server record and an outcome for calls made OUTSIDE a dial session (manual dial, or an inbound call answered
-- from the banner). Today they leave nothing behind. This migration adds the table, three RPCs and the RLS; the web calls the
-- RPCs (no direct client writes). Deliberately NOT part of call_leg_analytics, the Dashboard or the shift KPIs.
--
--  public.manual_call_logs                 one row per call, written only by the RPCs below (security definer)
--  public.record_manual_call(...)          when a call ends (answered or not); idempotent on (user, client_key)
--  public.set_manual_call_outcome(...)     outcome (an active disposition key) + notes on your OWN row (owner/admin: any row)
--  public.list_contact_manual_calls(...)   the contact's manual calls for "Previous calls" (same visibility as the table)
--
-- Outcome effects mirror submit_disposition (20261101195022) and run only when the caller has contact_read_access to the
-- contact (owner/admin always, an agent with campaign access, a manager in scope):
--   dnc        contacts.dnc = true, that contact's campaign_leads -> 'dnc'; the number is ALWAYS added to dnc_numbers (it only
--              ever blocks calls), even without contact access. The contacts trigger also queues the GHL DNC flag.
--   completed / exhausted   the contact's 'queued' or 'callback' leads take that status (nobody re-dials them).
--   queued / callback       no lead change (a manual call has no lead of its own; no callback time is asked here).
-- Effects are applied once per effect: re-saving the same outcome re-applies nothing; DNC is never undone by a later save.
-- Dispositions with required_fields (e.g. "Yes - Build Profile": license, zips) are refused: those details exist only in a
-- session wrap-up (use Log close for a closed pro). GHL: one 'disposition' job per call (call_leg_id = the log id, an opaque
-- id with no FK, so the job is deduplicated) when a readable contact exists and GHL is connected; it carries no recording.

create table public.manual_call_logs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  contact_id uuid references public.contacts(id) on delete set null,
  phone text not null check (phone ~ '^\+[0-9]{10,15}$'),
  direction text not null check (direction in ('outbound', 'inbound')),
  answered boolean not null,
  started_at timestamptz not null,
  ended_at timestamptz,
  duration_seconds integer check (duration_seconds is null or duration_seconds between 0 and 86400),
  disposition_id uuid references public.dispositions(id) on delete set null,
  notes text check (notes is null or char_length(notes) <= 2000),
  client_key text not null check (char_length(client_key) between 8 and 80),
  applied_effect text check (applied_effect is null or applied_effect in ('dnc', 'completed', 'exhausted')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, client_key)
);

create index manual_call_logs_org_started_idx on public.manual_call_logs (org_id, started_at desc);
create index manual_call_logs_contact_idx on public.manual_call_logs (contact_id) where contact_id is not null;
create index manual_call_logs_phone_idx on public.manual_call_logs (org_id, phone);
create index manual_call_logs_user_started_idx on public.manual_call_logs (user_id, started_at desc);

alter table public.manual_call_logs enable row level security;
revoke all on table public.manual_call_logs from public, anon, authenticated;
grant select on table public.manual_call_logs to authenticated;

create policy "own rows, owner/admin all, manager by pod"
  on public.manual_call_logs for select to authenticated
  using (
    user_id = auth.uid()
    or private.has_org_role(org_id, array['owner', 'admin'])
    or (private.has_org_role(org_id, array['manager']) and private.is_agent_in_callers_pod_scope(org_id, user_id))
  );

-- ---- record_manual_call ---------------------------------------------------------------------------------------------
create or replace function public.record_manual_call(
  p_org_id uuid,
  p_client_key text,
  p_phone text,
  p_direction text,
  p_answered boolean,
  p_started_at timestamptz,
  p_ended_at timestamptz default null,
  p_duration_seconds integer default null
)
returns table (id uuid, contact_id uuid, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_digits text;
  v_phone text;
  v_contact uuid;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_org_id is null or not private.has_org_role(p_org_id, array['owner', 'admin', 'manager', 'agent']) then
    raise exception 'not allowed to record calls in this organization' using errcode = '42501';
  end if;
  if p_client_key is null or char_length(p_client_key) not between 8 and 80 then
    raise exception 'client key is required (8-80 characters)' using errcode = '22023';
  end if;
  if p_direction is null or p_direction not in ('outbound', 'inbound') then
    raise exception 'direction must be outbound or inbound' using errcode = '22023';
  end if;
  if p_answered is null or p_started_at is null then
    raise exception 'answered and started_at are required' using errcode = '22023';
  end if;
  if p_started_at < now() - interval '2 days' or p_started_at > now() + interval '5 minutes' then
    raise exception 'started_at is out of range' using errcode = '22023';
  end if;
  if p_ended_at is not null and p_ended_at < p_started_at then
    raise exception 'ended_at is before started_at' using errcode = '22023';
  end if;
  if p_duration_seconds is not null and p_duration_seconds not between 0 and 86400 then
    raise exception 'duration is not valid' using errcode = '22023';
  end if;
  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if length(v_digits) = 10 then
    v_phone := '+1' || v_digits;
  elsif length(v_digits) between 11 and 15 then
    v_phone := '+' || v_digits;
  else
    raise exception 'phone number is not valid' using errcode = '22023';
  end if;

  -- idempotent retry: the same (user, client_key) returns the existing row and writes nothing
  select l.id, l.contact_id into v_id, v_contact
  from public.manual_call_logs l where l.user_id = v_uid and l.client_key = p_client_key;
  if v_id is not null then
    return query select v_id, case when v_contact is not null and private.contact_read_access(p_org_id, v_contact) then v_contact end, false;
    return;
  end if;

  -- the contact, only if the caller may read it (never reveal someone else's contact)
  select c.id into v_contact
  from public.contacts c
  where c.org_id = p_org_id and c.phone_number = v_phone and private.contact_read_access(p_org_id, c.id)
  order by c.created_at, c.id
  limit 1;

  insert into public.manual_call_logs (org_id, user_id, contact_id, phone, direction, answered, started_at, ended_at,
                                       duration_seconds, client_key)
  values (p_org_id, v_uid, v_contact, v_phone, p_direction, p_answered, p_started_at, p_ended_at,
          p_duration_seconds, p_client_key)
  on conflict (user_id, client_key) do nothing
  returning manual_call_logs.id into v_id;

  if v_id is null then  -- a concurrent retry won the insert
    select l.id, l.contact_id into v_id, v_contact
    from public.manual_call_logs l where l.user_id = v_uid and l.client_key = p_client_key;
    return query select v_id, case when v_contact is not null and private.contact_read_access(p_org_id, v_contact) then v_contact end, false;
    return;
  end if;
  return query select v_id, v_contact, true;
end;
$$;

revoke all on function public.record_manual_call(uuid, text, text, text, boolean, timestamptz, timestamptz, integer) from public, anon;
grant execute on function public.record_manual_call(uuid, text, text, text, boolean, timestamptz, timestamptz, integer) to authenticated;

-- ---- set_manual_call_outcome ----------------------------------------------------------------------------------------
create or replace function public.set_manual_call_outcome(
  p_id uuid,
  p_disposition text,
  p_notes text default null
)
returns table (id uuid, disposition_key text, effect text, contact_effect text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := auth.uid();
  v_log public.manual_call_logs;
  v_disp public.dispositions;
  v_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  v_contact uuid;
  v_can boolean := false;
  v_effect text := null;
  v_applied text;
  v_contact_effect text := 'none';
  v_agent_name text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select * into v_log from public.manual_call_logs l where l.id = p_id for update;
  if v_log.id is null then
    raise exception 'call not found' using errcode = 'P0002';
  end if;
  if not private.has_org_role(v_log.org_id, array['owner', 'admin', 'manager', 'agent']) then
    raise exception 'not allowed in this organization' using errcode = '42501';
  end if;
  if v_log.user_id <> v_uid and not private.has_org_role(v_log.org_id, array['owner', 'admin']) then
    raise exception 'you can only set the outcome of your own calls' using errcode = '42501';
  end if;
  if v_notes is not null and char_length(v_notes) > 2000 then
    raise exception 'notes are too long (2000 characters max)' using errcode = '22023';
  end if;
  if p_disposition is null and v_notes is null then
    raise exception 'choose an outcome or write a note' using errcode = '22023';
  end if;

  if p_disposition is not null then
    select * into v_disp from public.dispositions d
    where d.org_id = v_log.org_id and d.key = p_disposition and d.active;
    if v_disp.id is null then
      raise exception 'unknown or inactive outcome: %', p_disposition using errcode = '22023';
    end if;
    if v_disp.required_fields is not null and cardinality(v_disp.required_fields) > 0 then
      raise exception 'This outcome needs details that are only collected in a dial session. Use Log close for a closed pro.' using errcode = '22023';
    end if;
  end if;

  -- the contact: the one recorded, or (a contact created since) one found by phone; effects only if the caller may read it
  v_contact := v_log.contact_id;
  if v_contact is null then
    select c.id into v_contact from public.contacts c
    where c.org_id = v_log.org_id and c.phone_number = v_log.phone
    order by c.created_at, c.id limit 1;
  end if;
  if v_contact is not null then
    v_can := private.contact_read_access(v_log.org_id, v_contact);
  end if;
  if v_log.contact_id is null and v_can then
    update public.manual_call_logs set contact_id = v_contact where id = v_log.id;
  end if;

  v_applied := v_log.applied_effect;
  if v_disp.id is not null then
    v_effect := case when v_disp.lead_effect in ('dnc', 'completed', 'exhausted') then v_disp.lead_effect end;
    -- once per effect; DNC is never downgraded by a later save
    if v_effect is not null and v_applied is distinct from v_effect and v_applied is distinct from 'dnc' then
      if v_effect = 'dnc' then
        insert into public.dnc_numbers (org_id, e164, source, added_by, note)
        values (v_log.org_id, v_log.phone, 'disposition', v_uid, 'via manual call outcome: ' || v_disp.label)
        on conflict (org_id, e164) do nothing;
        if v_can then
          update public.contacts set dnc = true, updated_at = now() where id = v_contact;
          update public.campaign_leads set status = 'dnc', updated_at = now() where contact_id = v_contact;
          v_contact_effect := 'applied';
        else
          v_contact_effect := 'skipped_no_access';
        end if;
      elsif v_can then
        update public.campaign_leads set status = v_effect, updated_at = now()
        where contact_id = v_contact and org_id = v_log.org_id and status in ('queued', 'callback');
        v_contact_effect := 'applied';
      else
        v_contact_effect := 'skipped_no_access';
      end if;
      v_applied := v_effect;
    elsif v_effect is not null and v_applied is not distinct from v_effect then
      v_contact_effect := 'already_applied';
    elsif v_effect is not null then
      v_contact_effect := 'already_applied';  -- DNC applied earlier stays
    end if;
  end if;

  update public.manual_call_logs
  set disposition_id = coalesce(v_disp.id, disposition_id),
      notes = case when p_notes is null then notes else v_notes end,
      applied_effect = v_applied,
      updated_at = now()
  where id = v_log.id;

  -- GHL: one 'disposition' job per call (deduplicated on the log id) when a readable contact exists
  if v_disp.id is not null and v_can then
    select nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') into v_agent_name
    from public.profiles p where p.user_id = v_log.user_id;
    begin
      perform public.enqueue_crm_job(
        v_log.org_id, 'disposition', v_contact, v_log.id,
        jsonb_build_object(
          'disposition_key', v_disp.key, 'disposition_label', v_disp.label, 'notes', v_notes, 'callback_at', null,
          'ghl_tag', v_disp.ghl_tag, 'creates_task', false, 'agent_name', coalesce(v_agent_name, 'Agent'),
          'duration_seconds', coalesce(v_log.duration_seconds, 0), 'recording_url', null, 'transcript_excerpt', null,
          'license_number', null, 'zips', null, 'top_objection', null, 'is_dnc', v_disp.lead_effect = 'dnc'
        )
      );
    exception when others then
      perform private.log_trigger_failure(v_log.org_id, 'manual_call_outcome', v_log.id, sqlstate || ': ' || sqlerrm);
    end;
  end if;

  return query select v_log.id, v_disp.key, v_effect, v_contact_effect;
end;
$$;

revoke all on function public.set_manual_call_outcome(uuid, text, text) from public, anon;
grant execute on function public.set_manual_call_outcome(uuid, text, text) to authenticated;

-- ---- list_contact_manual_calls --------------------------------------------------------------------------------------
create or replace function public.list_contact_manual_calls(p_contact_id uuid, p_limit integer default 50)
returns table (
  id uuid,
  user_id uuid,
  user_name text,
  direction text,
  answered boolean,
  started_at timestamptz,
  duration_seconds integer,
  disposition_key text,
  disposition_label text,
  notes text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_org uuid;
  v_phone text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  select c.org_id, c.phone_number into v_org, v_phone from public.contacts c where c.id = p_contact_id;
  if v_org is null then
    raise exception 'contact not found' using errcode = 'P0002';
  end if;
  if not private.contact_read_access(v_org, p_contact_id) then
    raise exception 'no access to this contact' using errcode = '42501';
  end if;
  return query
    select l.id, l.user_id,
           nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
           l.direction, l.answered, l.started_at, l.duration_seconds, d.key, d.label, l.notes
    from public.manual_call_logs l
    left join public.profiles p on p.user_id = l.user_id
    left join public.dispositions d on d.id = l.disposition_id
    where l.org_id = v_org
      and (l.contact_id = p_contact_id or (v_phone is not null and l.phone = v_phone))
      -- same visibility as the table: own calls; owner/admin all; manager their pods
      and (l.user_id = auth.uid()
           or private.has_org_role(v_org, array['owner', 'admin'])
           or (private.has_org_role(v_org, array['manager']) and private.is_agent_in_callers_pod_scope(v_org, l.user_id)))
    order by l.started_at desc, l.id desc
    limit greatest(least(coalesce(p_limit, 50), 200), 1);
end;
$$;

revoke all on function public.list_contact_manual_calls(uuid, integer) from public, anon;
grant execute on function public.list_contact_manual_calls(uuid, integer) to authenticated;

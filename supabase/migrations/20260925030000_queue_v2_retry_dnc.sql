-- TASK-F-T1 (design doc §11, PDF IDs QUE-2/3/4/5/7, BUG-3, DSP-6): queue v2 (per-disposition
-- retry rules, time-block rotation, loser requeue) + an org-wide DNC table.
--
-- Design choice (documented per the task's own instruction): a `campaign_retry_rules` TABLE, not
-- a jsonb column on campaigns. Every other per-campaign/per-org config in this schema (dial
-- settings, dispositions) is a flat-columns table, and a table gives the Settings/campaign-
-- settings editor UI a normal row-per-disposition shape to list/edit -- a jsonb blob would be
-- the odd one out and harder to RLS-scope per row. See .brain/memory/decisions.md.
--
-- Disposition-key naming: QUE-2's own table (and DSP-2) names dispositions this build never
-- actually seeded -- "voicemail_left" (this build's real key is `voicemail`), "do_not_call"
-- (real key `dnc`), and two that don't exist at all here, "gatekeeper" and "already_on_platform"
-- (TASK-P3-E1 seeded a simpler 7-key set: interested/callback/not_interested/wrong_number/dnc/
-- voicemail/no_answer -- dispositions are also org-editable, so a real "Gatekeeper" disposition
-- an org adds later can get its own retry rule row through the same Settings UI, nothing in this
-- schema special-cases the seeded set). Retry rules below are seeded against the REAL keys this
-- build has; gatekeeper/already_on_platform are deliberately not fabricated as rule rows for
-- dispositions that don't exist. See known-issues.md.

-- dnc_numbers (QUE-7): org-wide DNC list, independent of (and NOT auto-synced with) the
-- contacts.dnc flag TASK-P2-P1 already added -- claim_next_leads below checks BOTH explicitly,
-- per this task's own instruction ("exclude contacts whose E.164 is in dnc_numbers... plus the
-- existing flag"), rather than this migration adding a sync trigger neither task asked for. A
-- number added here via 'manual'/'import' does not retroactively flip every matching contact's
-- own `dnc` flag -- known, documented gap, not a silent one (known-issues.md).
--------------------------------------------------------------------------------------------------

create table public.dnc_numbers (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  e164 text not null,
  source text not null check (source in ('disposition', 'sms_stop', 'manual', 'import')),
  added_by uuid references auth.users(id) on delete set null,
  note text,
  created_at timestamptz not null default now(),
  unique (org_id, e164)
);

create index idx_dnc_numbers_org_id on public.dnc_numbers(org_id);

alter table public.dnc_numbers enable row level security;

create policy "org members can view dnc_numbers"
  on public.dnc_numbers for select
  using (private.is_org_member(org_id));

create policy "admin can insert dnc_numbers"
  on public.dnc_numbers for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "admin can delete dnc_numbers"
  on public.dnc_numbers for delete
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- Backfill from every contact already flagged DNC (the only signal that existed before this
-- table) -- source 'manual' since there's no real "who/why" to attribute this one-time backfill
-- to; added_by is left null (no single user caused it).
insert into public.dnc_numbers (org_id, e164, source, note)
select distinct c.org_id, c.phone_number, 'manual', 'backfilled from contacts.dnc at TASK-F-T1'
from public.contacts c
where c.dnc = true and c.phone_number is not null
on conflict (org_id, e164) do nothing;

-- campaign_retry_rules (QUE-2/QUE-3/QUE-5) -------------------------------------------------------

create table public.campaign_retry_rules (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  disposition_key text not null,
  action text not null check (action in ('retry', 'out', 'exact_time')),
  -- Only meaningful when action='retry'. Minutes, not days, to match retry_interval_minutes'
  -- existing unit on campaigns -- the UI shows/edits it as days for the two seeded retry rules
  -- (4 days = 5760) since that's how the task's own spec states them.
  delay_minutes int check (delay_minutes is null or delay_minutes >= 0),
  -- Only meaningful when action='retry'. QUE-5: a rotating retry lands in a DIFFERENT time block
  -- than the attempt that triggered it (private.rotated_retry_schedule below); a non-rotating
  -- retry (action='retry', rotate_block=false) is a flat now()+delay_minutes offset instead --
  -- not used by either seeded retry rule today, but a future org-added rule can choose it.
  rotate_block boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (campaign_id, disposition_key)
);

create index idx_campaign_retry_rules_campaign_id on public.campaign_retry_rules(campaign_id);

alter table public.campaign_retry_rules enable row level security;

-- Member read, admin write (same shape as dispositions/dnc_numbers, and what the task's own
-- verification wording describes -- "a member can read, an agent cannot delete"). Nothing on the
-- agent side reads a retry rule directly today (the wrap-up form only reads `dispositions`, and
-- every RPC that CONSULTS campaign_retry_rules runs SECURITY DEFINER, bypassing RLS regardless),
-- but there's no reason to lock read access tighter than every other per-org config table, and
-- keeping the shape consistent is worth more than the theoretical narrower surface.
create policy "org members can view campaign_retry_rules"
  on public.campaign_retry_rules for select
  using (private.is_org_member(private.campaign_org_id(campaign_id)));

create policy "admin can insert campaign_retry_rules"
  on public.campaign_retry_rules for insert
  with check (private.has_org_role(private.campaign_org_id(campaign_id), array['owner', 'admin']));

create policy "admin can update campaign_retry_rules"
  on public.campaign_retry_rules for update
  using (private.has_org_role(private.campaign_org_id(campaign_id), array['owner', 'admin']))
  with check (private.has_org_role(private.campaign_org_id(campaign_id), array['owner', 'admin']));

create policy "admin can delete campaign_retry_rules"
  on public.campaign_retry_rules for delete
  using (private.has_org_role(private.campaign_org_id(campaign_id), array['owner', 'admin']));

-- Seed + trigger, same "one definition, shared by the new-row trigger and a backfill loop" shape
-- as private.seed_default_dispositions (20260924002200_dispositions.sql).
create function private.seed_default_campaign_retry_rules(p_campaign uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.campaign_retry_rules (campaign_id, disposition_key, action, delay_minutes, rotate_block)
  values
    (p_campaign, 'no_answer', 'retry', 5760, true),   -- QUE-2: +4 days, rotate the block
    (p_campaign, 'voicemail', 'retry', 5760, true),    -- QUE-2's "voicemail_left" -> this build's `voicemail` key
    (p_campaign, 'callback', 'exact_time', null, false),
    (p_campaign, 'interested', 'out', null, false),
    (p_campaign, 'not_interested', 'out', null, false),
    (p_campaign, 'wrong_number', 'out', null, false),
    (p_campaign, 'dnc', 'out', null, false)            -- QUE-2's "do_not_call" -> this build's `dnc` key
  on conflict (campaign_id, disposition_key) do nothing;
$$;

create function private.seed_default_campaign_retry_rules_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_campaign_retry_rules(new.id);
  return new;
end;
$$;

create trigger campaigns_seed_default_retry_rules
  after insert on public.campaigns
  for each row execute function private.seed_default_campaign_retry_rules_trigger();

do $$
declare r record;
begin
  for r in select id from public.campaigns loop
    perform private.seed_default_campaign_retry_rules(r.id);
  end loop;
end $$;

-- Time blocks (QUE-5) -----------------------------------------------------------------------

alter table public.call_legs
  add column time_block text check (time_block in ('morning', 'lunch', 'afternoon', 'drive', 'evening'));

alter table public.campaign_leads
  add column priority_requeue boolean not null default false;

-- private.time_block_for: pure SQL helper (the task's own "write a pure SQL helper" instruction).
-- Deliberately NOT called by any TS code -- every leg-ending decision that needs a time block
-- (claim_next_leads stamping one at dial time, apply_leg_outcome/submit_disposition rotating one
-- at retry time) already runs entirely inside a single SQL function call; there's no "TS decides,
-- then tells SQL what to write" step for this the way legTransition precedes transition_leg.
-- `_shared/queue-retry-rules.ts` is a deno-tested TS TWIN of this exact algorithm (the task's own
-- "unit tests for the time-block helpers" instruction) -- documentation/verification of the
-- algorithm, not a second live implementation; the SQL version below is the only one ever
-- actually executed. Both must stay in sync if the block boundaries ever change.
create function private.time_block_for(p_ts timestamptz, p_tz text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when extract(hour from p_ts at time zone coalesce(private.safe_timezone(p_tz), 'America/Chicago')) < 11 then 'morning'
    when extract(hour from p_ts at time zone coalesce(private.safe_timezone(p_tz), 'America/Chicago')) < 14 then 'lunch'
    when extract(hour from p_ts at time zone coalesce(private.safe_timezone(p_tz), 'America/Chicago')) < 16 then 'afternoon'
    when extract(hour from p_ts at time zone coalesce(private.safe_timezone(p_tz), 'America/Chicago')) < 19 then 'drive'
    else 'evening'
  end;
$$;

-- private.rotated_retry_schedule: "next_attempt_at = the start of the next day's slot in a block
-- different from the last attempt's block" (the task's own words). Rotation order is the fixed
-- cycle morning -> lunch -> afternoon -> drive -> evening -> morning -- deterministic, and even
-- across many retries (never gets stuck alternating just two blocks). p_delay_days is the whole
-- number of days out (>=1 -- a "rotate the block" retry is never scheduled for later today, that
-- would usually land in the SAME block it's trying to rotate away from).
create function private.rotated_retry_schedule(p_last_block text, p_tz text, p_delay_days int)
returns table (next_attempt_at timestamptz, next_block text)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_order text[] := array['morning', 'lunch', 'afternoon', 'drive', 'evening'];
  v_idx int;
  v_block text;
  v_hour int;
  v_tz text;
begin
  v_tz := coalesce(private.safe_timezone(p_tz), 'America/Chicago');
  v_idx := coalesce(array_position(v_order, p_last_block), 0);
  v_block := v_order[(v_idx % 5) + 1];
  v_hour := case v_block
    when 'morning' then 8 when 'lunch' then 11 when 'afternoon' then 14
    when 'drive' then 16 when 'evening' then 19
  end;
  next_block := v_block;
  next_attempt_at := ((((now() at time zone v_tz)::date + greatest(1, p_delay_days))::text
    || ' ' || v_hour || ':00:00')::timestamp) at time zone v_tz;
  return next;
end;
$$;

-- private.enqueue_nurture_tag_if_exhausted (QUE-3): the ONE place "did this lead just become
-- exhausted" gets checked, called from every write site that can set campaign_leads.status =
-- 'exhausted' (apply_leg_outcome's own max-attempts/failed paths, submit_disposition's exhausted
-- lead_effect, submit_disposition's queued-effect max-attempts path) -- rather than duplicating
-- the enqueue call (and its exact payload) at each site. Idempotent the same way every other
-- enqueue_crm_job caller is: keyed on (call_leg_id, 'nurture_tag'), so calling this twice for the
-- same leg (defensive, shouldn't happen -- a lead only crosses into 'exhausted' once) is a no-op
-- the second time.
create function private.enqueue_nurture_tag_if_exhausted(
  p_org uuid, p_lead_id uuid, p_contact_id uuid, p_call_leg_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_lead_id is null then
    return;
  end if;
  select status into v_status from public.campaign_leads where id = p_lead_id;
  if v_status = 'exhausted' then
    perform public.enqueue_crm_job(p_org, 'nurture_tag', p_contact_id, p_call_leg_id, '{}'::jsonb);
  end if;
end;
$$;

-- crm_sync_jobs.kind: add 'nurture_tag' (QUE-3) -- inline CHECK, so this is Postgres's own
-- default constraint name (verified live-equivalent pattern already used for
-- call_legs_hangup_cause_check/call_legs_amd_result_check, 20260924001000).
alter table public.crm_sync_jobs drop constraint crm_sync_jobs_kind_check;
alter table public.crm_sync_jobs add constraint crm_sync_jobs_kind_check
  check (kind in ('disposition', 'contact_upsert', 'nurture_tag'));

-- claim_next_leads (create or replace, SAME signature `(uuid)` as the live 20260924001900
-- version -- no drop needed, the argument list is unchanged): DNC exclusion (QUE-7) + time_block
-- stamping (QUE-5) on every newly-claimed contact leg. Every OTHER line is byte-identical to the
-- live version -- diff against it directly if this ever needs re-verifying.
create or replace function public.claim_next_leads(p_session uuid)
returns setof public.claimed_dial_leg
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_campaign_id uuid;
  v_agent_id uuid;
  v_lines int;
  v_window_start time;
  v_window_end time;
  v_capacity int;
begin
  select ds.org_id, ds.campaign_id, ds.agent_id, ds.lines
    into v_org_id, v_campaign_id, v_agent_id, v_lines
  from public.dial_sessions ds
  where ds.id = p_session and ds.state = 'dialing'
  for update;

  if v_campaign_id is null then
    return;
  end if;

  select count(*) into v_capacity
  from public.call_legs
  where session_id = p_session and kind = 'contact' and state <> 'ended';

  v_capacity := greatest(0, v_lines - v_capacity);
  if v_capacity = 0 then
    return;
  end if;

  select c.calling_window_start, c.calling_window_end into v_window_start, v_window_end
  from public.campaigns c
  where c.id = v_campaign_id;

  return query
  with picked as (
    select
      cl2.id,
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) as is_priority_callback,
      cl2.priority_requeue,
      cl2.attempts,
      cl2.next_attempt_at,
      cl2.position,
      cl2.contact_id
    from public.campaign_leads cl2
    join public.contacts ct on ct.id = cl2.contact_id
    where cl2.campaign_id = v_campaign_id
      and cl2.next_attempt_at <= now()
      and not ct.dnc
      -- QUE-7: the org-wide DNC list, independent of (checked IN ADDITION TO) the contact's own
      -- flag above -- see this migration's own header for why the two aren't sync-triggered.
      and not exists (
        select 1 from public.dnc_numbers dn
        where dn.org_id = v_org_id and dn.e164 = ct.phone_number
      )
      and (
        cl2.status = 'queued'
        or (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id)
      )
      and private.is_lead_callable_now(ct.timezone, v_window_start, v_window_end)
    order by
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) desc,
      -- BUG-3/QUE-4: a leg requeued by apply_leg_outcome's loser path (dropped/abandoned --
      -- lost the claim race to another leg in the SAME batch, not a real no-answer) goes to the
      -- front of the non-callback tier, ahead of ordinary attempts/next_attempt_at/position
      -- ordering -- it would otherwise tie with a same-attempts fresh lead on next_attempt_at
      -- and not reliably sort first.
      cl2.priority_requeue desc,
      cl2.attempts asc,
      cl2.next_attempt_at asc,
      cl2.position asc
    limit v_capacity
    for update of cl2 skip locked
  ),
  updated as (
    update public.campaign_leads cl
    set status = 'in_flight', updated_at = now(), priority_requeue = false
    from picked
    where cl.id = picked.id
    returning cl.id, cl.contact_id
  ),
  new_legs as (
    insert into public.call_legs (org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state, time_block)
    select
      v_org_id, p_session, v_campaign_id, u.contact_id, u.id, 'contact', 'pending-' || gen_random_uuid()::text, 'initiated',
      private.time_block_for(now(), (select ct3.timezone from public.contacts ct3 where ct3.id = u.contact_id))
    from updated u
    returning id, lead_id, contact_id, call_control_id
  )
  select
    nl.id as leg_id,
    nl.lead_id,
    nl.contact_id,
    (select ct2.phone_number from public.contacts ct2 where ct2.id = nl.contact_id),
    nl.call_control_id
  from new_legs nl
  join picked p on p.id = nl.lead_id
  order by p.is_priority_callback desc, p.priority_requeue desc, p.attempts asc, p.next_attempt_at asc, p.position asc;
end;
$$;

revoke all on function public.claim_next_leads(uuid) from public, anon, authenticated;
grant execute on function public.claim_next_leads(uuid) to service_role;

-- apply_leg_outcome (create or replace, SAME signature `(uuid)` as the live 20260924001000
-- version): QUE-2's no_answer retry rule (rotated schedule instead of the flat
-- retry_interval_minutes, when the campaign has one), and the BUG-3/QUE-4 fix -- 'abandoned' used
-- to increment attempts exactly like a real no-answer (the bug: BOTH losing outcomes,
-- dropped AND abandoned, must leave attempts unchanged, per the task's own words -- the live
-- version only excluded 'dropped'). Losing legs also now redial at now() (was +15 minutes) with
-- priority_requeue set, instead of a plain delay with no queue-position priority.
create or replace function public.apply_leg_outcome(p_leg uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_outcome text;
  v_lead_id uuid;
  v_session_id uuid;
  v_campaign_id uuid;
  v_org_id uuid;
  v_contact_id uuid;
  v_last_block text;
  v_max_attempts int;
  v_retry_minutes int;
  v_contact_tz text;
  v_current_attempts int;
  v_rule public.campaign_retry_rules;
  v_increment int;
  v_next_status text;
  v_next_attempt_at timestamptz;
  v_schedule record;
begin
  update public.call_legs
  set outcome_applied_at = now()
  where id = p_leg and outcome_applied_at is null and outcome is not null
  returning outcome, lead_id, session_id, campaign_id, org_id, contact_id, time_block
  into v_outcome, v_lead_id, v_session_id, v_campaign_id, v_org_id, v_contact_id, v_last_block;

  if not found then
    return;
  end if;

  if v_lead_id is not null then
    select max_attempts, retry_interval_minutes into v_max_attempts, v_retry_minutes
    from public.campaigns where id = v_campaign_id;
    select timezone into v_contact_tz from public.contacts where id = v_contact_id;
    select attempts into v_current_attempts from public.campaign_leads where id = v_lead_id;

    -- Only 'no_answer' has a real seeded rule row against this raw ENGINE outcome vocabulary
    -- (busy/machine/dropped/abandoned/failed/connected never match a row -- this lookup is a
    -- harmless no-op for them, v_rule stays null, every branch below falls back to the
    -- pre-existing flat-interval behavior exactly as before this migration).
    select * into v_rule from public.campaign_retry_rules
    where campaign_id = v_campaign_id and disposition_key = v_outcome;

    v_increment := case when v_outcome in ('dropped', 'abandoned') then 0 else 1 end;

    if v_outcome = 'failed' then
      v_next_status := 'exhausted';
      v_next_attempt_at := null;
    elsif v_outcome = 'connected' then
      v_next_status := null; -- coalesced to the current status below -- unchanged
      v_next_attempt_at := null; -- coalesced below -- unchanged
    elsif v_outcome in ('dropped', 'abandoned') then
      -- BUG-3/QUE-4 fix: attempts unchanged (v_increment above), redial immediately, front of
      -- the queue (priority_requeue, consulted by claim_next_leads' own ORDER BY above).
      v_next_status := 'queued';
      v_next_attempt_at := now();
    elsif v_rule.id is not null and v_rule.action = 'out' then
      v_next_status := 'exhausted';
      v_next_attempt_at := null;
    elsif v_current_attempts + v_increment >= v_max_attempts then
      v_next_status := 'exhausted';
      v_next_attempt_at := null;
    elsif v_rule.id is not null and v_rule.action = 'retry' then
      select * into v_schedule
      from private.rotated_retry_schedule(v_last_block, v_contact_tz, greatest(1, v_rule.delay_minutes / 1440));
      v_next_status := 'queued';
      v_next_attempt_at := v_schedule.next_attempt_at;
    else
      v_next_status := 'queued';
      v_next_attempt_at := now() + make_interval(mins => coalesce(v_retry_minutes, 120));
    end if;

    update public.campaign_leads cl
    set
      status = coalesce(v_next_status, cl.status),
      attempts = cl.attempts + v_increment,
      last_outcome = v_outcome,
      next_attempt_at = coalesce(v_next_attempt_at, cl.next_attempt_at),
      priority_requeue = (v_outcome in ('dropped', 'abandoned')),
      updated_at = now()
    where cl.id = v_lead_id;

    perform private.enqueue_nurture_tag_if_exhausted(v_org_id, v_lead_id, v_contact_id, p_leg);
  end if;

  if v_session_id is not null then
    update public.dial_sessions
    set active_leg_id = null, updated_at = now()
    where id = v_session_id and active_leg_id = p_leg;
  end if;
end;
$$;

revoke all on function public.apply_leg_outcome(uuid) from public, anon, authenticated;
grant execute on function public.apply_leg_outcome(uuid) to service_role;

-- submit_disposition (create or replace, SAME signature as the live 20260924002300 version):
-- the 'queued' lead_effect (voicemail/no_answer-manual dispositions) now consults
-- campaign_retry_rules the same way apply_leg_outcome does (QUE-2), instead of always using the
-- campaign's flat retry_interval_minutes. The 'dnc' lead_effect now also writes dnc_numbers
-- (DSP-6/QUE-7), and exhaustion via either the 'exhausted' lead_effect or a maxed-out 'queued'
-- effect enqueues the nurture tag job (QUE-3).
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
      'recording_url', null,
      'transcript_excerpt', null
    )
  );

  perform public.transition_session(v_session.id, array['wrap_up'], 'dialing', '{}'::jsonb);

  return query select v_session.id, v_already;
end;
$$;

revoke all on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.submit_disposition(uuid, uuid, uuid, text, text, timestamptz) to service_role;

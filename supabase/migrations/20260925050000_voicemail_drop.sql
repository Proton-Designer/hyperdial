-- TASK-F-T3: voicemail drop (VMD-1..5) + real AMD modes (BUG-7). Timestamp assigned by the lead
-- (20260925050000).
--
-- Telnyx details re-verified against the real spec3.json/webhook-events.json (not the task doc's
-- assumptions) -- full writeup in decisions.md/dialer.md, the two load-bearing findings:
--   1. CallRequest.answering_machine_detection's real enum is `premium|detect|detect_beep|
--      detect_words|greeting_end|disabled` -- this build surfaces 4 of those to a campaign
--      ('off'->disabled, 'detect', 'detect_words', 'premium'); 'detect_beep'/'greeting_end' are
--      narrower special cases of 'detect_words' this build doesn't need.
--   2. Plain 'detect' NEVER emits call.machine.greeting.ended (only detect_words/detect_beep/
--      greeting_end do, for standard detection; premium's greeting-ended is separately
--      beep-gated) -- so a voicemail drop is impossible to time safely under 'detect', and the
--      engine (voicemail-core.ts/dialer-engine.ts) never arms one for it regardless of
--      voicemail_drop_mode. Cost difference (telnyx.com/pricing/voice, fetched 2026-09-25):
--      standard AMD ~$0.002/call, premium ~$0.0065/call (~3.25x).
--
-- Key-naming note (same class of task-doc-vs-code mismatch F-T1/F-T2 already found, worth
-- flagging again): the task doc's own text says "voicemail_left already has an F-T1 rule" --
-- false. F-T1's seeded retry rule key is `voicemail` (the MANUAL agent-submitted "Left
-- voicemail" disposition, QUE-2). `voicemail_left` (this task) is a NEW, separate, AUTOMATED
-- engine outcome for a losing contact leg the engine itself detected as a machine and dropped a
-- recording on -- it gets its OWN seeded retry rule below (same +4-day rotated schedule), and its
-- own GHL tag job kind, entirely independent of the pre-existing `voicemail` disposition key.
-- Likewise `no_answer_tag` (GHL-9 overlap, explicitly green-lit by the task) is independent of
-- the manual "No answer (manual)" disposition's own (null, note-only) ghl_tag.

-- =================================================================================================
-- 1. AMD modes widen: campaigns/dial_sessions.amd_mode 'off'|'on' -> 'off'|'detect'|
--    'detect_words'|'premium'. Backfill BEFORE narrowing the CHECK -- 'on' always meant premium
--    (dialer-engine.ts's old toTelnyxAmdMode: `mode === 'on' ? 'premium' : 'off'`).
-- =================================================================================================

update public.campaigns set amd_mode = 'premium' where amd_mode = 'on';
update public.dial_sessions set amd_mode = 'premium' where amd_mode = 'on';

alter table public.campaigns drop constraint campaigns_amd_mode_check;
alter table public.campaigns add constraint campaigns_amd_mode_check
  check (amd_mode in ('off', 'detect', 'detect_words', 'premium'));

alter table public.dial_sessions drop constraint dial_sessions_amd_mode_check;
alter table public.dial_sessions add constraint dial_sessions_amd_mode_check
  check (amd_mode in ('off', 'detect', 'detect_words', 'premium'));

-- =================================================================================================
-- 2. call_legs: voicemail_dropping state, voicemail_left outcome, drop bookkeeping columns.
-- =================================================================================================

alter table public.call_legs
  -- Set once, at machine-detection-ended time (dialer-engine.ts's resolveVoicemailDropPath), to
  -- the STORAGE path this leg will play once its greeting ends -- null means "not dropping"
  -- (mode/attempt gating said no, amd_mode can't support it, or no drop file exists).
  add column voicemail_drop_path text,
  -- Stamped by startVoicemailPlayback right when playback_start is actually issued -- the
  -- sweeper's own ~90s safety timeout (below) anchors on this, falling back to created_at for the
  -- rare case a leg reaches 'voicemail_dropping' but the playback command itself then fails.
  add column voicemail_drop_started_at timestamptz;

alter table public.call_legs drop constraint call_legs_state_check;
alter table public.call_legs add constraint call_legs_state_check
  check (state in (
    'initiated', 'ringing', 'answered', 'amd_pending', 'claimed', 'dropped', 'abandoned',
    'machine', 'voicemail_dropping', 'ended'
  ));

alter table public.call_legs drop constraint call_legs_outcome_check;
alter table public.call_legs add constraint call_legs_outcome_check
  check (outcome in (
    'no_answer', 'busy', 'machine', 'dropped', 'abandoned', 'failed', 'connected',
    'voicemail_left'
  ));

-- =================================================================================================
-- 3. campaigns.voicemail_drop_mode (VMD-4). amd_mode already altered above.
-- =================================================================================================

alter table public.campaigns
  add column voicemail_drop_mode text not null default 'first_attempt'
    check (voicemail_drop_mode in ('first_attempt', 'every_attempt', 'never'));

-- =================================================================================================
-- 4. voicemail_drop_settings (VMD-1): per-user file, or the org default (user_id is null).
--    RLS per the task's own spec: "members read their own + the org default; admins write the
--    org default; users write their own." (Nothing client-side writes this table directly today
--    -- voicemail-upload/index.ts does, service-role, with its OWN auth check -- these policies
--    are still added per CLAUDE.md's own hard constraint and the task's explicit RLS ask, same
--    defense-in-depth reasoning as every other member-read/admin-write settings table here.)
-- =================================================================================================

create table public.voicemail_drop_settings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- null = the org default row.
  user_id uuid references auth.users(id) on delete cascade,
  storage_path text not null,
  updated_at timestamptz not null default now()
);

-- Two PARTIAL unique indexes (not one plain `unique(org_id, user_id)`) -- Postgres unique
-- constraints treat every NULL as distinct from every other NULL, so a plain unique index would
-- let an org insert unlimited "default" rows. One real per-user row per org, and exactly one
-- org-default row per org.
create unique index idx_voicemail_drop_settings_user
  on public.voicemail_drop_settings(org_id, user_id) where user_id is not null;
create unique index idx_voicemail_drop_settings_org_default
  on public.voicemail_drop_settings(org_id) where user_id is null;

alter table public.voicemail_drop_settings enable row level security;

create policy "org members can view their own or the org-default voicemail drop"
  on public.voicemail_drop_settings for select
  using (private.is_org_member(org_id) and (user_id = auth.uid() or user_id is null));

create policy "a member can set their own voicemail drop"
  on public.voicemail_drop_settings for insert
  with check (private.is_org_member(org_id) and user_id = auth.uid());

create policy "a member can update their own voicemail drop"
  on public.voicemail_drop_settings for update
  using (private.is_org_member(org_id) and user_id = auth.uid())
  with check (private.is_org_member(org_id) and user_id = auth.uid());

create policy "a member can delete their own voicemail drop"
  on public.voicemail_drop_settings for delete
  using (private.is_org_member(org_id) and user_id = auth.uid());

create policy "admin can set the org-default voicemail drop"
  on public.voicemail_drop_settings for insert
  with check (user_id is null and private.has_org_role(org_id, array['owner', 'admin']));

create policy "admin can update the org-default voicemail drop"
  on public.voicemail_drop_settings for update
  using (user_id is null and private.has_org_role(org_id, array['owner', 'admin']))
  with check (user_id is null and private.has_org_role(org_id, array['owner', 'admin']));

create policy "admin can delete the org-default voicemail drop"
  on public.voicemail_drop_settings for delete
  using (user_id is null and private.has_org_role(org_id, array['owner', 'admin']));

-- =================================================================================================
-- 5. Storage bucket: voicemail-drops (private). Same "no client-facing storage.objects policy at
--    all" shape as `recordings` (TASK-F-T2) -- RLS on storage.objects is on by default with zero
--    policies meaning zero access except service_role; voicemail-upload/index.ts (service role,
--    its own auth check) is the ONLY read/write path.
-- =================================================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'voicemail-drops', 'voicemail-drops', false, 5242880,
  array['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/wave', 'audio/x-wav']
)
on conflict (id) do nothing;

-- =================================================================================================
-- 6. claim_next_leads (create or replace, SAME signature `(uuid)` as the live 20260925030000
--    version): VMD-5's own capacity-check exclusion -- a 'voicemail_dropping' leg never counts as
--    an active dialing line, the exact same treatment 'ended' already gets. Every OTHER line is
--    byte-identical to the live version.
-- =================================================================================================

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
  where session_id = p_session and kind = 'contact'
    -- TASK-F-T3 (VMD-5): a voicemail-dropping leg must never hold up the next batch.
    and state not in ('ended', 'voicemail_dropping');

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

-- =================================================================================================
-- 7. crm_sync_jobs.kind: add 'voicemail_tag'/'no_answer_tag' (VMD-3, GHL-9 overlap).
-- =================================================================================================

alter table public.crm_sync_jobs drop constraint crm_sync_jobs_kind_check;
alter table public.crm_sync_jobs add constraint crm_sync_jobs_kind_check
  check (kind in ('disposition', 'contact_upsert', 'nurture_tag', 'voicemail_tag', 'no_answer_tag'));

-- private.enqueue_voicemail_tag_if_applicable / enqueue_no_answer_tag_if_applicable: the counted
-- tag (`call:voicemail-<n>`/`call:no-answer-<n>`) is computed HERE, at enqueue time, from a plain
-- count of this contact's own call_legs at that outcome -- the CURRENT leg's own outcome column
-- is already persisted by the time apply_leg_outcome calls these (transition_leg sets `outcome`
-- before apply_leg_outcome ever runs), so the count naturally includes it: n=1 on the very first
-- voicemail/no-answer for that contact, not n=0. enqueue_crm_job itself already no-ops when the
-- org has no connected GHL integration and dedupes on (call_leg_id, kind) -- neither function
-- needs to re-check either.

create function private.enqueue_voicemail_tag_if_applicable(
  p_org uuid, p_contact_id uuid, p_call_leg_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if p_contact_id is null then
    return;
  end if;
  select count(*) into v_count
  from public.call_legs
  where contact_id = p_contact_id and outcome = 'voicemail_left';
  perform public.enqueue_crm_job(
    p_org, 'voicemail_tag', p_contact_id, p_call_leg_id,
    jsonb_build_object('ghl_tag', 'call:voicemail-' || v_count)
  );
end;
$$;

create function private.enqueue_no_answer_tag_if_applicable(
  p_org uuid, p_contact_id uuid, p_call_leg_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count int;
begin
  if p_contact_id is null then
    return;
  end if;
  select count(*) into v_count
  from public.call_legs
  where contact_id = p_contact_id and outcome = 'no_answer';
  perform public.enqueue_crm_job(
    p_org, 'no_answer_tag', p_contact_id, p_call_leg_id,
    jsonb_build_object('ghl_tag', 'call:no-answer-' || v_count)
  );
end;
$$;

-- =================================================================================================
-- 8. apply_leg_outcome (create or replace, SAME signature `(uuid)` as the live 20260925030000
--    version): two new tag-push calls (voicemail_left/no_answer), mirroring the existing
--    enqueue_nurture_tag_if_exhausted call this function already makes for a different reason.
--    NO retry-schedule logic changes at all -- 'voicemail_left' falls through this function's
--    already-generic rule lookup (`campaign_retry_rules where disposition_key = v_outcome`) the
--    exact same way 'no_answer' already does, once the new seeded rule row (below) exists. Every
--    other line is byte-identical to the live version.
-- =================================================================================================

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

    select * into v_rule from public.campaign_retry_rules
    where campaign_id = v_campaign_id and disposition_key = v_outcome;

    v_increment := case when v_outcome in ('dropped', 'abandoned') then 0 else 1 end;

    if v_outcome = 'failed' then
      v_next_status := 'exhausted';
      v_next_attempt_at := null;
    elsif v_outcome = 'connected' then
      v_next_status := null;
      v_next_attempt_at := null;
    elsif v_outcome in ('dropped', 'abandoned') then
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

  -- TASK-F-T3 (VMD-3, GHL-9 overlap): unlike enqueue_nurture_tag_if_exhausted above, these two
  -- don't need v_lead_id at all (a contact-level count, not a lead-status transition) -- run for
  -- every leg reaching either outcome, lead or no.
  if v_outcome = 'voicemail_left' then
    perform private.enqueue_voicemail_tag_if_applicable(v_org_id, v_contact_id, p_leg);
  elsif v_outcome = 'no_answer' then
    perform private.enqueue_no_answer_tag_if_applicable(v_org_id, v_contact_id, p_leg);
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

-- =================================================================================================
-- 9. campaign_retry_rules: seed 'voicemail_left' (+4 days, rotate the block -- same shape as
--    'no_answer'/'voicemail'). seed_default_campaign_retry_rules (create or replace, SAME
--    signature) already ON CONFLICT DO NOTHINGs per-key, so re-running its own existing backfill
--    loop for every campaign is safe: the 5 already-seeded keys silently no-op, only the new
--    'voicemail_left' row actually inserts.
-- =================================================================================================

create or replace function private.seed_default_campaign_retry_rules(p_campaign uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.campaign_retry_rules (campaign_id, disposition_key, action, delay_minutes, rotate_block)
  values
    (p_campaign, 'no_answer', 'retry', 5760, true),
    (p_campaign, 'voicemail', 'retry', 5760, true),
    -- TASK-F-T3: the NEW automated engine outcome, distinct from 'voicemail' above (the manual
    -- agent-submitted disposition) -- see this migration's own header.
    (p_campaign, 'voicemail_left', 'retry', 5760, true),
    (p_campaign, 'callback', 'exact_time', null, false),
    (p_campaign, 'interested', 'out', null, false),
    (p_campaign, 'not_interested', 'out', null, false),
    (p_campaign, 'wrong_number', 'out', null, false),
    (p_campaign, 'dnc', 'out', null, false)
  on conflict (campaign_id, disposition_key) do nothing;
$$;

do $$
declare r record;
begin
  for r in select id from public.campaigns loop
    perform private.seed_default_campaign_retry_rules(r.id);
  end loop;
end $$;

-- =================================================================================================
-- 10. run_dialer_sweep: a NEW overload `(int, int, int)` -- the 3rd param is the VM-drop timeout
--     (default 90s, per the task's own "~90s" spec). Argument list changes, so `drop` the old
--     2-arg version first (same reasoning as 20260925010000's own header on this exact point) --
--     dialer-sweeper/index.ts is updated in the same commit to call the new 3-arg form.
--     Two real changes versus the live 2-arg version: (a) block 1's own "stuck non-terminal
--     contact leg" sweep now EXCLUDES 'voicemail_dropping' (it would otherwise reap a genuinely
--     still-playing drop at 60s with the WRONG outcome, 'failed' -- answered_at is set -- racing
--     the new block 1c below); (b) new block 1c reaps a 'voicemail_dropping' leg older than
--     p_voicemail_drop_after_seconds, outcome 'voicemail_left', same as a real playback-ended
--     hangup would have produced.
-- =================================================================================================

drop function if exists public.run_dialer_sweep(int, int);

create function public.run_dialer_sweep(
  p_stuck_after_seconds int default 60,
  p_claimed_check_after_seconds int default 300,
  p_voicemail_drop_after_seconds int default 90
)
returns public.dialer_sweep_result
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row record;
  v_applied boolean;
  v_result public.dialer_sweep_result;
begin
  v_result.reaped_legs := '[]'::jsonb;
  v_result.paused_agent_sessions := 0;
  v_result.applied_orphaned_outcomes := 0;
  v_result.requeued_leads := 0;
  v_result.stale_claimed_legs := '[]'::jsonb;

  -- 1. Stuck non-terminal contact legs -----------------------------------------------------
  for v_row in
    select cl.id, cl.call_control_id, cl.state, cl.answered_at, cl.org_id
    from public.call_legs cl
    where cl.kind = 'contact'
      -- TASK-F-T3: 'voicemail_dropping' has its OWN reap below (1c), on its own timeout and with
      -- the correct 'voicemail_left' outcome -- this generic branch would otherwise race it with
      -- a shorter window and the wrong outcome (answered_at is set, so it'd reap as 'failed').
      and cl.state not in ('ended', 'claimed', 'voicemail_dropping')
      and coalesce(
        (select max(we.received_at) from public.webhook_events we
         where we.call_control_id = cl.call_control_id),
        cl.created_at
      ) < now() - make_interval(secs => p_stuck_after_seconds)
    for update of cl skip locked
  loop
    select public.transition_leg(
      v_row.call_control_id,
      array[v_row.state],
      'ended',
      jsonb_build_object(
        'outcome', case when v_row.answered_at is not null then 'failed' else 'no_answer' end,
        'hangup_cause', 'timeout',
        'ended_at', now()
      )
    ) into v_applied;

    if v_applied then
      perform public.apply_leg_outcome(v_row.id);
      v_result.reaped_legs := v_result.reaped_legs
        || jsonb_build_object('org_id', v_row.org_id, 'call_control_id', v_row.call_control_id);
    end if;
  end loop;

  -- 1b. Claimed (bridged) contact legs silent longer than the check-after window -- SELECT only.
  for v_row in
    select cl.id, cl.call_control_id, cl.org_id, cl.created_at
    from public.call_legs cl
    where cl.kind = 'contact'
      and cl.state = 'claimed'
      and cl.claimed_at < now() - make_interval(secs => p_claimed_check_after_seconds)
  loop
    v_result.stale_claimed_legs := v_result.stale_claimed_legs || jsonb_build_object(
      'id', v_row.id,
      'call_control_id', v_row.call_control_id,
      'org_id', v_row.org_id,
      'created_at', v_row.created_at
    );
  end loop;

  -- 1c. Voicemail-dropping legs stuck past the safety timeout (TASK-F-T3, VMD-2 safety timeout)
  -- -- coalesce to created_at for the rare case voicemail_drop_started_at was never stamped (the
  -- greeting-ended transition landed but the playback_start command itself then failed).
  for v_row in
    select cl.id, cl.call_control_id, cl.org_id
    from public.call_legs cl
    where cl.kind = 'contact'
      and cl.state = 'voicemail_dropping'
      and coalesce(cl.voicemail_drop_started_at, cl.created_at)
        < now() - make_interval(secs => p_voicemail_drop_after_seconds)
    for update of cl skip locked
  loop
    select public.transition_leg(
      v_row.call_control_id,
      array['voicemail_dropping'],
      'ended',
      jsonb_build_object('outcome', 'voicemail_left', 'hangup_cause', 'timeout', 'ended_at', now())
    ) into v_applied;

    if v_applied then
      perform public.apply_leg_outcome(v_row.id);
      v_result.reaped_legs := v_result.reaped_legs
        || jsonb_build_object('org_id', v_row.org_id, 'call_control_id', v_row.call_control_id);
    end if;
  end loop;

  -- 2. Sessions whose agent leg has ended ---------------------------------------------------
  for v_row in
    select ds.id, ds.state
    from public.dial_sessions ds
    join public.call_legs al on al.id = ds.agent_leg_id
    where al.state = 'ended'
      and ds.state in ('ready_pending', 'ready', 'dialing', 'connecting', 'on_call', 'wrap_up', 'paused')
  loop
    select public.transition_session(
      v_row.id, array[v_row.state], 'paused_agent_lost',
      jsonb_build_object('paused_agent_lost_from', v_row.state)
    ) into v_applied;
    if v_applied then
      v_result.paused_agent_sessions := v_result.paused_agent_sessions + 1;
    end if;
  end loop;

  -- 3a. Ended legs with a recorded outcome that never got applied --------------------------
  for v_row in
    select id from public.call_legs
    where kind = 'contact' and state = 'ended' and outcome is not null and outcome_applied_at is null
    for update skip locked
  loop
    perform public.apply_leg_outcome(v_row.id);
    v_result.applied_orphaned_outcomes := v_result.applied_orphaned_outcomes + 1;
  end loop;

  -- 3b. In_flight leads with nothing left to apply -- direct requeue at attempts+0 ---------
  with latest_leg as (
    select
      cl.id as lead_id,
      (select l.id from public.call_legs l where l.lead_id = cl.id order by l.created_at desc limit 1)
        as leg_id
    from public.campaign_leads cl
    where cl.status = 'in_flight'
  ),
  stuck_leads as (
    select ll.lead_id
    from latest_leg ll
    left join public.call_legs l on l.id = ll.leg_id
    where ll.leg_id is null or (l.state = 'ended' and l.outcome is null)
  )
  update public.campaign_leads cl
  set status = 'queued', next_attempt_at = now(), updated_at = now()
  from stuck_leads
  where cl.id = stuck_leads.lead_id;
  get diagnostics v_result.requeued_leads = row_count;

  return v_result;
end;
$$;

revoke all on function public.run_dialer_sweep(int, int, int) from public, anon, authenticated;
grant execute on function public.run_dialer_sweep(int, int, int) to service_role;

-- Acceptance tests for TASK-P3-E1 (dispositions backend, design §5). Same technique as
-- dialer_schema_rpcs.sql/rls_org_matrix.sql: fixtures created as postgres (table owner, bypasses
-- RLS), everything inside one transaction ROLLED BACK at the end -- safe to run repeatedly
-- against the shared local DB. submit_disposition is service-role-only (see the migration's own
-- header for why), so these tests call it the same way the edge function does: explicit
-- p_org/p_caller_user_id, not auth.uid()/set_config RLS impersonation.

begin;

create or replace function public._test_expect_count(p_label text, p_query text, p_expected bigint)
returns void language plpgsql as $$
declare v_actual bigint;
begin
  execute p_query into v_actual;
  if v_actual is distinct from p_expected then
    raise exception 'FAIL [%]: expected % row(s), got % -- %', p_label, p_expected, v_actual, p_query;
  end if;
  raise notice 'PASS [%]: % row(s) as expected', p_label, v_actual;
end;
$$;

create or replace function public._test_expect_eq(p_label text, p_actual text, p_expected text)
returns void language plpgsql as $$
begin
  if p_actual is distinct from p_expected then
    raise exception 'FAIL [%]: expected %, got %', p_label, p_expected, p_actual;
  end if;
  raise notice 'PASS [%]: % as expected', p_label, p_actual;
end;
$$;

create or replace function public._test_expect_error(p_label text, p_query text)
returns void language plpgsql as $$
begin
  execute p_query;
  raise exception 'FAIL [%]: expected an error, but the query succeeded -- %', p_label, p_query;
exception
  when others then
    if sqlerrm like 'FAIL [%' then
      raise;
    end if;
    raise notice 'PASS [%]: raised as expected (%)', p_label, sqlerrm;
end;
$$;

-- Fixtures ---------------------------------------------------------------------------------
-- org_a: self-serve owner (the signup trigger provisions the org), plus agent1 (the session's
-- real agent) and agent2 (an unrelated active agent, for the cross-agent negative test).
-- org_b: a second org, used only for the "outbox row exists only when GHL is connected" test --
-- kept separate from org_a so org_a's own dispositions never accidentally enqueue anything.

-- TASK-L8: 20260925000300_invite_only_signup.sql's on_auth_user_created trigger now validates a
-- real org_invites token -- the old "no token = self-serve org" / "any non-null token = already
-- invited" shortcuts below no longer run those side effects, they just error. Swap the trigger
-- FUNCTION to a no-op (postgres owns it, even though it doesn't own auth.users itself on live --
-- same live-runnable technique as audit/L4/dryrun.sql), build org/profile/membership by hand, then
-- restore the real function. Manually inserting into public.orgs still fires that table's own
-- AFTER INSERT dispositions-seeding trigger (TASK-P3-E1) exactly as a real signup would.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $l8fx$
begin
  return new;
end;
$l8fx$;

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, is_sso_user, is_anonymous
) values
  ('00000000-0000-0000-0000-000000000000', 'e1e10000-a000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p3e1-owner-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'e1e10000-a000-4000-8000-00000000000b', 'authenticated', 'authenticated', 'p3e1-agent1-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'e1e10000-a000-4000-8000-00000000000c', 'authenticated', 'authenticated', 'p3e1-agent2-a@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false),
  ('00000000-0000-0000-0000-000000000000', 'e1e10000-b000-4000-8000-00000000000a', 'authenticated', 'authenticated', 'p3e1-owner-b@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_token text;
  v_invite record;
begin
  v_token := new.raw_user_meta_data ->> 'invite_token';
  if v_token is null or btrim(v_token) = '' then
    raise exception 'Sign-up is invite-only. Ask your team owner or admin for an invite link.';
  end if;
  select id, email, expires_at, accepted_at
    into v_invite
    from public.org_invites
   where token_hash = encode(extensions.digest(v_token, 'sha256'), 'hex');
  if not found then
    raise exception 'This invite link is not valid.';
  end if;
  if v_invite.accepted_at is not null then
    raise exception 'This invite has already been used.';
  end if;
  if v_invite.expires_at < now() then
    raise exception 'This invite has expired. Ask your team to send a new one.';
  end if;
  if lower(new.email) is distinct from lower(v_invite.email) then
    raise exception 'This invite was sent to a different email address.';
  end if;
  insert into public.profiles (user_id, first_name, last_name)
  values (new.id, nullif(new.raw_user_meta_data ->> 'first_name', ''), nullif(new.raw_user_meta_data ->> 'last_name', ''))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

insert into public.orgs (id, name, created_by) values
  ('e1e10000-a000-4000-8000-0000000000aa', 'P3E1 Org A', 'e1e10000-a000-4000-8000-00000000000a'),
  ('e1e10000-b000-4000-8000-0000000000aa', 'P3E1 Org B', 'e1e10000-b000-4000-8000-00000000000a');

select 'e1e10000-a000-4000-8000-0000000000aa' as org_a \gset
select 'e1e10000-b000-4000-8000-0000000000aa' as org_b \gset

insert into public.profiles (user_id, active_org_id) values
  ('e1e10000-a000-4000-8000-00000000000a', :'org_a'),
  ('e1e10000-a000-4000-8000-00000000000b', :'org_a'),
  ('e1e10000-a000-4000-8000-00000000000c', :'org_a'),
  ('e1e10000-b000-4000-8000-00000000000a', :'org_b');

insert into public.org_members (org_id, user_id, role, status) values
  (:'org_a', 'e1e10000-a000-4000-8000-00000000000a', 'owner', 'active'),
  (:'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'agent', 'active'),
  (:'org_a', 'e1e10000-a000-4000-8000-00000000000c', 'agent', 'active'),
  (:'org_b', 'e1e10000-b000-4000-8000-00000000000a', 'owner', 'active');

-- ===========================================================================================
-- 0. Seeding: every org (existing, from the fixtures above, and org_b) got the 7 defaults.
-- ===========================================================================================

select public._test_expect_count('org_a seeded with exactly the 7 design-§5 defaults',
  format('select count(*) from public.dispositions where org_id = %L', :'org_a'), 7);
select public._test_expect_count('org_b (created after the trigger existed) also seeded',
  format('select count(*) from public.dispositions where org_id = %L', :'org_b'), 7);

insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('e1e12000-a000-4000-8000-00000000000a', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', 'P3E1 Campaign 1', '00:00', '23:59', 3, 120),
         ('e1e12000-a000-4000-8000-00000000000b', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', 'P3E1 Campaign 2', '00:00', '23:59', 3, 120);

insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines) values
  ('e1e14000-a000-4000-8000-00000000000a', :'org_a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e10000-a000-4000-8000-00000000000b', 'wrap_up', 3);

-- ===========================================================================================
-- 1. Every default disposition's lead effect (acceptance #1)
-- ===========================================================================================
-- One contact + campaign_leads row + call_legs row per default disposition key, all on the same
-- session above (irrelevant to this block -- only the per-leg lead effect is under test here).

insert into public.contacts (id, org_id, user_id, phone_number) values
  ('e1e13000-a000-4000-8000-00000000000a', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', '+15551110001'),
  ('e1e13000-a000-4000-8000-00000000000b', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', '+15551110002'),
  ('e1e13000-a000-4000-8000-00000000000c', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', '+15551110003'),
  ('e1e13000-a000-4000-8000-00000000000d', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', '+15551110004'),
  ('e1e13000-a000-4000-8000-00000000000e', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', '+15551110005'),
  ('e1e13000-a000-4000-8000-0000000000a5', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', '+15551110010');

-- attempts here simulates what apply_leg_outcome('connected') already did to a leg that just won
-- and hung up -- TASK-P3-E1 fix-forward item 2 (lead's review, migration 20260924002300):
-- submit_disposition's 'queued' effect must NOT add a second increment on top of this.
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts) values
  ('e1e15000-a000-4000-8000-00000000000a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000a', :'org_a', 'in_flight', 0),
  ('e1e15000-a000-4000-8000-00000000000b', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000b', :'org_a', 'in_flight', 0),
  ('e1e15000-a000-4000-8000-00000000000c', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000c', :'org_a', 'in_flight', 0),
  ('e1e15000-a000-4000-8000-00000000000d', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000d', :'org_a', 'in_flight', 0),
  ('e1e15000-a000-4000-8000-00000000000e', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000e', :'org_a', 'in_flight', 1),
  -- Campaign 1's max_attempts is 3 -- already AT the max (apply_leg_outcome's own increment
  -- brought it here), so a 'queued'-effect disposition on this one must exhaust, not requeue.
  ('e1e15000-a000-4000-8000-0000000000a5', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-0000000000a5', :'org_a', 'in_flight', 3);

insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state) values
  ('e1e16000-a000-4000-8000-00000000000a', :'org_a', 'e1e14000-a000-4000-8000-00000000000a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000a', 'e1e15000-a000-4000-8000-00000000000a', 'contact', 'p3e1-leg-interested', 'ended'),
  ('e1e16000-a000-4000-8000-00000000000b', :'org_a', 'e1e14000-a000-4000-8000-00000000000a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000b', 'e1e15000-a000-4000-8000-00000000000b', 'contact', 'p3e1-leg-callback', 'ended'),
  ('e1e16000-a000-4000-8000-00000000000c', :'org_a', 'e1e14000-a000-4000-8000-00000000000a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000c', 'e1e15000-a000-4000-8000-00000000000c', 'contact', 'p3e1-leg-wrongnum', 'ended'),
  ('e1e16000-a000-4000-8000-00000000000d', :'org_a', 'e1e14000-a000-4000-8000-00000000000a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000d', 'e1e15000-a000-4000-8000-00000000000d', 'contact', 'p3e1-leg-voicemail', 'ended'),
  ('e1e16000-a000-4000-8000-00000000000e', :'org_a', 'e1e14000-a000-4000-8000-00000000000a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000e', 'e1e15000-a000-4000-8000-00000000000e', 'contact', 'p3e1-leg-noanswer', 'ended'),
  ('e1e16000-a000-4000-8000-0000000000a5', :'org_a', 'e1e14000-a000-4000-8000-00000000000a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-0000000000a5', 'e1e15000-a000-4000-8000-0000000000a5', 'contact', 'p3e1-leg-voicemail-exhausted', 'ended');

select public.submit_disposition('e1e16000-a000-4000-8000-00000000000a', :'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'interested', 'Great chat', null);
select public.submit_disposition('e1e16000-a000-4000-8000-00000000000b', :'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'callback', 'call back later', '2026-10-05T14:00:00Z');
select public.submit_disposition('e1e16000-a000-4000-8000-00000000000c', :'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'wrong_number', null, null);
select public.submit_disposition('e1e16000-a000-4000-8000-00000000000d', :'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'voicemail', null, null);
select public.submit_disposition('e1e16000-a000-4000-8000-00000000000e', :'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'no_answer', null, null);
select public.submit_disposition('e1e16000-a000-4000-8000-0000000000a5', :'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'voicemail', null, null);

select public._test_expect_eq('interested -> lead status completed',
  (select status from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000a'), 'completed');
select public._test_expect_eq('callback -> lead status callback',
  (select status from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000b'), 'callback');
select public._test_expect_eq('callback -> next_attempt_at set to the chosen time',
  (select to_char(next_attempt_at, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000b'),
  '2026-10-05T14:00:00Z');
select public._test_expect_eq('callback -> assigned_agent_id set to the session agent',
  (select assigned_agent_id::text from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000b'), 'e1e10000-a000-4000-8000-00000000000b');
select public._test_expect_eq('wrong_number -> lead status exhausted',
  (select status from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000c'), 'exhausted');
select public._test_expect_eq('voicemail -> lead status queued (fix-forward item 2: not exhausted, since attempts (0) < campaign max_attempts (3))',
  (select status from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000d'), 'queued');
select public._test_expect_eq('voicemail -> attempts NOT incremented again here (fix-forward item 2: apply_leg_outcome already did the one real increment; stays 0)',
  (select attempts::text from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000d'), '0');
select public._test_expect_count('voicemail -> next_attempt_at pushed out by the campaign''s retry_interval_minutes (120), not left <= now() (fix-forward item 2)',
  format('select count(*) from public.campaign_leads where id = %L and next_attempt_at > now() + interval ''100 minutes''', 'e1e15000-a000-4000-8000-00000000000d'), 1);
select public._test_expect_eq('no_answer (manual) -> lead status queued',
  (select status from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000e'), 'queued');
select public._test_expect_eq('no_answer (manual) -> attempts NOT incremented again here (stays 1)',
  (select attempts::text from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000e'), '1');
select public._test_expect_eq('voicemail on a lead already AT max_attempts (3) -> exhausted, not queued (fix-forward item 2)',
  (select status from public.campaign_leads where id = 'e1e15000-a000-4000-8000-0000000000a5'), 'exhausted');
select public._test_expect_eq('voicemail-exhausted -> attempts still not incremented (stays 3)',
  (select attempts::text from public.campaign_leads where id = 'e1e15000-a000-4000-8000-0000000000a5'), '3');
select public._test_expect_count('every submitted leg got disposition_id/dispositioned_by/dispositioned_at stamped',
  format('select count(*) from public.call_legs where id in (%L,%L,%L,%L,%L,%L) and disposition_id is not null and dispositioned_by = %L and dispositioned_at is not null',
    'e1e16000-a000-4000-8000-00000000000a', 'e1e16000-a000-4000-8000-00000000000b', 'e1e16000-a000-4000-8000-00000000000c', 'e1e16000-a000-4000-8000-00000000000d', 'e1e16000-a000-4000-8000-00000000000e', 'e1e16000-a000-4000-8000-0000000000a5',
    'e1e10000-a000-4000-8000-00000000000b'),
  6);

-- ===========================================================================================
-- 2. DNC propagation across campaigns (acceptance #2)
-- ===========================================================================================
-- One contact with a lead in EACH of the two campaigns above; dispositioning the campaign-1 leg
-- as DNC must set contacts.dnc AND flip BOTH campaign_leads rows to 'dnc', including the
-- campaign-2 one this leg never touched directly.

insert into public.contacts (id, org_id, user_id, phone_number) values
  ('e1e13000-a000-4000-8000-00000000000f', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', '+15551110006');
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts) values
  ('e1e15000-a000-4000-8000-00000000000f', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000f', :'org_a', 'in_flight', 0),
  ('e1e15000-a000-4000-8000-0000000000a1', 'e1e12000-a000-4000-8000-00000000000b', 'e1e13000-a000-4000-8000-00000000000f', :'org_a', 'completed', 3);
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state) values
  ('e1e16000-a000-4000-8000-00000000000f', :'org_a', 'e1e14000-a000-4000-8000-00000000000a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-00000000000f', 'e1e15000-a000-4000-8000-00000000000f', 'contact', 'p3e1-leg-dnc', 'ended');

select public.submit_disposition('e1e16000-a000-4000-8000-00000000000f', :'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'dnc', 'asked to be removed', null);

select public._test_expect_eq('dnc -> contacts.dnc set true', (select dnc::text from public.contacts where id = 'e1e13000-a000-4000-8000-00000000000f'), 'true');
select public._test_expect_eq('dnc -> the dispositioned campaign''s own lead is dnc',
  (select status from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000f'), 'dnc');
select public._test_expect_eq('dnc -> the OTHER campaign''s lead for the same contact is also dnc (cross-campaign propagation, even though it was already completed)',
  (select status from public.campaign_leads where id = 'e1e15000-a000-4000-8000-0000000000a1'), 'dnc');

-- ===========================================================================================
-- 3. Re-submit idempotency (acceptance #3): a second call updates notes/disposition but does
--    NOT double-apply the lead effect (attempts stays +1, not +2) or double-enqueue.
-- ===========================================================================================

select attempts as voicemail_attempts_before from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000d' \gset
select next_attempt_at as voicemail_next_attempt_before from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000d' \gset
select public.submit_disposition('e1e16000-a000-4000-8000-00000000000d', :'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'voicemail', 'updated note text', null);
select public._test_expect_eq('re-submit: attempts unchanged (no double-apply)',
  (select attempts::text from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000d'), :'voicemail_attempts_before');
select public._test_expect_eq('re-submit: next_attempt_at NOT pushed out a second time (the effect block was truly skipped, not coincidentally identical)',
  (select next_attempt_at::text from public.campaign_leads where id = 'e1e15000-a000-4000-8000-00000000000d'), :'voicemail_next_attempt_before');
select public._test_expect_eq('re-submit: notes ARE updated on the leg',
  (select notes from public.call_legs where id = 'e1e16000-a000-4000-8000-00000000000d'), 'updated note text');
select public._test_expect_count('re-submit: still exactly one crm_sync_jobs row for this leg (enqueue dedupe)',
  format('select count(*) from public.crm_sync_jobs where call_leg_id = %L', 'e1e16000-a000-4000-8000-00000000000d'), 0);
-- (0, not 1: org_a has no connected GHL integration -- see block 5 below. The dedupe-on-resubmit
-- behavior itself is already covered by 20260924001200's own test suite; this just confirms
-- calling enqueue_crm_job a second time here doesn't error or create a second row either.)

-- ===========================================================================================
-- 4. An agent can't disposition another agent's leg (acceptance #4)
-- ===========================================================================================

insert into public.contacts (id, org_id, user_id, phone_number) values
  ('e1e13000-a000-4000-8000-0000000000a2', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', '+15551110007');
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts) values
  ('e1e15000-a000-4000-8000-0000000000a2', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-0000000000a2', :'org_a', 'in_flight', 0);
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state) values
  ('e1e16000-a000-4000-8000-0000000000a2', :'org_a', 'e1e14000-a000-4000-8000-00000000000a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-0000000000a2', 'e1e15000-a000-4000-8000-0000000000a2', 'contact', 'p3e1-leg-notmine', 'ended');

-- session e1e14000-...a's own agent is agent1 (...000b); agent2 (...000c) is a different active
-- agent in the same org, not this session's owner.
select public._test_expect_error('agent2 (not this session''s agent) cannot submit a disposition for it',
  format('select public.submit_disposition(%L, %L, %L, %L, %L, %L)',
    'e1e16000-a000-4000-8000-0000000000a2', :'org_a', 'e1e10000-a000-4000-8000-00000000000c', 'interested', null, null));

-- The owner (admin+) CAN, even though they are not the session's own agent -- "the leg's agent,
-- or admin+" (the task's own wording).
select public.submit_disposition('e1e16000-a000-4000-8000-0000000000a2', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', 'interested', null, null);
select public._test_expect_eq('owner (admin+) CAN disposition a leg belonging to a different agent''s session',
  (select status from public.campaign_leads where id = 'e1e15000-a000-4000-8000-0000000000a2'), 'completed');

-- ===========================================================================================
-- 5. Callback assignee must be an active org member (lead's review note, task log 22:34)
-- ===========================================================================================

insert into public.contacts (id, org_id, user_id, phone_number) values
  ('e1e13000-a000-4000-8000-0000000000a3', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', '+15551110008');
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts) values
  ('e1e15000-a000-4000-8000-0000000000a3', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-0000000000a3', :'org_a', 'in_flight', 0);
insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines) values
  ('e1e14000-a000-4000-8000-00000000000d', :'org_a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e10000-a000-4000-8000-00000000000c', 'wrap_up', 3);
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state) values
  ('e1e16000-a000-4000-8000-0000000000a3', :'org_a', 'e1e14000-a000-4000-8000-00000000000d', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-0000000000a3', 'e1e15000-a000-4000-8000-0000000000a3', 'contact', 'p3e1-leg-disabled-agent', 'ended');

update public.org_members set status = 'disabled' where org_id = :'org_a' and user_id = 'e1e10000-a000-4000-8000-00000000000c';

select public._test_expect_error('callback cannot be assigned to a disabled agent (session''s own agent got disabled mid-session)',
  format('select public.submit_disposition(%L, %L, %L, %L, %L, %L)',
    'e1e16000-a000-4000-8000-0000000000a3', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', 'callback', null, '2026-10-06T10:00:00Z'));
-- A non-callback disposition on the same leg is unaffected by the assignee check (it doesn't
-- touch assigned_agent_id at all) -- but the caller-identity check now ALSO fails for agent2
-- (the disabled row makes them no longer an active member at all), so use the owner instead,
-- proving the callback-specific guard (not a blanket "any disabled member anywhere" failure) is
-- what fired above.
select public.submit_disposition('e1e16000-a000-4000-8000-0000000000a3', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', 'wrong_number', null, null);
select public._test_expect_eq('non-callback disposition on the same leg still succeeds (guard is callback-specific)',
  (select status from public.campaign_leads where id = 'e1e15000-a000-4000-8000-0000000000a3'), 'exhausted');

-- ===========================================================================================
-- 6. Unknown/inactive disposition key is rejected
-- ===========================================================================================

select public._test_expect_error('unknown disposition key is rejected',
  format('select public.submit_disposition(%L, %L, %L, %L, %L, %L)',
    'e1e16000-a000-4000-8000-00000000000a', :'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'not_a_real_key', null, null));

update public.dispositions set active = false where org_id = :'org_a' and key = 'not_interested';
insert into public.contacts (id, org_id, user_id, phone_number) values
  ('e1e13000-a000-4000-8000-0000000000a4', :'org_a', 'e1e10000-a000-4000-8000-00000000000a', '+15551110009');
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts) values
  ('e1e15000-a000-4000-8000-0000000000a4', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-0000000000a4', :'org_a', 'in_flight', 0);
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state) values
  ('e1e16000-a000-4000-8000-0000000000a4', :'org_a', 'e1e14000-a000-4000-8000-00000000000a', 'e1e12000-a000-4000-8000-00000000000a', 'e1e13000-a000-4000-8000-0000000000a4', 'e1e15000-a000-4000-8000-0000000000a4', 'contact', 'p3e1-leg-inactive-disp', 'ended');
select public._test_expect_error('a deactivated disposition key is rejected (an admin turned it off mid-flight)',
  format('select public.submit_disposition(%L, %L, %L, %L, %L, %L)',
    'e1e16000-a000-4000-8000-0000000000a4', :'org_a', 'e1e10000-a000-4000-8000-00000000000b', 'not_interested', null, null));

-- ===========================================================================================
-- 7. An outbox row exists only when GHL is connected (acceptance #5)
-- ===========================================================================================
-- org_a (above) has no org_integrations row at all -- block 3's re-submit test already showed 0
-- crm_sync_jobs rows for org_a. org_b gets a 'connected' integration and its own full fixture set.

insert into public.org_integrations (org_id, provider, status, location_id) values (:'org_b', 'ghl', 'connected', 'loc-p3e1-b');
insert into public.campaigns (id, org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('e1e12000-b000-4000-8000-00000000000a', :'org_b', 'e1e10000-b000-4000-8000-00000000000a', 'P3E1 Org B Campaign', '00:00', '23:59', 3, 120);
insert into public.dial_sessions (id, org_id, campaign_id, agent_id, state, lines) values
  ('e1e14000-b000-4000-8000-00000000000a', :'org_b', 'e1e12000-b000-4000-8000-00000000000a', 'e1e10000-b000-4000-8000-00000000000a', 'wrap_up', 3);
insert into public.contacts (id, org_id, user_id, phone_number) values
  ('e1e13000-b000-4000-8000-00000000000a', :'org_b', 'e1e10000-b000-4000-8000-00000000000a', '+15552220001');
insert into public.campaign_leads (id, campaign_id, contact_id, org_id, status, attempts) values
  ('e1e15000-b000-4000-8000-00000000000a', 'e1e12000-b000-4000-8000-00000000000a', 'e1e13000-b000-4000-8000-00000000000a', :'org_b', 'in_flight', 0);
insert into public.call_legs (id, org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state, duration_seconds) values
  ('e1e16000-b000-4000-8000-00000000000a', :'org_b', 'e1e14000-b000-4000-8000-00000000000a', 'e1e12000-b000-4000-8000-00000000000a', 'e1e13000-b000-4000-8000-00000000000a', 'e1e15000-b000-4000-8000-00000000000a', 'contact', 'p3e1-leg-org-b', 'ended', 87);

select public.submit_disposition('e1e16000-b000-4000-8000-00000000000a', :'org_b', 'e1e10000-b000-4000-8000-00000000000a', 'callback', 'org b note', '2026-10-07T09:30:00Z');

select public._test_expect_count('org_b (GHL connected): exactly one crm_sync_jobs row for this leg',
  format('select count(*) from public.crm_sync_jobs where call_leg_id = %L and kind = ''disposition''', 'e1e16000-b000-4000-8000-00000000000a'), 1);
select public._test_expect_eq('org_b outbox payload: disposition_key',
  (select payload ->> 'disposition_key' from public.crm_sync_jobs where call_leg_id = 'e1e16000-b000-4000-8000-00000000000a'), 'callback');
select public._test_expect_eq('org_b outbox payload: ghl_tag carried through from dispositions.ghl_tag',
  (select payload ->> 'ghl_tag' from public.crm_sync_jobs where call_leg_id = 'e1e16000-b000-4000-8000-00000000000a'), 'Callback');
select public._test_expect_eq('org_b outbox payload: creates_task carried through as true for callback',
  (select payload ->> 'creates_task' from public.crm_sync_jobs where call_leg_id = 'e1e16000-b000-4000-8000-00000000000a'), 'true');
select public._test_expect_eq('org_b outbox payload: duration_seconds from the leg',
  (select payload ->> 'duration_seconds' from public.crm_sync_jobs where call_leg_id = 'e1e16000-b000-4000-8000-00000000000a'), '87');
select public._test_expect_eq('org_b outbox payload: recording_url/transcript not built yet, always null',
  (select (payload ->> 'recording_url' is null and payload ->> 'transcript_excerpt' is null)::text
   from public.crm_sync_jobs where call_leg_id = 'e1e16000-b000-4000-8000-00000000000a'), 'true');

rollback;

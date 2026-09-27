-- MISSION-4 TASK-T10: reliability alerts -- stuck dial session + webhook error spike (SEC-7
-- rest). Timestamp from eng1's own assigned range (20260926080000-089999), next unused slot
-- after 080000/080100/080200/080300.
--
-- Both alert TYPES ship DISABLED by default per org (org_reliability_alert_settings, seeded
-- false/false on org create) -- only the alert-record machinery itself (this migration, the
-- cron, the edge function) is "live" from the start; no real org gets a surprise notification
-- until an owner/admin opts in. Delivery reuses the existing generic `notifications` table/bell
-- (TASK-SP's own `listNotifications`/TopNavigation UI) -- no new UI surface needed.
--
-- Thresholds (documented here, not exposed as per-org settings -- the task asks to document
-- them, not make them configurable):
--   - Stuck session: 20 minutes with no session-level OR leg-level activity. Deliberately much
--     longer than the sweeper's own reap windows (60s stuck-leg check, 300s claimed-leg check,
--     run_dialer_sweep, 20260925010000/20260924001700) -- the sweeper should silently resolve
--     ordinary staleness long before 20 minutes; a session still stuck past that point means the
--     sweeper itself isn't helping (a structural problem), not routine dial-loop noise. Also
--     comfortably longer than a normal live conversation's own natural pauses.
--   - Webhook error spike: 5+ processing failures for one org within a 15-minute window. A
--     single stray error is normal internet noise; 5 in 15 minutes for the SAME org points at
--     something systemically broken for that org specifically (revoked Telnyx creds, a code
--     regression, a DB outage) rather than one-off flakiness.
-- Dedup: a stuck session only re-alerts if it recovers (updated_at moves past its own
-- stuck_alerted_at) and then gets stuck again -- never a repeat alert for the same stuck spell.
-- A webhook error spike re-alerts at most once per hour per org, same cadence as the existing
-- low-balance alert (org_spend_settings.last_low_balance_alert_at).

-- =================================================================================================
-- 1. org_reliability_alert_settings: same "member read, owner/admin write, seed-on-org-create +
--    one-time backfill" shape as org_spend_settings (20260925080200).
-- =================================================================================================

create table public.org_reliability_alert_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  stuck_session_alerts_enabled boolean not null default false,
  webhook_error_alerts_enabled boolean not null default false,
  last_webhook_error_alert_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.org_reliability_alert_settings enable row level security;

create policy "org members can view reliability alert settings"
  on public.org_reliability_alert_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert reliability alert settings"
  on public.org_reliability_alert_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update reliability alert settings"
  on public.org_reliability_alert_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create function private.seed_default_reliability_alert_settings(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.org_reliability_alert_settings (org_id)
  values (p_org)
  on conflict (org_id) do nothing;
$$;

create function private.seed_default_reliability_alert_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_reliability_alert_settings(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_reliability_alert_settings
  after insert on public.orgs
  for each row execute function private.seed_default_reliability_alert_settings_trigger();

do $$
declare
  v_org record;
begin
  for v_org in select id from public.orgs loop
    perform private.seed_default_reliability_alert_settings(v_org.id);
  end loop;
end;
$$;

-- =================================================================================================
-- 2. dial_sessions.stuck_alerted_at: per-session dedup for the stuck-session alert -- a session
--    only re-alerts once it recovers (updated_at moves past this) and gets stuck again.
-- =================================================================================================

alter table public.dial_sessions
  add column stuck_alerted_at timestamptz;

comment on column public.dial_sessions.stuck_alerted_at is
  'TASK-T10: set once a stuck-session alert has fired for this session''s CURRENT stuck spell. Only
   re-alerts if updated_at moves past this (the session made real progress) and then goes stale
   again -- never a repeat alert for the same stuck spell.';

-- check_stuck_dial_sessions: SQL decides + flips (same "decide and mark atomically" shape as
-- reap_stale_call_transfers/reap_stale_coaching_sessions) so two concurrent cron runs can never
-- double-alert on the same stuck spell -- whichever call's UPDATE lands first is the one that
-- gets the row back. "No webhook/leg progress" is measured as the LATER of the session's own
-- updated_at (bumped by claim_leg/transition_session -- see dialer_rpcs.sql; apply_leg_outcome
-- itself only ever writes call_legs.outcome_applied_at/campaign_leads, never dial_sessions --
-- review fix-forward, eng2's review-eng2.md NIT, corrected 2026-09-27, checked directly against
-- voicemail_drop.sql's own apply_leg_outcome body)
-- and the most recent call_legs row created for it (a fresh refill is real progress even before
-- any of those RPCs run again) -- deliberately NOT webhook_events (that table has no session_id
-- at all, only call_control_id, and is a pure dedupe log, not an activity signal built for this).
-- Only orgs with stuck_session_alerts_enabled ever appear in the output at all (disabled by
-- default, per this migration's own header).

create function public.check_stuck_dial_sessions(p_stuck_after_seconds int)
returns table (session_id uuid, org_id uuid, agent_id uuid, state text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with candidates as (
    select
      ds.id,
      ds.org_id,
      ds.agent_id,
      ds.state,
      greatest(
        ds.updated_at,
        coalesce(
          (select max(cl.created_at) from public.call_legs cl where cl.session_id = ds.id),
          ds.updated_at
        )
      ) as last_activity
    from public.dial_sessions ds
    join public.org_reliability_alert_settings s
      on s.org_id = ds.org_id and s.stuck_session_alerts_enabled
    where ds.state in ('dialing', 'connecting', 'on_call')
      and (ds.stuck_alerted_at is null or ds.stuck_alerted_at < ds.updated_at)
  ),
  stale as (
    select * from candidates
    where last_activity < now() - make_interval(secs => p_stuck_after_seconds)
  ),
  updated as (
    update public.dial_sessions ds
    set stuck_alerted_at = now()
    from stale
    where ds.id = stale.id
    returning ds.id
  )
  select s.id, s.org_id, s.agent_id, s.state
  from stale s
  join updated u on u.id = s.id;
end;
$$;

revoke all on function public.check_stuck_dial_sessions(int) from public, anon, authenticated;
grant execute on function public.check_stuck_dial_sessions(int) to service_role;

-- =================================================================================================
-- 3. webhook_processing_errors: a pure append log of telnyx-webhook's own top-level catch (a
--    request that PASSED signature verification but threw during actual event processing) --
--    orthogonal to webhook_events (that table is a per-call_control_id dedupe record, inserted
--    by the individual engines, not a failure log; a failure can happen before any engine ever
--    gets far enough to insert one). Written by telnyx-webhook/index.ts itself (a tiny, isolated,
--    additive call in its existing top-level `.catch()`, per the lead's own T10 routing note).
-- =================================================================================================

create table public.webhook_processing_errors (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  event_type text,
  error_message text,
  occurred_at timestamptz not null default now()
);

create index idx_webhook_processing_errors_org_occurred
  on public.webhook_processing_errors (org_id, occurred_at desc);

alter table public.webhook_processing_errors enable row level security;

create policy "owner or admin can view webhook processing errors"
  on public.webhook_processing_errors for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.webhook_processing_errors from anon;

create function public.record_webhook_processing_error(
  p_org uuid,
  p_event_type text,
  p_error_message text
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.webhook_processing_errors (org_id, event_type, error_message)
  values (p_org, p_event_type, left(coalesce(p_error_message, 'unknown error'), 2000));
$$;

revoke all on function public.record_webhook_processing_error(uuid, text, text) from public, anon, authenticated;
grant execute on function public.record_webhook_processing_error(uuid, text, text) to service_role;

-- check_webhook_error_spikes: same "SQL decides + flips (dedup), TS does the best-effort notify"
-- split as check_stuck_dial_sessions above. Only orgs with webhook_error_alerts_enabled are ever
-- counted at all.

create function public.check_webhook_error_spikes(p_window_seconds int, p_threshold int)
returns table (org_id uuid, error_count int)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with counts as (
    select e.org_id, count(*)::int as error_count
    from public.webhook_processing_errors e
    join public.org_reliability_alert_settings s
      on s.org_id = e.org_id and s.webhook_error_alerts_enabled
    where e.occurred_at > now() - make_interval(secs => p_window_seconds)
    group by e.org_id
    having count(*) >= p_threshold
  ),
  due as (
    select c.org_id, c.error_count
    from counts c
    join public.org_reliability_alert_settings s on s.org_id = c.org_id
    where s.last_webhook_error_alert_at is null
      or s.last_webhook_error_alert_at < now() - interval '1 hour'
  ),
  updated as (
    update public.org_reliability_alert_settings s
    set last_webhook_error_alert_at = now()
    from due
    where s.org_id = due.org_id
    returning s.org_id
  )
  select d.org_id, d.error_count
  from due d
  join updated u on u.org_id = d.org_id;
end;
$$;

revoke all on function public.check_webhook_error_spikes(int, int) from public, anon, authenticated;
grant execute on function public.check_webhook_error_spikes(int, int) to service_role;

-- =================================================================================================
-- 4. pg_cron + pg_net: reliability-alert-check, every 5 minutes -- tighter than spend-alert-
--    check's hourly cadence (the task's own 15-minute error-spike window would otherwise go
--    stale for up to ~75 minutes between hourly checks). Same shared-secret shape as every other
--    cron-triggered function in this schema.
-- =================================================================================================

create table private.reliability_alert_config (
  id boolean primary key default true,
  url text,
  secret_secret_id uuid,
  constraint reliability_alert_config_singleton check (id)
);

create function private.set_reliability_alert_config(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select secret_secret_id into v_existing_secret_id
  from private.reliability_alert_config where id = true;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret);
  end if;

  insert into private.reliability_alert_config (id, url, secret_secret_id)
  values (true, p_url, v_secret_id)
  on conflict (id) do update set url = excluded.url, secret_secret_id = excluded.secret_secret_id;
end;
$$;

revoke all on function private.set_reliability_alert_config(text, text) from public;
grant execute on function private.set_reliability_alert_config(text, text) to service_role, postgres;

create function private.trigger_reliability_alert_check()
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
  select url, secret_secret_id into v_url, v_secret_id
  from private.reliability_alert_config where id = true;

  if v_url is null or v_secret_id is null then
    return; -- not configured yet -- no-op, not an error every tick.
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    return;
  end if;

  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
    timeout_milliseconds := 25000
  );
end;
$$;

-- Both extensions are already enabled by 20260925080200, but "explicit, not assumed" per that
-- migration's own header -- cheap and harmless if already on.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('reliability-alert-check', '*/5 * * * *', $$select private.trigger_reliability_alert_check();$$);

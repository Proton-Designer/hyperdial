-- MISSION-4 TASK-S2 (part 1 only tonight -- lines up to 10 + the drop-rate guard. Voicemail
-- rotation / inbound ring group / AUD-4 are explicitly NOT in this migration).
--
-- Lines 8-10 are allowed only while a campaign's own `high_lines_guard_enabled` flag is on -- an
-- owner/admin opts in per campaign (default OFF, per CLAUDE.md's "money/dialing features need
-- server-side guards defaulting off"). A periodic check (below) watches the SAME drop-rate
-- definition TASK-T8's `campaign_drop_rate_summary` uses (dropped+abandoned as a fraction of
-- human answers) over a short trailing window, and if it's over 3% for a campaign currently above
-- 7 lines, snaps it back to 7 and turns the flag back off -- a human must re-enable it after
-- reviewing what happened, not a self-healing toggle. This is why the widened CHECK below ties
-- `lines` and `high_lines_guard_enabled` together on the SAME row: it makes "lines 8-10 without
-- the guard on" impossible at the DB level, not just an app-layer convention that a direct
-- `campaigns` table update (updateCampaignSettings goes straight through PostgREST, no edge
-- function in front of it) could otherwise bypass.
--
-- =================================================================================================
-- 1. campaigns.lines: widen 1-7 -> 1-10, but 8-10 only with the guard on (same-row CHECK, not a
--    trigger -- both columns live on this one table so a plain multi-column CHECK is enough, and
--    it's evaluated against the FINAL row after an UPDATE, so a client can flip both `lines` and
--    `high_lines_guard_enabled` in one `updateCampaignSettings` call).
-- =================================================================================================

alter table public.campaigns
  add column high_lines_guard_enabled boolean not null default false,
  add column high_lines_guard_last_triggered_at timestamptz,
  add column high_lines_guard_last_drop_rate_pct numeric;

-- (lead fix) the constraint must come AFTER the column it references exists
alter table public.campaigns drop constraint campaigns_lines_check;
alter table public.campaigns add constraint campaigns_lines_check
  check (lines between 1 and 7 or (lines between 8 and 10 and high_lines_guard_enabled));

comment on column public.campaigns.high_lines_guard_enabled is
  'MISSION-4 TASK-S2: owner/admin opt-in (default OFF) allowing this campaign''s `lines` to go
   above 7, up to 10. A periodic check (check_high_lines_drop_rate_guard) watches the same T8
   drop-rate definition over a short trailing window and, if it exceeds 3%, sets `lines` back to
   7 AND this flag back to false in the same update -- the campaigns_lines_check constraint makes
   "lines > 7 with this flag off" impossible in the DB, so re-enabling requires deliberately
   raising `lines` again too, not just flipping this flag back on.';

comment on column public.campaigns.high_lines_guard_last_triggered_at is
  'MISSION-4 TASK-S2: when the drop-rate guard last auto-reduced this campaign back to 7 lines,
   if ever. Purely observational history (shown in the UI) -- never cleared automatically, so an
   owner/admin can see it happened even after re-enabling the guard and raising lines again.';

comment on column public.campaigns.high_lines_guard_last_drop_rate_pct is
  'MISSION-4 TASK-S2: the drop rate (0-100) observed at the moment the guard last tripped this
   campaign back to 7 lines. Paired with high_lines_guard_last_triggered_at.';

-- campaigns_with_stats: explicit column list (20260924001500's own header explains why), so a
-- plain ALTER TABLE above does NOT make the 3 new columns selectable through it -- same drop +
-- recreate 20260926080200 (script_text/objection_sheet_text) already had to do, byte-identical
-- except for the 3 new columns in the select list. getCampaign()/listCampaigns() (api.ts) read
-- this view, not the base table, so skipping this step would leave the new columns invisible to
-- the UI while looking done everywhere else -- caught by checking the view's own definition
-- before assuming a plain ALTER TABLE was enough.

drop view public.campaigns_with_stats;

create view public.campaigns_with_stats as
select
  c.id,
  c.user_id,
  c.org_id,
  c.name,
  c.status,
  c.total_calls_made,
  c.connect_rate,
  c.last_called_at,
  c.lines,
  c.amd_mode,
  c.caller_id_number_id,
  c.max_attempts,
  c.retry_interval_minutes,
  c.calling_window_start,
  c.calling_window_end,
  c.abandon_message_enabled,
  c.script_text,
  c.objection_sheet_text,
  c.high_lines_guard_enabled,
  c.high_lines_guard_last_triggered_at,
  c.high_lines_guard_last_drop_rate_pct,
  c.created_at,
  c.updated_at,
  count(cl.id)::integer as total_contacts,
  count(cl.id) filter (where cl.status = 'queued')::integer as queued,
  count(cl.id) filter (where cl.status = 'completed')::integer as completed,
  count(cl.id) filter (where cl.status = 'passthrough')::integer as passthrough
from public.campaigns c
left join public.campaign_leads cl on cl.campaign_id = c.id
where c.deleted_at is null
group by c.id;

alter view public.campaigns_with_stats set (security_invoker = on);

-- =================================================================================================
-- 2. dial_sessions.lines: widen 1-7 -> 1-10. The "8-10 needs the guard" rule itself is enforced by
--    the trigger below (dial_sessions has no client insert policy at all -- every write already
--    goes through startSession/an RPC, so a trigger is the only enforcement point, same reasoning
--    as dial_sessions_require_active_campaign, 20260924001500).
-- =================================================================================================

alter table public.dial_sessions drop constraint dial_sessions_lines_check;
alter table public.dial_sessions add constraint dial_sessions_lines_check
  check (lines between 1 and 10);

-- =================================================================================================
-- 3. Extend the existing dial_sessions BEFORE INSERT trigger (enforce_campaign_active_for_session,
--    20260924001500) to also refuse starting a session with lines > 7 on a campaign whose guard
--    isn't on. `create or replace function` on an already-applied function is the normal way to
--    extend one in a later migration (append-only means never editing the OLD migration FILE, not
--    that a function it created can never change again) -- the trigger itself is untouched, still
--    fires on the same event for the same reason.
-- =================================================================================================

create or replace function private.enforce_campaign_active_for_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_deleted timestamptz;
  v_guard_enabled boolean;
begin
  select status, deleted_at, high_lines_guard_enabled
    into v_status, v_deleted, v_guard_enabled
  from public.campaigns
  where id = new.campaign_id;

  if v_status is null then
    raise exception 'dial_sessions.campaign_id does not reference an existing campaign';
  end if;
  if v_deleted is not null then
    raise exception 'cannot start a dial session for a deleted campaign';
  end if;
  if v_status <> 'active' then
    raise exception 'cannot start a dial session for a % campaign', v_status;
  end if;
  -- MISSION-4 TASK-S2: lines 8-10 require the campaign's own drop-rate guard to be on right now
  -- -- mirrors campaigns_lines_check's same-row rule, applied here since dial_sessions.lines is a
  -- copy taken at session-start time, not read live off campaigns afterward.
  if new.lines > 7 and not coalesce(v_guard_enabled, false) then
    raise exception 'cannot start a session with more than 7 lines unless the campaign''s high-lines drop-rate guard is enabled';
  end if;

  return new;
end;
$$;

-- =================================================================================================
-- 4. check_high_lines_drop_rate_guard: decide + trip atomically (same "decide and mark in one
--    statement" shape as check_stuck_dial_sessions/check_webhook_error_spikes/check_number_health)
--    -- two overlapping cron runs can never double-trip the same campaign. PUBLIC (every
--    supabase.rpc() target must be, per this run's own rule) but revoked from anon/authenticated,
--    called only by the edge function below with the service-role client -- no client ever calls
--    this directly, so no separate role check is needed inside it (same "TS/GRANT gate before the
--    RPC" shape as check_number_health/check_stuck_dial_sessions).
--
--    Window/sample/threshold are hardcoded, not a per-org settings table (unlike
--    org_number_health_settings) -- the 3% threshold is literally this task's own spec, not a
--    tunable, and a campaign-level opt-in flag is already the "server-side guard default off"
--    this feature needs; a 60-minute trailing window with a 10-human-answer minimum sample avoids
--    tripping on a handful of unlucky calls right after enabling the guard.
-- =================================================================================================

create function public.check_high_lines_drop_rate_guard()
returns table (
  campaign_id uuid,
  org_id uuid,
  campaign_name text,
  lines_before smallint,
  human_answers int,
  dropped int,
  drop_rate_pct numeric
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with stats as (
    select
      c.id as campaign_id,
      c.org_id,
      c.name as campaign_name,
      c.lines as lines_before,
      count(cl.id) filter (
        where cl.outcome in ('connected', 'dropped', 'abandoned')
      )::int as human_answers,
      count(cl.id) filter (where cl.outcome in ('dropped', 'abandoned'))::int as dropped
    from public.campaigns c
    join public.call_legs cl
      on cl.campaign_id = c.id
      and cl.kind = 'contact'
      and cl.created_at >= now() - interval '60 minutes'
    where c.lines > 7
      and c.high_lines_guard_enabled
      and c.deleted_at is null
    group by c.id, c.org_id, c.name, c.lines
  ),
  candidates as (
    select
      stats.campaign_id, stats.org_id, stats.campaign_name, stats.lines_before,
      stats.human_answers, stats.dropped,
      round(100.0 * stats.dropped / stats.human_answers, 1) as drop_rate_pct
    from stats
    where stats.human_answers >= 10
      and stats.dropped::numeric / stats.human_answers > 0.03
  ),
  tripped as (
    update public.campaigns c
    set lines = 7,
        high_lines_guard_enabled = false,
        high_lines_guard_last_triggered_at = now(),
        high_lines_guard_last_drop_rate_pct = cand.drop_rate_pct
    from candidates cand
    where c.id = cand.campaign_id
    returning c.id as updated_id
  )
  select
    cand.campaign_id, cand.org_id, cand.campaign_name, cand.lines_before,
    cand.human_answers, cand.dropped, cand.drop_rate_pct
  from candidates cand
  join tripped t on t.updated_id = cand.campaign_id;
end;
$$;

revoke all on function public.check_high_lines_drop_rate_guard() from public, anon, authenticated;
grant execute on function public.check_high_lines_drop_rate_guard() to service_role;

-- =================================================================================================
-- 5. pg_cron + pg_net: campaign-lines-guard-check, every 5 minutes -- same shared-secret/vault
--    config shape as private.trigger_reliability_alert_check/private.set_number_health_check_config
--    (a separate config row/secret, not reused, since it points at a different function URL).
-- =================================================================================================

create table private.high_lines_guard_config (
  id boolean primary key default true,
  url text,
  secret_secret_id uuid,
  constraint high_lines_guard_config_singleton check (id)
);

create function private.set_high_lines_guard_config(p_url text, p_secret text)
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
  from private.high_lines_guard_config where id = true;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret);
  end if;

  insert into private.high_lines_guard_config (id, url, secret_secret_id)
  values (true, p_url, v_secret_id)
  on conflict (id) do update set url = excluded.url, secret_secret_id = excluded.secret_secret_id;
end;
$$;

revoke all on function private.set_high_lines_guard_config(text, text) from public;
grant execute on function private.set_high_lines_guard_config(text, text) to service_role, postgres;

create function private.trigger_high_lines_guard_check()
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
  from private.high_lines_guard_config where id = true;

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

-- Both extensions are already enabled by 20260925080200 -- "explicit, not assumed" per that
-- migration's own header, cheap and harmless if already on.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('campaign-lines-guard-check', '*/5 * * * *', $$select private.trigger_high_lines_guard_check();$$);

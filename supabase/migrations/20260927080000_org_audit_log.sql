-- MISSION-5 TASK-A1: org audit log (who did what, when).
--
-- Two writers, one table:
--   1. `private.log_org_action(...)` -- a SECURITY DEFINER helper, callable from any SQL RPC that
--      already runs as an authenticated caller (e.g. `assign_campaign_leads` below). Defaults
--      `p_actor` to `auth.uid()` so most call sites don't need to pass it explicitly.
--   2. `supabase/functions/_shared/audit.ts`'s `logOrgAction` -- a plain service-role INSERT, for
--      Edge Functions (org-members, org-invite-create, the GHL settings functions, dialer-coaching)
--      that never run a SQL RPC as part of their own write.
-- A third, passive source: the generic settings-change trigger below, attached to every existing
-- per-org settings table an owner/admin can edit directly via RLS (spend/reliability-alert/
-- recording/transfer) -- one trigger function, four `create trigger`s, no per-table code.
--
-- RLS: owner/admin SELECT their own org's rows; NO insert/update/delete policy for any client
-- role at all (both writers above are SECURITY DEFINER / service-role, neither needs a policy;
-- leaving zero write policies means even a raw PostgREST call from a signed-in owner can't insert
-- a fake row -- see contribution-protocol's own convention on `org_integrations`, 20260924000900).
--
-- Retention: keep 1 year, documented here rather than enforced -- no cron needed yet (an org this
-- young generates a trivial row volume; revisit with a scheduled prune once that stops being true).

-- =================================================================================================
-- 1. org_audit_log
-- =================================================================================================

create table public.org_audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- `on delete set null`, not cascade: a removed member's own past actions stay in the log (the
  -- whole point of an audit trail) even after `org-members`' `remove` action hard-deletes their
  -- org_members row (TM-B3/EC-14, per audit/M5/current-state.md) -- only auth.users itself
  -- cascading (a real account deletion, not a Mission-5 feature) would null this out.
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_type text,
  target_id uuid,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_org_audit_log_org_created on public.org_audit_log(org_id, created_at desc);
create index idx_org_audit_log_org_actor on public.org_audit_log(org_id, actor_user_id);
create index idx_org_audit_log_org_action on public.org_audit_log(org_id, action);

alter table public.org_audit_log enable row level security;

create policy "owner or admin can view audit log"
  on public.org_audit_log for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- No insert/update/delete policy for any client role -- see header.

-- =================================================================================================
-- 2. private.log_org_action: the RPC-side writer.
-- =================================================================================================

create function private.log_org_action(
  p_org uuid,
  p_action text,
  p_target_type text default null,
  p_target_id uuid default null,
  p_details jsonb default '{}'::jsonb,
  p_actor uuid default auth.uid()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.org_audit_log (org_id, actor_user_id, action, target_type, target_id, details)
  values (p_org, p_actor, p_action, p_target_type, p_target_id, p_details);
end;
$$;

-- Deliberately NOT granted to `authenticated`, unlike is_org_member/has_org_role: this function
-- takes an arbitrary p_org/p_actor with no role check of its own (it's a plain insert), so a grant
-- to authenticated would let ANY signed-in user forge an audit row in ANY org via a direct
-- supabase.rpc() call -- there is no caller-supplied org membership to check here the way
-- is_org_member's own query provides. `assign_campaign_leads` (SECURITY DEFINER, owned by this
-- migration's role) still reaches it fine without this grant: an internal call from one SECURITY
-- DEFINER function to another runs as the OWNER, which has implicit full privileges on functions
-- it owns -- no EXECUTE grant needed for that call path. Only postgres/service_role can call this
-- directly, same lockdown as org_mtd_billed_seconds (20260925080200).
revoke all on function private.log_org_action(uuid, text, text, uuid, jsonb, uuid) from public, anon, authenticated;

-- =================================================================================================
-- 3. assign_campaign_leads: wire in the one existing RPC named in this task's own requirements.
--    Byte-identical to the live 20260926070003 version except for the one new `perform` line
--    right before `return v_count` -- same signature, same behavior otherwise.
-- =================================================================================================

create or replace function public.assign_campaign_leads(
  p_campaign_id uuid,
  p_agent_id uuid,
  p_filter jsonb default '{"mode": "all"}'::jsonb
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_mode text;
  v_count int;
begin
  select org_id into v_org_id from public.campaigns where id = p_campaign_id;
  if v_org_id is null then
    raise exception 'campaign not found';
  end if;

  if not private.has_org_role(v_org_id, array['owner', 'admin']) then
    raise exception 'only an owner or admin can assign leads';
  end if;

  if p_agent_id is not null and not exists (
    select 1 from public.org_members
    where org_id = v_org_id and user_id = p_agent_id and status = 'active'
  ) then
    raise exception 'target agent is not an active member of this org';
  end if;

  if p_agent_id is not null then
    insert into public.campaign_agents (campaign_id, user_id, org_id)
    values (p_campaign_id, p_agent_id, v_org_id)
    on conflict (campaign_id, user_id) do nothing;
  end if;

  v_mode := coalesce(p_filter ->> 'mode', 'all');
  if v_mode not in ('all', 'range', 'percentage', 'tag') then
    raise exception 'p_filter.mode must be one of: all, range, percentage, tag';
  end if;

  with ranked as (
    select
      cl.id,
      ct.ghl_tags,
      row_number() over (order by cl.position) as rn,
      count(*) over () as total
    from public.campaign_leads cl
    join public.contacts ct on ct.id = cl.contact_id
    where cl.campaign_id = p_campaign_id and cl.status = 'queued'
  ),
  candidates as (
    select r.id
    from ranked r
    where
      v_mode = 'all'
      or (v_mode = 'range'
        and r.rn between (p_filter ->> 'start')::int and (p_filter ->> 'end')::int)
      or (v_mode = 'percentage'
        and r.rn <= ceil(r.total * (p_filter ->> 'percentage')::numeric / 100))
      or (v_mode = 'tag' and r.ghl_tags && array[p_filter ->> 'tag'])
  ),
  updated as (
    update public.campaign_leads cl
    set assigned_agent_id = p_agent_id, updated_at = now()
    from candidates
    where cl.id = candidates.id
    returning cl.id
  )
  select count(*) into v_count from updated;

  -- TASK-A1: log every real assignment (v_count = 0 means the filter matched nothing -- e.g. an
  -- empty/already-fully-assigned queue -- not worth a row of its own).
  if v_count > 0 then
    perform private.log_org_action(
      v_org_id,
      'campaign_leads.assign',
      'campaign',
      p_campaign_id,
      jsonb_build_object('agent_id', p_agent_id, 'filter', p_filter, 'lead_count', v_count)
    );
  end if;

  return v_count;
end;
$$;

revoke all on function public.assign_campaign_leads(uuid, uuid, jsonb) from public, anon;
grant execute on function public.assign_campaign_leads(uuid, uuid, jsonb) to authenticated;

-- =================================================================================================
-- 4. Generic settings-change audit trigger: attached to every EXISTING per-org settings table an
--    owner/admin can write directly via RLS (no edge function in between). Fires on INSERT (a
--    real first-time user save, distinct from the system's own seed-on-org-create insert, which
--    never runs under 'authenticated' -- see the role guard below) and UPDATE.
--
-- Guard: `auth.role() is distinct from 'authenticated'` skips every system/service-role write --
-- the seed-on-org-create triggers (org_spend_settings, org_reliability_alert_settings) and any
-- future migration backfill. Only a real signed-in client's own RLS-gated write is ever logged --
-- same "scope the exemption by what kind of caller it is" pattern as contacts_agent_update_scope
-- (TASK-P2-P1, see LANE-eng1.md), not an allowlist of specific roles.
--
-- No-op on a no-change UPDATE (e.g. a re-save with identical values) to keep the log meaningful.
-- =================================================================================================

create function private.audit_log_settings_change_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
begin
  if auth.role() is distinct from 'authenticated' then
    return coalesce(new, old);
  end if;
  -- Every one of these tables' own client-side save (api.ts) always stamps a fresh `updated_at`
  -- on every upsert, even a re-save of identical values -- comparing the whole row would defeat
  -- this no-op guard in practice (the ONE column that always ticks is exactly the one to ignore),
  -- so it's excluded here rather than compared. Same "allowlist/denylist the one column that
  -- doesn't count" shape as contacts_agent_update_scope's own trigger (TASK-P2-P1).
  if tg_op = 'UPDATE' and (to_jsonb(new) - 'updated_at') = (to_jsonb(old) - 'updated_at') then
    return new;
  end if;

  v_org_id := coalesce(new.org_id, old.org_id);
  perform private.log_org_action(
    v_org_id,
    tg_argv[0],
    tg_argv[1],
    v_org_id,
    case when tg_op = 'INSERT'
      then jsonb_build_object('new', to_jsonb(new))
      else jsonb_build_object('old', to_jsonb(old), 'new', to_jsonb(new))
    end
  );
  return coalesce(new, old);
end;
$$;

create trigger org_spend_settings_audit
  after insert or update on public.org_spend_settings
  for each row execute function private.audit_log_settings_change_trigger('settings.spend.update', 'org_spend_settings');

create trigger org_reliability_alert_settings_audit
  after insert or update on public.org_reliability_alert_settings
  for each row execute function private.audit_log_settings_change_trigger('settings.reliability_alerts.update', 'org_reliability_alert_settings');

create trigger org_recording_settings_audit
  after insert or update on public.org_recording_settings
  for each row execute function private.audit_log_settings_change_trigger('settings.recording.update', 'org_recording_settings');

create trigger org_transfer_settings_audit
  after insert or update on public.org_transfer_settings
  for each row execute function private.audit_log_settings_change_trigger('settings.transfer.update', 'org_transfer_settings');

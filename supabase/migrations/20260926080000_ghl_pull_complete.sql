-- MISSION-4 TASK-T1: GHL pull complete (GHL-3,4,5,6,8).
--
-- GHL-3: contacts already have ghl_contact_id (20260924001600) and ghl_tags (20260925080000).
-- This adds the rest: the pipeline stage's human name, mapped custom fields, and the assigned
-- owner resolved to an org member (all three: see _shared/ghl-import.ts's `GhlImportEnrichment`
-- and `GhlImportContactFields` for how they're populated -- never guessed, always either a real
-- resolved value or simply absent).
--
-- GHL-6: `org_integrations.ghl_field_mapping` -- the org's own GHL-custom-field-id -> our target
-- key mapping (business_name, website, rating, review_count, license_number, service_zips, tier,
-- list_source, ...; an open-ended jsonb object, not a fixed enum of columns, so a future target
-- key never needs a migration). "Sensible defaults by field name" is a server-side computation
-- (ghl-pull-run.ts, name-matching against `listContactCustomFieldDefs`), not a stored default
-- here -- there is nothing to default to until the org's OWN custom field ids exist, which
-- happens only after they connect GHL.
--
-- GHL-4: org_ghl_campaign_mappings -- tag|stage -> campaign, admin-editable, same direct-RLS
-- shape as campaigns/campaign_retry_rules (20260924000300/20260925030000) -- this is ordinary
-- per-org config data, not a secret-bearing table like org_integrations, so it gets real client
-- policies instead of the service-role-only-write pattern.
--
-- GHL-5: org_integrations gains ghl_pull_enabled (disabled by default, per the mission's own
-- "new automatic behaviour that would act on real orgs ships DISABLED by default" rule) plus
-- last-run bookkeeping (cursor/at/status/counts), and the pg_cron+pg_net scheduled trigger --
-- same shared-secret shape as spend-alert-check/recording-retention/dialer-sweeper/
-- ghl-sync-worker (20260925080200's own header has the fullest description of this pattern).
--
-- GHL-8: org_members.ghl_user_id -- owner/admin sets this per member (Team page); the dialer's
-- own queueing/assignment logic never reads it (GHL-8's explicit "the dialer never assigns
-- owners itself") -- it only flows into contacts.assigned_user_id as informational metadata.

-- ---------------------------------------------------------------------------------------------
-- contacts: pipeline stage, custom fields, assigned owner
-- ---------------------------------------------------------------------------------------------

alter table public.contacts
  add column ghl_pipeline_stage text,
  add column ghl_custom_fields jsonb,
  add column assigned_user_id uuid references auth.users(id) on delete set null;

-- ---------------------------------------------------------------------------------------------
-- org_members: GHL-8's per-member mapping. Unique per org (not global -- two different orgs'
-- GHL sub-accounts can reuse the same user id space with no relation to each other), ignoring
-- nulls (an unmapped member never conflicts with anything, same partial-unique-index shape as
-- org_billing_events.idempotency_key, 20260925080300).
-- ---------------------------------------------------------------------------------------------

alter table public.org_members add column ghl_user_id text;

create unique index org_members_org_ghl_user_id_key
  on public.org_members (org_id, ghl_user_id)
  where ghl_user_id is not null;

-- ---------------------------------------------------------------------------------------------
-- org_integrations: GHL-5/6 settings + last-pull bookkeeping.
-- ---------------------------------------------------------------------------------------------

alter table public.org_integrations
  add column ghl_pull_enabled boolean not null default false,
  add column ghl_pull_cursor timestamptz,
  add column ghl_last_pull_at timestamptz,
  add column ghl_last_pull_status text check (ghl_last_pull_status in ('ok', 'error')),
  add column ghl_last_pull_counts jsonb,
  add column ghl_field_mapping jsonb not null default '{}'::jsonb;

create or replace view public.org_integrations_status
  with (security_invoker = false)
  as
  select
    i.org_id,
    i.provider,
    i.status,
    i.token_last4,
    i.location_id,
    i.connected_at,
    i.ghl_dnc_tags,
    i.ghl_paused_tags,
    i.ghl_pull_enabled,
    i.ghl_last_pull_at,
    i.ghl_last_pull_status,
    i.ghl_last_pull_counts,
    i.ghl_field_mapping
  from public.org_integrations i
  where private.is_org_member(i.org_id);

-- Same belt-and-braces revokes 20260925080000 added when it last recreated this view (Postgres
-- doesn't preserve grants/revokes across create-or-replace) -- a security_invoker=false view
-- over a zero-client-policy base table is only safe for SELECT; write access must stay revoked
-- every time this view is recreated, not just the first time.
revoke insert, update, delete, truncate, trigger, references
  on public.org_integrations_status from anon, authenticated;
revoke select on public.org_integrations_status from anon;
grant select on public.org_integrations_status to authenticated;

-- Owner/admin-only settings write, same private/public SECURITY DEFINER wrapper split as
-- set_org_ghl_blocked_tags (20260925080000) -- requires an existing org_integrations row.

create function private.set_org_ghl_pull_settings(
  p_org uuid,
  p_pull_enabled boolean,
  p_field_mapping jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.org_integrations
  set ghl_pull_enabled = p_pull_enabled,
      ghl_field_mapping = p_field_mapping,
      updated_at = now()
  where org_id = p_org and provider = 'ghl';

  if not found then
    raise exception 'org % has no GHL integration to configure', p_org;
  end if;
end;
$$;

revoke all on function private.set_org_ghl_pull_settings(uuid, boolean, jsonb) from public;
grant execute on function private.set_org_ghl_pull_settings(uuid, boolean, jsonb) to service_role;

create function public.set_org_ghl_pull_settings(
  p_org uuid,
  p_pull_enabled boolean,
  p_field_mapping jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.set_org_ghl_pull_settings(p_org, p_pull_enabled, p_field_mapping);
end;
$$;

revoke all on function public.set_org_ghl_pull_settings(uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.set_org_ghl_pull_settings(uuid, boolean, jsonb) to service_role;

-- Service-role write for the pull worker/on-demand sync itself to record the outcome of a run
-- (cursor advance + last-pull bookkeeping) -- never exposed to a client at all.

create function public.record_ghl_pull_result(
  p_org uuid,
  p_cursor timestamptz,
  p_status text,
  p_counts jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.org_integrations
  set ghl_pull_cursor = coalesce(p_cursor, ghl_pull_cursor),
      ghl_last_pull_at = now(),
      ghl_last_pull_status = p_status,
      ghl_last_pull_counts = p_counts,
      updated_at = now()
  where org_id = p_org and provider = 'ghl';
end;
$$;

revoke all on function public.record_ghl_pull_result(uuid, timestamptz, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_ghl_pull_result(uuid, timestamptz, text, jsonb) to service_role;

-- ---------------------------------------------------------------------------------------------
-- org_ghl_campaign_mappings: GHL-4's tag|stage -> campaign map. Ordinary per-org config data,
-- direct client RLS (owner/admin write, org member read) -- same shape as campaign_retry_rules.
-- ---------------------------------------------------------------------------------------------

create table public.org_ghl_campaign_mappings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  match_type text not null check (match_type in ('tag', 'stage')),
  tag text,
  pipeline_id text,
  pipeline_stage_id text,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- Review fix-forward (eng2, audit/T1/review-eng2.md #3): the incremental pull cursor must be
  -- PER MAPPING, not one shared org-wide value (org_integrations.ghl_pull_cursor below stays as
  -- informational last-seen bookkeeping only). A single org-wide cursor let a fast-moving
  -- mapping's own max dateUpdated silently advance the cutoff past a slower mapping's own
  -- not-yet-processed contacts on the NEXT run. Null means "no cursor yet" -- process everything
  -- fetched, same semantics runGhlPullMapping's own sinceDate already had.
  ghl_pull_cursor timestamptz,
  constraint org_ghl_campaign_mappings_shape check (
    (match_type = 'tag' and tag is not null and pipeline_stage_id is null)
    or
    (match_type = 'stage' and pipeline_stage_id is not null and tag is null)
  )
);

-- One campaign per tag/stage per org -- two different campaigns claiming the same tag would make
-- "the campaign mapped to that tag" (the task's own singular wording) ambiguous. A stage id is
-- assumed globally unique within a GHL location (verified: GHL's own opportunity-search examples
-- use uuid-shaped stage ids, never small sequential ones), so it alone (not pipeline_id) is the
-- uniqueness key for stage mappings.
create unique index org_ghl_campaign_mappings_org_tag_key
  on public.org_ghl_campaign_mappings (org_id, tag)
  where match_type = 'tag';
create unique index org_ghl_campaign_mappings_org_stage_key
  on public.org_ghl_campaign_mappings (org_id, pipeline_stage_id)
  where match_type = 'stage';
create index idx_org_ghl_campaign_mappings_org_id on public.org_ghl_campaign_mappings(org_id);

alter table public.org_ghl_campaign_mappings enable row level security;

create policy "org members can view org_ghl_campaign_mappings"
  on public.org_ghl_campaign_mappings for select
  using (private.is_org_member(org_id));

create policy "admin can insert org_ghl_campaign_mappings"
  on public.org_ghl_campaign_mappings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "admin can update org_ghl_campaign_mappings"
  on public.org_ghl_campaign_mappings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "admin can delete org_ghl_campaign_mappings"
  on public.org_ghl_campaign_mappings for delete
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- ---------------------------------------------------------------------------------------------
-- pg_cron + pg_net: ghl-pull-worker, every 5 minutes (GHL-5). Same shared-secret shape as
-- spend-alert-check (20260925080200) -- a Vault-stored secret checked via X-Cron-Secret, silent
-- no-op until private.set_ghl_pull_worker_config(url, secret) is called live.
-- ---------------------------------------------------------------------------------------------

create table private.ghl_pull_worker_config (
  id boolean primary key default true,
  url text,
  secret_secret_id uuid,
  constraint ghl_pull_worker_config_singleton check (id)
);

create function private.set_ghl_pull_worker_config(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select secret_secret_id into v_existing_secret_id from private.ghl_pull_worker_config where id = true;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret);
  end if;

  insert into private.ghl_pull_worker_config (id, url, secret_secret_id)
  values (true, p_url, v_secret_id)
  on conflict (id) do update set url = excluded.url, secret_secret_id = excluded.secret_secret_id;
end;
$$;

revoke all on function private.set_ghl_pull_worker_config(text, text) from public;
grant execute on function private.set_ghl_pull_worker_config(text, text) to service_role, postgres;

create function private.trigger_ghl_pull_worker()
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
  select url, secret_secret_id into v_url, v_secret_id from private.ghl_pull_worker_config where id = true;

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

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('ghl-pull-worker', '*/5 * * * *', $$select private.trigger_ghl_pull_worker();$$);

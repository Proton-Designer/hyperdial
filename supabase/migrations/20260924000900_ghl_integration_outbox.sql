-- GHL connect storage + push outbox (design §6). TASK-P3-P1.
-- Depends on private.is_org_member / private.has_org_role (20260924000100) and the
-- "public service_role-only wrapper" pattern 20260924000500 establishes for reaching
-- Vault-backed private.* functions from a service-role edge function (PostgREST only
-- exposes "public"/"graphql_public", and service_role was never granted USAGE on
-- "private" -- see that migration's own header for the full story). Same shape here:
-- the token itself only ever lives in Vault + the two private.* functions below.

-- org_integrations -----------------------------------------------------------------
-- One row per (org, provider); Stage 1 only ever writes provider='ghl', but the PK
-- shape leaves room for a second CRM provider later without a schema change.
-- Deliberately no client policies at all, same reasoning as org_telephony
-- (20260924000400): the token's presence/absence and last4 are only ever readable
-- through the safe view below.

create table public.org_integrations (
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null check (provider in ('ghl')),
  token_secret_id uuid,
  token_last4 text,
  location_id text,
  status text not null default 'disconnected'
    check (status in ('disconnected', 'pending_verification', 'connected', 'error')),
  connected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (org_id, provider)
);

alter table public.org_integrations enable row level security;
-- No policies: RLS with zero policies denies every client-side select/insert/update/
-- delete. Service-role queries (the only writer/reader today) bypass RLS entirely.

create view public.org_integrations_status
  with (security_invoker = false)
  as
  select
    i.org_id,
    i.provider,
    i.status,
    i.token_last4,
    i.location_id,
    i.connected_at
  from public.org_integrations i
  where private.is_org_member(i.org_id);

grant select on public.org_integrations_status to authenticated;

-- Vault-backed token storage, same shape as private.set_org_telnyx_key/get_org_telnyx_key
-- (20260924000400): the token never leaves these two functions, and only public wrappers
-- (below) are reachable from a service-role edge function.

create function private.set_org_ghl_token(p_org uuid, p_token text, p_location_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select token_secret_id into v_existing_secret_id
  from public.org_integrations
  where org_id = p_org and provider = 'ghl';

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_token);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_token, 'org_ghl_token_' || p_org::text);
  end if;

  insert into public.org_integrations (org_id, provider, token_secret_id, token_last4, location_id, status, connected_at)
  values (p_org, 'ghl', v_secret_id, right(p_token, 4), p_location_id, 'connected', now())
  on conflict (org_id, provider) do update
    set token_secret_id = excluded.token_secret_id,
        token_last4 = excluded.token_last4,
        location_id = excluded.location_id,
        status = 'connected',
        connected_at = now(),
        updated_at = now();
end;
$$;

revoke all on function private.set_org_ghl_token(uuid, text, text) from public;
grant execute on function private.set_org_ghl_token(uuid, text, text) to service_role;

create function private.get_org_ghl_token(p_org uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_token text;
begin
  select token_secret_id into v_secret_id
  from public.org_integrations
  where org_id = p_org and provider = 'ghl' and status = 'connected';

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_token
  from vault.decrypted_secrets
  where id = v_secret_id;

  return v_token;
end;
$$;

revoke all on function private.get_org_ghl_token(uuid) from public;
grant execute on function private.get_org_ghl_token(uuid) to service_role;

-- Public wrappers so PostgREST/`.rpc()` from a service-role edge function can reach
-- the private.* functions above -- see 20260924000500's header for why this indirection
-- is necessary rather than exposing "private" itself.

create function public.set_org_ghl_token(p_org uuid, p_token text, p_location_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.set_org_ghl_token(p_org, p_token, p_location_id);
end;
$$;

revoke all on function public.set_org_ghl_token(uuid, text, text) from public, anon, authenticated;
grant execute on function public.set_org_ghl_token(uuid, text, text) to service_role;

create function public.get_org_ghl_token(p_org uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.get_org_ghl_token(p_org);
end;
$$;

revoke all on function public.get_org_ghl_token(uuid) from public, anon, authenticated;
grant execute on function public.get_org_ghl_token(uuid) to service_role;

-- crm_sync_jobs ----------------------------------------------------------------------
-- Push outbox (design §6): one row per GHL side-effect a disposition needs (note, tag,
-- callback task, DND). A pg_cron worker (a later task -- out of scope here, this task
-- only builds the contract + the enqueue RPC) drains queued rows with retry/backoff so
-- a GHL outage never blocks the dialer. Admin+ get a read-only status view for a future
-- "sync health" screen; no client writes anywhere, matching dial_sessions/call_legs.

create table public.crm_sync_jobs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  provider text not null check (provider in ('ghl')),
  kind text not null check (kind in ('disposition', 'contact_upsert')),
  contact_id uuid references public.contacts(id) on delete set null,
  call_leg_id uuid,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'done', 'failed', 'dead')),
  attempts int not null default 0,
  next_run_at timestamptz not null default now(),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- call_leg_id intentionally has no FK: TASK-P2-E1's call_legs table exists in this
-- schema, but this migration doesn't take a cross-lane dependency on it (eng2's table,
-- eng2's timestamps) -- it's an opaque reference id the disposition write carries
-- through, not a join target for anything this task builds.

create index idx_crm_sync_jobs_org_id on public.crm_sync_jobs(org_id);
create index idx_crm_sync_jobs_queue on public.crm_sync_jobs(status, next_run_at);

alter table public.crm_sync_jobs enable row level security;

create policy "owner or admin can view crm_sync_jobs"
  on public.crm_sync_jobs for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- enqueue_crm_job: service-role RPC, no-ops (returns null, writes nothing) when the org
-- has no *connected* GHL integration -- design's explicit requirement, so a disposition
-- write from an org that never connected GHL doesn't pile up permanently-failing jobs.

create function public.enqueue_crm_job(
  p_org uuid,
  p_kind text,
  p_contact_id uuid,
  p_call_leg_id uuid,
  p_payload jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_connected boolean;
  v_id uuid;
begin
  select exists (
    select 1 from public.org_integrations
    where org_id = p_org and provider = 'ghl' and status = 'connected'
  ) into v_connected;

  if not v_connected then
    return null;
  end if;

  insert into public.crm_sync_jobs (org_id, provider, kind, contact_id, call_leg_id, payload)
  values (p_org, 'ghl', p_kind, p_contact_id, p_call_leg_id, p_payload)
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.enqueue_crm_job(uuid, text, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.enqueue_crm_job(uuid, text, uuid, uuid, jsonb) to service_role;

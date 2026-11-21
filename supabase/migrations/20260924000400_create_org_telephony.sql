-- BYO Telnyx key storage + provisioning record (design §3). TASK-P1-05.
-- Depends on private.is_org_member / private.has_org_role from
-- 20260924000100_create_org_tenancy_tables.sql. Timestamp assigned by the lead;
-- the lead applies this locally after TASK-P1-01 lands, not eng2.

create extension if not exists supabase_vault cascade;

-- org_telephony -----------------------------------------------------------
-- No client SELECT policy on this table at all -- the key's secret id and the
-- Telnyx resource ids are read only through the safe view below or via the
-- service-role RPCs. The webhook_public_key is not secret (it authenticates
-- Telnyx to us, not the other way around) but still isn't exposed by the base
-- table's RLS to keep the surface area to a single reviewed path.

create table public.org_telephony (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  api_key_secret_id uuid,
  api_key_last4 text,
  webhook_public_key text,
  call_control_app_id text,
  credential_connection_id text,
  outbound_voice_profile_id text,
  status text not null default 'disconnected'
    check (status in ('disconnected', 'pending_verification', 'connected', 'error')),
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.org_telephony enable row level security;
-- Deliberately no policies: RLS with zero policies denies every client-side
-- select/insert/update/delete. Service-role queries (the only writer/reader today)
-- bypass RLS entirely, as always.

-- Safe view for the client (design §3: "status and the last 4 characters of the
-- key"). Deliberately NOT security_invoker, unlike campaigns_with_stats
-- (20260924000300): org_telephony has zero client-facing policies on purpose, so a
-- security_invoker view over it would always return no rows. This view instead runs
-- as its owner (bypasses org_telephony's RLS the same way the SECURITY DEFINER
-- helpers bypass org_members'), and its own WHERE clause -- calling the same
-- is_org_member helper -- is what scopes it to the caller's org. That is the only
-- membership check here; do not add a client policy to the base table instead of
-- fixing this view, or the key's presence/absence becomes queryable more broadly
-- than intended.

create view public.org_telephony_status
  with (security_invoker = false)
  as
  select
    t.org_id,
    t.status,
    t.verified_at,
    t.api_key_last4,
    t.call_control_app_id,
    t.credential_connection_id,
    t.outbound_voice_profile_id
  from public.org_telephony t
  where private.is_org_member(t.org_id);

grant select on public.org_telephony_status to authenticated;

-- Service-role-only RPCs: the key itself never leaves these two functions. -----

create function private.set_org_telnyx_key(p_org uuid, p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select api_key_secret_id into v_existing_secret_id
  from public.org_telephony
  where org_id = p_org;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_key);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_key, 'org_telnyx_key_' || p_org::text);
  end if;

  insert into public.org_telephony (org_id, api_key_secret_id, api_key_last4, status)
  values (p_org, v_secret_id, right(p_key, 4), 'pending_verification')
  on conflict (org_id) do update
    set api_key_secret_id = excluded.api_key_secret_id,
        api_key_last4 = excluded.api_key_last4,
        status = 'pending_verification',
        updated_at = now();
end;
$$;

revoke all on function private.set_org_telnyx_key(uuid, text) from public;
grant execute on function private.set_org_telnyx_key(uuid, text) to service_role;

create function private.get_org_telnyx_key(p_org uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_secret_id uuid;
  v_key text;
begin
  select api_key_secret_id into v_secret_id
  from public.org_telephony
  where org_id = p_org;

  if v_secret_id is null then
    return null;
  end if;

  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where id = v_secret_id;

  return v_key;
end;
$$;

revoke all on function private.get_org_telnyx_key(uuid) from public;
grant execute on function private.get_org_telnyx_key(uuid) to service_role;

-- No updated_at trigger: this project's other tables (contacts, campaigns, orgs)
-- all set updated_at explicitly from the writer rather than via a trigger/extension,
-- and this migration follows that convention. set_org_telnyx_key does the same above;
-- telnyx-connect's status/verified_at writes must do likewise.

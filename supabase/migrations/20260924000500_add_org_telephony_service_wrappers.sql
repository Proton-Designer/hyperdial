-- Fix for TASK-P1-05's eng1 review (2026-09-24): telnyx-connect calls
-- `supabase.rpc('set_org_telnyx_key', ...)`, which PostgREST resolves only against the
-- schemas listed in config.toml's [api].schemas -- "public" and "graphql_public", not
-- "private". Reproduced: `curl .../rest/v1/rpc/set_org_telnyx_key` -> 404 PGRST202.
-- Independently, even a direct SQL caller as service_role fails: 20260924000100 granted
-- `usage on schema private` to `authenticated` only (for the RLS-helper policies), never
-- to `service_role`, so `SET ROLE service_role; SELECT private.set_org_telnyx_key(...)`
-- -> "permission denied for schema private".
--
-- Fix: public-schema SECURITY DEFINER wrappers, owned by the migration role (which owns
-- `private` and therefore has implicit access to it), that just call through to the real
-- private.* functions. PostgREST can resolve a public function by name, and because the
-- wrapper runs as its owner, the missing service_role USAGE grant on `private` stops
-- mattering -- the wrapper never needs its own caller to have that grant.
--
-- Rejected alternative: adding "private" to config.toml's exposed schemas. That would
-- also turn is_org_member/has_org_role/campaign_org_id/etc. into public REST endpoints,
-- which is exactly the closed surface area TASK-P1-01 built the `private` schema to avoid.
-- A public SECURITY DEFINER function exposes only the one call it forwards, nothing else
-- in the schema.
--
-- Append-only: 20260924000400 is not edited. Timestamp assigned by the lead.

create function public.set_org_telnyx_key(p_org uuid, p_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.set_org_telnyx_key(p_org, p_key);
end;
$$;

revoke all on function public.set_org_telnyx_key(uuid, text) from public, anon, authenticated;
grant execute on function public.set_org_telnyx_key(uuid, text) to service_role;

create function public.get_org_telnyx_key(p_org uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  return private.get_org_telnyx_key(p_org);
end;
$$;

revoke all on function public.get_org_telnyx_key(uuid) from public, anon, authenticated;
grant execute on function public.get_org_telnyx_key(uuid) to service_role;

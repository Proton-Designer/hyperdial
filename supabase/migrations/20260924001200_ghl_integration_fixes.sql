-- Fix for the lead's review of 20260924000900 (2026-09-24). Two independent issues:
--
-- 1. private.set_org_ghl_token gave every secret a deterministic name
--    ('org_ghl_token_' || org_id). vault.secrets has a unique index on name WHERE name
--    IS NOT NULL (verified: \d vault.secrets -> "secrets_name_idx" UNIQUE, btree (name)
--    WHERE name IS NOT NULL), so a second vault.create_secret call with that same name
--    collides -- e.g. a disconnect flow that ever clears org_integrations' row (or a
--    race between two concurrent ghl-connect calls, both seeing no existing
--    token_secret_id) would try to create a second secret under the same name and fail.
--    Nothing in this codebase looks a secret up by name, only by token_secret_id, so the
--    name was purely cosmetic. Fix: stop naming it. vault.create_secret's `new_name`
--    already defaults to NULL, and multiple NULLs are exempt from the unique index by
--    definition (WHERE name IS NOT NULL) -- this removes the whole collision class
--    rather than just the one path that surfaced it.
--
-- 2. crm_sync_jobs had no dedupe: enqueue_crm_job would happily insert a second
--    'disposition' row for the same call_leg_id (e.g. a webhook-triggered disposition
--    write retried after a timeout). Add a unique partial index on (call_leg_id, kind)
--    -- partial because contact_upsert jobs carry no call_leg_id and dedupe by a
--    different identity entirely, out of this task's scope -- and make
--    enqueue_crm_job's insert an ON CONFLICT ... DO NOTHING against it. A caller now
--    gets null back both when the org has no connected integration and when this exact
--    (call_leg_id, kind) job already exists; both are "no-op, nothing new to do" from
--    the caller's point of view.
--
-- Append-only: 20260924000900 is not edited. Timestamp assigned by the lead.

create or replace function private.set_org_ghl_token(p_org uuid, p_token text, p_location_id text)
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
    v_secret_id := vault.create_secret(p_token);
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

create unique index idx_crm_sync_jobs_dedupe
  on public.crm_sync_jobs (call_leg_id, kind)
  where call_leg_id is not null;

create or replace function public.enqueue_crm_job(
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
  on conflict (call_leg_id, kind) where call_leg_id is not null do nothing
  returning id into v_id;

  return v_id;
end;
$$;

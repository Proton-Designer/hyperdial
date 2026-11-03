-- TASK-H21: "View as intern". An owner/admin gets a REAL GoTrue session for an agent (minted by the view-as-start Edge Function),
-- read-only. This migration adds the registry of those sessions, the db_pre_request function that makes them read-only, and a
-- trigger that stops a viewed account's password / email being changed. It does NOT switch the pre-request on: that is the
-- separate migration 20261102190100_h21_view_as_pre_request_config.sql (rollout order is in audit/H21/design.md section 9).
-- Nothing here touches existing tables or the dialer.

create table public.view_as_sessions (
  session_id uuid primary key,                       -- auth.sessions.id = the JWT `session_id` claim
  org_id uuid not null references public.orgs(id) on delete cascade,
  viewer_id uuid not null references auth.users(id) on delete cascade,
  target_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  ended_reason text                                  -- 'exit' | 'ended_stale' | 'start_failed'
);
-- The row is kept after the session ends so db_pre_request can still reject its (signature-valid) token until it expires.
create index idx_view_as_sessions_target_open on public.view_as_sessions (target_id) where ended_at is null;
create index idx_view_as_sessions_viewer_target_open on public.view_as_sessions (viewer_id, target_id) where ended_at is null;

alter table public.view_as_sessions enable row level security;
-- No policy for any client role: service role (Edge Functions) and SECURITY DEFINER functions only.
revoke all on public.view_as_sessions from anon, authenticated;

-- =================================================================================================
-- 1. db_pre_request: every PostgREST request calls this once, after the JWT is parsed and before the query runs.
--    anon / service_role / a JWT without session_id: return at once (the dialer engine and every Edge Function write as
--    service_role through PostgREST, so they pay one GUC read and nothing else).
--    A live view-as session: make the transaction read-only. Postgres refuses to flip it back after the first query, so no
--    SECURITY DEFINER function can write; every insert/update/delete/nextval/FOR UPDATE raises 25006.
--    An ended view-as session: PT401 (PostgREST answers 401).
--    A failure of the lookup itself must not take the API down: it logs and makes THIS authenticated request read-only.
-- =================================================================================================
create or replace function public.view_as_pre_request()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_claims text;
  v_sid text;
  v_found boolean := false;
  v_ended timestamptz;
begin
  v_claims := current_setting('request.jwt.claims', true);
  if v_claims is null or v_claims = '' then return; end if;
  begin
    if (v_claims::jsonb ->> 'role') is distinct from 'authenticated' then return; end if;
    v_sid := v_claims::jsonb ->> 'session_id';
    if v_sid is null then return; end if;
    select true, v.ended_at into v_found, v_ended
      from public.view_as_sessions v where v.session_id = v_sid::uuid;
  exception when others then
    raise warning 'view_as_pre_request lookup failed: %', sqlerrm;
    perform set_config('transaction_read_only', 'on', true);
    return;
  end;
  if not coalesce(v_found, false) then return; end if;
  if v_ended is not null then
    raise exception 'view-as session ended' using errcode = 'PT401';
  end if;
  perform set_config('transaction_read_only', 'on', true);
end;
$$;
revoke all on function public.view_as_pre_request() from public;
grant execute on function public.view_as_pre_request() to anon, authenticated, service_role;

-- =================================================================================================
-- 2. End a view-as session (service role only): marks the row and deletes the GoTrue session (and with it its refresh tokens).
--    Idempotent. Returns the row so the Edge Function can audit it.
-- =================================================================================================
create or replace function public.view_as_end(p_session_id uuid, p_reason text)
returns table (org_id uuid, viewer_id uuid, target_id uuid, was_open boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.view_as_sessions%rowtype;
  v_was_open boolean;
begin
  select * into v_row from public.view_as_sessions s where s.session_id = p_session_id for update;
  if not found then return; end if;
  v_was_open := v_row.ended_at is null;
  if v_was_open then
    update public.view_as_sessions s
       set ended_at = now(), ended_reason = coalesce(p_reason, 'exit')
     where s.session_id = p_session_id;
  end if;
  delete from auth.sessions where id = p_session_id;
  return query select v_row.org_id, v_row.viewer_id, v_row.target_id, v_was_open;
end;
$$;
revoke all on function public.view_as_end(uuid, text) from public, anon, authenticated;
grant execute on function public.view_as_end(uuid, text) to service_role;

-- A tab closed without Exit leaves ended_at null. A session whose GoTrue row is gone, or not refreshed for 2 hours (its access
-- token is dead by then), is stale. view-as-start calls this for the same viewer + target before minting a new session.
create or replace function public.view_as_close_stale(p_viewer uuid, p_target uuid)
returns table (session_id uuid, org_id uuid)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r record;
begin
  for r in
    select v.session_id as sid, v.org_id as oid
      from public.view_as_sessions v
     where v.viewer_id = p_viewer and v.target_id = p_target and v.ended_at is null
       and not exists (
         select 1 from auth.sessions s
          where s.id = v.session_id
            and coalesce(s.refreshed_at, s.created_at) > now() - interval '2 hours')
  loop
    perform public.view_as_end(r.sid, 'ended_stale');
    session_id := r.sid;
    org_id := r.oid;
    return next;
  end loop;
end;
$$;
revoke all on function public.view_as_close_stale(uuid, uuid) from public, anon, authenticated;
grant execute on function public.view_as_close_stale(uuid, uuid) to service_role;

-- =================================================================================================
-- 3. A viewed account's password / email cannot be changed while a LIVE view-as session exists (GoTrue PUT /user with the view
--    token cannot be restricted any other way). Live = row not ended AND its GoTrue session refreshed within 2 hours.
--    Fires only when encrypted_password or email actually changes; any internal error lets the update through (never break
--    sign-in or password reset for anyone). Known edge: a login that makes GoTrue re-hash an old password during a live view.
-- =================================================================================================
create or replace function public.view_as_block_credential_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.encrypted_password is distinct from old.encrypted_password or new.email is distinct from old.email then
    begin
      if exists (
        select 1
          from public.view_as_sessions v
          join auth.sessions s on s.id = v.session_id
         where v.target_id = old.id and v.ended_at is null
           and coalesce(s.refreshed_at, s.created_at) > now() - interval '2 hours'
      ) then
        raise exception 'This account is being viewed by an admin right now. Try again after they exit.'
          using errcode = '42501';
      end if;
    exception
      when insufficient_privilege then raise;
      when others then
        raise warning 'view_as_block_credential_change lookup failed: %', sqlerrm;
    end;
  end if;
  return new;
end;
$$;
revoke all on function public.view_as_block_credential_change() from public, anon, authenticated;

create trigger view_as_block_credential_change
  before update of encrypted_password, email on auth.users
  for each row execute function public.view_as_block_credential_change();

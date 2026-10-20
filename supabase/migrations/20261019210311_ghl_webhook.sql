-- TASK-G30 (design: audit/G26/webhook-design.md): GHL -> HyperDial webhook (`ghl-webhook`).
-- Two service-only tables and two helper functions. The webhook is a trigger only: it re-reads the contact from
-- GHL and reuses apply_ghl_reconcile / apply_ghl_owner_routing, so no existing function changes.
--
--  ghl_webhook_state  one row per org: the workflow-webhook secret (SHA-256 hash only, never the secret), who
--                     rotated it and when, and the last event seen (shown to owner/admin in Settings).
--  ghl_webhook_seen   body-hash dedupe + per-org rate window.
--
-- RLS is ON with NO policy for authenticated/anon: these rows are reachable only with the service role (the
-- ghl-webhook and ghl-webhook-settings Edge Functions, where owner/admin is checked). A member can never read
-- the secret hash or the event log directly.

create table public.ghl_webhook_state (
  org_id uuid primary key references public.orgs (id) on delete cascade,
  secret_hash text unique,
  secret_rotated_at timestamptz,
  secret_rotated_by uuid references auth.users (id) on delete set null,
  last_event_at timestamptz,
  last_event_type text,
  handled_count bigint not null default 0,
  created_at timestamptz not null default now()
);
alter table public.ghl_webhook_state enable row level security;
revoke all on table public.ghl_webhook_state from public, anon, authenticated;
grant select, insert, update, delete on table public.ghl_webhook_state to service_role;

create table public.ghl_webhook_seen (
  org_id uuid not null references public.orgs (id) on delete cascade,
  body_hash text not null,
  seen_at timestamptz not null default now(),
  primary key (org_id, body_hash)
);
create index ghl_webhook_seen_seen_at_idx on public.ghl_webhook_seen (seen_at);
alter table public.ghl_webhook_seen enable row level security;
revoke all on table public.ghl_webhook_seen from public, anon, authenticated;
grant select, insert, update, delete on table public.ghl_webhook_seen to service_role;

-- Dedupe + rate limit in one atomic step. Returns 'ok' (go ahead), 'duplicate' (same body already seen within
-- p_dedupe_minutes) or 'rate_limited' (more than p_rate_per_minute accepted events in the last minute: the event is
-- dropped and the 5-minute sweep picks the change up). 'ok' also stamps ghl_webhook_state for the Settings card.
create function public.ghl_webhook_accept(
  p_org uuid,
  p_hash text,
  p_event_type text,
  p_dedupe_minutes int default 10,
  p_rate_per_minute int default 60
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hit int;
  v_recent int;
begin
  -- housekeeping for this org only (the (org_id, seen_at) scan is tiny)
  delete from public.ghl_webhook_seen where org_id = p_org and seen_at < now() - interval '1 day';

  insert into public.ghl_webhook_seen as s (org_id, body_hash, seen_at)
  values (p_org, p_hash, now())
  on conflict (org_id, body_hash) do update set seen_at = now()
    where s.seen_at < now() - make_interval(mins => greatest(p_dedupe_minutes, 1));
  get diagnostics v_hit = row_count;
  if v_hit = 0 then
    return 'duplicate';
  end if;

  select count(*) into v_recent from public.ghl_webhook_seen
  where org_id = p_org and seen_at > now() - interval '1 minute';
  if v_recent > greatest(p_rate_per_minute, 1) then
    delete from public.ghl_webhook_seen where org_id = p_org and body_hash = p_hash;
    return 'rate_limited';
  end if;

  insert into public.ghl_webhook_state as st (org_id, last_event_at, last_event_type, handled_count)
  values (p_org, now(), left(coalesce(p_event_type, ''), 80), 1)
  on conflict (org_id) do update
    set last_event_at = now(), last_event_type = excluded.last_event_type, handled_count = st.handled_count + 1;
  return 'ok';
end;
$$;
revoke all on function public.ghl_webhook_accept(uuid, text, text, int, int) from public, anon, authenticated;
grant execute on function public.ghl_webhook_accept(uuid, text, text, int, int) to service_role;

-- A delivery that failed transiently is un-seen, so GHL's retry of the same body is processed, not deduped.
create function public.ghl_webhook_forget(p_org uuid, p_hash text)
returns void
language sql
security definer
set search_path = ''
as $$
  delete from public.ghl_webhook_seen where org_id = p_org and body_hash = p_hash;
$$;
revoke all on function public.ghl_webhook_forget(uuid, text) from public, anon, authenticated;
grant execute on function public.ghl_webhook_forget(uuid, text) to service_role;

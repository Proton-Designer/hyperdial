-- TASK-H37: per-org read-only API keys + the data function behind the public Calls API (Edge Function `public-api`).
--
-- org_api_keys: only the SHA-256 of a key is stored (key_prefix = first 12 chars, display only). RLS on; an owner/admin of
-- the org may SELECT its rows, and column grants take key_hash away from every API role. No client insert/update/delete:
-- keys are made and revoked only through create_org_api_key / revoke_org_api_key (security definer, owner/admin check).
-- Key format: hd_live_ + 43 base62 chars (32 random bytes).
--
-- public_api_* functions are service_role only (the Edge Function is the sole caller). Org comes from the key, never input.
-- "Calls" = dialer contact legs (call_legs.kind='contact') with outcome 'connected' that have ended. Manual calls live in
-- manual_call_logs (not call_legs) and are NOT included. Contact email: contacts has no email column, so the newest
-- contact_closes.email for the contact is used (null if none).

create table public.org_api_keys (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references public.orgs(id) on delete cascade,
  name         text not null check (length(btrim(name)) between 1 and 80),
  key_prefix   text not null,
  key_hash     text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes       text[] not null default array['calls:read'],
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create index idx_org_api_keys_org on public.org_api_keys(org_id, created_at desc);

alter table public.org_api_keys enable row level security;
create policy "owner or admin can view api keys" on public.org_api_keys for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

revoke all on public.org_api_keys from public, anon, authenticated;
grant select (id, org_id, name, key_prefix, scopes, created_by, created_at, last_used_at, revoked_at)
  on public.org_api_keys to authenticated;

-- Per-key request counter (one row per key per minute), service-only.
create table public.org_api_key_hits (
  key_id uuid not null references public.org_api_keys(id) on delete cascade,
  minute timestamptz not null,
  n      int not null default 0,
  primary key (key_id, minute)
);
alter table public.org_api_key_hits enable row level security;
revoke all on public.org_api_key_hits from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
create function public.create_org_api_key(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_name text := btrim(coalesce(p_name, ''));
  v_bytes bytea;
  v_alphabet constant text := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  v_body text := '';
  v_key text;
  v_id uuid;
  v_created timestamptz;
  i int;
begin
  if auth.uid() is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select pr.active_org_id into v_org from public.profiles pr where pr.user_id = auth.uid();
  if v_org is null or not private.has_org_role(v_org, array['owner', 'admin']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if length(v_name) < 1 or length(v_name) > 80 then
    raise exception 'name must be 1 to 80 characters' using errcode = '22023';
  end if;
  if (select count(*) from public.org_api_keys k where k.org_id = v_org and k.revoked_at is null) >= 20 then
    raise exception 'too many active keys (max 20); revoke one first' using errcode = '22023';
  end if;

  v_bytes := extensions.gen_random_bytes(43);
  for i in 0..42 loop
    v_body := v_body || substr(v_alphabet, (get_byte(v_bytes, i) % 62) + 1, 1);
  end loop;
  v_key := 'hd_live_' || v_body;

  insert into public.org_api_keys (org_id, name, key_prefix, key_hash, created_by)
  values (v_org, v_name, substr(v_key, 1, 12), encode(extensions.digest(convert_to(v_key, 'UTF8'), 'sha256'), 'hex'), auth.uid())
  returning id, created_at into v_id, v_created;

  perform private.log_org_action(v_org, 'api_key.created', 'org_api_key', v_id, jsonb_build_object('name', v_name));

  return jsonb_build_object('id', v_id, 'name', v_name, 'key', v_key, 'key_prefix', substr(v_key, 1, 12), 'created_at', v_created);
end;
$$;

create function public.revoke_org_api_key(p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_name text;
begin
  select k.org_id, k.name into v_org, v_name from public.org_api_keys k where k.id = p_id;
  if v_org is null or auth.uid() is null or not private.has_org_role(v_org, array['owner', 'admin']) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update public.org_api_keys set revoked_at = now() where id = p_id and revoked_at is null;
  if found then
    perform private.log_org_action(v_org, 'api_key.revoked', 'org_api_key', p_id, jsonb_build_object('name', v_name));
  end if;
end;
$$;

revoke all on function public.create_org_api_key(text) from public, anon;
revoke all on function public.revoke_org_api_key(uuid) from public, anon;
grant execute on function public.create_org_api_key(text) to authenticated;
grant execute on function public.revoke_org_api_key(uuid) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- public_api_check_key: authenticate by hash, count this request, throttle last_used_at (once per minute).
-- Returns no row for an unknown/revoked key; allowed=false when over p_limit requests in the current minute.
create function public.public_api_check_key(p_key_hash text, p_limit int default 60)
returns table (org_id uuid, key_id uuid, allowed boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_org uuid;
  v_id uuid;
  v_n int;
  v_min timestamptz := date_trunc('minute', now());
begin
  select k.org_id, k.id into v_org, v_id
    from public.org_api_keys k
   where k.key_hash = p_key_hash and k.revoked_at is null and 'calls:read' = any (k.scopes);
  if v_id is null then
    return;
  end if;
  insert into public.org_api_key_hits (key_id, minute, n) values (v_id, v_min, 1)
  on conflict (key_id, minute) do update set n = public.org_api_key_hits.n + 1
  returning n into v_n;
  if random() < 0.02 then
    delete from public.org_api_key_hits h where h.minute < now() - interval '1 hour';
  end if;
  update public.org_api_keys k set last_used_at = now()
   where k.id = v_id and (k.last_used_at is null or k.last_used_at < now() - interval '1 minute');
  return query select v_org, v_id, v_n <= p_limit;
end;
$$;

-- public_api_list_calls: one page, oldest first by (ended_at, id), keyset on (p_after_ended_at, p_after_id).
-- Returns up to p_limit (max 200) rows as jsonb; the caller signs recording_url from recording_path.
create function public.public_api_list_calls(
  p_org uuid,
  p_since timestamptz,
  p_after_ended_at timestamptz default null,
  p_after_id uuid default null,
  p_limit int default 200
)
returns table (
  id uuid, ended_at timestamptz, duration_seconds int, agent_name text, agent_email text, campaign text,
  disposition text, contact_name text, contact_business text, contact_phone text, contact_email text,
  contact_timezone text, contact_notes text, callback_at timestamptz,
  recording_path text, recording_status text, recording_channels int
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    cl.id,
    cl.ended_at,
    cl.duration_seconds::int,
    nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
    u.email::text,
    ca.name,
    d.label,
    coalesce(nullif(btrim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), nullif(btrim(c.owner_contact), '')),
    c.business_name,
    c.phone_number,
    (select cc.email from public.contact_closes cc
      where cc.contact_id = c.id and cc.org_id = cl.org_id and cc.email is not null
      order by cc.created_at desc limit 1),
    c.timezone,
    c.notes,
    cl.callback_at,
    cl.recording_path,
    cl.recording_status,
    case when cl.recording_path is not null then 2 else null end
  from public.call_legs cl
  left join public.dial_sessions ds on ds.id = cl.session_id
  left join public.profiles p on p.user_id = ds.agent_id
  left join auth.users u on u.id = ds.agent_id
  left join public.campaigns ca on ca.id = cl.campaign_id
  left join public.dispositions d on d.id = cl.disposition_id
  left join public.contacts c on c.id = cl.contact_id and c.org_id = cl.org_id
  where cl.org_id = p_org
    and cl.kind = 'contact'
    and cl.outcome = 'connected'
    and cl.ended_at is not null
    and cl.ended_at > p_since
    and (p_after_ended_at is null or (cl.ended_at, cl.id) > (p_after_ended_at, p_after_id))
  order by cl.ended_at, cl.id
  limit least(greatest(coalesce(p_limit, 200), 1), 200);
$$;

revoke all on function public.public_api_check_key(text, int) from public, anon, authenticated;
revoke all on function public.public_api_list_calls(uuid, timestamptz, timestamptz, uuid, int) from public, anon, authenticated;
grant execute on function public.public_api_check_key(text, int) to service_role;
grant execute on function public.public_api_list_calls(uuid, timestamptz, timestamptz, uuid, int) to service_role;

-- Index for the keyset scan.
create index if not exists idx_call_legs_org_connected_ended
  on public.call_legs(org_id, ended_at, id) where kind = 'contact' and outcome = 'connected';

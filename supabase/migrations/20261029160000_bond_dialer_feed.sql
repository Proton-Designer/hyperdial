-- A read-only daily dialing feed for Bond (Kareem's personal assistant): per dialer, per local day --
-- dials, connects, voicemails, talk seconds -- for his morning brief, "someone's dials dropped"
-- alerts and the weekly report card. Bond never writes; it holds one feed key and calls one function.
--
-- Built from Kareem's own draft (2026-10-29), with three changes so it returns real numbers:
-- - It reads call_legs/dial_sessions, not the legacy call_logs table (nothing has written call_logs
--   since the dialer rewrite -- 0 rows ever on prod; dialer-engine.ts header).
-- - Each feed key is bound to ONE org, and only that org's dialers/legs are returned.
-- - The numbers use the Team page's own definitions (team_daily_stats, 20260928123723), so Bond and
--   the Team page agree for the same day:
--     dials        = contact legs placed (kind='contact'; the agent's own browser leg is not a dial)
--     connects     = outcome 'connected' (a person answered and was bridged to the agent)
--     voicemails   = outcome 'machine' or 'voicemail_left' (answering machine reached)
--     talk_seconds = sum(duration_seconds) over connects (bridge to hangup)
--   bucketed by call_legs.created_at in the caller's p_tz.
--
-- The response shape is Kareem's draft unchanged:
--   { generated_at, users: [{id, name}], days: [{user_id, date, dials, connects, voicemails, talk_seconds}] }
--
-- bond_dialer_feed_keys: RLS on with NO policies and no grants -- deliberately unreadable by every API
-- role (anon/authenticated/a member's own JWT alike); only the SECURITY DEFINER function below and the
-- SQL Editor see it. Only the SHA-256 of the key is stored.
--
-- Add a key (SQL Editor):  insert into public.bond_dialer_feed_keys (key_hash, org_id) values ('<64 hex>', '<org uuid>');
-- Cut Bond off:            delete from public.bond_dialer_feed_keys;

create table public.bond_dialer_feed_keys (
  key_hash   text primary key check (key_hash ~ '^[0-9a-f]{64}$'),
  org_id     uuid not null references public.orgs(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.bond_dialer_feed_keys enable row level security;
revoke all on public.bond_dialer_feed_keys from public, anon, authenticated;

create function public.bond_dialer_feed(p_key text, p_from date, p_to date, p_tz text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_from timestamptz;
  v_to timestamptz;
begin
  if p_key is not null and length(p_key) >= 32 then
    select k.org_id into v_org
      from public.bond_dialer_feed_keys k
     where k.key_hash = encode(sha256(convert_to(p_key, 'UTF8')), 'hex');
  end if;
  if v_org is null then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 30 then
    raise exception 'range must be 1 to 31 days' using errcode = '22023';
  end if;
  if p_tz is null or not exists (select 1 from pg_catalog.pg_timezone_names where name = p_tz) then
    raise exception 'unknown time zone' using errcode = '22023';
  end if;

  -- Local midnight of p_from to local midnight after p_to, in the caller's time zone.
  v_from := (p_from::timestamp at time zone p_tz);
  v_to := ((p_to + 1)::timestamp at time zone p_tz);

  return jsonb_build_object(
    'generated_at', now(),
    -- Everyone in the org who ran a dial session in the last 31 days or in the requested range --
    -- so a dialer with zero dials today is still listed (Bond's "dials dropped" alert needs that).
    'users', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', u.id,
        'name', coalesce(
          nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
          split_part(u.email, '@', 1)))
        order by u.id)
      from auth.users u
      left join public.profiles p on p.user_id = u.id
      where u.id in (
        select ds.agent_id from public.dial_sessions ds
        where ds.org_id = v_org
          and (ds.started_at >= now() - interval '31 days'
               or (ds.started_at < v_to and coalesce(ds.ended_at, now()) > v_from)))), '[]'::jsonb),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'user_id', d.agent_id, 'date', d.local_date, 'dials', d.dials, 'connects', d.connects,
        'voicemails', d.voicemails, 'talk_seconds', d.talk_seconds)
        order by d.local_date, d.agent_id)
      from (
        select
          ds.agent_id,
          (cl.created_at at time zone p_tz)::date as local_date,
          count(*)::int as dials,
          (count(*) filter (where cl.outcome = 'connected'))::int as connects,
          (count(*) filter (where cl.outcome in ('machine', 'voicemail_left')))::int as voicemails,
          coalesce(sum(cl.duration_seconds) filter (where cl.outcome = 'connected'), 0)::int as talk_seconds
        from public.call_legs cl
        join public.dial_sessions ds on ds.id = cl.session_id
        where cl.org_id = v_org
          and cl.kind = 'contact'
          and cl.created_at >= v_from
          and cl.created_at < v_to
        group by ds.agent_id, (cl.created_at at time zone p_tz)::date) d), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.bond_dialer_feed(text, date, date, text) from public;
grant execute on function public.bond_dialer_feed(text, date, date, text) to anon;

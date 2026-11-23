-- Outbound dial pacing (proposal). From Dec 1, 2026 Telnyx bills Voice API outbound traffic on
-- the monthly 95th percentile of each active hour's busiest second of call attempts; the first
-- 5 calls per second are free. Each org dials through its own (BYO) Telnyx account, so pacing is
-- per org: at most `dial_cps_limit` dials in any rolling 1.1 s window (0.1 s of margin for
-- network jitter). Dials below the limit go out immediately; only the excess waits.

-- Per-org limit, default 5 (the free tier). Raising it is a deliberate spend decision:
-- every call per second over 5 is $12/month up to 25.
alter table public.org_telephony
  add column dial_cps_limit smallint not null default 5
    check (dial_cps_limit between 1 and 50);

-- Last `dial_cps_limit` reserved dial times per org, oldest first.
create table private.org_dial_pace (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  slots timestamptz[] not null default '{}'
);
-- Service-role only: RLS on with no policies, so no authenticated user can read or write it.
alter table private.org_dial_pace enable row level security;

-- Reserves this caller's dial slot and returns how many ms to wait before dialing (0 = now).
create function public.reserve_dial_slot(p_org uuid, p_window_ms int default 1100)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_window interval := make_interval(secs => p_window_ms / 1000.0);
  v_limit int;
  v_slots timestamptz[];
  v_len int;
  v_slot timestamptz;
begin
  select t.dial_cps_limit into v_limit from public.org_telephony t where t.org_id = p_org;
  v_limit := coalesce(v_limit, 5);

  insert into private.org_dial_pace (org_id) values (p_org) on conflict (org_id) do nothing;
  select p.slots into v_slots from private.org_dial_pace p where p.org_id = p_org for update;
  v_len := coalesce(array_length(v_slots, 1), 0);

  if v_len < v_limit then
    v_slot := greatest(v_now, coalesce(v_slots[v_len], v_now));
  else
    -- The window may hold at most v_limit dials: this one goes no sooner than one window
    -- after the v_limit-th most recent. Slots stay sorted, so this is monotone.
    v_slot := greatest(v_now, v_slots[v_len - v_limit + 1] + v_window);
  end if;

  v_slots := array_append(v_slots, v_slot);
  v_len := v_len + 1;
  if v_len > v_limit then
    v_slots := v_slots[v_len - v_limit + 1 : v_len];
  end if;
  update private.org_dial_pace set slots = v_slots where org_id = p_org;

  return greatest(0, ceil(extract(epoch from (v_slot - v_now)) * 1000))::int;
end;
$$;

revoke all on function public.reserve_dial_slot(uuid, int) from public, anon, authenticated;
grant execute on function public.reserve_dial_slot(uuid, int) to service_role;

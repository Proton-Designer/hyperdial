-- TASK-N1 fix-forward (eng1 review blocker + finding L). Append-only, follows
-- 20260925070000_number_pool.sql.
--
-- BLOCKER: private.has_available_dial_number and private.pick_and_reserve_dial_number are
-- called via supabase.rpc(...) from dialer-engine.ts (bare names, no schema prefix), but
-- PostgREST's .rpc() only resolves against config.toml's [api].schemas (public,
-- graphql_public here) -- a private.* function is unreachable that way no matter what grants
-- it has (the exact same bug class TASK-P1-05 already hit and fixed for org_telephony; see
-- LANE-eng2.md). The FakeDb-backed deno tests mock .rpc() regardless of schema, and the
-- dry-run calls private.* directly in raw SQL, so neither caught this -- only a real
-- PostgREST call against the deployed schema would 404 (PGRST202). Fix: public
-- SECURITY DEFINER wrapper functions with the identical name/signature already called,
-- delegating straight to the private implementation; revoked from public/anon/authenticated,
-- granted to service_role only, same as every other RPC surface in this file.

create function public.has_available_dial_number(p_org_id uuid, p_agent_id uuid)
returns boolean
language sql
security definer
set search_path = ''
as $$
  select private.has_available_dial_number(p_org_id, p_agent_id);
$$;

create function public.pick_and_reserve_dial_number(
  p_org_id uuid,
  p_agent_id uuid,
  p_contact_phone text
)
returns uuid
language sql
security definer
set search_path = ''
as $$
  select private.pick_and_reserve_dial_number(p_org_id, p_agent_id, p_contact_phone);
$$;

revoke all on function public.has_available_dial_number(uuid, uuid) from public, anon, authenticated;
revoke all on function public.pick_and_reserve_dial_number(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.has_available_dial_number(uuid, uuid) to service_role;
grant execute on function public.pick_and_reserve_dial_number(uuid, uuid, text) to service_role;

-- FINDING (L): dialLead's catch (dialer-engine.ts) terminates the leg when Telnyx rejects a
-- dial outright, but never gave back the number_daily_usage increment pick_and_reserve_dial_
-- number already made for it -- repeated dial failures can rest a real number for a day+ with
-- zero actual calls placed from it. Compensating decrement: never below 0, and only flips a
-- resting number back to active if THIS decrement is what drops it back under cap. That's safe
-- without a race check because pick_and_reserve_dial_number only ever selects `status =
-- 'active'` numbers -- once a number goes resting, nothing else can increment it further, so
-- its dials count is frozen at exactly the value that crossed the cap and this decrement always
-- refers to that same crossing.

create function private.release_reserved_dial_number(p_org_id uuid, p_number_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dials int;
  v_cap int;
  v_status text;
begin
  update public.number_daily_usage
  set dials = greatest(dials - 1, 0)
  where number_id = p_number_id and org_id = p_org_id and day = (now() at time zone 'utc')::date
  returning dials into v_dials;

  if v_dials is null then
    return;
  end if;

  select daily_cap, status into v_cap, v_status
  from public.user_phone_numbers where id = p_number_id and org_id = p_org_id;

  if v_status = 'resting' and v_dials < v_cap then
    update public.user_phone_numbers
    set status = 'active', resting_until = null
    where id = p_number_id;
  end if;
end;
$$;

create function public.release_reserved_dial_number(p_org_id uuid, p_number_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  select private.release_reserved_dial_number(p_org_id, p_number_id);
$$;

revoke all on function private.release_reserved_dial_number(uuid, uuid) from public, anon, authenticated;
revoke all on function public.release_reserved_dial_number(uuid, uuid) from public, anon, authenticated;
grant execute on function private.release_reserved_dial_number(uuid, uuid) to service_role;
grant execute on function public.release_reserved_dial_number(uuid, uuid) to service_role;

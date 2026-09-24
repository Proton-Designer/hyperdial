-- TASK-P2-E2 fix-forward, item 1 (lead's diff-read, high): the overdial race.
--
-- refillSession used to compute n = lines - activeLegs in TS, then call
-- claim_next_leads(session, n). Two leg-end webhooks for the same session processed
-- concurrently each read the same active-leg count before either had inserted anything, so
-- each independently computed "room for N more" and together could dial up to 2x `lines`
-- legs at once -- breaking the 1-7 lines contract (dial_sessions.lines' own CHECK).
--
-- Fix: move the capacity check AND the leg insert into claim_next_leads itself, under a
-- `select ... for update` lock on the dial_sessions row for the whole call. Two concurrent
-- calls for the same session now serialize -- the second blocks until the first commits (its
-- new call_legs rows and all), then recomputes capacity against the fresh, post-insert count.
-- p_n is dropped entirely: the caller no longer decides how many to claim, the locked
-- capacity computation does. dialLead (TS) no longer inserts into call_legs itself -- the
-- row already exists by the time it dials.

drop function public.claim_next_leads(uuid, int);
drop type public.claimed_lead;

create type public.claimed_dial_leg as (
  leg_id uuid,
  lead_id uuid,
  contact_id uuid,
  phone_number text,
  call_control_id text
);

create function public.claim_next_leads(p_session uuid)
returns setof public.claimed_dial_leg
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_campaign_id uuid;
  v_agent_id uuid;
  v_lines int;
  v_window_start time;
  v_window_end time;
  v_capacity int;
begin
  -- Locks the session row for this call's whole duration (held until commit) -- this is what
  -- makes the capacity check below and the leg insert further down atomic against any other
  -- concurrent claim_next_leads call for the SAME session. A second call blocks here until
  -- the first one's transaction ends, then sees its newly-inserted legs in the count.
  select ds.org_id, ds.campaign_id, ds.agent_id, ds.lines
    into v_org_id, v_campaign_id, v_agent_id, v_lines
  from public.dial_sessions ds
  where ds.id = p_session and ds.state = 'dialing'
  for update;

  if v_campaign_id is null then
    return;
  end if;

  select count(*) into v_capacity
  from public.call_legs
  where session_id = p_session and kind = 'contact' and state <> 'ended';

  v_capacity := greatest(0, v_lines - v_capacity);
  if v_capacity = 0 then
    return;
  end if;

  select c.calling_window_start, c.calling_window_end into v_window_start, v_window_end
  from public.campaigns c
  where c.id = v_campaign_id;

  -- Same "picked -> updated -> re-sorted final select" shape as before (UPDATE ... RETURNING
  -- has no defined row order -- TASK-P2-E1's own finding), now with a third stage that inserts
  -- each claimed lead's call_legs row in the same statement/lock instead of leaving that to a
  -- second, separate TS-side insert.
  return query
  with picked as (
    select
      cl2.id,
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) as is_priority_callback,
      cl2.attempts,
      cl2.next_attempt_at,
      cl2.position,
      cl2.contact_id
    from public.campaign_leads cl2
    join public.contacts ct on ct.id = cl2.contact_id
    where cl2.campaign_id = v_campaign_id
      and cl2.next_attempt_at <= now()
      and not ct.dnc
      and (
        cl2.status = 'queued'
        or (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id)
      )
      and private.is_lead_callable_now(ct.timezone, v_window_start, v_window_end)
    order by
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) desc,
      cl2.attempts asc,
      cl2.next_attempt_at asc,
      cl2.position asc
    limit v_capacity
    for update of cl2 skip locked
  ),
  updated as (
    update public.campaign_leads cl
    set status = 'in_flight', updated_at = now()
    from picked
    where cl.id = picked.id
    returning cl.id, cl.contact_id
  ),
  new_legs as (
    -- call_control_id is NOT NULL UNIQUE and Telnyx's real one isn't known until dial()
    -- returns -- a placeholder reserves the row so it's trackable (and counted toward
    -- capacity) from the instant this commits; dialLead (TS) overwrites it with the real
    -- value once Telnyx accepts the call. The placeholder is keyed on a fresh random uuid,
    -- NOT the lead id: a lead id is reused every time that same lead is claimed again after a
    -- failed dial (dialLead's error path ends that leg but never changes its call_control_id
    -- away from the placeholder), so a lead-id-keyed placeholder collides with its own prior
    -- attempt's now-dead row on the very next retry -- a real bug the lead caught before this
    -- migration was ever applied. Every attempt gets its own placeholder no matter how many
    -- times the same lead is claimed.
    insert into public.call_legs (org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state)
    select v_org_id, p_session, v_campaign_id, u.contact_id, u.id, 'contact', 'pending-' || gen_random_uuid()::text, 'initiated'
    from updated u
    returning id, lead_id, contact_id, call_control_id
  )
  select
    nl.id as leg_id,
    nl.lead_id,
    nl.contact_id,
    (select ct2.phone_number from public.contacts ct2 where ct2.id = nl.contact_id),
    nl.call_control_id
  from new_legs nl
  join picked p on p.id = nl.lead_id
  order by p.is_priority_callback desc, p.attempts asc, p.next_attempt_at asc, p.position asc;
end;
$$;

revoke all on function public.claim_next_leads(uuid) from public, anon, authenticated;
grant execute on function public.claim_next_leads(uuid) to service_role;

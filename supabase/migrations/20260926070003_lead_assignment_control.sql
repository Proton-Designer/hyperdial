-- MISSION-4 TASK-T6: list & assignment control (ADM-4 + skip/remove/priority, NEW).
--
-- Design (documented per the task's own "pick the simplest robust model and document it" ask):
--
-- ADM-4's "assign a campaign to one or more interns" is ALREADY built -- `campaign_agents`
-- (20260924000200) already gates campaign-level visibility (RLS on campaign_leads/contacts,
-- dialer-session-start's own membership check) and the campaign picker (`listCampaigns()`
-- already filters to assigned campaigns for an agent). Nothing new needed there.
--
-- What's genuinely missing is PER-LEAD ("slice") assignment: `campaign_leads.assigned_agent_id`
-- (20260924000700) already exists but has only ever been used for CALLBACK ownership (set by
-- submit_disposition when a lead's own outcome is 'callback', read by claim_next_leads' own
-- `cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id` filter/ordering) -- for a
-- 'queued' lead it has never been checked at all (any agent on the campaign can claim any queued
-- lead today, regardless of this column's value). This migration REUSES the same column for
-- both meanings rather than adding a second one: a manager "assigning a slice" is exactly
-- "setting assigned_agent_id on a computed set of queued leads", and claim_next_leads' own
-- WHERE clause widens to respect it for 'queued' too (a null value keeps today's "anyone on the
-- campaign" behavior -- assignment is opt-in per lead, never a new default restriction).
--
-- "A lead range/percentage/tag filter" (assign_campaign_leads below): eager materialization, not
-- an abstract rule evaluated later at claim time -- the RPC computes the target lead set ONCE,
-- at assignment time, and writes assigned_agent_id directly onto those rows. Reassigning mid-day
-- is just calling it again (a fresh filter, a different target agent, or p_agent_id := null to
-- unassign) -- idempotent, no assignment-rules table, no extra join in the hot claim path.
-- "One or more interns" for a SLICE (as opposed to a whole campaign, where campaign_agents
-- already supports many) means running this RPC once per intern with non-overlapping filters --
-- assigned_agent_id stays a single nullable FK, the simplest shape that already existed; the
-- manager repartitions by calling it again, not by this column becoming a set.
--
-- Skip (during a session, keeps its place/attempt) and lead Priority are BOTH plain column
-- updates through the EXISTING "owner or admin can update leads" RLS policy (20260924000300) --
-- no new RPC, no new policy. Neither needs role logic beyond what that policy already enforces
-- (an agent has zero write access to campaign_leads today, and this task never asked to change
-- that -- these are manager-side list actions, same audience as the pre-existing Remove button,
-- not a new agent-facing control). "Skip" pushes `next_attempt_at` forward (a plain UPDATE from
-- apps/web/src/lib/api.ts, no SQL here) without touching `attempts`/`position` -- literally
-- "keeps its place/attempt" by not writing either column.
--
-- Remove from campaign (terminal status): the EXISTING `removeLeadFromCampaign`/
-- `removeLeadsFromCampaign` (apps/web/src/lib/api.ts) do a hard `.delete()` -- contradicts this
-- task's own "terminal status" ask and silently loses the lead's own attempts/status/history
-- (call_legs.lead_id is `on delete set null`, so the LEG survives but its link to the lead does
-- not). Fixed in the SAME commit as this migration (api.ts only) to `.update({status:'removed'})`
-- instead -- needs the new 'removed' status value below. Deliberately a NEW status, not a reuse
-- of 'passthrough' -- that value already has its own distinct meaning (a losing duplicate leg for
-- a contact dialed twice in the same campaign, TASK-N1/20260925000200) baked into every existing
-- campaign-stats view's own `count(...) filter (where status = 'passthrough')`; conflating the two
-- would silently corrupt those counts.

-- =================================================================================================
-- 1. campaign_leads: priority + the new 'removed' terminal status.
-- =================================================================================================

alter table public.campaign_leads
  add column priority text not null default 'normal' check (priority in ('low', 'normal', 'high'));

comment on column public.campaign_leads.priority is
  'TASK-T6: manager-set dial priority. claim_next_leads orders high before normal before low, after
   callback ownership and priority_requeue, before attempts/next_attempt_at/position (the existing
   retry-time ordering). Plain column, set via a direct UPDATE (owner/admin RLS), no RPC.';

alter table public.campaign_leads drop constraint campaign_leads_status_check;
alter table public.campaign_leads add constraint campaign_leads_status_check
  check (status in (
    'queued', 'in_flight', 'completed', 'exhausted', 'dnc', 'callback', 'passthrough', 'paused',
    'removed'
  ));

-- =================================================================================================
-- 2. assign_campaign_leads: the ONLY new RPC this task needs. Owner/admin only (checked inside,
--    same "security definer + role check inside the function" convention as every write RPC in
--    this schema). Computes the target lead set ONCE against a rank/percentage/tag filter over
--    that campaign's currently QUEUED leads (ordered by `position`, the same FIFO key
--    claim_next_leads itself already orders by), then sets assigned_agent_id on exactly those
--    rows. p_agent_id := null unassigns (clears assigned_agent_id back to "anyone on the
--    campaign can claim it").
-- =================================================================================================

create function public.assign_campaign_leads(
  p_campaign_id uuid,
  p_agent_id uuid,
  p_filter jsonb default '{"mode": "all"}'::jsonb
)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_mode text;
  v_count int;
begin
  select org_id into v_org_id from public.campaigns where id = p_campaign_id;
  if v_org_id is null then
    raise exception 'campaign not found';
  end if;

  if not private.has_org_role(v_org_id, array['owner', 'admin']) then
    raise exception 'only an owner or admin can assign leads';
  end if;

  if p_agent_id is not null and not exists (
    select 1 from public.org_members
    where org_id = v_org_id and user_id = p_agent_id and status = 'active'
  ) then
    raise exception 'target agent is not an active member of this org';
  end if;

  -- A lead assigned to someone NOT on campaign_agents would be a footgun: that agent's own
  -- campaign picker (listCampaigns()) filters to campaign_agents, and campaign_leads/contacts'
  -- own RLS SELECT policy (private.agent_assigned_to_campaign) gates on the exact same table --
  -- they could never see or claim a lead assigned to them on a campaign they're not "on". Assign
  -- a slice therefore also ensures campaign-level membership, the same way checking one box in
  -- the existing "Assigned Agents" UI already does -- one manager action, not two.
  if p_agent_id is not null then
    insert into public.campaign_agents (campaign_id, user_id, org_id)
    values (p_campaign_id, p_agent_id, v_org_id)
    on conflict (campaign_id, user_id) do nothing;
  end if;

  v_mode := coalesce(p_filter ->> 'mode', 'all');
  if v_mode not in ('all', 'range', 'percentage', 'tag') then
    raise exception 'p_filter.mode must be one of: all, range, percentage, tag';
  end if;

  with ranked as (
    select
      cl.id,
      ct.ghl_tags,
      row_number() over (order by cl.position) as rn,
      count(*) over () as total
    from public.campaign_leads cl
    join public.contacts ct on ct.id = cl.contact_id
    where cl.campaign_id = p_campaign_id and cl.status = 'queued'
  ),
  candidates as (
    select r.id
    from ranked r
    where
      v_mode = 'all'
      or (v_mode = 'range'
        and r.rn between (p_filter ->> 'start')::int and (p_filter ->> 'end')::int)
      or (v_mode = 'percentage'
        and r.rn <= ceil(r.total * (p_filter ->> 'percentage')::numeric / 100))
      or (v_mode = 'tag' and r.ghl_tags && array[p_filter ->> 'tag'])
  ),
  updated as (
    update public.campaign_leads cl
    set assigned_agent_id = p_agent_id, updated_at = now()
    from candidates
    where cl.id = candidates.id
    returning cl.id
  )
  select count(*) into v_count from updated;

  return v_count;
end;
$$;

revoke all on function public.assign_campaign_leads(uuid, uuid, jsonb) from public, anon;
grant execute on function public.assign_campaign_leads(uuid, uuid, jsonb) to authenticated;

-- =================================================================================================
-- 3. claim_next_leads (create or replace, SAME signature `(uuid)` as the live 20260925050000
--    version): (a) a 'queued' lead is now only claimable when unassigned OR assigned to THIS
--    agent -- the exact same shape 'callback' already used, just applied to 'queued' too; (b)
--    lead priority (high/normal/low) is ordered ahead of attempts/next_attempt_at/position, after
--    callback ownership and priority_requeue (both existing, unchanged). Every OTHER line is
--    byte-identical to the live version.
-- =================================================================================================

create or replace function public.claim_next_leads(p_session uuid)
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
  where session_id = p_session and kind = 'contact'
    and state not in ('ended', 'voicemail_dropping');

  v_capacity := greatest(0, v_lines - v_capacity);
  if v_capacity = 0 then
    return;
  end if;

  select c.calling_window_start, c.calling_window_end into v_window_start, v_window_end
  from public.campaigns c
  where c.id = v_campaign_id;

  return query
  with picked as (
    select
      cl2.id,
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) as is_priority_callback,
      cl2.priority_requeue,
      case cl2.priority when 'high' then 2 when 'normal' then 1 else 0 end as priority_rank,
      cl2.attempts,
      cl2.next_attempt_at,
      cl2.position,
      cl2.contact_id
    from public.campaign_leads cl2
    join public.contacts ct on ct.id = cl2.contact_id
    where cl2.campaign_id = v_campaign_id
      and cl2.next_attempt_at <= now()
      and not ct.dnc
      and not exists (
        select 1 from public.dnc_numbers dn
        where dn.org_id = v_org_id and dn.e164 = ct.phone_number
      )
      and (
        (cl2.status = 'queued' and (cl2.assigned_agent_id is null or cl2.assigned_agent_id = v_agent_id))
        or (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id)
      )
      and private.is_lead_callable_now(ct.timezone, v_window_start, v_window_end)
    order by
      (cl2.status = 'callback' and cl2.assigned_agent_id = v_agent_id) desc,
      cl2.priority_requeue desc,
      (case cl2.priority when 'high' then 2 when 'normal' then 1 else 0 end) desc,
      cl2.attempts asc,
      cl2.next_attempt_at asc,
      cl2.position asc
    limit v_capacity
    for update of cl2 skip locked
  ),
  updated as (
    update public.campaign_leads cl
    set status = 'in_flight', updated_at = now(), priority_requeue = false
    from picked
    where cl.id = picked.id
    returning cl.id, cl.contact_id
  ),
  new_legs as (
    insert into public.call_legs (org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state, time_block)
    select
      v_org_id, p_session, v_campaign_id, u.contact_id, u.id, 'contact', 'pending-' || gen_random_uuid()::text, 'initiated',
      private.time_block_for(now(), (select ct3.timezone from public.contacts ct3 where ct3.id = u.contact_id))
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
  order by
    p.is_priority_callback desc, p.priority_requeue desc, p.priority_rank desc,
    p.attempts asc, p.next_attempt_at asc, p.position asc;
end;
$$;

revoke all on function public.claim_next_leads(uuid) from public, anon, authenticated;
grant execute on function public.claim_next_leads(uuid) to service_role;

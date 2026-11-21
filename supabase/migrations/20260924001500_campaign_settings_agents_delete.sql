-- Campaign settings editor, agent assignment, soft-delete, and dial-session status enforcement
-- (TASK-P2-P2, design §7). Timestamp granted by the lead in this task's own board-file log.
--
-- campaign_agents (assignment) and every campaign dial-setting column (lines/amd_mode/
-- caller_id_number_id/max_attempts/retry_interval_minutes/calling_window_*/
-- abandon_message_enabled) already exist and are already RLS-correct as of TASK-P2-E1
-- (20260924000700) and TASK-P1-01 (20260924000300) -- this migration adds only what's new:
-- soft-delete, the settings columns' visibility through campaigns_with_stats, and a DB-level
-- guard against starting a session on a paused/completed/deleted campaign.

-- campaigns: soft delete -------------------------------------------------------------------------
-- A real DELETE cascades (campaign_id ... on delete cascade) through dial_sessions and call_legs,
-- destroying call history, not just "orphaning" it. Soft delete avoids that entirely: the row
-- stays, every FK stays valid, and deleted_at hides it from clients. Logged choice, per the task's
-- own "soft-delete or restrict, your call" -- restrict (blocking delete while leads/history exist)
-- would still need an escape hatch eventually and soft-delete gives one for free.

alter table public.campaigns
  add column deleted_at timestamptz;

-- Hard delete is no longer offered to clients -- only the soft-delete UPDATE path remains, so a
-- deleted campaign's history can never be destroyed by a client request. (Nothing else in this
-- repo issues a DELETE against public.campaigns; grep confirms deleteCampaign was never built
-- before this task.)
drop policy "owner or admin can delete campaigns" on public.campaigns;

-- Deliberately NOT filtering deleted_at into the campaigns SELECT policy (tempting, but proven
-- wrong by dry-run testing): PostgreSQL implicitly ANDs a table's SELECT-policy USING clause into
-- an UPDATE's WITH CHECK for that same table, so a SELECT policy requiring "deleted_at is null"
-- would make the soft-delete UPDATE itself (the one that *sets* deleted_at) fail RLS -- you would
-- never be able to soft-delete a campaign at all, since the resulting row would no longer be
-- visible under that policy. "org members can view campaigns" (TASK-P1-01) is left untouched;
-- deleted_at is filtered at the campaigns_with_stats view level below instead, which is a plain
-- SQL predicate, not RLS, and has no such interaction with UPDATE.

-- campaigns_with_stats: expose the dial-settings columns + hide soft-deleted rows -----------------
-- The view previously listed columns explicitly and predates TASK-P2-E1's settings columns, so
-- lines/amd_mode/caller_id_number_id/max_attempts/retry_interval_minutes/calling_window_start/
-- calling_window_end/abandon_message_enabled were never selectable through it. Still
-- security_invoker (RLS on the underlying campaigns row still applies through the view). The new
-- "where c.deleted_at is null" is an ordinary view predicate, not RLS -- see the comment above for
-- why it lives here instead of on the SELECT policy.

drop view public.campaigns_with_stats;

create view public.campaigns_with_stats as
select
  c.id,
  c.user_id,
  c.org_id,
  c.name,
  c.status,
  c.total_calls_made,
  c.connect_rate,
  c.last_called_at,
  c.lines,
  c.amd_mode,
  c.caller_id_number_id,
  c.max_attempts,
  c.retry_interval_minutes,
  c.calling_window_start,
  c.calling_window_end,
  c.abandon_message_enabled,
  c.created_at,
  c.updated_at,
  count(cl.id)::integer as total_contacts,
  count(cl.id) filter (where cl.status = 'queued')::integer as queued,
  count(cl.id) filter (where cl.status = 'completed')::integer as completed,
  count(cl.id) filter (where cl.status = 'passthrough')::integer as passthrough
from public.campaigns c
left join public.campaign_leads cl on cl.campaign_id = c.id
where c.deleted_at is null
group by c.id;

alter view public.campaigns_with_stats set (security_invoker = on);

-- dial_sessions: refuse to start a session on a paused/completed/deleted campaign -----------------
-- A BEFORE INSERT trigger, not a client-side check: dial_sessions has no client INSERT policy at
-- all (every write is meant to go through a SECURITY DEFINER RPC or the service role, per
-- 20260924000700's own comment), and this task's spec explicitly offers "a DB-level CHECK or
-- trigger on dial_sessions insert" as the alternative to coordinating a code change into
-- dialer-session-start, which is eng2's file (out of lane). A trigger fires regardless of RLS
-- bypass or superuser/service-role status (see .brain/memory or LANE-eng1.md for the general
-- gotcha), so this holds even once eng2's TASK-P2-E2 rewrite starts inserting into this table.

create function private.enforce_campaign_active_for_session()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_deleted timestamptz;
begin
  select status, deleted_at into v_status, v_deleted
  from public.campaigns
  where id = new.campaign_id;

  if v_status is null then
    raise exception 'dial_sessions.campaign_id does not reference an existing campaign';
  end if;
  if v_deleted is not null then
    raise exception 'cannot start a dial session for a deleted campaign';
  end if;
  if v_status <> 'active' then
    raise exception 'cannot start a dial session for a % campaign', v_status;
  end if;

  return new;
end;
$$;

create trigger dial_sessions_require_active_campaign
  before insert on public.dial_sessions
  for each row execute function private.enforce_campaign_active_for_session();

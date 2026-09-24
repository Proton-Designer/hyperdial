-- TASK-L3 (part 2 of 2), QUE-8 / audit/final.json: one active campaign per contact at a time.
--
-- "Active" statuses, determined from the dialer schema/RPCs (not guessed): the
-- campaign_leads_status_check constraint (20260924000700_dialer_schema.sql) allows 'queued',
-- 'in_flight', 'completed', 'exhausted', 'dnc', 'callback', 'passthrough'. apply_leg_outcome's own
-- candidate-selection SQL (20260924000800_dialer_rpcs.sql and its fix-forwards) treats
-- `status = 'queued' or (status = 'callback' and assigned_agent_id = v_agent_id)` as dialable --
-- i.e. 'callback' rows are still live queue members, not a terminal state, just claimed by one
-- agent. 'in_flight' is self-evidently active (a leg is on it right now). 'completed', 'exhausted',
-- 'dnc', and 'passthrough' are all terminal/inactive. So ACTIVE = {'queued', 'in_flight',
-- 'callback'}. Flagged to eng2 for a second opinion per the task's own "coordinate with eng2 if
-- unsure" note -- this migration is safe to revise if that reading turns out wrong, since the
-- partial index's WHERE clause is the only place this list appears.
--
-- No explicit begin/commit -- see 20260925000100's header for why.

-- Resolve any pre-existing violations first (read against live: 0 contacts currently have more
-- than one active row across any campaigns, so this is a no-op today -- written generally in case
-- that ever changes before this runs, or for a future environment seeded with data). Demote the
-- losers to 'passthrough' rather than deleting them: the contact stays a member of that campaign's
-- lead list (visible in history/exports) but is no longer competing to be dialed from it. Same
-- rank table and tie-break order as 20260925000100's campaign collision resolution, for the same
-- reason (never demote a more-settled outcome in favor of a less-informative one).
create temporary table _active_rank(status text, rank int);
insert into _active_rank(status, rank) values ('callback', 2), ('in_flight', 1), ('queued', 0);

with ranked as (
  select id, contact_id,
    row_number() over (
      partition by contact_id
      order by _active_rank.rank desc, attempts desc, updated_at desc, id
    ) as rn
  from public.campaign_leads
  join _active_rank on _active_rank.status = campaign_leads.status
)
update public.campaign_leads cl
set status = 'passthrough', updated_at = now()
from ranked
where cl.id = ranked.id and ranked.rn > 1;

drop table _active_rank;

do $$
declare
  v_violations int;
begin
  select count(*) into v_violations
  from (
    select contact_id
    from public.campaign_leads
    where status in ('queued', 'in_flight', 'callback')
    group by contact_id
    having count(*) > 1
  ) x;
  if v_violations > 0 then
    raise exception 'campaign_leads_one_active: % contact(s) still active in more than one campaign after cleanup', v_violations;
  end if;
end $$;

create unique index idx_campaign_leads_one_active_per_contact
  on public.campaign_leads (contact_id)
  where status in ('queued', 'in_flight', 'callback');

-- Re-queuing a lead WITHIN its own campaign (dialer-sweeper's stale-batch reset, a callback
-- coming due, a retry after no-answer) is always an UPDATE of that same row by apply_leg_outcome/
-- submit_disposition/the sweeper -- never a second INSERT for the same contact -- so none of those
-- paths can violate this index. Only a genuine cross-campaign double-queue (import paths) can, and
-- contacts-import/ghl-import are updated in this same task to check and skip that case instead of
-- attempting the insert and hitting this constraint.

-- Copy-paste verification queries for the lead's live dry-run (not executed by this file):
--   select contact_id, count(*) from public.campaign_leads where status in ('queued','in_flight','callback') group by 1 having count(*) > 1;  -- must return 0 rows
--   select indexname from pg_indexes where tablename='campaign_leads' and indexname='idx_campaign_leads_one_active_per_contact';  -- must return 1 row

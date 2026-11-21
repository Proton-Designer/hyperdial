-- MISSION-4 TASK-T5 (CRD-4, NO AI): per-campaign script + objection sheet. Timestamp from eng1's
-- own assigned range (20260926080000-089999), next unused slot after 20260926080000/080100.
--
-- Scope note: this migration is the SQL-only half of CRD-4 (the admin-editable columns + the
-- view exposing them). The card-side rendering and the CampaignManageModal editor UI need
-- api.ts/dialer-session-get/LiveCallPanel.tsx/CampaignManageModal.tsx -- all currently claimed by
-- eng2's TASK-T4 (live transfer, CLAIMS.md) for the SAME dialer-UI surface. Landing the schema
-- now so it's ready the moment those claims release, rather than blocking on a full T5 rework
-- later; flagged to the lead (see this run's messages).
--
-- No RLS policy changes needed: "org members can view campaigns" (org-wide SELECT) and "owner or
-- admin can update campaigns" (20260924000300) already cover these two new columns exactly like
-- every other campaigns column -- neither policy is column-scoped.

alter table public.campaigns
  add column script_text text,
  add column objection_sheet_text text;

-- campaigns_with_stats: explicit column list (20260924001500's own header explains why -- it
-- predates several settings columns and had to be widened before), so a plain ALTER TABLE above
-- does NOT make these two selectable through it. Drop + recreate, byte-identical to the live
-- 20260924001500 definition except for the two new columns in the select list.

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
  c.script_text,
  c.objection_sheet_text,
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

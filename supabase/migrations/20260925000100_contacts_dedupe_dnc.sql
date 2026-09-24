-- TASK-L3 (part 1 of 2): merge duplicate (org_id, phone_number) contacts, then enforce
-- uniqueness. BUG-12 / audit/final.json: the original unique-index attempt
-- (20260924001300_contacts_e164_tz_dnc.sql) found pre-existing duplicate groups on live and
-- skipped creating the index -- permanently, since that migration only runs once. This migration
-- finishes the job regardless of whether duplicates exist today: idempotent, safe on an empty set
-- (verified against live: 0 duplicate groups as of 2026-09-25, so in practice this mostly just
-- creates the index -- but the merge logic below is real and general, not a no-op shortcut, since
-- a future import path bug or manual insert could reintroduce a duplicate before this runs).
--
-- Every FK referencing contacts.id (read live via pg_catalog / information_schema, not assumed):
-- campaign_leads.contact_id, call_logs.contact_id, call_legs.contact_id, crm_sync_jobs.contact_id.
-- Only campaign_leads has a uniqueness constraint touching contact_id
-- (campaign_leads_campaign_id_contact_id_key on (campaign_id, contact_id)), so it's the only one
-- that needs collision handling below; the other three are safe as a plain UPDATE.
--
-- No explicit begin/commit here, matching every other migration in this repo: the applier (the
-- Supabase CLI, and the lead's own begin/…/rollback dry-run wrapper) already wraps the whole file
-- in one transaction. Adding a `commit;` of our own here would end THAT outer transaction early
-- and commit for real in the middle of a rollback-only dry run -- exactly the auto-commit trap
-- this lane's LANE-eng1.md already documents from a past migration+test mistake.

-- Survivor = oldest row per (org_id, phone_number) group (min created_at, tie-broken by id for a
-- total order). Only groups with phone_number is not null and count(*) > 1 are touched.
create temporary table _dedupe_groups as
select
  org_id,
  phone_number,
  (array_agg(id order by created_at, id))[1] as survivor_id,
  array_agg(id order by created_at, id) as all_ids,
  bool_or(dnc) as merged_dnc
from public.contacts
where phone_number is not null
group by org_id, phone_number
having count(*) > 1;

-- Earliest non-null value per nullable field across the WHOLE group (survivor included) -- the
-- fill-update below only overwrites the survivor's own field when it is null, so this never
-- clobbers a value the survivor already had; it only supplies one when the survivor had none.
create temporary table _dedupe_fields as
select
  g.survivor_id,
  (array_agg(c.business_name order by c.created_at) filter (where c.business_name is not null))[1] as business_name,
  (array_agg(c.business_link order by c.created_at) filter (where c.business_link is not null))[1] as business_link,
  (array_agg(c.business_type order by c.created_at) filter (where c.business_type is not null))[1] as business_type,
  (array_agg(c.rating order by c.created_at) filter (where c.rating is not null))[1] as rating,
  (array_agg(c.review_count order by c.created_at) filter (where c.review_count is not null))[1] as review_count,
  (array_agg(c.open_hours order by c.created_at) filter (where c.open_hours is not null))[1] as open_hours,
  (array_agg(c.website order by c.created_at) filter (where c.website is not null))[1] as website,
  (array_agg(c.notes order by c.created_at) filter (where c.notes is not null))[1] as notes,
  (array_agg(c.first_name order by c.created_at) filter (where c.first_name is not null))[1] as first_name,
  (array_agg(c.last_name order by c.created_at) filter (where c.last_name is not null))[1] as last_name,
  (array_agg(c.owner_contact order by c.created_at) filter (where c.owner_contact is not null))[1] as owner_contact,
  (array_agg(c.address order by c.created_at) filter (where c.address is not null))[1] as address,
  (array_agg(c.category order by c.created_at) filter (where c.category is not null))[1] as category,
  (array_agg(c.contact_status order by c.created_at) filter (where c.contact_status is not null))[1] as contact_status,
  (array_agg(c.last_called_at order by c.created_at) filter (where c.last_called_at is not null))[1] as last_called_at,
  (array_agg(c.timezone order by c.created_at) filter (where c.timezone is not null))[1] as timezone,
  (array_agg(c.phone_raw order by c.created_at) filter (where c.phone_raw is not null))[1] as phone_raw,
  (array_agg(c.ghl_contact_id order by c.created_at) filter (where c.ghl_contact_id is not null))[1] as ghl_contact_id,
  sum(c.call_count) as summed_call_count
from _dedupe_groups g
join public.contacts c on c.id = any(g.all_ids)
group by g.survivor_id;

update public.contacts s
set
  dnc = g.merged_dnc,
  business_name = coalesce(s.business_name, f.business_name),
  business_link = coalesce(s.business_link, f.business_link),
  business_type = coalesce(s.business_type, f.business_type),
  rating = coalesce(s.rating, f.rating),
  review_count = coalesce(s.review_count, f.review_count),
  open_hours = coalesce(s.open_hours, f.open_hours),
  website = coalesce(s.website, f.website),
  notes = coalesce(s.notes, f.notes),
  first_name = coalesce(s.first_name, f.first_name),
  last_name = coalesce(s.last_name, f.last_name),
  owner_contact = coalesce(s.owner_contact, f.owner_contact),
  address = coalesce(s.address, f.address),
  category = coalesce(s.category, f.category),
  contact_status = coalesce(s.contact_status, f.contact_status),
  last_called_at = coalesce(s.last_called_at, f.last_called_at),
  timezone = coalesce(s.timezone, f.timezone),
  phone_raw = coalesce(s.phone_raw, f.phone_raw),
  ghl_contact_id = coalesce(s.ghl_contact_id, f.ghl_contact_id),
  -- call_count is additive (every group member's dial history is real), not a "fill" field.
  call_count = f.summed_call_count,
  updated_at = now()
from _dedupe_groups g
join _dedupe_fields f on f.survivor_id = g.survivor_id
where s.id = g.survivor_id;

-- campaign_leads: repoint loser rows to the survivor, but campaign_id+contact_id is unique, so
-- when the survivor AND one or more losers all have a row in the same campaign, only one of
-- those rows may survive. Rank ALL of a (survivor_id, campaign_id) group's rows together (not
-- just pairwise) by status "how advanced / final the outcome is" (dnc and completed are the most
-- settled; queued is the least), then attempts desc, then updated_at desc; keep the single
-- top-ranked row and delete the rest. Written as one group ranking (not a pairwise survivor-vs-
-- each-loser comparison) so it's correct even for a 3+-way duplicate group with more than one
-- loser queued into the same campaign, not just the common 2-way case. This never loses a DNC or
-- a completed outcome in favor of a less-informative row.
create temporary table _clg_rank(status text, rank int);
insert into _clg_rank(status, rank) values
  ('dnc', 6), ('completed', 5), ('exhausted', 4), ('callback', 3),
  ('in_flight', 2), ('queued', 1), ('passthrough', 0);

with candidate_leads as (
  select cl.id, cl.campaign_id, g.survivor_id, coalesce(r.rank, -1) as rank, cl.attempts, cl.updated_at
  from public.campaign_leads cl
  join _dedupe_groups g on cl.contact_id = any(g.all_ids)
  left join _clg_rank r on r.status = cl.status
),
ranked as (
  select id, campaign_id, survivor_id,
    row_number() over (
      partition by survivor_id, campaign_id
      order by rank desc, attempts desc, updated_at desc, id
    ) as rn
  from candidate_leads
)
delete from public.campaign_leads cl
using ranked
where cl.id = ranked.id and ranked.rn > 1;

-- Every remaining campaign_leads row that belonged to this group is now the sole survivor of its
-- (survivor_id, campaign_id) partition -- safe to repoint every one still pointing at a loser.
update public.campaign_leads cl
set contact_id = l.survivor_id, updated_at = now()
from (select unnest(all_ids) as loser_id, survivor_id from _dedupe_groups) l
where cl.contact_id = l.loser_id and l.loser_id <> l.survivor_id;

update public.call_logs cl
set contact_id = l.survivor_id
from (select unnest(all_ids) as loser_id, survivor_id from _dedupe_groups) l
where cl.contact_id = l.loser_id and l.loser_id <> l.survivor_id;

update public.call_legs cl
set contact_id = l.survivor_id
from (select unnest(all_ids) as loser_id, survivor_id from _dedupe_groups) l
where cl.contact_id = l.loser_id and l.loser_id <> l.survivor_id;

update public.crm_sync_jobs csj
set contact_id = l.survivor_id
from (select unnest(all_ids) as loser_id, survivor_id from _dedupe_groups) l
where csj.contact_id = l.loser_id and l.loser_id <> l.survivor_id;

delete from public.contacts c
using (select unnest(all_ids) as loser_id, survivor_id from _dedupe_groups) l
where c.id = l.loser_id and l.loser_id <> l.survivor_id;

drop table _dedupe_groups;
drop table _dedupe_fields;
drop table _clg_rank;

-- Verification block -- fails the whole migration (and the lead's dry-run) loudly if either
-- check doesn't hold, rather than silently leaving live in a half-fixed state.
do $$
declare
  v_dup_groups int;
begin
  select count(*) into v_dup_groups
  from (
    select 1 from public.contacts
    where phone_number is not null
    group by org_id, phone_number
    having count(*) > 1
  ) x;
  if v_dup_groups > 0 then
    raise exception 'contacts_dedupe_dnc: % duplicate (org_id, phone_number) group(s) remain after merge', v_dup_groups;
  end if;
end $$;

create unique index idx_contacts_org_phone_unique
  on public.contacts (org_id, phone_number)
  where phone_number is not null;

-- Copy-paste verification queries for the lead's live dry-run (not executed by this file):
--   select count(*) from public.contacts;                                    -- compare before/after: should drop by exactly the number of merged losers
--   select org_id, phone_number, count(*) from public.contacts where phone_number is not null group by 1,2 having count(*) > 1;  -- must return 0 rows
--   select indexname from pg_indexes where tablename='contacts' and indexname='idx_contacts_org_phone_unique';  -- must return 1 row
--   select dnc, count(*) from public.contacts group by dnc;                  -- spot-check DNC counts before/after are consistent (never fewer true's than before)

-- TASK-H02: add many contacts to a campaign's lead queue in ONE statement.
--
-- Replaces the client-side loop (api.ts addLeadsToCampaign: chunked selects + chunked upserts, no cap, not atomic) for the
-- "Add existing contacts" modal. Same role gate as today's path: campaign_leads INSERT is owner/admin only (RLS "owner or
-- admin can add leads") and the modal only renders for owner/admin -- this RPC allows EXACTLY owner/admin of the campaign's org.
--
-- Nothing here touches the dial loop: it only inserts `queued` campaign_leads rows (same row shape as today's path), and the
-- existing statement-level trigger campaign_leads_auto_distribute still sees them (round-robin). claim_next_leads,
-- dialer-engine and the webhook are untouched.
--
-- Skip reasons, one per contact, first match wins: no_phone, dnc (contacts.dnc), org_dnc (dnc_numbers), closed
-- (contact_status = 'Closed', switchable), removed (a removed lead of THIS campaign; the unique key blocks a revive),
-- already_in_campaign, active_elsewhere (queued/in_flight/callback in another campaign).

create function private.bulk_lead_candidates(
  p_org_id uuid,
  p_campaign_id uuid,
  p_mode text,
  p_contact_ids uuid[],
  p_filter jsonb,
  p_skip_closed boolean
)
returns table (contact_id uuid, created_at timestamptz, reason text)
language plpgsql
stable
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_search text := nullif(btrim(coalesce(p_filter ->> 'search', '')), '');
  v_category text := nullif(btrim(coalesce(p_filter ->> 'category', '')), '');
  v_status text := nullif(btrim(coalesce(p_filter ->> 'contact_status', '')), '');
  v_city text := nullif(btrim(coalesce(p_filter ->> 'city', '')), '');
  v_list text := nullif(btrim(coalesce(p_filter ->> 'import_list', '')), '');
  v_from uuid := nullif(btrim(coalesce(p_filter ->> 'from_campaign_id', '')), '')::uuid;
begin
  -- user text -> ILIKE pattern with the wildcards neutralised
  if v_search is not null then
    v_search := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  if v_city is not null then
    v_city := '%' || replace(replace(replace(v_city, '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  return query
  select c.id,
         c.created_at,
         case
           when c.phone_number is null then 'no_phone'
           when c.dnc then 'dnc'
           when exists (select 1 from public.dnc_numbers d where d.org_id = p_org_id and d.e164 = c.phone_number) then 'org_dnc'
           when p_skip_closed and c.contact_status = 'Closed' then 'closed'
           when exists (select 1 from public.campaign_leads cl
                         where cl.campaign_id = p_campaign_id and cl.contact_id = c.id and cl.status = 'removed') then 'removed'
           when exists (select 1 from public.campaign_leads cl
                         where cl.campaign_id = p_campaign_id and cl.contact_id = c.id) then 'already_in_campaign'
           when exists (select 1 from public.campaign_leads cl
                         where cl.contact_id = c.id and cl.campaign_id <> p_campaign_id
                           and cl.status in ('queued', 'in_flight', 'callback')) then 'active_elsewhere'
           else null
         end
  from public.contacts c
  where c.org_id = p_org_id
    and (
      (p_mode = 'ids' and c.id = any (p_contact_ids))
      or (
        p_mode = 'filter'
        and (v_search is null or concat_ws(' ', c.first_name, c.last_name) ilike v_search
             or coalesce(c.business_name, '') ilike v_search)
        and (v_category is null or coalesce(c.category, 'Cold') = v_category)
        and (v_status is null or coalesce(c.contact_status, 'No Contact') = v_status)
        -- city column first; contacts imported before it existed fall back to the free-text address
        and (v_city is null or c.city ilike v_city or (c.city is null and coalesce(c.address, '') ilike v_city))
        and (v_list is null or c.import_list = v_list)
        and (v_from is null or exists (select 1 from public.campaign_leads src
                                        where src.campaign_id = v_from and src.org_id = p_org_id and src.contact_id = c.id))
      )
    );
end;
$$;

create function public.add_leads_to_campaign_bulk(
  p_campaign_id uuid,
  p_mode text,
  p_contact_ids uuid[] default null,
  p_filter jsonb default '{}'::jsonb,
  p_skip_closed boolean default true,
  p_cap integer default 5000,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_org uuid;
  v_cap integer := least(greatest(coalesce(p_cap, 5000), 1), 5000);
  v_filter jsonb := coalesce(p_filter, '{}'::jsonb);
  v_matched integer;
  v_eligible integer;
  v_added integer := 0;
  v_picked integer := 0;
  v_counts jsonb;
begin
  if auth.uid() is null then
    raise exception 'not signed in' using errcode = '42501';
  end if;
  if p_mode not in ('ids', 'filter') then
    raise exception 'mode must be ids or filter' using errcode = '22023';
  end if;
  if p_mode = 'ids' and coalesce(cardinality(p_contact_ids), 0) = 0 then
    raise exception 'no contacts given' using errcode = '22023';
  end if;
  if jsonb_typeof(v_filter) is distinct from 'object' then
    raise exception 'filter must be an object' using errcode = '22023';
  end if;

  select org_id into v_org from public.campaigns where id = p_campaign_id;
  if v_org is null or not private.has_org_role(v_org, array['owner', 'admin']) then
    -- same answer for "no such campaign" and "not yours": no org probing
    raise exception 'not allowed' using errcode = '42501';
  end if;

  -- a from_campaign_id must belong to the same org
  if nullif(v_filter ->> 'from_campaign_id', '') is not null
     and not exists (select 1 from public.campaigns where id = (v_filter ->> 'from_campaign_id')::uuid and org_id = v_org) then
    raise exception 'source campaign not found' using errcode = '22023';
  end if;

  -- One statement: classify once (materialized), insert the eligible batch, count everything. No temp table, so it is
  -- safe to call repeatedly inside one transaction.
  with cand as materialized (
    select * from private.bulk_lead_candidates(v_org, p_campaign_id, p_mode, p_contact_ids, v_filter, coalesce(p_skip_closed, true))
  ), picked as (
    select contact_id from cand where reason is null order by created_at, contact_id limit v_cap
  ), ins as (
    -- on conflict do nothing (no target) also swallows the one-active-campaign partial unique index, so a contact that
    -- lost a race since the classification is simply not added and is counted as active elsewhere below.
    insert into public.campaign_leads (campaign_id, contact_id, org_id)
      select p_campaign_id, contact_id, v_org from picked where not coalesce(p_dry_run, false)
      on conflict do nothing
      returning 1
  )
  select (select count(*) from cand),
         (select count(*) filter (where reason is null) from cand),
         (select count(*) from ins),
         (select count(*) from picked),
         coalesce((select jsonb_object_agg(reason, n) from (select reason, count(*) as n from cand where reason is not null group by reason) r), '{}'::jsonb)
    into v_matched, v_eligible, v_added, v_picked, v_counts;

  return jsonb_build_object(
    'dry_run', coalesce(p_dry_run, false),
    'matched', v_matched,
    'eligible', v_eligible,
    'would_add', least(v_eligible, v_cap),
    'added', v_added,
    'capped', v_eligible > v_cap,
    'cap', v_cap,
    'not_found', case when p_mode = 'ids' then greatest(cardinality(p_contact_ids) - v_matched, 0) else 0 end,
    'skipped_no_phone', coalesce((v_counts ->> 'no_phone')::int, 0),
    'skipped_dnc', coalesce((v_counts ->> 'dnc')::int, 0),
    'skipped_org_dnc', coalesce((v_counts ->> 'org_dnc')::int, 0),
    'skipped_closed', coalesce((v_counts ->> 'closed')::int, 0),
    'skipped_removed', coalesce((v_counts ->> 'removed')::int, 0),
    'skipped_already_in_campaign', coalesce((v_counts ->> 'already_in_campaign')::int, 0),
    -- includes any contact that raced into another campaign between classification and insert
    'skipped_active_elsewhere', coalesce((v_counts ->> 'active_elsewhere')::int, 0)
      + case when coalesce(p_dry_run, false) then 0 else greatest(v_picked - v_added, 0) end
  );
end;
$$;

revoke all on function public.add_leads_to_campaign_bulk(uuid, text, uuid[], jsonb, boolean, integer, boolean) from public, anon;
grant execute on function public.add_leads_to_campaign_bulk(uuid, text, uuid[], jsonb, boolean, integer, boolean) to authenticated;

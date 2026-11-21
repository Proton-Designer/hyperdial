-- TASK-H25: "Pros" tab read path. An onboarded pro = a contact with at least one contact_closes row; the list shows each
-- contact's LATEST close. contact_closes RLS excludes managers (owner/admin read all, an agent only their own), so this is a
-- security-definer read RPC with its own role gate: owner, admin and manager of p_org_id only (an agent is refused, a member of
-- another org is refused). Org scoped: only rows of p_org_id. Read only; no edit/delete.
-- Counts (by niche / city / closer, this week / month) are computed by the screen from these rows. At most p_limit rows
-- (newest first, capped at 5000); total_count is the full number so the screen can say when the list is cut.
create or replace function public.list_onboarded_pros(p_org_id uuid, p_limit integer default 5000)
returns table (
  close_id uuid,
  contact_id uuid,
  business_name text,
  owner_name text,
  mobile text,
  email text,
  services text[],
  cities text[],
  frequencies text[],
  insured boolean,
  best_contact text,
  starting_price numeric,
  capacity integer,
  years_in_business integer,
  closed_by uuid,
  closed_by_name text,
  closed_at timestamptz,
  close_count bigint,
  total_count bigint
)
language plpgsql
security definer
stable
set search_path = ''
as $$
#variable_conflict use_column
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_org_id is null or not private.has_org_role(p_org_id, array['owner', 'admin', 'manager']) then
    raise exception 'not allowed to view onboarded pros in this organization' using errcode = '42501';
  end if;

  return query
  with latest as (
    select distinct on (cc.contact_id) cc.*,
           count(*) over (partition by cc.contact_id) as n
    from public.contact_closes cc
    where cc.org_id = p_org_id
    order by cc.contact_id, cc.created_at desc, cc.id desc
  ),
  counted as (
    select l.*, count(*) over () as total from latest l
  )
  select c.id, c.contact_id, c.business_name, c.owner_name, c.mobile, c.email, c.services, c.cities, c.frequencies,
         c.insured, c.best_contact, c.starting_price, c.capacity, c.years_in_business, c.closed_by,
         nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
         c.created_at, c.n, c.total
  from counted c
  left join public.profiles p on p.user_id = c.closed_by
  order by c.created_at desc, c.id desc
  limit greatest(least(coalesce(p_limit, 5000), 5000), 1);
end;
$$;

revoke all on function public.list_onboarded_pros(uuid, integer) from public, anon;
grant execute on function public.list_onboarded_pros(uuid, integer) to authenticated;

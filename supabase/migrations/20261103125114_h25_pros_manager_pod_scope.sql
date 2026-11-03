-- TASK-H25 security review follow-up (new migration; 20261103124805 may already be applied): managers are pod-scoped in this
-- codebase (private.is_agent_in_callers_pod_scope / manager_has_contact_access), but list_onboarded_pros showed a manager
-- every close in the org. Now owner/admin see all; a manager sees only pros closed by an agent in their pods or whose contact
-- has a lead assigned to such an agent (a manager with no pods sees none). The scope is applied BEFORE the window counts,
-- so close_count and total_count are scoped too; the row shown is the contact's latest close overall (a pro whose latest close is out of scope is not shown). Same signature/grants.
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
declare
  v_all boolean;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_org_id is null or not private.has_org_role(p_org_id, array['owner', 'admin', 'manager']) then
    raise exception 'not allowed to view onboarded pros in this organization' using errcode = '42501';
  end if;

  -- owner/admin see every pro; a MANAGER sees only their pod scope (the documented manager rule): pros closed by an agent in
  -- one of their pods, or whose contact has a lead assigned to such an agent. A manager with no pods sees none.
  v_all := private.has_org_role(p_org_id, array['owner', 'admin']);

  return query
  with latest_all as (
    -- the LATEST close of each contact (of all closes), so the row shown is never an older close picked because it is in scope
    select distinct on (cc.contact_id) cc.*
    from public.contact_closes cc
    where cc.org_id = p_org_id
    order by cc.contact_id, cc.created_at desc, cc.id desc
  ),
  latest as (
    -- a pro is in scope when its latest close is (owner/admin: always); close_count counts only the closes in scope
    select l.*,
           (select count(*) from public.contact_closes x
             where x.contact_id = l.contact_id and x.org_id = p_org_id
               and (v_all
                    or private.is_agent_in_callers_pod_scope(p_org_id, x.closed_by)
                    or private.manager_has_contact_access(p_org_id, x.contact_id))) as n
    from latest_all l
    where v_all
       or private.is_agent_in_callers_pod_scope(p_org_id, l.closed_by)
       or private.manager_has_contact_access(p_org_id, l.contact_id)
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

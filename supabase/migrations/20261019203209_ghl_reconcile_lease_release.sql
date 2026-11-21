-- TASK-G19 (security-review finding on G16): the reconcile claim stamps contacts.ghl_reconciled_at = now()
-- BEFORE they are read from GHL. If the worker's time budget runs out mid-batch, the unread contacts used to
-- look freshly checked and went to the back of the queue, so a contact set to DND/DNC in GHL could keep being
-- dialed for extra full rotations. Fix: the claim now also returns each contact's PREVIOUS stamp, and a new
-- service-role RPC puts the previous stamp back for exactly the contacts the worker did not read.
-- (Changing a RETURNS TABLE shape: drop + recreate + re-grant.)

drop function public.claim_ghl_reconcile_batch(uuid, int);

create function public.claim_ghl_reconcile_batch(p_org uuid, p_limit int)
returns table (contact_id uuid, ghl_contact_id text, prev_reconciled_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select c.id, c.ghl_reconciled_at as prev
    from public.contacts c
    where c.org_id = p_org
      and c.ghl_contact_id is not null
      and c.dnc is not true
      and exists (
        select 1 from public.campaign_leads cl
        where cl.contact_id = c.id and cl.org_id = p_org and cl.status in ('queued', 'callback'))
    order by c.ghl_reconciled_at asc nulls first, c.id
    limit greatest(1, least(coalesce(p_limit, 100), 500))
    for update of c skip locked
  ), upd as (
    update public.contacts c
    set ghl_reconciled_at = now()
    from picked
    where c.id = picked.id
    returning c.id, c.ghl_contact_id, picked.prev
  )
  select upd.id, upd.ghl_contact_id, upd.prev from upd;
end;
$$;

revoke all on function public.claim_ghl_reconcile_batch(uuid, int) from public, anon, authenticated;
grant execute on function public.claim_ghl_reconcile_batch(uuid, int) to service_role;

-- p_items: [{contact_id, prev_reconciled_at (timestamptz or null)}] -> number of contacts released.
-- Only this org's contacts are touched.
create function public.release_ghl_reconcile_leases(p_org uuid, p_items jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  update public.contacts c
  set ghl_reconciled_at = x.prev_reconciled_at
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(contact_id uuid, prev_reconciled_at timestamptz)
  where c.id = x.contact_id and c.org_id = p_org;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.release_ghl_reconcile_leases(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.release_ghl_reconcile_leases(uuid, jsonb) to service_role;

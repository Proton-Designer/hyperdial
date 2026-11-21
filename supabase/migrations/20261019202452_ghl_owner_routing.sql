-- TASK-G15 (spec section 4, "Owner assignment"): callbacks route back to the contact's GHL owner.
-- The G08 reconcile already reads each queued/callback contact from GHL; it now also hands us the
-- contact's `assignedTo` (a GHL user id). This RPC resolves it through org_members.ghl_user_id and
--   1. keeps the informational contacts.assigned_user_id in sync (never written back to GHL), and
--   2. sets campaign_leads.assigned_agent_id on that contact's CALLBACK leads (the claim filter in
--      claim_next_leads only hands a callback to its assigned agent), but only when the owner is an
--      active org member who is on that campaign's roster.
-- Unmapped owner, inactive member, member not on the campaign, non-callback leads (queued, in_flight,
-- ...) are all left exactly as they are. Does not touch dialer-engine or claim_next_leads.

create function public.apply_ghl_owner_routing(p_org uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_member uuid;
  v_n int;
  v_contacts int := 0;
  v_leads int := 0;
  v_unmapped int := 0;
begin
  for v in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(contact_id uuid, ghl_user_id text)
  loop
    select m.user_id into v_member
    from public.org_members m
    where m.org_id = p_org and m.ghl_user_id = v.ghl_user_id and m.status = 'active';
    if v_member is null then
      v_unmapped := v_unmapped + 1;
      continue;
    end if;

    update public.contacts set assigned_user_id = v_member, updated_at = now()
    where id = v.contact_id and org_id = p_org and assigned_user_id is distinct from v_member;
    get diagnostics v_n = row_count;
    v_contacts := v_contacts + v_n;

    update public.campaign_leads cl
    set assigned_agent_id = v_member, updated_at = now()
    where cl.org_id = p_org
      and cl.contact_id = v.contact_id
      and cl.status = 'callback'
      and cl.assigned_agent_id is distinct from v_member
      and exists (
        select 1 from public.campaign_agents ca
        where ca.campaign_id = cl.campaign_id and ca.user_id = v_member
      );
    get diagnostics v_n = row_count;
    v_leads := v_leads + v_n;
  end loop;

  return jsonb_build_object('owner_contacts', v_contacts, 'owner_callbacks_routed', v_leads, 'owner_unmapped', v_unmapped);
end;
$$;

revoke all on function public.apply_ghl_owner_routing(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.apply_ghl_owner_routing(uuid, jsonb) to service_role;

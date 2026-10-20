-- TASK-G32 (audit G23 F3): contacts that were never pushed to or pulled from GHL (CSV imports) have no ghl_contact_id, so the
-- reconcile never read them: a person already set to Do Not Disturb in GHL was invisible until a first call linked them.
-- The reconcile worker now looks each such contact up in GHL by phone (before its first dial), links it when exactly one GHL contact
-- matches, and the normal reconcile read + decision runs on it in the same tick.
--
--  contacts.ghl_lookup_at           when the contact was last searched in GHL (the claim lease + "checked" stamp)
--  claim_ghl_lookup_batch           oldest-looked-up-first, only unlinked, non-DNC contacts that still have a queued/callback lead
--                                   and a phone number; stamps ghl_lookup_at = now() and returns the previous stamp so the worker can
--                                   hand it back for contacts it did not get to (same lease rule as G19)
--  release_ghl_lookup_leases        restores previous stamps
--  link_ghl_contacts                sets ghl_contact_id for [{contact_id, ghl_contact_id}]; skips a GHL id already linked to another
--                                   contact of the org (unique index idx_contacts_org_ghl_contact_id) and reports it
-- A contact with no GHL match keeps its stamp and is searched again only after p_recheck_hours (default 72 h), so a tick never re-searches
-- the same people. All three functions are service_role only. Never creates anything in GHL.

alter table public.contacts add column ghl_lookup_at timestamptz;
create index idx_contacts_ghl_lookup
  on public.contacts (org_id, ghl_lookup_at nulls first)
  where ghl_contact_id is null;

create function public.claim_ghl_lookup_batch(p_org uuid, p_limit int, p_recheck_hours int default 72)
returns table (contact_id uuid, phone_number text, prev_lookup_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  return query
  with picked as (
    select c.id, c.ghl_lookup_at as prev
    from public.contacts c
    where c.org_id = p_org
      and c.ghl_contact_id is null
      and c.dnc is not true
      and c.phone_number is not null
      and (c.ghl_lookup_at is null or c.ghl_lookup_at < now() - make_interval(hours => greatest(coalesce(p_recheck_hours, 72), 1)))
      and exists (
        select 1 from public.campaign_leads cl
        where cl.contact_id = c.id and cl.org_id = p_org and cl.status in ('queued', 'callback'))
    order by c.ghl_lookup_at asc nulls first, c.id
    limit greatest(1, least(coalesce(p_limit, 25), 200))
    for update of c skip locked
  ), upd as (
    update public.contacts c
    set ghl_lookup_at = now()
    from picked
    where c.id = picked.id
    returning c.id, c.phone_number, picked.prev
  )
  select upd.id, upd.phone_number, upd.prev from upd;
end;
$$;

revoke all on function public.claim_ghl_lookup_batch(uuid, int, int) from public, anon, authenticated;
grant execute on function public.claim_ghl_lookup_batch(uuid, int, int) to service_role;

-- p_items: [{contact_id, prev_lookup_at (timestamptz or null)}] -> number of contacts released. Only this org's, still-unlinked contacts.
create function public.release_ghl_lookup_leases(p_org uuid, p_items jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n int;
begin
  update public.contacts c
  set ghl_lookup_at = x.prev_lookup_at
  from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(contact_id uuid, prev_lookup_at timestamptz)
  where c.id = x.contact_id and c.org_id = p_org and c.ghl_contact_id is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.release_ghl_lookup_leases(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.release_ghl_lookup_leases(uuid, jsonb) to service_role;

-- p_items: [{contact_id, ghl_contact_id}] -> { linked, conflicts, linked_ids: [contact uuid, ...] }. Links only a still-unlinked contact of p_org; the GHL id must not
-- already belong to another contact of the org. A freshly linked contact also gets ghl_reconciled_at = now() (the worker reads it right away).
create function public.link_ghl_contacts(p_org uuid, p_items jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v record;
  v_n int;
  v_linked int := 0;
  v_conflicts int := 0;
  v_ids uuid[] := '{}';
begin
  for v in
    select * from jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) as x(contact_id uuid, ghl_contact_id text)
  loop
    if v.ghl_contact_id is null or btrim(v.ghl_contact_id) = '' then
      continue;
    end if;
    if exists (select 1 from public.contacts c where c.org_id = p_org and c.ghl_contact_id = v.ghl_contact_id) then
      v_conflicts := v_conflicts + 1;
      continue;
    end if;
    update public.contacts c
    set ghl_contact_id = v.ghl_contact_id, ghl_reconciled_at = now()
    where c.id = v.contact_id and c.org_id = p_org and c.ghl_contact_id is null;
    get diagnostics v_n = row_count;
    v_linked := v_linked + v_n;
    if v_n > 0 then
      v_ids := array_append(v_ids, v.contact_id);
    end if;
  end loop;
  return jsonb_build_object('linked', v_linked, 'conflicts', v_conflicts, 'linked_ids', to_jsonb(v_ids));
end;
$$;

revoke all on function public.link_ghl_contacts(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.link_ghl_contacts(uuid, jsonb) to service_role;

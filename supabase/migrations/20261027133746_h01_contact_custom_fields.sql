-- TASK-H01: CSV import turns unmatched columns into per-org custom fields, and `city` becomes a canonical contact column.
--
-- 1. contacts.city (canonical, nullable): the importer maps City/Town/Locality headers to it; the H02 bulk-add filter and the
--    H03 close form read it. Old rows stay null (consumers fall back to parsing `address`).
-- 2. contacts.custom_values jsonb: { <field key>: <text value> }, keys defined in contact_field_defs. Deliberately NOT
--    ghl_custom_fields (that one is GHL-pull-owned and replaced wholesale on every pull). Stored and shown only; nothing pushes it to GHL.
--    contacts_agent_update_scope compares whole-row jsonb, so agents still cannot touch the new columns.
-- 3. contact_field_defs: one row per (org, key). SELECT for org members; no client write policy, so the table is written only
--    by contacts-import (service role). Cap of 50 defs per org is enforced by a trigger as defence in depth (the function
--    also checks it and falls back to Skip with a message).
-- 4. import_merge_custom_values: service-role-only batch merge for re-imported duplicates -- adds only the keys a contact
--    does not already have, never overwrites an existing value.

alter table public.contacts
  add column city text,
  add column custom_values jsonb not null default '{}'::jsonb;

alter table public.contacts
  add constraint contacts_custom_values_is_object check (jsonb_typeof(custom_values) = 'object');

create table public.contact_field_defs (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs (id) on delete cascade,
  key text not null check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  label text not null check (char_length(label) between 1 and 60),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, key)
);

alter table public.contact_field_defs enable row level security;

create policy "Org members can read contact field defs"
  on public.contact_field_defs for select
  using (private.is_org_member(org_id));

revoke all on public.contact_field_defs from anon, authenticated;
grant select on public.contact_field_defs to authenticated;

create function private.enforce_contact_field_defs_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select count(*) from public.contact_field_defs where org_id = new.org_id) >= 50 then
    raise exception 'an organization can have at most 50 custom contact fields' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger contact_field_defs_cap
  before insert on public.contact_field_defs
  for each row execute function private.enforce_contact_field_defs_cap();

create function public.import_merge_custom_values(p_org_id uuid, p_items jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  if p_org_id is null or jsonb_typeof(p_items) is distinct from 'array' then
    return 0;
  end if;
  -- `new || old`: on a key present in both, the right operand (the contact's existing value) wins.
  update public.contacts c
     set custom_values = v.vals || c.custom_values
    from (
      select (e->>'contact_id')::uuid as contact_id, e->'values' as vals
        from jsonb_array_elements(p_items) e
       where jsonb_typeof(e->'values') = 'object'
    ) v
   where c.id = v.contact_id
     and c.org_id = p_org_id
     and (v.vals || c.custom_values) is distinct from c.custom_values;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.import_merge_custom_values(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.import_merge_custom_values(uuid, jsonb) to service_role;

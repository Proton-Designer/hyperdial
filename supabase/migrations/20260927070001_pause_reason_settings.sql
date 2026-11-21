-- MISSION-5 TASK-M5-B1: org-level pause reason list (defaults Break/Lunch/Training/Meeting/
-- Admin/Other; owner/admin editable). Same "org_<feature>_settings" singleton-table shape as
-- org_number_pool_settings/org_spend_settings/org_inbound_settings/org_transfer_settings
-- (select: any org member; insert/update: owner/admin) rather than a column on `orgs` itself --
-- `orgs`' own UPDATE policy is owner-only (20260924000100), and widening that to admin for the
-- sake of one column would also hand admin write access to every OTHER orgs column (name, etc.)
-- with no way to scope it back down; a dedicated table with its own RLS avoids that entirely.
--
-- Client writes go through plain RLS (`.from('org_pause_reason_settings').update(...)`), the same
-- pattern api.ts already uses for org_spend_settings/org_inbound_settings -- no dedicated RPC
-- needed.
--
-- dialer-session-pause deliberately does NOT validate an incoming reason against this list
-- server-side: dial_sessions.pause_reason is already free-form text with no CHECK constraint by
-- design (20260925070000's own comment -- "only trusted engine code ever writes it"), and an org
-- can edit this list after a client has already cached an older copy of it. This table is a UI
-- data source, not a server-side enum.

create table public.org_pause_reason_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  reasons text[] not null default array['Break', 'Lunch', 'Training', 'Meeting', 'Admin', 'Other'],
  updated_at timestamptz not null default now()
);

alter table public.org_pause_reason_settings enable row level security;

create policy "org members can view pause reason settings"
  on public.org_pause_reason_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert pause reason settings"
  on public.org_pause_reason_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update pause reason settings"
  on public.org_pause_reason_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create function private.seed_default_pause_reason_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.org_pause_reason_settings (org_id)
  values (new.id)
  on conflict (org_id) do nothing;
  return new;
end;
$$;

create trigger orgs_seed_default_pause_reason_settings
  after insert on public.orgs
  for each row execute function private.seed_default_pause_reason_settings_trigger();

-- Backfill every org that already exists (this is not a fresh install) so the client never has
-- to handle "no row yet" -- getOrgPauseReasons still falls back to the same hardcoded default
-- list client-side regardless, as defense in depth, but should never actually need to.

insert into public.org_pause_reason_settings (org_id)
select id from public.orgs
on conflict (org_id) do nothing;

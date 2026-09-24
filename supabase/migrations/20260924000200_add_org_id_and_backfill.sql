-- Tenancy foundation (2/3): org_id on every business table, campaign_agents, and the one-time
-- backfill of existing (pre-org) data. See docs/design/stage-1-architecture.md §2.
--
-- Deviation from the design doc, logged here and in .brain/memory/decisions.md: call_events.org_id
-- stays NULLABLE. call_events.user_id has always been nullable (ON DELETE SET NULL, see
-- 20250213000001) and rows with a null user_id are already unreachable under RLS -- there is no
-- user to derive an org from. Forcing org_id NOT NULL there would make this migration fail on any
-- environment that has such a row (the live project is real, recovered data of unknown shape) for
-- no reachability benefit. Every other table in scope keeps NOT NULL per the design.

-- org_id columns (nullable first; backfilled below, then tightened where the design calls for it)

alter table public.campaigns
  add column org_id uuid references public.orgs(id) on delete cascade;

alter table public.contacts
  add column org_id uuid references public.orgs(id) on delete cascade;

alter table public.user_phone_numbers
  add column org_id uuid references public.orgs(id) on delete cascade;

alter table public.notifications
  add column org_id uuid references public.orgs(id) on delete cascade;

alter table public.dialer_sessions
  add column org_id uuid references public.orgs(id) on delete cascade;

alter table public.call_logs
  add column org_id uuid references public.orgs(id) on delete cascade;

alter table public.call_events
  add column org_id uuid references public.orgs(id) on delete set null;

alter table public.campaign_leads
  add column org_id uuid references public.orgs(id) on delete cascade;

-- campaign_agents: brand-new table, no legacy rows to backfill, so org_id is NOT NULL from the
-- start. org_id is denormalized from campaigns.org_id (rather than derived via a join in every
-- policy) so its RLS policies can be written with the helpers directly; a trigger (next migration,
-- alongside the rest of the RLS work) enforces that it always matches the campaign's org.

create table public.campaign_agents (
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (campaign_id, user_id)
);

create index idx_campaign_agents_user_id on public.campaign_agents(user_id);
create index idx_campaign_agents_org_id on public.campaign_agents(org_id);

-- RLS enabled now (default-deny with zero policies is safe); policies land in the next migration
-- alongside the rest of the RLS rewrite.
alter table public.campaign_agents enable row level security;

-- Backfill: one org per existing auth user (owner), idempotent and a no-op on an empty DB.

do $$
declare
  u record;
begin
  for u in select id from auth.users loop
    perform private.ensure_org_for_user(u.id);
  end loop;
end;
$$;

-- Backfill org_id on every row from its owning user's (now-existing) org.

update public.campaigns c
set org_id = m.org_id
from public.org_members m
where m.user_id = c.user_id and m.role = 'owner' and c.org_id is null;

update public.contacts c
set org_id = m.org_id
from public.org_members m
where m.user_id = c.user_id and m.role = 'owner' and c.org_id is null;

update public.user_phone_numbers p
set org_id = m.org_id
from public.org_members m
where m.user_id = p.user_id and m.role = 'owner' and p.org_id is null;

update public.notifications n
set org_id = m.org_id
from public.org_members m
where m.user_id = n.user_id and m.role = 'owner' and n.org_id is null;

update public.dialer_sessions d
set org_id = m.org_id
from public.org_members m
where m.user_id = d.user_id and m.role = 'owner' and d.org_id is null;

update public.call_logs c
set org_id = m.org_id
from public.org_members m
where m.user_id = c.user_id and m.role = 'owner' and c.org_id is null;

update public.call_events e
set org_id = m.org_id
from public.org_members m
where m.user_id = e.user_id and m.role = 'owner' and e.org_id is null and e.user_id is not null;

-- campaign_leads has no direct user_id; its org is its campaign's org (already backfilled above).
update public.campaign_leads cl
set org_id = c.org_id
from public.campaigns c
where c.id = cl.campaign_id and cl.org_id is null;

-- Every row must now have an org (except call_events, see the note at the top of this file).

alter table public.campaigns alter column org_id set not null;
alter table public.contacts alter column org_id set not null;
alter table public.user_phone_numbers alter column org_id set not null;
alter table public.notifications alter column org_id set not null;
alter table public.dialer_sessions alter column org_id set not null;
alter table public.call_logs alter column org_id set not null;
alter table public.campaign_leads alter column org_id set not null;

create index idx_campaigns_org_id on public.campaigns(org_id);
create index idx_contacts_org_id on public.contacts(org_id);
create index idx_user_phone_numbers_org_id on public.user_phone_numbers(org_id);
create index idx_notifications_org_id on public.notifications(org_id);
create index idx_dialer_sessions_org_id on public.dialer_sessions(org_id);
create index idx_call_logs_org_id on public.call_logs(org_id);
create index idx_call_events_org_id on public.call_events(org_id);
create index idx_campaign_leads_org_id on public.campaign_leads(org_id);

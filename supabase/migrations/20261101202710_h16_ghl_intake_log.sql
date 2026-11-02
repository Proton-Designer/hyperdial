-- TASK-H16: one row per handled GHL webhook lead intake (shown to owner/admin in Settings -> GoHighLevel).
-- Service-only, like ghl_webhook_state / ghl_webhook_seen: RLS ON with NO policy and no grant for anon/authenticated, so
-- the rows (contact ids, outcomes) are reachable only through the ghl-webhook / ghl-webhook-settings Edge Functions, where
-- owner/admin is checked. Pruned to 30 days by the ghl-webhook function itself on every insert.
create table public.ghl_intake_log (
  id bigint generated always as identity primary key,
  org_id uuid not null references public.orgs (id) on delete cascade,
  received_at timestamptz not null default now(),
  ghl_contact_id text not null,
  contact_id uuid references public.contacts (id) on delete set null,
  campaign_id uuid references public.campaigns (id) on delete set null,
  outcome text not null check (outcome in (
    'queued', 'already_queued', 'skipped_dnc', 'skipped_paused',
    'skipped_active_elsewhere', 'no_matching_rule', 'error'
  )),
  detail text
);
create index ghl_intake_log_org_received_idx on public.ghl_intake_log (org_id, received_at desc);
alter table public.ghl_intake_log enable row level security;
revoke all on table public.ghl_intake_log from public, anon, authenticated;
grant select, insert, update, delete on table public.ghl_intake_log to service_role;

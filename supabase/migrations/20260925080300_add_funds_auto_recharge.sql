-- TASK-BF1: add funds + auto-recharge from inside HyperDial (owner AND admin). User order
-- (verbatim): "go ahead and fully build out/integrate the add funds capbilty and the abilty to
-- turn on auto-recharge and control its settings as well ... this capabilty should be avaiable
-- for admins as well not just owner."
--
-- org_billing_events: an audit trail of every add-funds charge and auto-recharge settings
-- change, same "owner/admin SELECT only, no client writes at all (service role only)" shape as
-- crm_sync_jobs (20260924000900) -- RLS enabled with only a SELECT policy, zero INSERT/UPDATE/
-- DELETE policies, so even though Supabase's project-level default privileges GRANT those verbs
-- to authenticated at the table level (see 20260925080000's own header for the full citation),
-- RLS itself denies every row for a command with no permissive policy -- this is a plain TABLE,
-- not a security_invoker=false VIEW, so there is no view-owner-bypass risk here the way that
-- migration's fix addressed; RLS enforcement on a base table applies directly to the caller.
--
-- Real money: telnyx-billing/index.ts inserts a 'pending' row BEFORE calling Telnyx, then updates
-- it to 'succeeded'/'failed' after -- a crash mid-charge leaves a visible pending row, never a
-- silent double charge. idempotency_key's own unique-per-org constraint is the second line of
-- defense against an actual double charge from a client retry (nullable: only add_funds rows set
-- it; an auto_recharge_update row has no charge to dedupe, so it stays null and never conflicts).

create table public.org_billing_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  -- Nullable + ON DELETE SET NULL (not CASCADE, unlike most user_id columns in this schema) --
  -- this is a financial audit trail; deleting the user who triggered a charge must never delete
  -- the record that the charge happened. Same shape as call_events.user_id (20250213000001).
  user_id uuid references auth.users(id) on delete set null,
  kind text not null check (kind in ('add_funds', 'auto_recharge_update')),
  amount_usd numeric(10,2),
  idempotency_key uuid,
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  telnyx_transaction_id text,
  error text,
  -- add_funds: not used. auto_recharge_update: {before: {...}, after: {...}} snapshot of the
  -- prefs, since Telnyx's own auto-recharge-prefs response is the only record of what changed.
  request_snapshot jsonb,
  created_at timestamptz not null default now()
);

-- Unique PER ORG (not globally) -- the task's own spec. A null idempotency_key (every
-- auto_recharge_update row) never participates in the uniqueness check at all.
create unique index org_billing_events_org_idempotency_key_key
  on public.org_billing_events (org_id, idempotency_key)
  where idempotency_key is not null;

-- Rate-limit queries (isAddFundsRateLimited/wouldExceedDailyAddFundsCap in
-- _shared/billing-validation.ts) filter on org_id + kind + status + a created_at window -- this
-- index covers all four without a second lookup.
create index idx_org_billing_events_org_kind_status_created_at
  on public.org_billing_events (org_id, kind, status, created_at desc);

alter table public.org_billing_events enable row level security;

create policy "owner or admin can view org_billing_events"
  on public.org_billing_events for select
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- Belt and braces, same reasoning as 20260925080000's identical revoke: is_org_member/
-- has_org_role already return false for anon (no auth.uid()), so anon's SELECT already yields
-- zero rows -- revoked anyway so "can anon read this at all" is never a question for a table
-- that holds billing history.
revoke all on public.org_billing_events from anon;

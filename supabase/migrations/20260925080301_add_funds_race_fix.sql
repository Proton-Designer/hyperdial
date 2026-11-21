-- TASK-BF1 fix (lead + eng2 review, HIGH): runAddFundsAction's rate-limit/cap checks and the
-- pending-row insert were three separate round-trips (two SELECTs against status='succeeded'
-- only, then an INSERT) -- not atomic, and blind to any 'pending' row already in flight. Two
-- concurrent add_funds requests for the same org with DIFFERENT idempotency keys (two admins, or
-- two tabs -- the existing (org_id, idempotency_key) unique index never fires, since the keys
-- differ) each see "nothing recent / cap not hit yet" before either one's own Telnyx call
-- resolves, so both pass both checks and both charge Telnyx -- jointly violating the 1-per-60s
-- and $2,000/24h invariants the task itself requires.
--
-- Fix: move the checks + the insert into ONE atomic public SQL function, serialized per-org with
-- pg_advisory_xact_lock (a transaction-scoped lock, released automatically at commit/rollback --
-- no separate unlock call needed). Counts status IN ('pending', 'succeeded', 'unknown') for both
-- the 60s interval and the 24h cap -- not just 'succeeded' -- so a charge still in flight (or one
-- whose outcome is unknown, see below) blocks a second one from starting at all, closing the race
-- at its root instead of only detecting it after the fact. A 'failed' row (a DEFINITE rejection --
-- see below) never counts: no charge was actually attempted, so it must not consume a slot.
--
-- Distinct SQLSTATEs (custom application-level codes, 'BF' prefix -- not a standard PostgreSQL
-- error class) let billing-core.ts map each rejection to the right HTTP status/error code without
-- parsing message text: BF001 = RATE_LIMITED (429), BF002 = DAILY_CAP_EXCEEDED (400), BF003 =
-- DUPLICATE_REQUEST (409, checked explicitly here too, not left only to the unique index, so one
-- error-code-mapping path in billing-core.ts covers every rejection reason).
--
-- ADD_FUNDS_MIN_INTERVAL_SECONDS (60) and ADD_FUNDS_DAILY_CAP_USD (2000) are hardcoded below,
-- duplicating the constants of the same name in _shared/billing-validation.ts -- the lead's own
-- function signature (reserve_add_funds(p_org, p_user, p_amount, p_key), no cap/interval params)
-- has no way to pass them through. If either constant ever changes, this function must change
-- with it -- there is no single source of truth across SQL and TypeScript for these two numbers.
--
-- Also adds 'unknown' to org_billing_events.status (companion fix, eng2 review finding #2): an
-- AMBIGUOUS Telnyx outcome (a network error/timeout, or a 5xx -- Telnyx may or may not have
-- actually charged the card) is now recorded as 'unknown', not 'failed', KEEPING its
-- idempotency_key so a same-key retry is blocked by the unique index until a human confirms the
-- real balance/the Telnyx portal. A DEFINITE Telnyx rejection (a 4xx -- declined, no payment
-- method, invalid amount, bad key, etc.) stays 'failed' but has its idempotency_key set to null,
-- freeing the slot: no charge was attempted, so it's safe for the dialog to mint a fresh key and
-- let the user retry from the amount step. (Previously every failure permanently burned its key
-- with no server-side distinction between the two cases -- the only visible retry affordance hit
-- a false-positive 409 "already submitted" even for a plain declined card.)
--
-- New migration, not an edit of 20260925080300 in place: 080300 isn't applied live yet (either
-- would have been append-only-safe), but leaving that create-table migration untouched is simpler
-- to reason about against the docs/decisions.md that already quote it verbatim.

alter table public.org_billing_events
  drop constraint org_billing_events_status_check;
alter table public.org_billing_events
  add constraint org_billing_events_status_check
  check (status in ('pending', 'succeeded', 'failed', 'unknown'));

create function public.reserve_add_funds(
  p_org uuid,
  p_user uuid,
  p_amount numeric,
  p_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_window_start timestamptz := now() - interval '60 seconds';
  v_day_start timestamptz := now() - interval '24 hours';
  v_recent_count int;
  v_day_total numeric;
  v_new_id uuid;
begin
  -- Serializes every reserve_add_funds call for the SAME org -- a concurrent call for a
  -- DIFFERENT org proceeds immediately; a concurrent call for the SAME org blocks here until the
  -- first one's transaction commits or rolls back, at which point it sees that first call's own
  -- pending/succeeded/unknown row in the counts below. This is the actual fix for the race --
  -- everything after this line is no longer a check-then-act race between two backends.
  perform pg_advisory_xact_lock(hashtextextended('add_funds:' || p_org::text, 0));

  if exists (
    select 1 from public.org_billing_events
    where org_id = p_org and idempotency_key = p_key
  ) then
    raise exception using
      errcode = 'BF003',
      message = 'This add-funds request was already submitted.';
  end if;

  select count(*) into v_recent_count
  from public.org_billing_events
  where org_id = p_org
    and kind = 'add_funds'
    and status in ('pending', 'succeeded', 'unknown')
    and created_at >= v_window_start;
  if v_recent_count > 0 then
    raise exception using
      errcode = 'BF001',
      message = 'Please wait a moment before adding funds again (at most once every 60s).';
  end if;

  select coalesce(sum(amount_usd), 0) into v_day_total
  from public.org_billing_events
  where org_id = p_org
    and kind = 'add_funds'
    and status in ('pending', 'succeeded', 'unknown')
    and created_at >= v_day_start;
  if v_day_total + p_amount > 2000 then
    raise exception using
      errcode = 'BF002',
      message = format(
        'This would exceed the $2000.00/24h add-funds limit for this org ($%s already added in the last 24h).',
        to_char(v_day_total, 'FM999999990.00')
      );
  end if;

  insert into public.org_billing_events (org_id, user_id, kind, amount_usd, idempotency_key, status)
  values (p_org, p_user, 'add_funds', p_amount, p_key, 'pending')
  returning id into v_new_id;

  return v_new_id;
end;
$$;

revoke all on function public.reserve_add_funds(uuid, uuid, numeric, uuid) from public, anon, authenticated;
grant execute on function public.reserve_add_funds(uuid, uuid, numeric, uuid) to service_role;

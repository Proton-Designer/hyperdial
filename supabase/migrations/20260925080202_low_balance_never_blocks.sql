-- TASK-SP2 -- USER ORDER (verbatim, 2026-09-25): "why is dialing blocked below 5$, that should
-- tbe the case, it shouldnt be blocked at all, it should only send a warning below 2$".
--
-- A low balance no longer blocks Go Ready or a number purchase at all (spend-gate.ts's own
-- LOW_BALANCE block is removed in the same commit as this migration) -- only the org's own
-- opted-in monthly spend cap (SPEND_CAP_REACHED, null by default) still blocks. The low-balance
-- alert becomes the ONLY balance-based signal: a non-blocking warning at Go Ready plus the
-- existing hourly in-app alert / Dashboard banner (both already keyed on low_balance_alert_usd,
-- not min_balance_to_dial_usd -- unaffected by this migration). Its default drops from $20 to
-- the user's own requested $2.

-- New default for every NEW org going forward.
alter table public.org_spend_settings
  alter column low_balance_alert_usd set default 2;

-- Existing orgs still sitting on the OLD default (20, never customized) move to the new default.
-- An org that already tuned this value away from 20 is a deliberate choice and is left alone.
update public.org_spend_settings
  set low_balance_alert_usd = 2
  where low_balance_alert_usd = 20;

-- min_balance_to_dial_usd stays in the table (migrations are append-only, and nothing else here
-- reads it once spend-gate.ts's blocking branch is removed) but is now dead weight -- documented
-- in place rather than silently left to confuse the next reader.
comment on column public.org_spend_settings.min_balance_to_dial_usd is
  'deprecated 2026-09-25 (TASK-SP2): low balance never blocks dialing anymore. Column kept for append-only history; unused by every code path.';

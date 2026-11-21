-- Perf fix-forward for TASK-P2-E1's 20260924001000 fix D. private.safe_timezone scanned
-- pg_timezone_names (a view over the tzdata catalog, not indexed for equality lookups) on every
-- call; claim_next_leads calls it once per candidate lead BEFORE the LIMIT, so a large campaign's
-- claim scaled with total queued leads, not with p_n. Measured ~48ms/call by the lead -- a 10k-lead
-- campaign took minutes per claim.
--
-- Fix: snapshot pg_timezone_names into a real table with a primary key once, at migration time,
-- and have safe_timezone do a PK lookup against that instead of scanning the catalog view.
-- Timezone data changes only with a Postgres/tzdata upgrade, not at runtime, so a snapshot is safe
-- -- there is no live-updating requirement here.

create table private.valid_timezones (
  name text primary key
);

insert into private.valid_timezones (name)
select name from pg_catalog.pg_timezone_names;

-- Not PostgREST-exposed and holds no user data, but every new table gets RLS per this repo's hard
-- constraint regardless -- default-deny (no policies) costs nothing here since the only readers
-- are SECURITY DEFINER call chains rooted at this migration's owning role, which bypass RLS.
alter table private.valid_timezones enable row level security;

create or replace function private.safe_timezone(p_timezone text)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when p_timezone is not null
      and exists (select 1 from private.valid_timezones where name = p_timezone)
    then p_timezone
    else null
  end;
$$;

-- is_lead_callable_now previously called safe_timezone() twice per row (once per comparison in the
-- non-null branch) -- doubling the already-hot per-candidate cost in claim_next_leads. Compute it
-- once via the FROM-subquery and reuse the result.
create or replace function private.is_lead_callable_now(p_timezone text, p_window_start time, p_window_end time)
returns boolean
language sql
stable
set search_path = ''
as $$
  select case
    when z is not null then
      (now() at time zone z)::time >= p_window_start
      and (now() at time zone z)::time < p_window_end
    else
      (now() at time zone 'America/New_York')::time >= p_window_start
      and (now() at time zone 'America/New_York')::time < p_window_end
      and (now() at time zone 'America/Los_Angeles')::time >= p_window_start
      and (now() at time zone 'America/Los_Angeles')::time < p_window_end
  end
  from (select private.safe_timezone(p_timezone) as z) t;
$$;

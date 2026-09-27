-- MISSION-4 TASK-T9: caller-ID health (CID-4) + local-presence fallback. eng1's own assigned
-- range (20260926080000-089999), next unused slot after 080000/080100/080200/080300/080400/080500.
--
-- Scope note: the task also asks to "research whether Telnyx offers a spam/reputation lookup" --
-- spec3.json DOES have one (`/v2/reputation/numbers/{phone_number}`, `GET`), but it sits behind
-- `/v2/enterprises/{enterprise_id}/...` and a one-time `/v2/terms_of_service/number_reputation/
-- agree` acceptance -- Telnyx's "Enterprise" reputation-monitoring product, not a plain per-call
-- endpoint on the standard account tier this build uses. spec3.json's own schema carries no
-- pricing info, and this environment has no enterprise-tier Telnyx account to test against, so
-- the cost/eligibility can't be confirmed from here. Per the task's own "if it costs money, build
-- it disabled + document the cost" instruction: since the cost itself is unconfirmed, NOT wired
-- up at all this task -- documented as a follow-up decision for the lead/business, not guessed at.
-- See audit/T9/api-evidence.md and decisions.md for the full note.
--
-- CID-4 (this migration's real deliverable) needs no external API at all: it's entirely derived
-- from this org's own call_legs history (outcome = 'connected' as the human-answer signal, same
-- definition call_leg_analytics/dial_session_hours already use for "is_connected").

-- =================================================================================================
-- 1. user_phone_numbers: observability-only columns for a CID-4 flag. The actual enforcement
--    reuses the EXISTING 'resting'/resting_until mechanism (20260925070000) verbatim -- a flagged
--    number is just an auto-triggered rest with a reason attached, not a new status value (no
--    widening of the existing CHECK constraint, no new branch in pick_and_reserve_dial_number's
--    own `status = 'active'` filter to keep in sync).
-- =================================================================================================

alter table public.user_phone_numbers
  add column flagged_at timestamptz,
  add column flagged_reason text;

comment on column public.user_phone_numbers.flagged_reason is
  'MISSION-4 TASK-T9 (CID-4): set only when check_number_health auto-rested this number for a
   below-median human-answer rate. Purely observational -- the actual rest is the existing
   status=''resting''/resting_until pair (20260925070000), reactivated the same lazy way as an
   ordinary daily-cap rest. Left as history after reactivation; not cleared automatically.';

-- =================================================================================================
-- 2. private.area_code_states: NANP area code -> two-letter US state/territory, mirroring
--    private.area_code_timezones' own shape and scope exactly (20260924001300: "NANP-only... a
--    foreign code simply returns null"). A SEPARATE table, not a column bolted onto
--    area_code_timezones, since that table belongs to TASK-P2-P1's own contacts-timezone feature
--    and this is a different consumer (pick_and_reserve_dial_number, private schema only, no
--    client ever reads this directly -- same "no policies needed" reasoning as
--    area_code_timezones' own comment).
--
--    Source: Wikipedia's "List of North American Numbering Plan area codes" (fetched 2026-09-27),
--    the SAME source area_code_timezones itself already cites. Extracted programmatically (parsed
--    the raw page's assignment table, mapped each area code's location text to its first-listed US
--    state/territory name; Canadian/Caribbean entries and reserved/unassigned codes are correctly
--    excluded, matching area_code_timezones' own "out of scope by design" precedent) and spot-
--    checked against a representative, geographically-spread sample (~60 codes across every
--    region) plus every code whose location text mentions 2+ US state names (15 codes -- all
--    boundary-area codes like 304/681 West Virginia vs Virginia, 410/443/667 Maryland vs a
--    Delaware-border mention -- confirmed each picked the correct PRIMARY state, not an
--    incidental one). This is the same "proportionate, not exhaustive" verification standard
--    area_code_timezones' own build used (a wrong entry here only ever weakens a *preference*
--    tier below the existing area-code-match tier -- it can never mis-dial or error).
-- =================================================================================================

create table private.area_code_states (
  area_code text primary key,
  state text not null
);

alter table private.area_code_states enable row level security;
-- No policies: not PostgREST-exposed, holds no user data, only read by
-- private.pick_and_reserve_dial_number below (same shape as area_code_timezones).

insert into private.area_code_states (area_code, state) values
  ('201', 'NJ'),
  ('202', 'DC'),
  ('203', 'CT'),
  ('205', 'AL'),
  ('206', 'WA'),
  ('207', 'ME'),
  ('208', 'ID'),
  ('209', 'CA'),
  ('210', 'TX'),
  ('212', 'NY'),
  ('213', 'CA'),
  ('214', 'TX'),
  ('215', 'PA'),
  ('216', 'OH'),
  ('217', 'IL'),
  ('218', 'MN'),
  ('219', 'IN'),
  ('220', 'OH'),
  ('223', 'PA'),
  ('224', 'IL'),
  ('225', 'LA'),
  ('227', 'MD'),
  ('228', 'MS'),
  ('229', 'GA'),
  ('231', 'MI'),
  ('234', 'OH'),
  ('235', 'MO'),
  ('239', 'FL'),
  ('240', 'MD'),
  ('248', 'MI'),
  ('251', 'AL'),
  ('252', 'NC'),
  ('253', 'WA'),
  ('254', 'TX'),
  ('256', 'AL'),
  ('260', 'IN'),
  ('262', 'WI'),
  ('267', 'PA'),
  ('269', 'MI'),
  ('270', 'KY'),
  ('272', 'PA'),
  ('274', 'WI'),
  ('276', 'VA'),
  ('279', 'CA'),
  ('281', 'TX'),
  ('283', 'OH'),
  ('301', 'MD'),
  ('302', 'DE'),
  ('303', 'CO'),
  ('304', 'WV'),
  ('305', 'FL'),
  ('307', 'WY'),
  ('308', 'NE'),
  ('309', 'IL'),
  ('310', 'CA'),
  ('312', 'IL'),
  ('313', 'MI'),
  ('314', 'MO'),
  ('315', 'NY'),
  ('316', 'KS'),
  ('317', 'IN'),
  ('318', 'LA'),
  ('319', 'IA'),
  ('320', 'MN'),
  ('321', 'FL'),
  ('323', 'CA'),
  ('324', 'FL'),
  ('325', 'TX'),
  ('326', 'OH'),
  ('327', 'AR'),
  ('329', 'NY'),
  ('330', 'OH'),
  ('331', 'IL'),
  ('332', 'NY'),
  ('334', 'AL'),
  ('336', 'NC'),
  ('337', 'LA'),
  ('339', 'MA'),
  ('341', 'CA'),
  ('346', 'TX'),
  ('347', 'NY'),
  ('350', 'CA'),
  ('351', 'MA'),
  ('352', 'FL'),
  ('353', 'WI'),
  ('357', 'CA'),
  ('360', 'WA'),
  ('361', 'TX'),
  ('363', 'NY'),
  ('364', 'KY'),
  ('369', 'CA'),
  ('380', 'OH'),
  ('385', 'UT'),
  ('386', 'FL'),
  ('401', 'RI'),
  ('402', 'NE'),
  ('404', 'GA'),
  ('405', 'OK'),
  ('406', 'MT'),
  ('407', 'FL'),
  ('408', 'CA'),
  ('409', 'TX'),
  ('410', 'MD'),
  ('412', 'PA'),
  ('413', 'MA'),
  ('414', 'WI'),
  ('415', 'CA'),
  ('417', 'MO'),
  ('419', 'OH'),
  ('423', 'TN'),
  ('424', 'CA'),
  ('425', 'WA'),
  ('430', 'TX'),
  ('432', 'TX'),
  ('434', 'VA'),
  ('435', 'UT'),
  ('436', 'OH'),
  ('440', 'OH'),
  ('442', 'CA'),
  ('443', 'MD'),
  ('445', 'PA'),
  ('447', 'IL'),
  ('448', 'FL'),
  ('457', 'LA'),
  ('463', 'IN'),
  ('465', 'NY'),
  ('469', 'TX'),
  ('472', 'NC'),
  ('475', 'CT'),
  ('478', 'GA'),
  ('479', 'AR'),
  ('480', 'AZ'),
  ('483', 'AL'),
  ('484', 'PA'),
  ('501', 'AR'),
  ('502', 'KY'),
  ('503', 'OR'),
  ('504', 'LA'),
  ('505', 'NM'),
  ('507', 'MN'),
  ('508', 'MA'),
  ('509', 'WA'),
  ('510', 'CA'),
  ('512', 'TX'),
  ('513', 'OH'),
  ('515', 'IA'),
  ('516', 'NY'),
  ('517', 'MI'),
  ('518', 'NY'),
  ('520', 'AZ'),
  ('530', 'CA'),
  ('531', 'NE'),
  ('534', 'WI'),
  ('540', 'VA'),
  ('541', 'OR'),
  ('551', 'NJ'),
  ('557', 'MO'),
  ('559', 'CA'),
  ('561', 'FL'),
  ('562', 'CA'),
  ('563', 'IA'),
  ('564', 'WA'),
  ('567', 'OH'),
  ('570', 'PA'),
  ('571', 'VA'),
  ('572', 'OK'),
  ('573', 'MO'),
  ('574', 'IN'),
  ('575', 'NM'),
  ('580', 'OK'),
  ('586', 'MI'),
  ('601', 'MS'),
  ('602', 'AZ'),
  ('603', 'NH'),
  ('605', 'SD'),
  ('606', 'KY'),
  ('607', 'NY'),
  ('608', 'WI'),
  ('609', 'NJ'),
  ('610', 'PA'),
  ('612', 'MN'),
  ('614', 'OH'),
  ('615', 'TN'),
  ('616', 'MI'),
  ('617', 'MA'),
  ('618', 'IL'),
  ('619', 'CA'),
  ('620', 'KS'),
  ('623', 'AZ'),
  ('624', 'NY'),
  ('626', 'CA'),
  ('628', 'CA'),
  ('629', 'TN'),
  ('630', 'IL'),
  ('631', 'NY'),
  ('636', 'MO'),
  ('640', 'NJ'),
  ('641', 'IA'),
  ('645', 'FL'),
  ('646', 'NY'),
  ('650', 'CA'),
  ('651', 'MN'),
  ('657', 'CA'),
  ('659', 'AL'),
  ('660', 'MO'),
  ('661', 'CA'),
  ('662', 'MS'),
  ('667', 'MD'),
  ('669', 'CA'),
  ('678', 'GA'),
  ('679', 'MI'),
  ('680', 'NY'),
  ('681', 'WV'),
  ('682', 'TX'),
  ('686', 'VA'),
  ('689', 'FL'),
  ('701', 'ND'),
  ('702', 'NV'),
  ('703', 'VA'),
  ('704', 'NC'),
  ('706', 'GA'),
  ('707', 'CA'),
  ('708', 'IL'),
  ('712', 'IA'),
  ('713', 'TX'),
  ('714', 'CA'),
  ('715', 'WI'),
  ('716', 'NY'),
  ('717', 'PA'),
  ('718', 'NY'),
  ('719', 'CO'),
  ('720', 'CO'),
  ('724', 'PA'),
  ('725', 'NV'),
  ('726', 'TX'),
  ('727', 'FL'),
  ('728', 'FL'),
  ('729', 'TN'),
  ('730', 'IL'),
  ('731', 'TN'),
  ('734', 'MI'),
  ('737', 'TX'),
  ('738', 'CA'),
  ('740', 'OH'),
  ('743', 'NC'),
  ('747', 'CA'),
  ('754', 'FL'),
  ('757', 'VA'),
  ('760', 'CA'),
  ('762', 'GA'),
  ('763', 'MN'),
  ('765', 'IN'),
  ('769', 'MS'),
  ('770', 'GA'),
  ('772', 'FL'),
  ('773', 'IL'),
  ('774', 'MA'),
  ('775', 'NV'),
  ('779', 'IL'),
  ('781', 'MA'),
  ('785', 'KS'),
  ('786', 'FL'),
  ('787', 'PR'),
  ('801', 'UT'),
  ('802', 'VT'),
  ('803', 'SC'),
  ('804', 'VA'),
  ('805', 'CA'),
  ('806', 'TX'),
  ('810', 'MI'),
  ('812', 'IN'),
  ('813', 'FL'),
  ('814', 'PA'),
  ('815', 'IL'),
  ('816', 'MO'),
  ('817', 'TX'),
  ('818', 'CA'),
  ('820', 'CA'),
  ('826', 'VA'),
  ('828', 'NC'),
  ('830', 'TX'),
  ('831', 'CA'),
  ('832', 'TX'),
  ('838', 'NY'),
  ('843', 'SC'),
  ('845', 'NY'),
  ('847', 'IL'),
  ('850', 'FL'),
  ('854', 'SC'),
  ('856', 'NJ'),
  ('857', 'MA'),
  ('858', 'CA'),
  ('859', 'KY'),
  ('860', 'CT'),
  ('861', 'IL'),
  ('862', 'NJ'),
  ('863', 'FL'),
  ('864', 'SC'),
  ('865', 'TN'),
  ('870', 'AR'),
  ('872', 'IL'),
  ('878', 'PA'),
  ('901', 'TN'),
  ('903', 'TX'),
  ('904', 'FL'),
  ('906', 'MI'),
  ('907', 'AK'),
  ('908', 'NJ'),
  ('910', 'NC'),
  ('912', 'GA'),
  ('913', 'KS'),
  ('914', 'NY'),
  ('915', 'TX'),
  ('916', 'CA'),
  ('917', 'NY'),
  ('918', 'OK'),
  ('919', 'NC'),
  ('920', 'WI'),
  ('925', 'CA'),
  ('928', 'AZ'),
  ('929', 'NY'),
  ('930', 'IN'),
  ('931', 'TN'),
  ('936', 'TX'),
  ('937', 'OH'),
  ('938', 'AL'),
  ('939', 'PR'),
  ('940', 'TX'),
  ('941', 'FL'),
  ('947', 'MI'),
  ('949', 'CA'),
  ('951', 'CA'),
  ('952', 'MN'),
  ('954', 'FL'),
  ('956', 'TX'),
  ('959', 'CT'),
  ('970', 'CO'),
  ('971', 'OR'),
  ('972', 'TX'),
  ('973', 'NJ'),
  ('978', 'MA'),
  ('979', 'TX'),
  ('980', 'NC'),
  ('984', 'NC'),
  ('985', 'LA'),
  ('989', 'MI');

-- =================================================================================================
-- 3. org_number_health_settings: CID-4's per-org opt-in, same "member read, owner/admin write,
--    seed-on-org-create + one-time backfill, DISABLED by default" shape as
--    org_reliability_alert_settings (20260926080400). Thresholds are DOCUMENTED, not
--    per-org-configurable (same choice T10 made) -- min_sample_dials/flag_threshold_ratio/
--    rest_days_on_flag columns exist so a future task can make them adjustable without a schema
--    change, but this task only ever writes the defaults below.
--
--    Thresholds:
--      - min_sample_dials = 20: a number needs at least 20 dials in the trailing 30 days before
--        its answer rate is trusted at all (both to be a flag CANDIDATE and to count toward the
--        pool's own median) -- a number with 2 dials and 0 connects is just as likely unlucky as
--        actually bad; 20 is the same order-of-magnitude minimum-sample bar CID-1's own daily-cap
--        design implicitly assumes (a handful of numbers each taking a meaningful slice of a
--        100/day cap).
--      - flag_threshold_ratio = 0.5: flag a number whose human-answer rate is below HALF the
--        pool's own median rate (among numbers that also clear min_sample_dials) -- "well below
--        the pool median," not merely below-average; a number at 90% of median is normal
--        variance, one at 40% of median is a real signal (dead air, a carrier-side spam/blocked
--        listing, a wrong outbound CNAM).
--      - rest_days_on_flag = 7: longer than the existing daily-cap rest default (2 days,
--        org_number_pool_settings.rest_days) -- a capacity rest is routine; a health flag means
--        something is plausibly wrong with the number itself and deserves a longer cooldown before
--        it's back in rotation, though nothing here prevents an owner/admin manually reactivating
--        it sooner via the existing number-management UI.
-- =================================================================================================

create table public.org_number_health_settings (
  org_id uuid primary key references public.orgs(id) on delete cascade,
  health_alerts_enabled boolean not null default false,
  min_sample_dials int not null default 20 check (min_sample_dials > 0),
  flag_threshold_ratio numeric not null default 0.5 check (flag_threshold_ratio > 0 and flag_threshold_ratio < 1),
  rest_days_on_flag int not null default 7 check (rest_days_on_flag >= 0),
  last_health_alert_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.org_number_health_settings enable row level security;

create policy "org members can view number health settings"
  on public.org_number_health_settings for select
  using (private.is_org_member(org_id));

create policy "owner or admin can insert number health settings"
  on public.org_number_health_settings for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update number health settings"
  on public.org_number_health_settings for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create function private.seed_default_number_health_settings(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.org_number_health_settings (org_id)
  values (p_org)
  on conflict (org_id) do nothing;
$$;

create function private.seed_default_number_health_settings_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.seed_default_number_health_settings(new.id);
  return new;
end;
$$;

create trigger orgs_seed_default_number_health_settings
  after insert on public.orgs
  for each row execute function private.seed_default_number_health_settings_trigger();

do $$
declare
  v_org record;
begin
  for v_org in select id from public.orgs loop
    perform private.seed_default_number_health_settings(v_org.id);
  end loop;
end;
$$;

-- =================================================================================================
-- 4. number_health_stats: per-number dials/human-answer-rate/avg-talk-time over trailing 7d/30d,
--    for Settings -> Telephony -> Numbers. security_invoker=on (same convention as
--    call_leg_analytics/dial_session_hours) -- an eventual direct authenticated-client read is
--    safe under org-scoped RLS on the underlying tables; today's edge function still applies its
--    own explicit org filter regardless (service-role always bypasses RLS, security_invoker or
--    not -- same distinction call_leg_analytics' own comment already makes).
--    "Human answer" = outcome = 'connected', the SAME definition call_leg_analytics'
--    is_connected column already uses -- not a new metric, reused verbatim.
-- =================================================================================================

create view public.number_health_stats with (security_invoker = on) as
select
  upn.id as number_id,
  upn.org_id,
  upn.phone_number,
  upn.status,
  upn.flagged_at,
  upn.flagged_reason,
  count(cl.id) filter (where cl.created_at >= now() - interval '7 days') as dials_7d,
  count(cl.id) filter (where cl.created_at >= now() - interval '7 days' and cl.outcome = 'connected') as connected_7d,
  round(
    count(cl.id) filter (where cl.created_at >= now() - interval '7 days' and cl.outcome = 'connected')::numeric
    / nullif(count(cl.id) filter (where cl.created_at >= now() - interval '7 days'), 0),
    4
  ) as human_answer_rate_7d,
  round(
    avg(cl.duration_seconds) filter (
      where cl.created_at >= now() - interval '7 days' and cl.duration_seconds is not null
    ),
    1
  ) as avg_talk_seconds_7d,
  count(cl.id) filter (where cl.created_at >= now() - interval '30 days') as dials_30d,
  count(cl.id) filter (where cl.created_at >= now() - interval '30 days' and cl.outcome = 'connected') as connected_30d,
  round(
    count(cl.id) filter (where cl.created_at >= now() - interval '30 days' and cl.outcome = 'connected')::numeric
    / nullif(count(cl.id) filter (where cl.created_at >= now() - interval '30 days'), 0),
    4
  ) as human_answer_rate_30d,
  round(
    avg(cl.duration_seconds) filter (
      where cl.created_at >= now() - interval '30 days' and cl.duration_seconds is not null
    ),
    1
  ) as avg_talk_seconds_30d
from public.user_phone_numbers upn
left join public.call_legs cl
  on cl.from_number_id = upn.id and cl.kind = 'contact' and cl.created_at >= now() - interval '30 days'
group by upn.id, upn.org_id, upn.phone_number, upn.status, upn.flagged_at, upn.flagged_reason;

-- =================================================================================================
-- 5. check_number_health: SQL decides + flips atomically (same "decide and mark in one statement"
--    shape as check_stuck_dial_sessions/check_webhook_error_spikes, 20260926080400) -- two
--    concurrent calls can never double-flag the same number. PUBLIC schema (every supabase.rpc()
--    target must be, per this task's own rule) but still SECURITY DEFINER + revoked from
--    anon/authenticated, called only by the edge function below with the service-role client (the
--    on-demand path additionally checks the caller's own owner/admin role in TypeScript first,
--    same "TS auth check before the RPC" shape as dialer-session-disposition/submit_disposition).
--
--    p_org_id: null (the cron sweep) processes every org with health_alerts_enabled = true only --
--    the AUTOMATIC path stays opt-in/disabled-by-default per CLAUDE.md's own rule. A specific org
--    id (the on-demand button) runs the SAME check for that one org regardless of its own
--    health_alerts_enabled flag -- an explicit, user-initiated check is not "new automatic
--    behaviour" and deliberately isn't gated by the auto-alert opt-in.
--
--    Dedup: only a currently status='active' number is ever a flag candidate -- once flagged it
--    becomes 'resting' (the existing mechanism) and drops out of consideration on its own until
--    reactivate_rested_numbers (already called by has_available_dial_number/
--    pick_and_reserve_dial_number's own lazy check) returns it to 'active', at which point it is
--    naturally re-eligible for a fresh flag on the next run -- never a repeat alert for the same
--    flagged spell.
-- =================================================================================================

create function public.check_number_health(p_org_id uuid default null)
returns table (
  number_id uuid,
  org_id uuid,
  phone_number text,
  sample_dials int,
  human_answer_rate numeric,
  pool_median_rate numeric
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with settings as (
    select ons.org_id, ons.min_sample_dials, ons.flag_threshold_ratio, ons.rest_days_on_flag
    from public.org_number_health_settings ons
    where (p_org_id is not null and ons.org_id = p_org_id)
       or (p_org_id is null and ons.health_alerts_enabled)
  ),
  stats as (
    select
      upn.id as number_id,
      upn.org_id,
      upn.phone_number,
      count(cl.id) as dials,
      count(cl.id) filter (where cl.outcome = 'connected')::numeric
        / nullif(count(cl.id), 0) as rate
    from public.user_phone_numbers upn
    join settings s on s.org_id = upn.org_id
    left join public.call_legs cl
      on cl.from_number_id = upn.id
      and cl.kind = 'contact'
      and cl.created_at >= now() - interval '30 days'
    where upn.status = 'active'
    group by upn.id, upn.org_id, upn.phone_number
  ),
  eligible as (
    select st.*, s.min_sample_dials, s.flag_threshold_ratio, s.rest_days_on_flag
    from stats st
    join settings s on s.org_id = st.org_id
    where st.dials >= s.min_sample_dials
  ),
  medians as (
    select org_id, percentile_cont(0.5) within group (order by rate) as median_rate
    from eligible
    group by org_id
  ),
  candidates as (
    select e.number_id, e.org_id, e.phone_number, e.dials, e.rate, m.median_rate,
      e.rest_days_on_flag, e.flag_threshold_ratio
    from eligible e
    join medians m on m.org_id = e.org_id
    where m.median_rate > 0 and e.rate < m.median_rate * e.flag_threshold_ratio
  ),
  flagged as (
    update public.user_phone_numbers upn
    set status = 'resting',
        resting_until = now() + make_interval(days => c.rest_days_on_flag),
        flagged_at = now(),
        flagged_reason = format(
          'CID-4: human-answer rate %s%% is below %s%% of the pool median (%s%%) over the last 30 days (%s dials sampled)',
          round(c.rate * 100, 1), round(c.flag_threshold_ratio * 100, 0), round(c.median_rate * 100, 1), c.dials
        )
    from candidates c
    where upn.id = c.number_id
    returning upn.id as number_id, upn.org_id, upn.phone_number
  )
  select f.number_id, f.org_id, f.phone_number, c.dials, round(c.rate, 4), round(c.median_rate, 4)
  from flagged f
  join candidates c on c.number_id = f.number_id;
end;
$$;

revoke all on function public.check_number_health(uuid) from public, anon, authenticated;
grant execute on function public.check_number_health(uuid) to service_role;

-- =================================================================================================
-- 6. pg_cron + pg_net: number-health-check, weekly (Monday 08:00 UTC) -- CID-4's own "weekly (and
--    on demand)" cadence. Same shared-secret/vault-config shape as
--    private.trigger_reliability_alert_check (20260926080400); a separate config row/secret (not
--    reused) since it points at a different function URL.
-- =================================================================================================

create table private.number_health_check_config (
  id boolean primary key default true,
  url text,
  secret_secret_id uuid,
  constraint number_health_check_config_singleton check (id)
);

create function private.set_number_health_check_config(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_secret_id uuid;
  v_secret_id uuid;
begin
  select secret_secret_id into v_existing_secret_id
  from private.number_health_check_config where id = true;

  if v_existing_secret_id is not null then
    perform vault.update_secret(v_existing_secret_id, p_secret);
    v_secret_id := v_existing_secret_id;
  else
    v_secret_id := vault.create_secret(p_secret);
  end if;

  insert into private.number_health_check_config (id, url, secret_secret_id)
  values (true, p_url, v_secret_id)
  on conflict (id) do update set url = excluded.url, secret_secret_id = excluded.secret_secret_id;
end;
$$;

revoke all on function private.set_number_health_check_config(text, text) from public;
grant execute on function private.set_number_health_check_config(text, text) to service_role, postgres;

create function private.trigger_number_health_check()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret_id uuid;
  v_secret text;
begin
  select url, secret_secret_id into v_url, v_secret_id
  from private.number_health_check_config where id = true;

  if v_url is null or v_secret_id is null then
    return; -- not configured yet -- no-op, not an error every tick.
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_secret_id;
  if v_secret is null then
    return;
  end if;

  perform net.http_post(
    url := v_url,
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'X-Cron-Secret', v_secret),
    timeout_milliseconds := 25000
  );
end;
$$;

-- Already enabled by 20260925080200/20260926080400 -- explicit, not assumed, per that
-- migration's own precedent.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule('number-health-check', '0 8 * * 1', $$select private.trigger_number_health_check();$$);

-- =================================================================================================
-- 7. pick_and_reserve_dial_number: add a THIRD ordering tier -- same area code (unchanged, still
--    2nd) beats same state (new, 3rd) beats fewest-dials-today (unchanged, still last). Only the
--    `order by` clause and one new `v_state` lookup change; the function's signature, its
--    concurrency shape (`for update of upn skip locked`), the daily-cap/rest-day write, and every
--    other line are byte-for-byte identical to 20260925070000's own body -- a surgical,
--    reviewable diff, same discipline as the auto-resume migration's own
--    submit_disposition change.
-- =================================================================================================

create or replace function private.pick_and_reserve_dial_number(
  p_org_id uuid,
  p_agent_id uuid,
  p_contact_phone text
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rest_days int;
  v_area_code text;
  v_state text;
  v_today date := (now() at time zone 'utc')::date;
  v_number_id uuid;
  v_cap int;
  v_dials int;
begin
  perform private.reactivate_rested_numbers(p_org_id);

  select rest_days into v_rest_days
  from public.org_number_pool_settings where org_id = p_org_id;
  v_rest_days := coalesce(v_rest_days, 2);

  -- NANP-only area-code match (unchanged from 20260925070000's own comment: a non-matching/
  -- malformed contact number just means no area-code/state preference applies, never an error).
  v_area_code := case
    when p_contact_phone ~ '^\+1[0-9]{10}$' then substring(p_contact_phone from 3 for 3)
    else null
  end;

  -- MISSION-4 TASK-T9 (CID-4 local presence): the new state-match tier. area_code_states has no
  -- row at all for a Canadian/Caribbean/reserved code (private.area_code_states' own header) --
  -- v_state stays null in exactly that case, and the new ORDER BY tier below simply never
  -- prefers anything on it, falling straight through to the existing dials-today tie-break.
  if v_area_code is not null then
    select state into v_state from private.area_code_states where area_code = v_area_code;
  end if;

  select upn.id, upn.daily_cap
    into v_number_id, v_cap
  from public.user_phone_numbers upn
  left join public.number_daily_usage ndu
    on ndu.number_id = upn.id and ndu.day = v_today
  where upn.org_id = p_org_id
    and upn.status = 'active'
    and (upn.assigned_user_id is null or upn.assigned_user_id = p_agent_id)
    and coalesce(ndu.dials, 0) < upn.daily_cap
  order by
    (upn.assigned_user_id = p_agent_id) desc nulls last,
    (v_area_code is not null and substring(upn.phone_number from 3 for 3) = v_area_code) desc,
    (
      v_state is not null
      and exists (
        select 1 from private.area_code_states acs
        where acs.area_code = substring(upn.phone_number from 3 for 3) and acs.state = v_state
      )
    ) desc,
    coalesce(ndu.dials, 0) asc
  limit 1
  for update of upn skip locked;

  if v_number_id is null then
    return null;
  end if;

  insert into public.number_daily_usage (number_id, org_id, day, dials)
  values (v_number_id, p_org_id, v_today, 1)
  on conflict (number_id, day) do update set dials = number_daily_usage.dials + 1
  returning dials into v_dials;

  if v_dials >= v_cap then
    update public.user_phone_numbers
    set status = 'resting', resting_until = now() + make_interval(days => v_rest_days)
    where id = v_number_id;
  end if;

  return v_number_id;
end;
$$;

revoke all on function private.pick_and_reserve_dial_number(uuid, uuid, text) from public, anon, authenticated;
grant execute on function private.pick_and_reserve_dial_number(uuid, uuid, text) to service_role;

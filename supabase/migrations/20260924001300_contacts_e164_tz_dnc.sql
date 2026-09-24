-- TASK-P2-P1: contacts.phone_raw, private.area_code_timezones + timezone backfill, a
-- conditional per-org phone dedupe index, and an agent DNC-only update trigger.
--
-- Design references: docs/design/stage-1-architecture.md §7 (E.164, timezone from area
-- code, real editing, org-wide DNC, dedupe) and §2's permission matrix (agents may only
-- "edit notes" and "mark a contact DNC" -- everything else on a contact is owner/admin).
--
-- contacts.timezone and contacts.dnc already exist (TASK-P2-E1, 20260924000700). This
-- migration populates timezone for existing rows and adds the pieces needed to keep both
-- columns correct going forward.

-- ---------------------------------------------------------------------------------------
-- phone_raw: the exact text a contact's phone number arrived as (CSV cell or a manual
-- edit), before libphonenumber-js normalization. contacts.phone_number stays the
-- strict-E.164 dial target -- dialer-engine.ts reads it directly as the Telnyx `to` field
-- (_shared/dialer-engine.ts, eng2's lane, not touched by this migration) -- so it can never
-- become "whatever the user typed." phone_raw is the "never destroy the original text"
-- side of that requirement instead of a second, competing dial-target column.
-- ---------------------------------------------------------------------------------------

alter table public.contacts add column phone_raw text;

-- Best-effort backfill for rows that predate this column: the true original CSV/typed text
-- is gone (contacts-import overwrote phone_number with its own normalized value on the way
-- in), so this preserves what's there today rather than leaving phone_raw null forever.
update public.contacts set phone_raw = phone_number where phone_raw is null and phone_number is not null;

-- ---------------------------------------------------------------------------------------
-- NANP area code -> IANA timezone lookup table, matching supabase/functions/_shared/
-- area-code-tz.ts exactly (same source, same corrections -- see that file's header
-- comment for provenance and the documented TX/IN/KY/TN exceptions). Duplicated
-- deliberately: the SQL table drives this migration's one-time backfill UPDATE below,
-- the TS module drives contacts-import's per-row lookup at request time in Deno. Neither
-- can call the other, so keeping them in sync is a manual discipline, not a mechanism --
-- flagged in .brain/domains/contacts.md.
-- ---------------------------------------------------------------------------------------

create table private.area_code_timezones (
  area_code text primary key,
  timezone text not null
);

alter table private.area_code_timezones enable row level security;
-- No policies: not PostgREST-exposed, holds no user data, and the only reader is this
-- migration's own backfill UPDATE below (same "default-deny costs nothing here" reasoning
-- as private.valid_timezones, 20260924001100).

insert into private.area_code_timezones (area_code, timezone) values
  ('201', 'America/New_York'),
  ('202', 'America/New_York'),
  ('203', 'America/New_York'),
  ('204', 'America/Winnipeg'),
  ('205', 'America/Chicago'),
  ('206', 'America/Los_Angeles'),
  ('207', 'America/New_York'),
  ('208', 'America/Denver'),
  ('209', 'America/Los_Angeles'),
  ('210', 'America/Chicago'),
  ('212', 'America/New_York'),
  ('213', 'America/Los_Angeles'),
  ('214', 'America/Chicago'),
  ('215', 'America/New_York'),
  ('216', 'America/New_York'),
  ('217', 'America/Chicago'),
  ('218', 'America/Chicago'),
  ('219', 'America/Chicago'),
  ('220', 'America/New_York'),
  ('223', 'America/New_York'),
  ('224', 'America/Chicago'),
  ('225', 'America/Chicago'),
  ('226', 'America/Toronto'),
  ('227', 'America/New_York'),
  ('228', 'America/Chicago'),
  ('229', 'America/New_York'),
  ('231', 'America/Detroit'),
  ('234', 'America/New_York'),
  ('235', 'America/Chicago'),
  ('236', 'America/Vancouver'),
  ('239', 'America/New_York'),
  ('240', 'America/New_York'),
  ('248', 'America/Detroit'),
  ('249', 'America/Toronto'),
  ('250', 'America/Vancouver'),
  ('251', 'America/Chicago'),
  ('252', 'America/New_York'),
  ('253', 'America/Los_Angeles'),
  ('254', 'America/Chicago'),
  ('256', 'America/Chicago'),
  ('257', 'America/Vancouver'),
  ('260', 'America/Indiana/Indianapolis'),
  ('262', 'America/Chicago'),
  ('263', 'America/Toronto'),
  ('267', 'America/New_York'),
  ('269', 'America/Detroit'),
  ('270', 'America/Chicago'),
  ('272', 'America/New_York'),
  ('274', 'America/Chicago'),
  ('276', 'America/New_York'),
  ('279', 'America/Los_Angeles'),
  ('281', 'America/Chicago'),
  ('283', 'America/New_York'),
  ('289', 'America/Toronto'),
  ('301', 'America/New_York'),
  ('302', 'America/New_York'),
  ('303', 'America/Denver'),
  ('304', 'America/New_York'),
  ('305', 'America/New_York'),
  ('306', 'America/Regina'),
  ('307', 'America/Denver'),
  ('308', 'America/Chicago'),
  ('309', 'America/Chicago'),
  ('310', 'America/Los_Angeles'),
  ('312', 'America/Chicago'),
  ('313', 'America/Detroit'),
  ('314', 'America/Chicago'),
  ('315', 'America/New_York'),
  ('316', 'America/Chicago'),
  ('317', 'America/Indiana/Indianapolis'),
  ('318', 'America/Chicago'),
  ('319', 'America/Chicago'),
  ('320', 'America/Chicago'),
  ('321', 'America/New_York'),
  ('323', 'America/Los_Angeles'),
  ('324', 'America/New_York'),
  ('325', 'America/Chicago'),
  ('326', 'America/New_York'),
  ('327', 'America/Chicago'),
  ('329', 'America/New_York'),
  ('330', 'America/New_York'),
  ('331', 'America/Chicago'),
  ('332', 'America/New_York'),
  ('334', 'America/Chicago'),
  ('336', 'America/New_York'),
  ('337', 'America/Chicago'),
  ('339', 'America/New_York'),
  ('341', 'America/Los_Angeles'),
  ('343', 'America/Toronto'),
  ('346', 'America/Chicago'),
  ('347', 'America/New_York'),
  ('350', 'America/Los_Angeles'),
  ('351', 'America/New_York'),
  ('352', 'America/New_York'),
  ('353', 'America/Chicago'),
  ('354', 'America/Toronto'),
  ('357', 'America/Los_Angeles'),
  ('360', 'America/Los_Angeles'),
  ('361', 'America/Chicago'),
  ('363', 'America/New_York'),
  ('364', 'America/Chicago'),
  ('365', 'America/Toronto'),
  ('367', 'America/Toronto'),
  ('368', 'America/Edmonton'),
  ('369', 'America/Los_Angeles'),
  ('380', 'America/New_York'),
  ('382', 'America/Toronto'),
  ('385', 'America/Denver'),
  ('386', 'America/New_York'),
  ('401', 'America/New_York'),
  ('402', 'America/Chicago'),
  ('403', 'America/Edmonton'),
  ('404', 'America/New_York'),
  ('405', 'America/Chicago'),
  ('406', 'America/Denver'),
  ('407', 'America/New_York'),
  ('408', 'America/Los_Angeles'),
  ('409', 'America/Chicago'),
  ('410', 'America/New_York'),
  ('412', 'America/New_York'),
  ('413', 'America/New_York'),
  ('414', 'America/Chicago'),
  ('415', 'America/Los_Angeles'),
  ('416', 'America/Toronto'),
  ('417', 'America/Chicago'),
  ('418', 'America/Toronto'),
  ('419', 'America/New_York'),
  ('423', 'America/New_York'),
  ('424', 'America/Los_Angeles'),
  ('425', 'America/Los_Angeles'),
  ('428', 'America/Moncton'),
  ('430', 'America/Chicago'),
  ('431', 'America/Winnipeg'),
  ('432', 'America/Chicago'),
  ('434', 'America/New_York'),
  ('435', 'America/Denver'),
  ('436', 'America/New_York'),
  ('437', 'America/Toronto'),
  ('438', 'America/Toronto'),
  ('440', 'America/New_York'),
  ('442', 'America/Los_Angeles'),
  ('443', 'America/New_York'),
  ('445', 'America/New_York'),
  ('447', 'America/Chicago'),
  ('448', 'America/New_York'),
  ('450', 'America/Toronto'),
  ('457', 'America/Chicago'),
  ('458', 'America/Los_Angeles'),
  ('463', 'America/Indiana/Indianapolis'),
  ('465', 'America/New_York'),
  ('469', 'America/Chicago'),
  ('472', 'America/Denver'),
  ('474', 'America/Regina'),
  ('475', 'America/New_York'),
  ('478', 'America/New_York'),
  ('479', 'America/Chicago'),
  ('480', 'America/Phoenix'),
  ('481', 'America/Vancouver'),
  ('483', 'America/Chicago'),
  ('484', 'America/New_York'),
  ('501', 'America/Chicago'),
  ('502', 'America/New_York'),
  ('503', 'America/Los_Angeles'),
  ('504', 'America/Chicago'),
  ('505', 'America/Denver'),
  ('506', 'America/Moncton'),
  ('507', 'America/Chicago'),
  ('508', 'America/New_York'),
  ('509', 'America/Los_Angeles'),
  ('510', 'America/Los_Angeles'),
  ('512', 'America/Chicago'),
  ('513', 'America/New_York'),
  ('514', 'America/Toronto'),
  ('515', 'America/Chicago'),
  ('516', 'America/New_York'),
  ('517', 'America/Detroit'),
  ('518', 'America/New_York'),
  ('519', 'America/Toronto'),
  ('520', 'America/Phoenix'),
  ('521', 'America/Los_Angeles'),
  ('523', 'America/Halifax'),
  ('524', 'America/New_York'),
  ('530', 'America/Los_Angeles'),
  ('531', 'America/Chicago'),
  ('534', 'America/Chicago'),
  ('535', 'America/New_York'),
  ('537', 'America/Toronto'),
  ('540', 'America/New_York'),
  ('541', 'America/Los_Angeles'),
  ('551', 'America/New_York'),
  ('557', 'America/Chicago'),
  ('559', 'America/Los_Angeles'),
  ('561', 'America/New_York'),
  ('562', 'America/Los_Angeles'),
  ('563', 'America/Chicago'),
  ('564', 'America/Los_Angeles'),
  ('567', 'America/New_York'),
  ('570', 'America/New_York'),
  ('571', 'America/New_York'),
  ('572', 'America/Chicago'),
  ('573', 'America/Chicago'),
  ('574', 'America/Indiana/Indianapolis'),
  ('575', 'America/Denver'),
  ('578', 'America/Toronto'),
  ('579', 'America/Toronto'),
  ('580', 'America/Chicago'),
  ('581', 'America/Toronto'),
  ('584', 'America/Winnipeg'),
  ('586', 'America/Detroit'),
  ('587', 'America/Edmonton'),
  ('589', 'America/New_York'),
  ('601', 'America/Chicago'),
  ('602', 'America/Phoenix'),
  ('603', 'America/New_York'),
  ('604', 'America/Vancouver'),
  ('605', 'America/Chicago'),
  ('606', 'America/New_York'),
  ('607', 'America/New_York'),
  ('608', 'America/Chicago'),
  ('609', 'America/New_York'),
  ('610', 'America/New_York'),
  ('612', 'America/Chicago'),
  ('613', 'America/Toronto'),
  ('614', 'America/New_York'),
  ('615', 'America/Chicago'),
  ('616', 'America/Detroit'),
  ('617', 'America/New_York'),
  ('618', 'America/Chicago'),
  ('619', 'America/Los_Angeles'),
  ('620', 'America/Chicago'),
  ('623', 'America/Phoenix'),
  ('624', 'America/Los_Angeles'),
  ('626', 'America/Los_Angeles'),
  ('627', 'America/Los_Angeles'),
  ('628', 'America/Los_Angeles'),
  ('629', 'America/Chicago'),
  ('630', 'America/Chicago'),
  ('631', 'America/New_York'),
  ('636', 'America/Chicago'),
  ('639', 'America/Regina'),
  ('640', 'America/New_York'),
  ('641', 'America/Chicago'),
  ('645', 'America/New_York'),
  ('646', 'America/New_York'),
  ('647', 'America/Toronto'),
  ('650', 'America/Los_Angeles'),
  ('651', 'America/Chicago'),
  ('657', 'America/Los_Angeles'),
  ('659', 'America/Chicago'),
  ('660', 'America/Chicago'),
  ('661', 'America/Los_Angeles'),
  ('662', 'America/Chicago'),
  ('667', 'America/New_York'),
  ('669', 'America/Los_Angeles'),
  ('670', 'Pacific/Guam'),
  ('671', 'Pacific/Guam'),
  ('672', 'America/Vancouver'),
  ('678', 'America/New_York'),
  ('679', 'America/Detroit'),
  ('680', 'America/New_York'),
  ('681', 'America/New_York'),
  ('682', 'America/Chicago'),
  ('683', 'America/Toronto'),
  ('684', 'Pacific/Pago_Pago'),
  ('686', 'America/Vancouver'),
  ('689', 'America/New_York'),
  ('701', 'America/Chicago'),
  ('702', 'America/Los_Angeles'),
  ('703', 'America/New_York'),
  ('704', 'America/New_York'),
  ('705', 'America/Toronto'),
  ('706', 'America/New_York'),
  ('707', 'America/Los_Angeles'),
  ('708', 'America/Chicago'),
  ('709', 'America/St_Johns'),
  ('712', 'America/Chicago'),
  ('713', 'America/Chicago'),
  ('714', 'America/Los_Angeles'),
  ('715', 'America/Chicago'),
  ('716', 'America/New_York'),
  ('717', 'America/New_York'),
  ('718', 'America/New_York'),
  ('719', 'America/Denver'),
  ('720', 'America/Denver'),
  ('724', 'America/New_York'),
  ('725', 'America/Los_Angeles'),
  ('726', 'America/Chicago'),
  ('727', 'America/New_York'),
  ('728', 'America/Vancouver'),
  ('729', 'America/Chicago'),
  ('730', 'America/Chicago'),
  ('731', 'America/Chicago'),
  ('732', 'America/New_York'),
  ('734', 'America/Detroit'),
  ('737', 'America/Chicago'),
  ('738', 'America/Los_Angeles'),
  ('740', 'America/New_York'),
  ('742', 'America/Toronto'),
  ('743', 'America/New_York'),
  ('745', 'America/Toronto'),
  ('747', 'America/Los_Angeles'),
  ('751', 'America/Toronto'),
  ('752', 'America/Toronto'),
  ('753', 'America/Toronto'),
  ('754', 'America/New_York'),
  ('757', 'America/New_York'),
  ('760', 'America/Los_Angeles'),
  ('761', 'America/Chicago'),
  ('762', 'America/New_York'),
  ('763', 'America/Chicago'),
  ('765', 'America/Indiana/Indianapolis'),
  ('769', 'America/Chicago'),
  ('770', 'America/New_York'),
  ('772', 'America/New_York'),
  ('773', 'America/Chicago'),
  ('774', 'America/New_York'),
  ('775', 'America/Los_Angeles'),
  ('776', 'America/New_York'),
  ('778', 'America/Vancouver'),
  ('779', 'America/Chicago'),
  ('780', 'America/Edmonton'),
  ('781', 'America/New_York'),
  ('782', 'America/Halifax'),
  ('783', 'America/Regina'),
  ('785', 'America/Chicago'),
  ('786', 'America/New_York'),
  ('787', 'America/Puerto_Rico'),
  ('801', 'America/Denver'),
  ('802', 'America/New_York'),
  ('803', 'America/New_York'),
  ('804', 'America/New_York'),
  ('805', 'America/Los_Angeles'),
  ('806', 'America/Chicago'),
  ('807', 'America/Toronto'),
  ('808', 'Pacific/Honolulu'),
  ('810', 'America/Detroit'),
  ('812', 'America/Indiana/Indianapolis'),
  ('813', 'America/New_York'),
  ('814', 'America/New_York'),
  ('815', 'America/Chicago'),
  ('816', 'America/Chicago'),
  ('817', 'America/Chicago'),
  ('818', 'America/Los_Angeles'),
  ('819', 'America/Toronto'),
  ('820', 'America/Chicago'),
  ('825', 'America/Edmonton'),
  ('826', 'America/New_York'),
  ('828', 'America/New_York'),
  ('830', 'America/Chicago'),
  ('831', 'America/Los_Angeles'),
  ('832', 'America/Chicago'),
  ('838', 'America/New_York'),
  ('843', 'America/New_York'),
  ('845', 'America/New_York'),
  ('846', 'America/Chicago'),
  ('847', 'America/Chicago'),
  ('848', 'America/New_York'),
  ('850', 'America/New_York'),
  ('854', 'America/New_York'),
  ('856', 'America/New_York'),
  ('857', 'America/New_York'),
  ('858', 'America/Los_Angeles'),
  ('859', 'America/New_York'),
  ('860', 'America/New_York'),
  ('861', 'America/Chicago'),
  ('862', 'America/New_York'),
  ('863', 'America/New_York'),
  ('864', 'America/New_York'),
  ('865', 'America/New_York'),
  ('867', 'America/Whitehorse'),
  ('870', 'America/Chicago'),
  ('872', 'America/Chicago'),
  ('873', 'America/Toronto'),
  ('878', 'America/New_York'),
  ('901', 'America/Chicago'),
  ('902', 'America/Halifax'),
  ('903', 'America/Chicago'),
  ('904', 'America/New_York'),
  ('905', 'America/Toronto'),
  ('906', 'America/Detroit'),
  ('907', 'America/Anchorage'),
  ('908', 'America/New_York'),
  ('909', 'America/Los_Angeles'),
  ('910', 'America/New_York'),
  ('912', 'America/New_York'),
  ('913', 'America/Chicago'),
  ('914', 'America/New_York'),
  ('915', 'America/Denver'),
  ('916', 'America/Los_Angeles'),
  ('917', 'America/New_York'),
  ('918', 'America/Chicago'),
  ('919', 'America/New_York'),
  ('920', 'America/Chicago'),
  ('925', 'America/Los_Angeles'),
  ('928', 'America/Phoenix'),
  ('929', 'America/New_York'),
  ('930', 'America/New_York'),
  ('931', 'America/Chicago'),
  ('936', 'America/Chicago'),
  ('937', 'America/New_York'),
  ('938', 'America/Chicago'),
  ('939', 'America/Puerto_Rico'),
  ('940', 'America/Chicago'),
  ('941', 'America/New_York'),
  ('947', 'America/Detroit'),
  ('949', 'America/Los_Angeles'),
  ('951', 'America/Los_Angeles'),
  ('952', 'America/Chicago'),
  ('954', 'America/New_York'),
  ('956', 'America/Chicago'),
  ('957', 'America/Denver'),
  ('959', 'America/New_York'),
  ('970', 'America/Denver'),
  ('971', 'America/Los_Angeles'),
  ('972', 'America/Chicago'),
  ('973', 'America/New_York'),
  ('978', 'America/New_York'),
  ('979', 'America/Chicago'),
  ('980', 'America/New_York'),
  ('984', 'America/New_York'),
  ('985', 'America/Chicago'),
  ('989', 'America/Detroit')
;

-- Backfill: for every existing contact with a null timezone and a 10-digit-plus-country-
-- code E.164 US/CA number (+1 followed by exactly 10 digits), look up the area code (the
-- 3 digits right after +1) and set timezone when it maps to something. Never overwrites an
-- already-set timezone -- there shouldn't be any yet (the column is new in 20260924000700
-- and nothing has written to it), but this is safe regardless if that ever changes.
--
-- Ordering note: this UPDATE runs before the contacts_agent_update_scope trigger created
-- near the bottom of this file, so the trigger cannot fire on it regardless of role. Kept
-- in this order deliberately as defense in depth even though the trigger itself is now
-- scoped to auth.role() = 'authenticated' only (see that trigger's comment) -- a migration
-- role has no JWT context at all, so it would be exempt either way. Caught by dry-running
-- this file with the trigger created first (to check for exactly this) before settling on
-- this order.
update public.contacts c
set timezone = t.timezone
from private.area_code_timezones t
where c.timezone is null
  and c.phone_number ~ '^\+1[0-9]{10}$'
  and t.area_code = substring(c.phone_number from 3 for 3);

-- ---------------------------------------------------------------------------------------
-- Per-org phone dedupe. contacts-import already de-duplicates at insert time (org-scoped,
-- as of TASK-P1-02); this is the DB-level backstop the design asks for -- but only if it
-- can be added without touching or losing any existing row. If duplicate (org_id,
-- phone_number) pairs already exist, a unique index would fail the migration outright, and
-- resolving them by deleting data is explicitly off the table. So: check first, and only
-- add the unique index when the data already supports it. Either way this is logged, per
-- the task's own instruction, in the RAISE NOTICE below and in this task's board log.
-- ---------------------------------------------------------------------------------------

do $$
declare
  v_dupe_groups int;
begin
  select count(*) into v_dupe_groups
  from (
    select org_id, phone_number
    from public.contacts
    where phone_number is not null
    group by org_id, phone_number
    having count(*) > 1
  ) dupes;

  if v_dupe_groups = 0 then
    execute 'create unique index idx_contacts_org_phone_unique on public.contacts (org_id, phone_number) where phone_number is not null';
    raise notice 'contacts: no existing (org_id, phone_number) duplicates found -- created a unique index.';
  else
    execute 'create index idx_contacts_org_phone on public.contacts (org_id, phone_number)';
    raise notice 'contacts: % existing (org_id, phone_number) duplicate group(s) found -- skipped the unique index (data is not deleted or merged by this migration). Dedupe stays enforced at import time only (contacts-import/index.ts). A future migration can add the unique index once the existing duplicates are resolved.', v_dupe_groups;
  end if;
end $$;

-- ---------------------------------------------------------------------------------------
-- Agent DNC-only update scope (closes .brain/memory/known-issues.md #7, using the exact
-- fix that issue names). The existing "owner, admin, or assigned agent can update
-- contacts" RLS policy (20260924000300) lets a matching agent update any column, because
-- RLS USING/WITH CHECK can restrict which ROWS match, not which COLUMNS change within a
-- matched row. A BEFORE UPDATE trigger enforces the column-level boundary; RLS still
-- governs which rows an agent's UPDATE can reach at all.
--
-- DNC only, not "notes" too: design §2's matrix also lists "edit notes" as an agent right,
-- but that's exercised during dispositions/wrap-up (Phase 3, not built yet -- see
-- .brain/domains/crm.md "Not covered here"), which -- like the rest of the dial loop --
-- writes through a service-role Edge Function or a SECURITY DEFINER RPC, neither of which
-- is a client-authenticated UPDATE from the Contacts page. This trigger only bounds what
-- an agent's own authenticated session can change directly, which per the matrix is DNC
-- alone.
--
-- Allowlist, not a denylist of today's columns: comparing whole rows minus {dnc,
-- updated_at} means a future contacts column (ghl_contact_id, per this task's own "later,
-- in Phase 3" note) is covered automatically, instead of silently becoming
-- agent-writable because nobody remembered to add it to a column-by-column check.
--
-- Enforced only when auth.role() = 'authenticated' -- an ordinary end-user request through
-- PostgREST. Everything else (a service-role Edge Function, a future pg_cron job or
-- SECURITY DEFINER RPC running with no JWT context at all, or this migration's own
-- backfill UPDATE above) has auth.role() return null or 'service_role', never
-- 'authenticated', and is exempt. private.has_org_role(auth.uid()) would be false for all
-- of those too (auth.uid() is also null outside a real user JWT), so without this
-- role-scoped check every one of them would be misidentified as an unprivileged agent edit
-- and rejected -- including this same migration's own backfill UPDATE if this trigger
-- existed before it ran (it doesn't -- see that UPDATE's ordering note).
-- ---------------------------------------------------------------------------------------

create function private.enforce_agent_contact_update_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'authenticated' then
    return new;
  end if;

  if private.has_org_role(new.org_id, array['owner', 'admin']) then
    return new;
  end if;

  -- Anyone else matching the row (an assigned agent, per the existing UPDATE policy) may
  -- only change dnc.
  if (to_jsonb(new) - 'dnc' - 'updated_at') is distinct from (to_jsonb(old) - 'dnc' - 'updated_at') then
    raise exception 'agents may only change the dnc flag on a contact' using errcode = '42501';
  end if;

  return new;
end;
$$;

create trigger contacts_agent_update_scope
before update on public.contacts
for each row execute function private.enforce_agent_contact_update_scope();

-- MISSION-5 TASK-M5-G3 (deferred backlog item): campaign script / objection-sheet version history
-- + restore, eng1 lane.
--
-- Scope check (schema first, per the task's own instruction): campaigns has no per-campaign
-- disposition SET to version -- dispositions are a plain org-wide table (public.dispositions,
-- 20260925060000), never a per-campaign text/config column. campaign_retry_rules maps
-- (campaign_id, disposition_key) to a retry action, but that's structured config data (its own
-- rows, already its own change-in-place semantics), not free text an admin edits and might want to
-- roll back -- out of scope for THIS task. Only `campaigns.script_text` and
-- `campaigns.objection_sheet_text` (20260926080200_call_card_scripts.sql) get versioned.
--
-- 1. campaign_script_versions: one row per edit, `field` distinguishes which of the two columns.
--    `org_id` is denormalized from campaigns.org_id (not read via a policy-side join into
--    campaigns -- LANE-eng1.md's own recorded gotcha: an inline EXISTS into another RLS-protected
--    table can recurse; every other cross-referencing table in this codebase denormalizes org_id
--    the same way, e.g. campaign_leads/dial_sessions). `edited_by` is stamped by the trigger from
--    `auth.uid()` -- never trusted from the client, and there is no direct-insert path for a
--    client to supply a different value anyway (no insert policy at all, see below).
-- 2. private.record_campaign_script_version: an AFTER UPDATE trigger on campaigns, one row per
--    CHANGED field (not one row covering both, so `field` stays a clean discriminator and history
--    "per field" in the requirement means literally that). `old is distinct from new` is what
--    makes a no-op save (identical text) produce zero version rows and what makes concurrent
--    edits by two admins both land in order (each UPDATE is its own trigger firing, version
--    numbers computed from the CURRENT max at insert time inside the same row-level trigger
--    invocation -- Postgres serializes concurrent UPDATEs to the same row via its own row lock,
--    so there is no window for two concurrent saves to compute the same next-version number).
--    SECURITY DEFINER so this fires (and its insert succeeds) regardless of which role's own
--    UPDATE on campaigns triggered it -- same reasoning as the generic settings-audit trigger
--    (org_audit_log's own header) and stamp_recording_flag_flagger.
-- 3. restore_campaign_script_version: the one write RPC other than the trigger itself. Same gate
--    as "who can edit the campaign today" (`private.has_org_role(org_id, array['owner','admin'])`
--    -- campaigns' own UPDATE policy, re-checked against the CURRENT migration state: still
--    exactly owner/admin, never widened to manager, per the A5 note in Team.tsx's own RoleChip
--    comment that a manager gets Team/Analytics but not Campaigns). Restoring is a plain UPDATE on
--    campaigns (so the AFTER UPDATE trigger above records the restore as its own new version, same
--    as any other edit) PLUS one explicit `private.log_org_action` row -- the trigger's own
--    version rows are not separately audit-logged (an ordinary keystroke-save isn't audit-log
--    noise), but a restore specifically is, per the task's own requirement.
-- 4. RLS: SELECT mirrors "org members can view campaigns" exactly (private.is_org_member(org_id))
--    -- everyone who can read the campaign can read its history. No insert/update/delete policy
--    for any client role: the trigger (SECURITY DEFINER) and the restore RPC (also SECURITY
--    DEFINER, itself going through the trigger) are the only writers.
-- 5. Edge cases (one line each, also in audit/M5-G3/notes.md):
--    - First edit of a campaign with no history yet: version=1, old_text=null (not a seeded v1 row
--      at campaign-creation time -- a campaign that's never edited needs zero storage).
--    - No-op save (identical text): `is distinct from` in the trigger means zero version rows.
--    - Very large script: stored in FULL, never truncated or capped -- Postgres `text` is
--      TOAST-based with no practical size limit, so storing it never fails the save. The UI's
--      history-list preview truncates to the first ~300 chars of old/new text for the on-screen
--      diff (never a full diff algorithm over a possibly-huge blob) -- "restore" still recovers
--      the exact original text regardless, since the STORED value is never truncated.
--    - Campaign deleted: FK `on delete cascade` -- history goes with it. Chosen because campaigns
--      are soft-deleted in normal operation (`deleted_at`, campaigns_with_stats' own WHERE
--      clause) -- the row itself is never actually removed by any in-app action, so this FK only
--      ever fires for a genuine hard-delete/data-purge, where keeping orphaned script history
--      around (for a campaign that no longer exists to view it against) serves no purpose.
--    - Concurrent edits by two admins: both get versions, strictly in commit order -- see point 2
--      above (row-level lock serializes the two UPDATEs, each computes its own next version number
--      from what's already committed at the time it runs).

-- =================================================================================================
-- 1. campaign_script_versions
-- =================================================================================================

create table public.campaign_script_versions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  field text not null check (field in ('script_text', 'objection_sheet_text')),
  version int not null check (version > 0),
  old_text text,
  new_text text not null,
  edited_by uuid references auth.users(id) on delete set null,
  edited_at timestamptz not null default now(),
  unique (campaign_id, field, version)
);

create index campaign_script_versions_campaign_field_idx
  on public.campaign_script_versions(campaign_id, field, version desc);

alter table public.campaign_script_versions enable row level security;

create policy "org members can view campaign script history"
  on public.campaign_script_versions for select
  using (private.is_org_member(org_id));

-- No insert/update/delete policy for any client role -- the trigger and the restore RPC below
-- (both SECURITY DEFINER) are the only writers.
revoke all on public.campaign_script_versions from anon;

-- =================================================================================================
-- 2. private.record_campaign_script_version
-- =================================================================================================

create function private.record_campaign_script_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next_version int;
begin
  if old.script_text is distinct from new.script_text then
    select coalesce(max(version), 0) + 1 into v_next_version
    from public.campaign_script_versions
    where campaign_id = new.id and field = 'script_text';

    insert into public.campaign_script_versions
      (org_id, campaign_id, field, version, old_text, new_text, edited_by)
    values
      (new.org_id, new.id, 'script_text', v_next_version, old.script_text, new.script_text, auth.uid());
  end if;

  if old.objection_sheet_text is distinct from new.objection_sheet_text then
    select coalesce(max(version), 0) + 1 into v_next_version
    from public.campaign_script_versions
    where campaign_id = new.id and field = 'objection_sheet_text';

    insert into public.campaign_script_versions
      (org_id, campaign_id, field, version, old_text, new_text, edited_by)
    values
      (new.org_id, new.id, 'objection_sheet_text', v_next_version, old.objection_sheet_text, new.objection_sheet_text, auth.uid());
  end if;

  return new;
end;
$$;

create trigger campaigns_record_script_version
  after update on public.campaigns
  for each row execute function private.record_campaign_script_version();

-- =================================================================================================
-- 3. restore_campaign_script_version
-- =================================================================================================

create function public.restore_campaign_script_version(p_org uuid, p_version_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign_id uuid;
  v_field text;
  v_new_text text;
  v_version int;
begin
  select campaign_id, field, new_text, version
    into v_campaign_id, v_field, v_new_text, v_version
  from public.campaign_script_versions
  where id = p_version_id and org_id = p_org;

  if v_campaign_id is null then
    raise exception 'version not found';
  end if;
  if not private.has_org_role(p_org, array['owner', 'admin']) then
    raise exception 'only an owner or admin can restore a campaign script version';
  end if;

  if v_field = 'script_text' then
    update public.campaigns set script_text = v_new_text where id = v_campaign_id and org_id = p_org;
  else
    update public.campaigns set objection_sheet_text = v_new_text where id = v_campaign_id and org_id = p_org;
  end if;

  perform private.log_org_action(
    p_org, 'campaign.restore_script_version', 'campaign', v_campaign_id,
    jsonb_build_object('field', v_field, 'restored_version', v_version)
  );
end;
$$;

revoke all on function public.restore_campaign_script_version(uuid, uuid) from public, anon;
grant execute on function public.restore_campaign_script_version(uuid, uuid) to authenticated;

-- =================================================================================================
-- 4. list_campaign_script_versions: the one reader beyond a plain table SELECT -- kept as an RPC
--    (rather than the client querying campaign_script_versions directly) only so the response can
--    join in the editor's display name once, instead of the client doing a second round trip to
--    org_member_emails/profiles per history list. RLS above still applies underneath it (SELECT,
--    not a bypass) since it queries through the same table.
-- =================================================================================================

create function public.list_campaign_script_versions(p_org uuid, p_campaign uuid, p_field text)
returns table (
  id uuid,
  version int,
  old_text text,
  new_text text,
  edited_by uuid,
  edited_by_name text,
  edited_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    v.id,
    v.version,
    v.old_text,
    v.new_text,
    v.edited_by,
    coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), 'Former member') as edited_by_name,
    v.edited_at
  from public.campaign_script_versions v
  left join public.profiles p on p.user_id = v.edited_by
  where v.org_id = p_org and v.campaign_id = p_campaign and v.field = p_field
    and private.is_org_member(p_org)
  order by v.version desc;
$$;

revoke all on function public.list_campaign_script_versions(uuid, uuid, text) from public, anon;
grant execute on function public.list_campaign_script_versions(uuid, uuid, text) to authenticated;

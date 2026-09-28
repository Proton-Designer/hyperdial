-- MISSION-5 TASK-M5-G5 (deferred backlog item): contact collaboration -- team notes thread,
-- @mentions, contact change history. eng1 lane.
--
-- Scope check (schema first, per this task's own instruction): `contacts.notes` (the legacy
-- single overwritable column, 20250214000001) is kept exactly as-is -- not migrated, not dropped,
-- still shown by ContactDetailModal.tsx as a pinned "legacy note". Nothing here touches it.
--
-- 1. contact_notes: an append-only thread per contact (never a client-writable table -- every
--    write goes through add_contact_note/edit_contact_note/delete_contact_note below, all
--    SECURITY DEFINER, same "table has a SELECT policy but no insert/update/delete policy, RPCs
--    are the only writers" shape as campaign_script_versions, G3). Soft-delete (`deleted_at`) --
--    not a real DELETE -- so a moderated-away note stays available for a future audit need instead
--    of disappearing outright; `deleted_at is null` is filtered as an ordinary predicate inside
--    list_contact_notes, never folded into the SELECT policy's USING clause (LANE-eng1.md's own
--    P2-P2 lesson: a row can never be moved into a state its own SELECT policy would exclude, even
--    via a separately-permitted UPDATE -- the correct home for a "hide via a flag" filter is the
--    reader, not RLS).
-- 2. private.contact_read_access(p_org, p_contact_id): the exact "owner, admin, or assigned agent"
--    condition contacts' own SELECT policy already uses (20260924000300), pulled out into one
--    helper so contact_notes/contact_change_history's policies and RPCs reuse it instead of
--    re-deriving it a second and third time (this lane's own recurring composed-scope-check
--    pattern, e.g. private.is_agent_in_callers_pod_scope).
-- 3. @mentions: `add_contact_note` validates every mentioned id is an ACTIVE member of the
--    contact's org by INNER JOINing org_members (silently drops anything that doesn't match --
--    never raises -- so a stale client-side suggestion, e.g. someone removed between typing and
--    saving, doesn't block the whole note from saving; this is also what makes "a mention of a
--    member later removed" a non-issue: removed BEFORE save is filtered out here, removed AFTER
--    save just means a notification that already fired stays historically accurate). One
--    `notifications` row per valid mention (existing table, 20250213000001, already has an `org_id`
--    and `data` jsonb column from prior tasks) with `type = 'mention'`, gated by the SAME
--    `user_notification_preferences` opt-out table TASK-M5-B4 built (absence of a row = on, the
--    established convention) -- widens that table's `alert_type` check constraint to add
--    'mention' alongside the 4 supervisor-alert types, reusing the column rather than adding a new
--    one. Never a self-notification (checked before insert, not relied on the mentioned-id list
--    excluding the author -- a caller could legitimately @mention themselves in the text with no
--    entry ever generated for it). Deduped per note for free: `array_agg(distinct ...)` on input,
--    one notification row per distinct surviving id.
-- 4. Contact change history: `private.record_contact_change_history()`, an AFTER UPDATE trigger on
--    contacts, batches every TRACKED field that changed in ONE UPDATE statement into a SINGLE
--    jsonb row (never one row per field) -- the same "is distinct from, batch the whole diff"
--    shape campaign_script_versions' own trigger uses, just extended from 2 tracked columns to 6.
--    Tracked columns are exactly the ones this task names: assigned_user_id (owner/assigned
--    agent), contact_status + dnc (status/DNC), phone_number, {first_name, last_name,
--    business_name} (name, folded into one 'name' entry since they're one semantic field split
--    across 3 columns), ghl_tags (tags) -- NOT every column (rating/website/address/timezone/
--    notes/ghl_custom_fields stay untracked: notes has its OWN thread now, per this same task, and
--    the rest were never named as in-scope).
--    Bulk-import check (per this task's own instruction, "check how the importer writes and say
--    what you chose"): contacts-import/index.ts (CSV) is INSERT-only -- a phone match against an
--    existing contact is counted as a duplicate and skipped outright, never merged/updated
--    (confirmed by reading its current source, not assumed) -- so CSV import never fires this
--    trigger at all; a brand-new contact has no "before" state to diff against, so zero history
--    rows is the correct outcome, not a gap. ghl-import/index.ts (GHL pull) DOES update existing
--    contacts, but via one `.update(patch).eq('id', id)` call per contact carrying every changed
--    field in a single patch object (TASK-P3-P2's own fix-forward, LANE-eng1.md) -- so this
--    trigger already produces exactly ONE row per contact per import run, with every field that
--    import changed for that contact batched into that one row's `changes` jsonb, which IS "one
--    summary row per import, not one per field per contact" -- no special-casing needed beyond the
--    batch-the-whole-diff design already required for the ordinary manual-edit case.
--    Attribution: `auth.role() = 'authenticated'` (a real end-user PATCH through PostgREST, i.e.
--    ContactDetailModal.tsx's plain `updateContact`) stamps `changed_by = auth.uid()`,
--    `source = 'user'`; anything else (contacts-import/ghl-import's service-role client, or this
--    migration's own DDL) has no JWT context at all and stamps `changed_by = null`,
--    `source = 'import'` -- displayed as "Imported" rather than a person's name.
-- 5. Edge cases (one line each, also in audit/M5-G5/notes.md):
--    - Note on a deleted contact: FK `on delete cascade` on both new tables -- a hard-deleted
--      contact (owner/admin-only, real DELETE, contacts has no soft-delete column) takes its notes
--      and history with it, same reasoning as campaign_script_versions' own cascade choice.
--    - An offboarded (A3) author's notes stay with a "(removed)" label: list_contact_notes /
--      list_contact_change_history join org_members and return a `*_removed` boolean (true when
--      that member's current `status <> 'active'`) alongside the name -- the row itself is never
--      altered or hidden, only how the client labels the author.
--    - A mention of a member later removed: see point 3 above.
--    - A very long note: `contact_notes.body` has a `char_length(...) <= 5000` CHECK (DB-level
--      backstop) in addition to add_contact_note/edit_contact_note's own explicit length check
--      (the same belt-and-suspenders shape as every other "cap it server-side" requirement this
--      session).
--    - Two people adding notes at once: no shared mutable state between two INSERTs (unlike
--      campaign_script_versions' own version-number counter) -- both rows land independently,
--      ordered by created_at, no coordination needed.
--    - HTML/markdown injection: purely a rendering concern -- the note body is stored and returned
--      as plain text; the UI renders it as a plain React text node (never dangerouslySetInnerHTML,
--      never a markdown parser), so raw `<script>`/`**bold**` etc. show up as literal characters,
--      never interpreted.

-- =================================================================================================
-- 1. private.contact_read_access
-- =================================================================================================

create function private.contact_read_access(p_org uuid, p_contact_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    private.has_org_role(p_org, array['owner', 'admin'])
    or (
      private.has_org_role(p_org, array['agent'])
      and private.agent_has_contact_access(p_contact_id)
    );
$$;

grant execute on function private.contact_read_access(uuid, uuid) to authenticated;

-- =================================================================================================
-- 2. contact_notes
-- =================================================================================================

create table public.contact_notes (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  author_user_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) > 0 and char_length(body) <= 5000),
  mentioned_user_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz
);

create index contact_notes_contact_idx on public.contact_notes(contact_id, created_at);

alter table public.contact_notes enable row level security;

create policy "contact-visible org members can view notes"
  on public.contact_notes for select
  using (private.contact_read_access(org_id, contact_id));

-- No insert/update/delete policy for any client role -- add_contact_note/edit_contact_note/
-- delete_contact_note below (all SECURITY DEFINER) are the only writers.
revoke all on public.contact_notes from anon;

-- =================================================================================================
-- 3. contact_change_history
-- =================================================================================================

create table public.contact_change_history (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  changed_by uuid references auth.users(id) on delete set null,
  source text not null default 'user' check (source in ('user', 'import')),
  changes jsonb not null,
  created_at timestamptz not null default now()
);

create index contact_change_history_contact_idx on public.contact_change_history(contact_id, created_at);

alter table public.contact_change_history enable row level security;

create policy "contact-visible org members can view contact history"
  on public.contact_change_history for select
  using (private.contact_read_access(org_id, contact_id));

-- No insert/update/delete policy for any client role -- private.record_contact_change_history
-- (SECURITY DEFINER trigger below) is the only writer.
revoke all on public.contact_change_history from anon;

-- =================================================================================================
-- 4. private.record_contact_change_history + trigger
-- =================================================================================================

create function private.record_contact_change_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_changes jsonb := '{}'::jsonb;
begin
  if new.assigned_user_id is distinct from old.assigned_user_id then
    v_changes := v_changes || jsonb_build_object(
      'assigned_user_id', jsonb_build_object('old', old.assigned_user_id, 'new', new.assigned_user_id)
    );
  end if;

  if new.contact_status is distinct from old.contact_status then
    v_changes := v_changes || jsonb_build_object(
      'contact_status', jsonb_build_object('old', old.contact_status, 'new', new.contact_status)
    );
  end if;

  if new.dnc is distinct from old.dnc then
    v_changes := v_changes || jsonb_build_object(
      'dnc', jsonb_build_object('old', old.dnc, 'new', new.dnc)
    );
  end if;

  if new.phone_number is distinct from old.phone_number then
    v_changes := v_changes || jsonb_build_object(
      'phone_number', jsonb_build_object('old', old.phone_number, 'new', new.phone_number)
    );
  end if;

  if new.first_name is distinct from old.first_name
     or new.last_name is distinct from old.last_name
     or new.business_name is distinct from old.business_name then
    v_changes := v_changes || jsonb_build_object(
      'name', jsonb_build_object(
        'old', jsonb_build_object(
          'first_name', old.first_name, 'last_name', old.last_name, 'business_name', old.business_name
        ),
        'new', jsonb_build_object(
          'first_name', new.first_name, 'last_name', new.last_name, 'business_name', new.business_name
        )
      )
    );
  end if;

  if new.ghl_tags is distinct from old.ghl_tags then
    v_changes := v_changes || jsonb_build_object(
      'ghl_tags', jsonb_build_object('old', to_jsonb(old.ghl_tags), 'new', to_jsonb(new.ghl_tags))
    );
  end if;

  if v_changes = '{}'::jsonb then
    return new;
  end if;

  insert into public.contact_change_history (org_id, contact_id, changed_by, source, changes)
  values (
    new.org_id,
    new.id,
    case when auth.role() = 'authenticated' then auth.uid() else null end,
    case when auth.role() = 'authenticated' then 'user' else 'import' end,
    v_changes
  );

  return new;
end;
$$;

create trigger contacts_record_change_history
  after update on public.contacts
  for each row execute function private.record_contact_change_history();

-- =================================================================================================
-- 5. add_contact_note
-- =================================================================================================

create function public.add_contact_note(
  p_org uuid,
  p_contact uuid,
  p_body text,
  p_mentioned_user_ids uuid[] default '{}'
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_contact_org uuid;
  v_body text;
  v_mentions uuid[];
  v_recipient uuid;
begin
  select org_id into v_contact_org from public.contacts where id = p_contact;
  if v_contact_org is null or v_contact_org <> p_org then
    raise exception 'contact not found';
  end if;
  if not private.contact_read_access(p_org, p_contact) then
    raise exception 'not permitted to note this contact' using errcode = '42501';
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'note text is required';
  end if;
  if char_length(v_body) > 5000 then
    raise exception 'note text is limited to 5,000 characters';
  end if;

  -- Every mentioned id must be an ACTIVE member of this contact's org -- anything else (a
  -- different org's user, a removed/disabled member, a stale suggestion) is silently dropped,
  -- never raised (see this migration's own header, point 3).
  select coalesce(array_agg(distinct mu.user_id), '{}')
    into v_mentions
  from unnest(coalesce(p_mentioned_user_ids, '{}')) as mu(user_id)
  where exists (
    select 1 from public.org_members m
    where m.org_id = p_org and m.user_id = mu.user_id and m.status = 'active'
  );

  insert into public.contact_notes (org_id, contact_id, author_user_id, body, mentioned_user_ids)
  values (p_org, p_contact, auth.uid(), v_body, v_mentions);

  foreach v_recipient in array v_mentions loop
    if v_recipient <> auth.uid() and not exists (
      select 1 from public.user_notification_preferences unp
      where unp.org_id = p_org and unp.user_id = v_recipient and unp.alert_type = 'mention'
        and unp.enabled = false
    ) then
      insert into public.notifications (org_id, user_id, type, title, body, data)
      values (
        p_org, v_recipient, 'mention', 'You were mentioned on a contact',
        left(v_body, 200),
        jsonb_build_object('contactId', p_contact)
      );
    end if;
  end loop;
end;
$$;

revoke all on function public.add_contact_note(uuid, uuid, text, uuid[]) from public, anon;
grant execute on function public.add_contact_note(uuid, uuid, text, uuid[]) to authenticated;

-- =================================================================================================
-- 6. edit_contact_note / delete_contact_note
-- =================================================================================================

create function public.edit_contact_note(p_org uuid, p_note_id uuid, p_body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_author uuid;
  v_created_at timestamptz;
  v_note_org uuid;
  v_body text;
begin
  select author_user_id, created_at, org_id into v_author, v_created_at, v_note_org
  from public.contact_notes
  where id = p_note_id and deleted_at is null;

  if v_author is null or v_note_org <> p_org then
    raise exception 'note not found';
  end if;
  if v_author <> auth.uid() then
    raise exception 'only the author may edit this note' using errcode = '42501';
  end if;
  if now() - v_created_at >= interval '15 minutes' then
    raise exception 'this note can no longer be edited (the 15-minute window has passed)';
  end if;

  v_body := btrim(coalesce(p_body, ''));
  if v_body = '' then
    raise exception 'note text is required';
  end if;
  if char_length(v_body) > 5000 then
    raise exception 'note text is limited to 5,000 characters';
  end if;

  update public.contact_notes set body = v_body, edited_at = now() where id = p_note_id;
end;
$$;

create function public.delete_contact_note(p_org uuid, p_note_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_author uuid;
  v_created_at timestamptz;
  v_note_org uuid;
begin
  select author_user_id, created_at, org_id into v_author, v_created_at, v_note_org
  from public.contact_notes
  where id = p_note_id and deleted_at is null;

  if v_author is null or v_note_org <> p_org then
    raise exception 'note not found';
  end if;

  if v_author = auth.uid() and now() - v_created_at < interval '15 minutes' then
    null; -- self-delete within the edit window, allowed
  elsif private.has_org_role(p_org, array['owner', 'admin']) then
    null; -- owner/admin may delete any note, any time
  else
    raise exception 'not permitted to delete this note' using errcode = '42501';
  end if;

  update public.contact_notes set deleted_at = now() where id = p_note_id;
end;
$$;

revoke all on function public.edit_contact_note(uuid, uuid, text) from public, anon;
grant execute on function public.edit_contact_note(uuid, uuid, text) to authenticated;
revoke all on function public.delete_contact_note(uuid, uuid) from public, anon;
grant execute on function public.delete_contact_note(uuid, uuid) to authenticated;

-- =================================================================================================
-- 7. list_contact_notes / list_contact_change_history
-- =================================================================================================

create function public.list_contact_notes(p_org uuid, p_contact uuid)
returns table (
  id uuid,
  author_user_id uuid,
  author_name text,
  author_removed boolean,
  body text,
  mentioned_user_ids uuid[],
  created_at timestamptz,
  edited_at timestamptz,
  can_edit boolean,
  can_delete boolean
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    n.id,
    n.author_user_id,
    coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), 'Former member') as author_name,
    coalesce(om.status, 'removed') <> 'active' as author_removed,
    n.body,
    n.mentioned_user_ids,
    n.created_at,
    n.edited_at,
    (n.author_user_id = auth.uid() and now() - n.created_at < interval '15 minutes') as can_edit,
    (
      (n.author_user_id = auth.uid() and now() - n.created_at < interval '15 minutes')
      or private.has_org_role(p_org, array['owner', 'admin'])
    ) as can_delete
  from public.contact_notes n
  left join public.profiles p on p.user_id = n.author_user_id
  left join public.org_members om on om.org_id = n.org_id and om.user_id = n.author_user_id
  where n.org_id = p_org and n.contact_id = p_contact and n.deleted_at is null
    and private.contact_read_access(p_org, p_contact)
  order by n.created_at asc;
$$;

revoke all on function public.list_contact_notes(uuid, uuid) from public, anon;
grant execute on function public.list_contact_notes(uuid, uuid) to authenticated;

create function public.list_contact_change_history(p_org uuid, p_contact uuid)
returns table (
  id uuid,
  changed_by uuid,
  changed_by_name text,
  changed_by_removed boolean,
  source text,
  changes jsonb,
  created_at timestamptz
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    h.id,
    h.changed_by,
    case
      when h.changed_by is null then null
      else coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), 'Former member')
    end as changed_by_name,
    h.changed_by is not null and coalesce(om.status, 'removed') <> 'active' as changed_by_removed,
    h.source,
    h.changes,
    h.created_at
  from public.contact_change_history h
  left join public.profiles p on p.user_id = h.changed_by
  left join public.org_members om on om.org_id = h.org_id and om.user_id = h.changed_by
  where h.org_id = p_org and h.contact_id = p_contact
    and private.contact_read_access(p_org, p_contact)
  order by h.created_at desc;
$$;

revoke all on function public.list_contact_change_history(uuid, uuid) from public, anon;
grant execute on function public.list_contact_change_history(uuid, uuid) to authenticated;

-- =================================================================================================
-- 8. user_notification_preferences: widen alert_type to add 'mention' (point 3 above).
-- =================================================================================================

alter table public.user_notification_preferences
  drop constraint user_notification_preferences_alert_type_check;

alter table public.user_notification_preferences
  add constraint user_notification_preferences_alert_type_check
  check (alert_type in ('wrap_up_stuck', 'paused_stuck', 'call_stuck', 'zero_connects', 'mention'));

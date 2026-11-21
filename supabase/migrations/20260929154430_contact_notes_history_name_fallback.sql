-- TASK-Q4F (audit/ui/Q4/report.md, finding #1): list_contact_notes' author_name and
-- list_contact_change_history's changed_by_name coalesce straight from a blank profile name to
-- the literal 'Former member', with no email fallback in between and no regard for the SEPARATE
-- author_removed/changed_by_removed boolean these same functions already compute correctly --
-- so an ACTIVE member who simply never filled in a profile name (reproduced live on the QA
-- sandbox's own qa-admin@example.com, whose Profile tab has both first/last name blank) is
-- mislabeled as having left the org. Same missing-email-fallback gap as eng1's own
-- 20260929154003_name_email_fallbacks.sql (Q2 findings #2/#3) -- same fix, same auth.users join
-- pattern (team_daily_stats' own coalesce chain: name -> email -> literal), but with an added
-- twist: the literal fallback must now be gated on the removed boolean, not just on a blank name,
-- since these two functions (unlike Q2F's) already have a real removed/not-removed signal to
-- check. No OUT-column change on either function (identical returns table), so a plain
-- `create or replace` is correct (R-038 N/A). Every other line copied verbatim from the LATEST
-- (and only) body, 20260927215820_contact_notes_mentions_history.sql -- only the two name
-- expressions and their join lists changed.

create or replace function public.list_contact_notes(p_org uuid, p_contact uuid)
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
    case
      when coalesce(om.status, 'removed') <> 'active' then
        coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), 'Former member')
      else
        coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), u.email, 'Member')
    end as author_name,
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
  left join auth.users u on u.id = n.author_user_id
  where n.org_id = p_org and n.contact_id = p_contact and n.deleted_at is null
    and private.contact_read_access(p_org, p_contact)
  order by n.created_at asc;
$$;

revoke all on function public.list_contact_notes(uuid, uuid) from public, anon;
grant execute on function public.list_contact_notes(uuid, uuid) to authenticated;

create or replace function public.list_contact_change_history(p_org uuid, p_contact uuid)
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
      when coalesce(om.status, 'removed') <> 'active' then
        coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), 'Former member')
      else
        coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), u.email, 'Member')
    end as changed_by_name,
    h.changed_by is not null and coalesce(om.status, 'removed') <> 'active' as changed_by_removed,
    h.source,
    h.changes,
    h.created_at
  from public.contact_change_history h
  left join public.profiles p on p.user_id = h.changed_by
  left join public.org_members om on om.org_id = h.org_id and om.user_id = h.changed_by
  left join auth.users u on u.id = h.changed_by
  where h.org_id = p_org and h.contact_id = p_contact
    and private.contact_read_access(p_org, p_contact)
  order by h.created_at desc;
$$;

revoke all on function public.list_contact_change_history(uuid, uuid) from public, anon;
grant execute on function public.list_contact_change_history(uuid, uuid) to authenticated;

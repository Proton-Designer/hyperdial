-- TASK-G7 (GHL-7): contacts tagged do-not-call or paused in GHL are never queued or dialed.
--
-- Blocked tags become an org setting (org_integrations.ghl_dnc_tags/ghl_paused_tags) instead of
-- the hardcoded 'dialer:dnc'/'dialer:paused' exact tags TASK-L3's ghl-import.ts stub used --
-- those never matched this task's real spec (default lists of "do not call"/"dnc"/"do-not-call"
-- and "paused"/"pause", owner/admin-editable). Column defaults ARE the spec's default lists, so
-- every already-connected org gets the real defaults with no separate backfill statement (adding
-- a column with a literal default backfills every existing row at the same time in Postgres).

alter table public.org_integrations
  add column ghl_dnc_tags text[] not null default array['do not call', 'dnc', 'do-not-call'],
  add column ghl_paused_tags text[] not null default array['paused', 'pause'];

-- org_integrations_status: append the two tag-list columns so an org's Settings -> Integrations
-- panel can read its current lists through the same safe view it already reads status/location_id
-- from (org_integrations itself has zero client policies -- see 20260924000900's header). Editing
-- them still goes through a service-role edge function (ghl-update-blocked-tags), same as every
-- other write to this table.
create or replace view public.org_integrations_status
  with (security_invoker = false)
  as
  select
    i.org_id,
    i.provider,
    i.status,
    i.token_last4,
    i.location_id,
    i.connected_at,
    i.ghl_dnc_tags,
    i.ghl_paused_tags
  from public.org_integrations i
  where private.is_org_member(i.org_id);

-- SECURITY FIX (lead review, pre-apply): org_integrations_status and org_telephony_status are
-- simple single-table views (no DISTINCT/GROUP BY/join), which Postgres treats as automatically
-- updatable (information_schema.views.is_updatable = YES) -- and because both are deliberately
-- security_invoker=false (so they can read past the base table's zero-policy RLS; see each view's
-- own original header), an INSERT/UPDATE/DELETE issued directly against the view runs with the
-- VIEW OWNER's privileges, not the caller's -- completely bypassing the "zero client policies"
-- protection those base tables were built around. Supabase's project-level default privileges
-- grant INSERT/UPDATE/DELETE/TRUNCATE/TRIGGER/REFERENCES on every public-schema relation
-- (views included) to anon/authenticated by default; only `grant select ... to authenticated` was
-- ever added on top, which does not remove the rest. Proven live (rolled back): an intern-level
-- authenticated user's `update org_telephony_status set call_control_app_id = ...` updated the
-- row in the real org_telephony base table. G7 widens the same hole -- an intern could otherwise
-- clear ghl_dnc_tags/ghl_paused_tags through org_integrations_status, bypassing the owner/admin
-- check ghl-update-blocked-tags enforces. Neither view was ever meant to be written through --
-- both close that gap here, for both views, since they share the exact same root cause.
revoke insert, update, delete, truncate, trigger, references
  on public.org_integrations_status, public.org_telephony_status
  from anon, authenticated;
-- Belt and braces: is_org_member(...) already returns false for anon, so anon's SELECT already
-- yields zero rows -- revoked anyway so "can anon read this view at all" is never a question.
revoke select on public.org_integrations_status, public.org_telephony_status from anon;

-- contacts.ghl_tags: raw snapshot of the contact's GHL tags as of its last import (TASK-G7). Lets
-- a re-import detect "this contact WAS paused (per its previously stored tags) and no longer is"
-- without a second live GHL round trip -- see ghl-import.ts's unpausedCount for the read side.
alter table public.contacts add column ghl_tags text[];

-- campaign_leads: a new terminal, non-dialable 'paused' status (TASK-G7's own "add a 'paused'
-- status via a migration if cleaner" option). 'passthrough' (the other suggested reuse) already
-- means something different and unrelated -- "this exact lead lost a same-contact-in-this-
-- campaign dedupe collision" (20260925000200) -- overloading it for "paused via a GHL tag" would
-- make both cases impossible to tell apart later (e.g. for a future "un-pause" management screen,
-- which needs to find exactly the GHL-paused rows, not every passthrough row too). 'paused' is
-- deliberately NOT added to campaign-queue.ts's ACTIVE_CAMPAIGN_LEAD_STATUSES -- claim_next_leads
-- (which only ever selects 'queued') already ignores it, same as every other terminal status.
alter table public.campaign_leads drop constraint campaign_leads_status_check;
alter table public.campaign_leads add constraint campaign_leads_status_check
  check (status in ('queued', 'in_flight', 'completed', 'exhausted', 'dnc', 'callback', 'passthrough', 'paused'));

-- ghl-update-blocked-tags: owner/admin-only settings write (Settings -> Integrations -> GHL),
-- same private/public SECURITY DEFINER wrapper split as set_org_ghl_token (20260924000900's
-- header explains why the indirection is necessary for a service-role edge function to reach a
-- function in the "private" schema). Requires an existing org_integrations row (i.e. the org has
-- connected GHL at least once) -- there is nothing to configure blocked tags ON before that, and
-- the UI only shows this editor once connected (same gating as the existing sync-status panel).

create function private.set_org_ghl_blocked_tags(p_org uuid, p_dnc_tags text[], p_paused_tags text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.org_integrations
  set ghl_dnc_tags = p_dnc_tags,
      ghl_paused_tags = p_paused_tags,
      updated_at = now()
  where org_id = p_org and provider = 'ghl';

  if not found then
    raise exception 'org % has no GHL integration to configure', p_org;
  end if;
end;
$$;

revoke all on function private.set_org_ghl_blocked_tags(uuid, text[], text[]) from public;
grant execute on function private.set_org_ghl_blocked_tags(uuid, text[], text[]) to service_role;

create function public.set_org_ghl_blocked_tags(p_org uuid, p_dnc_tags text[], p_paused_tags text[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.set_org_ghl_blocked_tags(p_org, p_dnc_tags, p_paused_tags);
end;
$$;

revoke all on function public.set_org_ghl_blocked_tags(uuid, text[], text[]) from public, anon, authenticated;
grant execute on function public.set_org_ghl_blocked_tags(uuid, text[], text[]) to service_role;

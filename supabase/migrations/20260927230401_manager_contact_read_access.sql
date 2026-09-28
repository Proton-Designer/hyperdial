-- MISSION-5 TASK-M5-P1 (follow-up from G5, board.md 22:2x): pod-scoped manager READ access to
-- contacts. Today a manager cannot SELECT contacts at all -- the SELECT policy
-- (20260924000300, "owner, admin, or assigned agent can view contacts") and
-- private.contact_read_access (20260927215820) both only have owner/admin + agent-with-access
-- branches, so a pod manager sees no contact detail, notes, or change history for the leads
-- their own agents work.
--
-- Lead decision (do not re-litigate): a manager may READ a contact iff some campaign_leads row
-- for that contact (same org) has an assigned_agent_id for which
-- private.is_agent_in_callers_pod_scope(org, assigned_agent_id) is true. READ ONLY -- no
-- insert/update/delete grant for managers on contacts; owner/admin/agent behaviour is byte-
-- identical (every existing branch is kept verbatim, only a new OR branch is added).

-- =================================================================================================
-- 1. private.manager_has_contact_access: mirrors private.agent_has_contact_access's shape (same
--    file/precedent) but keyed on campaign_leads.assigned_agent_id (per the lead's own decision)
--    rather than campaign_agents membership -- a manager's scope is about which AGENT a lead is
--    assigned to, not which campaign the manager themselves is attached to (managers aren't
--    attached to campaigns at all). The `has_org_role(p_org, array['manager'])` check lives
--    INSIDE the function (this task's own build instruction) so every caller -- the contacts
--    policy, contact_read_access, and any future RPC -- gets the same role gate for free instead
--    of having to remember to add it at each call site.
-- =================================================================================================

create function private.manager_has_contact_access(p_org uuid, p_contact_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select
    private.has_org_role(p_org, array['manager'])
    and exists (
      select 1
      from public.campaign_leads cl
      where cl.contact_id = p_contact_id
        and cl.org_id = p_org
        and cl.assigned_agent_id is not null
        and private.is_agent_in_callers_pod_scope(p_org, cl.assigned_agent_id)
    );
$$;

grant execute on function private.manager_has_contact_access(uuid, uuid) to authenticated;

-- =================================================================================================
-- 2. Supporting index. The RLS policy below runs this EXISTS once per contacts row selected, so
--    campaign_leads needs an index it can actually use for "does this contact_id have ANY
--    assigned_agent_id at all" across every lead status (the existing
--    idx_campaign_leads_one_active_per_contact is a PARTIAL unique index scoped to
--    queued/in_flight/callback only -- it cannot support this query, which must also see
--    completed/exhausted/dnc/removed leads: an agent who already finished a lead is still a
--    legitimate reason for their manager to have read access to that contact). A partial index
--    matching this function's own `assigned_agent_id is not null` filter exactly.
-- =================================================================================================

create index if not exists idx_campaign_leads_contact_assigned_agent
  on public.campaign_leads (contact_id, assigned_agent_id)
  where assigned_agent_id is not null;

-- =================================================================================================
-- 3. Widen the contacts SELECT policy. Dropped and recreated by its EXACT current name
--    (20260924000300) -- every existing branch kept verbatim, only the new manager OR-branch is
--    added.
-- =================================================================================================

drop policy "owner, admin, or assigned agent can view contacts" on public.contacts;

create policy "owner, admin, or assigned agent can view contacts"
  on public.contacts for select
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (
      private.has_org_role(org_id, array['agent'])
      and private.agent_has_contact_access(contacts.id)
    )
    or private.manager_has_contact_access(org_id, contacts.id)
  );

-- =================================================================================================
-- 4. Widen private.contact_read_access the SAME way, so contact_notes/contact_change_history's
--    own SELECT policies and RPCs (list_contact_notes, list_contact_change_history, add/edit/
--    delete_contact_note's own permission checks -- TASK-M5-G5) pick this up automatically, with
--    no separate change needed in that migration. Same signature (boolean in, boolean out) --
--    a plain `create or replace`, R-038 doesn't apply.
-- =================================================================================================

create or replace function private.contact_read_access(p_org uuid, p_contact_id uuid)
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
    )
    or private.manager_has_contact_access(p_org, p_contact_id);
$$;

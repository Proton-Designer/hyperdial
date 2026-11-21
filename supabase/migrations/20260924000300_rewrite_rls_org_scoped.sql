-- Tenancy foundation (3/3): drop the single-tenant auth.uid() = user_id policies and replace them
-- with org-scoped ones per docs/design/stage-1-architecture.md §2's permission matrix. Every new
-- policy is written with private.is_org_member / private.has_org_role -- no inline subquery on
-- org_members. user_preferences and notifications are intentionally left untouched: they are
-- per-user, not org-shared (see TASK-P1-01 log).
--
-- The same recursion the org_members invariant warns about turns out not to be limited to
-- org_members: campaign_leads' INSERT check queried contacts, and contacts' own SELECT policy
-- queries campaign_leads back -- a cycle Postgres detects and rejects at runtime ("infinite
-- recursion detected in policy for relation campaign_leads"), reproduced while writing this
-- task's RLS test (supabase/tests/rls_org_matrix.sql). Every cross-table reference from inside a
-- policy is therefore routed through a SECURITY DEFINER helper below, the same pattern as
-- is_org_member/has_org_role: it bypasses the referenced table's own RLS instead of re-entering
-- it, so no policy ever triggers another table's policy evaluation.

create function private.campaign_org_id(p_campaign_id uuid)
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
  select org_id from public.campaigns where id = p_campaign_id;
$$;

create function private.contact_org_id(p_contact_id uuid)
returns uuid
language sql
security definer
stable
set search_path = ''
as $$
  select org_id from public.contacts where id = p_contact_id;
$$;

create function private.agent_assigned_to_campaign(p_campaign_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1 from public.campaign_agents ca
    where ca.campaign_id = p_campaign_id and ca.user_id = auth.uid()
  );
$$;

create function private.agent_has_contact_access(p_contact_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.campaign_leads cl
    join public.campaign_agents ca on ca.campaign_id = cl.campaign_id
    where cl.contact_id = p_contact_id and ca.user_id = auth.uid()
  );
$$;

grant execute on function private.campaign_org_id(uuid) to authenticated;
grant execute on function private.contact_org_id(uuid) to authenticated;
grant execute on function private.agent_assigned_to_campaign(uuid) to authenticated;
grant execute on function private.agent_has_contact_access(uuid) to authenticated;

-- campaign_agents: validation trigger + policies ---------------------------
--
-- Guards the same class of bug the auth.md audit flagged for campaign_leads (an insert claiming
-- an org_id that does not match its parent row): org_id must equal the campaign's own org_id, and
-- the assigned user must already be a member of that org.

create function private.check_campaign_agent_org()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_campaign_org uuid;
begin
  select org_id into v_campaign_org from public.campaigns where id = new.campaign_id;
  if v_campaign_org is null or v_campaign_org <> new.org_id then
    raise exception 'campaign_agents.org_id must match campaigns.org_id';
  end if;
  if not exists (
    select 1 from public.org_members m
    where m.org_id = new.org_id and m.user_id = new.user_id and m.status = 'active'
  ) then
    raise exception 'campaign_agents.user_id must be an active member of org_id';
  end if;
  return new;
end;
$$;

create trigger campaign_agents_check_org
  before insert or update on public.campaign_agents
  for each row execute function private.check_campaign_agent_org();

create policy "org members can view campaign assignments"
  on public.campaign_agents for select
  using (private.is_org_member(org_id));

create policy "owner or admin can assign agents"
  on public.campaign_agents for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can unassign agents"
  on public.campaign_agents for delete
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- campaigns -----------------------------------------------------------------

drop policy "Users can view own campaigns" on public.campaigns;
drop policy "Users can insert own campaigns" on public.campaigns;
drop policy "Users can update own campaigns" on public.campaigns;
drop policy "Users can delete own campaigns" on public.campaigns;

create policy "org members can view campaigns"
  on public.campaigns for select
  using (private.is_org_member(org_id));

create policy "owner or admin can create campaigns"
  on public.campaigns for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update campaigns"
  on public.campaigns for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can delete campaigns"
  on public.campaigns for delete
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- campaign_leads --------------------------------------------------------
--
-- Fixes the auth.md finding: INSERT previously only checked the caller owned the campaign, never
-- that the contact belonged to the same tenant. Both are now required, alongside campaign_id and
-- contact_id each actually belonging to org_id (guards a crafted cross-org campaign_id/contact_id
-- pair as well as a crafted org_id).

drop policy "Users can view campaign_leads for own campaigns" on public.campaign_leads;
drop policy "Users can insert campaign_leads for own campaigns" on public.campaign_leads;
drop policy "Users can update campaign_leads for own campaigns" on public.campaign_leads;
drop policy "Users can delete campaign_leads for own campaigns" on public.campaign_leads;

create policy "owner, admin, or assigned agent can view leads"
  on public.campaign_leads for select
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (
      private.has_org_role(org_id, array['agent'])
      and private.agent_assigned_to_campaign(campaign_leads.campaign_id)
    )
  );

create policy "owner or admin can add leads"
  on public.campaign_leads for insert
  with check (
    private.has_org_role(org_id, array['owner', 'admin'])
    and private.campaign_org_id(campaign_leads.campaign_id) = campaign_leads.org_id
    and private.contact_org_id(campaign_leads.contact_id) = campaign_leads.org_id
  );

create policy "owner or admin can update leads"
  on public.campaign_leads for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can delete leads"
  on public.campaign_leads for delete
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- contacts ------------------------------------------------------------------
--
-- Agents read (and, until the contacts.dnc column lands in TASK-P1-02/design §7, can also write)
-- only contacts reachable through a campaign they are assigned to via campaign_agents. This is
-- broader than "agents may only toggle DNC" from the design's permission matrix -- there is no
-- dnc column yet to scope an UPDATE to. Narrow this to a DNC-only check once that column exists;
-- logged in this task's log and .brain/memory/known-issues.md.

drop policy "Users can view own contacts" on public.contacts;
drop policy "Users can insert own contacts" on public.contacts;
drop policy "Users can update own contacts" on public.contacts;
drop policy "Users can delete own contacts" on public.contacts;

create policy "owner, admin, or assigned agent can view contacts"
  on public.contacts for select
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (
      private.has_org_role(org_id, array['agent'])
      and private.agent_has_contact_access(contacts.id)
    )
  );

create policy "owner or admin can import contacts"
  on public.contacts for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner, admin, or assigned agent can update contacts"
  on public.contacts for update
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (
      private.has_org_role(org_id, array['agent'])
      and private.agent_has_contact_access(contacts.id)
    )
  )
  with check (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (
      private.has_org_role(org_id, array['agent'])
      and private.agent_has_contact_access(contacts.id)
    )
  );

create policy "owner or admin can delete contacts"
  on public.contacts for delete
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- user_phone_numbers ----------------------------------------------------
--
-- Any org member can see the org's numbers (needed to pick a caller ID while dialing); only
-- owner/admin buy, release, or otherwise change them.

drop policy "Users can view own phone numbers" on public.user_phone_numbers;
drop policy "Users can insert own phone numbers" on public.user_phone_numbers;
drop policy "Users can update own phone numbers" on public.user_phone_numbers;
drop policy "Users can delete own phone numbers" on public.user_phone_numbers;

create policy "org members can view phone numbers"
  on public.user_phone_numbers for select
  using (private.is_org_member(org_id));

create policy "owner or admin can add phone numbers"
  on public.user_phone_numbers for insert
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can update phone numbers"
  on public.user_phone_numbers for update
  using (private.has_org_role(org_id, array['owner', 'admin']))
  with check (private.has_org_role(org_id, array['owner', 'admin']));

create policy "owner or admin can delete phone numbers"
  on public.user_phone_numbers for delete
  using (private.has_org_role(org_id, array['owner', 'admin']));

-- call_events -------------------------------------------------------------
--
-- Writes stay service-role only (no client INSERT/UPDATE policy, same as before). Owner/admin see
-- every call in the org; an agent sees only their own.

drop policy "Users can view own call_events" on public.call_events;

create policy "owner, admin, or own agent can view call_events"
  on public.call_events for select
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (org_id is not null and private.is_org_member(org_id) and user_id = auth.uid())
  );

-- dialer_sessions -----------------------------------------------------------

drop policy "Users can view own dialer_sessions" on public.dialer_sessions;

create policy "owner, admin, or own agent can view dialer_sessions"
  on public.dialer_sessions for select
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (private.is_org_member(org_id) and user_id = auth.uid())
  );

-- call_logs -----------------------------------------------------------------

drop policy "Users can view own call_logs" on public.call_logs;

create policy "owner, admin, or own agent can view call_logs"
  on public.call_logs for select
  using (
    private.has_org_role(org_id, array['owner', 'admin'])
    or (private.is_org_member(org_id) and user_id = auth.uid())
  );

-- campaigns_with_stats -------------------------------------------------------
-- Recreated to carry org_id through; still security_invoker so the caller's RLS on campaigns
-- (now org-scoped) applies.

drop view public.campaigns_with_stats;

create view public.campaigns_with_stats as
select
  c.id,
  c.user_id,
  c.org_id,
  c.name,
  c.status,
  c.total_calls_made,
  c.connect_rate,
  c.last_called_at,
  c.created_at,
  c.updated_at,
  count(cl.id)::integer as total_contacts,
  count(cl.id) filter (where cl.status = 'queued')::integer as queued,
  count(cl.id) filter (where cl.status = 'completed')::integer as completed,
  count(cl.id) filter (where cl.status = 'passthrough')::integer as passthrough
from public.campaigns c
left join public.campaign_leads cl on cl.campaign_id = c.id
group by c.id;

alter view public.campaigns_with_stats set (security_invoker = on);

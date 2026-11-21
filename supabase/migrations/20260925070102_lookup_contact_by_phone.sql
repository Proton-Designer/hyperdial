-- TASK-I1 review fix (eng1 review-eng1.md finding #6): IncomingCallBanner needs to resolve the
-- caller's contact record to show a name (INB-2's own "the call rings their browser with the
-- contact card up (matched by the caller's E.164)" requirement) -- but the existing contacts RLS
-- policy ("owner, admin, or assigned agent can view contacts", 20260924000300) scopes an agent's
-- visibility to `campaign_leads`/`campaign_agents`: a contact this agent has never dialed (no
-- campaign relationship at all) is invisible to them under that policy. Inbound routing, though,
-- is keyed on which NUMBER was called (`user_phone_numbers.assigned_user_id`), not on any
-- campaign relationship -- an agent can receive a real inbound call from a contact they have no
-- campaign_leads row for at all, and a plain client-side query against contacts' own RLS would
-- silently under-match exactly the calls this banner exists to identify.
--
-- Fix: a small, deliberately WIDER lookup -- any org member may resolve ANY contact in their own
-- org by phone number, for this one narrow purpose (identifying who is calling right now), the
-- same shape `handleFreshInboundCall`'s own server-side (service-role) lookup already uses for
-- the identical reason (inbound-engine.ts).

create function public.lookup_contact_by_phone(p_org_id uuid, p_phone_e164 text)
returns table (id uuid, business_name text, first_name text, last_name text, phone_number text)
language sql
security definer
set search_path = ''
stable
as $$
  select c.id, c.business_name, c.first_name, c.last_name, c.phone_number
  from public.contacts c
  where c.org_id = p_org_id
    and c.phone_number = p_phone_e164
    and private.is_org_member(p_org_id)
  limit 1;
$$;

revoke all on function public.lookup_contact_by_phone(uuid, text) from public, anon;
grant execute on function public.lookup_contact_by_phone(uuid, text) to authenticated;

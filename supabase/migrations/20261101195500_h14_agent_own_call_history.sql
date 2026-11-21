-- TASK-H14: an agent (intern) sees only THEIR OWN past calls.
--
-- contact_disposition_history (the "last 3 attempts" strip in the wrap-up modal) was SECURITY DEFINER and gated only on
-- org membership, so an agent got every teammate's calls on a contact -- agent name, disposition, notes, has_recording --
-- and could pass ANY contact id in the org, including contacts they have no access to.
--
-- Fix: for the 'agent' role only the legs of the caller's own dial sessions are returned. owner/admin/manager keep the
-- existing org-wide strip (unchanged). Same signature and return shape, so nothing in the client moves, and the
-- existing EXECUTE grant to authenticated is preserved by CREATE OR REPLACE.

create or replace function public.contact_disposition_history(p_contact_id uuid)
returns table (
  leg_id uuid,
  dispositioned_at timestamptz,
  agent_name text,
  disposition_label text,
  notes text,
  has_recording boolean
)
language sql
security definer
stable
set search_path = ''
as $$
  select
    cl.id,
    cl.dispositioned_at,
    trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')),
    d.label,
    cl.notes,
    cl.recording_path is not null
  from public.call_legs cl
  join public.contacts c on c.id = cl.contact_id
  left join public.dispositions d on d.id = cl.disposition_id
  left join public.profiles p on p.user_id = cl.dispositioned_by
  where cl.contact_id = p_contact_id
    and cl.dispositioned_at is not null
    and private.is_org_member(c.org_id)
    -- H14: an agent only sees calls made in their own dial sessions
    and (
      not private.has_org_role(c.org_id, array['agent'])
      or private.dial_session_agent_id(cl.session_id) = auth.uid()
    )
  order by cl.dispositioned_at desc
  limit 3;
$$;

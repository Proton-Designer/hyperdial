-- TASK-H26 follow-up: one Do Not Call check for a manual dial that does not depend on what the caller's RLS lets them read.
-- The browser used to query dnc_numbers and contacts (dnc = true) directly; an agent cannot read contacts outside their
-- campaigns, so a contact flagged do-not-call by an admin edit or a GHL tag (no dnc_numbers row) was invisible to them.
-- This definer RPC answers one boolean for an org member: is this number on the org's dnc_numbers list, or on a contact in
-- the org with dnc = true. It returns nothing else (no contact id, no name), so it discloses no more than "do not dial".
-- Browser-side use only, like the rest of H26: it is not enforced by any server dial path.
create or replace function public.is_number_dnc(p_org_id uuid, p_e164 text)
returns boolean
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_digits text := regexp_replace(coalesce(p_e164, ''), '[^0-9]', '', 'g');
  v_phone text;
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_org_id is null or not private.is_org_member(p_org_id) then
    raise exception 'not a member of this organization' using errcode = '42501';
  end if;
  if length(v_digits) = 10 then
    v_phone := '+1' || v_digits;
  elsif length(v_digits) between 11 and 15 then
    v_phone := '+' || v_digits;
  else
    raise exception 'phone number is not valid' using errcode = '22023';
  end if;

  return exists (select 1 from public.dnc_numbers d where d.org_id = p_org_id and d.e164 = v_phone)
      or exists (select 1 from public.contacts c where c.org_id = p_org_id and c.phone_number = v_phone and c.dnc is true);
end;
$$;

revoke all on function public.is_number_dnc(uuid, text) from public, anon;
grant execute on function public.is_number_dnc(uuid, text) to authenticated;

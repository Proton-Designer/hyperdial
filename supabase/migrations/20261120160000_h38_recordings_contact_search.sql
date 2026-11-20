-- TASK-H38: Recordings show WHO was called (business, person, phone) and can be searched the way people type.
--
-- Rayan's report: a booked prospect no-showed; the recording showed no phone number to call back, and searching the company
-- ("Bow Stern" for "Bowstern Marketing Communications") found nothing. Contacts search is client-side (lib/contactName.ts);
-- this adds the SAME rule in SQL for recordings_search:
--   - every word of the query appears in the contact's business/name/owner text, OR
--   - the query with spaces removed appears in that text with spaces removed ("bow stern" finds "Bowstern"), OR
--   - a digits-only query (>= 3 digits, phone punctuation allowed) appears in a phone number's digits.
-- Normalisation: lowercase, common accents folded, every run of other characters = one space.
--
-- recordings_search gains p_search (last, default null) and four output columns (contact_id, contact_business, contact_name,
-- contact_phone). Output columns change, so the old function is dropped and recreated; every scoping rule is copied unchanged
-- (owner/admin all, manager pod-scoped, agent own; p_agent_id scope check; kind = 'contact'; recording saved). Callers that
-- do not pass p_search (an older web bundle) keep working and just ignore the new columns. Apply this BEFORE the web release.

create function private.search_norm(p_text text)
returns text
language sql
immutable
set search_path = ''
as $$
  select btrim(regexp_replace(
    translate(lower(coalesce(p_text, '')), 'àáâãäåāçćčèéêëēėęìíîïīñńòóôõöøōùúûüūýÿžśšł', 'aaaaaaaccceeeeeeeiiiiinnooooooouuuuuyyzssl'),
    '[^a-z0-9]+', ' ', 'g'))
$$;

create function private.search_matches(p_query text, p_text text, p_phones text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when private.search_norm(p_query) = '' then true
    when not exists (
      select 1 from unnest(string_to_array(private.search_norm(p_query), ' ')) w
      where position(w in private.search_norm(p_text)) = 0
    ) then true
    when position(replace(private.search_norm(p_query), ' ', '') in replace(private.search_norm(p_text), ' ', '')) > 0 then true
    when length(regexp_replace(coalesce(p_query, ''), '\D', '', 'g')) >= 3
         and btrim(p_query) ~ '^[0-9\s().+-]+$'
         and exists (
           select 1 from unnest(coalesce(p_phones, array[]::text[])) ph
           where position(regexp_replace(p_query, '\D', '', 'g') in regexp_replace(coalesce(ph, ''), '\D', '', 'g')) > 0
         ) then true
    else false
  end
$$;

drop function public.recordings_search(
  uuid, uuid, uuid, text, int, int, timestamptz, timestamptz, boolean, int, int
);

create function public.recordings_search(
  p_org uuid,
  p_agent_id uuid default null,
  p_campaign_id uuid default null,
  p_disposition_key text default null,
  p_min_duration_seconds int default null,
  p_max_duration_seconds int default null,
  p_start timestamptz default null,
  p_end timestamptz default null,
  p_flagged_only boolean default false,
  p_limit int default 50,
  p_offset int default 0,
  p_search text default null
)
returns table (
  call_leg_id uuid,
  agent_id uuid,
  agent_name text,
  campaign_id uuid,
  campaign_name text,
  disposition_key text,
  disposition_label text,
  duration_seconds int,
  ended_at timestamptz,
  is_flagged boolean,
  flag_reason text,
  comment_count bigint,
  has_scorecard boolean,
  contact_id uuid,
  contact_business text,
  contact_name text,
  contact_phone text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
begin
  if not private.has_org_role(p_org, array['owner', 'admin', 'manager', 'agent']) then
    return;
  end if;

  if p_agent_id is not null
     and not private.is_agent_in_callers_pod_scope(p_org, p_agent_id)
     and p_agent_id <> v_caller then
    raise exception 'that agent is outside your managed pods';
  end if;

  return query
  select
    cl.id,
    ds.agent_id,
    coalesce(nullif(trim(concat(pr.first_name, ' ', pr.last_name)), ''), 'Unknown'),
    cl.campaign_id,
    c.name,
    d.key,
    d.label,
    coalesce(cl.recording_duration_seconds, cl.duration_seconds),
    cl.ended_at,
    (rf.call_leg_id is not null),
    rf.reason,
    coalesce(cc.cnt, 0),
    (cs.id is not null),
    cl.contact_id,
    ct.business_name,
    nullif(trim(concat(ct.first_name, ' ', ct.last_name)), ''),
    coalesce(ct.phone_number, ct.phone_raw)
  from public.call_legs cl
  join public.dial_sessions ds on ds.id = cl.session_id
  left join public.profiles pr on pr.user_id = ds.agent_id
  left join public.campaigns c on c.id = cl.campaign_id
  left join public.contacts ct on ct.id = cl.contact_id and ct.org_id = cl.org_id
  left join public.dispositions d on d.id = cl.disposition_id
  left join public.recording_flags rf on rf.call_leg_id = cl.id
  left join public.call_scorecards cs on cs.call_leg_id = cl.id
  left join lateral (
    select count(*) as cnt from public.recording_comments rc where rc.call_leg_id = cl.id
  ) cc on true
  where cl.org_id = p_org
    and cl.kind = 'contact'
    and cl.recording_status = 'saved'
    and (private.is_agent_in_callers_pod_scope(p_org, ds.agent_id) or ds.agent_id = v_caller)
    and (p_agent_id is null or ds.agent_id = p_agent_id)
    and (p_campaign_id is null or cl.campaign_id = p_campaign_id)
    and (p_disposition_key is null or d.key = p_disposition_key)
    and (
      p_min_duration_seconds is null
      or coalesce(cl.recording_duration_seconds, cl.duration_seconds) >= p_min_duration_seconds
    )
    and (
      p_max_duration_seconds is null
      or coalesce(cl.recording_duration_seconds, cl.duration_seconds) <= p_max_duration_seconds
    )
    and (p_start is null or cl.ended_at >= p_start)
    and (p_end is null or cl.ended_at < p_end)
    and (not p_flagged_only or rf.call_leg_id is not null)
    and (
      p_search is null
      or private.search_matches(
        p_search,
        concat_ws(' ', ct.business_name, ct.first_name, ct.last_name, ct.owner_contact),
        array[ct.phone_number, ct.phone_raw]
      )
    )
  order by cl.ended_at desc nulls last
  limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0));
end;
$$;

revoke all on function public.recordings_search(
  uuid, uuid, uuid, text, int, int, timestamptz, timestamptz, boolean, int, int, text
) from public, anon;
grant execute on function public.recordings_search(
  uuid, uuid, uuid, text, int, int, timestamptz, timestamptz, boolean, int, int, text
) to authenticated;

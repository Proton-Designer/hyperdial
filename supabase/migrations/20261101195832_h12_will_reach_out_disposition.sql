-- TASK-H12 (intern feedback: "Need an option for when they say they are going to reach out"): a new default disposition
-- key 'will_reach_out', label "They'll reach out", for every org.
--  * lead_effect 'completed' -- the same effect as "Not interested": the lead leaves the dial queue (status 'completed'), no callback,
--    no retry, no DNC, no nurture tag (that one is only for 'exhausted'). Chosen over 'exhausted' on purpose: it is not a dead end.
--  * GHL tag 'Will Reach Out', no task, not a win, sort 35 (between "Not interested" 30 and "Already on platform" 40).
--  * Existing orgs get the row here (on conflict do nothing: an org that already made its own 'will_reach_out' keeps it);
--    new orgs get it from private.seed_default_dispositions, replaced below (body of 20261019210213 plus the one row; same signature).
-- Owners/admins can still add or edit dispositions themselves in Settings -> Dispositions.

insert into public.dispositions (org_id, key, label, lead_effect, ghl_tag, creates_task, sort, is_win, required_fields)
select o.id, 'will_reach_out', 'They''ll reach out', 'completed', 'Will Reach Out', false, 35, false, null
from public.orgs o
on conflict (org_id, key) do nothing;

create or replace function private.seed_default_dispositions(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.dispositions
    (org_id, key, label, lead_effect, ghl_tag, creates_task, sort, is_win, required_fields)
  values
    (p_org, 'yes_build_profile', 'Yes - Build Profile', 'completed', 'signed up', false, 10,
      true, array['license_number', 'zips']),
    (p_org, 'callback', 'Callback', 'callback', 'Callback', true, 20, false, null),
    (p_org, 'not_interested', 'Not interested', 'completed', 'Not Interested', false, 30, false, null),
    (p_org, 'will_reach_out', 'They''ll reach out', 'completed', 'Will Reach Out', false, 35, false, null),
    (p_org, 'already_on_platform', 'Already on platform', 'exhausted', 'Already On Platform', false, 40, false, null),
    (p_org, 'wrong_number', 'Wrong number', 'exhausted', 'Wrong Number', false, 50, false, null),
    (p_org, 'gatekeeper', 'Gatekeeper', 'queued', 'call:gatekeeper', false, 60, false, null),
    (p_org, 'do_not_call', 'Do not call', 'dnc', 'DNC', false, 70, false, null),
    (p_org, 'voicemail_left', 'Left voicemail', 'queued', 'call:voicemail_left', false, 80, false, null),
    (p_org, 'no_answer', 'No answer (manual)', 'queued', 'call:no_answer', false, 90, false, null)
  on conflict (org_id, key) do nothing;
$$;

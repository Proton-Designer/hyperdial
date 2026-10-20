-- TASK-G28 (user order: "for GHL tags include signed up and active, connect them to GHL and allow users to create them").
-- 1. New GHL integration rows start with the "Remove from call lists" reconcile ON and the exclude tags 'signed up' + 'active'
--    (ghl_reconcile_enabled default true, ghl_exclude_tags default {signed up,active}). No org has a GHL row yet, so nothing live
--    changes; the defaults take effect when an org connects (ghl-connect inserts the row via set_org_ghl_token). Existing rows are
--    left alone (an org that already configured its own lists keeps them).
-- 2. The win disposition ("Yes - Build Profile", is_win) pushes the GHL tag 'signed up' instead of 'Interested': dispositions.ghl_tag
--    lives in public.dispositions (20260924002200; seeded by private.seed_default_dispositions, last defined in 20260926080100).
--    New orgs get it from the replaced seed; existing orgs whose yes_build_profile tag is still the old default 'Interested' are
--    updated. A tag an admin changed by hand is left alone.
alter table public.org_integrations
  alter column ghl_reconcile_enabled set default true,
  alter column ghl_exclude_tags set default array['signed up', 'active']::text[];

update public.dispositions
set ghl_tag = 'signed up'
where key = 'yes_build_profile' and is_win and ghl_tag = 'Interested';

-- Body of 20260926080100 verbatim; only the yes_build_profile ghl_tag changed ('Interested' -> 'signed up'). Same signature, grants kept.
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
    (p_org, 'already_on_platform', 'Already on platform', 'exhausted', 'Already On Platform', false, 40, false, null),
    (p_org, 'wrong_number', 'Wrong number', 'exhausted', 'Wrong Number', false, 50, false, null),
    (p_org, 'gatekeeper', 'Gatekeeper', 'queued', 'call:gatekeeper', false, 60, false, null),
    (p_org, 'do_not_call', 'Do not call', 'dnc', 'DNC', false, 70, false, null),
    (p_org, 'voicemail_left', 'Left voicemail', 'queued', 'call:voicemail_left', false, 80, false, null),
    (p_org, 'no_answer', 'No answer (manual)', 'queued', 'call:no_answer', false, 90, false, null)
  on conflict (org_id, key) do nothing;
$$;

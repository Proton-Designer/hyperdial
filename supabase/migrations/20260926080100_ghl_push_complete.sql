-- MISSION-4 TASK-T2 (GHL push complete: GHL-2,10,11,12,13,16). User order: "give me everything
-- that relates to the parallel dialer and making it as powerful and industry level as possible."
--
-- GHL-10 ("every disposition pushes a matching tag ... ensure every outcome has one"): three of
-- the 9 canonical seeded dispositions (gatekeeper/voicemail_left/no_answer, 20260925060000) were
-- seeded with ghl_tag = null -- a deliberate choice at the time (their `queued` lead_effect made
-- a GHL tag less obviously useful), but this task's own explicit ask is that every outcome has
-- one. Fill ONLY the gaps -- an admin's own configured tag on any OTHER disposition (including
-- the 6 already-non-null seeded ones, e.g. 'Interested'/'Callback') is left completely alone, per
-- the task file's own "keep the admin-configurable mapping that exists" instruction. This is an
-- UPDATE, not a rename of the existing scheme -- 'Interested' etc. stay exactly as they are.
update public.dispositions set ghl_tag = 'call:' || key where ghl_tag is null;

-- Same fill, going forward, for every NEW org (private.seed_default_dispositions,
-- 20260925060000) -- verbatim reproduction of that function's body with only the three null
-- ghl_tag values changed to the same 'call:<key>' shape the UPDATE above just backfilled.
create or replace function private.seed_default_dispositions(p_org uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.dispositions
    (org_id, key, label, lead_effect, ghl_tag, creates_task, sort, is_win, required_fields)
  values
    (p_org, 'yes_build_profile', 'Yes - Build Profile', 'completed', 'Interested', false, 10,
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

-- GHL-12: "the pipeline stage moves with the outcome (an org-configurable outcome -> pipeline/
-- stage mapping; unmapped = no move)". Nullable, admin-editable directly via the existing
-- Settings dispositions editor (updateDisposition -- direct client RLS write, same admin/owner
-- policy every other disposition column already goes through; no new edge function or RLS
-- change needed for this alone). Both null (the default) means "don't move anything" -- the
-- task's own explicit "unmapped = no move" requirement.
alter table public.dispositions
  add column ghl_pipeline_id text,
  add column ghl_pipeline_stage_id text;

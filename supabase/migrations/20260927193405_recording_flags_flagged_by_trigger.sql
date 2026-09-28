-- MISSION-5 TASK-M5-B5 follow-up (review SHOULD): recording_flags.flagged_by was never set by
-- the real client path -- api.ts's own flagRecording() never sends it (there's no reason a
-- legitimate caller ever should have to), and the original migration
-- (20260927171355_call_review_library.sql) gave the column no default, so every real flag ended
-- up with flagged_by = NULL. Fixed server-side via a trigger that unconditionally stamps
-- auth.uid(), rather than trusting a client-supplied value for this column -- anyone who can
-- flag a leg (can_view_call_leg -- includes an agent flagging their own call) could otherwise
-- claim to be someone else by just passing a different flagged_by in the upsert payload.
--
-- Applies on both INSERT and UPDATE: "re-flagging overwrites the reason/flagger" is the ORIGINAL
-- migration's own stated intent for this table's upsert semantics, so the current flagger should
-- always win, not just the first one.

create function private.stamp_recording_flag_flagger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.flagged_by := auth.uid();
  return new;
end;
$$;

create trigger recording_flags_stamp_flagger
  before insert or update on public.recording_flags
  for each row execute function private.stamp_recording_flag_flagger();

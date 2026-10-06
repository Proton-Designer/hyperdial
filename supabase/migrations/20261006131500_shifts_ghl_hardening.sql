-- TASK-S04F (hardening before the first live GHL run, from eng2's S04 review). Replaces
-- complete_shift_outbox (same signature) so a later success can no longer hide a failure:
-- shifts.ghl_sync_status becomes 'synced' only when the row that just completed is the shift's LATEST
-- appointment row. An older row finishing while a newer one is pending (or errored) leaves the shift as is;
-- the newest appointment row carries the full desired state, so when it succeeds the shift IS in sync, even
-- if an older row had errored.
create or replace function public.complete_shift_outbox(p_id bigint, p_appointment_id text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.shift_ghl_outbox;
begin
  update public.shift_ghl_outbox
  set status = 'done', last_error = null
  where id = p_id and status = 'pending'
  returning * into r;
  if r.id is null or r.shift_id is null or r.kind not like 'appointment\_%' then
    return;
  end if;
  if p_appointment_id is not null then
    update public.shifts set ghl_appointment_id = p_appointment_id where id = r.shift_id;
  end if;
  if r.id = (
    select max(x.id) from public.shift_ghl_outbox x
    where x.shift_id = r.shift_id and x.kind like 'appointment\_%'
  ) then
    update public.shifts set ghl_sync_status = 'synced', ghl_sync_error = null where id = r.shift_id;
  end if;
end;
$$;

-- TASK-S04 (Shifts -> GHL sync). Claim / complete / fail / release RPCs for public.shift_ghl_outbox,
-- called by the shift-ghl-sync edge function (service role only; all PUBLIC because edge functions
-- can only rpc() the public schema).
--
--  * claim_shift_outbox(n)      up to n due pending rows, FOR UPDATE SKIP LOCKED, ordered by id, and
--                               leased: next_attempt_at is pushed 10 minutes ahead so a concurrent
--                               run (cron + a post-write nudge) never double-sends. A row whose
--                               contact has an EARLIER pending row that is not due (backoff or a
--                               live lease) is not claimed, so per-contact id order always holds.
--  * complete_shift_outbox      done; for appointment rows saves shifts.ghl_appointment_id and, once no
--                               appointment row of that shift is still pending, ghl_sync_status 'synced'.
--  * fail_shift_outbox          retryable: attempts+1, next try in 2^attempts minutes, 'error' after
--                               6 attempts; not retryable: 'error' at once. A terminal appointment
--                               failure copies the message to shifts.ghl_sync_error.
--  * release_shift_outbox       drop the lease without counting an attempt (held / deferred rows).

create function public.claim_shift_outbox(p_n integer default 50)
returns setof public.shift_ghl_outbox
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with due as (
    select o.id
    from public.shift_ghl_outbox o
    where o.status = 'pending'
      and o.next_attempt_at <= now()
      and not exists (
        select 1
        from public.shift_ghl_outbox e
        where o.user_id is not null
          and e.org_id = o.org_id
          and e.user_id = o.user_id
          and e.status = 'pending'
          and e.id < o.id
          and e.next_attempt_at > now()
      )
    order by o.id
    limit greatest(1, least(coalesce(p_n, 50), 200))
    for update of o skip locked
  )
  update public.shift_ghl_outbox o
  set next_attempt_at = now() + interval '10 minutes'
  from due
  where o.id = due.id
  returning o.*;
end;
$$;

create function public.complete_shift_outbox(p_id bigint, p_appointment_id text default null)
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
  if not exists (
    select 1 from public.shift_ghl_outbox x
    where x.shift_id = r.shift_id and x.kind like 'appointment\_%' and x.status = 'pending'
  ) then
    update public.shifts set ghl_sync_status = 'synced', ghl_sync_error = null where id = r.shift_id;
  end if;
end;
$$;

create function public.fail_shift_outbox(p_id bigint, p_error text, p_retryable boolean default true)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  r public.shift_ghl_outbox;
  v_msg text := left(coalesce(p_error, 'unknown error'), 500);
begin
  select * into r from public.shift_ghl_outbox where id = p_id and status = 'pending' for update;
  if r.id is null then
    return;
  end if;
  if p_retryable and r.attempts + 1 < 6 then
    update public.shift_ghl_outbox
    set attempts = r.attempts + 1,
        last_error = v_msg,
        next_attempt_at = now() + power(2, r.attempts + 1)::integer * interval '1 minute'
    where id = r.id;
    return;
  end if;
  update public.shift_ghl_outbox
  set status = 'error', attempts = r.attempts + 1, last_error = v_msg
  where id = r.id;
  if r.shift_id is not null and r.kind like 'appointment\_%' then
    update public.shifts set ghl_sync_status = 'error', ghl_sync_error = v_msg where id = r.shift_id;
  end if;
end;
$$;

create function public.release_shift_outbox(
  p_ids bigint[],
  p_error text default null,
  p_delay_seconds integer default 0
)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.shift_ghl_outbox
  set next_attempt_at = now() + make_interval(secs => greatest(coalesce(p_delay_seconds, 0), 0)),
      last_error = coalesce(left(p_error, 500), last_error)
  where id = any(p_ids) and status = 'pending';
$$;

revoke all on function
  public.claim_shift_outbox(integer),
  public.complete_shift_outbox(bigint, text),
  public.fail_shift_outbox(bigint, text, boolean),
  public.release_shift_outbox(bigint[], text, integer)
from public, anon, authenticated;
grant execute on function
  public.claim_shift_outbox(integer),
  public.complete_shift_outbox(bigint, text),
  public.fail_shift_outbox(bigint, text, boolean),
  public.release_shift_outbox(bigint[], text, integer)
to service_role;

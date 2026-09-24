#!/usr/bin/env bash
# submit_disposition_concurrency.sh -- TASK-P3-E1 fix-forward item 1 (lead's review of
# 20260924002200, migration 20260924002300): "the leg is read without a lock, so two concurrent
# submits (a double-click or retry) both see dispositioned_at null and both apply the lead
# effect." A single-connection SQL script (the _test_expect_* pattern the rest of
# supabase/tests/ uses) can't exercise real concurrency, so this uses two actual concurrent psql
# sessions on the SAME leg, same shape as crm_sync_jobs_concurrency.sh/
# run-dialer-concurrency-test.sh: session A submits a disposition and holds its transaction open
# (pg_sleep) past the FOR UPDATE row lock it just took; session B submits concurrently on the
# SAME leg while A is still open. `for update` must make B BLOCK until A commits, then see the
# leg already dispositioned and correctly take the no-op-effect (re-submit) path -- proving the
# lock actually serializes the two attempts rather than letting both race through and both apply
# the lead effect.
#
# Prerequisites: `supabase start` running, with migrations up to 20260924002300 already applied
# (this script does not apply them). LOCAL ONLY -- never point DB at a linked/remote project.
set -euo pipefail
DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
TAG="p3e1-conc-$(date +%s)"
OWNER_ID=""

cleanup() {
  echo "[submit-disposition-concurrency] cleanup"
  if [ -n "$OWNER_ID" ]; then
    psql "$DB" -q -c "delete from public.orgs where created_by = '${OWNER_ID}'" || true
    psql "$DB" -q -c "delete from auth.users where id = '${OWNER_ID}'" || true
  fi
}

echo "[submit-disposition-concurrency] seeding fixture"
psql "$DB" -v ON_ERROR_STOP=1 -q <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', '${TAG}@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);
SQL

OWNER_ID=$(psql "$DB" -t -A -c "select id from auth.users where email = '${TAG}@example.com'" | grep -E '^[0-9a-f-]{36}$')
if [ -z "$OWNER_ID" ]; then
  echo "[submit-disposition-concurrency] FAIL: could not create the fixture owner user"
  exit 1
fi
# Registered as soon as OWNER_ID exists -- same "clean up even if a later step fails" discipline
# as crm_sync_jobs_concurrency.sh's own fix (TASK-P3-P3), so a failure below never leaks a
# fixture user/org into the shared local DB.
trap cleanup EXIT

ORG_ID=$(psql "$DB" -t -A -c "select active_org_id from public.profiles where user_id = '${OWNER_ID}'" | grep -E '^[0-9a-f-]{36}$')
if [ -z "$ORG_ID" ]; then
  echo "[submit-disposition-concurrency] FAIL: profiles.active_org_id was not auto-provisioned for the owner user"
  exit 1
fi

CAMPAIGN_ID=$(psql "$DB" -t -A -c "
  insert into public.campaigns (org_id, user_id, name, calling_window_start, calling_window_end, max_attempts, retry_interval_minutes)
  values ('${ORG_ID}', '${OWNER_ID}', 'P3E1 Concurrency Campaign', '00:00', '23:59', 3, 120)
  returning id;
" | grep -E '^[0-9a-f-]{36}$')

CONTACT_ID=$(psql "$DB" -t -A -c "
  insert into public.contacts (org_id, user_id, phone_number) values ('${ORG_ID}', '${OWNER_ID}', '+15559990001') returning id;
" | grep -E '^[0-9a-f-]{36}$')

# attempts=1 here mirrors what apply_leg_outcome('connected') already did to a real winning leg
# before it reaches wrap_up -- the same simulated-prior-increment setup dispositions.sql uses.
LEAD_ID=$(psql "$DB" -t -A -c "
  insert into public.campaign_leads (campaign_id, contact_id, org_id, status, attempts)
  values ('${CAMPAIGN_ID}', '${CONTACT_ID}', '${ORG_ID}', 'in_flight', 1) returning id;
" | grep -E '^[0-9a-f-]{36}$')

SESSION_ID=$(psql "$DB" -t -A -c "
  insert into public.dial_sessions (org_id, campaign_id, agent_id, state, lines)
  values ('${ORG_ID}', '${CAMPAIGN_ID}', '${OWNER_ID}', 'wrap_up', 3) returning id;
" | grep -E '^[0-9a-f-]{36}$')

LEG_ID=$(psql "$DB" -t -A -c "
  insert into public.call_legs (org_id, session_id, campaign_id, contact_id, lead_id, kind, call_control_id, state)
  values ('${ORG_ID}', '${SESSION_ID}', '${CAMPAIGN_ID}', '${CONTACT_ID}', '${LEAD_ID}', 'contact', 'p3e1-conc-leg', 'ended') returning id;
" | grep -E '^[0-9a-f-]{36}$')

echo "[submit-disposition-concurrency] fixture ready: org=${ORG_ID} lead=${LEAD_ID} leg=${LEG_ID}"

A_OUT=$(mktemp)
B_OUT=$(mktemp)

# Session A: submit, then hold the transaction open 2s so its FOR UPDATE lock on the call_legs
# row stays live for B to race against, then commit.
psql "$DB" -t -A -c "
  begin;
  select already_submitted from public.submit_disposition('${LEG_ID}', '${ORG_ID}', '${OWNER_ID}', 'voicemail', 'first submit', null);
  select pg_sleep(2);
  commit;
" > "$A_OUT" 2>&1 &
A_PID=$!

sleep 0.5 # let A's submit land and its transaction still be open when B starts

B_START=$(date +%s)
# Session B: submits concurrently on the SAME leg. Without the fix-forward's `for update` lock,
# this would read dispositioned_at as still null (A hasn't committed yet) and re-apply the lead
# effect a second time. With the lock, this BLOCKS here until A commits.
psql "$DB" -t -A -c "
  begin;
  select already_submitted from public.submit_disposition('${LEG_ID}', '${ORG_ID}', '${OWNER_ID}', 'voicemail', 'second submit', null);
  commit;
" > "$B_OUT" 2>&1
B_END=$(date +%s)
B_ELAPSED=$((B_END - B_START))

wait "$A_PID"

A_ALREADY=$(grep -E '^[tf]$' "$A_OUT" | head -1)
B_ALREADY=$(grep -E '^[tf]$' "$B_OUT" | head -1)
rm -f "$A_OUT" "$B_OUT"

echo "[submit-disposition-concurrency] A already_submitted=${A_ALREADY} B already_submitted=${B_ALREADY} B_elapsed=${B_ELAPSED}s"

if [ "$A_ALREADY" != "f" ]; then
  echo "[submit-disposition-concurrency] FAIL: session A (first submit) should report already_submitted=false, got '${A_ALREADY}'"
  exit 1
fi
if [ "$B_ALREADY" != "t" ]; then
  echo "[submit-disposition-concurrency] FAIL: session B (raced against A) should report already_submitted=true (proves the row lock serialized them and B correctly saw the leg as already dispositioned), got '${B_ALREADY}'"
  exit 1
fi
if [ "$B_ELAPSED" -lt 1 ]; then
  echo "[submit-disposition-concurrency] FAIL: session B returned in ${B_ELAPSED}s -- too fast to have actually blocked on A's row lock through A's 2s pg_sleep. The lock may not be in effect."
  exit 1
fi

NOTES=$(psql "$DB" -t -A -c "select notes from public.call_legs where id = '${LEG_ID}'")
if [ "$NOTES" != "second submit" ]; then
  echo "[submit-disposition-concurrency] FAIL: expected the leg's notes to be B's ('second submit', it ran after A committed), got '${NOTES}'"
  exit 1
fi

ATTEMPTS=$(psql "$DB" -t -A -c "select attempts from public.campaign_leads where id = '${LEAD_ID}'")
if [ "$ATTEMPTS" != "1" ]; then
  echo "[submit-disposition-concurrency] FAIL: expected attempts to stay 1 (the lead effect must have applied exactly once, and 'queued' never increments -- fix-forward item 2), got '${ATTEMPTS}'"
  exit 1
fi

echo "[submit-disposition-concurrency] PASS: the row lock serialized two concurrent submits on the same leg -- exactly one lead-effect application, the second call correctly took the re-submit path"

#!/usr/bin/env bash
# crm_sync_jobs_concurrency.sh — TASK-P3-P3 acceptance requirement: "two concurrent workers
# never claim the same job." A single-connection SQL script (the `_test_expect_*` helper
# pattern the rest of supabase/tests/ uses) can't exercise real concurrency, so this uses two
# actual concurrent psql sessions instead: session A claims 3 of 5 queued jobs, then holds its
# transaction open (pg_sleep) so its FOR UPDATE SKIP LOCKED locks are still live; session B
# claims concurrently while A is still open. Asserts the two claimed sets are disjoint and their
# union is every job inserted (nothing double-claimed, nothing lost).
#
# Prerequisites: `supabase start` running, with migration 20260924002000 already applied (this
# script does not apply it). LOCAL ONLY -- never point DB at a linked/remote project.
set -euo pipefail
DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"

echo "[crm-sync-concurrency] seeding fixture"
# psql -t -A still prints the "INSERT 0 1" command tag on its own line after a RETURNING
# value (confirmed live -- -t only suppresses column headers/row-count footers for a SELECT,
# not a DML command tag), so a bare $(psql ...) capture picks up both lines. Filter to the
# UUID-shaped line specifically, same technique the claim-set comparison below already uses.
OWNER_ID=$(psql "$DB" -t -A -c "
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token,
    email_change, email_change_token_new, email_change_token_current, phone_change, phone_change_token,
    reauthentication_token, is_sso_user, is_anonymous)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    'crm-concurrency-test@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(),
    '', '', '', '', '', '', '', '', false, false)
  returning id;
" | grep -E '^[0-9a-f-]{36}$')
if [ -z "$OWNER_ID" ]; then
  echo "[crm-sync-concurrency] FAIL: could not create the fixture owner user"
  exit 1
fi

# Registered as soon as OWNER_ID exists, not after every later step -- so a failure anywhere
# below (including the org lookup on the very next line) still cleans up the user/org instead
# of leaking a fixture row into the shared local DB (found live: an earlier version of this
# script left exactly that behind after an unrelated bug aborted it mid-run).
cleanup() {
  echo "[crm-sync-concurrency] cleanup"
  if [ -n "${ORG_ID:-}" ]; then
    psql "$DB" -t -A -c "delete from public.orgs where id = '$ORG_ID';" >/dev/null || true
  fi
  psql "$DB" -t -A -c "delete from auth.users where id = '$OWNER_ID';" >/dev/null || true
}
trap cleanup EXIT

ORG_ID=$(psql "$DB" -t -A -c "select active_org_id from public.profiles where user_id = '$OWNER_ID';" | grep -E '^[0-9a-f-]{36}$')
if [ -z "$ORG_ID" ]; then
  echo "[crm-sync-concurrency] FAIL: profiles.active_org_id was not auto-provisioned for the owner user"
  exit 1
fi

psql "$DB" -t -A -c "
  insert into public.crm_sync_jobs (org_id, provider, kind, payload)
  select '$ORG_ID', 'ghl', 'contact_upsert', '{}'::jsonb from generate_series(1,5);
" >/dev/null
echo "[crm-sync-concurrency] 5 jobs queued for org $ORG_ID"

A_OUT=$(mktemp)
B_OUT=$(mktemp)

# Session A: claim 3, hold the transaction open 2s so its row locks stay live for B to race
# against, then commit.
psql "$DB" -t -A -c "
  begin;
  select id from public.claim_crm_sync_jobs(3) order by id;
  select pg_sleep(2);
  commit;
" > "$A_OUT" 2>&1 &
A_PID=$!

sleep 0.5 # let A's claim land and its transaction still be open when B starts

# Session B: claims concurrently. FOR UPDATE SKIP LOCKED must skip A's 3 locked rows and
# return only the 2 still-unlocked ones (a plain FOR UPDATE, without SKIP LOCKED, would instead
# block here until A commits -- this proves SKIP LOCKED is actually in effect, not just written).
psql "$DB" -t -A -c "
  begin;
  select id from public.claim_crm_sync_jobs(3) order by id;
  commit;
" > "$B_OUT" 2>&1
B_START=$(date +%s)

wait "$A_PID"

A_IDS=$(grep -E '^[0-9a-f-]{36}$' "$A_OUT" | sort)
B_IDS=$(grep -E '^[0-9a-f-]{36}$' "$B_OUT" | sort)
rm -f "$A_OUT" "$B_OUT"

A_COUNT=$(echo "$A_IDS" | grep -c . || true)
B_COUNT=$(echo "$B_IDS" | grep -c . || true)
OVERLAP=$(comm -12 <(echo "$A_IDS") <(echo "$B_IDS") | grep -c . || true)
TOTAL=$((A_COUNT + B_COUNT))

echo "[crm-sync-concurrency] session A claimed $A_COUNT, session B claimed $B_COUNT, overlap=$OVERLAP, total=$TOTAL"

if [ "$OVERLAP" -ne 0 ]; then
  echo "[crm-sync-concurrency] FAIL: sessions claimed $OVERLAP overlapping job id(s)"
  exit 1
fi
if [ "$TOTAL" -ne 5 ]; then
  echo "[crm-sync-concurrency] FAIL: expected 5 jobs claimed across both sessions, got $TOTAL"
  exit 1
fi
if [ "$A_COUNT" -ne 3 ]; then
  echo "[crm-sync-concurrency] FAIL: expected session A (claimed first, p_n=3) to get exactly 3, got $A_COUNT"
  exit 1
fi

echo "[crm-sync-concurrency] PASS: no overlap, all 5 jobs claimed exactly once across two concurrent sessions"

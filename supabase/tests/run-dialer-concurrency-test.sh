#!/usr/bin/env bash
# run-dialer-concurrency-test.sh — TASK-P2-E1 acceptance #2: two concurrent claim_next_leads
# calls against the same 5-lead pool must return disjoint leads (SKIP LOCKED doing its job), not
# duplicates and not an error.
#
# LOCAL ONLY, and requires 20260924000700/000800 already applied (this task's own migrations --
# `npm run db:push`/`supabase migration up`, run by the lead, not this script). Cleans up its own
# fixtures on exit (success, failure, or interrupt) via `delete from public.orgs` (cascades every
# child row this script created) + `delete from auth.users` -- a targeted delete of only the rows
# this run's TAG created, not a full `npm run db:local:reset` of the shared local DB.
#
# A single psql script can't hold two overlapping open transactions, hence two real client
# processes here (the "documented manual script" this task's acceptance text allows for #2).
set -euo pipefail
DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
TAG="p2e1-conc-$(date +%s)"
OWNER_ID=""

cleanup() {
  if [ -n "$OWNER_ID" ]; then
    psql "$DB" -q -c "delete from public.orgs where created_by = '${OWNER_ID}'" || true
    psql "$DB" -q -c "delete from auth.users where id = '${OWNER_ID}'" || true
  fi
}
trap cleanup EXIT

psql "$DB" -v ON_ERROR_STOP=1 -q <<SQL
insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, is_sso_user, is_anonymous)
values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', '${TAG}@example.com', crypt('x', gen_salt('bf')), now(), '{}', '{}', now(), now(), '', '', false, false);
SQL

OWNER_ID=$(psql "$DB" -t -A -c "select id from auth.users where email = '${TAG}@example.com'")
ORG_ID=$(psql "$DB" -t -A -c "select active_org_id from public.profiles where user_id = '${OWNER_ID}'")
# A bare `INSERT ... RETURNING` via -c prints its own "INSERT 0 1" status line after the row, even
# under -t -A, which corrupts a $(...) capture -- wrapping it in a CTE (`with ins as (insert ...
# returning id) select id from ins`) makes the whole statement a SELECT, so only the row prints.
CAMPAIGN_ID=$(psql "$DB" -t -A -c "with ins as (insert into public.campaigns (org_id, user_id, name, calling_window_start, calling_window_end) values ('${ORG_ID}', '${OWNER_ID}', '${TAG}', '00:00', '23:59') returning id) select id from ins")
SESSION_A=$(psql "$DB" -t -A -c "with ins as (insert into public.dial_sessions (org_id, campaign_id, agent_id, state) values ('${ORG_ID}', '${CAMPAIGN_ID}', '${OWNER_ID}', 'dialing') returning id) select id from ins")
SESSION_B=$(psql "$DB" -t -A -c "with ins as (insert into public.dial_sessions (org_id, campaign_id, agent_id, state) values ('${ORG_ID}', '${CAMPAIGN_ID}', '${OWNER_ID}', 'dialing') returning id) select id from ins")

for i in 1 2 3 4 5; do
  CID=$(psql "$DB" -t -A -c "with ins as (insert into public.contacts (org_id, user_id, phone_number, timezone) values ('${ORG_ID}', '${OWNER_ID}', '+1555${TAG: -7}${i}', 'America/Chicago') returning id) select id from ins")
  psql "$DB" -v ON_ERROR_STOP=1 -q -c "insert into public.campaign_leads (campaign_id, contact_id, org_id, status, attempts, next_attempt_at) values ('${CAMPAIGN_ID}', '${CID}', '${ORG_ID}', 'queued', 0, now())"
done

echo "--- 5 leads seeded, campaign=${CAMPAIGN_ID} ---"

OUT_A=$(mktemp)
OUT_B=$(mktemp)
# Two real, concurrently-open connections, each claiming 3 -- with only 5 available, disjoint
# results is the only way both can get their full/partial claim without an overlap.
psql "$DB" -t -A -c "select contact_id from public.claim_next_leads('${SESSION_A}', 3)" > "$OUT_A" &
PID_A=$!
psql "$DB" -t -A -c "select contact_id from public.claim_next_leads('${SESSION_B}', 3)" > "$OUT_B" &
PID_B=$!
wait "$PID_A" "$PID_B"

echo "--- session A claimed ---"; cat "$OUT_A"
echo "--- session B claimed ---"; cat "$OUT_B"

OVERLAP=$(comm -12 <(sort "$OUT_A") <(sort "$OUT_B") | wc -l | tr -d ' ')
TOTAL=$(( $(wc -l < "$OUT_A") + $(wc -l < "$OUT_B") ))

rm -f "$OUT_A" "$OUT_B"

if [ "$OVERLAP" -ne 0 ]; then
  echo "FAIL: $OVERLAP contact(s) claimed by both sessions -- SKIP LOCKED did not prevent a double-claim"
  exit 1
fi
if [ "$TOTAL" -ne 5 ]; then
  echo "FAIL: expected 5 leads claimed across both sessions (3+2 or fewer if one session raced ahead), got $TOTAL"
  exit 1
fi

echo "PASS: disjoint claims, $TOTAL leads claimed across both sessions, zero overlap"

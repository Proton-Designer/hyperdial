#!/usr/bin/env bash
# run-dialer-concurrency-test.sh — TASK-P2-E1 acceptance #2 (scenario 1) and TASK-P2-E2
# fix-forward item 1 (scenario 2, added when claim_next_leads gained the capacity check + leg
# insert -- the overdial race fix):
#   1. Two concurrent claim_next_leads calls for DIFFERENT sessions against the same shared
#      5-lead pool must return disjoint leads (SKIP LOCKED doing its job), not duplicates.
#   2. Two concurrent claim_next_leads calls for the SAME session (a 3-line session, 10
#      candidates available -- plenty of demand) must never together claim/dial more than
#      `lines` -- the exact race a same-process sequential acceptance script (dialer-sim.ts)
#      cannot exercise by construction, per LANE-eng2.md's NEEDS-CONCURRENCY-VERIFY lesson.
#
# LOCAL ONLY, and requires 20260924000700/000800/20260924001900 already applied (this task's
# own migrations -- `npm run db:push`/`supabase migration up`, run by the lead, not this
# script). Cleans up its own fixtures on exit (success, failure, or interrupt) via `delete from
# public.orgs` (cascades every child row this script created) + `delete from auth.users` -- a
# targeted delete of only the rows this run's TAG created, not a full `npm run db:local:reset`
# of the shared local DB.
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
# Two real, concurrently-open connections, each claiming (up to) 3 -- claim_next_leads no
# longer takes a p_n (TASK-P2-E2 fix-forward item 1: it derives its own capacity from each
# session's own `lines`, both default to 3 here) -- with only 5 contacts available across the
# two sessions' shared campaign pool, disjoint results is the only way both can get their
# full/partial claim without an overlap.
psql "$DB" -t -A -c "select contact_id from public.claim_next_leads('${SESSION_A}')" > "$OUT_A" &
PID_A=$!
psql "$DB" -t -A -c "select contact_id from public.claim_next_leads('${SESSION_B}')" > "$OUT_B" &
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

echo
echo "=== scenario 2: SAME session, concurrent refills must never exceed lines (fix-forward item 1) ==="

SESSION_C=$(psql "$DB" -t -A -c "with ins as (insert into public.dial_sessions (org_id, campaign_id, agent_id, state, lines) values ('${ORG_ID}', '${CAMPAIGN_ID}', '${OWNER_ID}', 'dialing', 3) returning id) select id from ins")

for i in 1 2 3 4 5 6 7 8 9 10; do
  CID=$(psql "$DB" -t -A -c "with ins as (insert into public.contacts (org_id, user_id, phone_number, timezone) values ('${ORG_ID}', '${OWNER_ID}', '+1556${TAG: -6}${i}', 'America/Chicago') returning id) select id from ins")
  psql "$DB" -v ON_ERROR_STOP=1 -q -c "insert into public.campaign_leads (campaign_id, contact_id, org_id, status, attempts, next_attempt_at) values ('${CAMPAIGN_ID}', '${CID}', '${ORG_ID}', 'queued', 0, now())"
done

echo "--- 10 more leads seeded for session C (lines=3), 10x the actual capacity ---"

OUT_C1=$(mktemp)
OUT_C2=$(mktemp)
# Both calls target the SAME session -- before the fix-forward, each independently read "0
# active legs, room for 3" and could together dial up to 6 against a 3-line session. The fix
# locks the dial_sessions row for claim_next_leads's whole call, so the second call blocks
# until the first commits its new call_legs rows, then sees the reduced (or zero) room.
psql "$DB" -t -A -c "select leg_id from public.claim_next_leads('${SESSION_C}')" > "$OUT_C1" &
PID_C1=$!
psql "$DB" -t -A -c "select leg_id from public.claim_next_leads('${SESSION_C}')" > "$OUT_C2" &
PID_C2=$!
wait "$PID_C1" "$PID_C2"

CLAIMED_C1=$(grep -c . "$OUT_C1" || true)
CLAIMED_C2=$(grep -c . "$OUT_C2" || true)
TOTAL_C=$((CLAIMED_C1 + CLAIMED_C2))
rm -f "$OUT_C1" "$OUT_C2"

LEG_ROWS_C=$(psql "$DB" -t -A -c "select count(*) from public.call_legs where session_id = '${SESSION_C}'")

echo "call 1 claimed ${CLAIMED_C1}, call 2 claimed ${CLAIMED_C2}, total ${TOTAL_C}, call_legs rows for session C: ${LEG_ROWS_C}"

if [ "$TOTAL_C" -gt 3 ]; then
  echo "FAIL: session C (lines=3) had ${TOTAL_C} leads claimed across two concurrent refills -- the overdial race is back"
  exit 1
fi
if [ "$LEG_ROWS_C" -gt 3 ]; then
  echo "FAIL: session C (lines=3) has ${LEG_ROWS_C} call_legs rows after two concurrent refills -- exceeds lines"
  exit 1
fi
if [ "$TOTAL_C" -ne 3 ]; then
  echo "FAIL: expected exactly 3 leads claimed total (10 candidates were available, lines=3) -- one call under-claimed"
  exit 1
fi

echo "PASS: session C claimed exactly 3 total across two concurrent refills, never exceeding lines"

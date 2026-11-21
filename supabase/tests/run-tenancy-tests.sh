#!/usr/bin/env bash
# run-tenancy-tests.sh — TASK-P1-01 verification: the tenancy backfill (against real pre-org
# data) plus the RLS org matrix (against the full post-migration schema).
#
# Uses the same EMPTY-workdir / legacy-replay technique as scripts/db-local-reset.sh (see that
# file for why) but inserts a seed step between the legacy replay and the new migrations, so the
# backfill runs against data that genuinely predates orgs -- exactly the live project's situation.
# LEGACY_ORDER must be kept in sync with scripts/db-local-reset.sh.
#
# LOCAL ONLY. Resets the local Postgres instance; do not run against a linked/remote project.
# Leaves the local DB in a post-migration state with two extra seeded users -- run
# `npm run db:local:reset` afterward to get back to a clean baseline before other engineers rely
# on the shared local stack.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EMPTY="${TMPDIR:-/tmp}/hyperdial-supabase-empty"
DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
LEGACY_ORDER=(20250214000001 20250207000001 20250207100000 20250208000001 20250213000001 20260207000100 20260208000001)

mkdir -p "$EMPTY/supabase/migrations"
find "$EMPTY/supabase/migrations" -name '*.sql' -delete
cp "$ROOT/supabase/config.toml" "$EMPTY/supabase/config.toml"

supabase db reset --local --workdir "$EMPTY"

psql "$DB" -q -v ON_ERROR_STOP=1 -c "create schema if not exists supabase_migrations;
  create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text)"

for v in "${LEGACY_ORDER[@]}"; do
  f=$(ls "$ROOT"/supabase/migrations/"${v}"_*.sql)
  name=$(basename "$f" .sql); name=${name#*_}
  psql "$DB" -q -v ON_ERROR_STOP=1 -f "$f"
  psql "$DB" -q -v ON_ERROR_STOP=1 -c \
    "insert into supabase_migrations.schema_migrations(version, name) values ('$v', '$name') on conflict (version) do nothing"
  echo "legacy applied: $v $name"
done

echo "--- seeding pre-org users (proves the backfill works on data that predates orgs) ---"
psql "$DB" -q -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/fixtures/seed_pre_org_users.sql"

echo "--- applying tenancy migrations ---"
supabase migration up --local --workdir "$ROOT"

echo "--- backfill assertions ---"
psql "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/tenancy_backfill_assertions.sql"

echo "--- RLS org matrix (self-contained; BEGIN/ROLLBACK, leaves no fixtures behind) ---"
psql "$DB" -v ON_ERROR_STOP=1 -f "$ROOT/supabase/tests/rls_org_matrix.sql"

echo "ALL TENANCY TESTS PASSED"
echo "Run 'npm run db:local:reset' to return the shared local DB to a clean baseline."

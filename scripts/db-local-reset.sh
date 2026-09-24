#!/usr/bin/env bash
# db-local-reset.sh — rebuild the LOCAL Supabase database from this repo's migrations.
#
# Why this exists: the committed migrations cannot replay from an empty database in timestamp
# order. 20250207000001/20250207100000 reference public.contacts, which is only created by
# 20250214000001 (the live project was built out of order). Migrations are append-only and
# already applied to the live project, so they are not edited. Instead, this script:
#   1. starts (or resets) the local stack from an EMPTY copy of the supabase dir, same project_id,
#   2. replays the legacy migrations in a working order and records them in
#      supabase_migrations.schema_migrations,
#   3. runs `supabase migration up --local` from the real dir, which applies every newer migration.
# LOCAL ONLY. It never touches a linked/remote project. Long-term fix: baseline from the live schema
# (see .brain/memory/known-issues.md).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EMPTY="${TMPDIR:-/tmp}/softdial-supabase-empty"
DB="postgresql://postgres:postgres@127.0.0.1:54322/postgres"
LEGACY_ORDER=(20250214000001 20250207000001 20250207100000 20250208000001 20250213000001 20260207000100 20260208000001)

mkdir -p "$EMPTY/supabase/migrations"
find "$EMPTY/supabase/migrations" -name '*.sql' -delete
cp "$ROOT/supabase/config.toml" "$EMPTY/supabase/config.toml"

if supabase status --workdir "$EMPTY" >/dev/null 2>&1; then
  supabase db reset --local --workdir "$EMPTY"
else
  supabase start --workdir "$EMPTY"
fi

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

supabase migration up --local --workdir "$ROOT"
echo "local DB ready: $(psql "$DB" -Atc 'select count(*) from supabase_migrations.schema_migrations') migrations recorded"

#!/usr/bin/env bash
# Supabase migration / query helper for Mancipatio.
# Reads the DB password from .env.local (gitignored) at runtime — no secrets stored here.
# The direct host (db.<ref>.supabase.co) no longer resolves over IPv4; we use the
# Supavisor session pooler in eu-west-1.
#
# Usage:
#   bash scripts/db.sh -f supabase/migrations/0014_asset_profiles.sql
#   bash scripts/db.sh -c "select count(*) from assets;"
#   bash scripts/db.sh   # opens an interactive psql session
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env.local ]; then echo "missing .env.local" >&2; exit 1; fi
RAW="$(grep -E '^SUPABASE_DB_URL=' .env.local | head -1 | cut -d= -f2- | tr -d '"')"
rest="${RAW#postgresql://}"; rest="${rest#postgres://}"
afteruser="${rest#*:}"
PASS="${afteruser%@*}"

HOST="aws-0-eu-west-1.pooler.supabase.com"
PORT="5432"
USER="postgres.gvnckuzmuwozlcohtuhx"
DB="postgres"

PGPASSWORD="$PASS" exec psql -h "$HOST" -p "$PORT" -U "$USER" -d "$DB" -v ON_ERROR_STOP=1 "$@"

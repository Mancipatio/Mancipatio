#!/usr/bin/env bash
# Maintenance mode switch (public.platform_maintenance, migration 0061).
# While it is on, signed API writes and wallet transactions are refused with
# 503 and every page shows the message; reads, sign-in, the indexer webhook
# and /api/internal/retry keep running. Servers pick up a change within ~5 s,
# open pages within ~30 s (or on focus).
#
# Usage:
#   bash scripts/ops/maintenance.sh devnet on "Program upgrade in progress, back in about 15 minutes."
#   bash scripts/ops/maintenance.sh devnet off
#   bash scripts/ops/maintenance.sh devnet status
#
# Values reach SQL only as psql variables quoted with :'name' (never spliced
# into the statement). The connection goes through scripts/db.sh, which reads
# the database password itself; nothing here prints or echoes credentials.
set -euo pipefail
cd "$(dirname "$0")/../.."

usage() {
  echo "usage: bash scripts/ops/maintenance.sh <devnet|mainnet|testnet|localnet> on \"message\" | off | status" >&2
  exit 2
}

[ $# -ge 2 ] || usage
network="$1"
action="$2"
case "$network" in devnet|mainnet|testnet|localnet) ;; *) usage ;; esac
operator="${MAINTENANCE_OPERATOR:-${USER:-ops}}"

# Shown after every change so the operator sees the stored state.
status_sql="select :'network' as network, coalesce(m.enabled, false) as enabled, m.message, m.updated_at, m.updated_by
from (select 1) as one left join public.platform_maintenance m on m.network = :'network';"

run() {
  bash scripts/db.sh -X -q -P pager=off -v network="$network" -v operator="$operator" "$@"
}

case "$action" in
  on)
    [ $# -eq 3 ] || usage
    message="$3"
    if [ -z "${message//[[:space:]]/}" ]; then echo "The message must not be empty." >&2; exit 2; fi
    # The table enforces 500 characters; this only fails earlier.
    if [ "$(printf '%s' "$message" | wc -m)" -gt 500 ]; then echo "The message must be at most 500 characters." >&2; exit 2; fi
    run -v message="$message" -f - <<SQL
insert into public.platform_maintenance (network, enabled, message, updated_at, updated_by)
values (:'network', true, :'message', now(), :'operator')
on conflict (network) do update
  set enabled = true, message = excluded.message, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
$status_sql
SQL
    ;;
  off)
    [ $# -eq 2 ] || usage
    run -f - <<SQL
insert into public.platform_maintenance (network, enabled, updated_at, updated_by)
values (:'network', false, now(), :'operator')
on conflict (network) do update
  set enabled = false, updated_at = excluded.updated_at, updated_by = excluded.updated_by;
$status_sql
SQL
    ;;
  status)
    [ $# -eq 2 ] || usage
    run -f - <<SQL
$status_sql
SQL
    ;;
  *) usage ;;
esac

#!/usr/bin/env bash
# Maintenance mode switch (public.platform_maintenance, migration 0061).
# While it is on, signed API writes and wallet transactions are refused with
# 503 and every page shows the message; reads, sign-in, receipts of
# transactions that already landed, the indexer webhook and
# /api/internal/retry keep running. Open pages show it within ~30 s (or on
# focus).
#
# Switching it on does not stop writes at once: each server instance keeps
# its cached flag for up to 5 s, and a request that already passed the check
# keeps writing until it finishes (routes that set maxDuration allow up to
# 60 s; the others are bounded only by the platform default). Wait about
# 70 s after `on` before starting work that must not race user writes, longer
# if the function logs still show requests running. The flag only works once
# a front that reads it (migration 0061 and later) is deployed.
#
# Usage:
#   bash scripts/ops/maintenance.sh devnet on "Program upgrade in progress, back in about 15 minutes."
#   bash scripts/ops/maintenance.sh devnet off
#   bash scripts/ops/maintenance.sh devnet status
#   MANCI_ALLOW_MAINNET=1 bash scripts/ops/maintenance.sh mainnet on "…"
#
# Target (Talas 4.3): for devnet and mainnet the database is the target of the
# same name (scripts/ops/targets.json); a MANCI_TARGET that names another one
# is refused. testnet and localnet flags live in some other project, so they
# need MANCI_TARGET set explicitly, and never to mainnet. scripts/db.sh then
# checks the database's identity row before any SQL (mainnet also needs
# MANCI_ALLOW_MAINNET=1; on a project without the identity yet, set
# MANCI_DB_BOOTSTRAP=1). The network guard (migration 0071) refuses a
# 'mainnet' flag row in any other project, and the reverse.
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
case "$network" in
  devnet|mainnet)
    if [ -n "${MANCI_TARGET:-}" ] && [ "$MANCI_TARGET" != "$network" ]; then
      echo "MANCI_TARGET=$MANCI_TARGET does not match the network argument $network; refusing." >&2
      exit 1
    fi
    export MANCI_TARGET="$network"
    ;;
  testnet|localnet)
    if [ -z "${MANCI_TARGET:-}" ]; then
      echo "A $network flag lives in another project: set MANCI_TARGET to that project's target." >&2
      exit 1
    fi
    if [ "$MANCI_TARGET" = "mainnet" ]; then
      echo "The mainnet project only holds mainnet rows; refusing a $network flag there." >&2
      exit 1
    fi
    ;;
  *) usage ;;
esac
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
    echo "Maintenance is on. Writes already in flight can still land: wait about 70 s (5 s flag cache + 60 s slowest route) before starting work." >&2
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

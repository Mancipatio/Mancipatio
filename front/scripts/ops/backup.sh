#!/usr/bin/env bash
# Logical backup of one explicit target (Talas 4.3, D14).
#
#   bash scripts/ops/backup.sh devnet pre-0071
#   MANCI_ALLOW_MAINNET=1 bash scripts/ops/backup.sh mainnet pre-0072            # schema only
#   MANCI_ALLOW_MAINNET=1 bash scripts/ops/backup.sh mainnet weekly --data --prune
#
# Rule: `backup.sh <target> pre-<migration>` before every migration. Before a
# project has its identity row (0070 + scripts/ops/deployment-identity.sql),
# add MANCI_DB_BOOTSTRAP=1.
#
# Same target resolution, identity assertion (scripts/ops/assert-target.sql)
# and credentials as scripts/db.sh. Everything is written under umask 077 to
# ~/Backups/mancipatio/<target>/<target>-<label>-<UTC time>.*, with a .sha256
# manifest (hash, size, file) next to it. Nothing is overwritten.
#
#   devnet (test data):  full custom-format dump of public, storage and
#                        mancipatio_ops, plus a schema-only dump; both checked
#                        with pg_restore --list.
#   mainnet:             schema only by default. --data adds a full dump that
#                        is piped through `age -r <backupAgeRecipient>` (from
#                        targets.json), so no plaintext data reaches the disk.
#                        Supabase PITR stays the primary restore point.
#   --prune              after a successful backup, deletes this target's
#                        dumps older than 30 days.
#
# pg_dump comes from ${MANCI_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin} and
# must be at least the server's major version. pg_dump copies the storage
# schema's metadata, not Storage object bodies (D17). bash 3.2-safe.
set -euo pipefail
cd "$(dirname "$0")/../.."

usage() {
  echo "usage: bash scripts/ops/backup.sh <target> <label> [--data] [--prune]" >&2
  exit 2
}

[ $# -ge 2 ] || usage
target="$1"
label="$2"
shift 2
data=0
prune=0
for arg in ${@+"$@"}; do
  case "$arg" in
    --data) data=1 ;;
    --prune) prune=1 ;;
    *) usage ;;
  esac
done
case "$label" in
  ""|*[!A-Za-z0-9._-]*) echo "The label may only contain letters, digits, '.', '_' and '-'." >&2; exit 2 ;;
esac
if [ "${#label}" -gt 64 ]; then echo "The label must be at most 64 characters." >&2; exit 2; fi
if [ -n "${MANCI_TARGET:-}" ] && [ "$MANCI_TARGET" != "$target" ]; then
  echo "MANCI_TARGET=$MANCI_TARGET does not match the target argument $target; refusing." >&2
  exit 1
fi
export MANCI_TARGET="$target"

# shellcheck source=target-env.sh
. scripts/ops/target-env.sh
manci_resolve_target

pgbin="${MANCI_PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}"
for tool in psql pg_dump pg_restore; do
  [ -x "$pgbin/$tool" ] || manci_die "$pgbin/$tool not found; set MANCI_PG_BIN to a PostgreSQL client at least as new as the server."
done

recipient=""
if [ "$MANCI_NETWORK" = "mainnet" ]; then
  if [ "$data" = 1 ]; then
    recipient="$(node scripts/ops/target.mjs "$target" --age-recipient)" || exit 1
    if [ -z "$recipient" ] || [ "$recipient" = "-" ]; then
      manci_die "A mainnet --data backup needs backupAgeRecipient for $target in scripts/ops/targets.json; plaintext data dumps are refused."
    fi
    command -v age >/dev/null 2>&1 || manci_die "age is not installed (G10); refusing a mainnet --data backup."
  fi
elif [ "$data" = 1 ]; then
  echo "Note: $target is not mainnet; its dump always includes data." >&2
fi

manci_connection_env

# The identity check and the server version in one session.
server_num="$("$pgbin/psql" "${MANCI_PSQL_ARGS[@]}" -q -A -t -f scripts/ops/assert-target.sql \
  -c "select current_setting('server_version_num')")" || manci_die "Target assertion failed; nothing was dumped."
client_version="$("$pgbin/pg_dump" --version | awk '{print $3}')"
client_major="${client_version%%.*}"
case "$server_num" in ''|*[!0-9]*) manci_die "Unexpected server version." ;; esac
case "$client_major" in ''|*[!0-9]*) manci_die "Unexpected pg_dump version." ;; esac
if [ "$client_major" -lt $((server_num / 10000)) ]; then
  manci_die "pg_dump $client_major is older than the server ($((server_num / 10000))); set MANCI_PG_BIN to a newer client."
fi

umask 077
set -o noclobber
dir="$HOME/Backups/mancipatio/$target"
mkdir -p "$dir"
chmod 700 "$dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
base="$dir/$target-$label-$stamp"
dump_args=(-h "$MANCI_HOST" -p "$MANCI_PORT" -U "postgres.$MANCI_REF" -d postgres -w
  -Fc --lock-wait-timeout=15000 -n public -n storage -n mancipatio_ops)
written=()

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi
}

"$pgbin/pg_dump" "${dump_args[@]}" --schema-only -f "$base.schema.dump"
"$pgbin/pg_restore" --list "$base.schema.dump" > /dev/null
written+=("$base.schema.dump")

if [ "$MANCI_NETWORK" != "mainnet" ]; then
  "$pgbin/pg_dump" "${dump_args[@]}" -f "$base.dump"
  "$pgbin/pg_restore" --list "$base.dump" > /dev/null
  written+=("$base.dump")
elif [ "$data" = 1 ]; then
  if ! "$pgbin/pg_dump" "${dump_args[@]}" | age -r "$recipient" > "$base.dump.age"; then
    rm -f "$base.dump.age"
    manci_die "The encrypted data dump failed; the partial file was removed."
  fi
  written+=("$base.dump.age")
fi

for file in "${written[@]}"; do
  printf '%s  %s  %s\n' "$(sha256 "$file")" "$(wc -c < "$file" | tr -d ' ')" "$(basename "$file")" >> "$base.sha256"
done
cat "$base.sha256"
echo "Backup written to $dir" >&2

if [ "$prune" = 1 ]; then
  find "$dir" -maxdepth 1 -type f \( -name "$target-*.dump" -o -name "$target-*.dump.age" -o -name "$target-*.sha256" \) \
    -mtime +30 -print -delete
fi

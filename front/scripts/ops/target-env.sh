# Shared by scripts/db.sh and scripts/ops/backup.sh (sourced, never run).
# bash 3.2-safe. The caller has already cd'd into front/.
#
# manci_resolve_target   MANCI_TARGET → MANCI_NETWORK, MANCI_REF, MANCI_HOST,
#                        MANCI_PORT, MANCI_ORIGIN through scripts/ops/target.mjs
#                        (targets.json; mainnet needs MANCI_ALLOW_MAINNET=1)
# manci_connection_env   exports the libpq settings for that target:
#                        PGPASSFILE (${MANCI_PGPASSFILE:-~/.mancipatio/pgpass},
#                        mode 600), PGSSLMODE=require, PGAPPNAME; clears PG*
#                        variables that could redirect the connection.
#                        Devnet only, until Talas 7 (D10): without a pgpass
#                        file, the password comes from .env.local
#                        SUPABASE_DB_URL, and only if that URL names the same
#                        project. Mainnet never reads .env.local.
# MANCI_PSQL_ARGS        (array) connection + target variables for psql

manci_die() {
  echo "$*" >&2
  exit 1
}

manci_resolve_target() {
  if [ -z "${MANCI_TARGET:-}" ]; then
    manci_die "MANCI_TARGET is required (a target in scripts/ops/targets.json, e.g. devnet). There is no default."
  fi
  case "${MANCI_DB_BOOTSTRAP:-0}" in
    0|1) ;;
    *) manci_die "MANCI_DB_BOOTSTRAP must be 0 or 1" ;;
  esac
  local line
  line=$(node scripts/ops/target.mjs "$MANCI_TARGET") || exit 1
  IFS='|' read -r MANCI_NETWORK MANCI_REF MANCI_HOST MANCI_PORT MANCI_ORIGIN <<EOF
$line
EOF
  local value
  for value in "$MANCI_NETWORK" "$MANCI_REF" "$MANCI_HOST" "$MANCI_PORT"; do
    if [ -z "$value" ] || [ "$value" = "-" ]; then
      manci_die "Target $MANCI_TARGET is incomplete; refusing."
    fi
  done
  if [ "$MANCI_NETWORK" = "mainnet" ] && [ "${MANCI_ALLOW_MAINNET:-}" != "1" ]; then
    manci_die "Target $MANCI_TARGET is a mainnet project: set MANCI_ALLOW_MAINNET=1 for this command."
  fi
  MANCI_ORIGIN="${MANCI_ORIGIN:--}"
}

manci_file_mode() {
  stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"
}

# Devnet transition only (D10): the password from .env.local SUPABASE_DB_URL,
# accepted only when the URL's user and host name this target's project
# (pooler form postgres.<ref>@<poolerHost>, or direct form postgres@db.<ref>.supabase.co).
manci_env_local_password() {
  if [ ! -f .env.local ]; then
    manci_die "No pgpass file at $1 and no .env.local; create the pgpass file (mode 600): $MANCI_HOST:$MANCI_PORT:postgres:postgres.$MANCI_REF:<password>"
  fi
  local raw rest userinfo hostpart user pass host
  raw="$(grep -E '^SUPABASE_DB_URL=' .env.local | head -1 | cut -d= -f2- | tr -d '"' || true)"
  if [ -z "$raw" ]; then
    manci_die "No pgpass file at $1 and no SUPABASE_DB_URL in .env.local."
  fi
  rest="${raw#postgresql://}"
  rest="${rest#postgres://}"
  userinfo="${rest%@*}"
  hostpart="${rest##*@}"
  user="${userinfo%%:*}"
  pass="${userinfo#*:}"
  host="${hostpart%%[:/?]*}"
  if { [ "$user" = "postgres.$MANCI_REF" ] && [ "$host" = "$MANCI_HOST" ]; } \
    || { [ "$user" = "postgres" ] && [ "$host" = "db.$MANCI_REF.supabase.co" ]; }; then
    echo "Using the devnet password from .env.local (transitional; move it to $1)." >&2
    export PGPASSWORD="$pass"
    # Never fall back to another pgpass file for this connection.
    export PGPASSFILE=/dev/null
  else
    manci_die "SUPABASE_DB_URL in .env.local does not belong to target $MANCI_TARGET ($MANCI_REF); refusing."
  fi
}

manci_connection_env() {
  unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS PGPASSWORD PGDATABASE PGUSER PGHOST PGPORT PGTARGETSESSIONATTRS PGSSLMODE
  local passfile="${MANCI_PGPASSFILE:-$HOME/.mancipatio/pgpass}"
  if [ -e "$passfile" ]; then
    if [ ! -f "$passfile" ]; then
      manci_die "$passfile is not a regular file."
    fi
    if [ "$(manci_file_mode "$passfile")" != "600" ]; then
      manci_die "$passfile must be mode 600 (chmod 600 $passfile)."
    fi
    export PGPASSFILE="$passfile"
  elif [ "$MANCI_NETWORK" = "devnet" ]; then
    manci_env_local_password "$passfile"
  else
    manci_die "No pgpass file at $passfile. Create it (mode 600) with: $MANCI_HOST:$MANCI_PORT:postgres:postgres.$MANCI_REF:<password>"
  fi
  export PGSSLMODE=require
  export PGAPPNAME="manci-ops-$MANCI_TARGET"
  export PGCONNECT_TIMEOUT="${PGCONNECT_TIMEOUT:-15}"
  MANCI_PSQL_ARGS=(-X -w -h "$MANCI_HOST" -p "$MANCI_PORT" -U "postgres.$MANCI_REF" -d postgres
    -v ON_ERROR_STOP=1
    -v "target_network=$MANCI_NETWORK" -v "target_ref=$MANCI_REF" -v "target_origin=$MANCI_ORIGIN"
    -v "bootstrap=${MANCI_DB_BOOTSTRAP:-0}")
}

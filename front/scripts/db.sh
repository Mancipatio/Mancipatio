#!/usr/bin/env bash
# psql against ONE explicit Supabase project (Talas 4.3).
#
#   MANCI_TARGET=devnet bash scripts/db.sh -f supabase/migrations/0071_network_guard.sql
#   MANCI_TARGET=devnet bash scripts/db.sh -c "select count(*) from assets;"
#   MANCI_TARGET=devnet bash scripts/db.sh          # interactive psql
#
# MANCI_TARGET is required, with no default. It names a target in
# scripts/ops/targets.json (host, port and user postgres.<ref> come from
# there); a mainnet target also needs MANCI_ALLOW_MAINNET=1.
#
# Before any of your SQL, scripts/ops/assert-target.sql runs in the same
# session and stops psql unless the database's identity row (migration 0070)
# names the same network and project. On a project without the identity yet
# (the steps up to and including scripts/ops/deployment-identity.sql), set
# MANCI_DB_BOOTSTRAP=1 for that one command; it is refused once the row
# exists. Session settings from the assert (manci.target_*) and the psql
# variables target_network, target_ref, target_origin and bootstrap are there
# for your files; an interactive session gets the assert as a separate,
# earlier call, so files that need them must run via -f.
#
# Credentials: a pgpass file, ${MANCI_PGPASSFILE:-~/.mancipatio/pgpass}, mode
# 600, line <poolerHost>:5432:postgres:postgres.<ref>:<password>. Devnet only,
# until Talas 7 (D10): without that file the password is taken from
# .env.local SUPABASE_DB_URL when that URL names the same project. Mainnet
# never reads .env.local. TLS is required (PGSSLMODE=require).
#
# Connection options (-h, -p, -U, -d, --host, --port, --username, --dbname, a
# positional database or user) and the reserved psql variables are refused:
# the target decides where this goes. Long options must be spelled out in
# full; psql would also take an abbreviation (--hos=, --d=, --va=), which
# could otherwise carry a connection option or a reserved variable past
# these checks. bash 3.2-safe.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=ops/target-env.sh
. scripts/ops/target-env.sh

# psql's options (15–17). Short options that take a value; long options that
# take one (as --name=value or as the next argument); long options without a
# required value. A long option db.sh does not know is refused.
VALUE_SHORT="cdfFhLopPRTUv"
VALUE_LONG=" command dbname file field-separator host log-file output port pset record-separator table-attr username set variable "
FLAG_LONG=" csv echo-all echo-errors echo-hidden echo-queries expanded field-separator-zero help html list no-align no-password no-psqlrc no-readline password quiet record-separator-zero single-line single-step single-transaction tuples-only version "
RESERVED_VARS=" ON_ERROR_STOP target_network target_ref target_origin bootstrap "

refuse() {
  manci_die "db.sh: $* (the target decides the connection; see the header of scripts/db.sh)"
}

check_variable() {
  local name="${1%%=*}"
  case "$RESERVED_VARS" in
    *" $name "*) refuse "the psql variable $name is set by db.sh" ;;
  esac
}

interactive=1
expect_value=""
for arg in ${@+"$@"}; do
  if [ -n "$expect_value" ]; then
    [ "$expect_value" = "v" ] && check_variable "$arg"
    expect_value=""
    continue
  fi
  case "$arg" in
    --*)
      # Resolved by exact name only: getopt_long would also accept any
      # unambiguous prefix (--hos, --po, --use, --d, --va, --se).
      name="${arg#--}"
      name="${name%%=*}"
      case "$name" in
        ""|*[!a-z-]*) refuse "\"$arg\" is not a psql option db.sh accepts" ;;
        host|port|username|dbname) refuse "--$name is not allowed" ;;
      esac
      case "$VALUE_LONG" in
        *" $name "*)
          case "$name" in command|file) interactive=0 ;; esac
          if [ "$arg" = "--$name" ]; then
            case "$name" in set|variable) expect_value="v" ;; *) expect_value="x" ;; esac
          else
            case "$name" in set|variable) check_variable "${arg#*=}" ;; esac
          fi ;;
        *)
          case "$FLAG_LONG" in
            *" $name "*) ;;
            *) refuse "--$name is not a psql option db.sh accepts (spell long options out in full; psql would read an abbreviation such as --hos as --host)" ;;
          esac ;;
      esac ;;
    -?*)
      i=1
      while [ "$i" -lt "${#arg}" ]; do
        letter="${arg:$i:1}"
        case "$letter" in
          h|p|U|d) refuse "-$letter is not allowed" ;;
          c|f) interactive=0 ;;
        esac
        case "$VALUE_SHORT" in
          *"$letter"*)
            rest="${arg:$((i + 1))}"
            if [ -z "$rest" ]; then
              expect_value="$letter"
            elif [ "$letter" = "v" ]; then
              check_variable "$rest"
            fi
            break ;;
        esac
        i=$((i + 1))
      done ;;
    *) refuse "positional argument \"$arg\" (a database or user name) is not allowed" ;;
  esac
done
if [ -n "$expect_value" ]; then
  refuse "an option is missing its value"
fi

manci_resolve_target
manci_connection_env

if [ "$interactive" = 1 ]; then
  psql "${MANCI_PSQL_ARGS[@]}" -q -f scripts/ops/assert-target.sql
  exec psql "${MANCI_PSQL_ARGS[@]}" ${@+"$@"}
fi
exec psql "${MANCI_PSQL_ARGS[@]}" -f scripts/ops/assert-target.sql "$@"

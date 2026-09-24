#!/usr/bin/env bash
# Supabase CLI against ONE explicit target (Talas 4.3). Only these commands:
#
#   bash scripts/ops/supabase.sh <target> functions deploy helius-webhook [--use-api]
#   bash scripts/ops/supabase.sh <target> secrets list
#   bash scripts/ops/supabase.sh <target> secrets set --env-file <file>
#   bash scripts/ops/supabase.sh <target> secrets unset NAME [NAME...]
#
# The project comes only from scripts/ops/targets.json: this wrapper appends
# --project-ref <ref> and refuses a caller-supplied --project-ref or --db-url,
# any `db` command (migrations go through scripts/db.sh), and secret values
# on the command line (NAME=VALUE ends up in shell history; use an env file,
# mode 600). A mainnet target needs MANCI_ALLOW_MAINNET=1.
#
# `--use-api` bundles the function on Supabase's side instead of in Docker
# (for a machine without a running Docker); it does not change the project.
#
# Delete front/supabase/.temp/ (project-ref, linked-project.json,
# pooler-url) before the first use: a linked project must never decide where
# a command goes. The wrapper refuses while those files exist.
# `verify_jwt = false` for helius-webhook stays in supabase/config.toml.
# bash 3.2-safe.
set -euo pipefail
cd "$(dirname "$0")/../.."

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}
die() {
  echo "$*" >&2
  exit 1
}

[ $# -ge 2 ] || usage
target="$1"
shift
if [ -n "${MANCI_TARGET:-}" ] && [ "$MANCI_TARGET" != "$target" ]; then
  die "MANCI_TARGET=$MANCI_TARGET does not match the target argument $target; refusing."
fi

for arg in "$@"; do
  case "$arg" in
    --project-ref|--project-ref=*|--db-url|--db-url=*|--linked|--local)
      die "$arg is not allowed: the target decides the project." ;;
  esac
done
if [ "$1" = "db" ]; then
  die "supabase db commands are not allowed here; apply migrations with scripts/db.sh."
fi

for leftover in supabase/.temp/project-ref supabase/.temp/linked-project.json supabase/.temp/pooler-url; do
  if [ -e "$leftover" ]; then
    die "Delete front/supabase/.temp/ first: $leftover links a project, and only the target may choose one."
  fi
done

line="$(node scripts/ops/target.mjs "$target")" || exit 1
IFS='|' read -r network ref _host _port _origin <<EOF
$line
EOF
if [ -z "$ref" ] || [ "$ref" = "-" ] || [ -z "$network" ]; then
  die "Target $target has no project ref; refusing."
fi

name_ok() {
  case "$1" in
    ""|[!A-Z]*|*[!A-Z0-9_]*) return 1 ;;
  esac
  return 0
}

case "$1 ${2:-}" in
  "functions deploy")
    { [ $# -eq 3 ] || { [ $# -eq 4 ] && [ "$4" = "--use-api" ]; }; } && [ "$3" = "helius-webhook" ] \
      || die "Only: functions deploy helius-webhook [--use-api]"
    if [ $# -eq 4 ]; then
      set -- functions deploy helius-webhook --use-api
    else
      set -- functions deploy helius-webhook
    fi
    ;;
  "secrets list")
    [ $# -eq 2 ] || die "Only: secrets list"
    ;;
  "secrets set")
    [ $# -eq 4 ] && [ "$3" = "--env-file" ] || die "Only: secrets set --env-file <file> (NAME=VALUE arguments are refused)"
    envfile="$4"
    [ -f "$envfile" ] || die "$envfile is not a file."
    mode="$(stat -c %a "$envfile" 2>/dev/null || stat -f %Lp "$envfile")"
    [ "$mode" = "600" ] || die "$envfile must be mode 600 (it holds secrets)."
    ;;
  "secrets unset")
    [ $# -ge 3 ] || die "Only: secrets unset NAME [NAME...]"
    for name in "${@:3}"; do
      name_ok "$name" || die "Invalid secret name: $name"
    done
    ;;
  *) usage ;;
esac

echo "supabase $1 $2 → target $target ($network, $ref)" >&2
exec supabase "$@" --project-ref "$ref"

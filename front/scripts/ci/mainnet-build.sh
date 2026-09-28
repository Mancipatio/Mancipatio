#!/usr/bin/env bash
# The mainnet variant of the front, built in CI without a single secret
# (front-app-18; .github/workflows/front-ci.yml "next build (mainnet,
# placeholder env)"). Run from front/:
#
#   bash scripts/ci/mainnet-build.sh
#
# A mainnet build is guarded by next.config.ts: the legal copy, the mainnet
# Supabase project and publishable key, the KYC registry pin, the RPC and the
# operations requirements, the feature-flag spellings. This proves both sides:
#   1. the guards REFUSE: a bare mainnet build, and the placeholder set with
#      one setting missing per guard (each fails while loading the config,
#      in seconds);
#   2. the guards PASS and the mainnet branches COMPILE: a full `next build`
#      with the placeholder set.
# Placeholders only: reserved .invalid hosts (the browser and server RPC on
# different hosts: the guard refuses a shared endpoint or key), placeholder
# Turnstile keys (never Cloudflare's published test keys: the guard refuses
# them, and the server would answer 503 with a test secret in production), the
# role-map example's placeholder registry and a placeholder Supabase ref. While no mainnet Supabase project is recorded
# (scripts/ops/targets.json, SUPABASE_PROJECT_REFS in next.config.ts), step 2
# writes the placeholder ref into next.config.ts of this throwaway checkout
# and restores the file on exit: the guard itself has no override.
# A guard added later needs its placeholder here (PLACEHOLDERS) and, ideally,
# its own refusal case.
set -euo pipefail

[ -f next.config.ts ] || { echo "Run from front/" >&2; exit 2; }
export NEXT_TELEMETRY_DISABLED=1
LOG="$(mktemp)"
BACKUP="$(mktemp)"
cp next.config.ts "$BACKUP"
trap 'cp "$BACKUP" next.config.ts; rm -f "$BACKUP" "$LOG"' EXIT

RECORDED_REF="$(node -p "require('./scripts/ops/targets.json').mainnet.projectRef ?? ''")"
REF="${RECORDED_REF:-cimainnetplaceholder}"

PLACEHOLDERS=(
  NEXT_PUBLIC_NETWORK=mainnet
  MAINNET_LEGAL_COPY_APPROVED=true
  "NEXT_PUBLIC_SUPABASE_URL=https://${REF}.supabase.co"
  NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_ci_placeholder_not_a_key
  NEXT_PUBLIC_KYC_REGISTRY=GEn28vq5EiMUKqoGfHa6Ai3C1EtHuTvxKk8X5HbH56Es
  NEXT_PUBLIC_SOLANA_RPC_URL=https://rpc.mainnet-ci.invalid
  NEXT_PUBLIC_SOLANA_WS_URL=wss://rpc.mainnet-ci.invalid
  HELIUS_MAINNET_RPC=https://server-rpc.mainnet-ci.invalid
  SENTRY_DSN=https://ciplaceholder@ci-placeholder.invalid.de.sentry.io/0
  HEALTH_TOKEN=ci-placeholder-health-token-not-a-secret-0000
  TURNSTILE_SECRET_KEY=0x4AAAAAAA-ci-placeholder-not-a-secret
  NEXT_PUBLIC_TURNSTILE_SITE_KEY=0x4AAAAAAA-ci-placeholder-site-key
  ALERT_WEBHOOK_URL=https://alerts.mainnet-ci.invalid/hook
  SESSION_SECRET=ci-placeholder-session-secret-not-a-secret-0000
  NEXT_PUBLIC_SITE_URL=https://mainnet-ci.invalid
)

# expect_refusal <message pattern> [NAME=value ...]: the build must fail with it.
expect_refusal() {
  local pattern="$1"
  shift
  if env "$@" npx next build >"$LOG" 2>&1; then
    echo "::error::a mainnet build that should be refused passed ($pattern)"
    exit 1
  fi
  if ! grep -qE -- "$pattern" "$LOG"; then
    echo "::error::the mainnet build failed, but not with: $pattern"
    tail -40 "$LOG"
    exit 1
  fi
  echo "refused as expected: $pattern"
}

echo "== 1. the guards refuse"
expect_refusal "Refusing a mainnet build: the Terms of Service" NEXT_PUBLIC_NETWORK=mainnet
if [ -z "$RECORDED_REF" ]; then
  expect_refusal "no mainnet Supabase project is recorded" "${PLACEHOLDERS[@]}"
  grep -q '^  mainnet: null,$' next.config.ts || { echo "::error::SUPABASE_PROJECT_REFS.mainnet line not found"; exit 1; }
  sed -i.bak "s/^  mainnet: null,\$/  mainnet: \"${REF}\",/" next.config.ts && rm -f next.config.ts.bak
fi
expect_refusal "NEXT_PUBLIC_SUPABASE_ANON_KEY must be a publishable key" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_SUPABASE_ANON_KEY=
expect_refusal "NEXT_PUBLIC_KYC_REGISTRY is not set" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_KYC_REGISTRY=
expect_refusal "NEXT_PUBLIC_SOLANA_RPC_URL is not set" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_SOLANA_RPC_URL=
expect_refusal "NEXT_PUBLIC_SOLANA_RPC_URL must be a https:// URL of a paid RPC provider" \
  "${PLACEHOLDERS[@]}" NEXT_PUBLIC_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
expect_refusal "carries the server RPC credential" \
  "${PLACEHOLDERS[@]}" NEXT_PUBLIC_SOLANA_RPC_URL=https://server-rpc.mainnet-ci.invalid
# Mainnet sniffed from the RPC URL, NEXT_PUBLIC_NETWORK unset (the Supabase URL
# unset too, so the non-mainnet Supabase guard does not answer first).
expect_refusal "would run as mainnet .* without NEXT_PUBLIC_NETWORK" \
  "${PLACEHOLDERS[@]}" NEXT_PUBLIC_NETWORK= MAINNET_LEGAL_COPY_APPROVED= NEXT_PUBLIC_SUPABASE_URL=
expect_refusal "\[sentry\]" "${PLACEHOLDERS[@]}" SENTRY_DSN=
expect_refusal "\[sentry\]" "${PLACEHOLDERS[@]}" SENTRY_DSN=https://ciplaceholder@ci-placeholder.invalid.de.sentry.io/
expect_refusal "\[turnstile\]" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_TURNSTILE_SITE_KEY= TURNSTILE_SECRET_KEY=
expect_refusal "\[turnstile\]" "${PLACEHOLDERS[@]}" TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
expect_refusal "is not a flag value" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_FEATURE_ISSUER_ROTATION=ture

echo "== 2. the guards pass and the mainnet variant compiles"
env "${PLACEHOLDERS[@]}" npx next build

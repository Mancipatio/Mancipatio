#!/usr/bin/env bash
# The mainnet variant of the front, built in CI without a single secret
# (front-app-18; .github/workflows/front-ci.yml "next build (mainnet,
# placeholder env)"). Run from front/:
#
#   bash scripts/ci/mainnet-build.sh
#
# A mainnet build is guarded by next.config.ts: MAINNET_LEGAL_COPY_APPROVED,
# the mainnet Supabase project and publishable key, the KYC registry pin, the
# operator and legal slots (8.1, lib/legal/readiness.ts), the RPC and the
# operations requirements, the feature-flag spellings (8.4). This proves both
# sides:
#   1. the guards REFUSE: a bare mainnet build, and the placeholder set with
#      one setting missing per guard (each fails while loading the config,
#      in seconds);
#   2. the guards PASS and the mainnet branches COMPILE: the config loads with
#      the licence waiver, and a full `next build` runs with the licence.
# Placeholders only: reserved .invalid hosts (the browser and server RPC on
# different hosts: the guard refuses a shared endpoint or key), placeholder
# Turnstile keys (never Cloudflare's published test keys: the guard refuses
# them, and the server would answer 503 with a test secret in production), the
# role-map example's placeholder registry and a placeholder Supabase ref.
#
# Two guards read committed files rather than the environment, and neither
# has an override, so this throwaway checkout is edited instead and every
# edited file is restored on exit (trap):
#   - while no mainnet Supabase project is recorded (scripts/ops/targets.json,
#     SUPABASE_PROJECT_REFS in next.config.ts), the placeholder ref is written
#     into next.config.ts;
#   - the operator and legal slots (lib/legal/operator.ts, mainnet-copy.ts,
#     risk-warning.ts) get a CI FIXTURE (write_legal_fixture below): an
#     obviously invented company ("CI Fixture d.o.o.", .invalid contacts,
#     8-digit MB and 9-digit PIB with valid check digits), a licence or none,
#     one-clause Terms and Privacy Policy, a one-line acceptance summary and
#     the risk warning marked "counsel". It never leaves this checkout; the
#     committed slots stay as they are (null until counsel delivers), and
#     tests/legal-slots.test.ts checks those. The fixture avoids the words the
#     guard treats as drafts (placeholder, TODO, TBD, devnet, ...).
# A guard added later needs its placeholder here (PLACEHOLDERS, or the
# fixture) and, ideally, its own refusal case.
set -euo pipefail

[ -f next.config.ts ] || { echo "Run from front/" >&2; exit 2; }
export NEXT_TELEMETRY_DISABLED=1

WORK="$(mktemp -d)"
LOG="$WORK/build.log"
EDITED=(next.config.ts lib/legal/operator.ts lib/legal/mainnet-copy.ts lib/legal/risk-warning.ts)
for file in "${EDITED[@]}"; do
  mkdir -p "$WORK/orig/$(dirname "$file")"
  cp "$file" "$WORK/orig/$file"
done
restore() {
  for file in "${EDITED[@]}"; do cp "$WORK/orig/$file" "$file"; done
  rm -rf "$WORK"
}
trap restore EXIT
trap 'exit 130' INT TERM

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
# The licence waiver (MAINNET_LICENSE_NOT_REQUIRED) is not a placeholder: the
# fixture's licence and the waiver are exclusive, so each case sets it.

# write_legal_fixture <variant>: the legal slot files as committed, plus the
# CI fixture. Variants: licence (complete, with a licence), no-licence
# (complete, no licence: needs the waiver), and one defect each for the
# refusal cases: incomplete-operator, devnet-copy, draft-warning.
cat >"$WORK/legal-fixture.cjs" <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const [orig, variant] = process.argv.slice(2);
const VARIANTS = ["licence", "no-licence", "incomplete-operator", "devnet-copy", "draft-warning"];
if (!VARIANTS.includes(variant)) throw new Error(`unknown legal fixture variant: ${variant}`);
const HEADER = "// ── CI FIXTURE (scripts/ci/mainnet-build.sh): this checkout only, restored on exit ──";
const json = (value) => JSON.stringify(value, null, 2);
const append = (file, code) =>
  fs.writeFileSync(file, `${fs.readFileSync(path.join(orig, file), "utf8")}\n${HEADER}\n${code}\n`);

const operator = {
  legalName: "CI Fixture d.o.o. Beograd",
  shortName: "CI Fixture d.o.o.",
  registeredOffice: "Fixture Street 1, 11000 Belgrade, Serbia",
  registrationNumber: "90000005",
  taxId: variant === "incomplete-operator" ? null : "100000008",
  register: { name: "CI fixture register (not a real entry)", url: null },
  licence: variant === "no-licence" ? null : {
    authority: "CI Fixture Authority (not a real licence)",
    decisionNumber: "CI-1/2026",
    decisionDate: "2026-01-01",
    services: ["CI fixture service"],
    registerUrl: null,
  },
  contacts: {
    support: null,
    legal: "legal@mainnet-ci.invalid",
    privacy: "privacy@mainnet-ci.invalid",
    security: "security@mainnet-ci.invalid",
    dpo: null,
  },
  governingLaw: "the law of the Republic of Serbia (CI fixture)",
  disputeResolution: "the competent court in Belgrade (CI fixture)",
  pilotNotice: null,
};
append("lib/legal/operator.ts",
  `const CI_FIXTURE_OPERATOR: Operator = { ...OPERATORS.mainnet, ...${json(operator)} };\n` +
  "Object.assign(OPERATORS.mainnet, CI_FIXTURE_OPERATOR);");

const doc = (title, text) => ({
  version: "2026-01-01",
  lastUpdated: "2026-01-01",
  clauses: [{ title: `1. ${title}`, blocks: [{ kind: "paragraph", text }] }],
});
const terms = doc("CI fixture",
  variant === "devnet-copy"
    ? "The current release runs on Solana devnet."
    : "This text exists only in the CI mainnet build. It is not counsel's text and is never deployed.");
const privacy = doc("CI fixture", "This text exists only in the CI mainnet build. It is not counsel's text and is never deployed.");
fs.writeFileSync("lib/legal/mainnet-copy.ts", [
  HEADER,
  'import type { LegalDocument } from "./document";',
  `export const MAINNET_TERMS: LegalDocument | null = ${json(terms)};`,
  `export const MAINNET_PRIVACY: LegalDocument | null = ${json(privacy)};`,
  `export const MAINNET_TOS_GATE_POINTS: string[] | null = ${json(["CI fixture: you accept the Terms of Service."])};`,
  "",
].join("\n"));

append("lib/legal/risk-warning.ts",
  `const CI_FIXTURE_RISK_WARNING: RiskWarning = { ...PURCHASE_RISK_WARNING, status: ${json(variant === "draft-warning" ? "draft" : "counsel")} };\n` +
  "Object.assign(PURCHASE_RISK_WARNING, CI_FIXTURE_RISK_WARNING);");
JS
write_legal_fixture() {
  node "$WORK/legal-fixture.cjs" "$WORK/orig" "$1"
}

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

# expect_config_pass <label> [NAME=value ...]: every guard passes. Loads the
# config the way `next build` does first (next/dist/server/config), without
# building: the full build below covers compilation.
expect_config_pass() {
  local label="$1"
  shift
  if ! env "$@" node -e "require('next/dist/server/config').default('phase-production-build', process.cwd())
    .then(() => process.exit(0), (error) => { console.error(error?.message ?? error); process.exit(1); })" >"$LOG" 2>&1; then
    echo "::error::the mainnet guards should pass ($label)"
    tail -40 "$LOG"
    exit 1
  fi
  echo "passed as expected: $label"
}

echo "== 1. the guards refuse"
expect_refusal "set MAINNET_LEGAL_COPY_APPROVED=true only after counsel" NEXT_PUBLIC_NETWORK=mainnet
if [ -z "$RECORDED_REF" ]; then
  expect_refusal "no mainnet Supabase project is recorded" "${PLACEHOLDERS[@]}"
  grep -q '^  mainnet: null,$' next.config.ts || { echo "::error::SUPABASE_PROJECT_REFS.mainnet line not found"; exit 1; }
  sed -i.bak "s/^  mainnet: null,\$/  mainnet: \"${REF}\",/" next.config.ts && rm -f next.config.ts.bak
fi
expect_refusal "NEXT_PUBLIC_SUPABASE_ANON_KEY must be a publishable key" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_SUPABASE_ANON_KEY=
expect_refusal "NEXT_PUBLIC_KYC_REGISTRY is not set" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_KYC_REGISTRY=

# 8.1: the operator and legal slots. As committed, while counsel's Terms are
# not in the slot, the build is refused; then the fixture, one defect at a time.
if grep -q '^export const MAINNET_TERMS: LegalDocument | null = null;$' lib/legal/mainnet-copy.ts; then
  expect_refusal "the operator and legal slots are not complete" "${PLACEHOLDERS[@]}"
fi
write_legal_fixture incomplete-operator
expect_refusal "operator\.taxId \(PIB\) is not set" "${PLACEHOLDERS[@]}"
write_legal_fixture no-licence
expect_refusal "operator\.licence is not recorded" "${PLACEHOLDERS[@]}"
expect_config_pass "no licence, MAINNET_LICENSE_NOT_REQUIRED=true" "${PLACEHOLDERS[@]}" MAINNET_LICENSE_NOT_REQUIRED=true
write_legal_fixture licence
expect_refusal "operator\.licence is recorded and MAINNET_LICENSE_NOT_REQUIRED=true says none is needed" \
  "${PLACEHOLDERS[@]}" MAINNET_LICENSE_NOT_REQUIRED=true
write_legal_fixture devnet-copy
expect_refusal "Terms of Service: contains wording that must not reach mainnet \(devnet\)" "${PLACEHOLDERS[@]}"
write_legal_fixture draft-warning
expect_refusal "Purchase risk warning: still engineering's draft" "${PLACEHOLDERS[@]}"
# The complete fixture with its licence from here on.
write_legal_fixture licence

# 8.4: RPC, operations, feature flags.
expect_refusal "NEXT_PUBLIC_SOLANA_RPC_URL is not set" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_SOLANA_RPC_URL=
expect_refusal "NEXT_PUBLIC_SOLANA_RPC_URL must be a https:// URL of a paid RPC provider" \
  "${PLACEHOLDERS[@]}" NEXT_PUBLIC_SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
expect_refusal "carries the server RPC credential" \
  "${PLACEHOLDERS[@]}" NEXT_PUBLIC_SOLANA_RPC_URL=https://server-rpc.mainnet-ci.invalid
# Mainnet sniffed from the RPC URL, NEXT_PUBLIC_NETWORK unset: assertBuildNetwork,
# the first guard, refuses it.
expect_refusal "would run as mainnet .* without NEXT_PUBLIC_NETWORK" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_NETWORK=
expect_refusal "\[sentry\]" "${PLACEHOLDERS[@]}" SENTRY_DSN=
expect_refusal "\[sentry\]" "${PLACEHOLDERS[@]}" SENTRY_DSN=https://ciplaceholder@ci-placeholder.invalid.de.sentry.io/
expect_refusal "\[turnstile\]" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_TURNSTILE_SITE_KEY= TURNSTILE_SECRET_KEY=
expect_refusal "\[turnstile\]" "${PLACEHOLDERS[@]}" TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA
expect_refusal "is not a flag value" "${PLACEHOLDERS[@]}" NEXT_PUBLIC_FEATURE_ISSUER_ROTATION=ture

echo "== 2. the guards pass and the mainnet variant compiles"
env "${PLACEHOLDERS[@]}" npx next build

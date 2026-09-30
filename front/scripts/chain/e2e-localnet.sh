#!/usr/bin/env bash
# Local validator for `npm run chain:e2e` on localnet (Talas 6.3, design-6.3 §C).
#
#   bash scripts/chain/e2e-localnet.sh start        # fresh ledger, release .so, prints the CHAIN_* lines
#   bash scripts/chain/e2e-localnet.sh stop
#   bash scripts/chain/e2e-localnet.sh status
#   bash scripts/chain/e2e-localnet.sh warp <slot>  # restart this validator on its ledger at <slot>
#
# The programs are the Release artefacts of E2E_RELEASE_DIR (required by
# start; checked against its SHA256SUMS) loaded as upgradeable programs whose
# upgrade authority is a local deployer key (<E2E_DIR>/keys/deployer.json,
# 600, also the faucet --mint). The localnet matrix is v1.0.0-rc's (G1 1.13 /
# 1.14 and G4–G8 expect its codes: 6142–6155), so start refuses a registry
# .so without v1.0.0-rc's freeze_issuer_proceeds; point E2E_RELEASE_DIR at a
# v1.0.0-rc artefact (e.g. the verifiable build deployed to devnet,
# docs/mainnet-readiness/deploy-8.3b/artifact-M), not release-v0.0.0-rc.1. Ports stay
# clear of a default validator (8899/8900, 18000-18040, 19900): by default
# RPC 8999, WS 9000 (always RPC + 1), gossip 18100, dynamic 18101-18140,
# faucet 19910; E2E_RPC_PORT, E2E_GOSSIP_PORT, E2E_DYNAMIC_PORTS and
# E2E_FAUCET_PORT move them (parallel runs); start checks every one of them,
# the dynamic range included, and records them with E2E_SCRATCH in
# <E2E_DIR>/validator.txt, the env file chain:e2e sources. A faucet on RPC + 1 takes the
# WS port: the validator then logs that its pubsub service could not bind,
# which chain:e2e does not use (HTTP only). The ledger lives in E2E_SCRATCH
# (default $TMPDIR/manci-e2e-6.3), never in the repository.
# E2E_CLONE_FEATURES=0 skips the mainnet feature-set clone (on by default,
# as in the 6.1 rehearsal; a read-only fetch by the validator at start).
# `stop` kills only a pid whose command is solana-test-validator on this
# ledger (a stale pid file is just removed) and waits up to 15 s for it.
# `warp` restarts only the validator this run's validator.txt records: it
# refuses (nothing stopped) unless this environment's E2E_SCRATCH, ports and
# CHAIN_RPC_URL / CHAIN_GENESIS_HASH (when set) are the recorded ones, the pid
# file's process is solana-test-validator on this ledger with exactly those
# ports and holds the RPC port, the RPC's genesis hash is the recorded one,
# and no other process holds a port the relaunch binds.
#
# Time (design-6.3 §D; the 7-day recoveries, the 48 h grants, the 30-day
# KYC grace): a test validator has no runtime clock control, only
# `--warp-slot` at a (re)start. `warp <slot>` first waits for a full
# snapshot at or past the finalized slot (the restart loads the newest
# snapshot and warps from it without replaying the blockstore after it, so
# a finalized transaction past it would be lost), stops THIS validator (the
# same ours() check as stop), restarts it on the same ledger with only the
# ports and `--warp-slot <slot>` (the genesis flags are ignored on an
# existing ledger anyway) and returns once a full snapshot at least 300
# slots past the warp exists: a restart from the warp's own snapshot fails
# (its leader is the default key), and one whose status cache still holds
# pre-warp slots fails the SlotHistory check. Each of the two snapshot
# waits is bounded by E2E_WARP_SETTLE_TIMEOUT_S (default 900 s); chain:e2e
# derives its own limit for this script from the same value (warp.ts
# warpTimeoutMs). Which slot gives which clock (a reset into a later epoch,
# then a jump from that epoch's first slot) is scripts/chain/lib/e2e/warp.ts's:
# measured on Agave 4.2.2, a jump lands at about 0.1875 s of clock per slot
# counted from the epoch's first slot, so a jump of D seconds needs about
# D / 0.1875 slots inside one epoch. Genesis therefore uses a long epoch,
# E2E_SLOTS_PER_EPOCH (default 20,000,000 slots: up to about 43 days per
# jump, which is why G5's two payout months take two jumps; ~1.2 GB RSS).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(git rev-parse --show-toplevel)"
E2E_DIR="${E2E_DIR:-$ROOT/docs/mainnet-readiness/e2e-6.3/localnet}"
SCRATCH="${E2E_SCRATCH:-${TMPDIR:-/tmp}/manci-e2e-6.3}"
RELEASE="${E2E_RELEASE_DIR:-}"
number() {
  case "$2" in '' | *[!0-9]*) echo "$1 must be a number" >&2; exit 2 ;; esac
}
RPC_PORT="${E2E_RPC_PORT:-8999}"
number E2E_RPC_PORT "$RPC_PORT"
WS_PORT=$((RPC_PORT + 1))
GOSSIP_PORT="${E2E_GOSSIP_PORT:-18100}"
number E2E_GOSSIP_PORT "$GOSSIP_PORT"
DYNAMIC_PORTS="${E2E_DYNAMIC_PORTS:-18101-18140}"
if ! [[ "$DYNAMIC_PORTS" =~ ^[0-9]+-[0-9]+$ ]]; then echo "E2E_DYNAMIC_PORTS must be MIN-MAX" >&2; exit 2; fi
FAUCET_PORT="${E2E_FAUCET_PORT:-19910}"
number E2E_FAUCET_PORT "$FAUCET_PORT"
SLOTS_PER_EPOCH="${E2E_SLOTS_PER_EPOCH:-20000000}"
number E2E_SLOTS_PER_EPOCH "$SLOTS_PER_EPOCH"
SETTLE_TIMEOUT_S="${E2E_WARP_SETTLE_TIMEOUT_S:-900}"
number E2E_WARP_SETTLE_TIMEOUT_S "$SETTLE_TIMEOUT_S"
URL="http://127.0.0.1:${RPC_PORT}"
REGISTRY=FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS
HOOK=GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy
PID_FILE="$SCRATCH/validator.pid"
LEDGER="$SCRATCH/ledger"
LOG="$SCRATCH/validator.log"
# The run's env file: written by start, the identity warp checks.
ENV_FILE="$E2E_DIR/validator.txt"
# A warp must be past this many slots before the next restart (see above).
WARP_SETTLE_SLOTS=300

# Ours = alive AND its command line is this script's validator on this
# ledger: a stale pid file must never make us kill a reused pid.
ours() {
  [ -f "$PID_FILE" ] || return 1
  local pid cmd
  pid="$(cat "$PID_FILE")"
  case "$pid" in '' | *[!0-9]*) return 1 ;; esac
  cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
  case "$cmd" in *solana-test-validator*"$LEDGER"*) return 0 ;; *) return 1 ;; esac
}

# E2E_DIR inside the repository: the key and the env file must be git-ignored.
assert_ignored() {
  local abs rel path
  abs="$(cd "$E2E_DIR" && pwd -P)"
  case "$abs/" in
    "$ROOT"/*) rel="${abs#"$ROOT"}"; rel="${rel#/}" ;;
    *) return 0 ;;
  esac
  for path in "keys/" "keys/deployer.json" "validator.txt" "state.json" "summary.json"; do
    if ! git -C "$ROOT" check-ignore -q -- "${rel:+$rel/}$path"; then
      echo "E2E_DIR is inside the repository and $path there is not git-ignored; refusing to write the key"
      exit 1
    fi
  done
}

# The pids holding a port the validator binds: TCP listeners on RPC, WS
# (RPC + 1), gossip and faucet, the gossip UDP socket, and any TCP listener
# or UDP socket in the dynamic range.
port_holders() {
  {
    for port in $RPC_PORT $WS_PORT $GOSSIP_PORT $FAUCET_PORT; do
      lsof -nP -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
    done
    lsof -nP -t -iUDP:"$GOSSIP_PORT" 2>/dev/null || true
    lsof -nP -t -iTCP:"$DYNAMIC_PORTS" -sTCP:LISTEN 2>/dev/null || true
    lsof -nP -t -iUDP:"$DYNAMIC_PORTS" 2>/dev/null || true
  } | sort -u
}

# Every port the validator binds is free, or held only by pid $1 (the
# validator a warp is about to restart on the same ports).
ports_free() {
  local holders
  holders="$(port_holders | grep -vx "${1:-}" || true)"
  if [ -n "$holders" ]; then
    echo "ports $RPC_PORT, $WS_PORT, $GOSSIP_PORT, $FAUCET_PORT or $DYNAMIC_PORTS are held by pid(s) $(printf '%s ' $holders)"
    exit 1
  fi
}

# A value start recorded in the env file ("" when missing).
recorded() {
  sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | tail -1
}

# The directory's physical path (a missing one as given).
physical() {
  (cd "$1" 2>/dev/null && pwd -P) || printf '%s\n' "$1"
}

# Refuses a warp whose environment is not the run start recorded: the
# scratch (ledger, pid file), the ports the relaunch binds and, when the
# caller passes them, the RPC URL and genesis it runs against.
same_run() {
  local pair name here there
  [ -f "$ENV_FILE" ] || { echo "no $ENV_FILE: warp restarts only a validator start recorded there (same E2E_DIR)"; exit 1; }
  for pair in "E2E_SCRATCH=$(physical "$SCRATCH")" "E2E_RPC_PORT=$RPC_PORT" "E2E_GOSSIP_PORT=$GOSSIP_PORT" \
    "E2E_DYNAMIC_PORTS=$DYNAMIC_PORTS" "E2E_FAUCET_PORT=$FAUCET_PORT" "CHAIN_RPC_URL=$URL" \
    "CHAIN_RPC_URL=${CHAIN_RPC_URL:-$URL}" "CHAIN_GENESIS_HASH=${CHAIN_GENESIS_HASH:-$(recorded CHAIN_GENESIS_HASH)}"; do
    name="${pair%%=*}"
    here="${pair#*=}"
    there="$(recorded "$name")"
    if [ "$here" != "$there" ]; then
      echo "$name is '$here' here but '$there' in $ENV_FILE: not this run's validator (source that file); nothing stopped"
      exit 1
    fi
  done
}

# The pid serves this run: solana-test-validator on this ledger with exactly
# the recorded ports, holding the RPC port, whose RPC answers with the
# recorded genesis hash.
serves() {
  local pid="$1" cmd flag
  cmd=" $(ps -ww -o command= -p "$pid" 2>/dev/null || true) "
  for flag in "--ledger $LEDGER" "--rpc-port $RPC_PORT" "--gossip-port $GOSSIP_PORT" \
    "--dynamic-port-range $DYNAMIC_PORTS" "--faucet-port $FAUCET_PORT"; do
    case "$cmd" in *" $flag "*) ;; *) echo "pid $pid does not run with $flag"; return 1 ;; esac
  done
  if ! lsof -nP -a -p "$pid" -iTCP:"$RPC_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "pid $pid does not hold the RPC port $RPC_PORT"
    return 1
  fi
  if [ "$(solana genesis-hash -u "$URL" 2>/dev/null || true)" != "$(recorded CHAIN_GENESIS_HASH)" ]; then
    echo "$URL does not answer with the recorded genesis $(recorded CHAIN_GENESIS_HASH)"
    return 1
  fi
}

# Starts the validator in the background with the ports and the given extra
# flags, records its pid and waits up to 90 s for the RPC.
launch() {
  nohup solana-test-validator --ledger "$LEDGER" --bind-address 127.0.0.1 \
    --rpc-port "$RPC_PORT" --gossip-port "$GOSSIP_PORT" --dynamic-port-range "$DYNAMIC_PORTS" \
    --faucet-port "$FAUCET_PORT" "$@" >>"$LOG" 2>&1 &
  echo $! >"$PID_FILE"
  for _ in $(seq 1 90); do
    if solana cluster-version -u "$URL" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  solana cluster-version -u "$URL" >/dev/null || { echo "validator did not start; see $LOG"; exit 1; }
}

halt() {
  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid"
  for _ in $(seq 1 15); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  if kill -0 "$pid" 2>/dev/null; then echo "pid $pid did not exit within 15 s; pid file kept"; exit 1; fi
  rm -f "$PID_FILE"
}

latest_snapshot() {
  ls "$LEDGER" 2>/dev/null | sed -nE 's/^snapshot-([0-9]+)-.*\.tar\.zst$/\1/p' | sort -n | tail -1
}

# The newest full snapshot both as an archive and as the bank snapshot
# directory a restart loads (the older of the two), or 0.
settled_snapshot() {
  local archive dir
  archive="$(latest_snapshot)"
  dir="$(ls "$LEDGER/snapshots" 2>/dev/null | sed -nE '/^[0-9]+$/p' | sort -n | tail -1)"
  archive="${archive:-0}"
  dir="${dir:-0}"
  if [ "$archive" -lt "$dir" ]; then echo "$archive"; else echo "$dir"; fi
}

# Waits until this validator has a full snapshot at or past slot $1.
wait_snapshot() {
  local waited=0
  until [ "$(settled_snapshot)" -ge "$1" ]; do
    if ! ours; then echo "the validator exited ($2); see $LOG" >&2; exit 1; fi
    if [ "$waited" -ge "$SETTLE_TIMEOUT_S" ]; then
      echo "no snapshot at or past slot $1 within ${waited} s ($2); see $LOG" >&2; exit 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "$waited"
}

case "${1:-}" in
  start)
    if ours; then echo "already running (pid $(cat "$PID_FILE"))"; exit 1; fi
    if [ -z "$RELEASE" ]; then
      echo "E2E_RELEASE_DIR is required: a v1.0.0-rc artefact directory (SHA256SUMS, asset_registry.so, transfer_hook.so)," \
        "e.g. docs/mainnet-readiness/deploy-8.3b/artifact-M"
      exit 2
    fi
    rm -f "$PID_FILE"
    ports_free
    # Exactly one line per program, then the check: a SHA256SUMS missing a
    # line would otherwise verify only the other file.
    sums="$(grep -E ' \*?(asset_registry|transfer_hook)\.so$' "$RELEASE/SHA256SUMS" || true)"
    if [ "$(printf '%s\n' "$sums" | grep -cE ' \*?asset_registry\.so$')" != 1 ] \
      || [ "$(printf '%s\n' "$sums" | grep -cE ' \*?transfer_hook\.so$')" != 1 ] \
      || [ "$(printf '%s\n' "$sums" | grep -c .)" != 2 ]; then
      echo "SHA256SUMS must list asset_registry.so and transfer_hook.so exactly once each"; exit 1
    fi
    (cd "$RELEASE" && printf '%s\n' "$sums" | shasum -a 256 -c -) >/dev/null \
      || { echo "the Release .so files do not match SHA256SUMS"; exit 1; }
    # The localnet matrix expects v1.0.0-rc (freeze_issuer_proceeds, 6142–6155).
    if ! LC_ALL=C grep -qa "Instruction: FreezeIssuerProceeds" "$RELEASE/asset_registry.so"; then
      echo "$RELEASE/asset_registry.so is not a v1.0.0-rc build (no freeze_issuer_proceeds): chain:e2e on localnet needs one"
      exit 1
    fi
    # SBPF v3 Releases (v0.0.0-rc.2 on, e_flags 3; design 8.3 §11.5): an
    # Agave 3.x validator cannot load the final v3 ELF, so require >= 4.0.
    for so in asset_registry transfer_hook; do
      if [ "$(od -An -t u4 -j 48 -N 4 "$RELEASE/$so.so" | tr -d ' ')" = 3 ]; then
        version="$(solana-test-validator --version)"
        major="$(printf '%s\n' "$version" | sed -nE 's/^solana-test-validator ([0-9]+)\..*/\1/p')"
        if [ -z "$major" ] || [ "$major" -lt 4 ]; then
          echo "$so.so is SBPF v3: needs solana-test-validator >= 4.0, found: $version"
          echo "setup: agave-install init 4.2.2 (or sh -c \"\$(curl -sSfL https://release.anza.xyz/v4.2.2/install)\")"
          exit 1
        fi
        break
      fi
    done
    mkdir -p "$SCRATCH" "$E2E_DIR/keys"
    chmod 700 "$SCRATCH" "$E2E_DIR/keys"
    case "$(physical "$SCRATCH")$(physical "$E2E_DIR")" in
      *[[:space:]]*) echo "E2E_SCRATCH and E2E_DIR must not contain whitespace (validator.txt is sourced)"; exit 1 ;;
    esac
    assert_ignored
    : >"$LOG"
    DEPLOYER_KEY="$E2E_DIR/keys/deployer.json"
    if [ ! -f "$DEPLOYER_KEY" ]; then
      solana-keygen new --no-bip39-passphrase --silent --outfile "$DEPLOYER_KEY" >/dev/null
    fi
    chmod 600 "$DEPLOYER_KEY"
    DEPLOYER="$(solana address -k "$DEPLOYER_KEY")"
    clone=()
    if [ "${E2E_CLONE_FEATURES:-1}" = "1" ]; then clone=(--url mainnet-beta --clone-feature-set); fi
    launch --reset --mint "$DEPLOYER" --slots-per-epoch "$SLOTS_PER_EPOCH" \
      --upgradeable-program "$REGISTRY" "$RELEASE/asset_registry.so" "$DEPLOYER" \
      --upgradeable-program "$HOOK" "$RELEASE/transfer_hook.so" "$DEPLOYER" \
      ${clone[@]+"${clone[@]}"}
    GENESIS="$(solana genesis-hash -u "$URL")"
    umask 077
    # Sourced (set -a) before chain:e2e: the run, and every warp it starts,
    # then carries this validator's scratch and ports; warp checks them.
    cat >"$ENV_FILE" <<EOF
CHAIN_NETWORK=localnet
CHAIN_RPC_URL=$URL
CHAIN_GENESIS_HASH=$GENESIS
E2E_PAYER=$DEPLOYER
CHAIN_KEYPAIR=$DEPLOYER_KEY
CHAIN_STATE_DIR=$SCRATCH/state
E2E_DIR=$(physical "$E2E_DIR")
E2E_SCRATCH=$(physical "$SCRATCH")
E2E_RPC_PORT=$RPC_PORT
E2E_GOSSIP_PORT=$GOSSIP_PORT
E2E_DYNAMIC_PORTS=$DYNAMIC_PORTS
E2E_FAUCET_PORT=$FAUCET_PORT
EOF
    echo "validator up (pid $(cat "$PID_FILE")), genesis $GENESIS, deployer $DEPLOYER"
    echo "env: $ENV_FILE"
    ;;
  warp)
    target="${2:-}"
    case "$target" in '' | *[!0-9]*) echo "usage: $0 warp <slot>" >&2; exit 2 ;; esac
    same_run
    if ! ours; then echo "not running: warp restarts only this script's validator on $LEDGER"; exit 1; fi
    pid="$(cat "$PID_FILE")"
    serves "$pid" || { echo "not restarting pid $pid"; exit 1; }
    # Before the halt: the relaunch binds the same ports, so none may be held
    # by another process (a failure after the halt would leave it stopped).
    ports_free "$pid"
    current="$(solana slot -u "$URL" --commitment finalized)"
    if [ "$target" -le "$current" ]; then echo "warp slot $target is not past the finalized slot $current"; exit 1; fi
    # The restart loads the newest full snapshot and warps from it WITHOUT
    # replaying the blockstore after it: every finalized transaction must be
    # in a snapshot first, or the warp silently drops it (observed: a
    # finalized open_payout_vault 65 slots past the snapshot was gone).
    before="$(wait_snapshot "$current" "before the warp")"
    halt
    if ! (ports_free); then
      echo "the validator is stopped (ledger kept at $LEDGER); a port was taken during the halt" >&2
      exit 1
    fi
    echo "=== warp to slot $target from snapshot $(settled_snapshot) ($(date -u +%FT%TZ)) ===" >>"$LOG"
    launch --warp-slot "$target"
    # A snapshot past the warp must itself be settled before the next
    # restart (the warp's own snapshot would make that restart fail).
    after="$(wait_snapshot $((target + WARP_SETTLE_SLOTS)) "after the warp")"
    echo "warped to slot $target (pid $(cat "$PID_FILE")); snapshot waits ${before} s before, ${after} s after (settled at $(settled_snapshot))"
    ;;
  stop)
    if ! ours; then
      [ -f "$PID_FILE" ] && echo "pid file is stale (not this validator); removed"
      rm -f "$PID_FILE"
      echo "not running"
      exit 0
    fi
    halt
    echo "stopped"
    ;;
  status)
    if ours; then echo "running (pid $(cat "$PID_FILE")) at $URL"; else echo "not running"; fi
    ;;
  *)
    echo "usage: $0 start|stop|status|warp <slot>  (start needs E2E_RELEASE_DIR = a v1.0.0-rc artefact)" >&2
    exit 2
    ;;
esac

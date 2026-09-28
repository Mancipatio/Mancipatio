#!/usr/bin/env bash
# Local validator for `npm run chain:e2e` on localnet (Talas 6.3, design-6.3 §C).
#
#   bash scripts/chain/e2e-localnet.sh start        # fresh ledger, release .so, prints the CHAIN_* lines
#   bash scripts/chain/e2e-localnet.sh stop
#   bash scripts/chain/e2e-localnet.sh status
#   bash scripts/chain/e2e-localnet.sh warp <slot>  # restart this validator on its ledger at <slot>
#
# The programs are the Release artefacts (checked against SHA256SUMS) loaded
# as upgradeable programs whose upgrade authority is a local deployer key
# (<E2E_DIR>/keys/deployer.json, 600, also the faucet --mint). Ports stay
# clear of a default validator (8899/8900, 18000-18040, 19900): by default
# RPC 8999, WS 9000 (always RPC + 1), gossip 18100, dynamic 18101-18140,
# faucet 19910; E2E_RPC_PORT, E2E_GOSSIP_PORT, E2E_DYNAMIC_PORTS and
# E2E_FAUCET_PORT move them (parallel runs). A faucet on RPC + 1 takes the
# WS port: the validator then logs that its pubsub service could not bind,
# which chain:e2e does not use (HTTP only). The ledger lives in E2E_SCRATCH
# (default $TMPDIR/manci-e2e-6.3), never in the repository.
# E2E_CLONE_FEATURES=0 skips the mainnet feature-set clone (on by default,
# as in the 6.1 rehearsal; a read-only fetch by the validator at start).
# `stop` kills only a pid whose command is solana-test-validator on this
# ledger (a stale pid file is just removed) and waits up to 15 s for it.
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
# pre-warp slots fails the SlotHistory check. Which slot gives which
# clock (a jump inside the epoch, then a reset into a later epoch so the
# clock moves again) is scripts/chain/lib/e2e/warp.ts's; a jump of D
# seconds needs D / 0.3 slots inside one epoch, so genesis uses a long
# epoch, E2E_SLOTS_PER_EPOCH (default 20,000,000 slots: up to about 69
# days per jump; ~1.2 GB RSS).
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(git rev-parse --show-toplevel)"
E2E_DIR="${E2E_DIR:-$ROOT/docs/mainnet-readiness/e2e-6.3/localnet}"
SCRATCH="${E2E_SCRATCH:-${TMPDIR:-/tmp}/manci-e2e-6.3}"
RELEASE="${E2E_RELEASE_DIR:-$ROOT/docs/mainnet-readiness/release-v0.0.0-rc.1}"
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
URL="http://127.0.0.1:${RPC_PORT}"
REGISTRY=FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS
HOOK=GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy
PID_FILE="$SCRATCH/validator.pid"
LEDGER="$SCRATCH/ledger"
LOG="$SCRATCH/validator.log"
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

ports_free() {
  local port
  for port in $RPC_PORT $WS_PORT $GOSSIP_PORT $FAUCET_PORT; do
    if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is in use"; exit 1; fi
  done
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
    if [ "$waited" -ge "${E2E_WARP_SETTLE_TIMEOUT_S:-900}" ]; then
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
    cat >"$E2E_DIR/validator.txt" <<EOF
CHAIN_NETWORK=localnet
CHAIN_RPC_URL=$URL
CHAIN_GENESIS_HASH=$GENESIS
E2E_PAYER=$DEPLOYER
CHAIN_KEYPAIR=$DEPLOYER_KEY
CHAIN_STATE_DIR=$SCRATCH/state
EOF
    echo "validator up (pid $(cat "$PID_FILE")), genesis $GENESIS, deployer $DEPLOYER"
    echo "env: $E2E_DIR/validator.txt"
    ;;
  warp)
    target="${2:-}"
    case "$target" in '' | *[!0-9]*) echo "usage: $0 warp <slot>" >&2; exit 2 ;; esac
    if ! ours; then echo "not running: warp restarts only this script's validator on $LEDGER"; exit 1; fi
    current="$(solana slot -u "$URL" --commitment finalized)"
    if [ "$target" -le "$current" ]; then echo "warp slot $target is not past the finalized slot $current"; exit 1; fi
    # The restart loads the newest full snapshot and warps from it WITHOUT
    # replaying the blockstore after it: every finalized transaction must be
    # in a snapshot first, or the warp silently drops it (observed: a
    # finalized open_payout_vault 65 slots past the snapshot was gone).
    before="$(wait_snapshot "$current" "before the warp")"
    halt
    ports_free
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
    echo "usage: $0 start|stop|status|warp <slot>" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
# Local validator for `npm run chain:e2e` on localnet (Talas 6.3, design-6.3 §C).
#
#   bash scripts/chain/e2e-localnet.sh start   # fresh ledger, release .so, prints the CHAIN_* lines
#   bash scripts/chain/e2e-localnet.sh stop
#   bash scripts/chain/e2e-localnet.sh status
#
# The programs are the Release artefacts (checked against SHA256SUMS) loaded
# as upgradeable programs whose upgrade authority is a local deployer key
# (<E2E_DIR>/keys/deployer.json, 600, also the faucet --mint). Ports stay
# clear of a default validator (8899/8900, 18000-18040, 19900): RPC 8999,
# WS 9000, gossip 18100, dynamic 18101-18140, faucet 19910. The ledger lives
# in E2E_SCRATCH (default $TMPDIR/manci-e2e-6.3), never in the repository.
# E2E_CLONE_FEATURES=0 skips the mainnet feature-set clone (on by default,
# as in the 6.1 rehearsal; a read-only fetch by the validator at start).
# `stop` kills only a pid whose command is solana-test-validator on this
# ledger (a stale pid file is just removed) and waits up to 15 s for it.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT="$(git rev-parse --show-toplevel)"
E2E_DIR="${E2E_DIR:-$ROOT/docs/mainnet-readiness/e2e-6.3/localnet}"
SCRATCH="${E2E_SCRATCH:-${TMPDIR:-/tmp}/manci-e2e-6.3}"
RELEASE="${E2E_RELEASE_DIR:-$ROOT/docs/mainnet-readiness/release-v0.0.0-rc.1}"
RPC_PORT=8999
WS_PORT=9000
GOSSIP_PORT=18100
DYNAMIC_PORTS=18101-18140
FAUCET_PORT=19910
URL="http://127.0.0.1:${RPC_PORT}"
REGISTRY=FJs1EM1ND89L9sUXaS8VBKYXjmoXCkkVSJKRE19hmYxS
HOOK=GBDyesyTr266LqKeFq95r1DeigRyHpfw6ACWdjENHAPy
PID_FILE="$SCRATCH/validator.pid"
LEDGER="$SCRATCH/ledger"
LOG="$SCRATCH/validator.log"

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

case "${1:-}" in
  start)
    if ours; then echo "already running (pid $(cat "$PID_FILE"))"; exit 1; fi
    rm -f "$PID_FILE"
    for port in $RPC_PORT $WS_PORT $GOSSIP_PORT $FAUCET_PORT; do
      if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is in use"; exit 1; fi
    done
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
    nohup solana-test-validator --reset --ledger "$LEDGER" --bind-address 127.0.0.1 \
      --rpc-port "$RPC_PORT" --gossip-port "$GOSSIP_PORT" --dynamic-port-range "$DYNAMIC_PORTS" \
      --faucet-port "$FAUCET_PORT" --mint "$DEPLOYER" \
      --upgradeable-program "$REGISTRY" "$RELEASE/asset_registry.so" "$DEPLOYER" \
      --upgradeable-program "$HOOK" "$RELEASE/transfer_hook.so" "$DEPLOYER" \
      ${clone[@]+"${clone[@]}"} >"$LOG" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in $(seq 1 90); do
      if solana cluster-version -u "$URL" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    solana cluster-version -u "$URL" >/dev/null || { echo "validator did not start; see $LOG"; exit 1; }
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
  stop)
    if ! ours; then
      [ -f "$PID_FILE" ] && echo "pid file is stale (not this validator); removed"
      rm -f "$PID_FILE"
      echo "not running"
      exit 0
    fi
    pid="$(cat "$PID_FILE")"
    kill "$pid"
    for _ in $(seq 1 15); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$pid" 2>/dev/null; then echo "pid $pid did not exit within 15 s; pid file kept"; exit 1; fi
    rm -f "$PID_FILE"
    echo "stopped"
    ;;
  status)
    if ours; then echo "running (pid $(cat "$PID_FILE")) at $URL"; else echo "not running"; fi
    ;;
  *)
    echo "usage: $0 start|stop|status" >&2
    exit 2
    ;;
esac

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

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

case "${1:-}" in
  start)
    if running; then echo "already running (pid $(cat "$PID_FILE"))"; exit 1; fi
    for port in $RPC_PORT $WS_PORT $GOSSIP_PORT $FAUCET_PORT; do
      if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is in use"; exit 1; fi
    done
    (cd "$RELEASE" && grep -E ' (asset_registry|transfer_hook)\.so$' SHA256SUMS | shasum -a 256 -c -) >/dev/null \
      || { echo "the Release .so files do not match SHA256SUMS"; exit 1; }
    mkdir -p "$SCRATCH" "$E2E_DIR/keys"
    chmod 700 "$SCRATCH" "$E2E_DIR/keys"
    DEPLOYER_KEY="$E2E_DIR/keys/deployer.json"
    if [ ! -f "$DEPLOYER_KEY" ]; then
      solana-keygen new --no-bip39-passphrase --silent --outfile "$DEPLOYER_KEY" >/dev/null
    fi
    chmod 600 "$DEPLOYER_KEY"
    DEPLOYER="$(solana address -k "$DEPLOYER_KEY")"
    clone=()
    if [ "${E2E_CLONE_FEATURES:-1}" = "1" ]; then clone=(--url mainnet-beta --clone-feature-set); fi
    nohup solana-test-validator --reset --ledger "$SCRATCH/ledger" --bind-address 127.0.0.1 \
      --rpc-port "$RPC_PORT" --gossip-port "$GOSSIP_PORT" --dynamic-port-range "$DYNAMIC_PORTS" \
      --faucet-port "$FAUCET_PORT" --mint "$DEPLOYER" \
      --upgradeable-program "$REGISTRY" "$RELEASE/asset_registry.so" "$DEPLOYER" \
      --upgradeable-program "$HOOK" "$RELEASE/transfer_hook.so" "$DEPLOYER" \
      "${clone[@]}" >"$SCRATCH/validator.log" 2>&1 &
    echo $! >"$PID_FILE"
    for _ in $(seq 1 90); do
      if solana cluster-version -u "$URL" >/dev/null 2>&1; then break; fi
      sleep 1
    done
    solana cluster-version -u "$URL" >/dev/null || { echo "validator did not start; see $SCRATCH/validator.log"; exit 1; }
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
    if running; then kill "$(cat "$PID_FILE")"; echo "stopped"; else echo "not running"; fi
    rm -f "$PID_FILE"
    ;;
  status)
    if running; then echo "running (pid $(cat "$PID_FILE")) at $URL"; else echo "not running"; fi
    ;;
  *)
    echo "usage: $0 start|stop|status" >&2
    exit 2
    ;;
esac

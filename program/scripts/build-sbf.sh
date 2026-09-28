#!/usr/bin/env bash
# Local SBPF v3 build of both programs (design 8.3 §11.5), identical in
# flags to program-ci:
#
#   bash scripts/build-sbf.sh [extra cargo-build-sbf options]
#
# One-time setup (the Solana install's cargo-build-sbf is 3.1.13 /
# platform-tools v1.52, and sits ahead of ~/.cargo/bin in PATH — it must
# never be used with --arch v3):
#
#   rustup toolchain install 1.95.0 --profile minimal
#   cargo +1.95.0 install cargo-build-sbf --version '=4.2.0' --locked \
#     --root ~/.local/share/manci-cbs-4.2.0
#
# MANCI_CARGO_BUILD_SBF overrides the binary path. The script refuses any
# other cargo-build-sbf / platform-tools pair, always passes
# `--arch v3 --tools-version v1.56` and runs the ELF gate afterwards.
set -euo pipefail

CARGO_BUILD_SBF_VERSION=4.2.0
PLATFORM_TOOLS_VERSION=v1.56
cbs="${MANCI_CARGO_BUILD_SBF:-$HOME/.local/share/manci-cbs-$CARGO_BUILD_SBF_VERSION/bin/cargo-build-sbf}"
program_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -x "$cbs" ]]; then
  echo "cargo-build-sbf $CARGO_BUILD_SBF_VERSION not found at $cbs (see the setup in $0)" >&2
  exit 1
fi
version="$("$cbs" --version)"
if ! grep -qx "cargo-build-sbf $CARGO_BUILD_SBF_VERSION" <<<"$version" ||
  ! grep -qx "platform-tools $PLATFORM_TOOLS_VERSION" <<<"$version"; then
  echo "expected cargo-build-sbf $CARGO_BUILD_SBF_VERSION / platform-tools $PLATFORM_TOOLS_VERSION, got:" >&2
  echo "$version" >&2
  exit 1
fi

cd "$program_dir"
"$cbs" --manifest-path "$program_dir/Cargo.toml" --workspace \
  --arch v3 --tools-version "$PLATFORM_TOOLS_VERSION" "$@" -- --locked
bash "$program_dir/scripts/check-sbf-elf.sh" \
  target/deploy/asset_registry.so target/deploy/transfer_hook.so

#!/usr/bin/env bash
set -euo pipefail

# Linux CI only. Keep these versions in step with the frontend IDL manifest.
# SHA-256 values are the official GitHub release asset digests; no mutable
# installer script or floating release tag is executed.
test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64
tool_root="${RUNNER_TEMP:-/tmp}/mancipatio-solana-toolchain"
mkdir -p "$tool_root/bin"
curl --fail --location --retry 3 \
  https://github.com/anza-xyz/agave/releases/download/v3.1.13/solana-release-x86_64-unknown-linux-gnu.tar.bz2 \
  --output "$tool_root/agave.tar.bz2"
printf '%s  %s\n' 88df00f7c23f84aa627f9181f8231d2aa10ada7caa9ff5a7f7287b7ef7d0bbe8 "$tool_root/agave.tar.bz2" | sha256sum --check
tar -xjf "$tool_root/agave.tar.bz2" -C "$tool_root"

# solana-foundation/anchor v1.0.0 resolves to this release asset repository.
curl --fail --location --retry 3 \
  https://github.com/otter-sec/anchor/releases/download/v1.0.0/anchor-1.0.0-x86_64-unknown-linux-gnu \
  --output "$tool_root/bin/anchor"
printf '%s  %s\n' 56c5a838ace02fcaa45d7d85920f228e476b2477803a24d80bc11d0040aa1d8d "$tool_root/bin/anchor" | sha256sum --check
chmod 755 "$tool_root/bin/anchor"

export PATH="$tool_root/bin:$tool_root/solana-release/bin:$PATH"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  printf '%s\n' "$tool_root/bin" "$tool_root/solana-release/bin" >> "$GITHUB_PATH"
fi
solana --version
cargo build-sbf --version
anchor --version

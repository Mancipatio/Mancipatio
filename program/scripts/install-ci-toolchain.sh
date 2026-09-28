#!/usr/bin/env bash
set -euo pipefail

# Linux CI only. Keep these versions in step with the frontend IDL manifest
# (front/idl/program-toolchain.json) and with the verifiable-build image.
# SHA-256 values are the official GitHub release asset digests; no mutable
# installer script or floating release tag is executed.
#
#   bash scripts/install-ci-toolchain.sh             # SBF build + IDL tooling
#   bash scripts/install-ci-toolchain.sh --idl-only  # Agave CLI + Anchor only
#
# SBPF v3 (design 8.3 §11.1): programs are built with cargo-build-sbf 4.2.0
# and platform-tools v1.56 (rustc 1.89 / LLVM 20). cargo-build-sbf 4.x ships
# no release binaries (its GitHub releases carry no assets), so it is built
# from crates.io with the Rust release its repository targets (1.95.0),
# `--locked`, into a directory CI caches by version. Platform-tools older
# than v1.53 must never be combined with `--arch v3`.
idl_only=false
case "${1:-}" in
  "") ;;
  --idl-only) idl_only=true ;;
  *) echo "usage: $0 [--idl-only]" >&2; exit 2 ;;
esac

test "$(uname -s)" = Linux
test "$(uname -m)" = x86_64

AGAVE_VERSION=4.2.2
AGAVE_SHA256=5fc8684f7430038105fde953d4308ed56addf627f658daa61709f345448247ee
ANCHOR_VERSION=1.0.0
ANCHOR_SHA256=56c5a838ace02fcaa45d7d85920f228e476b2477803a24d80bc11d0040aa1d8d
CARGO_BUILD_SBF_VERSION=4.2.0
CARGO_BUILD_SBF_RUST=1.95.0
PLATFORM_TOOLS_VERSION=v1.56

tool_root="${RUNNER_TEMP:-/tmp}/mancipatio-solana-toolchain"
cbs_root="$tool_root/cbs"
mkdir -p "$tool_root/bin"

# Agave v4.2.x: `solana` CLI >= 4.0 (write-buffer / deploy / extend of a v3
# program). Its tarball may bundle a cargo-build-sbf of its own; the PATH
# order below keeps the pinned one first.
curl --fail --location --retry 3 \
  "https://github.com/anza-xyz/agave/releases/download/v${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
  --output "$tool_root/agave.tar.bz2"
printf '%s  %s\n' "$AGAVE_SHA256" "$tool_root/agave.tar.bz2" | sha256sum --check
tar -xjf "$tool_root/agave.tar.bz2" -C "$tool_root"

# solana-foundation/anchor v1.0.0 resolves to this release asset repository.
curl --fail --location --retry 3 \
  "https://github.com/otter-sec/anchor/releases/download/v${ANCHOR_VERSION}/anchor-${ANCHOR_VERSION}-x86_64-unknown-linux-gnu" \
  --output "$tool_root/bin/anchor"
printf '%s  %s\n' "$ANCHOR_SHA256" "$tool_root/bin/anchor" | sha256sum --check
chmod 755 "$tool_root/bin/anchor"

# Highest precedence first.
path_dirs=("$tool_root/bin" "$tool_root/solana-release/bin")
if ! $idl_only; then
  if ! "$cbs_root/bin/cargo-build-sbf" --version 2>/dev/null |
    grep -qx "cargo-build-sbf $CARGO_BUILD_SBF_VERSION"; then
    rustup toolchain install "$CARGO_BUILD_SBF_RUST" --profile minimal
    # `+1.95.0` overrides the job's RUSTUP_TOOLCHAIN (1.89.0, the host
    # toolchain of the programs, their tests, clippy and the IDL build).
    cargo "+$CARGO_BUILD_SBF_RUST" install cargo-build-sbf \
      --version "=$CARGO_BUILD_SBF_VERSION" --locked --root "$cbs_root"
  fi
  path_dirs=("$cbs_root/bin" "${path_dirs[@]}")
fi

export PATH
PATH="$(IFS=:; echo "${path_dirs[*]}"):$PATH"
if [[ -n "${GITHUB_PATH:-}" ]]; then
  # The runner prepends GITHUB_PATH entries in reverse order of writing (the
  # last line written ends up first), so write the lowest precedence first.
  for ((i = ${#path_dirs[@]} - 1; i >= 0; i--)); do
    printf '%s\n' "${path_dirs[i]}" >> "$GITHUB_PATH"
  done
fi

solana_version="$(solana --version)"
echo "$solana_version"
[[ "$solana_version" == "solana-cli ${AGAVE_VERSION%.*}."* ]] || {
  echo "::error::expected solana-cli ${AGAVE_VERSION%.*}.x, got: $solana_version"
  exit 1
}
anchor_version="$(anchor --version)"
echo "$anchor_version"
[[ "$anchor_version" == "anchor-cli $ANCHOR_VERSION" ]] || {
  echo "::error::expected anchor-cli $ANCHOR_VERSION, got: $anchor_version"
  exit 1
}

if ! $idl_only; then
  cbs_version="$(cargo build-sbf --version)"
  echo "$cbs_version"
  grep -qx "cargo-build-sbf $CARGO_BUILD_SBF_VERSION" <<<"$cbs_version" &&
    grep -qx "platform-tools $PLATFORM_TOOLS_VERSION" <<<"$cbs_version" || {
    echo "::error::expected cargo-build-sbf $CARGO_BUILD_SBF_VERSION / platform-tools $PLATFORM_TOOLS_VERSION first on PATH, got: $cbs_version ($(command -v cargo-build-sbf))"
    exit 1
  }
  # Fetch platform-tools now, so a download failure is not reported as a
  # build failure.
  cargo build-sbf --install-only --tools-version "$PLATFORM_TOOLS_VERSION"
fi

#!/usr/bin/env bash
# Negative control of the SBPF v3 ELF gate (design 8.3 §11.3 / K2.2; review
# 8.3 finding 22). The gate replaces cargo-build-sbf's skipped
# `check_undefined_symbols`, so a parser bug that makes it pass everything
# must turn CI red. For every given release .so this:
#
#   * runs check-sbf-elf.sh on the original, which must PASS (exit 0);
#   * writes patched copies that must each FAIL (exit 1) for that reason
#     (the gate's message is matched, so a copy rejected for something else
#     does not count):
#       - e_flags 0 (a v0 artifact),
#       - the first syscall (`call`, src 0) re-pointed at an unknown hash,
#       - the first syscall re-pointed at sol_get_sysvar, a syscall the
#         runtime knows but neither program's pin allows,
#       - the first internal call (`call`, src 1) re-pointed outside .text,
#       - a second security.txt marker appended,
#       - the only security.txt marker overwritten (zero markers).
#     Each copy keeps the original file name (one directory per patch): the
#     gate picks the syscall pin by name.
#
#   bash scripts/check-sbf-elf-selftest.sh target/deploy/asset_registry.so target/deploy/transfer_hook.so
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <program.so>..." >&2
  exit 2
fi

gate="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-sbf-elf.sh"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

failed=0
for so in "$@"; do
  name="$(basename "$so" .so)"
  if ! bash "$gate" "$so" >/dev/null; then
    echo "::error::$so: the ELF gate rejects the original artifact"
    failed=1
    continue
  fi
  python3 - "$so" "$work" <<'PY'
import os
import struct
import sys

src, work = sys.argv[1], sys.argv[2]
name = os.path.basename(src)
data = bytes(open(src, "rb").read())
MARKER = b"=======BEGIN SECURITY.TXT V1======="

e_shoff = struct.unpack_from("<Q", data, 40)[0]
shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 58)
secs = [struct.unpack_from("<IIQQQQ", data, e_shoff + i * shentsize) for i in range(shnum)]
str_off = secs[shstrndx][4]
text = None
for s in secs:
    start = str_off + s[0]
    if data[start:data.index(b"\0", start)] == b".text":
        text = (s[4], s[5])
if text is None:
    sys.exit("no .text section")
off, size = text


def write(tag, patched):
    os.makedirs(f"{work}/{tag}", exist_ok=True)
    open(f"{work}/{tag}/{name}", "wb").write(bytes(patched))


def first_call(src_reg):
    for i in range(off, off + size, 8):
        if data[i] == 0x85 and data[i + 1] >> 4 == src_reg:
            return i
    sys.exit(f"no call with src {src_reg} in .text")


v0 = bytearray(data)
struct.pack_into("<I", v0, 48, 0)
write("v0-flags", v0)

syscall = bytearray(data)
struct.pack_into("<I", syscall, first_call(0) + 4, 0xDEADBEEF)
write("unknown-syscall", syscall)

# murmur3_32(b"sol_get_sysvar"): known to cargo-build-sbf 4.2.0, pinned for
# neither program.
unpinned = bytearray(data)
struct.pack_into("<I", unpinned, first_call(0) + 4, 0x13C1B505)
write("unpinned-syscall", unpinned)

internal = bytearray(data)
struct.pack_into("<i", internal, first_call(1) + 4, size // 8 + 16)
write("call-outside-text", internal)

write("two-markers", bytearray(data) + MARKER + b"\0")

assert data.count(MARKER) == 1
no_marker = bytearray(data)
at = data.index(MARKER)
no_marker[at:at + len(MARKER)] = b"#" * len(MARKER)
write("no-marker", no_marker)
PY
  # tag|message the gate must print for that copy
  for expect in \
    "v0-flags|e_flags 0 != 3 (SBPF v3)" \
    "unknown-syscall|unknown syscall hash 0xdeadbeef" \
    "unpinned-syscall|syscall sol_get_sysvar is not pinned for $name" \
    "call-outside-text|outside .text" \
    "two-markers|2 security.txt markers (expected exactly 1)" \
    "no-marker|0 security.txt markers (expected exactly 1)"; do
    tag="${expect%%|*}"
    message="${expect#*|}"
    patched="$work/$tag/$name.so"
    set +e
    bash "$gate" "$patched" >"$work/out.txt" 2>&1
    status=$?
    set -e
    if [[ $status -eq 1 ]] && grep -qF -- "$message" "$work/out.txt"; then
      echo "$name/$tag: rejected, as it must be ($message)"
    else
      echo "::error::$name/$tag: the ELF gate exited $status on a broken artifact without \"$message\""
      cat "$work/out.txt"
      failed=1
    fi
  done
  rm -rf "${work:?}"/*
done
exit "$failed"

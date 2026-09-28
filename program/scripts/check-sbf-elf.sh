#!/usr/bin/env bash
# SBPF v3 release-artifact gate (design 8.3 §11.3). Used by program-ci,
# verifiable-build and locally (program/scripts/build-sbf.sh runs it after
# every build):
#
#   bash scripts/check-sbf-elf.sh target/deploy/asset_registry.so target/deploy/transfer_hook.so
#
# For every .so it fails unless:
#   1. it is ELF64 little-endian, e_machine == EM_BPF (0xF7) and
#      e_flags == 3 (SBPF v3). Nothing else may be deployed: a v0 build of
#      this workspace stops loading once SIMD-0500 activates;
#   2. it has no dynamic linking at all: no .dynsym / .dynamic / relocation
#      section and no undefined (UND) symbol. cargo-build-sbf 4.2.0 skips its
#      own `check_undefined_symbols` for v3 (post_processing.rs) — it links
#      v3 with `-z defs` instead, and this check is the independent proof;
#   3. every call instruction resolves: an internal call (src = 1) lands
#      inside .text, and a syscall (src = 0) is the murmur3 hash of a
#      syscall the runtime knows (the cargo-build-sbf 4.2.0 SYSCALLS list).
#      An unresolved or sentinel target fails;
#   3a. every syscall is in the reviewed set PINNED for that program (by
#      file name). The v3 verifier does not look at syscall hashes at deploy
#      (solana-sbpf 0.21 `ebpf::CALL_IMM => {}`), so a syscall that is
#      unregistered or feature-gated on the cluster would deploy and fail
#      only when its path runs. A dependency bump that starts calling a new
#      one (e.g. sol_get_sysvar through solana-get-sysvar) fails here until
#      the pin is changed in review, after checking the syscall is active on
#      the target cluster. A file name without a pin fails;
#   4. it carries exactly one `=======BEGIN SECURITY.TXT V1=======` marker.
#      The SBF targets are `target_arch = "sbf"`, so solana-security-txt's
#      `link_section = ".security.txt"` (gated on "bpf") never applies: the
#      string lives in .rodata and survives only because the static is kept.
#
# Negative control (G0): a throwaway crate calling an undefined
# `extern "C" fn` does not link under `--arch v3` (-z defs), and the same
# object patched to v0 flags or with a foreign syscall hash fails here.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <program.so>..." >&2
  exit 2
fi

exec python3 - "$@" <<'PY'
import os
import struct
import sys

EM_BPF = 0xF7
SBPF_V3 = 3
MARKER = b"=======BEGIN SECURITY.TXT V1======="
# cargo-build-sbf 4.2.0 src/syscalls.rs, in order.
SYSCALLS = [
    "abort", "sol_panic_", "sol_log_", "sol_log_64_", "sol_log_pubkey",
    "sol_log_compute_units_", "sol_create_program_address",
    "sol_try_find_program_address", "sol_sha256", "sol_keccak256",
    "sol_secp256k1_recover", "sol_get_clock_sysvar",
    "sol_get_epoch_schedule_sysvar", "sol_get_rent_sysvar",
    "sol_get_epoch_rewards_sysvar", "sol_memcpy_", "sol_memmove_",
    "sol_memset_", "sol_memcmp_", "sol_get_processed_sibling_instruction",
    "sol_get_stack_height", "sol_set_return_data", "sol_get_return_data",
    "sol_invoke_signed_c", "sol_invoke_signed_rust", "sol_log_data",
    "sol_blake3", "sol_curve_validate_point", "sol_curve_group_op",
    "sol_curve_multiscalar_mul", "sol_curve_decompress",
    "sol_curve_pairing_map", "sol_get_fees_sysvar",
    "sol_get_last_restart_slot", "sol_alloc_free_", "sol_alt_bn128_group_op",
    "sol_big_mod_exp", "sol_poseidon", "sol_remaining_compute_units",
    "sol_alt_bn128_compression", "sol_get_sysvar", "sol_get_epoch_stake",
]


def murmur3_32(data: bytes, seed: int = 0) -> int:
    """solana-sbpf `ebpf::hash_symbol_name` (murmur3 x86_32, seed 0)."""
    c1, c2, h = 0xCC9E2D51, 0x1B873593, seed
    n = len(data) & ~3
    for i in range(0, n, 4):
        k = int.from_bytes(data[i:i + 4], "little")
        k = (k * c1) & 0xFFFFFFFF
        k = ((k << 15) | (k >> 17)) & 0xFFFFFFFF
        k = (k * c2) & 0xFFFFFFFF
        h ^= k
        h = ((h << 13) | (h >> 19)) & 0xFFFFFFFF
        h = (h * 5 + 0xE6546B64) & 0xFFFFFFFF
    tail, k = data[n:], 0
    if len(tail) == 3:
        k ^= tail[2] << 16
    if len(tail) >= 2:
        k ^= tail[1] << 8
    if tail:
        k ^= tail[0]
        k = (k * c1) & 0xFFFFFFFF
        k = ((k << 15) | (k >> 17)) & 0xFFFFFFFF
        k = (k * c2) & 0xFFFFFFFF
        h ^= k
    h ^= len(data)
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & 0xFFFFFFFF
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & 0xFFFFFFFF
    h ^= h >> 16
    return h


KNOWN = {murmur3_32(name.encode()) for name in SYSCALLS}
NAMES = {murmur3_32(name.encode()): name for name in SYSCALLS}
assert murmur3_32(b"sol_log_") == 0x207559BD, "murmur3 self-test"

# The syscalls each release program calls, pinned from the reviewed v3
# build of the rc.1 logic (2026-09-28; the rc.1 v0 Release imports the same
# names). Add one only in review, never to make CI pass.
PINNED = {
    "asset_registry": {
        "abort", "sol_create_program_address", "sol_get_clock_sysvar",
        "sol_get_rent_sysvar", "sol_invoke_signed_rust", "sol_log_",
        "sol_log_data", "sol_log_pubkey", "sol_memcmp_", "sol_memcpy_",
        "sol_memmove_", "sol_memset_", "sol_panic_", "sol_sha256",
        "sol_try_find_program_address",
    },
    "transfer_hook": {
        "abort", "sol_create_program_address", "sol_get_clock_sysvar",
        "sol_get_rent_sysvar", "sol_invoke_signed_rust", "sol_log_",
        "sol_log_pubkey", "sol_memcmp_", "sol_memcpy_", "sol_memmove_",
        "sol_memset_", "sol_panic_", "sol_try_find_program_address",
    },
}
assert all(PINNED[p] <= set(SYSCALLS) for p in PINNED), "pin names a syscall cargo-build-sbf does not know"


def check(path: str) -> list:
    problems = []
    program = os.path.basename(path)[: -len(".so")] if path.endswith(".so") else os.path.basename(path)
    pinned = PINNED.get(program)
    if pinned is None:
        problems.append(f"no pinned syscall set for {program!r} (known: {', '.join(sorted(PINNED))})")
    data = open(path, "rb").read()
    if data[:4] != b"\x7fELF" or data[4] != 2 or data[5] != 1:
        return ["not an ELF64 little-endian file"]
    (e_machine,) = struct.unpack_from("<H", data, 18)
    (e_flags,) = struct.unpack_from("<I", data, 48)
    if e_machine != EM_BPF:
        problems.append(f"e_machine {e_machine:#x} != EM_BPF {EM_BPF:#x}")
    if e_flags != SBPF_V3:
        problems.append(f"e_flags {e_flags} != {SBPF_V3} (SBPF v3)")
    (e_shoff,) = struct.unpack_from("<Q", data, 40)
    e_shentsize, e_shnum, e_shstrndx = struct.unpack_from("<HHH", data, 58)
    sections = []
    for i in range(e_shnum):
        base = e_shoff + i * e_shentsize
        name, sh_type, _flags, addr, off, size = struct.unpack_from("<IIQQQQ", data, base)
        sections.append((name, sh_type, addr, off, size))
    _, _, _, str_off, _ = sections[e_shstrndx]

    def sec_name(entry):
        start = str_off + entry[0]
        return data[start:data.index(b"\0", start)].decode()

    names = {sec_name(s): s for s in sections}
    for bad in (".dynsym", ".dynstr", ".dynamic", ".rel.dyn", ".rela.dyn"):
        if bad in names:
            problems.append(f"dynamic-linking section {bad} present")
    for s in sections:
        if s[1] in (4, 6, 9, 11):  # RELA, DYNAMIC, REL, DYNSYM
            problems.append(f"section {sec_name(s)!r} has dynamic type {s[1]}")
    text = names.get(".text")
    if text is None:
        problems.append("no .text section")
    else:
        _, _, _, off, size = text
        count = size // 8
        for idx in range(count):
            insn = data[off + idx * 8: off + idx * 8 + 8]
            if insn[0] != 0x85:
                continue
            src = insn[1] >> 4
            (imm,) = struct.unpack_from("<i", insn, 4)
            if src == 1:
                target = idx + 1 + imm
                if not 0 <= target < count:
                    problems.append(f".text[{idx}]: internal call to {target} outside .text")
            elif src == 0:
                key = imm & 0xFFFFFFFF
                if key not in KNOWN:
                    problems.append(f".text[{idx}]: unknown syscall hash {key:#010x}")
                elif pinned is not None and NAMES[key] not in pinned:
                    problems.append(f".text[{idx}]: syscall {NAMES[key]} is not pinned for {program}")
            else:
                problems.append(f".text[{idx}]: call with src {src}")
            if len(problems) > 20:
                break
    markers = data.count(MARKER)
    if markers != 1:
        problems.append(f"{markers} security.txt markers (expected exactly 1)")
    return problems


failed = False
for path in sys.argv[1:]:
    problems = check(path)
    if problems:
        failed = True
        for p in problems:
            print(f"::error::{path}: {p}")
    else:
        print(f"{path}: SBPF v3 (e_flags 3, EM_BPF), no dynamic symbols, calls resolved, syscalls within the pin, security.txt x1")
sys.exit(1 if failed else 0)
PY

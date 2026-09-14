// lib/merkle.ts — sorted-pair SHA-256 tree, cross-checked against an
// INDEPENDENT reference implementation (node:crypto, not WebCrypto) plus
// hardcoded vectors computed outside this codebase.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Address } from "@solana/kit";
import { merkleProof, merkleRoot, snapshotLeaf } from "@/lib/merkle";

const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address; // 32 zero bytes

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

// ── Independent reference (node:crypto) ──────────────────────────────────────

function refSha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(data).digest());
}

function refParent(a: Uint8Array, b: Uint8Array): Uint8Array {
  const [lo, hi] = Buffer.compare(Buffer.from(a), Buffer.from(b)) <= 0 ? [a, b] : [b, a];
  return refSha256(new Uint8Array([...lo, ...hi]));
}

/** Fold a proof back up to a root — mirrors on-chain verify_merkle_proof. */
function refVerify(leaf: Uint8Array, proof: Uint8Array[]): Uint8Array {
  return proof.reduce((acc, sib) => refParent(acc, sib), leaf);
}

async function leaves(n: number): Promise<Uint8Array[]> {
  // Distinct deterministic leaves (weight-varied, same wallet).
  const out: Uint8Array[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(await snapshotLeaf(SYSTEM_PROGRAM, BigInt(i + 1)));
  }
  return out;
}

describe("snapshotLeaf", () => {
  it("matches the hardcoded vector for (system program, weight 1)", async () => {
    // sha256(32 zero bytes || u64le(1)) — computed independently.
    expect(hex(await snapshotLeaf(SYSTEM_PROGRAM, BigInt(1)))).toBe(
      "19ea44be89eece0fd4ec7482049f472a11af19384bffb38a88e77b3b1dd54c19",
    );
  });

  it("matches the hardcoded vector for (system program, weight 1_000_000)", async () => {
    expect(hex(await snapshotLeaf(SYSTEM_PROGRAM, BigInt(1_000_000)))).toBe(
      "96d4591587576b75f8240958411f5072003506d1d6400be55ccf4f0dc0a72db1",
    );
  });

  it("encodes the weight little-endian (weight 1 ≠ weight 256)", async () => {
    const a = await snapshotLeaf(SYSTEM_PROGRAM, BigInt(1));
    const b = await snapshotLeaf(SYSTEM_PROGRAM, BigInt(256));
    expect(hex(a)).not.toBe(hex(b));
    // Independent recomputation of the LE layout.
    const w = new Uint8Array(8);
    w[1] = 1; // 256 little-endian
    expect(hex(b)).toBe(hex(refSha256(new Uint8Array([...new Uint8Array(32), ...w]))));
  });
});

describe("merkleRoot", () => {
  it("returns 32 zero bytes for an empty leaf set", async () => {
    expect(hex(await merkleRoot([]))).toBe("00".repeat(32));
  });

  it("returns the leaf itself for a single leaf", async () => {
    const [l] = await leaves(1);
    expect(hex(await merkleRoot([l]))).toBe(hex(l));
  });

  it("hashes a pair in sorted order (order-independent root)", async () => {
    const [a, b] = await leaves(2);
    const root = await merkleRoot([a, b]);
    expect(hex(root)).toBe(hex(refParent(a, b)));
    expect(hex(await merkleRoot([b, a]))).toBe(hex(root)); // commutative
  });

  it("matches the hardcoded parent-of-self vector", async () => {
    const l = await snapshotLeaf(SYSTEM_PROGRAM, BigInt(1));
    expect(hex(await merkleRoot([l, l]))).toBe(
      "36f7c3cc9fa27af556760bbb2e6f033b985db876d9d5990cbb9eb21bceb99d9b",
    );
  });

  it("promotes the odd node unchanged (3 leaves)", async () => {
    const [a, b, c] = await leaves(3);
    expect(hex(await merkleRoot([a, b, c]))).toBe(hex(refParent(refParent(a, b), c)));
  });

  it("matches a full independent rebuild for 7 leaves", async () => {
    const ls = await leaves(7);
    let level = ls;
    while (level.length > 1) {
      const next: Uint8Array[] = [];
      for (let i = 0; i < level.length; i += 2) {
        next.push(i + 1 < level.length ? refParent(level[i], level[i + 1]) : level[i]);
      }
      level = next;
    }
    expect(hex(await merkleRoot(ls))).toBe(hex(level[0]));
  });
});

describe("merkleProof", () => {
  it("proves every leaf back to the root for sizes 1..8", async () => {
    for (let n = 1; n <= 8; n += 1) {
      const ls = await leaves(n);
      const root = await merkleRoot(ls);
      for (let i = 0; i < n; i += 1) {
        const proof = await merkleProof(ls, i);
        expect(hex(refVerify(ls[i], proof))).toBe(hex(root));
      }
    }
  });

  it("yields an empty proof for a single-leaf tree", async () => {
    const ls = await leaves(1);
    expect(await merkleProof(ls, 0)).toEqual([]);
  });

  it("fails verification for a tampered leaf", async () => {
    const ls = await leaves(4);
    const root = await merkleRoot(ls);
    const proof = await merkleProof(ls, 2);
    const forged = await snapshotLeaf(SYSTEM_PROGRAM, BigInt(999));
    expect(hex(refVerify(forged, proof))).not.toBe(hex(root));
  });
});

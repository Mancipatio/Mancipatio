// Sorted-pair SHA-256 Merkle tree — matches the on-chain
// `util::verify_merkle_proof` / `merkle_parent` / `snapshot_leaf`.

import { getAddressEncoder, type Address } from "@solana/kit";

const addrEncoder = getAddressEncoder();

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  // `.slice()` yields an ArrayBuffer-backed copy — a valid BufferSource.
  return new Uint8Array(await crypto.subtle.digest("SHA-256", data.slice()));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Lexicographic `a <= b` over equal-length byte arrays. */
function lte(a: Uint8Array, b: Uint8Array): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return true;
}

/** Snapshot leaf = `sha256(address || weight_u64_le)`. */
export async function snapshotLeaf(
  address: Address,
  weight: bigint,
): Promise<Uint8Array> {
  const a = new Uint8Array(addrEncoder.encode(address));
  const w = new Uint8Array(8);
  new DataView(w.buffer).setBigUint64(0, weight, true);
  return sha256(concat(a, w));
}

async function parent(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  return lte(a, b) ? sha256(concat(a, b)) : sha256(concat(b, a));
}

async function nextLevel(nodes: Uint8Array[]): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  for (let i = 0; i < nodes.length; i += 2) {
    out.push(
      i + 1 < nodes.length ? await parent(nodes[i], nodes[i + 1]) : nodes[i],
    );
  }
  return out;
}

export async function merkleRoot(leaves: Uint8Array[]): Promise<Uint8Array> {
  if (leaves.length === 0) return new Uint8Array(32);
  let nodes = leaves;
  while (nodes.length > 1) nodes = await nextLevel(nodes);
  return nodes[0];
}

/** Proof (sibling list) for the leaf at `index`. */
export async function merkleProof(
  leaves: Uint8Array[],
  index: number,
): Promise<Uint8Array[]> {
  const proof: Uint8Array[] = [];
  let nodes = leaves;
  let idx = index;
  while (nodes.length > 1) {
    const sibling = idx ^ 1;
    if (sibling < nodes.length) proof.push(nodes[sibling]);
    nodes = await nextLevel(nodes);
    idx >>= 1;
  }
  return proof;
}

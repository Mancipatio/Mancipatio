/** Canonical original-investor snapshot. Weights are exact u64 base units;
 * current holder balances are never substituted for this committed list. */
import { address } from "@solana/kit";
import { merkleRoot, snapshotLeaf } from "@/lib/merkle";
export type PayoutSnapshotKind = "vault_vote" | "investor_yield";
export type SnapshotWeight = { wallet: string; weight: string };
export type SnapshotEntry = SnapshotWeight & { proof: string[] };
export type CanonicalPayoutSnapshot = { root_hex: string; rows_hash: string; total_weight: string; count: number; rows: SnapshotWeight[]; entries: SnapshotEntry[] };
export type PreparedPayoutSnapshot = { id: string; kind: PayoutSnapshotKind; target_pda: string; round: string; root_hex: string; total_weight: string; entry_count: number; status: "prepared" | "bound" };
export type PayoutSnapshotProof = { snapshot_id: string; root_hex: string; total_weight: string; weight: string; proof: string[]; bound_slot: string };
export const MAX_SNAPSHOT_ENTRIES = 5000;
const MAX_U64 = BigInt("18446744073709551615");
export function snapshotHex(bytes: Uint8Array | ArrayLike<number>) { return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""); }
export function snapshotBytes(hex: string) {
  if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error("Invalid snapshot hash");
  return Uint8Array.from(hex.match(/../g)!, (pair) => parseInt(pair, 16));
}
export async function canonicalPayoutSnapshot(input: unknown): Promise<CanonicalPayoutSnapshot> {
  if (!Array.isArray(input) || input.length < 1 || input.length > MAX_SNAPSHOT_ENTRIES) throw new Error(`Provide 1–${MAX_SNAPSHOT_ENTRIES} original investor entries`);
  const seen = new Set<string>(); let total = BigInt(0);
  const rows = input.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Invalid snapshot entry");
    const value = item as Record<string, unknown>;
    if (typeof value.wallet !== "string" || typeof value.weight !== "string" || !/^[1-9]\d{0,19}$/.test(value.weight)) throw new Error("Invalid wallet or positive integer weight");
    const wallet = address(value.wallet).toString(); const weight = BigInt(value.weight);
    if (seen.has(wallet)) throw new Error("Duplicate investor wallet in canonical snapshot");
    if (weight > MAX_U64) throw new Error("Investor weight exceeds u64");
    seen.add(wallet); total += weight;
    if (total > MAX_U64) throw new Error("Snapshot total exceeds u64");
    return { wallet, weight: weight.toString() };
  }).sort((a, b) => a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0);
  const levels: Uint8Array[][] = [await Promise.all(rows.map((row) => snapshotLeaf(address(row.wallet), BigInt(row.weight))))];
  while (levels.at(-1)!.length > 1) {
    const nodes = levels.at(-1)!; const tasks: Promise<Uint8Array>[] = [];
    for (let i = 0; i < nodes.length; i += 2) tasks.push(i + 1 < nodes.length ? merkleRoot([nodes[i], nodes[i + 1]]) : Promise.resolve(nodes[i]));
    levels.push(await Promise.all(tasks));
  }
  const entries = rows.map((row, index) => {
    let idx = index; const proof: string[] = [];
    for (let level = 0; level < levels.length - 1; level++) {
      const sibling = idx ^ 1;
      if (sibling < levels[level].length) proof.push(snapshotHex(levels[level][sibling]));
      idx >>= 1;
    }
    return { ...row, proof };
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows))));
  return { root_hex: snapshotHex(levels.at(-1)![0]), rows_hash: snapshotHex(digest), total_weight: total.toString(), count: rows.length, rows, entries };
}
export async function verifyOriginalSnapshotProof(wallet: string, weight: string, proof: string[], root: string) {
  if (!/^[1-9]\d{0,19}$/.test(weight) || BigInt(weight) > MAX_U64 || !Array.isArray(proof) || proof.length > 13) return false;
  try {
    let node = await snapshotLeaf(address(wallet), BigInt(weight));
    for (const sibling of proof) node = await merkleRoot([node, snapshotBytes(sibling)]);
    return snapshotHex(node) === root;
  } catch { return false; }
}

import { describe, expect, it } from "vitest";
import { canonicalPayoutSnapshot, verifyOriginalSnapshotProof } from "@/lib/payout-snapshots";
import { address } from "@solana/kit";
import { merkleRoot, snapshotLeaf } from "@/lib/merkle";
const A = "11111111111111111111111111111111";
const B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const C = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const rows = [{ wallet: A, weight: "10" }, { wallet: B, weight: "9007199254740993" }, { wallet: C, weight: "5" }];
describe("canonical original investor entitlements", () => {
  it("preserves exact weights above Number precision and reproduces the program Merkle root", async () => {
    const built = await canonicalPayoutSnapshot([...rows].reverse());
    expect(built.rows).toEqual(rows); expect(built.total_weight).toBe("9007199254741008");
    const root = await merkleRoot(await Promise.all(rows.map((r) => snapshotLeaf(address(r.wallet), BigInt(r.weight)))));
    expect(built.root_hex).toBe(Buffer.from(root).toString("hex"));
    expect((await canonicalPayoutSnapshot(rows)).rows_hash).toBe(built.rows_hash);
    for (const entry of built.entries) expect(await verifyOriginalSnapshotProof(entry.wallet, entry.weight, entry.proof, built.root_hex)).toBe(true);
  });
  it("proofs remain valid after live balances move; a new owner/weight does not inherit entitlement", async () => {
    const built = await canonicalPayoutSnapshot(rows);
    const original = built.entries[0];
    expect(await verifyOriginalSnapshotProof(A, original.weight, original.proof, built.root_hex)).toBe(true);
    expect(await verifyOriginalSnapshotProof(B, original.weight, original.proof, built.root_hex)).toBe(false);
    expect(await verifyOriginalSnapshotProof(A, "1", original.proof, built.root_hex)).toBe(false);
  });
  it.each([[], [{ wallet: A, weight: "0" }], [{ wallet: A, weight: "-1" }], [{ wallet: A, weight: "1.5" }], [{ wallet: A, weight: "01" }], [{ wallet: "bad", weight: "1" }], [rows[0], rows[0]], [{ wallet: A, weight: "18446744073709551616" }], [{ wallet: A, weight: "18446744073709551615" }, { wallet: B, weight: "1" }]].map((value) => [value]))("rejects ambiguous or unrepresentable canonical data", async (value: unknown) => {
    await expect(canonicalPayoutSnapshot(value)).rejects.toThrow();
  });
  it("handles a single investor with an empty valid proof", async () => {
    const built = await canonicalPayoutSnapshot([rows[0]]); expect(built.entries[0].proof).toEqual([]);
    expect(await verifyOriginalSnapshotProof(A, "10", [], built.root_hex)).toBe(true);
  });
});

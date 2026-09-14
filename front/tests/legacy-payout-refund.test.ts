import { describe, expect, it, vi } from "vitest";
import { address, createNoopSigner } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, findVaultPda, getPayoutVaultEncoder, getVaultVoteEncoder, getPrepareLegacyAccountDiscriminatorBytes, getClaimRefundInstructionDataDecoder, PayoutVaultState, VaultVoteOutcome } from "@/lib/generated/asset_registry";
import { canonicalPayoutSnapshot, snapshotBytes } from "@/lib/payout-snapshots";
import { readLegacyRefundState, legacyRefundInstructions } from "@/lib/legacy-payout-refund";
import { legacyVaultVotePda, vaultVotePda } from "@/lib/payout-vote-pda";
const A = address("11111111111111111111111111111111"), B = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const account = (data: Uint8Array) => ({ owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: [Buffer.from(data).toString("base64"), "base64"] });
async function fixture() {
  const canonical = await canonicalPayoutSnapshot([{ wallet: A, weight: "10" }, { wallet: B, weight: "20" }]);
  const vaultPda = (await findVaultPda({ sale: A }))[0];
  const v = account(new Uint8Array(getPayoutVaultEncoder().encode({ sale: A, shareClass: A, paymentMint: B, escrow: A, founder: B, raiseType: 0, totalAmount: 100, released: 25,
    startTs: 1, cliffMonths: 0, vestingMonths: 10, numTranches: 10, trancheAmount: 10, tranchesReleased: 2, updatesPosted: 2, lastUpdateTs: 10,
    founderYieldClaimable: 0, investorYieldPool: 0, investorYieldRoot: new Uint8Array(32), totalWeight: 30, state: PayoutVaultState.Cancelled,
    metadataHash: new Uint8Array(32), version: 1, bump: 255, voteRound: 0, votePending: false })).slice(0, -9));
  const w = account(new Uint8Array(getVaultVoteEncoder().encode({ payoutVault: vaultPda, snapshotRoot: snapshotBytes(canonical.root_hex), startTs: 1, endTs: 10, returnWeight: 30, extendWeight: 0, outcome: VaultVoteOutcome.ReturnCapital, version: 1, bump: 255, round: 0 })).slice(0, -8));
  const read = vi.fn<(...args: unknown[]) => Promise<{ context: { slot: bigint }; value: ReturnType<typeof account>[] }>>().mockResolvedValue({ context: { slot: BigInt(123) }, value: [v, w] });
  const rpc = { getMultipleAccounts: (...args: unknown[]) => ({ send: (...options: unknown[]) => read(...args, ...options) }) } as unknown as Parameters<typeof readLegacyRefundState>[0];
  return { canonical, vaultPda, rpc, read, v, w };
}
describe("original v1 return-capital exit", () => {
  it("reads the finalized original roundless vote without requiring live holder accounts", async () => {
    const f = await fixture(); const state = await readLegacyRefundState(f.rpc, f.vaultPda);
    expect(state.votePda).toBe(await legacyVaultVotePda(f.vaultPda)); expect(state.votePda).not.toBe(await vaultVotePda(f.vaultPda, BigInt(1)));
    expect(state.vault.totalAmount - state.vault.released).toBe(BigInt(75)); expect(f.read.mock.calls).toHaveLength(1);
  });
  it("atomically prepares the two legacy allocations then claims with the original investor proof", async () => {
    const f = await fixture(); const state = await readLegacyRefundState(f.rpc, f.vaultPda); const entry = f.canonical.entries[0];
    const ixs = await legacyRefundInstructions(state, createNoopSigner(A), B, A, BigInt(entry.weight), entry.proof.map(snapshotBytes));
    expect(ixs).toHaveLength(3);
    expect(Array.from(ixs[0].data)).toEqual(Array.from(getPrepareLegacyAccountDiscriminatorBytes()));
    expect(ixs[0].accounts[1].address).toBe(state.vaultPda); expect(ixs[1].accounts[1].address).toBe(state.votePda);
    expect(ixs[2].accounts[2].address).toBe(state.votePda);
    expect(getClaimRefundInstructionDataDecoder().decode(ixs[2].data)).toMatchObject({ weight: BigInt(10), proof: entry.proof.map(snapshotBytes) });
  });
  it("rejects a different wallet or substituted weight before building a claim", async () => {
    const f = await fixture(); const state = await readLegacyRefundState(f.rpc, f.vaultPda); const entry = f.canonical.entries[0];
    await expect(legacyRefundInstructions(state, createNoopSigner(B), B, A, BigInt(10), entry.proof.map(snapshotBytes))).rejects.toThrow(/original/);
    await expect(legacyRefundInstructions(state, createNoopSigner(A), B, A, BigInt(11), entry.proof.map(snapshotBytes))).rejects.toThrow(/original/);
  });
  it("rejects missing original account evidence", async () => {
    const f = await fixture(); f.read.mockResolvedValue({ context: { slot: BigInt(123) }, value: [f.v] });
    await expect(readLegacyRefundState(f.rpc, f.vaultPda)).rejects.toThrow(/Incomplete/);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { address } from "@solana/kit";
const mocks = vi.hoisted(() => ({ current: vi.fn(), publish: vi.fn() }));
vi.mock("@/lib/generated/asset_registry", async (original) => ({ ...await original<typeof import("@/lib/generated/asset_registry")>(), fetchMaybeVaultVote: mocks.current }));
vi.mock("@/lib/legacy-accounts-store", () => ({ publishLegacyPayoutVaults: mocks.publish }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
import { getPayoutVaultEncoder, getPayoutVaultDecoder, getShareClassEncoder, getShareClassDecoder, getVaultVoteEncoder, getVaultVoteDecoder,
  ASSET_REGISTRY_PROGRAM_ADDRESS, PayoutVaultState, VaultVoteOutcome, type PayoutVaultArgs } from "@/lib/generated/asset_registry";
import { decodeReadableShareClass, decodeReadablePayoutVault, decodeReadableVaultVote } from "@/lib/legacy-accounts";
import { loadPayoutVaults, loadVaultVoteHistory, currentVaultVote, vaultVoteActions, vaultVotePda, payoutVaultPda } from "@/lib/payout-vault";
import { indexerFixtures } from "./helpers/indexer-fixtures";
const KEY = address("11111111111111111111111111111111");
const SECOND = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const hash = new Uint8Array(32).fill(4);
function vaultArgs(): PayoutVaultArgs { return { sale: KEY, shareClass: KEY, paymentMint: KEY, escrow: KEY, founder: KEY, raiseType: 0,
  totalAmount: 100, released: 30, startTs: 1, cliffMonths: 0, vestingMonths: 10, numTranches: 10, trancheAmount: 10,
  tranchesReleased: 3, updatesPosted: 3, lastUpdateTs: 2, founderYieldClaimable: 4, investorYieldPool: 5, investorYieldRoot: hash,
  totalWeight: 90, state: PayoutVaultState.Frozen, metadataHash: hash, version: 2, bump: 255, voteRound: 3, votePending: true }; }
const vault = () => getPayoutVaultDecoder().decode(getPayoutVaultEncoder().encode(vaultArgs()));
const vote = (round = 3) => getVaultVoteDecoder().decode(getVaultVoteEncoder().encode({ payoutVault: KEY, snapshotRoot: hash, startTs: 10, endTs: 20, returnWeight: 5, extendWeight: 2, outcome: VaultVoteOutcome.Pending, version: 2, bump: 255, round }));
type Rpc = Parameters<typeof loadPayoutVaults>[0];
const rpc = (rows: unknown[]) => ({ getProgramAccounts: vi.fn(() => ({ send: async () => rows })) }) as unknown as Rpc;
const account = (pubkey: string, bytes: Uint8Array) => ({ pubkey, account: { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: [Buffer.from(bytes).toString("base64"), "base64"] } });
beforeEach(() => vi.clearAllMocks());
describe("explicit legacy read-only layout", () => {
  it("preserves exact v1 share-class prefix with unknown lifetime issuance, including old Option padding", () => {
    const f = indexerFixtures().find((f) => f.table === "share_classes")!;
    const full = new Uint8Array(getShareClassEncoder().encode({ ...getShareClassDecoder().decode(f.bytes), version: 1 }));
    for (const bytes of [full.slice(0, -9), full, new Uint8Array([...full.slice(0, -9), ...new Uint8Array(40)])]) {
      expect(decodeReadableShareClass(bytes)).toMatchObject({ version: 1, readonlyLegacy: true, lifetimeMinted: null, cumulativeCap: null, circulatingSupply: BigInt(9), lockedSupply: BigInt(4) });
    }
  });
  it("ignores dirty allocation after a v1 Option-bearing prefix without decoding it as a v2 boolean", () => {
    const original = getShareClassDecoder().decode(indexerFixtures().find((f) => f.table === "share_classes")!.bytes);
    const prefix = new Uint8Array(getShareClassEncoder().encode({ ...original, version: 1, convertibleTo: null, maxSupply: null })).slice(0, -9);
    const dirty = new Uint8Array(prefix.length + 50).fill(255); dirty.set(prefix);
    expect(decodeReadableShareClass(dirty)).toMatchObject({ version: 1, lifetimeMinted: null, cumulativeCap: null, circulatingSupply: BigInt(9) });
    const v = new Uint8Array(getPayoutVaultEncoder().encode({ ...vaultArgs(), version: 1 })).slice(0, -9);
    expect(decodeReadablePayoutVault(new Uint8Array([...v, ...new Uint8Array(9).fill(255)]))).toMatchObject({ voteRound: null, votePending: null });
  });
  it("reads only original v1 vote fields and rejects an incomplete prefix", () => {
    const bytes = new Uint8Array(getVaultVoteEncoder().encode({ ...vote(), version: 1 })).slice(0, -8);
    expect(decodeReadableVaultVote(new Uint8Array([...bytes, ...new Uint8Array(8).fill(255)]))).toMatchObject({ version: 1, round: null, snapshotRoot: hash });
    expect(() => decodeReadableVaultVote(bytes.slice(0, -1))).toThrow();
  });
  it("does not manufacture rounds/pending for a physically shorter v1 payout vault", () => {
    const bytes = new Uint8Array(getPayoutVaultEncoder().encode({ ...vaultArgs(), version: 1 })).slice(0, -9);
    expect(decodeReadablePayoutVault(bytes)).toMatchObject({ version: 1, readonlyLegacy: true, voteRound: null, votePending: null, totalAmount: BigInt(100), released: BigInt(30) });
    expect(() => decodeReadablePayoutVault(bytes.slice(0, -1))).toThrow();
  });
  it("rejects incomplete v2 and unsupported versions rather than filling missing financial fields", () => {
    const bytes = new Uint8Array(getPayoutVaultEncoder().encode(vaultArgs()));
    expect(() => decodeReadablePayoutVault(bytes.slice(0, -9))).toThrow();
    expect(() => decodeReadablePayoutVault(new Uint8Array(getPayoutVaultEncoder().encode({ ...vaultArgs(), version: 3 })))).toThrow(/Unsupported/);
  });
  it("keeps legacy vaults visible separately while admitting v2 to action forms", async () => {
    const legacy = new Uint8Array(getPayoutVaultEncoder().encode({ ...vaultArgs(), sale: SECOND, version: 1 })).slice(0, -9);
    const oldPda = await payoutVaultPda(SECOND); const newPda = await payoutVaultPda(KEY);
    const result = await loadPayoutVaults(rpc([account(oldPda, legacy), account(newPda, new Uint8Array(getPayoutVaultEncoder().encode(vaultArgs())))]));
    expect(result).toHaveLength(1); expect(result[0].vault.version).toBe(2);
    expect(mocks.publish).toHaveBeenCalledWith("devnet", [expect.objectContaining({ address: oldPda, vault: expect.objectContaining({ readonlyLegacy: true, voteRound: null }) })]);
  });
});
describe("round-specific payout vote actions and history", () => {
  it("derives distinct immutable vote addresses for each round and rejects round zero/overflow", async () => {
    expect(await vaultVotePda(KEY, BigInt(1))).not.toBe(await vaultVotePda(KEY, BigInt(2)));
    await expect(vaultVotePda(KEY, BigInt(0))).rejects.toThrow(); await expect(vaultVotePda(KEY, BigInt("18446744073709551616"))).rejects.toThrow();
  });
  it("allows voting/finalization only in the pending current round and correct time window", () => {
    const v = vault(); const w = vote();
    expect(vaultVoteActions(v, w, 15)).toEqual({ canOpen: false, canCast: true, canFinalize: false, canRefund: false });
    expect(vaultVoteActions(v, w, 20)).toMatchObject({ canCast: false, canFinalize: true });
    expect(vaultVoteActions(v, vote(2), 30)).toMatchObject({ canCast: false, canFinalize: false, canRefund: false });
    expect(vaultVoteActions({ ...v, votePending: false }, w, 30)).toMatchObject({ canOpen: true, canCast: false, canFinalize: false });
    expect(vaultVoteActions({ ...v, version: 1 }, w, 30)).toMatchObject({ canOpen: false, canCast: false, canFinalize: false, canRefund: false });
  });
  it("permits refund only after the current round returns capital and pending is cleared", () => {
    const v = { ...vault(), state: PayoutVaultState.Cancelled, votePending: false }; const w = { ...vote(), outcome: VaultVoteOutcome.ReturnCapital };
    expect(vaultVoteActions(v, w, 30).canRefund).toBe(true);
    expect(vaultVoteActions({ ...v, votePending: true }, w, 30).canRefund).toBe(false);
    expect(vaultVoteActions(v, { ...w, round: BigInt(2) }, 30).canRefund).toBe(false);
    expect(vaultVoteActions(v, { ...w, outcome: VaultVoteOutcome.Extend }, 30).canRefund).toBe(false);
  });
  it("verifies current vote owner, discriminator, vault and round before returning proof data", async () => {
    const w = vote(); mocks.current.mockResolvedValue({ exists: true, programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, data: w });
    expect((await currentVaultVote(rpc([]), KEY, BigInt(3)))?.vote).toBe(w);
    expect(mocks.current.mock.calls[0][2]).toMatchObject({ commitment: "finalized", abortSignal: expect.any(AbortSignal) });
    for (const changed of [{ ...w, round: BigInt(2) }, { ...w, payoutVault: SECOND }, { ...w, version: 1 }]) {
      mocks.current.mockResolvedValue({ exists: true, programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, data: changed });
      await expect(currentVaultVote(rpc([]), KEY, BigInt(3))).rejects.toThrow(/mismatch/);
    }
  });
  it("loads immutable historical rounds and rejects mismatched PDA history rows", async () => {
    const rows = await Promise.all([1, 3, 2].map(async (round) => account(await vaultVotePda(KEY, BigInt(round)), new Uint8Array(getVaultVoteEncoder().encode(vote(round))))));
    expect((await loadVaultVoteHistory(rpc(rows), KEY)).map((r) => r.vote.round)).toEqual([BigInt(3), BigInt(2), BigInt(1)]);
    rows[0].pubkey = SECOND; await expect(loadVaultVoteHistory(rpc(rows), KEY)).rejects.toThrow(/identity/);
  });
});

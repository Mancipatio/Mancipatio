import { beforeEach, describe, expect, it, vi } from "vitest";
import { address } from "@solana/kit";
const mocks = vi.hoisted(() => ({ current: vi.fn() }));
vi.mock("@/lib/generated/asset_registry", async (original) => ({ ...await original<typeof import("@/lib/generated/asset_registry")>(), fetchMaybeVaultVote: mocks.current }));
import { getPayoutVaultEncoder, getPayoutVaultDecoder, getShareClassEncoder, getShareClassDecoder, getVaultVoteEncoder, getVaultVoteDecoder,
  ASSET_REGISTRY_PROGRAM_ADDRESS, PayoutVaultState, VaultVoteOutcome, type PayoutVaultArgs } from "@/lib/generated/asset_registry";
import { decodePayoutVaultV2, decodeShareClassV2 } from "@/lib/account-versions";
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
describe("current-layout decoders fail closed (no v1 path)", () => {
  it("decodes a complete v2 payout vault", () => {
    expect(decodePayoutVaultV2(new Uint8Array(getPayoutVaultEncoder().encode(vaultArgs())))).toMatchObject({ version: 2, voteRound: BigInt(3), votePending: true });
  });
  it("rejects a truncated v2, version 3 and version 1 payout vault rather than filling missing fields", () => {
    const bytes = new Uint8Array(getPayoutVaultEncoder().encode(vaultArgs()));
    expect(() => decodePayoutVaultV2(bytes.slice(0, -9))).toThrow();
    expect(() => decodePayoutVaultV2(bytes.slice(0, -9))).not.toThrow(/Unsupported/);
    expect(() => decodePayoutVaultV2(new Uint8Array(getPayoutVaultEncoder().encode({ ...vaultArgs(), version: 3 })))).toThrow(/Unsupported PayoutVault version 3/);
    const v1 = new Uint8Array(getPayoutVaultEncoder().encode({ ...vaultArgs(), version: 1 }));
    // Both an original (physically shorter) v1 account and a padded one.
    expect(() => decodePayoutVaultV2(v1.slice(0, -9))).toThrow(/Unsupported PayoutVault version 1; the current program has no v1 path/);
    expect(() => decodePayoutVaultV2(v1)).toThrow(/Unsupported PayoutVault version 1/);
  });
  it("rejects a foreign discriminator and a v1 share class", () => {
    const bytes = new Uint8Array(getPayoutVaultEncoder().encode(vaultArgs())); bytes[0] ^= 1;
    expect(() => decodePayoutVaultV2(bytes)).toThrow(/discriminator/);
    expect(() => decodePayoutVaultV2(new Uint8Array(3))).toThrow(/discriminator/);
    const f = indexerFixtures().find((f) => f.table === "share_classes")!;
    expect(decodeShareClassV2(f.bytes).version).toBe(2);
    const v1 = new Uint8Array(getShareClassEncoder().encode({ ...getShareClassDecoder().decode(f.bytes), version: 1 }));
    expect(() => decodeShareClassV2(v1)).toThrow(/Unsupported ShareClass version 1/);
    expect(() => decodeShareClassV2(v1.slice(0, -9))).toThrow(/Unsupported ShareClass version 1/);
  });
  it("loadPayoutVaults rejects a v1 vault instead of hiding or showing it", async () => {
    const legacy = new Uint8Array(getPayoutVaultEncoder().encode({ ...vaultArgs(), sale: SECOND, version: 1 })).slice(0, -9);
    const oldPda = await payoutVaultPda(SECOND); const newPda = await payoutVaultPda(KEY);
    await expect(loadPayoutVaults(rpc([account(oldPda, legacy), account(newPda, new Uint8Array(getPayoutVaultEncoder().encode(vaultArgs())))]))).rejects.toThrow(/Unsupported PayoutVault version 1/);
    const result = await loadPayoutVaults(rpc([account(newPda, new Uint8Array(getPayoutVaultEncoder().encode(vaultArgs())))]));
    expect(result).toHaveLength(1); expect(result[0].vault.version).toBe(2);
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

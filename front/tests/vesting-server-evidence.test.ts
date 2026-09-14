import { beforeEach, describe, it, expect, vi } from "vitest";
import { address, getBase58Decoder, type Address } from "@solana/kit";
import {
  getMintEncoder,
  getTokenEncoder,
  AccountState,
} from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getVestingSeriesEncoder,
  getEscrowIdentityEncoder,
  findCreateVestingSeriesIdentityPda,
  getVestingPositionEncoder,
  findSeriesPda,
  findPositionPda,
  findCreateVestingSeriesEscrowPda,
  VestingSeriesStatus,
  VestingTimingMode,
  VestingDeliveryMode,
} from "@/lib/generated/asset_registry";
import { hashVestingTerms } from "@/lib/vesting-terms";
import { TOKEN_2022 } from "@/lib/transaction-builders";
import type { VestingCreationIntent } from "@/lib/vesting-creation";
const mocks = vi.hoisted(() => ({ rpc: null as unknown }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => mocks.rpc }));
import { readVestingCreationState } from "@/lib/server/vesting-creation";
const key = (n: number) =>
  address(getBase58Decoder().decode(new Uint8Array(32).fill(n)));
let row: VestingCreationIntent;
let chain: Record<string, { owner: Address; data: Uint8Array }>;
let seriesData: Parameters<
  ReturnType<typeof getVestingSeriesEncoder>["encode"]
>[0];
let position: Address;
function putSeries() {
  chain[row.series_pda!] = {
    owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: new Uint8Array(getVestingSeriesEncoder().encode(seriesData)),
  };
}
beforeEach(async () => {
  const [pda] = await findSeriesPda({ authority: key(1), seriesId: BigInt(5) }),
    [escrow] = await findCreateVestingSeriesEscrowPda({ series: pda });
  [position] = await findPositionPda({ series: pda, positionIndex: 0 });
  row = {
    id: "10000000-0000-4000-8000-000000000001",
    network: "devnet",
    client_wallet: key(1),
    token_mint: key(2),
    token_label: "Token",
    timing_mode: "auto",
    delivery_mode: "claim",
    approval_window_secs: 0,
    recovery_enabled: false,
    cancellation_enabled: true,
    pre_cliff_bps: 0,
    schedule: [{ unlock_ts: 2000000000, amount: "10" }],
    recipients: [{ wallet: key(3), allocation: "10" }],
    series_id: "5",
    series_pda: pda,
    escrow,
    approved_terms_hash: null,
    creation_terms_hash: null,
  };
  row.approved_terms_hash = await hashVestingTerms(row);
  row.creation_terms_hash = row.approved_terms_hash;
  seriesData = {
    authority: key(1),
    tokenMint: key(2),
    escrow,
    seriesId: BigInt(5),
    totalAllocated: BigInt(10),
    deposited: BigInt(0),
    totalReleased: BigInt(0),
    timingMode: VestingTimingMode.Auto,
    deliveryMode: VestingDeliveryMode.Claim,
    status: VestingSeriesStatus.Active,
    approvalWindowSecs: BigInt(0),
    recoveryEnabled: false,
    cancellationEnabled: true,
    preCliffBps: 0,
    approvedMask: BigInt(0),
    cancelledAt: BigInt(0),
    finalCumulative: BigInt(0),
    positionsCount: 1,
    createdAt: BigInt(100),
    version: 2,
    bump: 1,
    tranches: [{ unlockTs: BigInt(2000000000), amount: BigInt(10) }],
  };
  const [identityPda] = await findCreateVestingSeriesIdentityPda({
    series: pda,
  });
  chain = {
    [identityPda]: {
      owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: Uint8Array.from(
        getEscrowIdentityEncoder().encode({
          refundOwner: key(1),
          ownDeposited: 0,
          ownRefunded: 0,
          bump: 1,
        }),
      ),
    },
    [key(2)]: {
      owner: TOKEN_2022,
      data: new Uint8Array(
        getMintEncoder().encode({
          mintAuthority: key(1),
          supply: BigInt(100),
          decimals: 6,
          isInitialized: true,
          freezeAuthority: null,
          extensions: null,
        }),
      ),
    },
    [escrow]: {
      owner: TOKEN_2022,
      data: new Uint8Array(
        getTokenEncoder().encode({
          mint: key(2),
          owner: pda,
          amount: BigInt(0),
          delegate: null,
          state: AccountState.Initialized,
          isNative: null,
          delegatedAmount: BigInt(0),
          closeAuthority: null,
          extensions: [{ __kind: "ImmutableOwner" }],
        }),
      ),
    },
    [position]: {
      owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: new Uint8Array(
        getVestingPositionEncoder().encode({
          series: pda,
          index: 0,
          wallet: key(3),
          allocation: BigInt(10),
          released: BigInt(0),
          version: 2,
          bump: 1,
        }),
      ),
    },
  };
  putSeries();
  function account(key: Address) {
    const a = chain[key];
    return a
      ? {
          data: [Buffer.from(a.data).toString("base64"), "base64"],
          owner: a.owner,
          executable: false,
          lamports: BigInt(1),
          space: BigInt(a.data.length),
          rentEpoch: BigInt(0),
        }
      : null;
  }
  mocks.rpc = {
    getAccountInfo: vi.fn((key: Address) => ({
      send: async () => ({
        context: { slot: BigInt(100) },
        value: account(key),
      }),
    })),
    getMultipleAccounts: vi.fn((keys: Address[]) => ({
      send: async () => ({
        context: { slot: BigInt(100) },
        value: keys.map(account),
      }),
    })),
  };
});
describe("finalized server comparison uses real SDK account decoding", () => {
  it("accepts a complete unfunded finalized series and checks every account at finalized commitment", async () => {
    const result = await readVestingCreationState(row, true, BigInt(90));
    expect(result?.deposited).toBe(BigInt(0));
    const rpc = mocks.rpc as {
      getAccountInfo: ReturnType<typeof vi.fn>;
      getMultipleAccounts: ReturnType<typeof vi.fn>;
    };
    expect(rpc.getMultipleAccounts).toHaveBeenCalledWith(
      [position],
      expect.objectContaining({
        commitment: "finalized",
        minContextSlot: BigInt(90),
      }),
    );
  });
  it("rejects a correct authority and mint with altered schedule/approval/recovery terms", async () => {
    for (const change of [
      { preCliffBps: 100 },
      { recoveryEnabled: true },
      { approvalWindowSecs: BigInt(1) },
      { tranches: [{ unlockTs: BigInt(2000000001), amount: BigInt(10) }] },
    ]) {
      const original = { ...seriesData };
      seriesData = { ...seriesData, ...change };
      putSeries();
      await expect(readVestingCreationState(row, true)).rejects.toThrow(
        /approved/,
      );
      seriesData = original;
    }
  });
  it("rejects wrong owner, incomplete positions and a wrong escrow token program", async () => {
    delete chain[position];
    await expect(readVestingCreationState(row, true)).rejects.toThrow(
      /position/,
    );
    chain[position] = {
      owner: key(20),
      data: new Uint8Array(
        getVestingPositionEncoder().encode({
          series: address(row.series_pda!),
          index: 0,
          wallet: key(3),
          allocation: BigInt(10),
          released: BigInt(0),
          version: 2,
          bump: 1,
        }),
      ),
    };
    await expect(readVestingCreationState(row, true)).rejects.toThrow(/owner/);
    chain[position].owner = ASSET_REGISTRY_PROGRAM_ADDRESS;
    chain[row.escrow!].owner = key(20);
    await expect(readVestingCreationState(row, true)).rejects.toThrow(/Escrow/);
  });
  it("rejects tampered request hashes and pending Draft state, and fails closed on RPC outage", async () => {
    await expect(
      readVestingCreationState({ ...row, network: "mainnet" }, true),
    ).rejects.toThrow(/fresh review/);
    seriesData.status = VestingSeriesStatus.Draft;
    putSeries();
    await expect(readVestingCreationState(row, true)).rejects.toThrow(
      /finalized first/,
    );
    mocks.rpc = {
      getAccountInfo: () => ({
        send: async () => {
          throw new Error("provider unavailable");
        },
      }),
    };
    await expect(readVestingCreationState(row, true)).rejects.toThrow(
      /unavailable/,
    );
  });
});

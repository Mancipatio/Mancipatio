import { beforeEach, describe, expect, it, vi } from "vitest";
import { address, createNoopSigner } from "@solana/kit";
const mocks = vi.hoisted(() => ({ account: vi.fn() }));
vi.mock("@solana/kit", async (original) => ({
  ...(await original<typeof import("@solana/kit")>()),
  fetchEncodedAccount: mocks.account,
}));
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getShareClassDecoder,
  getShareClassEncoder,
  parsePrepareLegacyAccountInstruction,
} from "@/lib/generated/asset_registry";
import { buildLegacyPreparation } from "@/lib/legacy-preparation";
import { findShareClassPda } from "@/lib/pdas";
import { indexerFixtures } from "./helpers/indexer-fixtures";
const payer = createNoopSigner(address("11111111111111111111111111111111")),
  rpc = {} as Parameters<typeof buildLegacyPreparation>[0];
beforeEach(() => vi.clearAllMocks());
describe("explicit legacy preparation builder", () => {
  it("accepts original full-option v1 bytes and only emits the rent/size preparation instruction", async () => {
    const sample = getShareClassDecoder().decode(
      indexerFixtures().find((f) => f.table === "share_classes")!.bytes,
    );
    const bytes = new Uint8Array(
        getShareClassEncoder().encode({ ...sample, version: 1 }),
      ).slice(0, -9),
      pda = await findShareClassPda(sample.asset, sample.classIndex);
    mocks.account.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: bytes,
    });
    const ix = await buildLegacyPreparation(rpc, pda, payer);
    expect(
      parsePrepareLegacyAccountInstruction(ix).accounts.legacyAccount.address,
    ).toBe(pda);
    expect(ix.data).toHaveLength(8);
    expect(mocks.account.mock.calls[0][2]).toMatchObject({
      commitment: "finalized",
    });
    expect(bytes).toEqual(
      new Uint8Array(
        getShareClassEncoder().encode({ ...sample, version: 1 }),
      ).slice(0, -9),
    );
  });
  it("rejects v2, foreign program ownership and a mismatched original PDA", async () => {
    const sample = getShareClassDecoder().decode(
        indexerFixtures().find((f) => f.table === "share_classes")!.bytes,
      ),
      pda = await findShareClassPda(sample.asset, sample.classIndex);
    mocks.account.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: new Uint8Array(getShareClassEncoder().encode(sample)),
    });
    await expect(buildLegacyPreparation(rpc, pda, payer)).rejects.toThrow(
      /original v1/,
    );
    mocks.account.mockResolvedValue({
      exists: true,
      programAddress: payer.address,
      data: new Uint8Array(
        getShareClassEncoder().encode({ ...sample, version: 1 }),
      ),
    });
    await expect(buildLegacyPreparation(rpc, pda, payer)).rejects.toThrow(
      /another program/,
    );
    mocks.account.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: new Uint8Array(
        getShareClassEncoder().encode({ ...sample, version: 1 }),
      ),
    });
    await expect(
      buildLegacyPreparation(rpc, payer.address, payer),
    ).rejects.toThrow(/PDA/);
  });
});

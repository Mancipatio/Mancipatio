import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const calls = vi.hoisted(() => ({ asset: vi.fn(), issuer: vi.fn(), assetPda: vi.fn(), issuerPda: vi.fn() }));
vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/generated/asset_registry", () => ({
  ASSET_REGISTRY_PROGRAM_ADDRESS: "BPFLoaderUpgradeab1e11111111111111111111111",
  fetchMaybeAsset: calls.asset, fetchMaybeIssuer: calls.issuer,
  findAssetPda: calls.assetPda, findIssuerPda: calls.issuerPda,
  getAssetDiscriminatorBytes: () => new Uint8Array(8).fill(1),
  getIssuerDiscriminatorBytes: () => new Uint8Array(8).fill(2),
}));
import { requireProfileOwner } from "@/lib/server/profile-read";

const WALLET = "11111111111111111111111111111111";
const PDA = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ISSUER = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const PROGRAM = "BPFLoaderUpgradeab1e11111111111111111111111";
const asset = () => ({ exists: true, programAddress: PROGRAM, data: { discriminator: new Uint8Array(8).fill(1), issuer: ISSUER, assetId: "asset-1" } });
const issuer = () => ({ exists: true, programAddress: PROGRAM, data: { discriminator: new Uint8Array(8).fill(2), authority: WALLET, legalEntityId: new Uint8Array(32) } });
beforeEach(() => {
  vi.clearAllMocks(); calls.asset.mockResolvedValue(asset()); calls.issuer.mockResolvedValue(issuer());
  calls.assetPda.mockResolvedValue([PDA]); calls.issuerPda.mockResolvedValue([ISSUER]);
});

describe("on-chain private profile ownership", () => {
  it("accepts the actual authority only after verifying both program-owned derived accounts", async () => {
    await expect(requireProfileOwner(WALLET, PDA, "asset")).resolves.toBeUndefined();
    expect(calls.assetPda).toHaveBeenCalledWith({ issuer: ISSUER, assetId: "asset-1" });
    expect(calls.issuerPda).toHaveBeenCalled();
  });
  it.each(["owner", "discriminator", "pda", "authority"])("rejects a mismatching issuer %s", async (mismatch) => {
    const row = issuer();
    if (mismatch === "owner") row.programAddress = WALLET;
    if (mismatch === "discriminator") row.data.discriminator = new Uint8Array(8);
    if (mismatch === "authority") row.data.authority = PDA;
    if (mismatch === "pda") calls.issuerPda.mockResolvedValue([WALLET]);
    calls.issuer.mockResolvedValue(row);
    await expect(requireProfileOwner(WALLET, ISSUER, "issuer")).rejects.toMatchObject({ status: 403 });
  });
  it.each(["owner", "discriminator", "pda"])("rejects a mismatching asset %s before checking its alleged issuer", async (mismatch) => {
    const row = asset();
    if (mismatch === "owner") row.programAddress = WALLET;
    if (mismatch === "discriminator") row.data.discriminator = new Uint8Array(8);
    if (mismatch === "pda") calls.assetPda.mockResolvedValue([WALLET]);
    calls.asset.mockResolvedValue(row);
    await expect(requireProfileOwner(WALLET, PDA, "asset")).rejects.toMatchObject({ status: 403 });
    expect(calls.issuer).not.toHaveBeenCalled();
  });
  it("fails closed on missing accounts and RPC errors", async () => {
    calls.asset.mockResolvedValue({ exists: false });
    await expect(requireProfileOwner(WALLET, PDA, "asset")).rejects.toMatchObject({ status: 403 });
    calls.asset.mockRejectedValue(new Error("RPC down"));
    await expect(requireProfileOwner(WALLET, PDA, "asset")).rejects.toMatchObject({ status: 503 });
  });
});

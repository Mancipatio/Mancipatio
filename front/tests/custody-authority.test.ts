import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNoopSigner, getAddressDecoder } from "@solana/kit";
const mocks = vi.hoisted(() => ({
  vault: vi.fn(),
  platform: vi.fn(),
  transfer: vi.fn(),
  admin: vi.fn(),
}));
vi.mock("@/lib/closed-account", () => ({
  fetchMaybeLiveCustodyVault: mocks.vault,
}));
vi.mock("@/lib/generated/asset_registry", async (original) => ({
  ...(await original<typeof import("@/lib/generated/asset_registry")>()),
  fetchMaybeCustodyVault: mocks.vault,
  fetchMaybePlatform: mocks.platform,
  fetchMaybeAuthorityTransfer: mocks.transfer,
  fetchMaybeAdmin: mocks.admin,
}));
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findAdminRecordPda,
  parseProposeCustodyAuthorityInstruction,
  parseAcceptCustodyAuthorityInstruction,
} from "@/lib/generated/asset_registry";
import { findCustodyVaultPda } from "@/lib/pdas";
import {
  custodyAuthorityRecord,
  buildCustodyAuthorityChange,
} from "@/lib/custody-authority";
const key = (n: number) =>
  getAddressDecoder().decode(new Uint8Array(32).fill(n));
const operator = key(1),
  next = key(2),
  superAdmin = key(3),
  shareClass = key(4),
  rpc = {} as Parameters<typeof custodyAuthorityRecord>[0];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.vault.mockResolvedValue({
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: { authority: operator, shareClass, vaultId: BigInt(4) },
  });
  mocks.platform.mockResolvedValue({
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: { admin: superAdmin },
  });
  mocks.transfer.mockResolvedValue({ exists: false });
  mocks.admin.mockResolvedValue({
    exists: true,
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: { admin: next },
  });
});
describe("custody operator proof and two-step rotation", () => {
  it("derives from current operator without requiring an admin record that a deadline exit may outlive", async () => {
    const vault = await findCustodyVaultPda(shareClass, BigInt(4));
    expect(await custodyAuthorityRecord(rpc, vault)).toBe(
      (await findAdminRecordPda({ authority: operator }))[0],
    );
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.vault.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { authority: next, shareClass, vaultId: BigInt(4) },
    });
    expect(await custodyAuthorityRecord(rpc, vault)).toBe(
      (await findAdminRecordPda({ authority: next }))[0],
    );
  });
  it("constructs separate proposal and acceptance with the live role and vault identity", async () => {
    const vault = await findCustodyVaultPda(shareClass, BigInt(4));
    const propose = await buildCustodyAuthorityChange(
      rpc,
      vault,
      createNoopSigner(superAdmin),
      "propose",
      next,
    );
    expect(
      parseProposeCustodyAuthorityInstruction(
        propose as Parameters<
          typeof parseProposeCustodyAuthorityInstruction
        >[0],
      ).data.newAuthority,
    ).toBe(next);
    mocks.transfer.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { target: vault, currentAuthority: operator, newAuthority: next },
    });
    const accept = await buildCustodyAuthorityChange(
      rpc,
      vault,
      createNoopSigner(next),
      "accept",
    );
    expect(
      parseAcceptCustodyAuthorityInstruction(
        accept as Parameters<typeof parseAcceptCustodyAuthorityInstruction>[0],
      ).accounts.newAuthority.address,
    ).toBe(next);
    await expect(
      buildCustodyAuthorityChange(
        rpc,
        vault,
        createNoopSigner(operator),
        "accept",
      ),
    ).rejects.toThrow(/proposed/);
  });
  it("rejects revoked replacement roles and stale or mismatched vaults", async () => {
    const vault = await findCustodyVaultPda(shareClass, BigInt(4));
    mocks.admin.mockResolvedValue({ exists: false });
    await expect(
      buildCustodyAuthorityChange(
        rpc,
        vault,
        createNoopSigner(superAdmin),
        "propose",
        next,
      ),
    ).rejects.toThrow(/current Admin/);
    await expect(custodyAuthorityRecord(rpc, key(9))).rejects.toThrow(
      /identity/,
    );
    mocks.transfer.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { target: vault, currentAuthority: next, newAuthority: operator },
    });
    await expect(
      buildCustodyAuthorityChange(
        rpc,
        vault,
        createNoopSigner(superAdmin),
        "propose",
        next,
      ),
    ).rejects.toThrow(/stale/);
  });
});

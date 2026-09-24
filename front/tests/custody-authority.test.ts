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
  VaultState,
} from "@/lib/generated/asset_registry";
import { findCustodyVaultPda } from "@/lib/pdas";
import {
  custodyAuthorityRecord,
  buildCustodyAuthorityChange,
  custodyAcceptBlocker,
  loadCustodyAuthority,
  CUSTODY_STALE_PROPOSAL,
} from "@/lib/custody-authority";
import { PROPOSAL_NOT_FINALIZED_HINT } from "@/lib/operational-authority";
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
    data: { authority: operator, shareClass, vaultId: BigInt(4), state: VaultState.Active },
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
      data: { authority: next, shareClass, vaultId: BigInt(4), state: VaultState.Active },
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
      data: { target: vault, currentAuthority: operator, newAuthority: next, proposedBy: superAdmin },
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
  it("an accept the finalized re-read cannot see yet names the finality lag", async () => {
    const vault = await findCustodyVaultPda(shareClass, BigInt(4));
    // No finalized proposal yet (the page listed it at `confirmed`).
    await expect(
      buildCustodyAuthorityChange(rpc, vault, createNoopSigner(next), "accept"),
    ).rejects.toThrow(PROPOSAL_NOT_FINALIZED_HINT);
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
    // A proposal of ANOTHER vault is not a stale proposal: it is invalid.
    mocks.transfer.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { target: key(9), currentAuthority: operator, newAuthority: next, proposedBy: superAdmin },
    });
    mocks.admin.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { admin: next },
    });
    await expect(
      buildCustodyAuthorityChange(rpc, vault, createNoopSigner(superAdmin), "propose", next),
    ).rejects.toThrow(/invalid/);
  });
});

describe("stale custody proposals (Talas 3.1 K10)", () => {
  const staleCases = [
    ["the vault operator changed", { currentAuthority: next, proposedBy: superAdmin }],
    ["the Super Admin changed", { currentAuthority: operator, proposedBy: key(7) }],
  ] as const;

  it.each(staleCases)("reports a proposal as stale when %s, instead of throwing", async (_label, fields) => {
    const vault = await findCustodyVaultPda(shareClass, BigInt(4));
    mocks.transfer.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { target: vault, newAuthority: key(8), ...fields },
    });
    const state = await loadCustodyAuthority(rpc, vault);
    expect(state.stale).toBe(true);
    expect(state.proposed).toBe(key(8));
    expect(state.proposedBy).toBe(fields.proposedBy);
    expect(state.vaultState).toBe(VaultState.Active);
  });

  it("a live proposal is not stale", async () => {
    const vault = await findCustodyVaultPda(shareClass, BigInt(4));
    mocks.transfer.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { target: vault, currentAuthority: operator, newAuthority: next, proposedBy: superAdmin },
    });
    expect((await loadCustodyAuthority(rpc, vault)).stale).toBe(false);
    mocks.transfer.mockResolvedValue({ exists: false });
    const none = await loadCustodyAuthority(rpc, vault);
    expect(none.stale).toBe(false);
    expect(none.proposed).toBeNull();
  });

  it("accept refuses a stale proposal; the Super Admin can re-propose over it", async () => {
    const vault = await findCustodyVaultPda(shareClass, BigInt(4));
    mocks.transfer.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { target: vault, currentAuthority: operator, newAuthority: next, proposedBy: key(7) },
    });
    await expect(
      buildCustodyAuthorityChange(rpc, vault, createNoopSigner(next), "accept"),
    ).rejects.toThrow(CUSTODY_STALE_PROPOSAL);
    const repropose = await buildCustodyAuthorityChange(
      rpc,
      vault,
      createNoopSigner(superAdmin),
      "propose",
      next,
    );
    expect(
      parseProposeCustodyAuthorityInstruction(
        repropose as Parameters<typeof parseProposeCustodyAuthorityInstruction>[0],
      ).data.newAuthority,
    ).toBe(next);
  });

  it("still throws for a wrong-owner proposal", async () => {
    const vault = await findCustodyVaultPda(shareClass, BigInt(4));
    mocks.transfer.mockResolvedValue({
      exists: true,
      programAddress: key(6),
      data: { target: vault, currentAuthority: operator, newAuthority: next, proposedBy: superAdmin },
    });
    await expect(loadCustodyAuthority(rpc, vault)).rejects.toThrow(/invalid/);
  });

  it("requires the vault to be Active or Triggered for accept and propose", async () => {
    const vault = await findCustodyVaultPda(shareClass, BigInt(4));
    mocks.transfer.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { target: vault, currentAuthority: operator, newAuthority: next, proposedBy: superAdmin },
    });
    mocks.vault.mockResolvedValue({
      exists: true,
      programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: { authority: operator, shareClass, vaultId: BigInt(4), state: VaultState.Triggered },
    });
    await expect(
      buildCustodyAuthorityChange(rpc, vault, createNoopSigner(next), "accept"),
    ).resolves.toBeDefined();
    for (const closed of [VaultState.Realized, VaultState.Reverted, VaultState.Expired, VaultState.Returned]) {
      mocks.vault.mockResolvedValue({
        exists: true,
        programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
        data: { authority: operator, shareClass, vaultId: BigInt(4), state: closed },
      });
      await expect(
        buildCustodyAuthorityChange(rpc, vault, createNoopSigner(next), "accept"),
      ).rejects.toThrow(/Active or Triggered/);
      await expect(
        buildCustodyAuthorityChange(rpc, vault, createNoopSigner(superAdmin), "propose", next),
      ).rejects.toThrow(/Active or Triggered/);
    }
  });

  it("custodyAcceptBlocker mirrors the accept constraints", () => {
    expect(custodyAcceptBlocker({ stale: false, vaultState: VaultState.Active, acceptorIsAdmin: true })).toBeNull();
    expect(custodyAcceptBlocker({ stale: true, vaultState: VaultState.Active, acceptorIsAdmin: true })).toBe(
      CUSTODY_STALE_PROPOSAL,
    );
    expect(custodyAcceptBlocker({ stale: false, vaultState: VaultState.Triggered, acceptorIsAdmin: false })).toMatch(
      /Admin record/,
    );
    expect(custodyAcceptBlocker({ stale: false, vaultState: VaultState.Realized, acceptorIsAdmin: true })).toMatch(
      /Realized/,
    );
  });
});

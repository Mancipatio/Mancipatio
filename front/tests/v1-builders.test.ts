// The v1.0.0-rc (8.3) builders: the proceeds exits with the issuer freeze and
// the payees' blocklist entries, the vesting release's recipient entry, the
// two-step Admin grant, the custody cancel and the recoveries by the upgrade
// authority. Chain reads are mocked; every PDA is compared with the generated
// helpers (through lib/pdas).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { address, createNoopSigner, type Address } from "@solana/kit";

const mocks = vi.hoisted(() => ({
  chain: vi.fn(),
  platform: vi.fn(),
  pendingAdmin: vi.fn(),
  admin: vi.fn(),
  platformRecovery: vi.fn(),
  blocklistAuthority: vi.fn(),
  blocklistRecovery: vi.fn(),
  vault: vi.fn(),
  proposal: vi.fn(),
}));
vi.mock("@/lib/issuer-authority", async (original) => ({
  ...(await original<object>()),
  resolveIssuerChain: mocks.chain,
}));
vi.mock("@/lib/closed-account", () => ({ fetchMaybeLiveCustodyVault: mocks.vault }));
vi.mock("@/lib/generated/asset_registry", async (original) => ({
  ...(await original<object>()),
  fetchMaybePlatform: mocks.platform,
  fetchMaybePendingAdmin: mocks.pendingAdmin,
  fetchMaybeAdmin: mocks.admin,
  fetchMaybePlatformRecovery: mocks.platformRecovery,
  fetchMaybeAuthorityProposal: mocks.proposal,
}));
vi.mock("@/lib/generated/transfer_hook", async (original) => ({
  ...(await original<object>()),
  fetchMaybeBlocklistAuthority: mocks.blocklistAuthority,
  fetchMaybeBlocklistRecovery: mocks.blocklistRecovery,
}));

import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  VaultState,
  findAdminRecordPda,
  findPlatformPda,
  getPendingAdminEncoder,
  parseAddAdminInstruction,
  parseCancelAdminProposalInstruction,
  parseCancelCustodyAuthorityTransferInstruction,
  parseCancelPlatformRecoveryInstruction,
  parseClaimFounderYieldInstruction,
  parseClaimVestedInstruction,
  parseCloseSaleInstruction,
  parseExecutePlatformRecoveryInstruction,
  parseOpenPayoutVaultInstruction,
  parseProposeAdminInstruction,
  parsePushVestedInstruction,
  parseReleasePayoutInstruction,
} from "@/lib/generated/asset_registry";
import {
  TRANSFER_HOOK_PROGRAM_ADDRESS,
  parseExecuteBlocklistRecoveryInstruction,
} from "@/lib/generated/transfer_hook";
import {
  buildClaimFounderYieldInstruction,
  buildCloseSaleInstruction,
  buildOpenPayoutVaultInstruction,
  buildReleasePayoutInstruction,
} from "@/lib/proceeds-exits";
import { buildVestingReleaseInstruction } from "@/lib/vesting-release";
import { STALE_ADMIN_PROPOSAL, buildAddAdmin, buildCancelAdminProposal, buildProposeAdmin, listPendingAdmins } from "@/lib/admin-grants";
import { proposalWindowState } from "@/lib/proposal-window";
import { buildCancelCustodyAuthorityTransfer } from "@/lib/custody-authority";
import { buildCancelRoleRecovery, buildExecuteRoleRecovery } from "@/lib/role-recovery";
import {
  findBlockEntryPda,
  findCustodyVaultPda,
  findIssuerFreezePda,
  findPendingAdminPda,
  findProgramDataPda,
} from "@/lib/pdas";

const key = (n: number) => address(["11111111111111111111111111111111", "Stake11111111111111111111111111111111111111", "Vote111111111111111111111111111111111111111", "Config1111111111111111111111111111111111111", "SysvarRent111111111111111111111111111111111", "SysvarC1ock11111111111111111111111111111111", "SysvarRecentB1ockHashes11111111111111111111", "SysvarS1otHashes111111111111111111111111111", "SysvarStakeHistory1111111111111111111111111", "AddressLookupTab1e1111111111111111111111111", "BPFLoaderUpgradeab1e11111111111111111111111", "ComputeBudget111111111111111111111111111111"][n]);
const rpc = {} as never;
const ISSUER = key(1), ASSET = key(2), SHARE_CLASS = key(3), WALLET = key(4), SA = key(5), UA = key(6), NEW = key(7);
const owned = (data: object, programAddress: Address = ASSET_REGISTRY_PROGRAM_ADDRESS) => ({ exists: true, programAddress, data });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chain.mockResolvedValue({ shareClass: SHARE_CLASS, asset: ASSET, issuer: ISSUER, issuerAuthority: WALLET });
  mocks.platform.mockResolvedValue(owned({ admin: SA, pauseFlags: 0 }));
  mocks.admin.mockResolvedValue({ exists: false });
  mocks.pendingAdmin.mockResolvedValue({ exists: false });
  mocks.platformRecovery.mockResolvedValue({ exists: false });
  mocks.blocklistRecovery.mockResolvedValue({ exists: false });
  mocks.proposal.mockResolvedValue({ exists: false });
});

describe("proceeds exits (D1 freeze, prog-novac-4 payees)", () => {
  const sale = { address: key(8), shareClass: SHARE_CLASS, proceeds: key(9), paymentMint: key(10) };

  it("close_sale names the share class, asset, the issuer's freeze and both parties' blocklist entries", async () => {
    const ix = await buildCloseSaleInstruction(rpc, {
      authority: createNoopSigner(WALLET),
      sale,
      destination: key(11),
      destinationOwner: WALLET,
      paymentTokenProgram: key(0),
    });
    const { accounts } = parseCloseSaleInstruction(ix as never);
    expect(accounts.platform.address).toBe((await findPlatformPda())[0]);
    expect(accounts.shareClass.address).toBe(SHARE_CLASS);
    expect(accounts.asset.address).toBe(ASSET);
    expect(accounts.issuerFreeze.address).toBe(await findIssuerFreezePda(ISSUER));
    expect(accounts.authorityBlockEntry.address).toBe(await findBlockEntryPda(WALLET));
    expect(accounts.destinationBlockEntry.address).toBe(await findBlockEntryPda(WALLET));
    expect(mocks.chain).toHaveBeenCalledWith(rpc, SHARE_CLASS);
  });

  it("open_payout_vault, release_payout and claim_founder_yield carry the freeze; the payouts the founder's entry", async () => {
    const open = parseOpenPayoutVaultInstruction(
      (await buildOpenPayoutVaultInstruction(rpc, { authority: createNoopSigner(WALLET), sale, paymentTokenProgram: key(0), metadataHash: new Uint8Array(32) })) as never,
    ).accounts;
    expect([open.shareClass.address, open.asset.address, open.issuerFreeze.address]).toEqual([SHARE_CLASS, ASSET, await findIssuerFreezePda(ISSUER)]);
    const exit = { vault: key(8), escrow: key(9), shareClass: SHARE_CLASS, paymentMint: key(10), founderAccount: key(11), paymentTokenProgram: key(0) };
    const release = parseReleasePayoutInstruction((await buildReleasePayoutInstruction(rpc, { ...exit, founder: WALLET })) as never).accounts;
    expect(release.issuerFreeze.address).toBe(await findIssuerFreezePda(ISSUER));
    expect(release.founderBlockEntry.address).toBe(await findBlockEntryPda(WALLET));
    const claim = parseClaimFounderYieldInstruction(
      (await buildClaimFounderYieldInstruction(rpc, { ...exit, founder: createNoopSigner(WALLET) })) as never,
    ).accounts;
    expect(claim.founder.address).toBe(WALLET);
    expect(claim.asset.address).toBe(ASSET);
    expect(claim.founderBlockEntry.address).toBe(await findBlockEntryPda(WALLET));
  });
});

describe("vesting release", () => {
  it.each(["claim", "push"] as const)("%s_vested names position.wallet's blocklist entry right after token_program", async (mode) => {
    const ix = await buildVestingReleaseInstruction({
      mode,
      signer: createNoopSigner(mode === "claim" ? WALLET : SA),
      series: key(8),
      position: key(9),
      positionIndex: 3,
      recipient: WALLET,
      tokenMint: key(10),
      escrow: key(11),
      recipientTokenAccount: key(1),
      tokenProgram: key(0),
    });
    const parsed = (mode === "claim" ? parseClaimVestedInstruction : parsePushVestedInstruction)(ix as never);
    expect(ix.accounts).toHaveLength(8);
    expect(parsed.accounts.recipientBlockEntry.address).toBe(await findBlockEntryPda(WALLET));
    expect(ix.accounts[7].address).toBe(await findBlockEntryPda(WALLET));
  });
});

describe("Admin grants (D3)", () => {
  it("propose_admin: the live Super Admin only, never for a key that already holds the role", async () => {
    const ix = await buildProposeAdmin(rpc, createNoopSigner(SA), NEW);
    const parsed = parseProposeAdminInstruction(ix as never);
    expect(parsed.accounts.superAdmin.address).toBe(SA);
    expect(parsed.accounts.pendingAdmin.address).toBe(await findPendingAdminPda(NEW));
    expect(parsed.data.newAdmin).toBe(NEW);
    await expect(buildProposeAdmin(rpc, createNoopSigner(WALLET), NEW)).rejects.toThrow(/Only the Super Admin/);
    await expect(buildProposeAdmin(rpc, createNoopSigner(SA), "11111111111111111111111111111111" as Address)).rejects.toThrow(/default/);
    mocks.admin.mockResolvedValue(owned({ admin: NEW }));
    await expect(buildProposeAdmin(rpc, createNoopSigner(SA), NEW)).rejects.toThrow(/already holds the Admin role/);
  });

  it("add_admin is signed by the proposed key, pays the proposer back, and refuses a stale grant", async () => {
    await expect(buildAddAdmin(rpc, createNoopSigner(NEW))).rejects.toThrow(/No Admin grant is staged/);
    mocks.pendingAdmin.mockResolvedValue(owned({ newAdmin: NEW, proposedBy: SA, proposedAt: BigInt(0), eta: BigInt(1), expiresAt: BigInt(2) }));
    const parsed = parseAddAdminInstruction((await buildAddAdmin(rpc, createNoopSigner(NEW))) as never);
    expect(parsed.accounts.newAdmin.address).toBe(NEW);
    expect(parsed.accounts.proposer.address).toBe(SA);
    expect(parsed.accounts.adminRecord.address).toBe((await findAdminRecordPda({ authority: NEW }))[0]);
    expect(parsed.data.newAdmin).toBe(NEW);
    mocks.pendingAdmin.mockResolvedValue(owned({ newAdmin: NEW, proposedBy: WALLET, proposedAt: BigInt(0), eta: BigInt(1), expiresAt: BigInt(2) }));
    await expect(buildAddAdmin(rpc, createNoopSigner(NEW))).rejects.toThrow(STALE_ADMIN_PROPOSAL);
  });

  it("the pending list carries the Platform flags: while bit 7 is open the grant is executable at once (util::effective_eta)", async () => {
    const [pda] = [await findPendingAdminPda(NEW)];
    const data = getPendingAdminEncoder().encode({ newAdmin: NEW, proposedBy: SA, proposedAt: 1_000, eta: 1_000 + 172_800, expiresAt: 1_000 + 172_800 + 1_209_600, version: 1, bump: 255 });
    const list = { getProgramAccounts: () => ({ send: async () => [{ pubkey: pda, account: { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: [Buffer.from(data).toString("base64"), "base64"] } }] }) } as never;
    mocks.platform.mockResolvedValue(owned({ admin: SA, pauseFlags: 0xff }));
    const [open] = await listPendingAdmins(list);
    expect(open.platformPauseFlags).toBe(0xff);
    expect(proposalWindowState(open, 1_010, { pauseFlags: open.platformPauseFlags, bootstrapWaived: true }).kind).toBe("open");
    // Without the flags the page showed the 48 h wait the program does not apply.
    expect(proposalWindowState(open, 1_010).kind).toBe("waiting");
    mocks.platform.mockResolvedValue(owned({ admin: SA, pauseFlags: 0x7f }));
    const [closed] = await listPendingAdmins(list);
    expect(proposalWindowState(closed, 1_010, { pauseFlags: closed.platformPauseFlags, bootstrapWaived: true }).kind).toBe("waiting");
  });

  it("cancel_admin_proposal: any canceller (the program decides), rent to the proposer, ProgramData named", async () => {
    mocks.pendingAdmin.mockResolvedValue(owned({ newAdmin: NEW, proposedBy: SA, proposedAt: BigInt(0), eta: BigInt(1), expiresAt: BigInt(2) }));
    const parsed = parseCancelAdminProposalInstruction((await buildCancelAdminProposal(rpc, createNoopSigner(UA), NEW)) as never);
    expect(parsed.accounts.canceller.address).toBe(UA);
    expect(parsed.accounts.proposer.address).toBe(SA);
    expect(parsed.accounts.programData.address).toBe(await findProgramDataPda());
    expect(parsed.accounts.cancellerAdminRecord.address).toBe((await findAdminRecordPda({ authority: UA }))[0]);
  });
});

describe("custody rotation cancel", () => {
  it("the Super Admin, or the vault operator while it holds an Admin record", async () => {
    const vaultPda = await findCustodyVaultPda(SHARE_CLASS, BigInt(1));
    mocks.vault.mockResolvedValue(owned({ shareClass: SHARE_CLASS, vaultId: BigInt(1), authority: WALLET, state: VaultState.Active }));
    mocks.proposal.mockResolvedValue(owned({ target: vaultPda, currentAuthority: WALLET, newAuthority: NEW, proposedBy: SA, expiresAt: BigInt(9) }));
    const bySa = parseCancelCustodyAuthorityTransferInstruction((await buildCancelCustodyAuthorityTransfer(rpc, vaultPda, createNoopSigner(SA))) as never);
    expect(bySa.accounts.proposer.address).toBe(SA);
    await expect(buildCancelCustodyAuthorityTransfer(rpc, vaultPda, createNoopSigner(WALLET))).rejects.toThrow(/live Admin role/);
    mocks.admin.mockResolvedValue(owned({ admin: WALLET }));
    await expect(buildCancelCustodyAuthorityTransfer(rpc, vaultPda, createNoopSigner(WALLET))).resolves.toBeDefined();
    await expect(buildCancelCustodyAuthorityTransfer(rpc, vaultPda, createNoopSigner(NEW))).rejects.toThrow(/Only the Super Admin or the vault's current custody operator/);
  });
});

describe("recoveries by the upgrade authority (D4)", () => {
  it("platform: cancel by the SA or the proposer; execute by the recovered key, which closes the old Admin record", async () => {
    const [platform] = await findPlatformPda();
    mocks.platformRecovery.mockResolvedValue(owned({ platform, currentAdmin: SA, newAdmin: NEW, proposedBy: UA, eta: BigInt(1), expiresAt: BigInt(2) }));
    const cancel = parseCancelPlatformRecoveryInstruction((await buildCancelRoleRecovery(rpc, "platform", createNoopSigner(SA))) as never);
    expect(cancel.accounts.proposer.address).toBe(UA);
    await expect(buildCancelRoleRecovery(rpc, "platform", createNoopSigner(WALLET))).rejects.toThrow(/current holder of the role or the upgrade authority/);
    const execute = parseExecutePlatformRecoveryInstruction((await buildExecuteRoleRecovery(rpc, "platform", createNoopSigner(NEW))) as never);
    expect(execute.accounts.oldAdminRecord.address).toBe((await findAdminRecordPda({ authority: SA }))[0]);
    expect(execute.accounts.programData.address).toBe(await findProgramDataPda());
    await expect(buildExecuteRoleRecovery(rpc, "platform", createNoopSigner(WALLET))).rejects.toThrow(/recovered key/);
    // Against a former Super Admin: stale, execute refused.
    mocks.platformRecovery.mockResolvedValue(owned({ platform, currentAdmin: WALLET, newAdmin: NEW, proposedBy: UA, eta: BigInt(1), expiresAt: BigInt(2) }));
    await expect(buildExecuteRoleRecovery(rpc, "platform", createNoopSigner(NEW))).rejects.toThrow(/Cancel it/);
  });

  it("blocklist: execute names the hook's ProgramData", async () => {
    mocks.blocklistAuthority.mockResolvedValue(owned({ authority: SA }, TRANSFER_HOOK_PROGRAM_ADDRESS));
    mocks.blocklistRecovery.mockResolvedValue(owned({ currentAuthority: SA, newAuthority: NEW, proposedBy: UA, eta: BigInt(1), expiresAt: BigInt(2) }, TRANSFER_HOOK_PROGRAM_ADDRESS));
    const execute = parseExecuteBlocklistRecoveryInstruction((await buildExecuteRoleRecovery(rpc, "blocklist", createNoopSigner(NEW))) as never);
    expect(execute.accounts.programData.address).toBe(await findProgramDataPda(TRANSFER_HOOK_PROGRAM_ADDRESS));
    expect(execute.accounts.proposer.address).toBe(UA);
  });
});

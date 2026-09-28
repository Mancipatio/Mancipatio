import { beforeEach, describe, expect, it, vi } from "vitest";
import { address, createNoopSigner, type Address } from "@solana/kit";
const mocks = vi.hoisted(() => ({
  platform: vi.fn(),
  issuer: vi.fn(),
  admin: vi.fn(),
  permission: vi.fn(),
  transfer: vi.fn(),
  hook: vi.fn(),
  hookTransfer: vi.fn(),
  recovery: vi.fn(),
  hookRecovery: vi.fn(),
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMaybePlatform: mocks.platform,
  fetchMaybeIssuer: mocks.issuer,
  fetchMaybeAdmin: mocks.admin,
  fetchMaybeIssuerPermissions: mocks.permission,
  fetchMaybeAuthorityProposal: mocks.transfer,
  fetchMaybePlatformRecovery: mocks.recovery,
}));
vi.mock("@/lib/generated/transfer_hook", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMaybeBlocklistAuthority: mocks.hook,
  fetchMaybeBlocklistAuthorityProposal: mocks.hookTransfer,
  fetchMaybeBlocklistRecovery: mocks.hookRecovery,
}));
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findPlatformPda,
  findAdminRecordPda,
  getSetIssuerPermissionsInstructionDataDecoder,
} from "@/lib/generated/asset_registry";
import { TRANSFER_HOOK_PROGRAM_ADDRESS } from "@/lib/generated/transfer_hook";
import {
  PROPOSAL_NOT_FINALIZED_HINT,
  RECOVERY_PENDING_BLOCKER,
  STALE_OPERATIONAL_PROPOSAL,
  assertBlocklistAuthority,
  buildAcceptOperationalAuthority,
  buildCancelOperationalAuthority,
  buildProposeOperationalAuthority,
  loadOperationalAuthority,
} from "@/lib/operational-authority";
import {
  parseCancelPlatformAdminTransferInstruction,
  parseAcceptPlatformAdminInstruction,
  findAcceptPlatformAdminRecoveryPda,
} from "@/lib/generated/asset_registry";
import { parseCancelBlocklistAuthorityTransferInstruction } from "@/lib/generated/transfer_hook";
import { findProgramDataPda } from "@/lib/pdas";
import {
  findIssuerPermissionsAddress,
  loadIssuerPermission,
  resolveIssuerPermission,
  buildSetIssuerPermissions,
} from "@/lib/issuer-permissions";
const current = address("11111111111111111111111111111111"),
  next = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  issuer = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
  rpc = {} as Parameters<typeof loadOperationalAuthority>[0];
const account = (
  data: object,
  owner: Address = ASSET_REGISTRY_PROGRAM_ADDRESS,
) => ({ exists: true, programAddress: owner, data });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.platform.mockResolvedValue(account({ admin: current }));
  mocks.issuer.mockResolvedValue(account({ authority: current }));
  mocks.admin.mockResolvedValue({ exists: false });
  mocks.permission.mockResolvedValue(
    account({ issuer, authority: current, capabilities: 2 }),
  );
  mocks.transfer.mockResolvedValue({ exists: false });
  mocks.hook.mockResolvedValue(
    account({ authority: current }, TRANSFER_HOOK_PROGRAM_ADDRESS),
  );
  mocks.hookTransfer.mockResolvedValue({ exists: false });
  mocks.recovery.mockResolvedValue({ exists: false });
  mocks.hookRecovery.mockResolvedValue({ exists: false });
});
describe("live operational authority builders", () => {
  it.each(["platform", "blocklist"] as const)(
    "requires current %s proposer and proposed accepting wallet",
    async (kind) => {
      const ix = await buildProposeOperationalAuthority(
        rpc,
        kind,
        createNoopSigner(current),
        next,
      );
      expect(ix.accounts[0].address).toBe(current);
      await expect(
        buildProposeOperationalAuthority(
          rpc,
          kind,
          createNoopSigner(next),
          issuer,
        ),
      ).rejects.toThrow("current operational");
      const [platform] = await findPlatformPda();
      if (kind === "platform")
        mocks.transfer.mockResolvedValue(
          account({
            target: platform,
            currentAuthority: current,
            newAuthority: next,
          }),
        );
      else
        mocks.hookTransfer.mockResolvedValue(
          account(
            { currentAuthority: current, newAuthority: next },
            TRANSFER_HOOK_PROGRAM_ADDRESS,
          ),
        );
      await expect(
        buildAcceptOperationalAuthority(rpc, kind, createNoopSigner(current)),
      ).rejects.toThrow("proposed");
      const accept = await buildAcceptOperationalAuthority(
        rpc,
        kind,
        createNoopSigner(next),
      );
      expect(accept.accounts[0].address).toBe(next);
      if (kind === "platform") {
        const [oldRecord] = await findAdminRecordPda({ authority: current }),
          [newRecord] = await findAdminRecordPda({ authority: next });
        expect(accept.accounts.slice(3, 5).map((a) => a.address)).toEqual([
          oldRecord,
          newRecord,
        ]);
      }
    },
  );
  it.each(["platform", "blocklist"] as const)(
    "an accept the finalized re-read cannot see yet names the finality lag (%s)",
    async (kind) => {
      // /account/roles lists the proposal at `confirmed`; the builder re-reads
      // at `finalized`, which has no proposal yet.
      await expect(
        buildAcceptOperationalAuthority(rpc, kind, createNoopSigner(next)),
      ).rejects.toThrow(PROPOSAL_NOT_FINALIZED_HINT);
    },
  );
  it.each(["platform", "blocklist"] as const)(
    "never proposes the default address as the next %s authority (K2/K3)",
    async (kind) => {
      mocks.platform.mockResolvedValue(account({ admin: next }));
      mocks.hook.mockResolvedValue(account({ authority: next }, TRANSFER_HOOK_PROGRAM_ADDRESS));
      await expect(
        buildProposeOperationalAuthority(rpc, kind, createNoopSigner(next), "11111111111111111111111111111111"),
      ).rejects.toThrow(/default/);
      expect(mocks.platform).not.toHaveBeenCalled();
      expect(mocks.hook).not.toHaveBeenCalled();
    },
  );
  // Intentional (8.3 review): a stale proposal is REPORTED, not thrown. v1's
  // executed recoveries retire a pending proposal by zeroing its
  // current_authority instead of closing it; the program still lets it be
  // cancelled and overwritten, so throwing here locked the new holder's panel
  // and builders. Only a wrong target or owner still throws.
  it("rejects cross-target and wrong-owner proposals; reports a stale one", async () => {
    const [target] = await findPlatformPda();
    mocks.transfer.mockResolvedValue(account({ target: issuer, currentAuthority: current, newAuthority: next, proposedBy: current }));
    await expect(loadOperationalAuthority(rpc, "platform")).rejects.toThrow("invalid");
    mocks.transfer.mockResolvedValue(account({ target, currentAuthority: next, newAuthority: issuer, proposedBy: next }));
    expect(await loadOperationalAuthority(rpc, "platform")).toMatchObject({ stale: true, proposed: issuer, proposedBy: next });
    mocks.hookTransfer.mockResolvedValue(account({ currentAuthority: next, newAuthority: issuer }, ASSET_REGISTRY_PROGRAM_ADDRESS));
    await expect(loadOperationalAuthority(rpc, "blocklist")).rejects.toThrow("invalid");
    mocks.platform.mockResolvedValue(
      account({ admin: current }, TRANSFER_HOOK_PROGRAM_ADDRESS),
    );
    await expect(loadOperationalAuthority(rpc, "platform")).rejects.toThrow(
      "owner",
    );
  });

  // execute_platform_recovery / execute_blocklist_recovery retire a pending
  // proposal: current_authority becomes 1111…1111 and the account stays.
  it.each(["platform", "blocklist"] as const)(
    "a %s proposal retired by a recovery: accept refused before signing, cancel and a new propose allowed",
    async (kind) => {
      const retired = address("11111111111111111111111111111111");
      const live = issuer; // the recovered holder
      const oldHolder = next;
      const [target] = await findPlatformPda();
      mocks.platform.mockResolvedValue(account({ admin: live }));
      mocks.hook.mockResolvedValue(account({ authority: live }, TRANSFER_HOOK_PROGRAM_ADDRESS));
      const wanted = address("SysvarRent111111111111111111111111111111111");
      if (kind === "platform")
        mocks.transfer.mockResolvedValue(account({ target, currentAuthority: retired, newAuthority: wanted, proposedBy: oldHolder, proposedAt: BigInt(1), eta: BigInt(2), expiresAt: BigInt(3) }));
      else
        mocks.hookTransfer.mockResolvedValue(account({ currentAuthority: retired, newAuthority: wanted, proposedAt: BigInt(1), expiresAt: BigInt(3) }, TRANSFER_HOOK_PROGRAM_ADDRESS));
      const state = await loadOperationalAuthority(rpc, kind);
      expect(state).toMatchObject({ current: live, proposed: wanted, stale: true });
      await expect(buildAcceptOperationalAuthority(rpc, kind, createNoopSigner(wanted))).rejects.toThrow(STALE_OPERATIONAL_PROPOSAL);
      // The live holder cancels it (platform: the rent returns to the old proposer).
      const cancel = await buildCancelOperationalAuthority(rpc, kind, createNoopSigner(live));
      if (kind === "platform") expect(parseCancelPlatformAdminTransferInstruction(cancel as never).accounts.proposer.address).toBe(oldHolder);
      else expect(parseCancelBlocklistAuthorityTransferInstruction(cancel as never).accounts.authority.address).toBe(live);
      // ... or overwrites it with a new proposal.
      const propose = await buildProposeOperationalAuthority(rpc, kind, createNoopSigner(live), next);
      expect(propose.accounts[0].address).toBe(live);
    },
  );
});
// v1.0.0-rc (8.3): proposals carry a window, a pending recovery by the
// upgrade authority refuses the accept, and both rotations can be cancelled.
describe("v1 proposal windows, recoveries and cancels", () => {
  const proposal = { currentAuthority: current, newAuthority: next, proposedBy: current, proposedAt: BigInt(10), eta: BigInt(172_810), expiresAt: BigInt(1_382_410) };

  it("reports the window: the bootstrap window waives the platform eta; the BA proposal has none", async () => {
    const [target] = await findPlatformPda();
    mocks.transfer.mockResolvedValue(account({ target, ...proposal }));
    expect(await loadOperationalAuthority(rpc, "platform")).toMatchObject({ proposed: next, proposedBy: current, eta: BigInt(172_810), expiresAt: BigInt(1_382_410), recoveryPending: false });
    mocks.platform.mockResolvedValue(account({ admin: current, pauseFlags: 0xff }));
    expect((await loadOperationalAuthority(rpc, "platform"))?.eta).toBe(BigInt(10));
    mocks.hookTransfer.mockResolvedValue(account({ currentAuthority: current, newAuthority: next, proposedAt: BigInt(5), expiresAt: BigInt(99) }, TRANSFER_HOOK_PROGRAM_ADDRESS));
    expect(await loadOperationalAuthority(rpc, "blocklist")).toMatchObject({ eta: BigInt(5), expiresAt: BigInt(99), proposedBy: current });
  });

  it.each(["platform", "blocklist"] as const)("a pending recovery against the live %s refuses the accept before signing", async (kind) => {
    const [target] = await findPlatformPda();
    mocks.transfer.mockResolvedValue(account({ target, ...proposal }));
    mocks.hookTransfer.mockResolvedValue(account({ currentAuthority: current, newAuthority: next }, TRANSFER_HOOK_PROGRAM_ADDRESS));
    if (kind === "platform") mocks.recovery.mockResolvedValue(account({ platform: target, currentAdmin: current, newAdmin: issuer }));
    else mocks.hookRecovery.mockResolvedValue(account({ currentAuthority: current, newAuthority: issuer }, TRANSFER_HOOK_PROGRAM_ADDRESS));
    await expect(buildAcceptOperationalAuthority(rpc, kind, createNoopSigner(next))).rejects.toThrow(RECOVERY_PENDING_BLOCKER);
    // A recovery against a former holder is not live.
    if (kind === "platform") mocks.recovery.mockResolvedValue(account({ platform: target, currentAdmin: issuer, newAdmin: issuer }));
    else mocks.hookRecovery.mockResolvedValue(account({ currentAuthority: issuer, newAuthority: issuer }, TRANSFER_HOOK_PROGRAM_ADDRESS));
    await expect(buildAcceptOperationalAuthority(rpc, kind, createNoopSigner(next))).resolves.toBeDefined();
  });

  it("the platform accept names the recovery PDA; the cancels name the proposer and ProgramData", async () => {
    const [target] = await findPlatformPda();
    mocks.transfer.mockResolvedValue(account({ target, ...proposal }));
    const accept = await buildAcceptOperationalAuthority(rpc, "platform", createNoopSigner(next));
    expect(parseAcceptPlatformAdminInstruction(accept as never).accounts.recovery.address).toBe((await findAcceptPlatformAdminRecoveryPda({ platform: target }))[0]);
    // Any Admin (the program checks the veto) cancels; the rent returns to the proposer.
    const cancel = await buildCancelOperationalAuthority(rpc, "platform", createNoopSigner(issuer));
    const parsed = parseCancelPlatformAdminTransferInstruction(cancel as never);
    expect(parsed.accounts.canceller.address).toBe(issuer);
    expect(parsed.accounts.proposer.address).toBe(current);
    expect(parsed.accounts.programData.address).toBe(await findProgramDataPda());
    // The BA cancels its own proposal only.
    mocks.hookTransfer.mockResolvedValue(account({ currentAuthority: current, newAuthority: next }, TRANSFER_HOOK_PROGRAM_ADDRESS));
    const ba = await buildCancelOperationalAuthority(rpc, "blocklist", createNoopSigner(current));
    expect(parseCancelBlocklistAuthorityTransferInstruction(ba as never).accounts.authority.address).toBe(current);
    await expect(buildCancelOperationalAuthority(rpc, "blocklist", createNoopSigner(next))).rejects.toThrow(/Connect the blocklist authority/);
    mocks.transfer.mockResolvedValue({ exists: false });
    await expect(buildCancelOperationalAuthority(rpc, "platform", createNoopSigner(current))).rejects.toThrow(/No authority proposal/);
  });
});

// Talas 3.1 K7/K8: blocklist and hook-mode builders re-check the live,
// finalized blocklist authority before building.
describe("assertBlocklistAuthority", () => {
  it("passes the live authority (signer or address) and reads at finalized", async () => {
    await expect(assertBlocklistAuthority(rpc, createNoopSigner(current))).resolves.toBe(current);
    await expect(assertBlocklistAuthority(rpc, current)).resolves.toBe(current);
    expect(mocks.hook.mock.calls[0][2]).toMatchObject({ commitment: "finalized" });
  });
  it("names the current authority when another wallet signs", async () => {
    await expect(assertBlocklistAuthority(rpc, createNoopSigner(next))).rejects.toThrow(
      `Connect the blocklist authority (current: ${current})`,
    );
  });
  it("refuses a missing or foreign-owned BlocklistAuthority", async () => {
    mocks.hook.mockResolvedValue({ exists: false });
    await expect(assertBlocklistAuthority(rpc, current)).rejects.toThrow("not initialized");
    mocks.hook.mockResolvedValue(account({ authority: current }, ASSET_REGISTRY_PROGRAM_ADDRESS));
    await expect(assertBlocklistAuthority(rpc, current)).rejects.toThrow("owner");
  });
  it("propagates an RPC failure (never passes on error)", async () => {
    mocks.hook.mockRejectedValue(new Error("rpc down"));
    await expect(assertBlocklistAuthority(rpc, current)).rejects.toThrow("rpc down");
  });
});
describe("issuer-scoped permission proofs", () => {
  it("uses issuer+current authority scoped proof and immediately observes revocation", async () => {
    const scoped = await findIssuerPermissionsAddress(issuer, current);
    expect(await resolveIssuerPermission(rpc, issuer, current, 2)).toBe(scoped);
    await expect(
      resolveIssuerPermission(rpc, issuer, current, 1),
    ).rejects.toThrow("required scoped");
    mocks.permission.mockResolvedValue(
      account({ issuer, authority: current, capabilities: 0 }),
    );
    await expect(
      resolveIssuerPermission(rpc, issuer, current, 2),
    ).rejects.toThrow("required scoped");
    expect(mocks.permission).toHaveBeenCalledTimes(3);
  });
  it("retains global Admin capability but never permits a different issuer signer", async () => {
    mocks.admin.mockResolvedValue(account({ admin: current }));
    expect(
      (await loadIssuerPermission(rpc, issuer, current)).capabilities,
    ).toBe(7);
    await expect(loadIssuerPermission(rpc, issuer, next)).rejects.toThrow(
      "current authority",
    );
  });
  it("rejects another issuer or owner in a scoped account", async () => {
    mocks.permission.mockResolvedValue(
      account({ issuer: next, authority: current, capabilities: 7 }),
    );
    await expect(loadIssuerPermission(rpc, issuer, current)).rejects.toThrow(
      "Invalid issuer",
    );
    mocks.permission.mockResolvedValue(
      account(
        { issuer, authority: current, capabilities: 7 },
        TRANSFER_HOOK_PROGRAM_ADDRESS,
      ),
    );
    await expect(loadIssuerPermission(rpc, issuer, current)).rejects.toThrow(
      "Invalid issuer",
    );
  });
  it("grants/revokes only through the live Super Admin, bound to issuer authority PDA", async () => {
    const ix = await buildSetIssuerPermissions(
      rpc,
      issuer,
      createNoopSigner(current),
      0,
    );
    expect(
      getSetIssuerPermissionsInstructionDataDecoder().decode(ix.data)
        .capabilities,
    ).toBe(0);
    expect(ix.accounts[3].address).toBe(
      await findIssuerPermissionsAddress(issuer, current),
    );
    mocks.platform.mockResolvedValue(account({ admin: next }));
    await expect(
      buildSetIssuerPermissions(rpc, issuer, createNoopSigner(current), 7),
    ).rejects.toThrow("current Super Admin");
    await expect(
      buildSetIssuerPermissions(rpc, issuer, createNoopSigner(next), 8),
    ).rejects.toThrow("Invalid issuer capability");
  });
});

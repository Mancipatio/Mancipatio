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
}));
vi.mock("@/lib/generated/asset_registry", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMaybePlatform: mocks.platform,
  fetchMaybeIssuer: mocks.issuer,
  fetchMaybeAdmin: mocks.admin,
  fetchMaybeIssuerPermissions: mocks.permission,
  fetchMaybeAuthorityTransfer: mocks.transfer,
}));
vi.mock("@/lib/generated/transfer_hook", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchMaybeBlocklistAuthority: mocks.hook,
  fetchMaybeBlocklistAuthorityTransfer: mocks.hookTransfer,
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
  assertBlocklistAuthority,
  buildAcceptOperationalAuthority,
  buildProposeOperationalAuthority,
  loadOperationalAuthority,
} from "@/lib/operational-authority";
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
  it("rejects cross-target, stale and wrong-owner proposals", async () => {
    const [target] = await findPlatformPda();
    for (const data of [
      { target: issuer, currentAuthority: current, newAuthority: next },
      { target, currentAuthority: next, newAuthority: issuer },
    ]) {
      mocks.transfer.mockResolvedValue(account(data));
      await expect(loadOperationalAuthority(rpc, "platform")).rejects.toThrow(
        "stale or invalid",
      );
    }
    mocks.platform.mockResolvedValue(
      account({ admin: current }, TRANSFER_HOOK_PROGRAM_ADDRESS),
    );
    await expect(loadOperationalAuthority(rpc, "platform")).rejects.toThrow(
      "owner",
    );
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

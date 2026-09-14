// lib/server/kyc-provider-gate.ts (e2e §4 × §5): the passport write-back
// routes must authorize against KycRegistry.authority, not Platform.admin —
// after a platform-admin rotation the provider is no longer the super admin
// but is still the only key that can send approve_holder / revoke_holder.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const chain = vi.hoisted(() => ({
  platform: vi.fn(),
  registries: vi.fn(),
  network: vi.fn(async () => {}),
  requireAdmin: vi.fn<(wallet: string) => Promise<void>>(),
}));

vi.mock("@/lib/server/rpc", () => ({ getServerRpc: () => ({}) }));
vi.mock("@/lib/network", () => ({ detectNetwork: () => "devnet" }));
vi.mock("@/lib/network-identity", () => ({ createNetworkVerifier: () => chain.network }));
vi.mock("@/lib/generated/asset_registry", () => ({
  ASSET_REGISTRY_PROGRAM_ADDRESS: "registry-program",
  fetchMaybePlatform: chain.platform,
  findPlatformPda: async () => ["platform"],
}));
vi.mock("@/lib/kyc-authority", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/kyc-authority")>();
  return { ...real, listKycRegistries: chain.registries };
});
vi.mock("@/lib/server/admin-gate", () => ({ requireAdmin: chain.requireAdmin }));

import { SiwsError } from "@/lib/server/siws";
import { requireAdminOrKycProvider, requireKycProvider } from "@/lib/server/kyc-provider-gate";

const PROVIDER = "11111111111111111111111111111111";
const NEW_ADMIN = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const STRANGER = "So11111111111111111111111111111111111111112";

const registryOf = (authority: string) => ({
  address: "registry-pda",
  registry: { authority },
});

beforeEach(() => {
  vi.clearAllMocks();
  chain.network.mockResolvedValue(undefined);
  // Post-rotation world: the platform admin moved, the registry did not.
  chain.platform.mockResolvedValue({
    exists: true,
    programAddress: "registry-program",
    data: { admin: NEW_ADMIN },
  });
  chain.registries.mockResolvedValue([registryOf(PROVIDER)]);
  chain.requireAdmin.mockImplementation(async (w: string) => {
    if (w !== NEW_ADMIN) throw new SiwsError(403, "Admin privileges required");
  });
});

describe("requireKycProvider", () => {
  it("authorizes the rotated provider even though it is no longer Platform.admin", async () => {
    await expect(requireKycProvider(PROVIDER)).resolves.toBeUndefined();
    expect(chain.platform.mock.calls[0][2]).toMatchObject({ commitment: "finalized" });
  });

  it("refuses the new super admin who never held the registry", async () => {
    await expect(requireKycProvider(NEW_ADMIN)).rejects.toMatchObject({
      status: 403,
      message: "KYC provider privileges required",
    });
  });

  it("refuses strangers and the pre-rotation case still works for the shared key", async () => {
    await expect(requireKycProvider(STRANGER)).rejects.toMatchObject({ status: 403 });
    chain.platform.mockResolvedValue({
      exists: true,
      programAddress: "registry-program",
      data: { admin: PROVIDER },
    });
    await expect(requireKycProvider(PROVIDER)).resolves.toBeUndefined();
  });

  it("fails closed when no registry exists", async () => {
    chain.registries.mockResolvedValue([]);
    await expect(requireKycProvider(PROVIDER)).rejects.toMatchObject({ status: 403 });
    await expect(requireKycProvider(NEW_ADMIN)).rejects.toMatchObject({ status: 403 });
  });

  it("fails closed when several registries exist and none belongs to the platform admin", async () => {
    chain.registries.mockResolvedValue([registryOf(PROVIDER), registryOf(STRANGER)]);
    await expect(requireKycProvider(PROVIDER)).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining("could not be resolved"),
    });
  });

  it("picks the registry owned by the platform admin when several exist", async () => {
    chain.registries.mockResolvedValue([registryOf(STRANGER), registryOf(NEW_ADMIN)]);
    await expect(requireKycProvider(NEW_ADMIN)).resolves.toBeUndefined();
    await expect(requireKycProvider(STRANGER)).rejects.toMatchObject({ status: 403 });
  });

  it("does not cache a positive answer across a registry change", async () => {
    await expect(requireKycProvider(PROVIDER)).resolves.toBeUndefined();
    chain.registries.mockResolvedValue([registryOf(STRANGER)]);
    await expect(requireKycProvider(PROVIDER)).rejects.toMatchObject({ status: 403 });
    expect(chain.registries).toHaveBeenCalledTimes(2);
  });

  it("returns 503 (never grants) on RPC / network-identity failure", async () => {
    chain.network.mockRejectedValueOnce(new Error("wrong cluster"));
    await expect(requireKycProvider(PROVIDER)).rejects.toMatchObject({ status: 503 });
    chain.registries.mockRejectedValueOnce(new Error("rpc down"));
    await expect(requireKycProvider(PROVIDER)).rejects.toMatchObject({ status: 503 });
    chain.platform.mockResolvedValueOnce({ exists: true, programAddress: "foreign", data: { admin: PROVIDER } });
    await expect(requireKycProvider(PROVIDER)).rejects.toMatchObject({ status: 503 });
  });
});

describe("requireAdminOrKycProvider", () => {
  it("admits an admin without consulting the registry", async () => {
    await expect(requireAdminOrKycProvider(NEW_ADMIN)).resolves.toBeUndefined();
    expect(chain.registries).not.toHaveBeenCalled();
  });

  it("admits the rotated provider that is no longer an admin", async () => {
    await expect(requireAdminOrKycProvider(PROVIDER)).resolves.toBeUndefined();
    expect(chain.requireAdmin).toHaveBeenCalledWith(PROVIDER);
    expect(chain.registries).toHaveBeenCalledTimes(1);
  });

  it("refuses a wallet that is neither", async () => {
    await expect(requireAdminOrKycProvider(STRANGER)).rejects.toMatchObject({
      status: 403,
      message: "Admin or KYC provider privileges required",
    });
  });

  it("propagates a 503 from the admin check instead of falling through", async () => {
    chain.requireAdmin.mockRejectedValueOnce(new SiwsError(503, "Authorization check unavailable — try again"));
    await expect(requireAdminOrKycProvider(PROVIDER)).rejects.toMatchObject({ status: 503 });
    expect(chain.registries).not.toHaveBeenCalled();
  });
});

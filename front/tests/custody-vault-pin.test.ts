import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const accounts = vi.hoisted(() => new Map<string, { data: Uint8Array; owner: string }>());
vi.mock("@/lib/server/rpc", () => ({
  getServerRpc: () => ({
    getAccountInfo: (addr: string) => ({
      send: async () => {
        const hit = accounts.get(addr);
        return {
          context: { slot: BigInt(10) },
          value: hit
            ? { data: [Buffer.from(hit.data).toString("base64"), "base64"], executable: false, lamports: BigInt(1), owner: hit.owner, rentEpoch: BigInt(0), space: BigInt(hit.data.length) }
            : null,
        };
      },
    }),
  }),
}));
import { getAddressDecoder } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getCustodyVaultEncoder,
  RealizeAction,
  VaultState,
  VaultType,
} from "@/lib/generated/asset_registry";
import { findCustodyVaultPda } from "@/lib/pdas";
import { requireRequestVault } from "@/lib/server/chain-evidence";

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const holder = key(1);
const shareClass = key(2);
const mint = key(3);
const escrow = key(4);
const platformRegistry = key(5);
const DEFAULT = "11111111111111111111111111111111";

async function linkVault(kycRegistry: string) {
  const vaultPda = await findCustodyVaultPda(shareClass, BigInt(7));
  accounts.set(vaultPda, {
    owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: new Uint8Array(
      getCustodyVaultEncoder().encode({
        shareClass, mint, escrow, vaultId: BigInt(7), authority: holder,
        vaultType: VaultType.DeliveryEscrow, realizeAction: RealizeAction.BurnAndAttest,
        amount: BigInt(5), state: VaultState.Active, deadline: BigInt(0),
        metadataHash: new Uint8Array(32).fill(1), beneficiary: holder,
        version: 2, bump: 255, deposited: BigInt(0), kycRegistry: kycRegistry as never,
      }),
    ),
  });
  return { holder_wallet: holder, share_class_pda: shareClass, mint, vault_pda: vaultPda, vault_id: 7, amount: 5 };
}

describe("requireRequestVault: KYC registry pin (2C-3)", () => {
  afterEach(() => {
    accounts.clear();
    vi.unstubAllEnvs();
  });
  it("rejects a vault pinned to another registry than NEXT_PUBLIC_KYC_REGISTRY", async () => {
    vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", platformRegistry);
    const row = await linkVault(key(6));
    await expect(requireRequestVault(row)).rejects.toMatchObject({ status: 400, message: "Custody vault is not pinned to the platform KYC registry" });
  });
  it("rejects an unpinned vault even without a configured pin", async () => {
    vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", "");
    const row = await linkVault(DEFAULT);
    await expect(requireRequestVault(row)).rejects.toMatchObject({ message: "Custody vault is not pinned to the platform KYC registry" });
  });
  it("lets a correctly pinned vault through to the escrow check", async () => {
    vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", platformRegistry);
    const row = await linkVault(platformRegistry);
    // No escrow account in the fake RPC: failing HERE proves the pin passed.
    await expect(requireRequestVault(row)).rejects.toMatchObject({ message: "Custody escrow does not match this request" });
  });
});

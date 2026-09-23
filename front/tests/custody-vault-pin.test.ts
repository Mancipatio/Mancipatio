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
  getKycEntryEncoder,
  getKycRegistryEncoder,
  KycStatus,
  RealizeAction,
  VaultState,
  VaultType,
} from "@/lib/generated/asset_registry";
import { findCustodyVaultPda } from "@/lib/pdas";
import { getEntryPda } from "@/lib/passport";
import { requireBeneficiaryPassport, requireRequestVault } from "@/lib/server/chain-evidence";

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
  const link = { requirePlatformPin: true };
  it("at link, rejects a vault pinned to another registry than NEXT_PUBLIC_KYC_REGISTRY", async () => {
    vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", platformRegistry);
    const row = await linkVault(key(6));
    await expect(requireRequestVault(row, undefined, link)).rejects.toMatchObject({ status: 400, message: "Custody vault is not pinned to the platform KYC registry" });
  });
  it.each([true, false])("rejects an unpinned vault even without a configured pin (link: %s)", async (requirePlatformPin) => {
    vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", "");
    const row = await linkVault(DEFAULT);
    await expect(requireRequestVault(row, undefined, { requirePlatformPin })).rejects.toMatchObject({ message: "Custody vault is not pinned to the platform KYC registry" });
  });
  it("lets a correctly pinned vault through to the escrow check", async () => {
    vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", platformRegistry);
    const row = await linkVault(platformRegistry);
    // No escrow account in the fake RPC: failing HERE proves the pin passed.
    await expect(requireRequestVault(row, undefined, link)).rejects.toMatchObject({ message: "Custody escrow does not match this request" });
  });
  it("after linking, a re-pointed or malformed platform pin does not strand deposit / return / outcome recording", async () => {
    const row = await linkVault(key(6));
    for (const pin of [platformRegistry, "not-an-address"]) {
      vi.stubEnv("NEXT_PUBLIC_KYC_REGISTRY", pin);
      await expect(requireRequestVault(row)).rejects.toMatchObject({ message: "Custody escrow does not match this request" });
    }
  });
});

describe("requireBeneficiaryPassport: KYC before the physical handover (2C-3)", () => {
  const NOW = 1_800_000_000;
  const JURISDICTION = 688;
  const bitmapWith = (code: number) => { const b = new Uint8Array(128); b[code >> 3] |= 1 << (code & 7); return b; };
  afterEach(() => accounts.clear());
  function setRegistry(approved: Uint8Array, blocked = new Uint8Array(128)) {
    accounts.set(platformRegistry, {
      owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: new Uint8Array(getKycRegistryEncoder().encode({ authority: key(9), approvedJurisdictions: approved, blockedJurisdictions: blocked, entriesCount: BigInt(1), version: 1, bump: 255 })),
    });
  }
  async function setEntry(status: KycStatus, expiry: number) {
    accounts.set(await getEntryPda(platformRegistry, holder), {
      owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: new Uint8Array(getKycEntryEncoder().encode({ registry: platformRegistry, holder, status, jurisdiction: JURISDICTION, accreditationLevel: 0, expiry: BigInt(expiry), providerId: 0, externalRefHash: new Uint8Array(32), version: 1, bump: 255 })),
    });
  }
  const vault = { beneficiary: holder, kycRegistry: platformRegistry };
  it("passes an Approved, unexpired, jurisdiction-allowed passport", async () => {
    setRegistry(bitmapWith(JURISDICTION));
    await setEntry(KycStatus.Approved, NOW + 60);
    await expect(requireBeneficiaryPassport(vault, NOW)).resolves.toBeUndefined();
  });
  it.each([
    ["missing", null, NOW + 60, bitmapWith(JURISDICTION)],
    ["revoked", KycStatus.Revoked, NOW + 60, bitmapWith(JURISDICTION)],
    ["expired (expiry == now)", KycStatus.Approved, NOW, bitmapWith(JURISDICTION)],
    ["jurisdiction not allowed", KycStatus.Approved, NOW + 60, bitmapWith(1)],
  ] as const)("refuses the handover when the passport is %s", async (_label, status, expiry, approved) => {
    setRegistry(approved);
    if (status !== null) await setEntry(status, expiry);
    await expect(requireBeneficiaryPassport(vault, NOW)).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/approved investor passport/) });
  });
  it("refuses an unpinned vault", async () => {
    await expect(requireBeneficiaryPassport({ beneficiary: holder, kycRegistry: DEFAULT }, NOW)).rejects.toMatchObject({ status: 409 });
  });
});

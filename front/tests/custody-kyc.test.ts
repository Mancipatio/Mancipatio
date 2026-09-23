import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { address, createNoopSigner, getAddressDecoder } from "@solana/kit";
import {
  ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_MISMATCH,
  ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_NOT_ALLOWED,
  ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_REQUIRED,
  ASSET_REGISTRY_ERROR__RECEIVER_NOT_APPROVED,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findKycEntryPda,
  getCustodyVaultSize,
  getKycEntryEncoder,
  getKycRegistryEncoder,
  getRealizeCustodyVaultInstructionAsync,
  KycStatus,
  VaultType,
} from "@/lib/generated/asset_registry";
import {
  DEFAULT_PUBKEY,
  evaluatePassport,
  loadBeneficiaryPassport,
  passportShortcutHref,
  pinnedRegistryWarning,
  realizeKycAccounts,
} from "@/lib/custody-kyc";
import { explainSendError } from "@/lib/tx-error";

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const NOW = 1_800_000_000;
const JURISDICTION = 688; // Serbia — byte 86, bit 0
const bitmapWith = (...codes: number[]) => {
  const map = new Uint8Array(128);
  for (const c of codes) map[c >> 3] |= 1 << (c & 7);
  return map;
};
const allowAll = { approvedJurisdictions: new Uint8Array(128).fill(0xff), blockedJurisdictions: new Uint8Array(128) };
const approved = { status: KycStatus.Approved, expiry: BigInt(NOW + 3600), jurisdiction: JURISDICTION };

describe("evaluatePassport mirrors the realize gate (2C-3)", () => {
  it("walks status → expiry → registry → jurisdiction in the on-chain order", () => {
    expect(evaluatePassport(approved, allowAll, NOW)).toEqual({ status: "approved", reason: "", expiry: approved.expiry });
    expect(evaluatePassport(null, allowAll, NOW).status).toBe("missing");
    for (const status of [KycStatus.Pending, KycStatus.Revoked, KycStatus.Expired])
      expect(evaluatePassport({ ...approved, status }, allowAll, NOW).status).toBe("not_approved");
    // Revoked AND lapsed reports the status first, like 6069 before 6070.
    expect(evaluatePassport({ ...approved, status: KycStatus.Revoked, expiry: BigInt(1) }, null, NOW).status).toBe("not_approved");
    expect(evaluatePassport({ ...approved, expiry: BigInt(NOW - 1) }, allowAll, NOW).status).toBe("expired");
    expect(evaluatePassport(approved, null, NOW).status).toBe("registry_unreadable");
  });
  it("treats expiry == now as expired (the program needs expiry > now)", () => {
    expect(evaluatePassport({ ...approved, expiry: BigInt(NOW) }, allowAll, NOW).status).toBe("expired");
    expect(evaluatePassport({ ...approved, expiry: BigInt(NOW + 1) }, allowAll, NOW).status).toBe("approved");
    expect(evaluatePassport({ ...approved, expiry: BigInt(0) }, allowAll, NOW).status).toBe("expired");
  });
  it("needs the jurisdiction approved AND not blocked", () => {
    const onlyOther = { approvedJurisdictions: bitmapWith(222), blockedJurisdictions: new Uint8Array(128) };
    expect(evaluatePassport(approved, onlyOther, NOW).status).toBe("jurisdiction");
    const blocked = { approvedJurisdictions: bitmapWith(JURISDICTION), blockedJurisdictions: bitmapWith(JURISDICTION) };
    expect(evaluatePassport(approved, blocked, NOW)).toMatchObject({ status: "jurisdiction", reason: expect.stringMatching(/not allowed/) });
    const exact = { approvedJurisdictions: bitmapWith(JURISDICTION), blockedJurisdictions: new Uint8Array(128) };
    expect(evaluatePassport(approved, exact, NOW).status).toBe("approved");
  });
});

describe("realize KYC accounts", () => {
  const registry = key(7);
  const beneficiary = key(8);
  it("passes the pinned registry and the beneficiary's entry for a DeliveryEscrow", async () => {
    const accounts = await realizeKycAccounts({ vaultType: VaultType.DeliveryEscrow, beneficiary, kycRegistry: registry });
    expect(accounts.kycRegistry).toBe(registry);
    expect(accounts.kycEntry).toBe((await findKycEntryPda({ kycRegistry: registry, holder: beneficiary }))[0]);
  });
  it("passes nothing for other vault types and refuses an unpinned delivery vault", async () => {
    for (const vaultType of [VaultType.RedemptionQueue, VaultType.ConversionPending, VaultType.Vesting])
      expect(await realizeKycAccounts({ vaultType, beneficiary: DEFAULT_PUBKEY, kycRegistry: DEFAULT_PUBKEY })).toEqual({});
    await expect(
      realizeKycAccounts({ vaultType: VaultType.DeliveryEscrow, beneficiary, kycRegistry: DEFAULT_PUBKEY }),
    ).rejects.toThrow(/legacy vault/);
  });
  it("matches the final Rust RealizeCustodyVault ABI (10 accounts, KYC last)", async () => {
    const base = {
      authority: createNoopSigner(key(1)),
      shareClass: key(2),
      custodyVault: key(3),
      mint: key(4),
      escrow: key(5),
      tokenProgram: address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
      authorityAdminRecord: key(6),
    };
    const gated = await getRealizeCustodyVaultInstructionAsync({
      ...base,
      ...(await realizeKycAccounts({ vaultType: VaultType.DeliveryEscrow, beneficiary, kycRegistry: registry })),
    });
    expect(gated.accounts).toHaveLength(10);
    expect(gated.accounts[7].address).toBe(key(6));
    expect(gated.accounts[8].address).toBe(registry);
    expect(gated.accounts[9].address).toBe((await findKycEntryPda({ kycRegistry: registry, holder: beneficiary }))[0]);
    const quarantine = await getRealizeCustodyVaultInstructionAsync(base);
    expect(quarantine.accounts).toHaveLength(10);
    expect(quarantine.accounts[8].address).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
    expect(quarantine.accounts[9].address).toBe(ASSET_REGISTRY_PROGRAM_ADDRESS);
  });
  it("sizes CustodyVault v2 at 269 bytes", () => {
    expect(getCustodyVaultSize()).toBe(269);
  });
});

describe("loadBeneficiaryPassport", () => {
  const registry = key(7);
  const beneficiary = key(8);
  function fakeRpc(accounts: Map<string, Uint8Array>) {
    const calls: string[] = [];
    const rpc = {
      getAccountInfo: (addr: string) => ({
        send: async () => {
          calls.push(addr);
          const data = accounts.get(addr);
          return {
            context: { slot: BigInt(1) },
            value: data
              ? { data: [Buffer.from(data).toString("base64"), "base64"], executable: false, lamports: BigInt(1), owner: ASSET_REGISTRY_PROGRAM_ADDRESS, rentEpoch: BigInt(0), space: BigInt(data.length) }
              : null,
          };
        },
      }),
    };
    return { rpc: rpc as unknown as Parameters<typeof loadBeneficiaryPassport>[0], calls };
  }
  const registryBytes = new Uint8Array(getKycRegistryEncoder().encode({ authority: key(9), ...allowAll, entriesCount: BigInt(1), version: 1, bump: 255 }));
  it("reads the entry at [kyc, registry, beneficiary] and evaluates it", async () => {
    const [entryPda] = await findKycEntryPda({ kycRegistry: registry, holder: beneficiary });
    const entryBytes = new Uint8Array(getKycEntryEncoder().encode({ registry, holder: beneficiary, ...approved, accreditationLevel: 1, providerId: 1, externalRefHash: new Uint8Array(32), version: 1, bump: 255 }));
    const { rpc } = fakeRpc(new Map([[registry, registryBytes], [entryPda, entryBytes]]));
    const vault = { vaultType: VaultType.DeliveryEscrow, beneficiary, kycRegistry: registry };
    expect((await loadBeneficiaryPassport(rpc, vault, NOW)).status).toBe("approved");
    const missing = fakeRpc(new Map([[registry, registryBytes]]));
    expect((await loadBeneficiaryPassport(missing.rpc, vault, NOW)).status).toBe("missing");
  });
  it("never reads the chain for an unpinned vault", async () => {
    const { rpc, calls } = fakeRpc(new Map());
    const result = await loadBeneficiaryPassport(rpc, { vaultType: VaultType.DeliveryEscrow, beneficiary, kycRegistry: DEFAULT_PUBKEY }, NOW);
    expect(result.status).toBe("registry_unreadable");
    expect(calls).toEqual([]);
  });
});

describe("passport shortcut and pin warning", () => {
  it("links to the client page, or the client list searched by wallet", () => {
    expect(passportShortcutHref({ clientId: "c1/x", wallet: "W" })).toBe("/admin/clients/c1%2Fx");
    expect(passportShortcutHref({ clientId: null, wallet: "Abc+=" })).toBe("/admin/clients?q=Abc%2B%3D");
  });
  it("warns on an unpinned vault or a pin that is not the platform registry", () => {
    expect(pinnedRegistryWarning(key(7), key(7))).toBeNull();
    expect(pinnedRegistryWarning(key(7), null)).toBeNull();
    expect(pinnedRegistryWarning(key(7), key(8))).toMatch(/not the platform registry/);
    expect(pinnedRegistryWarning(DEFAULT_PUBKEY, null)).toMatch(/pins no KYC registry/);
  });
});

describe("transaction-error hints (2C-3)", () => {
  const withLogs = (n: number) =>
    Object.assign(new Error("Transaction simulation failed"), {
      context: { logs: [`Program x failed: custom program error: 0x${n.toString(16)}`] },
    });
  it("explains 6134-6136 and words 6069 for a custody beneficiary too", () => {
    expect(ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_REQUIRED).toBe(6134);
    expect(ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_NOT_ALLOWED).toBe(6135);
    expect(ASSET_REGISTRY_ERROR__CUSTODY_KYC_REGISTRY_MISMATCH).toBe(6136);
    expect(explainSendError(withLogs(6134))).toMatch(/CustodyKycRegistryRequired/);
    expect(explainSendError(withLogs(6135))).toMatch(/CustodyKycRegistryNotAllowed/);
    expect(explainSendError(withLogs(6136))).toMatch(/CustodyKycRegistryMismatch/);
    expect(explainSendError(withLogs(ASSET_REGISTRY_ERROR__RECEIVER_NOT_APPROVED))).toMatch(/custody beneficiary/);
  });
});

describe("custody page wiring (source)", () => {
  const page = readFileSync(path.join(__dirname, "../app/admin/custody/page.tsx"), "utf8");
  it("passes the KYC accounts to every realize and pins the registry on every delivery open", () => {
    expect(page.match(/getRealizeCustodyVaultInstructionAsync\(\{/g)).toHaveLength(3);
    expect(page.match(/\.\.\.\(await realizeKycAccounts\(vault\)\)/g)).toHaveLength(1);
    expect(page.match(/\.\.\.kycAccounts,/g)).toHaveLength(2);
    expect(page.match(/kycRegistry: pinnedRegistry,/g)).toHaveLength(2);
    expect(page).toMatch(/kycRegistry: platformRegistry\.registry/);
  });
  it("renders the issue-passport shortcut and gates confirm on the passport", () => {
    expect(page).toMatch(/Issue passport →/);
    expect(page.match(/passportBlock !== null/g)?.length).toBeGreaterThanOrEqual(2);
  });
});

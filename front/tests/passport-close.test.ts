import { describe, expect, it } from "vitest";
import { getAddressDecoder, some, type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  findKycEntryPda,
  getCustodyVaultEncoder,
  getKycEntryEncoder,
  getOfferEncoder,
  KycStatus,
  OfferStatus,
  OtcDealStatus,
  RealizeAction,
  VaultState,
  VaultType,
} from "@/lib/generated/asset_registry";
import {
  findConfigPda,
  getTransferHookConfigEncoder,
  RestrictionMode,
  TRANSFER_HOOK_PROGRAM_ADDRESS,
} from "@/lib/generated/transfer_hook";
import { CLOSED_ACCOUNT_TAG } from "@/lib/closed-account";
import { closePassportPreflight } from "@/lib/passport-close";

const key = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n)) as Address;
const registry = key(1);
const holder = key(2);
const gatedMint = key(3);
const openMint = key(4);

type Accounts = Map<string, { owner: string; data: Uint8Array }>;
function rpc(accounts: Accounts, holdings: { mint: string; amount: string }[]) {
  return {
    getAccountInfo: (addr: string) => ({
      send: async () => {
        const hit = accounts.get(addr);
        return {
          context: { slot: BigInt(1) },
          value: hit
            ? { data: [Buffer.from(hit.data).toString("base64"), "base64"], executable: false, lamports: BigInt(1), owner: hit.owner, rentEpoch: BigInt(0), space: BigInt(hit.data.length) }
            : null,
        };
      },
    }),
    getTokenAccountsByOwner: () => ({
      send: async () => ({
        context: { slot: BigInt(1) },
        value: holdings.map((h, i) => ({
          pubkey: key(100 + i),
          account: { data: { parsed: { info: { mint: h.mint, tokenAmount: { amount: h.amount } } } } },
        })),
      }),
    }),
  } as unknown as Parameters<typeof closePassportPreflight>[0];
}

async function entry(accounts: Accounts, status: KycStatus, expiry: bigint) {
  const [pda] = await findKycEntryPda({ kycRegistry: registry, holder });
  accounts.set(pda, {
    owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
    data: new Uint8Array(
      getKycEntryEncoder().encode({
        registry, holder, status, jurisdiction: 688, accreditationLevel: 1, expiry,
        providerId: 1, externalRefHash: new Uint8Array(32), version: 1, bump: 255,
      }),
    ),
  });
}

async function hookConfig(accounts: Accounts, mint: Address, mode: RestrictionMode) {
  const [pda] = await findConfigPda({ mint });
  accounts.set(pda, {
    owner: TRANSFER_HOOK_PROGRAM_ADDRESS,
    data: new Uint8Array(
      getTransferHookConfigEncoder().encode({
        mint, shareClass: key(9), blocklist: key(10), restrictionMode: mode,
        kycRegistry: some(registry), version: 1, bump: 255,
      }),
    ),
  });
}

const none = { vaults: [], offers: [], deals: [] };

describe("close revoked passport: live-chain preflight (2D)", () => {
  it("waits for Revoked and the expiry", async () => {
    const accounts: Accounts = new Map();
    await entry(accounts, KycStatus.Approved, BigInt(500));
    let check = await closePassportPreflight(rpc(accounts, []), { registry, holder, nowSec: BigInt(100) }, none);
    expect(check.closable).toBe(false);
    expect(check.blockers.join(" ")).toMatch(/Revoke the passport first/);
    expect(check.closableAt).toBe(BigInt(500));
    await entry(accounts, KycStatus.Revoked, BigInt(500));
    check = await closePassportPreflight(rpc(accounts, []), { registry, holder, nowSec: BigInt(100) }, none);
    expect(check.blockers).toHaveLength(1);
    expect(check.blockers[0]).toMatch(/Closable after/);
    check = await closePassportPreflight(rpc(accounts, []), { registry, holder, nowSec: BigInt(500) }, none);
    expect(check).toEqual({ closable: true, closableAt: BigInt(500), blockers: [] });
  });

  it("blocks on KYC-gated holdings of this registry, open delivery escrows, open offers and deals", async () => {
    const accounts: Accounts = new Map();
    await entry(accounts, KycStatus.Revoked, BigInt(10));
    await hookConfig(accounts, gatedMint, RestrictionMode.KycGated);
    await hookConfig(accounts, openMint, RestrictionMode.Open);
    const vault = key(20);
    accounts.set(vault, {
      owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: new Uint8Array(
        getCustodyVaultEncoder().encode({
          shareClass: key(9), mint: gatedMint, escrow: key(21), vaultId: BigInt(1), authority: key(22),
          vaultType: VaultType.DeliveryEscrow, realizeAction: RealizeAction.BurnAndAttest, amount: BigInt(1),
          state: VaultState.Triggered, deadline: BigInt(0), metadataHash: new Uint8Array(32),
          beneficiary: holder, version: 2, bump: 255, deposited: BigInt(1), kycRegistry: registry,
        }),
      ),
    });
    const offer = key(30);
    accounts.set(offer, {
      owner: ASSET_REGISTRY_PROGRAM_ADDRESS,
      data: new Uint8Array(
        getOfferEncoder().encode({
          maker: holder, shareClass: key(9), mint: gatedMint, escrow: key(31), paymentMint: key(32),
          amount: BigInt(1), price: BigInt(1), status: OfferStatus.Open, offerId: BigInt(1),
          expiresAt: BigInt(0), version: 1, bump: 255, deposited: BigInt(1),
        }),
      ),
    });
    const tombstoned = key(33);
    accounts.set(tombstoned, { owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: CLOSED_ACCOUNT_TAG });
    const check = await closePassportPreflight(
      rpc(accounts, [
        { mint: gatedMint, amount: "5" },
        { mint: openMint, amount: "5" },
        { mint: key(5), amount: "0" },
      ]),
      { registry, holder, nowSec: BigInt(10) },
      {
        vaults: [vault, key(40)],
        offers: [offer, tombstoned],
        deals: [
          { pda: key(50), deal: { seller: holder, status: OtcDealStatus.Open } },
          { pda: key(51), deal: { seller: holder, status: OtcDealStatus.Completed } },
        ],
      },
    );
    expect(check.closable).toBe(false);
    const text = check.blockers.join("\n");
    expect(check.blockers).toHaveLength(4);
    expect(text).toContain(gatedMint);
    expect(text).not.toContain(openMint);
    expect(text).toContain(vault);
    expect(text).toContain(offer);
    expect(text).toContain(key(50));
  });
});

// Registry accounts for the mock chain, encoded with the generated SDK (the
// same encoders the program's IDL produced), so the pages decode exactly
// what they would read from a cluster.
import { createHash } from "node:crypto";
import { getAddressDecoder, some, type Address } from "@solana/kit";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  AssetStatus,
  AssetType,
  KybStatus,
  RaiseType,
  SaleStatus,
  ShareClassType,
  getAssetEncoder,
  getIssuerEncoder,
  getIssuerFreezeEncoder,
  getPlatformEncoder,
  getSaleEncoder,
  getShareClassEncoder,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import { findIssuerFreezePda, findSalePda } from "@/lib/pdas";
import type { MockAccount } from "./mock-chain";

/** A stable, valid address for `label` (not a key anyone holds). */
export function smokeAddress(label: string): Address {
  return getAddressDecoder().decode(createHash("sha256").update(`manci-ui-smoke:${label}`).digest());
}

/** An address no mock account lives at: the "not found" state of a page. */
export const SMOKE_ABSENT_ADDRESS = smokeAddress("absent");

const zeros = (n: number) => new Uint8Array(n);

function account(address: Address, data: Uint8Array): MockAccount {
  return { address, owner: ASSET_REGISTRY_PROGRAM_ADDRESS, data: Uint8Array.from(data) };
}

/** The Platform account: `admin` is the super admin; `pauseFlags` the bitmask. */
export async function platformAccount(opts: { admin: Address; pauseFlags?: number }): Promise<MockAccount> {
  const [platform] = await findPlatformPda();
  return account(
    platform,
    getPlatformEncoder().encode({
      admin: opts.admin,
      protocolTreasury: smokeAddress("treasury"),
      protocolFeeBps: 100,
      pauseFlags: opts.pauseFlags ?? 0,
      issuersCount: 1,
      version: 1,
      bump: 255,
    }) as Uint8Array,
  );
}

/** One issuer → asset → share class → Mature sale chain, open for a week. */
export const SMOKE_SALE = {
  issuer: smokeAddress("issuer"),
  issuerAuthority: smokeAddress("issuer-authority"),
  asset: smokeAddress("asset"),
  shareClass: smokeAddress("share-class"),
  mint: smokeAddress("share-mint"),
  paymentMint: smokeAddress("payment-mint"),
  saleId: BigInt(1),
  /** Used by the page list: a sale PDA the mock chain does not hold. */
  absentSale: SMOKE_ABSENT_ADDRESS,
} as const;

export async function smokeSaleAddress(): Promise<Address> {
  return findSalePda(SMOKE_SALE.shareClass, SMOKE_SALE.saleId);
}

export async function saleChainAccounts(): Promise<MockAccount[]> {
  const now = Math.floor(Date.now() / 1000);
  const issuer = account(
    SMOKE_SALE.issuer,
    getIssuerEncoder().encode({
      authority: SMOKE_SALE.issuerAuthority,
      legalEntityId: zeros(32),
      jurisdiction: 688,
      kybStatus: KybStatus.Verified,
      kybDocHash: zeros(32),
      assetsCount: 1,
      version: 1,
      bump: 255,
    }) as Uint8Array,
  );
  const asset = account(
    SMOKE_SALE.asset,
    getAssetEncoder().encode({
      issuer: SMOKE_SALE.issuer,
      assetId: "SMOKE-1",
      assetType: AssetType.Equity,
      name: "Smoke Test Holdings",
      symbolPrefix: "SMK",
      legalDocHash: zeros(32),
      jurisdictionRules: { allowedCountries: zeros(32), maxHolders: 0, restrictedPeriodEnd: 0, allowP2p: true },
      status: AssetStatus.Active,
      shareClassesCount: 1,
      extraKycRegistry: null,
      version: 1,
      bump: 255,
    }) as Uint8Array,
  );
  const shareClass = account(
    SMOKE_SALE.shareClass,
    getShareClassEncoder().encode({
      asset: SMOKE_SALE.asset,
      mint: SMOKE_SALE.mint,
      classIndex: 0,
      classType: ShareClassType.Common,
      rightsBitfield: 0,
      liqPrefMultiplierBps: 10_000,
      liqSeniority: 0,
      votingWeight: 1,
      convertibleTo: null,
      maxSupply: some(BigInt(1_000_000)),
      circulatingSupply: 0,
      lockedSupply: 0,
      mintablePostLaunch: false,
      mintInitialized: true,
      supplyLocked: false,
      version: 2,
      bump: 255,
      lifetimeMinted: 0,
      cumulativeCap: false,
    }) as Uint8Array,
  );
  const sale = account(
    await smokeSaleAddress(),
    getSaleEncoder().encode({
      shareClass: SMOKE_SALE.shareClass,
      mint: SMOKE_SALE.mint,
      paymentMint: SMOKE_SALE.paymentMint,
      proceeds: smokeAddress("proceeds"),
      authority: SMOKE_SALE.issuerAuthority,
      saleId: SMOKE_SALE.saleId,
      pricePerUnit: 1_000_000,
      totalForSale: 100_000,
      sold: 0,
      startTs: now - 86_400,
      endTs: now + 7 * 86_400,
      status: SaleStatus.Open,
      raiseType: RaiseType.Mature,
      cliffMonths: 0,
      vestingMonths: 0,
      version: 1,
      bump: 255,
      saleApproval: smokeAddress("sale-approval"),
      applicationHash: zeros(32),
    }) as Uint8Array,
  );
  return [issuer, asset, shareClass, sale];
}

/** The issuer's D1 proceeds freeze: its existence is the freeze. */
export async function issuerFreezeAccount(): Promise<MockAccount> {
  return account(
    await findIssuerFreezePda(SMOKE_SALE.issuer),
    getIssuerFreezeEncoder().encode({
      issuer: SMOKE_SALE.issuer,
      frozenBy: smokeAddress("freezing-admin"),
      frozenAt: Math.floor(Date.now() / 1000) - 3_600,
      reasonHash: zeros(32),
      version: 1,
      bump: 255,
    }) as Uint8Array,
  );
}

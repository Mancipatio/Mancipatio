import { getAddressDecoder, none } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { NetworkData } from "@/lib/enumerate";
import { toBytes32 } from "@/lib/format";
import {
  AssetStatus,
  KybStatus,
  OfferStatus,
  SaleStatus,
  findAssetPda,
  findIssuerPda,
  type Asset,
  type Issuer,
  type Offer,
  type Sale,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { buildMarketOverview } from "@/lib/market-overview";
import { findOfferPda, findSalePda, findShareClassPda } from "@/lib/pdas";

const B = BigInt;
const address = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed));

async function fixture() {
  const issuer: Issuer = {
    discriminator: new Uint8Array(8),
    authority: address(1),
    legalEntityId: toBytes32("issuer-legal-id"),
    jurisdiction: 688,
    kybStatus: KybStatus.Verified,
    kybDocHash: new Uint8Array(32),
    assetsCount: B(1),
    version: 1,
    bump: 255,
  };
  const [issuerPda] = await findIssuerPda({ legalEntityId: issuer.legalEntityId });
  const asset: Asset = {
    discriminator: new Uint8Array(8),
    issuer: issuerPda,
    assetId: "property-1",
    assetType: 3,
    name: "Belgrade property",
    symbolPrefix: "BG",
    legalDocHash: new Uint8Array(32),
    jurisdictionRules: {
      allowedCountries: new Uint8Array(128),
      maxHolders: 0,
      restrictedPeriodEnd: B(0),
      allowP2p: true,
    },
    status: AssetStatus.Active,
    shareClassesCount: 1,
    extraKycRegistry: none(),
    version: 1,
    bump: 255,
  };
  const [assetPda] = await findAssetPda({ issuer: issuerPda, assetId: asset.assetId });
  const shareClass: ShareClass = {
    discriminator: new Uint8Array(8),
    asset: assetPda,
    mint: address(2),
    classIndex: 0,
    classType: 0,
    rightsBitfield: 0,
    liqPrefMultiplierBps: 10000,
    liqSeniority: 0,
    votingWeight: 1,
    convertibleTo: none(),
    maxSupply: none(),
    circulatingSupply: B(100),
    lockedSupply: B(0),
    mintablePostLaunch: false,
    lifetimeMinted: B(100),
    cumulativeCap: false,
    mintInitialized: true,
    supplyLocked: true,
    version: 1,
    bump: 255,
  };
  const classPda = await findShareClassPda(assetPda, shareClass.classIndex);
  const sale: Sale = {
    discriminator: new Uint8Array(8),
    shareClass: classPda,
    mint: shareClass.mint,
    paymentMint: address(3),
    proceeds: address(4),
    authority: issuer.authority,
    saleId: B(1),
    pricePerUnit: B(2_000_000),
    totalForSale: B(100),
    sold: B(10),
    startTs: B(100),
    endTs: B(200),
    status: SaleStatus.Open,
    raiseType: 0,
    cliffMonths: 0,
    vestingMonths: 0,
    version: 2,
    bump: 255,
    saleApproval: address(5),
    applicationHash: new Uint8Array(32),
  };
  const offer: Offer = {
    discriminator: new Uint8Array(8),
    maker: address(5),
    shareClass: classPda,
    mint: shareClass.mint,
    escrow: address(6),
    paymentMint: address(7),
    amount: B(10),
    price: B(25_000_000),
    status: OfferStatus.Open,
    offerId: B(1),
    expiresAt: B(200),
    deposited: B(10),
    version: 1,
    bump: 255,
  };
  const data: NetworkData = {
    issuers: [issuer],
    assets: [asset],
    shareClasses: [shareClass],
    sales: [sale],
    offers: [offer],
    rightsIssuances: [],
    milestones: [],
  };
  return { data, issuer, issuerPda, asset, assetPda, shareClass, classPda, sale, offer };
}

describe("buildMarketOverview", () => {
  it("joins issuer and share class PDAs and supplies executable route addresses", async () => {
    const f = await fixture();
    const overview = await buildMarketOverview(f.data, 150);
    const row = overview.rows[0];
    expect(row).toMatchObject({
      address: f.assetPda,
      // e2e §6: the public link is keyed by the asset PDA, not the bare assetId
      // (two issuers may both register "property-1").
      href: `/marketplace/assets/${f.assetPda}`,
      issuerAddress: f.issuerPda,
      issuerLegalId: "issuer-legal-id",
      issuerLegalName: null,
      issuerJurisdiction: 688,
      issuerKybStatus: KybStatus.Verified,
    });
    expect(row.asset).toBe(f.asset);
    expect(row.issuer).toBe(f.issuer);
    expect(row.shareClasses).toEqual([f.shareClass]);
    const salePda = await findSalePda(f.classPda, f.sale.saleId);
    const offerPda = await findOfferPda(f.classPda, f.offer.offerId);
    expect(row.sales).toEqual([{ sale: f.sale, address: salePda, href: `/marketplace/launchpad/${salePda}` }]);
    expect(row.offers).toEqual([{ offer: f.offer, address: offerPda, href: `/marketplace/otc/${offerPda}` }]);
    expect(overview.sales[0].sale).toBe(f.sale);
    expect(overview.offers[0].offer).toBe(f.offer);
    expect(overview.counts).toEqual({
      assets: 1, activeAssets: 1, issuers: 1, verifiedIssuers: 1,
      shareClasses: 1, availableSales: 1, fundedOffers: 1,
    });
    // Different payment mints stay distinct, with bigint base-unit prices.
    expect(overview.sales[0].sale.paymentMint).not.toBe(overview.offers[0].offer.paymentMint);
    expect(overview.sales[0].sale.pricePerUnit).toBe(B(2_000_000));
    expect(overview.offers[0].offer.price).toBe(B(25_000_000));
  });

  it.each([
    { now: 99, sales: 0, offers: 1 },
    { now: 100, sales: 1, offers: 1 },
    { now: 200, sales: 1, offers: 1 },
    { now: 201, sales: 0, offers: 0 },
  ])("matches inclusive Rust start/expiry boundaries at $now", async ({ now, sales, offers }) => {
    const { data } = await fixture();
    const overview = await buildMarketOverview(data, now);
    expect(overview.counts.availableSales).toBe(sales);
    expect(overview.counts.fundedOffers).toBe(offers);
  });

  it("treats zero expiry as unlimited and compares bigint timestamps without rounding", async () => {
    const { data, sale, offer } = await fixture();
    sale.endTs = B(0);
    offer.expiresAt = B(0);
    const huge = B("9007199254740993");
    expect((await buildMarketOverview(data, huge)).counts.availableSales).toBe(1);
    expect((await buildMarketOverview(data, huge)).counts.fundedOffers).toBe(1);
    sale.startTs = huge + B(1);
    expect((await buildMarketOverview(data, huge)).counts.availableSales).toBe(0);
  });

  it.each([AssetStatus.Draft, AssetStatus.Frozen, AssetStatus.WoundDown])(
    "keeps asset status %s visible but removes its available trades",
    async (status) => {
      const { data, asset } = await fixture();
      asset.status = status;
      const overview = await buildMarketOverview(data, 150);
      expect(overview.rows).toHaveLength(1);
      expect(overview.rows[0].shareClasses).toHaveLength(1);
      expect(overview.sales).toEqual([]);
      expect(overview.offers).toEqual([]);
      expect(overview.counts.activeAssets).toBe(0);
    },
  );

  it("filters closed, sold out and zero-inventory sales while retaining one available sale", async () => {
    const { data, sale } = await fixture();
    data.sales = [
      { ...sale, saleId: B(2), status: SaleStatus.Closed },
      { ...sale, saleId: B(3), sold: sale.totalForSale },
      { ...sale, saleId: B(4), sold: sale.totalForSale + B(1) },
      { ...sale, saleId: B(5), sold: B(0), totalForSale: B(0) },
      sale,
    ];
    const overview = await buildMarketOverview(data, 150);
    expect(overview.sales.map((item) => item.sale)).toEqual([sale]);
    expect(overview.counts.availableSales).toBe(1);
  });

  it("requires a positive, funded, open offer and permits excess maker deposits", async () => {
    const { data, offer } = await fixture();
    const excess = { ...offer, offerId: B(8), deposited: offer.amount + B(1) };
    data.offers = [
      ...[OfferStatus.Filled, OfferStatus.Cancelled, OfferStatus.Expired].map((status, i) => ({
        ...offer, offerId: B(i + 2), status,
      })),
      { ...offer, offerId: B(5), deposited: B(0) },
      { ...offer, offerId: B(6), deposited: offer.amount - B(1) },
      { ...offer, offerId: B(7), amount: B(0), deposited: B(0) },
      offer,
      excess,
    ];
    const overview = await buildMarketOverview(data, 150);
    expect(overview.offers.map((item) => item.offer)).toEqual([offer, excess]);
    expect(overview.counts.fundedOffers).toBe(2);
  });

  it("does not advertise orphaned or mismatched share-class trades", async () => {
    const { data, sale, offer } = await fixture();
    data.sales = [{ ...sale, shareClass: address(20) }, { ...sale, mint: address(21) }];
    data.offers = [{ ...offer, shareClass: address(20) }, { ...offer, mint: address(21) }];
    const overview = await buildMarketOverview(data, 150);
    expect(overview.sales).toEqual([]);
    expect(overview.offers).toEqual([]);
  });

  it("retains explicit unknown issuer fields when the issuer is absent from the snapshot", async () => {
    const { data } = await fixture();
    data.issuers = [];
    const overview = await buildMarketOverview(data, 150);
    expect(overview.rows[0]).toMatchObject({
      issuer: null, issuerLegalId: null, issuerLegalName: null,
      issuerJurisdiction: null, issuerKybStatus: null,
    });
    expect(overview.counts.verifiedIssuers).toBe(0);
  });

  it("joins identical class indices to their own asset, leaving unrelated classes unlisted", async () => {
    const { data, asset, shareClass } = await fixture();
    const secondAsset = { ...asset, assetId: "property-2" };
    const [secondPda] = await findAssetPda({ issuer: secondAsset.issuer, assetId: secondAsset.assetId });
    const secondClass = { ...shareClass, asset: secondPda, mint: address(22) };
    data.assets.push(secondAsset);
    data.shareClasses.push(secondClass, { ...shareClass, asset: address(23) });
    const overview = await buildMarketOverview(data, 150);
    expect(overview.rows[0].shareClasses).toEqual([shareClass]);
    expect(overview.rows[1].shareClasses).toEqual([secondClass]);
    expect(overview.rows[1].sales).toEqual([]);
    expect(overview.rows[1].offers).toEqual([]);
    expect(overview.counts.availableSales).toBe(1);
  });

  it("rejects ambiguous numeric timestamps", async () => {
    const { data } = await fixture();
    await expect(buildMarketOverview(data, Number.NaN)).rejects.toThrow(RangeError);
    await expect(buildMarketOverview(data, 150.5)).rejects.toThrow(RangeError);
    await expect(buildMarketOverview(data, Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow(RangeError);
  });

  it("handles an empty registry without inventing activity", async () => {
    const overview = await buildMarketOverview({
      issuers: [], assets: [], shareClasses: [], sales: [], offers: [],
      rightsIssuances: [], milestones: [],
    }, 150);
    expect(overview.rows).toEqual([]);
    expect(overview.sales).toEqual([]);
    expect(overview.offers).toEqual([]);
    expect(Object.values(overview.counts).every((count) => count === 0)).toBe(true);
  });
});

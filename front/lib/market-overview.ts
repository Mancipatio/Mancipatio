import type { Address } from "@solana/kit";
import type { NetworkData } from "@/lib/enumerate";
import { fromBytes32 } from "@/lib/format";
import { assetHref } from "@/lib/asset-links";
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
import { findOfferPda, findSalePda, findShareClassPda } from "@/lib/pdas";

export interface MarketSale {
  sale: Sale;
  address: Address;
  href: string;
}

export interface MarketOffer {
  offer: Offer;
  address: Address;
  href: string;
}

export interface MarketAssetRow {
  asset: Asset;
  address: Address;
  href: string;
  issuer: Issuer | null;
  issuerAddress: Address;
  issuerLegalId: string | null;
  /** Off-chain company name; NetworkData alone cannot supply this field. */
  issuerLegalName: string | null;
  issuerJurisdiction: number | null;
  issuerKybStatus: KybStatus | null;
  shareClasses: ShareClass[];
  sales: MarketSale[];
  offers: MarketOffer[];
}

export interface MarketOverview {
  rows: MarketAssetRow[];
  sales: MarketSale[];
  offers: MarketOffer[];
  counts: {
    assets: number;
    activeAssets: number;
    issuers: number;
    verifiedIssuers: number;
    shareClasses: number;
    availableSales: number;
    fundedOffers: number;
  };
}

/**
 * Join a registry snapshot without RPC or off-chain profile requests.
 *
 * "Available" means the listed asset, time, status and inventory conditions
 * pass at this snapshot. It does not establish wallet eligibility or promise
 * execution: KYC, restrictions, balances and transaction preflight still apply.
 * Keep payment amounts on their individual sale/offer, in their original mint
 * and base units; this overview deliberately does not invent a common TVL.
 */
export async function buildMarketOverview(
  data: NetworkData,
  nowSeconds: number | bigint,
): Promise<MarketOverview> {
  if (typeof nowSeconds === "number" && !Number.isSafeInteger(nowSeconds)) {
    throw new RangeError("nowSeconds must be an integer Unix timestamp");
  }
  const now = BigInt(nowSeconds);
  const zero = BigInt(0);
  const issuerEntries = await Promise.all(
    data.issuers.map(async (issuer) => {
      const [address] = await findIssuerPda({ legalEntityId: issuer.legalEntityId });
      return [address, issuer] as const;
    }),
  );
  const issuerByAddress = new Map(issuerEntries);

  const rows = await Promise.all(
    data.assets.map(async (asset): Promise<MarketAssetRow> => {
      const [address] = await findAssetPda({
        issuer: asset.issuer,
        assetId: asset.assetId,
      });
      const issuer = issuerByAddress.get(asset.issuer) ?? null;
      return {
        asset,
        address,
        href: assetHref(address),
        issuer,
        issuerAddress: asset.issuer,
        issuerLegalId: issuer ? fromBytes32(issuer.legalEntityId) : null,
        issuerLegalName: null,
        issuerJurisdiction: issuer?.jurisdiction ?? null,
        issuerKybStatus: issuer?.kybStatus ?? null,
        shareClasses: [],
        sales: [],
        offers: [],
      };
    }),
  );
  const rowByAddress = new Map(rows.map((row) => [row.address, row]));
  const classEntries = await Promise.all(
    data.shareClasses.map(async (shareClass) => {
      const address = await findShareClassPda(shareClass.asset, shareClass.classIndex);
      return [address, shareClass] as const;
    }),
  );
  const classByAddress = new Map(classEntries);
  for (const [, shareClass] of classEntries) {
    rowByAddress.get(shareClass.asset)?.shareClasses.push(shareClass);
  }

  // Join by the full PDA, not a class index or mint alone. Require the mint to
  // agree as well so an inconsistent/indexer-orphaned trade is not advertised.
  function activeRow(shareClassAddress: Address, mint: Address) {
    const shareClass = classByAddress.get(shareClassAddress);
    if (!shareClass || shareClass.mint !== mint) return undefined;
    const row = rowByAddress.get(shareClass.asset);
    return row?.asset.status === AssetStatus.Active ? row : undefined;
  }

  const saleEntries = await Promise.all(
    data.sales.map(async (sale) => {
      const row = activeRow(sale.shareClass, sale.mint);
      if (
        !row ||
        sale.status !== SaleStatus.Open ||
        sale.startTs > now ||
        (sale.endTs !== zero && now > sale.endTs) ||
        sale.sold >= sale.totalForSale
      ) return null;
      const address = await findSalePda(sale.shareClass, sale.saleId);
      const item: MarketSale = {
        sale,
        address,
        href: `/marketplace/launchpad/${address}`,
      };
      return { row, item };
    }),
  );
  const sales: MarketSale[] = [];
  for (const entry of saleEntries) {
    if (!entry) continue;
    entry.row.sales.push(entry.item);
    sales.push(entry.item);
  }

  const offerEntries = await Promise.all(
    data.offers.map(async (offer) => {
      const row = activeRow(offer.shareClass, offer.mint);
      if (
        !row ||
        offer.status !== OfferStatus.Open ||
        offer.amount <= zero ||
        offer.deposited < offer.amount ||
        (offer.expiresAt !== zero && now > offer.expiresAt)
      ) return null;
      const address = await findOfferPda(offer.shareClass, offer.offerId);
      const item: MarketOffer = {
        offer,
        address,
        href: `/marketplace/otc/${address}`,
      };
      return { row, item };
    }),
  );
  const offers: MarketOffer[] = [];
  for (const entry of offerEntries) {
    if (!entry) continue;
    entry.row.offers.push(entry.item);
    offers.push(entry.item);
  }

  return {
    rows,
    sales,
    offers,
    counts: {
      assets: data.assets.length,
      activeAssets: data.assets.filter((asset) => asset.status === AssetStatus.Active).length,
      issuers: data.issuers.length,
      verifiedIssuers: data.issuers.filter((issuer) => issuer.kybStatus === KybStatus.Verified).length,
      shareClasses: data.shareClasses.length,
      availableSales: sales.length,
      fundedOffers: offers.length,
    },
  };
}

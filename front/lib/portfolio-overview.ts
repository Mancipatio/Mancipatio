import { withAssetAddresses } from "@/lib/asset-links";
import type { NetworkData } from "@/lib/enumerate";
import type { Holding } from "@/lib/holdings";

const CLASS_TYPE = [
  "Common", "Preferred A", "Preferred B", "Senior debt", "Junior debt",
  "Rev-share tier", "Royalty tier",
];

export type PortfolioHolding = {
  mint: string;
  balance: bigint;
  assetPda: string;
  assetName: string;
  assetId: string;
  classIndex: number;
  className: string;
};

/** One balance per share-class mint, even when the owner has several token accounts. */
export async function enrichPortfolioHoldings(
  network: Pick<NetworkData, "assets" | "shareClasses">,
  holdings: readonly Holding[],
): Promise<PortfolioHolding[]> {
  const assets = new Map((await withAssetAddresses(network.assets))
    .map(({ address, asset }) => [address, asset]));
  const classes = new Map(network.shareClasses.map((sc) => [sc.mint.toString(), sc]));
  const result = new Map<string, PortfolioHolding>();
  for (const holding of holdings) {
    const sc = classes.get(holding.mint);
    if (!sc || holding.balance <= BigInt(0)) continue;
    const existing = result.get(holding.mint);
    if (existing) {
      existing.balance += holding.balance;
      continue;
    }
    const assetPda = sc.asset.toString();
    const asset = assets.get(assetPda);
    result.set(holding.mint, {
      mint: holding.mint,
      balance: holding.balance,
      assetPda,
      assetName: asset?.name ?? "Asset details unavailable",
      assetId: asset?.assetId ?? "—",
      classIndex: sc.classIndex,
      className: CLASS_TYPE[sc.classType] ?? "Other",
    });
  }
  return [...result.values()];
}

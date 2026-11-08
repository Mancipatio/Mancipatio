"use client";

// The browser half of the portfolio export (/portfolio/history): the signed
// read of the holder's own records (POST /api/portfolio/export, a session
// read: one sign-in at most, never a per-read signature), the share-class
// labels from the network data, and the download. Building the file is
// lib/portfolio-export.ts; reading the chain is lib/portfolio-chain.ts.

import type { WalletSession } from "@solana/client";
import { withAssetAddresses } from "@/lib/asset-links";
import { SHARE_CLASS_TYPE_LABELS } from "@/lib/asset-types";
import type { NetworkData } from "@/lib/enumerate";
import { parsePortfolioExportRecords, type PortfolioExportRecords, type ShareClassLabel } from "@/lib/portfolio-export";
import { signedFetch } from "@/lib/siws-client";

/** The signer's records. THROWS with the server's message, or WalletSessionRequiredError without a session. */
export async function loadPortfolioExportRecords(
  session: WalletSession | null | undefined,
): Promise<PortfolioExportRecords> {
  const data = await signedFetch<unknown>(session, "/api/portfolio/export", "portfolio.export", {}, { interactive: true });
  const records = parsePortfolioExportRecords(data);
  if (!records) throw new Error("Your records could not be read. Please try again.");
  return records;
}

/** "Mancipatio d.o.o. (MANCI-2026)" and "#0 Common" per share-class mint. */
export async function shareClassLabels(
  network: Pick<NetworkData, "assets" | "shareClasses">,
): Promise<Map<string, ShareClassLabel>> {
  const assets = new Map((await withAssetAddresses(network.assets)).map(({ address, asset }) => [address, asset]));
  const labels = new Map<string, ShareClassLabel>();
  for (const sc of network.shareClasses) {
    const asset = assets.get(sc.asset.toString());
    labels.set(sc.mint.toString(), {
      asset: asset ? `${asset.name} (${asset.assetId})` : sc.asset.toString(),
      shareClass: `#${sc.classIndex} ${SHARE_CLASS_TYPE_LABELS[sc.classType] ?? "Other"}`,
    });
  }
  return labels;
}

/** Hands the file to the browser as a download (UTF-8, text/csv). */
export function downloadCsv(csv: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // After the click has started the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

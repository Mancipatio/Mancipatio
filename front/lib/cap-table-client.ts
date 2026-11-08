"use client";

// Browser half of the cap table (/admin/cap-table, /issuer/cap-table): the
// asset list and the signed calls to /api/cap-table/*. Reads are session
// reads (lib/siws-session.ts: one sign-in, then no prompt); recording,
// voiding and the export ask the wallet to sign each request. Every call
// THROWS with the server's message (a 403, a 409 from the register guard, a
// 503 when the chain or the records cannot be read).

import type { WalletSession } from "@solana/client";
import type { SolanaClient } from "@solana/client";
import { findIssuerPda } from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { withAssetAddresses } from "@/lib/asset-links";
import { signedFetch, type SignedFetchInteractive } from "@/lib/siws-client";
import type { AssetReconciliation, RegisterEntryView } from "@/lib/cap-table";
import type { RegisterEntryInput } from "@/lib/register-entries";

type Rpc = SolanaClient["runtime"]["rpc"];

export type AssetOption = { pda: string; name: string; assetId: string; symbol: string };

/**
 * The assets with at least one minted share class, by name: every asset, or
 * with `authority` only those of the issuers that wallet is the authority of
 * (the server checks the same authority before it answers).
 */
export async function loadAssetOptions(rpc: Rpc, opts: { authority?: string } = {}): Promise<AssetOption[]> {
  const network = await loadNetworkPreferIndexer(() => loadNetwork(rpc));
  let assets = network.assets;
  if (opts.authority !== undefined) {
    const mine = network.issuers.filter((i) => i.authority.toString() === opts.authority);
    const issuerPdas = new Set(await Promise.all(
      mine.map(async (i) => (await findIssuerPda({ legalEntityId: i.legalEntityId }))[0].toString()),
    ));
    assets = assets.filter((a) => issuerPdas.has(a.issuer.toString()));
  }
  const minted = new Set(network.shareClasses.filter((sc) => sc.mintInitialized).map((sc) => sc.asset.toString()));
  return (await withAssetAddresses(assets))
    .filter(({ address }) => minted.has(address))
    .map(({ asset, address }) => ({ pda: address, name: asset.name, assetId: asset.assetId, symbol: asset.symbolPrefix }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.pda.localeCompare(b.pda));
}

/** The operator's reconciliation of one asset (Admin only). */
export async function readAdminCapTable(
  session: WalletSession | null | undefined,
  assetPda: string,
  interactive: SignedFetchInteractive = true,
): Promise<AssetReconciliation> {
  const data = await signedFetch<{ table: AssetReconciliation }>(
    session, "/api/cap-table/admin-read", "capTable.adminRead", { asset_pda: assetPda }, { interactive },
  );
  return data.table;
}

/** The issuer's reconciliation of one of its assets: wallets, units and decision references. */
export async function readIssuerCapTable(
  session: WalletSession | null | undefined,
  assetPda: string,
  interactive: SignedFetchInteractive = true,
): Promise<AssetReconciliation> {
  const data = await signedFetch<{ table: AssetReconciliation }>(
    session, "/api/cap-table/issuer-read", "capTable.issuerRead", { asset_pda: assetPda }, { interactive },
  );
  return data.table;
}

/** Record a register entry (fresh signature). */
export async function recordRegisterEntry(
  session: WalletSession | null | undefined,
  input: RegisterEntryInput,
): Promise<RegisterEntryView> {
  const data = await signedFetch<{ entry: RegisterEntryView }>(
    session, "/api/cap-table/register-create", "capTable.registerCreate", { ...input },
  );
  return data.entry;
}

/** Void a recorded register entry (fresh signature). */
export async function voidRegisterEntry(
  session: WalletSession | null | undefined,
  id: string,
  reason: string,
): Promise<RegisterEntryView> {
  const data = await signedFetch<{ entry: RegisterEntryView }>(
    session, "/api/cap-table/register-void", "capTable.registerVoid", { id, reason },
  );
  return data.entry;
}

/** The reconciliation as CSV (fresh signature; the server logs it before it answers). */
export async function exportCapTable(
  session: WalletSession | null | undefined,
  assetPda: string,
  personalData: boolean,
): Promise<{ filename: string; csv: string }> {
  return signedFetch<{ filename: string; csv: string }>(
    session, "/api/cap-table/export", "capTable.export", { asset_pda: assetPda, personal_data: personalData },
  );
}

/** Save `csv` as a file in the browser. */
export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

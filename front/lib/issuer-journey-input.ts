// From what the app reads to the issuer journey's input (lib/issuer-journey.ts):
// the on-chain snapshot (assets, share classes, sales, with the addresses the
// loader derived), the treasury balances and live sale approvals read from
// the chain, and the off-chain rows (applications, the SPV registry, the
// public-sale requests, conversion requests). Pure and node-safe, so the
// mapping is tested apart from the reads (tests/issuer-journey.test.ts); the
// reads themselves are lib/use-issuer-journey.ts.
//
// Every row type is imported as a type only: the modules that fetch them are
// browser modules, this one is not.

import type { ReadonlyUint8Array } from "@solana/kit";
import { AssetStatus, SaleStatus } from "@/lib/generated/asset_registry";
import type { Asset, Sale, ShareClass } from "@/lib/generated/asset_registry";
import type { LaunchApplication } from "@/lib/launchpad";
import type { SpvRow } from "@/lib/spvs";
import type { SaleRequestRow } from "@/lib/sale-requests";
import type { ConversionRequest } from "@/lib/conversion";
import type { JourneyApplication, JourneyAsset, JourneyClass, JourneySaleRequest, JourneySpv } from "@/lib/issuer-journey";

export type AddressedAsset = { address: string; asset: Asset };
export type AddressedClass = { address: string; shareClass: ShareClass };

const ASSET_STATUS: Record<AssetStatus, JourneyAsset["status"]> = {
  [AssetStatus.Draft]: "draft",
  [AssetStatus.Active]: "active",
  [AssetStatus.Frozen]: "frozen",
  [AssetStatus.WoundDown]: "wound_down",
};

/** Hex of a 32-byte hash, or null when it is all zeros (nothing recorded). */
export function hashHexOrNull(bytes: ReadonlyUint8Array): string | null {
  if (bytes.every((b) => b === 0)) return null;
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The company's latest application. The issuer reads its own rows
 * (applications.mine, already bound to the signer); the admin passes the
 * whole queue with `match`: a row linked to this issuer, or filed by its
 * authority wallet.
 */
export function latestApplication(
  rows: readonly LaunchApplication[],
  match?: { issuerPda: string; authority: string },
): JourneyApplication | null {
  const mine = match
    ? rows.filter((r) => r.linked_issuer === match.issuerPda || r.applicant_wallet === match.authority)
    : [...rows];
  const latest = mine.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0];
  if (!latest) return null;
  return {
    status: latest.status,
    applicantKind: latest.applicant_kind ?? null,
    incorporation: latest.incorporation,
    companyFormationRequested: latest.company_formation_requested === true,
  };
}

const SPV_PRIORITY: Record<JourneySpv["status"], number> = { active: 0, incorporating: 1, planned: 2, retired: 3 };

/** The SPV that speaks for the issuer: the most advanced one linked to it (a retired one only when nothing else is). */
export function pickIssuerSpv(rows: readonly Pick<SpvRow, "name" | "status">[]): JourneySpv | null {
  const best = [...rows].sort((a, b) => SPV_PRIORITY[a.status] - SPV_PRIORITY[b.status])[0];
  return best ? { name: best.name, status: best.status } : null;
}

/** A class's public-sale request from /api/sale-requests/list (undefined: not read). */
export function saleRequestOf(rows: readonly SaleRequestRow[] | undefined): JourneySaleRequest | null | undefined {
  if (rows === undefined) return undefined;
  const row = rows[0];
  return row?.request ? { status: row.request.status, outcome: row.outcome } : null;
}

/** Conversion requests of one class by stage (the flow never produces 'approved'). */
export function conversionCounts(rows: readonly Pick<ConversionRequest, "share_class_pda" | "status">[], shareClass: string): NonNullable<JourneyClass["conversions"]> {
  const counts = { requested: 0, vaultOpened: 0, deposited: 0, converted: 0 };
  for (const r of rows) {
    if (r.share_class_pda !== shareClass) continue;
    if (r.status === "requested") counts.requested += 1;
    else if (r.status === "vault_opened") counts.vaultOpened += 1;
    else if (r.status === "deposited") counts.deposited += 1;
    else if (r.status === "converted") counts.converted += 1;
  }
  return counts;
}

/**
 * The issuer's assets with their classes and every per-class figure the
 * journey reads. `assets` and `classes` must already be the issuer's (the
 * loader derived their addresses); sales of other classes are ignored.
 */
export function journeyAssets(input: {
  assets: readonly AddressedAsset[];
  classes: readonly AddressedClass[];
  sales: readonly Sale[];
  /** Treasury balance per class address (null: unread). A class without a mint needs none. */
  treasury: ReadonlyMap<string, bigint | null>;
  /** Live approvals per class address; null when they could not be read. */
  liveApprovals: ReadonlyMap<string, number> | null;
  /** Public-sale request per class address; absent: not read. */
  saleRequests?: ReadonlyMap<string, JourneySaleRequest | null | undefined>;
  /** Conversion requests (admin); undefined: not read. */
  conversions?: readonly Pick<ConversionRequest, "share_class_pda" | "status">[];
}): JourneyAsset[] {
  return input.assets.map(({ address, asset }) => ({
    address,
    name: asset.name,
    status: ASSET_STATUS[asset.status] ?? "draft",
    legalDocHash: hashHexOrNull(asset.legalDocHash),
    classes: input.classes
      .filter((c) => c.shareClass.asset.toString() === address)
      .map(({ address: classAddress, shareClass: sc }): JourneyClass => {
        const sales = input.sales.filter((s) => s.shareClass.toString() === classAddress);
        return {
          mintInitialized: sc.mintInitialized,
          maxSupply: sc.maxSupply.__option === "Some" ? sc.maxSupply.value : null,
          lifetimeMinted: sc.lifetimeMinted,
          circulatingSupply: sc.circulatingSupply,
          supplyLocked: sc.supplyLocked,
          treasury: sc.mintInitialized ? (input.treasury.get(classAddress) ?? null) : BigInt(0),
          sold: sales.reduce((n, s) => n + s.sold, BigInt(0)),
          openSales: sales.filter((s) => s.status === SaleStatus.Open).length,
          liveApprovals: input.liveApprovals === null ? null : (input.liveApprovals.get(classAddress) ?? 0),
          saleRequest: input.saleRequests ? input.saleRequests.get(classAddress) : undefined,
          conversions: input.conversions ? conversionCounts(input.conversions, classAddress) : undefined,
        };
      }),
  }));
}

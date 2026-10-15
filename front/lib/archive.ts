// Archive (soft delete, off-chain) of assets and issuers.
//
// The registry has no close instruction for Issuer, Asset or ShareClass: an
// account made on chain stays there for good. What the platform CAN do is stop
// showing it. Archiving records that decision off chain, with a reason:
//
//   asset  -> asset_profiles.status = 'archived' (an existing value of the
//             0014 check), is_published = false, and the record in
//             fields.archive (who, when, why, what it was before). No
//             migration.
//   issuer -> issuer_profiles.archive (jsonb, migration 0081, expand-only).
//             The front tolerates its absence: issuer archive is then
//             reported as unavailable and nothing is hidden for issuers.
//
// An archived asset (or every asset of an archived issuer) is left out of the
// public lists (explore, primary sales, market overview), its public pages say
// "This asset was withdrawn", the issuer workspace lists and the tokenize
// flow's Continue list / duplicate prompt skip it, and the admin lists hide it
// unless "Show archived" is on. Holders keep seeing what they hold
// (portfolio), and nothing on chain changes — except the optional, one-way
// lock_supply at 0 the admin dialog offers (A2).
//
// Pure and node-safe: the routes (lib/server/archive.ts), the dialog and the
// tests share these rules.
import type { Address } from "@solana/kit";
import { findAssetPda, findIssuerPda } from "@/lib/generated/asset_registry";
import { findShareClassPda } from "@/lib/pdas";
import type { NetworkData } from "@/lib/enumerate";

export type ArchiveKind = "asset" | "issuer";

export const ARCHIVE_REASON_MIN = 10;
export const ARCHIVE_REASON_MAX = 500;

/** Why an archive needs the super admin's explicit confirmation (or is refused). */
export type ArchiveBlockerCode =
  | "open_sale"
  | "live_approval"
  | "circulating"
  | "issuer_assets_with_supply";

export type ArchiveBlocker = { code: ArchiveBlockerCode; message: string };

/** What is stored for an archived asset (fields.archive) or issuer (issuer_profiles.archive). */
export type ArchiveRecord = {
  reason: string;
  archived_by: string;
  archived_at: string;
  /** Asset only: the profile status before archiving, restored on unarchive. */
  previous_status?: "draft" | "published";
  previous_is_published?: boolean;
  /** Asset only: the archive created the profile row (unarchive removes it again). */
  row_created?: boolean;
  /** Blockers the super admin confirmed over, kept with the record. */
  overridden?: ArchiveBlockerCode[];
};

/** One share class of an asset, as the archive checks read it on chain. */
export type ArchiveClassFacts = {
  address: string;
  classIndex: number;
  circulating: bigint;
  lifetimeMinted: bigint;
  supplyLocked: boolean;
};

export type AssetArchiveFacts = {
  /** On-chain AssetStatus.Draft. */
  draft: boolean;
  classes: ArchiveClassFacts[];
  /** Open Sale accounts of the asset's classes. */
  openSales: number;
  /** Unexpired SaleApproval accounts of the asset's classes (consumed ones are closed). */
  liveApprovals: number;
};

/** Validates the required reason; returns the trimmed text or an error message. */
export function checkArchiveReason(value: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = typeof value === "string" ? value.trim() : "";
  if (reason.length < ARCHIVE_REASON_MIN) {
    return { ok: false, error: `Give a reason of at least ${ARCHIVE_REASON_MIN} characters (it goes into the audit log).` };
  }
  if (reason.length > ARCHIVE_REASON_MAX) {
    return { ok: false, error: `Keep the reason under ${ARCHIVE_REASON_MAX} characters.` };
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
    return { ok: false, error: "Remove control characters from the reason." };
  }
  return { ok: true, reason };
}

export function circulatingOf(facts: Pick<AssetArchiveFacts, "classes">): bigint {
  return facts.classes.reduce((sum, c) => sum + c.circulating, BigInt(0));
}

/**
 * What stands against archiving an asset. Each one is something a buyer or a
 * holder could still meet after the asset disappears from the lists, so the
 * super admin must confirm it explicitly; the issuer path refuses outright.
 */
export function assetArchiveBlockers(facts: AssetArchiveFacts): ArchiveBlocker[] {
  const out: ArchiveBlocker[] = [];
  if (facts.openSales > 0) {
    out.push({
      code: "open_sale",
      message: `${facts.openSales} sale${facts.openSales === 1 ? " is" : "s are"} still Open on chain: buyers with a direct link can still buy. Close the sale first, or confirm that hiding it is intended.`,
    });
  }
  if (facts.liveApprovals > 0) {
    out.push({
      code: "live_approval",
      message: `${facts.liveApprovals} sale approval${facts.liveApprovals === 1 ? " is" : "s are"} still live: the issuer can still open a sale with ${facts.liveApprovals === 1 ? "it" : "them"}. Revoke ${facts.liveApprovals === 1 ? "it" : "them"} first, or confirm.`,
    });
  }
  const circulating = circulatingOf(facts);
  if (circulating > BigInt(0)) {
    out.push({
      code: "circulating",
      message: `${circulating.toString()} token unit${circulating === BigInt(1) ? " is" : "s are"} in circulation: holders still own ${circulating === BigInt(1) ? "it" : "them"} and will still see the asset in their portfolio. Archiving only hides it from lists.`,
    });
  }
  return out;
}

/**
 * The issuer authority may archive its OWN asset only while it is a Draft or
 * was never minted, with nothing circulating and no Open sale or live
 * approval. Returns why not, or null when allowed.
 */
export function issuerArchiveRefusal(facts: AssetArchiveFacts): string | null {
  const minted = facts.classes.some((c) => c.lifetimeMinted > BigInt(0));
  if (!facts.draft && minted) {
    return "Tokens of this asset were created: only the platform's super admin can archive it.";
  }
  const blockers = assetArchiveBlockers(facts);
  if (blockers.length > 0) {
    return `Only the platform's super admin can archive it now: ${blockers.map((b) => b.message).join(" ")}`;
  }
  return null;
}

/** The share classes the admin dialog may lock at 0 (A2): nothing circulating, not yet locked. */
export function lockableAtZero(facts: Pick<AssetArchiveFacts, "classes">): ArchiveClassFacts[] {
  return facts.classes.filter((c) => c.circulating === BigInt(0) && !c.supplyLocked);
}

/** Builds the stored asset record from the profile row as it is before archiving. */
export function assetArchiveRecord(input: {
  reason: string;
  wallet: string;
  now: Date;
  existing: { status?: unknown; is_published?: unknown } | null;
  overridden: ArchiveBlockerCode[];
}): ArchiveRecord {
  const previous = input.existing?.status === "published" ? "published" : "draft";
  return {
    reason: input.reason,
    archived_by: input.wallet,
    archived_at: input.now.toISOString(),
    previous_status: previous,
    previous_is_published: input.existing?.is_published === true,
    row_created: input.existing === null,
    ...(input.overridden.length ? { overridden: input.overridden } : {}),
  };
}

/** Reads a stored record back (null when absent or malformed). */
export function readArchiveRecord(value: unknown): ArchiveRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.reason !== "string" || typeof v.archived_by !== "string" || typeof v.archived_at !== "string") return null;
  return v as unknown as ArchiveRecord;
}

/**
 * True when unarchiving an asset puts its profile back on the public lists:
 * it was published when archived, and the archive did not create the row
 * (unarchive then restores status 'published' with is_published). KYC-only
 * mode refuses that to an issuer, a publish being an issuance entry as on
 * /api/profiles/upsert (lib/server/archive-actions.ts, /api/archive/set).
 */
export function unarchiveRepublishes(record: ArchiveRecord | null): boolean {
  return !!record && record.row_created !== true && record.previous_status === "published" && record.previous_is_published === true;
}

/**
 * `fields.archive` belongs to the archive route alone: a profile patch never
 * sets it, and a patch that writes `fields` whole keeps the stored one.
 */
export function protectArchive(
  patch: Record<string, unknown>,
  stored: Record<string, unknown> | null,
): Record<string, unknown> {
  const out = { ...patch };
  delete out.archive;
  if (stored && stored.archive !== undefined) out.archive = stored.archive;
  return out;
}

// ── Hiding archived records from lists ────────────────────────────────────

/** The archived asset and issuer PDAs of this network (GET /api/archive/list). */
export type ArchivedSet = {
  assets: ReadonlySet<string>;
  issuers: ReadonlySet<string>;
  /** False when issuer archive is not available yet (migration 0081 not applied). */
  issuerArchiveAvailable: boolean;
};

export const EMPTY_ARCHIVED: ArchivedSet = { assets: new Set(), issuers: new Set(), issuerArchiveAvailable: false };

export function archivedSetFrom(body: unknown): ArchivedSet {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const list = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { assets: list(b.assets), issuers: list(b.issuers), issuerArchiveAvailable: b.issuerArchiveAvailable === true };
}

/** An asset is withdrawn when it, or its issuer, is archived. */
export function isWithdrawn(set: ArchivedSet, assetPda: string | null | undefined, issuerPda: string | null | undefined): boolean {
  return (!!assetPda && set.assets.has(assetPda)) || (!!issuerPda && set.issuers.has(issuerPda));
}

/**
 * NetworkData without archived issuers, archived assets (or assets of an
 * archived issuer), and the share classes, sales and rights issuances of
 * those assets. Offers and vesting milestones are left as they are: they
 * belong to holders, who keep seeing what they hold.
 *
 * `issuers: false` (the issuer workspace) hides only archived ASSETS: an
 * archived issuer still sees itself and its own assets there.
 */
export async function hideArchived(
  data: NetworkData,
  set: ArchivedSet,
  opts: { issuers?: boolean } = {},
): Promise<NetworkData> {
  const effective: ArchivedSet = opts.issuers === false ? { ...set, issuers: new Set() } : set;
  if (effective.assets.size === 0 && effective.issuers.size === 0) return data;
  const issuers: NetworkData["issuers"] = [];
  for (const issuer of data.issuers) {
    const [pda] = await findIssuerPda({ legalEntityId: issuer.legalEntityId });
    if (!effective.issuers.has(pda.toString())) issuers.push(issuer);
  }
  const hiddenAssets = new Set<string>();
  const assets: NetworkData["assets"] = [];
  for (const asset of data.assets) {
    const [pda] = await findAssetPda({ issuer: asset.issuer, assetId: asset.assetId });
    if (isWithdrawn(effective, pda.toString(), asset.issuer.toString())) hiddenAssets.add(pda.toString());
    else assets.push(asset);
  }
  if (hiddenAssets.size === 0 && issuers.length === data.issuers.length) return data;
  const hiddenClasses = new Set<string>();
  const shareClasses: NetworkData["shareClasses"] = [];
  for (const sc of data.shareClasses) {
    if (hiddenAssets.has(sc.asset.toString())) {
      hiddenClasses.add((await findShareClassPda(sc.asset as Address, sc.classIndex)).toString());
    } else {
      shareClasses.push(sc);
    }
  }
  return {
    ...data,
    issuers,
    assets,
    shareClasses,
    sales: data.sales.filter((s) => !hiddenClasses.has(s.shareClass.toString())),
    rightsIssuances: data.rightsIssuances.filter((r) => !hiddenClasses.has(r.shareClass.toString())),
  };
}

/** Copy for a direct link to an archived asset or issuer. */
export const WITHDRAWN_TITLE = "This asset was withdrawn";
export const WITHDRAWN_ISSUER_TITLE = "This issuer was withdrawn";
export const WITHDRAWN_BODY =
  "It is no longer offered on Manci. The on-chain record stays (blockchain records cannot be deleted), but the platform no longer lists it. If you hold tokens of it, they remain in your portfolio.";

/** Plain explanation shown in every archive dialog. */
export const ARCHIVE_PERMANENCE_NOTE =
  "Archiving only hides it on Manci. The on-chain record stays on Solana forever — the registry has no instruction that deletes an issuer, asset or share class, and anyone can still read it with an explorer. Unarchiving shows it again.";

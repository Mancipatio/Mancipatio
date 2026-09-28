// The "waiting for you" rules behind the admin menu badges.
//
// Pure and shared: the server counts with them (lib/server/admin-badges.ts,
// POST /api/admin/badges) and the pages that show the same number filter
// with them, so a badge can always be found on its page. No React, no
// "use client", no Supabase or wallet imports — the server imports this file.
//
// Rules (docs: mainnet-readiness/admin-badges-design.md):
//   * a badge counts rows whose next step belongs to the viewer — rows that
//     wait on a client, an issuer or the chain are not counted;
//   * the number is one the page already shows (a tab, KPI, pill or filter);
//   * `null` means "could not count now" and is never shown as 0;
//   * the response carries hrefs, integers, fixed reason keys and one
//     timestamp per queue — never rows, ids or PII.

import type { Network } from "@/lib/network";
import { proposalWindowState } from "@/lib/proposal-window";
import { AssetStatus } from "@/lib/generated/asset_registry/types/assetStatus";
import { ProposalStatus } from "@/lib/generated/asset_registry/types/proposalStatus";
import { SaleStatus } from "@/lib/generated/asset_registry/types/saleStatus";

// ── Response shape ──────────────────────────────────────────────────────────

/** The admin pages that have a queue, in menu order. */
export const ADMIN_BADGE_HREFS = [
  "/admin/issuers",
  "/admin/applications",
  "/admin/assets",
  "/admin/launchpad",
  "/admin/custody",
  "/admin/otc",
  "/admin/governance",
  "/admin/vesting",
  "/admin/clients",
  "/admin/inquiries",
  "/admin/kyc",
  "/admin/compliance",
  "/admin/admins",
  "/admin/payouts",
  "/admin/platform",
] as const;

export type AdminBadgeHref = (typeof ADMIN_BADGE_HREFS)[number];

export function isAdminBadgeHref(href: string): href is AdminBadgeHref {
  return (ADMIN_BADGE_HREFS as readonly string[]).includes(href);
}

/** Why rows count (tooltip). Fixed keys, never data. */
export type BadgePart =
  // Clients
  | "final"
  | "documents"
  | "kyb"
  // Inquiries, KYC
  | "new"
  | "inReview"
  // Compliance
  | "open"
  | "escalated"
  // Custody
  | "delivery"
  | "conversion"
  // Assets (`ready` counts; the other two are waiting on the issuer)
  | "ready"
  | "issuerNotVerified"
  | "noShareClasses"
  // Launchpad
  | "yours"
  | "issuers"
  // Admins and Platform (v1.0.0-rc timelocked role changes)
  | "timelock"
  | "stale"
  | "awaitingKey"
  | "rotation"
  | "recovery";

export type AdminBadge = {
  /** Rows waiting for the caller; null = could not be counted now (never shown as 0). */
  count: number | null;
  /** Per-reason counts that make up `count` (they may overlap for Clients). */
  parts?: Partial<Record<BadgePart, number>>;
  /** Related rows NOT in `count`, named in the tooltip only (they wait on someone else). */
  aside?: Partial<Record<BadgePart, number>>;
  /** A bounded read hit its cap: the real number is at least `count`. */
  atLeast?: true;
  /**
   * ISO time of the newest counted row (Clients, KYC, Applications), so the
   * menu can mark "new since your last visit" — a backlog of 65 going to 66
   * is otherwise invisible.
   */
  latest?: string;
  reason?: "indexer" | "unavailable";
};

export type AdminBadges = {
  network: Network;
  checkedAt: string;
  /** Only the hrefs the caller's role may open. */
  badges: Partial<Record<AdminBadgeHref, AdminBadge>>;
};

// ── Clients (/admin/clients) ────────────────────────────────────────────────

/** Why a dossier waits for a reviewer. */
export type ClientReviewReason = "documents" | "final" | "kyb";

export const CLIENT_REVIEW_REASONS: readonly ClientReviewReason[] = ["documents", "final", "kyb"];

/** KYC states only compliance can lift; nothing waits in them (mirrors TERMINAL_KYC_STATUSES). */
const CLOSED_KYC_STATUSES: readonly string[] = ["suspended", "rejected"];

export type ClientReviewInput = {
  kyc_status: string;
  /** Every kyc_requirements row of the dossier (status only). */
  requirements: readonly { status: string }[];
  /** Every client_verification_details row of the dossier (/verify intake). */
  details: readonly { kind: string; status: string }[];
};

/**
 * Why a dossier waits for a reviewer, or [] when its next step belongs to the
 * client (or to nobody):
 *   * `documents` — an uploaded document waits for approve / reject;
 *   * `final`     — KYC is `pending`, every requested document is approved and
 *                   something was submitted (an approved document or /verify
 *                   details): the verdict is next. A `pending` dossier with
 *                   nothing submitted (an admin-created client that has not
 *                   onboarded yet) or with a document still `requested` or
 *                   `rejected` waits on the client — verifying needs every
 *                   document approved first (unapprovedRequirements);
 *   * `kyb`       — admins only (`includeKyb`; the decision is requireAdmin):
 *                   company details `pending` and every requested document
 *                   approved — the page asks to review the company documents
 *                   before deciding.
 * Suspended and rejected dossiers never count; erased (anonymized) dossiers
 * are filtered out before this runs.
 */
export function clientReviewReasons(
  input: ClientReviewInput,
  opts: { includeKyb: boolean },
): ClientReviewReason[] {
  if (CLOSED_KYC_STATUSES.includes(input.kyc_status)) return [];
  const statuses = input.requirements.map((r) => r.status);
  const settled = statuses.every((s) => s === "approved");
  const reasons: ClientReviewReason[] = [];
  if (statuses.includes("submitted")) reasons.push("documents");
  if (input.kyc_status === "pending" && settled && (statuses.length > 0 || input.details.length > 0)) {
    reasons.push("final");
  }
  if (opts.includeKyb && settled && input.details.some((d) => d.kind === "kyb" && d.status === "pending")) {
    reasons.push("kyb");
  }
  return reasons;
}

// ── Custody (/admin/custody) ────────────────────────────────────────────────
// `vault_opened` waits on the holder's deposit. The legacy `approved` status
// is allowed by the DB but never produced and has no action in the UI.

/** Delivery requests with an admin step: approve & open, mark in delivery, confirm delivery. */
export const DELIVERY_ADMIN_STATUSES = ["requested", "deposited", "in_delivery"] as const;
/** Conversion requests with an admin step: approve & open, confirm conversion. */
export const CONVERSION_ADMIN_STATUSES = ["requested", "deposited"] as const;

export function deliveryWaitsForAdmin(status: string): boolean {
  return (DELIVERY_ADMIN_STATUSES as readonly string[]).includes(status);
}

export function conversionWaitsForAdmin(status: string): boolean {
  return (CONVERSION_ADMIN_STATUSES as readonly string[]).includes(status);
}

// ── Assets (/admin/assets) ──────────────────────────────────────────────────

/** Why `activate_asset` would fail for a row (AR/instructions/activate_asset.rs). */
export type AssetActivationBlock = "notDraft" | "issuerNotVerified" | "noShareClasses";

/**
 * null when an admin can activate the asset now: it is a Draft, its issuer's
 * KYB is Verified and it has at least one share class. The signer also needs
 * an AdminRecord, which is per wallet and checked by the page.
 */
export function assetActivationBlock(asset: {
  status: number;
  shareClassesCount: number;
  issuerVerified: boolean;
}): AssetActivationBlock | null {
  if (asset.status !== AssetStatus.Draft) return "notDraft";
  if (!asset.issuerVerified) return "issuerNotVerified";
  if (!(asset.shareClassesCount > 0)) return "noShareClasses";
  return null;
}

// ── Launchpad and governance (indexer) ──────────────────────────────────────

/** An open sale whose end time has passed: its issuer key must close it. */
export function saleExpiredOpen(
  sale: { status: number; endTs: bigint | number },
  nowSec: number,
): boolean {
  const end = Number(sale.endTs);
  return sale.status === SaleStatus.Open && end > 0 && end <= nowSec;
}

/** An active proposal whose voting window is over: anyone may finalize it. */
export function proposalAwaitsFinalize(
  proposal: { status: number; endTs: bigint | number },
  nowSec: number,
): boolean {
  const end = Number(proposal.endTs);
  return proposal.status === ProposalStatus.Active && end > 0 && end <= nowSec;
}

// ── Vesting series (/admin/vesting) ─────────────────────────────────────────

/** PostgREST `or` filter of vestingSeriesNeedsReview. A constant, never user input. */
export const VESTING_REVIEW_FILTER =
  "status.eq.submitted,and(status.eq.approved,approved_terms_hash.is.null,series_pda.is.null)";

/** Submitted, or approved before the approved-terms hash existed and not yet created. */
export function vestingSeriesNeedsReview(row: {
  status: string;
  approved_terms_hash?: string | null;
  series_pda?: string | null;
}): boolean {
  return (
    row.status === "submitted" ||
    (row.status === "approved" && !row.approved_terms_hash && !row.series_pda)
  );
}

// ── Admins and Platform (v1.0.0-rc, 0079 mirror) ────────────────────────────
// A staged role change exists so that someone can veto it before it runs:
// while it is inside its timelock the veto is the admins' step (the Super
// Admin, any Admin, or the upgrade authority cancels). Once executable it
// waits on the NEW key (named, not counted); once expired nobody can run it.
// The windows are the program's (lib/proposal-window.ts); the bootstrap
// window (pause bit 7) waives the Admin-grant and Super-Admin-rotation
// timelocks, never the expiry.

/** A mirrored staged change; the timestamps are unix seconds (numbers or strings). */
export type StagedChangeRow = {
  proposed_at: number | string;
  eta?: number | string | null;
  expires_at: number | string;
  proposed_by?: string | null;
  current_authority?: string | null;
};

type PlatformContext = { superAdmin: string | null; pauseFlags: number | null; nowSec: number };

function windowOf(row: StagedChangeRow, ctx: PlatformContext, bootstrapWaived: boolean) {
  const proposedAt = Number(row.proposed_at);
  return proposalWindowState(
    { proposedAt, eta: row.eta === undefined || row.eta === null ? proposedAt : Number(row.eta), expiresAt: Number(row.expires_at) },
    ctx.nowSec,
    { pauseFlags: ctx.pauseFlags, bootstrapWaived },
  );
}

/**
 * /admin/admins: staged Admin grants (`PendingAdmin`) inside their 48 h
 * review window (`timelock`), and live grants proposed by an earlier Super
 * Admin (`stale`: add_admin refuses them, cancel them — K1.10). Grants past
 * their timelock wait on the new admin's signature (`awaitingKey`, aside).
 */
export function adminGrantBadge(rows: readonly StagedChangeRow[], ctx: PlatformContext): AdminBadge {
  const tally = { timelock: 0, stale: 0, awaitingKey: 0 };
  for (const row of rows) {
    const state = windowOf(row, ctx, true);
    if (state.kind === "expired") continue;
    if (ctx.superAdmin !== null && row.proposed_by && row.proposed_by !== ctx.superAdmin) tally.stale += 1;
    else if (state.kind === "waiting") tally.timelock += 1;
    else tally.awaitingKey += 1;
  }
  return {
    count: tally.timelock + tally.stale,
    parts: { timelock: tally.timelock, stale: tally.stale },
    aside: { awaitingKey: tally.awaitingKey },
  };
}

/**
 * /admin/platform: a Super Admin rotation (`AuthorityProposal` kind 0) inside
 * its 48 h window (`rotation`), and every live upgrade-authority recovery of
 * the Super Admin or the blocklist authority (`recovery`: the holder cancels
 * it until it runs). Executable rotations, and blocklist-authority rotations
 * (no timelock), wait on the new key (`awaitingKey`, aside). A rotation whose
 * current authority is no longer the Super Admin is dead and not counted.
 */
export function platformChangeBadge(
  input: {
    rotations: readonly StagedChangeRow[];
    recoveries: readonly StagedChangeRow[];
    blocklistRotations: readonly StagedChangeRow[];
  },
  ctx: PlatformContext,
): AdminBadge {
  const tally = { rotation: 0, recovery: 0, awaitingKey: 0 };
  for (const row of input.rotations) {
    const state = windowOf(row, ctx, true);
    if (state.kind === "expired") continue;
    if (ctx.superAdmin !== null && row.current_authority && row.current_authority !== ctx.superAdmin) continue;
    if (state.kind === "waiting") tally.rotation += 1;
    else tally.awaitingKey += 1;
  }
  for (const row of input.recoveries) {
    if (windowOf(row, ctx, false).kind !== "expired") tally.recovery += 1;
  }
  for (const row of input.blocklistRotations) {
    if (windowOf(row, ctx, false).kind !== "expired") tally.awaitingKey += 1;
  }
  return {
    count: tally.rotation + tally.recovery,
    parts: { rotation: tally.rotation, recovery: tally.recovery },
    aside: { awaitingKey: tally.awaitingKey },
  };
}

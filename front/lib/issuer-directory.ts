// Issuer directory (/admin/issuers): the review-queue ordering, the status
// chip counts, the KYB dossier link and the KYB-decision reconciliation.
//
// The directory list is indexer-first (lib/indexer loadNetworkPreferIndexer),
// and the indexer trails the chain by a few seconds. Right after a verify /
// reject the list therefore still reads "Pending"; a reviewer who then tried
// again hit an error because the issuer was already decided on chain. The
// page now (1) re-reads the issuer on chain before sending and refuses when
// it is no longer pending, (2) overlays the decided status on the row
// (`KybOverrides`) until the indexer-backed list agrees, and (3) polls that
// list for a bounded time (`startKybReconcile`).

import { KybStatus } from "@/lib/generated/asset_registry";
import { fromBytes32, KYB_LABEL } from "@/lib/format";
import { startFinalityPoll } from "@/lib/finality-poll";

export type IssuerStatusFilter =
  | "all"
  | "pending"
  | "verified"
  | "rejected"
  | "suspended";

export const ISSUER_STATUS_FILTERS: readonly IssuerStatusFilter[] = [
  "all",
  "pending",
  "verified",
  "rejected",
  "suspended",
];

const STATUS_TO_FILTER: Record<number, IssuerStatusFilter> = {
  [KybStatus.Pending]: "pending",
  [KybStatus.Verified]: "verified",
  [KybStatus.Rejected]: "rejected",
  [KybStatus.Suspended]: "suspended",
};

/** The issuer fields the directory reads; a decoded on-chain `Issuer` fits. */
export type DirectoryIssuer = {
  legalEntityId: ArrayLike<number>;
  authority: string;
  jurisdiction: number;
  kybStatus: KybStatus;
};

/** The legal-entity id as text (the row key and the PDA seed). */
export function issuerLegalId(issuer: Pick<DirectoryIssuer, "legalEntityId">): string {
  return fromBytes32(issuer.legalEntityId);
}

export function isPendingKyb(issuer: Pick<DirectoryIssuer, "kybStatus">): boolean {
  return issuer.kybStatus === KybStatus.Pending;
}

/** Whether a row belongs under a status chip ("all" matches every row). */
export function matchesStatus(
  issuer: Pick<DirectoryIssuer, "kybStatus">,
  status: IssuerStatusFilter,
): boolean {
  return status === "all" || STATUS_TO_FILTER[issuer.kybStatus] === status;
}

/**
 * Review-queue order: pending KYB first, then by legal-entity id, then by
 * authority (a stable tie-break for two rows with the same name).
 */
export function compareForReview(a: DirectoryIssuer, b: DirectoryIssuer): number {
  const pa = isPendingKyb(a) ? 0 : 1;
  const pb = isPendingKyb(b) ? 0 : 1;
  if (pa !== pb) return pa - pb;
  const byName = issuerLegalId(a).localeCompare(issuerLegalId(b));
  if (byName !== 0) return byName;
  return String(a.authority).localeCompare(String(b.authority));
}

/**
 * The visible rows, in review-queue order. The query matches the legal-entity
 * id, the authority wallet or the jurisdiction code. `keepLegalId` (the open
 * row) stays visible under the status chip even after its status changed, so
 * a verify / reject never makes the open review vanish under the reviewer;
 * it still has to match the query.
 */
export function filterIssuers<T extends DirectoryIssuer>(
  issuers: readonly T[],
  opts: { query: string; status: IssuerStatusFilter; keepLegalId?: string | null },
): T[] {
  const q = opts.query.trim().toLowerCase();
  return issuers
    .filter((issuer) => {
      const legalId = issuerLegalId(issuer);
      const kept = !!opts.keepLegalId && legalId === opts.keepLegalId;
      if (!kept && !matchesStatus(issuer, opts.status)) return false;
      if (!q) return true;
      return (
        legalId.toLowerCase().includes(q) ||
        String(issuer.authority).toLowerCase().includes(q) ||
        String(issuer.jurisdiction).includes(q)
      );
    })
    .sort(compareForReview);
}

export type IssuerStatusCounts = Record<IssuerStatusFilter, number>;

export function issuerStatusCounts(
  issuers: readonly Pick<DirectoryIssuer, "kybStatus">[],
): IssuerStatusCounts {
  const counts: IssuerStatusCounts = {
    all: issuers.length,
    pending: 0,
    verified: 0,
    rejected: 0,
    suspended: 0,
  };
  for (const issuer of issuers) {
    const key = STATUS_TO_FILTER[issuer.kybStatus];
    if (key) counts[key] += 1;
  }
  return counts;
}

/** "Pending (7)"; just the name while the list is loading. */
export function statusChipLabel(
  status: IssuerStatusFilter,
  counts: IssuerStatusCounts | null,
): string {
  const name = status === "all" ? "All" : status.charAt(0).toUpperCase() + status.slice(1);
  return counts ? `${name} (${counts[status]})` : name;
}

/**
 * The KYB documents live in the client dossier (/admin/clients/<id>). The
 * issuer's authority is the applicant wallet, and /admin/clients seeds its
 * search from `?q=`, which matches wallets.
 */
export function kybDossierHref(authority: string): string {
  return `/admin/clients?q=${encodeURIComponent(authority)}`;
}

// ── KYB decision reconciliation ─────────────────────────────────────────────

/** The on-chain status a verify_issuer_kyb(approved) sets. */
export function decisionStatus(approved: boolean): KybStatus {
  return approved ? KybStatus.Verified : KybStatus.Rejected;
}

export function kybLabel(status: KybStatus): string {
  return KYB_LABEL[status] ?? "Unknown";
}

export type KybPreflight =
  | { ok: true }
  | { ok: false; status: KybStatus | null; message: string };

/**
 * Checked on the LIVE chain record right before a KYB decision is sent: only
 * a still-pending issuer is decided. A decided one (an earlier attempt whose
 * row still read "Pending" from the indexer, or another admin) is refused
 * with its chain status so the page can show it instead of sending again.
 */
export function kybDecisionPreflight(
  live: Pick<DirectoryIssuer, "kybStatus"> | null,
): KybPreflight {
  if (!live) {
    return { ok: false, status: null, message: "Issuer account not found on chain." };
  }
  if (live.kybStatus !== KybStatus.Pending) {
    return {
      ok: false,
      status: live.kybStatus,
      message: `Already ${kybLabel(live.kybStatus).toLowerCase()} on chain`,
    };
  }
  return { ok: true };
}

/**
 * The status to show after a confirmed decision, given a fresh chain read.
 * A read that still says Pending is RPC lag (keep the decision); any other
 * status is the chain's truth (e.g. a concurrent decision) and wins. A failed
 * read (`null`) keeps the decision.
 */
export function reconciledStatus(decided: KybStatus, live: KybStatus | null): KybStatus {
  return live === null || live === KybStatus.Pending ? decided : live;
}

/**
 * A status seen on chain but maybe not yet in the indexer-backed list, keyed
 * by legal-entity id. `syncing`: the list is being polled; `chain`: the poll
 * gave up and the row keeps showing the chain status.
 */
export type KybOverride = { status: KybStatus; phase: "syncing" | "chain" };
export type KybOverrides = Readonly<Record<string, KybOverride>>;

/** The rows with each override's status (new objects; the source is untouched). */
export function applyKybOverrides<T extends Pick<DirectoryIssuer, "legalEntityId" | "kybStatus">>(
  issuers: readonly T[],
  overrides: KybOverrides,
): T[] {
  if (Object.keys(overrides).length === 0) return [...issuers];
  return issuers.map((issuer) => {
    const override = overrides[issuerLegalId(issuer)];
    return override && override.status !== issuer.kybStatus
      ? { ...issuer, kybStatus: override.status }
      : issuer;
  });
}

/** Whether the list shows `status` for the issuer. */
export function listAgrees(
  issuers: readonly Pick<DirectoryIssuer, "legalEntityId" | "kybStatus">[],
  legalId: string,
  status: KybStatus,
): boolean {
  return issuers.some((i) => issuerLegalId(i) === legalId && i.kybStatus === status);
}

/**
 * The overrides a freshly loaded list does not agree with yet. One the list
 * agrees with is settled, and one for an issuer no longer listed is moot;
 * both are dropped. Returns `overrides` itself when nothing changed.
 */
export function unsettledOverrides(
  issuers: readonly Pick<DirectoryIssuer, "legalEntityId" | "kybStatus">[],
  overrides: KybOverrides,
): KybOverrides {
  const keys = Object.keys(overrides);
  if (keys.length === 0) return overrides;
  const listed = new Map(issuers.map((i) => [issuerLegalId(i), i.kybStatus]));
  const next: Record<string, KybOverride> = {};
  let changed = false;
  for (const key of keys) {
    const indexed = listed.get(key);
    if (indexed === undefined || indexed === overrides[key].status) {
      changed = true;
      continue;
    }
    next[key] = overrides[key];
  }
  return changed ? next : overrides;
}

/** Marks an override as chain-only (the poll gave up); a no-op when absent. */
export function markChainOnly(overrides: KybOverrides, legalId: string): KybOverrides {
  const current = overrides[legalId];
  if (!current || current.phase === "chain") return overrides;
  return { ...overrides, [legalId]: { ...current, phase: "chain" } };
}

export const KYB_RECONCILE_INTERVAL_MS = 5_000;
/** 12 × 5 s = one minute, well past the usual indexer lag. */
export const KYB_RECONCILE_ATTEMPTS = 12;

/**
 * Re-loads the indexer-backed list every 5 s (never overlapping) until it
 * shows `status` for `legalId`, for at most a minute. `load` commits what it
 * loaded (the page's own refresh); `onAgree` / `onGiveUp` run at most once,
 * and never after the returned stop function was called.
 */
export function startKybReconcile(
  opts: {
    legalId: string;
    status: KybStatus;
    load: () => Promise<readonly Pick<DirectoryIssuer, "legalEntityId" | "kybStatus">[]>;
    onAgree?: () => void;
    onGiveUp?: () => void;
  },
  timers?: Parameters<typeof startFinalityPoll>[2],
): () => void {
  let stopped = false;
  const stop = startFinalityPoll(
    async () => {
      const agrees = listAgrees(await opts.load(), opts.legalId, opts.status);
      if (agrees && !stopped) opts.onAgree?.();
      return agrees;
    },
    {
      intervalMs: KYB_RECONCILE_INTERVAL_MS,
      attempts: KYB_RECONCILE_ATTEMPTS,
      onGiveUp: () => {
        if (!stopped) opts.onGiveUp?.();
      },
    },
    timers,
  );
  return () => {
    stopped = true;
    stop();
  };
}

/**
 * Asks the admin menu to re-count its badges (pending KYB and the like). The
 * menu listens for this event; nothing happens when nobody does.
 */
export const ADMIN_BADGES_REFRESH_EVENT = "admin:badges-refresh";

export function requestAdminBadgesRefresh(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(ADMIN_BADGES_REFRESH_EVENT));
}

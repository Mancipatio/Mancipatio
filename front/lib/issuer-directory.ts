// Issuer directory (/admin/issuers): the review-queue ordering, the status
// chip counts, the KYB dossier link and the KYB-decision reconciliation.
//
// The directory list is indexer-first (lib/indexer loadNetworkPreferIndexer),
// and the indexer trails the chain by a few seconds. Right after a verify /
// reject the list therefore still reads "Pending"; a reviewer who then tried
// again hit an error because the issuer was already decided on chain. The
// page now (1) re-reads the issuer on chain before sending and refuses when
// it is no longer pending, (2) waits for the sent decision to confirm
// (`waitForKybConfirmation`), (3) overlays the decided status on the row
// (`KybOverrides`) until the indexer-backed list agrees, and (4) polls that
// list for a bounded time (`startKybReconcile`), checking the chain again
// when the list never agreed (`giveUpOverride`).

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

type Ranked = { legalId: string; authority: string; pending: boolean };

function compareRanked(a: Ranked, b: Ranked): number {
  if (a.pending !== b.pending) return a.pending ? -1 : 1;
  const byName = a.legalId.localeCompare(b.legalId);
  if (byName !== 0) return byName;
  return a.authority.localeCompare(b.authority);
}

function ranked(issuer: DirectoryIssuer, legalId = issuerLegalId(issuer)): Ranked {
  return { legalId, authority: String(issuer.authority), pending: isPendingKyb(issuer) };
}

/**
 * Review-queue order: pending KYB first, then by legal-entity id, then by
 * authority (a stable tie-break for two rows with the same name).
 */
export function compareForReview(a: DirectoryIssuer, b: DirectoryIssuer): number {
  return compareRanked(ranked(a), ranked(b));
}

/**
 * The open review: its row, and whether it was pending when it was opened
 * (its place in the review queue at that moment).
 */
export type OpenReview = { legalId: string; pending: boolean };

/**
 * The visible rows, in review-queue order. The query matches the legal-entity
 * id, the authority wallet or the jurisdiction code. The open row (`keep`)
 * stays visible under the status chip even after its status changed, and
 * keeps the queue position it had when it was opened: a verify / reject (or
 * a chain read that finds it already decided) neither hides the open review
 * nor moves it away from the reviewer. It still has to match the query.
 */
export function filterIssuers<T extends DirectoryIssuer>(
  issuers: readonly T[],
  opts: { query: string; status: IssuerStatusFilter; keep?: OpenReview | null },
): T[] {
  const q = opts.query.trim().toLowerCase();
  const keep = opts.keep ?? null;
  const rows: { issuer: T; rank: Ranked }[] = [];
  for (const issuer of issuers) {
    const legalId = issuerLegalId(issuer);
    const kept = keep !== null && legalId === keep.legalId;
    if (!kept && !matchesStatus(issuer, opts.status)) continue;
    if (
      q &&
      !legalId.toLowerCase().includes(q) &&
      !String(issuer.authority).toLowerCase().includes(q) &&
      !String(issuer.jurisdiction).includes(q)
    ) {
      continue;
    }
    const rank = ranked(issuer, legalId);
    rows.push({ issuer, rank: kept ? { ...rank, pending: keep.pending } : rank });
  }
  return rows.sort((a, b) => compareRanked(a.rank, b.rank)).map((row) => row.issuer);
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

/** A getSignatureStatuses entry, as far as the confirmation wait reads it. */
export type SignatureStatusLike = {
  err: unknown;
  confirmationStatus?: string | null;
} | null;

/**
 * `confirmed`: the decision landed. `failed`: it landed with an error.
 * `unconfirmed`: no confirmation within the wait (it may still land, or it
 * was dropped).
 */
export type KybSendOutcome = "confirmed" | "failed" | "unconfirmed";

export const KYB_CONFIRM_TIMEOUT_MS = 45_000;
export const KYB_CONFIRM_INTERVAL_MS = 1_500;

/**
 * Waits for a sent KYB decision to confirm. The send resolves once the RPC
 * accepted the transaction, not once it landed: a dropped one (an expired
 * blockhash, a skipped leader) never lands, and treating it as decided showed
 * an approved issuer that the chain still held as Pending. Reads the status
 * every `intervalMs` for at most `timeoutMs`; a failed read counts as "not
 * yet".
 */
export async function waitForKybConfirmation(
  readStatus: () => Promise<SignatureStatusLike>,
  opts: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<KybSendOutcome> {
  const timeoutMs = opts.timeoutMs ?? KYB_CONFIRM_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? KYB_CONFIRM_INTERVAL_MS;
  const now = opts.now ?? (() => Date.now());
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const until = now() + timeoutMs;
  for (;;) {
    let status: SignatureStatusLike = null;
    try {
      status = await readStatus();
    } catch {
      status = null;
    }
    if (status?.err) return "failed";
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      return "confirmed";
    }
    if (now() >= until) return "unconfirmed";
    await sleep(intervalMs);
  }
}

/**
 * The KYB decision in flight for an issuer: being signed and sent, or sent
 * and waiting for confirmation.
 */
export type KybDecisionPhase = "sending" | "confirming";

export type KybDecisionGuard = {
  /** Claims the issuer for one decision; false while one is in flight. */
  begin(legalId: string): boolean;
  /** The decision was sent and now waits for confirmation. */
  confirming(legalId: string): void;
  /** The decision finished (whatever the outcome). */
  end(legalId: string): void;
};

/**
 * The KYB decisions in flight, by legal-entity id. The page holds it, not the
 * review detail: the detail unmounts whenever its row closes, and a review
 * re-opened while the first decision is still being sent or confirmed must
 * not offer Verify / Reject again (a second send either decides twice or
 * fails as already decided). `onChange` gets a fresh snapshot on every
 * change (the page's state).
 */
export function createKybDecisionGuard(
  onChange: (phases: ReadonlyMap<string, KybDecisionPhase>) => void,
): KybDecisionGuard {
  const phases = new Map<string, KybDecisionPhase>();
  const emit = () => onChange(new Map(phases));
  return {
    begin(legalId) {
      if (phases.has(legalId)) return false;
      phases.set(legalId, "sending");
      emit();
      return true;
    },
    confirming(legalId) {
      if (phases.get(legalId) !== "sending") return;
      phases.set(legalId, "confirming");
      emit();
    },
    end(legalId) {
      if (phases.delete(legalId)) emit();
    },
  };
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

/**
 * The poll gave up (the indexer never showed the status), so the row is
 * checked against the chain before it claims "on-chain": the chain's status
 * is kept as chain-only, and a chain that still says Pending drops the
 * override (the decision never landed; the row is reviewable again). A failed
 * read or a missing account (`null`) keeps the override, marked chain-only.
 * A no-op when the override is already gone.
 */
export function giveUpOverride(
  overrides: KybOverrides,
  legalId: string,
  live: KybStatus | null,
): KybOverrides {
  if (!overrides[legalId]) return overrides;
  if (live === null) return markChainOnly(overrides, legalId);
  if (live === KybStatus.Pending) {
    const next = { ...overrides };
    delete next[legalId];
    return next;
  }
  return { ...overrides, [legalId]: { status: live, phase: "chain" } };
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

export type ReconcileRegistry = {
  /**
   * Starts the poll `begin` returns (its stop function) for `key`, stopping
   * the one it replaces. `begin` gets `release`, which the poll calls once it
   * finished on its own. A no-op while closed.
   */
  start(key: string, begin: (release: () => void) => () => void): void;
  /** Whether new polls start (false between `close` and `open`). */
  readonly isOpen: boolean;
  /** The polls still running. */
  readonly size: number;
  open(): void;
  /** Stops every poll and refuses new ones (the page unmounted). */
  close(): void;
};

/**
 * The page's reconcile polls, one per issuer. A decision settles
 * asynchronously (a chain read comes first), so it can try to start a poll
 * after the page unmounted; a closed registry never starts it, where a bare
 * map emptied on unmount would have kept that poll running for a minute.
 */
export function createReconcileRegistry(): ReconcileRegistry {
  const running = new Map<string, () => void>();
  let open = true;
  return {
    get isOpen() {
      return open;
    },
    get size() {
      return running.size;
    },
    open() {
      open = true;
    },
    close() {
      open = false;
      for (const stop of running.values()) stop();
      running.clear();
    },
    start(key, begin) {
      if (!open) return;
      running.get(key)?.();
      running.delete(key);
      let finished = false;
      let stop: (() => void) | null = null;
      const release = () => {
        finished = true;
        if (stop && running.get(key) === stop) running.delete(key);
      };
      stop = begin(release);
      if (!finished) running.set(key, stop);
    },
  };
}

// Pending off-chain repairs for /admin/kyc: an approve_holder that LANDED
// on-chain while the dossier / request write-back failed (e2e §4).
//
// Pure helpers (no React, no storage) so the persistence contract can be unit
// tested. The map is keyed by passport_requests.id — NOT by wallet: a stale
// entry (sync failed once, then repaired elsewhere or abandoned) must never
// attach itself to a LATER request for the same wallet (re-KYC), where it
// would both block "Issue passport" and let "Retry off-chain sync" re-stamp
// the OLD tx signature + OLD expiry onto the dossier and mark the NEW request
// approved without any on-chain issuance. An entry is only ever offered for
// the exact request whose approve_holder produced it, and entries whose
// on-chain expiry has passed are dropped on read — a lapsed passport is no
// longer something a retry may mirror as "valid until".

export type UnsyncedIssue = {
  /** Holder wallet the passport was issued for (sanity check against the row). */
  wallet: string;
  /** The landed approve_holder transaction signature. */
  sig: string;
  /** On-chain expiry as an ISO timestamp — replayed on retry (route requires it). */
  expiresAt: string;
};

/** requestId → pending repair. */
export type UnsyncedIssueMap = Map<string, UnsyncedIssue>;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Parse the persisted JSON (`[[requestId, issue], …]`). Malformed entries, the
 * pre-fix wallet-keyed shape (no `wallet` / `requestId`), and entries whose
 * expiry is not strictly in the future are dropped.
 */
export function parseUnsyncedIssues(raw: string | null, now: number = Date.now()): UnsyncedIssueMap {
  const out: UnsyncedIssueMap = new Map();
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return out;
    for (const entry of parsed) {
      if (!Array.isArray(entry)) continue;
      const [requestId, v] = entry as [unknown, unknown];
      if (!isNonEmptyString(requestId) || !v || typeof v !== "object") continue;
      const { wallet, sig, expiresAt } = v as Partial<UnsyncedIssue>;
      if (!isNonEmptyString(wallet) || !isNonEmptyString(sig) || !isNonEmptyString(expiresAt)) {
        continue;
      }
      const expiresMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiresMs) || expiresMs <= now) continue;
      out.set(requestId, { wallet, sig, expiresAt });
    }
  } catch {
    // Corrupt entry — treat as empty rather than crash the queue.
  }
  return out;
}

/** Serialize for storage; `null` when there is nothing to persist. */
export function serializeUnsyncedIssues(map: UnsyncedIssueMap): string | null {
  return map.size === 0 ? null : JSON.stringify([...map]);
}

/**
 * The pending repair for THIS request, or null. Matches on the request id and
 * double-checks the wallet so a corrupted/edited entry cannot be replayed
 * against a different holder.
 */
export function pendingUnsyncedIssue(
  map: UnsyncedIssueMap,
  req: { id: string; wallet: string },
): UnsyncedIssue | null {
  const pending = map.get(req.id);
  return pending && pending.wallet === req.wallet ? pending : null;
}

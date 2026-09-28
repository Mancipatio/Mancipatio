// Pending off-chain flips for /admin/otc: a create_otc_deal that LANDED
// on-chain while the request's flip to `created` did not (the finalized read
// timed out, or /api/otc/admin-update refused or failed). Same contract as
// /admin/kyc's unsynced passports (../kyc/unsynced-issues.ts).
//
// Pure helpers (no React, no storage) so the persistence contract can be unit
// tested. Keyed by otc_requests.id: an entry is only ever offered for the
// exact request whose escrow produced it. While it is pending, "Create
// contract" stays disabled for that request (a second click would open a
// SECOND on-chain deal) and "Retry flip" resends the same
// { status: "created", deal_pda, deal_id } (the route treats a repeat as a
// no-op). An entry is dropped once the request is no longer `requested`
// (flipped or declined), once the chain shows its deal is no longer Open
// (cancelled, expired or settled: nothing left to flip to), and once the
// deal's own expiry has passed.

export type UnsyncedDeal = {
  /** The deal PDA the escrow opened. */
  dealPda: string;
  /** The deal id (u64, decimal) the request is flipped with. */
  dealId: string;
  /** The create_otc_deal signature (for the operator and the audit). */
  sig: string;
  /** The deal's on-chain expiry, ISO. */
  expiresAt: string;
};

/** requestId → pending flip. */
export type UnsyncedDealMap = Map<string, UnsyncedDeal>;

const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Parse the persisted JSON (`[[requestId, deal], …]`). Malformed entries and
 * entries whose deal expiry is not strictly in the future are dropped.
 */
export function parseUnsyncedDeals(raw: string | null, now: number = Date.now()): UnsyncedDealMap {
  const out: UnsyncedDealMap = new Map();
  if (!raw) return out;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return out;
    for (const entry of parsed) {
      if (!Array.isArray(entry)) continue;
      const [requestId, v] = entry as [unknown, unknown];
      if (!isNonEmptyString(requestId) || !v || typeof v !== "object") continue;
      const { dealPda, dealId, sig, expiresAt } = v as Partial<UnsyncedDeal>;
      if (!isNonEmptyString(dealPda) || !isNonEmptyString(sig) || !isNonEmptyString(expiresAt)) continue;
      if (!isNonEmptyString(dealId) || !/^\d{1,20}$/.test(dealId)) continue;
      const expiresMs = Date.parse(expiresAt);
      if (!Number.isFinite(expiresMs) || expiresMs <= now) continue;
      out.set(requestId, { dealPda, dealId, sig, expiresAt });
    }
  } catch {
    // Corrupt entry: treat as empty rather than crash the queue.
  }
  return out;
}

/** Serialize for storage; `null` when there is nothing to persist. */
export function serializeUnsyncedDeals(map: UnsyncedDealMap): string | null {
  return map.size === 0 ? null : JSON.stringify([...map]);
}

/**
 * The pending flip for THIS request, or null. `dealIsOpen` answers from the
 * loaded on-chain deals: true (Open), false (listed, not Open), or null (not
 * listed: not visible yet, or its record was archived), which keeps the entry.
 */
export function pendingUnsyncedDeal(
  map: UnsyncedDealMap,
  req: { id: string; status: string },
  dealIsOpen: (dealPda: string) => boolean | null,
): UnsyncedDeal | null {
  if (req.status !== "requested") return null;
  const pending = map.get(req.id);
  if (!pending) return null;
  return dealIsOpen(pending.dealPda) === false ? null : pending;
}

// Indexer-backed alternative to `loadNetwork`.
//
// Reads from the Supabase `public.*` tables that the Helius webhook Edge
// Function writes to, then decodes each row's stored `raw.base64` back into
// a Codama-decoded struct. End result: identical NetworkData shape as
// `loadNetwork()` but served instantly from Postgres instead of scanning
// every program account.

"use client";

import {
  getAssetDecoder,
  getCustodyVaultDecoder,
  getIssuerDecoder,
  getOfferDecoder,
  getProposalDecoder,
  getRightsIssuanceDecoder,
  getSaleDecoder,
  getShareClassDecoder,
  getVestingMilestoneDecoder,
  getVoteRecordDecoder,
  type Asset,
  type CustodyVault,
  type Issuer,
  type Offer,
  type Proposal,
  type RightsIssuance,
  type Sale,
  type ShareClass,
  type VestingMilestone,
  type VoteRecord,
} from "@/lib/generated/asset_registry";
import { getSupabase } from "@/lib/supabase";
import { detectNetwork } from "@/lib/network";
import { mergeableArchivedOffers } from "@/lib/closed-account";
import type { NetworkData } from "@/lib/enumerate";
import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";

export type ReconcileReport = Record<
  string,
  {
    onchain: number;
    refreshed: number;
    deleted: number;
    /** Rows on-chain that the indexer never saw. */
    missing: number;
    /**
     * Subset of `missing` that this run REBUILT from chain bytes — all 14 existing mirror types use the shared generated decoder.
     * Older servers omit the field.
     */
    rebuilt?: number;
  }
>;

/**
 * Trigger a server-side indexer reconcile (signed + admin-gated). Re-scans the
 * program on-chain, refreshes stale `raw` payloads, prunes rows whose account
 * is gone, and reports rows the indexer never saw. THROWS on failure.
 */
export async function runReconcile(
  session: WalletSession | null | undefined,
): Promise<{ network: string; report: ReconcileReport }> {
  return await signedFetch<{ network: string; report: ReconcileReport }>(
    session,
    "/api/admin/reconcile",
    "admin.reconcile",
  );
}

/** Manual recovery uses a fresh admin signature; scheduler uses its own secret. */
export async function runIndexerRetry(session: WalletSession | null | undefined) {
  return signedFetch<{ complete: number; pending: number; invalid: number }>(session, "/api/admin/retry-indexer", "admin.retryIndexer", { limit: 10 });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

type Row = { raw: { base64?: string } | null; layout_version: number | null; account_version: number | null };
async function requireReady(sb: NonNullable<ReturnType<typeof getSupabase>>, network: string) {
  const { data, error } = await sb.from("indexer_sync_state").select("status,checked_at,completed_at").eq("network", network).maybeSingle();
  const checked = Date.parse(data?.checked_at ?? "");
  if (error || data?.status !== "ready" || !data?.completed_at || !Number.isFinite(checked) || checked > Date.now() + 30_000 || Date.now() - checked > 5 * 60_000) {
    throw new Error("Indexer is warming, stale or unavailable; a chain read is required");
  }
}

// PostgREST caps an un-ranged select at 1000 rows and returns NO error, so a
// table with >1000 indexed rows would silently drop the rest. Page through with
// keyset-free .range() until a short page is returned, so lists are complete.
const INDEXER_PAGE = 1000;

async function fetchAllRaw(
  sb: NonNullable<ReturnType<typeof getSupabase>>,
  table: string,
  network: string,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let from = 0; ; from += INDEXER_PAGE) {
    const { data, error } = await sb
      .from(table)
      .select("raw,layout_version,account_version")
      .eq("network", network)
      .order("pda", { ascending: true })
      .range(from, from + INDEXER_PAGE - 1);
    if (error) {
      // A partial table must never look like a complete market snapshot.
      // Let the caller retry from the chain instead of reporting false zeros.
      throw new Error(`Could not load indexed ${table}: ${error.message}`);
    }
    const rows = (data ?? []) as Row[];
    out.push(...rows);
    if (rows.length < INDEXER_PAGE) break; // last (short) page
  }
  return out;
}

/** A malformed or out-of-date row invalidates the snapshot; never hide funded rows. */
function decodeAll<T>(rows: Row[], decoder: { decode: (b: Uint8Array) => T }, expectedVersion = 1): T[] {
  return rows.map((row) => {
    const b64 = row.raw?.base64;
    if (!b64 || row.layout_version !== 2 || row.account_version !== expectedVersion) throw new Error("Indexer account layout requires reconciliation");
    const value = decoder.decode(base64ToBytes(b64));
    if ((value as { version?: number }).version !== undefined && (value as { version: number }).version !== expectedVersion) throw new Error("Unsupported indexed account version");
    return value;
  });
}

/**
 * Returns the same `NetworkData` shape that `loadNetwork(rpc)` produces, but
 * sourced from the Supabase indexer. Use when you want instant page loads.
 *
 * Throws if Supabase isn't configured — callers should fall back to
 * `loadNetwork(rpc)` in that case.
 */
export async function loadNetworkFromIndexer(): Promise<NetworkData> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase env not configured");
  const network = detectNetwork();
  await requireReady(sb, network);

  // Fetch the raw base64 column for every entity table in parallel, paging
  // past the PostgREST 1000-row cap so large lists are never silently cut.
  const [
    issuersR,
    assetsR,
    shareClassesR,
    salesR,
    offersR,
    rightsR,
    milestonesR,
  ] = await Promise.all([
    fetchAllRaw(sb, "issuers", network),
    fetchAllRaw(sb, "assets", network),
    fetchAllRaw(sb, "share_classes", network),
    fetchAllRaw(sb, "sales", network),
    fetchAllRaw(sb, "offers", network),
    fetchAllRaw(sb, "rights_issuances", network),
    fetchAllRaw(sb, "milestones", network),
  ]);

  const issuers = decodeAll<Issuer>(issuersR, getIssuerDecoder());
  const assets = decodeAll<Asset>(assetsR, getAssetDecoder());
  // ShareClass v2 only: the program has no v1 path, so a v1 row fails closed.
  const shareClasses = decodeAll<ShareClass>(shareClassesR, getShareClassDecoder(), 2);
  // Sale v2 (program 2B, SALE_STATE_VERSION): v1 rows are not on chain.
  const sales = decodeAll<Sale>(salesR, getSaleDecoder(), 2);
  const offers = decodeAll<Offer>(offersR, getOfferDecoder());
  const rightsIssuances = decodeAll<RightsIssuance>(
    rightsR,
    getRightsIssuanceDecoder(),
  );
  const milestones = decodeAll<VestingMilestone>(
    milestonesR,
    getVestingMilestoneDecoder(),
  );

  return {
    issuers,
    assets,
    shareClasses,
    sales,
    offers,
    rightsIssuances,
    milestones,
  };
}

/**
 * Same as `loadNetworkFromIndexer` but tries indexer first, falls back to the
 * supplied on-chain loader when Supabase is missing/empty/throws.
 */
export async function loadNetworkPreferIndexer(
  fallback: () => Promise<NetworkData>,
): Promise<NetworkData> {
  try {
    const data = await loadNetworkFromIndexer();
    // If the indexer is genuinely empty (zero rows everywhere), fall back to
    // a fresh on-chain read so first-load is never blank during early use.
    const nonEmpty =
      data.issuers.length +
      data.assets.length +
      data.shareClasses.length +
      data.sales.length +
      data.offers.length +
      data.rightsIssuances.length +
      data.milestones.length;
    if (nonEmpty === 0) return await fallback();
    return data;
  } catch {
    return await fallback();
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Extra entities not yet in NetworkData — exposed as their own loaders.
// (Custody vaults, proposals, vote records.)
// ──────────────────────────────────────────────────────────────────────────

async function loadExtra<T>(table: string, decoder: { decode: (b: Uint8Array) => T }, expectedVersion = 1): Promise<T[]> {
  const sb = getSupabase();
  if (!sb) throw new Error("Supabase env not configured");
  const network = detectNetwork();
  await requireReady(sb, network);
  return decodeAll<T>(await fetchAllRaw(sb, table, network), decoder, expectedVersion);
}
export async function loadCustodyVaultsFromIndexer(): Promise<CustodyVault[]> {
  // CustodyVault v2 (2C-3) appends kyc_registry; v1 rows need a reconcile.
  return loadExtra("custody_vaults", getCustodyVaultDecoder(), 2);
}
export async function loadProposalsFromIndexer(): Promise<Proposal[]> {
  return loadExtra("proposals", getProposalDecoder());
}
export async function loadVoteRecordsFromIndexer(): Promise<VoteRecord[]> {
  return loadExtra("vote_records", getVoteRecordDecoder(), 0);
}

// ──────────────────────────────────────────────────────────────────────────
// 2D: history of accounts whose rent was reclaimed (0069 indexer_closed_rows).
// ──────────────────────────────────────────────────────────────────────────

/**
 * `data` with the archived (rent-reclaimed) offers appended, for history and
 * statistics views. An archived row whose last mirrored status is still
 * `Open` (terminal step + reclaim seen together) is dropped, so a tombstoned
 * offer never shows up as takeable or counts as open — see
 * `mergeableArchivedOffers`. Live rows win on a duplicate key; archive errors
 * are swallowed (history is best effort, the live data is not).
 */
export async function withClosedOffers(data: NetworkData): Promise<NetworkData> {
  const closed = await loadClosedRows(getSupabase(), "offers", getOfferDecoder()).catch(
    () => [],
  );
  const extra = mergeableArchivedOffers(
    data.offers,
    closed.map((row) => row.data),
  );
  return extra.length ? { ...data, offers: [...data.offers, ...extra] } : data;
}

export type ClosedRowTable = "offers" | "custody_vaults" | "otc_deals";
export type ClosedRow<T> = {
  pda: string;
  data: T;
  closed: true;
  closedAt: string | null;
};

/**
 * Rows archived when their account was tombstoned by `reclaim_rent`: offers
 * and custody vaults are copied by the 0069 delete trigger when the indexer
 * drops the mirror row, OTC deals by the admin archive route before the
 * reclaim. Each row keeps the account's last `raw.base64`, decoded here with
 * the Codama decoder. History only — never a live-state source. A row that no
 * longer decodes is skipped.
 */
export async function loadClosedRows<T>(
  sb: ReturnType<typeof getSupabase>,
  table: ClosedRowTable,
  decoder: { decode: (bytes: Uint8Array) => T },
): Promise<ClosedRow<T>[]> {
  if (!sb) return [];
  const out: ClosedRow<T>[] = [];
  for (let from = 0; ; from += INDEXER_PAGE) {
    const { data, error } = await sb
      .from("indexer_closed_rows")
      .select("pda,row,closed_at")
      .eq("network", detectNetwork())
      .eq("table_name", table)
      .order("pda", { ascending: true })
      .range(from, from + INDEXER_PAGE - 1);
    if (error) throw new Error(`Could not load closed ${table}: ${error.message}`);
    const rows = (data ?? []) as {
      pda: string;
      row: { raw?: { base64?: string } | null } | null;
      closed_at: string | null;
    }[];
    for (const row of rows) {
      const b64 = row.row?.raw?.base64;
      if (!b64) continue;
      try {
        out.push({
          pda: row.pda,
          data: decoder.decode(base64ToBytes(b64)),
          closed: true,
          closedAt: row.closed_at,
        });
      } catch {
        // An undecodable archive row is history we cannot show; skip it.
      }
    }
    if (rows.length < INDEXER_PAGE) break;
  }
  return out;
}

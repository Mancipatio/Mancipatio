// SERVER-ONLY — public-sale requests (Distribute → Public sale, design §4).
//
// A request lives in the asset's PRIVATE profile row, under
// asset_profiles.fields.sale_request (lib/public-sale SaleRequest): one per
// asset, written only by /api/sale-requests/* (the profile upsert route drops
// the key from client patches and keeps the stored one), with the server
// stamping who and when. No new table: approved, opened and closed are read
// from the chain (the SaleApproval and Sale accounts) and the raise-cap
// reservation, never stored twice.
//
// The submit call also publishes the buyer document (a verified
// whitepapers/{asset}/ version, whitepaper_status published, the profile
// published) — exactly what the sale's document route requires
// (lib/server/sale-document.ts) — so the issuer signs once.
import "server-only";

import type { Address } from "@solana/kit";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AssetStatus, fetchMaybeAsset, fetchMaybeSale, fetchMaybeShareClass } from "@/lib/generated/asset_registry";
import { listOpenSales, openSaleRemaining } from "@/lib/distribution-chain";
import { roomToCreate } from "@/lib/distribution-supply";
import { approvalUnits, parseSaleRequest, type SaleRequest } from "@/lib/public-sale";
import { getServerRpc } from "@/lib/server/rpc";
import { SiwsError } from "@/lib/server/siws";
import { listLiveApprovals } from "@/lib/server/sale-capacity-chain";
import { detectNetwork } from "@/lib/network";

const read = { commitment: "confirmed" as const };

/** What the chain says about a class before a request: room, the tokenize document's hash, sales and approvals. */
export type SaleRoomFacts = {
  /** Tokens that may still be offered (null = uncapped). */
  room: bigint | null;
  /** The asset's on-chain legal_doc_hash (what tokenize hashed). */
  legalDocHash: Uint8Array;
  assetActive: boolean;
  mintInitialized: boolean;
  openSales: number;
  /** Live (unexpired, unopened) approvals of the class. */
  liveApprovals: number;
};

/**
 * Room for a sale, as the Distribute card counts it (lib/distribution-supply):
 * cap − lifetime_minted − what Open sales may still mint − treasury mints
 * reserved and not yet booked − what live approvals not yet opened may mint.
 */
export async function readSaleRoom(sb: SupabaseClient, shareClass: Address, asset: Address): Promise<SaleRoomFacts> {
  let sc, a, openSales, approvals;
  try {
    const rpc = getServerRpc();
    const config = { ...read, abortSignal: AbortSignal.timeout(12_000) };
    [sc, a, openSales, approvals] = await Promise.all([
      fetchMaybeShareClass(rpc, shareClass, config),
      fetchMaybeAsset(rpc, asset, config),
      listOpenSales(rpc, { shareClass }),
      listLiveApprovals(AbortSignal.timeout(12_000)),
    ]);
  } catch (err) {
    console.error("[api/sale-requests] RPC failure reading the class:", err);
    throw new SiwsError(503, "On-chain check unavailable — try again");
  }
  if (!sc.exists || !a.exists) throw new SiwsError(404, "Share class not found on-chain");
  const now = BigInt(Math.floor(Date.now() / 1000));
  const live = approvals.filter((x) => x.shareClass === shareClass && x.expiresAt >= now);
  const { data, error } = await sb
    .from("sale_capacity_reservations")
    .select("amount_units")
    .eq("network", detectNetwork())
    .eq("kind", "treasury_mint")
    .eq("status", "reserved")
    .eq("share_class_pda", shareClass);
  if (error) throw new SiwsError(503, "Could not read the reserved treasury mints");
  const reservedUnminted = (data ?? []).reduce((sum, r) => {
    const text = String((r as { amount_units?: unknown }).amount_units ?? "");
    return /^\d+$/.test(text) ? sum + BigInt(text) : sum;
  }, BigInt(0));
  const room = roomToCreate({
    maxSupply: sc.data.maxSupply.__option === "Some" ? sc.data.maxSupply.value : null,
    lifetimeMinted: sc.data.lifetimeMinted,
    version: sc.data.version,
    supplyLocked: sc.data.supplyLocked,
    mintablePostLaunch: sc.data.mintablePostLaunch,
    openSaleRemaining: openSaleRemaining(openSales),
    reservedUnminted,
    approvedUnopened: live.reduce((sum, x) => sum + approvalUnits(x), BigInt(0)),
    treasuryBalance: BigInt(0),
  });
  return {
    room,
    legalDocHash: Uint8Array.from(a.data.legalDocHash),
    assetActive: a.data.status === AssetStatus.Active,
    mintInitialized: sc.data.mintInitialized,
    openSales: openSales.length,
    liveApprovals: live.length,
  };
}

/** The columns a request is read and written with. */
export const REQUEST_PROFILE_COLUMNS =
  "asset_pda,display_name,category,fields,is_published,status,whitepaper_path,whitepaper_sha256,whitepaper_status,whitepaper_published_at";

export type RequestProfileRow = {
  asset_pda: string;
  display_name: string | null;
  category: string | null;
  fields: Record<string, unknown> | null;
  is_published: boolean | null;
  status: string | null;
  whitepaper_path: string | null;
  whitepaper_sha256: string | null;
  whitepaper_status: string | null;
  whitepaper_published_at: string | null;
};

export async function readRequestProfile(sb: SupabaseClient, asset: string): Promise<RequestProfileRow | null> {
  const { data, error } = await sb
    .from("asset_profiles")
    .select(REQUEST_PROFILE_COLUMNS)
    .eq("network", detectNetwork())
    .eq("asset_pda", asset)
    .maybeSingle();
  if (error) throw new SiwsError(503, "Could not read the asset's profile");
  return (data as RequestProfileRow | null) ?? null;
}

/** The stored request of a profile row, or null. */
export function storedRequest(row: Pick<RequestProfileRow, "fields"> | null): SaleRequest | null {
  const fields = row?.fields;
  return fields && typeof fields === "object" ? parseSaleRequest((fields as Record<string, unknown>).sale_request) : null;
}

/** The profile's `fields` with the request set (every other key kept as stored). */
export function fieldsWithRequest(fields: Record<string, unknown> | null, request: SaleRequest): Record<string, unknown> {
  return { ...(fields ?? {}), sale_request: request };
}

/**
 * A profile patch from a client never writes `fields.sale_request`, and a
 * `fields` it does write keeps the stored request: the tokenize flow's
 * "Save details" sends `fields` whole (lib/tokenize-shares buildProfileRow),
 * which would otherwise overwrite a request made since the page loaded.
 */
export function protectSaleRequest(
  patchFields: Record<string, unknown>,
  storedFields: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...patchFields };
  delete out.sale_request;
  const stored = storedFields && typeof storedFields === "object" ? storedFields.sale_request : undefined;
  if (stored !== undefined) out.sale_request = stored;
  return out;
}

/**
 * What became of a "requested" request, read from the raise-cap ledger (the
 * operator's reserve step writes a sale reservation; it is consumed when the
 * sale opens, booked or released as closed_unsold when it closes):
 * the newest sale reservation of the class made since the request. A
 * reservation still "reserved" whose Sale account already exists on chain
 * (open_sale ran; the retry worker has not consumed it yet) reads as
 * "opened" — so the operator's list drops the request as soon as its sale
 * opens, and never offers "Approve sale" for it again.
 */
export type RequestOutcome = "approved" | "opened" | "closed" | null;

/** The reservation the operator made for a request: its approval (the pre-clear check's "this one") and sale. */
export type RequestReservation = { approval_pda: string | null; sale_pda: string | null; sale_id: string | null };

type ReservationOutcomeRow = {
  share_class_pda: string;
  status: string;
  release_reason: string | null;
  created_at: string;
  approval_pda?: string | null;
  sale_pda?: string | null;
  sale_id?: string | number | null;
};

/** The newest sale reservation of the request's class made since the request (released ones skipped unless closed_unsold). */
function requestReservationRow(
  request: Pick<SaleRequest, "share_class" | "requested_at">,
  rows: readonly ReservationOutcomeRow[],
): ReservationOutcomeRow | null {
  const since = Date.parse(request.requested_at);
  return (
    rows
      .filter((r) => r.share_class_pda === request.share_class && Date.parse(r.created_at) >= since)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .find((r) => r.status !== "released" || r.release_reason === "closed_unsold") ?? null
  );
}

export function outcomeOf(request: Pick<SaleRequest, "share_class" | "requested_at">, rows: readonly ReservationOutcomeRow[]): RequestOutcome {
  const newest = requestReservationRow(request, rows);
  if (!newest) return null;
  if (newest.status === "reserved") return "approved";
  if (newest.status === "consumed") return "opened";
  return "closed";
}

export type RequestState = { outcome: RequestOutcome; reservation: RequestReservation | null };

/** Whether a Sale account of `shareClass` exists at `sale` (confirmed); null when the chain could not be read. */
async function saleOpened(sale: string, shareClass: string): Promise<boolean | null> {
  try {
    const found = await fetchMaybeSale(getServerRpc(), sale as Address, { commitment: "confirmed", abortSignal: AbortSignal.timeout(8_000) });
    return found.exists && found.data.shareClass === shareClass;
  } catch {
    return null;
  }
}

/**
 * The outcome and the reservation of each request (one ledger read for all
 * of them, and one Sale read per request still "approved" with a sale
 * address; a chain read that fails leaves it "approved").
 */
export async function requestStates(sb: SupabaseClient, requests: readonly SaleRequest[]): Promise<Map<string, RequestState>> {
  const out = new Map<string, RequestState>();
  if (requests.length === 0) return out;
  const oldest = requests.reduce((min, r) => (r.requested_at < min ? r.requested_at : min), requests[0].requested_at);
  const { data, error } = await sb
    .from("sale_capacity_reservations")
    .select("share_class_pda,status,release_reason,created_at,approval_pda,sale_pda,sale_id")
    .eq("network", detectNetwork())
    .eq("kind", "sale")
    .in("share_class_pda", [...new Set(requests.map((r) => r.share_class))])
    .gte("created_at", oldest);
  if (error) throw new SiwsError(503, "Could not read the sale approvals of the requests");
  const rows = (data ?? []) as ReservationOutcomeRow[];
  await Promise.all(
    requests.map(async (r) => {
      const row = requestReservationRow(r, rows);
      let outcome = outcomeOf(r, rows);
      if (outcome === "approved" && row?.sale_pda && (await saleOpened(row.sale_pda, r.share_class)) === true) outcome = "opened";
      out.set(r.id, {
        outcome,
        reservation: row
          ? { approval_pda: row.approval_pda ?? null, sale_pda: row.sale_pda ?? null, sale_id: row.sale_id === null || row.sale_id === undefined ? null : String(row.sale_id) }
          : null,
      });
    }),
  );
  return out;
}

/** The outcome of each request (lib/server/sale-requests requestStates). */
export async function requestOutcomes(sb: SupabaseClient, requests: readonly SaleRequest[]): Promise<Map<string, RequestOutcome>> {
  const states = await requestStates(sb, requests);
  return new Map([...states].map(([id, state]) => [id, state.outcome]));
}

/** A request still waiting for the operator: "requested" and not yet approved, opened or closed. */
export function waitingForOperator(request: SaleRequest | null, outcome: RequestOutcome): boolean {
  return request?.status === "requested" && outcome === null;
}

/** A path inside this asset's public documents (whitepapers/{asset}/…), without traversal. */
export function assetDocumentPath(path: unknown, asset: string): string {
  if (
    typeof path !== "string" ||
    path.length > 350 ||
    !path.startsWith(`whitepapers/${asset}/`) ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new SiwsError(400, "The document must be a verified upload of this asset (whitepapers/<asset>/…)");
  }
  return path;
}

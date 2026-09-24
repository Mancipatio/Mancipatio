"use client";

// Private OTC requests — all reads and writes go
// through signed server routes (SIWS):
//   otc.create      — either party requests an escrow (requested_by is the
//                     verified signer; buyer- AND seller-initiated supported)
//   otc.adminUpdate — admin status flips (on-chain admin gate); flipping to
//                     'created' also emails both parties (when known) and
//                     writes in-app notifications rows server-side.
//   otc.adminScreen — admin re-screen of both parties (suspended dossier?)
//                     right before the escrow is opened (read-only).

import type { SolanaClient, WalletSession } from "@solana/client";
import type { Address } from "@solana/kit";
import { fetchMintTokenProgram } from "@/lib/transaction-builders";
import { signedFetch } from "@/lib/siws-client";
import { loadClosedRows } from "@/lib/indexer";
import { getSupabase } from "@/lib/supabase";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  getOtcDealDecoder,
  getOtcDealDiscriminatorBytes,
  findDealPda,
  type OtcDeal,
} from "@/lib/generated/asset_registry";

export type OtcRequestStatus =
  | "requested"
  | "created"
  | "cancelled"
  | "completed"
  | "expired";

export type OtcRequest = {
  id: string;
  created_at: string;
  updated_at: string;
  network: string;
  share_class_pda: string;
  mint: string;
  asset_label: string;
  seller_wallet: string;
  buyer_wallet: string;
  /** Share-class units the seller deposits (integer base units). */
  amount: number;
  /** Total price in payment-token base units (integer). */
  price: number;
  payment_mint: string;
  requested_by: string;
  status: OtcRequestStatus;
  deal_pda: string | null;
  deal_id: number | null;
  expires_at: string | null;
  admin_note?: string | null;
  decided_by?: string | null;
  decided_at?: string | null;
};

// requested_by is no longer part of the input — the server stamps it with the
// verified signing wallet (which must be one of the two parties).
export type OtcRequestInput = {
  share_class_pda: string;
  mint: string;
  asset_label?: string;
  seller_wallet: string;
  buyer_wallet: string;
  amount: number;
  price: number;
  payment_mint: string;
  expires_at?: string;
};

/**
 * Amount/price convention: both are INTEGER BASE UNITS, mirroring the OTC
 * offers UI — `amount` in share-class units (transferred with the share
 * mint's decimals), `price` in payment-token base units (transferred with
 * the payment mint's decimals). They round-trip through Supabase `numeric`
 * as JS numbers; signed create routes reject values outside the safe-integer
 * range before storage. Larger amounts require a future exact-string API.
 *
 * Signed route — THROWS with the server's message on failure. Returns the id.
 */
export async function createOtcRequest(
  session: WalletSession | null | undefined,
  input: OtcRequestInput,
): Promise<string> {
  const data = await signedFetch<{ id: string }>(
    session,
    "/api/otc/create",
    "otc.create",
    {
      share_class_pda: input.share_class_pda,
      mint: input.mint,
      asset_label: input.asset_label ?? "",
      seller_wallet: input.seller_wallet,
      buyer_wallet: input.buyer_wallet,
      amount: input.amount,
      price: input.price,
      payment_mint: input.payment_mint,
      expires_at: input.expires_at,
    },
  );
  return data.id;
}

async function readOtcRequests(
  session: WalletSession | null | undefined, scope: "admin" | "mine", status?: OtcRequestStatus,
): Promise<OtcRequest[]> {
  const rows: OtcRequest[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await signedFetch<OtcRequest[]>(session, "/api/otc/list", "otc.list", { scope, status, offset });
    rows.push(...page);
    if (page.length < 100) return rows;
  }
}

export async function listOtcRequests(session: WalletSession | null | undefined, status?: OtcRequestStatus): Promise<OtcRequest[]> {
  return readOtcRequests(session, "admin", status);
}

/** Server binds the party filter to the verified signer; no caller wallet parameter. */
export async function listOtcRequestsByWallet(session: WalletSession | null | undefined): Promise<OtcRequest[]> {
  return readOtcRequests(session, "mine");
}

export type OtcAdminPatch = {
  status?: Exclude<OtcRequestStatus, "requested">;
  deal_pda?: string;
  deal_id?: number;
  expires_at?: string | null;
  admin_note?: string | null;
  /** Stamp decided_by/decided_at with the signing admin + now (server-side). */
  decide?: boolean;
};

export type OtcPartyScreen = {
  /** True only when neither party's client profile is suspended. */
  cleared: boolean;
  seller: "clear" | "suspended";
  buyer: "clear" | "suspended";
};

/**
 * Admin compliance re-screen of a queued request's two parties, run right
 * before the on-chain escrow is opened (a party may have been suspended
 * while the request waited). THROWS on any failure — callers must treat an
 * unavailable screen as "do not open the escrow".
 */
export async function adminScreenOtcRequest(
  session: WalletSession | null | undefined,
  id: string,
): Promise<OtcPartyScreen> {
  return signedFetch<OtcPartyScreen>(
    session,
    "/api/otc/admin-screen",
    "otc.adminScreen",
    { id },
  );
}

/**
 * Admin status flip (signed + on-chain admin gate on the server). Setting
 * status 'created' also triggers the server-side party notifications.
 */
export async function adminUpdateOtcRequest(
  session: WalletSession | null | undefined,
  id: string,
  patch: OtcAdminPatch,
): Promise<boolean> {
  try {
    await signedFetch(session, "/api/otc/admin-update", "otc.adminUpdate", {
      id,
      ...patch,
    });
    return true;
  } catch (err) {
    console.warn("[otc] admin update failed:", err);
    return false;
  }
}

/**
 * 2D: archive a terminal deal's on-chain record (deal.admin only; the server
 * re-reads it at finalized) BEFORE its rent is reclaimed, and close any linked
 * request. Throws on failure: never reclaim a deal whose history did not land.
 */
export async function archiveOtcDealRecord(
  session: WalletSession | null | undefined,
  dealPda: string,
): Promise<void> {
  await signedFetch(session, "/api/otc/admin-update", "otc.adminUpdate", {
    archive: true,
    deal_pda: dealPda,
  });
}

/**
 * Live deals plus archived (rent-reclaimed) ones for PDAs that are no longer
 * live, marked `closed`. History only.
 */
export async function withArchivedOtcDeals(
  live: LoadedOtcDeal[],
): Promise<(LoadedOtcDeal & { closed?: boolean })[]> {
  const archived = await loadClosedRows(
    getSupabase(),
    "otc_deals",
    getOtcDealDecoder(),
  ).catch(() => []);
  const livePdas = new Set(live.map((d) => d.pda.toString()));
  return [
    ...live,
    ...archived
      .filter((row) => !livePdas.has(row.pda))
      .map((row) => ({ pda: row.pda as Address, deal: row.data, closed: true })),
  ];
}

// ── On-chain helpers ─────────────────────────────────────────────────────────

type Rpc = SolanaClient["runtime"]["rpc"];

export type LoadedOtcDeal = {
  /** Address of the OtcDeal account (the deal PDA). */
  pda: Address;
  deal: OtcDeal;
};

/**
 * Every on-chain `OtcDeal` account, with its address. Scan-all +
 * discriminator filter, mirroring `loadNetwork` in lib/enumerate.ts (the
 * Supabase indexer does not mirror OTC deals). Callers filter by
 * buyer/seller/status client-side.
 */
export async function loadOtcDeals(rpc: Rpc): Promise<LoadedOtcDeal[]> {
  const res = await rpc
    .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, { encoding: "base64", commitment: "finalized" })
    .send({ abortSignal: AbortSignal.timeout(10_000) });
  const disc = getOtcDealDiscriminatorBytes();
  const decoder = getOtcDealDecoder();
  const out: LoadedOtcDeal[] = [];
  for (const r of res) {
    const b64 = (r.account.data as readonly [string, string])[0];
    const bin = atob(b64);
    if (bin.length < 8) continue;
    let match = true;
    for (let i = 0; i < 8; i += 1) {
      if (bin.charCodeAt(i) !== disc[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    const data = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) data[i] = bin.charCodeAt(i);
    if (r.account.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected OTC account owner");
    const deal = decoder.decode(data);
    if (deal.version !== 1 || (await findDealPda({ shareClass: deal.shareClass, dealId: deal.dealId }))[0] !== r.pubkey) throw new Error("OTC deal identity mismatch");
    out.push({ pda: r.pubkey, deal });
  }
  return out;
}

export const TOKEN_2022_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

/** Resolve an initialized payment mint or fail explicitly; no classic-token
 * fallback is allowed after RPC failure or an unsupported owner. This is the
 * permissive EXIT check (cancel, expire, reclaim, the seller's leg); entry
 * paths use inspectPaymentMint (lib/transaction-builders). */
export function detectTokenProgram(rpc: Rpc, mint: Address): Promise<Address> {
  return fetchMintTokenProgram(rpc, mint, { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) });
}

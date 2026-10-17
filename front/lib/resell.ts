"use client";

// Resell listings — the PUBLIC board reads directly (anon Supabase: since
// 0082 the browser roles see ACTIVE listings only, so a seller's contact is
// public exactly while their post is). The seller's own history and the
// admin board read through a signed route on the service role, and ALL
// writes go through signed server routes (SIWS):
//   resell.list     — scope "mine": the signer's own listings, every status
//                     (the server binds the seller filter to the verified
//                     wallet); scope "admin": every listing with its
//                     moderation stamps (on-chain admin gate)
//   resell.create   — seller posts; the SERVER verifies on-chain holdings
//                     (amount ≤ Token-2022 balance) and that share_class_pda
//                     really is the ShareClass behind the mint
//   resell.update   — seller withdraws / marks matched (own listings only)
//   resell.moderate — admin remove/restore (on-chain admin gate; restore only
//                     a removed listing, never a seller's withdrawal)

import type { WalletSession } from "@solana/client";
import { signedFetch } from "@/lib/siws-client";
import { getSupabase } from "@/lib/supabase";
import { detectNetwork } from "@/lib/network";

export type ResellStatus = "active" | "matched" | "withdrawn" | "removed";

export type ResellListing = {
  id: string;
  created_at: string;
  updated_at: string;
  network: string;
  seller_wallet: string;
  mint: string;
  share_class_pda: string | null;
  asset_pda: string | null;
  asset_label: string;
  amount: number;
  ask_price: number | null;
  ask_currency: string;
  note: string;
  contact: string;
  status: ResellStatus;
  linked_offer_pda: string | null;
  /** Moderation stamps: the admin board only (scope "admin"); absent from a seller's own history. */
  moderated_by?: string | null;
  moderated_at?: string | null;
};

// seller_wallet comes from the verified signature; share_class_pda is now
// REQUIRED (it powers the board's "Request OTC escrow" funnel and is verified
// on-chain by the server).
export type ResellListingInput = {
  mint: string;
  share_class_pda: string;
  asset_pda?: string;
  asset_label?: string;
  amount: number;
  ask_price?: number;
  ask_currency?: string;
  note?: string;
  contact?: string;
};

/**
 * Post a listing for the connected wallet. THROWS with the server's message
 * on failure (e.g. "Amount exceeds your on-chain balance"). Returns the id.
 */
export async function createResellListing(
  session: WalletSession | null | undefined,
  input: ResellListingInput,
): Promise<string> {
  const data = await signedFetch<{ id: string }>(
    session,
    "/api/resell/create",
    "resell.create",
    {
      mint: input.mint,
      share_class_pda: input.share_class_pda,
      asset_pda: input.asset_pda,
      asset_label: input.asset_label ?? "",
      amount: input.amount,
      ask_price: input.ask_price ?? null,
      ask_currency: input.ask_currency ?? "USDC",
      note: input.note ?? "",
      contact: input.contact ?? "",
    },
  );
  return data.id;
}

/** Seller takes their own active listing off the board. */
export async function withdrawResellListing(
  session: WalletSession | null | undefined,
  id: string,
): Promise<boolean> {
  try {
    await signedFetch(session, "/api/resell/update", "resell.update", {
      id,
      action: "withdraw",
    });
    return true;
  } catch (err) {
    console.warn("[resell] withdraw failed:", err);
    return false;
  }
}

/** Seller marks their own active listing matched (optionally linking the Offer). */
export async function markResellListingMatched(
  session: WalletSession | null | undefined,
  id: string,
  linkedOfferPda: string | null,
): Promise<boolean> {
  try {
    await signedFetch(session, "/api/resell/update", "resell.update", {
      id,
      action: "match",
      linked_offer_pda: linkedOfferPda,
    });
    return true;
  } catch (err) {
    console.warn("[resell] mark matched failed:", err);
    return false;
  }
}

/** Admin moderation (remove from / restore to the public board). */
export async function moderateResellListing(
  session: WalletSession | null | undefined,
  id: string,
  action: "remove" | "restore",
): Promise<boolean> {
  try {
    await signedFetch(session, "/api/resell/moderate", "resell.moderate", {
      id,
      action,
    });
    return true;
  } catch (err) {
    console.warn("[resell] moderate failed:", err);
    return false;
  }
}

/**
 * The public board (anon client): ACTIVE listings of the network only — the
 * rows 0082 lets the browser roles read, so a status other than "active" is
 * not accepted here (own history and the admin board are the signed readers
 * below). A failed/missing database is unavailable, never an empty market.
 */
export async function listResellListings(opts: { status?: "active"; mint?: string } = {}): Promise<ResellListing[]> {
  const sb = getSupabase();
  if (!sb) throw new Error("Listings service is not configured");
  const rows: ResellListing[] = [];
  for (let offset = 0; ; offset += 1000) {
    let query = sb.from("resell_listings").select("*").eq("network", detectNetwork()).eq("status", "active")
      .order("created_at", { ascending: false }).order("id", { ascending: false }).range(offset, offset + 999);
    if (opts.mint) query = query.eq("mint", opts.mint);
    const { data, error } = await query.abortSignal(AbortSignal.timeout(10_000));
    if (error || !data) throw new Error("Listings service is unavailable; retry shortly");
    rows.push(...data as ResellListing[]);
    if (data.length < 1000) return rows;
  }
}

/** Signed reads page through /api/resell/list (service role) 100 rows at a time, like readOtcRequests in lib/otc.ts. */
async function readSignedResellListings(
  session: WalletSession | null | undefined, scope: "admin" | "mine", status?: ResellStatus,
): Promise<ResellListing[]> {
  const rows: ResellListing[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await signedFetch<ResellListing[]>(session, "/api/resell/list", "resell.list", { scope, status, offset });
    rows.push(...page);
    if (page.length < 100) return rows;
  }
}

/**
 * The signer's own listings, every status (withdrawn and matched included).
 * The server binds the seller filter to the verified wallet; no caller
 * wallet parameter.
 */
export function listMyResellListings(session: WalletSession | null | undefined, status?: ResellStatus): Promise<ResellListing[]> {
  return readSignedResellListings(session, "mine", status);
}

/** The admin board: every listing of the network with its moderation stamps (on-chain admin gate server-side). */
export function listAllResellListings(session: WalletSession | null | undefined, status?: ResellStatus): Promise<ResellListing[]> {
  return readSignedResellListings(session, "admin", status);
}

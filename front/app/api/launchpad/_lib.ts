// SERVER-ONLY — shared helpers for the /api/launchpad/* signed routes.
// The `_lib` underscore prefix keeps this file out of routing.
//
// Chain-derived authorization for launchpad writes: a wallet is allowed to
// manage a sale's listing / commitment lifecycle when it is either a platform
// admin (on-chain Admin PDA / super admin) or the ISSUER AUTHORITY behind the
// sale, resolved on-chain via Sale -> ShareClass -> Asset -> Issuer.authority
// (fresh finalized accounts, with no positive authorization cache).

import "server-only";

import { address as toAddress } from "@solana/kit";
import { getServerRpc } from "@/lib/server/rpc";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeAsset,
  fetchMaybeIssuer,
  fetchMaybeSale,
  fetchMaybeShareClass,
} from "@/lib/generated/asset_registry";
import { SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** Base58 transaction signature (64-byte ed25519 sig ≈ 87-88 chars). */
export const TX_SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/;
export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Mirrors the CHECK constraint on public.commitments.status (0012). */
export const COMMITMENT_STATUSES = new Set([
  "pending",
  "confirmed",
  "settled",
  "cancelled",
]);

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Non-throwing admin probe: 403 -> false; 503 (RPC down) propagates so we
 *  never fall through to a weaker auth path while checks are blind. */
export async function isAdminWallet(wallet: string): Promise<boolean> {
  try {
    await requireAdmin(wallet);
    return true;
  } catch (err) {
    if (err instanceof SiwsError && err.status === 403) return false;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Resolve the live issuer authority from finalized program accounts.
// ---------------------------------------------------------------------------

/** Returns the issuer authority wallet behind a sale PDA, or null when any
 *  hop of the chain (sale / share class / asset / issuer) does not exist.
 *  Throws SiwsError(503) on RPC failure (fail closed — never grant on error). */
export async function saleIssuerAuthority(
  salePubkey: string,
): Promise<string | null> {
  let authority: string | null = null;
  try {
    const rpc = getServerRpc();
    const config={commitment:"finalized" as const,abortSignal:AbortSignal.timeout(12_000)};
    const sale = await fetchMaybeSale(rpc, toAddress(salePubkey),config);
    if (sale.exists && sale.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS) {
      const shareClass = await fetchMaybeShareClass(rpc, sale.data.shareClass,config);
      if (shareClass.exists && shareClass.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS) {
        const asset = await fetchMaybeAsset(rpc, shareClass.data.asset,config);
        if (asset.exists && asset.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS) {
          const issuer = await fetchMaybeIssuer(rpc, asset.data.issuer,config);
          if (issuer.exists && issuer.programAddress === ASSET_REGISTRY_PROGRAM_ADDRESS) authority = issuer.data.authority.toString();
        }
      }
    }
  } catch (err) {
    console.error(
      "[api/launchpad] RPC failure resolving sale issuer authority:",
      err,
    );
    throw new SiwsError(503, "Authorization check unavailable — try again");
  }

  return authority;
}

/** Validates a commitment dollar amount: finite, > 0, sane upper bound. */
export function validateAmount(value: unknown): number {
  const amount = typeof value === "number" ? value : NaN;
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1e12) {
    throw new SiwsError(400, "amount must be a positive number");
  }
  return amount;
}

/**
 * Require that a sale pubkey resolves to a LIVE on-chain Sale — i.e. the whole
 * Sale -> ShareClass -> Asset -> Issuer chain exists. Commit/record-purchase
 * previously accepted any base58 string here, letting anyone fabricate
 * commitments (and inflate the public raised/backers aggregate) against
 * arbitrary sale_pubkey values. Returns the issuer authority wallet.
 * Throws SiwsError(404) for unknown sales, 503 on RPC failure (fail closed).
 */
export async function requireLiveSale(salePubkey: string): Promise<string> {
  const authority = await saleIssuerAuthority(salePubkey);
  if (authority === null) {
    throw new SiwsError(
      404,
      "sale_pubkey does not resolve to a live on-chain sale",
    );
  }
  return authority;
}

/**
 * Per-row dollar cap for a sale: the raise target of the linked application
 * when one exists. Oversubscription across MANY commitments stays possible by
 * design (soft commits may exceed the target in aggregate) — this bounds a
 * single fabricated row, so one wallet can no longer add $1e12 to a sale's
 * public "raised" figure in one insert. Returns null when no linked
 * application row exists (validateAmount's global bound still applies).
 */
export async function saleAmountCap(salePubkey: string): Promise<number | null> {
  const sb = getSupabaseAdmin();
  const { data, error } = await sb
    .from("launch_applications")
    .select("raise_amount")
    .eq("linked_sale_pubkey", salePubkey)
    .eq("network", detectNetwork())
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[api/launchpad] raise-cap lookup failed:", error.message);
    // Fail open to the global validateAmount bound: the cap is a sanity
    // limit, not the authorization gate (that's requireLiveSale + SIWS).
    return null;
  }
  const raise = data?.[0]?.raise_amount;
  return typeof raise === "number" && raise > 0 ? raise : null;
}

/** Enforce `amount <= sale raise target` when a linked application exists. */
export async function enforceSaleAmountCap(
  salePubkey: string,
  amount: number,
): Promise<void> {
  const cap = await saleAmountCap(salePubkey);
  if (cap !== null && amount > cap) {
    throw new SiwsError(400, "amount exceeds this sale's raise target");
  }
}

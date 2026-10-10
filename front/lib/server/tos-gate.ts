// SERVER-ONLY — Terms-of-Service acceptance on the signed write routes a buyer
// or seller uses (pravo-compliance-9): /api/launchpad/commit, /api/otc/create
// and /api/resell/create, the holder's /api/conversion/create, and the sale
// page's pre-buy check /api/compliance/screen-wallet (D2, 2026-10-03: buying
// needs a wallet linked to the platform, i.e. signed in with the Terms in
// force accepted).
//
// The <TosGate /> interstitial is a client-side screen: a script can call these
// routes without ever seeing it. So on MAINNET these routes also require a
// tos_acceptances row for (signing wallet, TOS_VERSION), and fail CLOSED: no
// row → 409, an unreadable table → 503. The row is written by the signed
// /api/tos/accept route (or the onboarding acceptance for the dossier's
// wallet).
//
// Test networks keep today's behaviour (no server check) unless the server
// variable TOS_SERVER_GATE is exactly "enforce" — for rehearsing the mainnet
// behaviour on devnet. Direct on-chain purchases (the Mature buy) bypass every
// route: they are not supported (D2) and are detected after the fact — the
// alarm worker raises a compliance alert for a buyer without an acceptance of
// the Terms in force by 2 minutes after the buy
// (lib/server/onchain-link-check.ts), and the Operator may blocklist the
// wallet and claw back its units.

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { detectNetwork, type Network } from "@/lib/network";
import { SiwsError } from "@/lib/server/siws";
import { TOS_VERSION } from "@/lib/tos-version";

/** Whether the server requires a recorded acceptance on `network`. */
export function tosServerGateEnforced(
  network: Network = detectNetwork(),
  env: Record<string, string | undefined> = process.env,
): boolean {
  return network === "mainnet" || env.TOS_SERVER_GATE?.trim() === "enforce";
}

/**
 * Throws SiwsError(409) when `wallet` has not accepted the Terms in force, and
 * SiwsError(503) when that cannot be checked. A no-op where the gate is not
 * enforced (see tosServerGateEnforced). `context` completes "before …".
 */
export async function requireAcceptedTos(
  sb: SupabaseClient,
  wallet: string,
  context: string,
): Promise<void> {
  if (!tosServerGateEnforced()) return;
  let rows: unknown[] | null = null;
  try {
    const { data, error } = await sb
      .from("tos_acceptances")
      .select("id")
      .eq("wallet", wallet)
      .eq("version", TOS_VERSION)
      .limit(1);
    if (!error) rows = data ?? [];
    else console.error("[tos-gate] acceptance lookup failed:", error.message);
  } catch (err) {
    console.error("[tos-gate] acceptance lookup threw:", err instanceof Error ? err.message : String(err));
  }
  if (rows === null) {
    throw new SiwsError(503, "Terms of Service acceptance could not be checked — try again");
  }
  if (rows.length === 0) {
    throw new SiwsError(
      409,
      `Accept the current Terms of Service (v${TOS_VERSION}) with this wallet before ${context}`,
    );
  }
}

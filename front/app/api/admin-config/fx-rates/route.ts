// POST /api/admin-config/fx-rates — EUR rates of payment mints for the raise
// cap (0066 fx_rates), current network.
//   read  "adminConfig.fxRatesRead"  — requireAdmin (a wallet session may authorize it)
//   write "adminConfig.fxRatesWrite" — requireSuperAdmin; op "upsert" | "delete"
// An EUR stablecoin is kind "eur_peg" (1 EUR per token, never stale). Any
// other mint is kind "rate" and is refused by reservations once `as_of` is
// older than its max age. Decimals are read from chain, never trusted, and
// the mint must pass the plain-payment rule (lib/server/payment-mint).
// Mainnet (Talas 4.2 §3.3, D18): only allowlisted payment mints, with the
// kind the allowlist fixes (USDC is "rate"), and a rate at most 7 days old.
// Deleting a row is always allowed.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin, requireSuperAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { addressParam } from "@/lib/server/sale-capacity";
import { assertAllowedPaymentMint, paymentMintInfo } from "@/lib/server/payment-mint";
import { MAINNET_MAX_RATE_AGE_DAYS, paymentMintLabel, requiredFxKind } from "@/lib/payment-mints";

const RATE_RE = /^(0|[1-9]\d{0,9})(\.\d{1,10})?$/;

export async function POST(request: Request) {
  try {
    const body = (await request.clone().json().catch(() => null)) as { payload?: { action?: unknown } } | null;
    const isWrite = body?.payload?.action === "adminConfig.fxRatesWrite";
    const { wallet, params } = await verifySigned(request, isWrite ? "adminConfig.fxRatesWrite" : "adminConfig.fxRatesRead");
    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    if (isWrite) {
      await requireSuperAdmin(wallet);
      const mint = addressParam(params.payment_mint, "payment_mint");
      if (params.op === "delete") {
        const { error } = await sb.from("fx_rates").delete().eq("network", network).eq("payment_mint", mint);
        if (error) throw new SiwsError(500, "Could not delete the rate");
      } else {
        const kind = params.kind;
        if (kind !== "eur_peg" && kind !== "rate") throw new SiwsError(400, "kind must be eur_peg or rate");
        const rate = kind === "eur_peg" ? "1" : String(params.eur_per_token ?? "");
        if (!RATE_RE.test(rate) || Number(rate) <= 0) throw new SiwsError(400, "eur_per_token must be a positive decimal");
        const source = typeof params.source === "string" ? params.source.trim() : "";
        if (source.length < 1 || source.length > 200) throw new SiwsError(400, "source is required (at most 200 characters)");
        const maxAgeDays = typeof params.max_age_days === "number" ? params.max_age_days : 7;
        if (!Number.isInteger(maxAgeDays) || maxAgeDays < 1 || maxAgeDays > 90) throw new SiwsError(400, "max_age_days must be 1-90");
        if (network === "mainnet") {
          assertAllowedPaymentMint(network, mint);
          const required = requiredFxKind(network, mint);
          if (kind !== required) {
            throw new SiwsError(400, `On mainnet the ${paymentMintLabel(mint, network)} rate must be kind ${required}`);
          }
          if (kind === "rate" && maxAgeDays > MAINNET_MAX_RATE_AGE_DAYS) {
            throw new SiwsError(400, `On mainnet max_age_days must be at most ${MAINNET_MAX_RATE_AGE_DAYS}`);
          }
        }
        const { decimals } = await paymentMintInfo(mint, network);
        const now = new Date().toISOString();
        const { error } = await sb.from("fx_rates").upsert({
          network, payment_mint: mint, kind, eur_per_token: rate, decimals, source,
          as_of: now, max_age: `${maxAgeDays} days`, updated_by: wallet, updated_at: now,
        }, { onConflict: "network,payment_mint" });
        if (error) throw new SiwsError(500, "Could not save the rate");
      }
    } else {
      await requireAdmin(wallet);
    }
    const { data, error } = await sb.from("fx_rates").select("*").eq("network", network).order("payment_mint");
    if (error) throw new SiwsError(500, "Could not load the rates");
    return NextResponse.json({ ok: true, data: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

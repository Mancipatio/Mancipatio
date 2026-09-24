// POST /api/compliance/open-wallets — which of these wallets have an
// UNRESOLVED compliance alert (status open or escalated, OD14) on this
// network. The passport issue gate needs exactly that bit, for the queue and
// again for the single wallet at send time.
//
// Signed (or wallet session: "compliance.openWallets" is a session read) +
// requireAdminOrKycProvider (Talas 3.1 K6 / OD2). Deliberately narrow: it
// answers with the matching addresses only — no evidence, hit lists, notes,
// ids or counts. The full AML table stays behind the admin-only
// /api/compliance/list.
//
// Client wrapper: listWalletsWithOpenAlerts() in lib/compliance.ts.

import { NextResponse } from "next/server";
import { isAddress } from "@solana/kit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdminOrKycProvider } from "@/lib/server/kyc-provider-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

/** Most wallets one request may ask about (the client wrapper chunks). */
const MAX_OPEN_WALLETS_QUERY = 200;

/** Alert statuses that block passport issuance (OD14: escalated too). */
const UNRESOLVED_ALERT_STATUSES = ["open", "escalated"] as const;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "compliance.openWallets");
    await requireAdminOrKycProvider(wallet);

    const raw = params.wallets;
    if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_OPEN_WALLETS_QUERY) {
      throw new SiwsError(400, `wallets must be an array of 1–${MAX_OPEN_WALLETS_QUERY} addresses`);
    }
    const wallets = [
      ...new Set(
        raw.map((w) => {
          if (typeof w !== "string" || !isAddress(w)) {
            throw new SiwsError(400, "wallets must contain valid addresses only");
          }
          return w;
        }),
      ),
    ];

    const sb = getSupabaseAdmin();
    const { data, error } = await sb
      .from("compliance_alerts")
      .select("wallet")
      .eq("network", detectNetwork())
      .in("wallet", wallets)
      .in("status", [...UNRESOLVED_ALERT_STATUSES]);
    if (error) {
      console.error("[api/compliance/open-wallets] query failed:", error.message);
      throw new SiwsError(500, "Could not load compliance alert status");
    }

    const asked = new Set<string>(wallets);
    const open = [
      ...new Set(
        (data ?? [])
          .map((row) => (row as { wallet?: unknown }).wallet)
          .filter((w): w is string => typeof w === "string" && asked.has(w)),
      ),
    ];
    return NextResponse.json(
      { ok: true, data: { wallets: open } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

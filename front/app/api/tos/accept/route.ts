// POST /api/tos/accept — WALLET-signed Terms-of-Service acceptance.
// Action: "tos.accept". Params contract: { version: string }.
//
// Used by the marketplace/portfolio ToS interstitial (W2-F2 components/
// tos-gate.tsx): any connected wallet can accept, INCLUDING wallets with no
// clients row — tos_acceptances.client_id stays NULL then (migration 0029).
// When a clients row for the wallet exists, the acceptance is linked to it and
// the clients row is stamped too.
//
// Idempotent per (wallet, version): a repeat acceptance returns ok without
// inserting a duplicate log row.
//
// Client call: signedFetch(session, "/api/tos/accept", "tos.accept", { version })

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { TOS_VERSION } from "@/lib/tos-version";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "tos.accept");

    // Pin to the CURRENT version server-side: accepting an arbitrary client-
    // supplied version would let a wallet pre-sign acceptances for plausible
    // future (unseen) versions and pollute the legal ledger. Only the version
    // actually in force is acceptable.
    const version = params.version;
    if (typeof version !== "string" || version !== TOS_VERSION) {
      throw new SiwsError(
        400,
        `version must be the current Terms of Service version (${TOS_VERSION})`,
      );
    }

    const sb = getSupabaseAdmin();

    // Idempotency: already accepted this version with this wallet → done.
    const { data: existing, error: existErr } = await sb
      .from("tos_acceptances")
      .select("id")
      .eq("wallet", wallet)
      .eq("version", version)
      .limit(1);
    if (existErr) throw new SiwsError(500, "Database read failed");
    if ((existing ?? []).length > 0) {
      return NextResponse.json({
        ok: true,
        data: { accepted: true, version, already: true },
      });
    }

    // Optional client link — oldest clients row for this wallet, if any.
    const { data: clientRow } = await sb
      .from("clients")
      .select("id")
      .eq("wallet", wallet)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    const clientId = (clientRow as { id: string } | null)?.id ?? null;

    const { error } = await sb.from("tos_acceptances").insert({
      client_id: clientId,
      wallet,
      version,
      source: "wallet-gate",
    });
    if (error) {
      console.warn("[api/tos/accept] insert failed:", error.message);
      throw new SiwsError(500, error.message);
    }

    if (clientId) {
      await sb
        .from("clients")
        .update({
          tos_accepted_at: new Date().toISOString(),
          tos_version: version,
        })
        .eq("id", clientId);
    }

    return NextResponse.json({ ok: true, data: { accepted: true, version } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

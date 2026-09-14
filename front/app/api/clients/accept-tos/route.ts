// POST /api/clients/accept-tos — magic-link client accepts the current ToS.
// TOKEN-authed (NOT wallet-signed) — part of the onboarding flow.
// Client half: lib/clients.ts acceptTos().
//
// Body: { client_id, token, wallet? }
// Effects (mirrors the pre-P1 client-side acceptTos): stamps the clients row,
// appends to the tos_acceptances log (source 'onboarding'), system note.
//
// Wallet-only acceptance (no client row / no token) is the SIGNED route
// /api/tos/accept instead.

import { NextResponse } from "next/server";
import { siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { TOS_VERSION } from "@/lib/tos-version";
import {
  assertBase58Wallet,
  assertUuid,
  insertNote,
  requireClientToken,
} from "../_helpers";

export async function POST(request: Request) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new SiwsError(400, "Invalid JSON body");
    }
    if (typeof body !== "object" || body === null) {
      throw new SiwsError(400, "Invalid request body");
    }
    const { client_id, token, wallet } = body as Record<string, unknown>;
    const clientId = assertUuid(client_id, "client_id");
    const requestedWallet =
      wallet === undefined || wallet === null || wallet === ""
        ? null
        : assertBase58Wallet(wallet, "wallet");

    const sb = getSupabaseAdmin();
    const client = await requireClientToken(sb, clientId, token);
    // A token may acknowledge this invitation's Terms; it cannot stamp an
    // arbitrary address into wallet-level acceptance/audit records.
    const walletStr = client.wallet;
    if (!walletStr || (requestedWallet !== null && requestedWallet !== walletStr)) {
      throw new SiwsError(401, "Link this invitation's wallet before accepting Terms");
    }

    const { error } = await sb
      .from("clients")
      .update({
        tos_accepted_at: new Date().toISOString(),
        tos_version: TOS_VERSION,
      })
      .eq("id", clientId);
    if (error) {
      console.warn("[api/clients/accept-tos] update failed:", error.message);
      throw new SiwsError(500, error.message);
    }

    const { error: logErr } = await sb.from("tos_acceptances").insert({
      client_id: clientId,
      wallet: walletStr,
      version: TOS_VERSION,
      source: "onboarding",
    });
    if (logErr) {
      // Log-append failure is non-fatal (matches pre-P1 behavior).
      console.warn("[api/clients/accept-tos] log insert failed:", logErr.message);
    }

    await insertNote(
      sb,
      clientId,
      walletStr ?? "client",
      "Accepted Terms of Service v" + TOS_VERSION,
      "system",
    );

    return NextResponse.json({ ok: true, data: { version: TOS_VERSION } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

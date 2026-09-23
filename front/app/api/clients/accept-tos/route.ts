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
import { assertWritable } from "@/lib/server/maintenance";
import { detectNetwork } from "@/lib/network";
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

    // Token-authed, not signed: the maintenance refusal (503) happens here.
    // Browsing keeps working; the wallet-level ToS gate is /api/tos/accept.
    await assertWritable(detectNetwork());

    const sb = getSupabaseAdmin();
    const client = await requireClientToken(sb, clientId, token);
    // A token may acknowledge this invitation's Terms; it cannot stamp an
    // arbitrary address into wallet-level acceptance/audit records.
    const walletStr = client.wallet;
    // A dossier owned by a wallet-less (email/Google) account accepts through
    // its token alone; a wallet dossier still binds acceptance to that wallet.
    const accountOwned = !walletStr && !!client.account_id;
    if (!accountOwned && (!walletStr || (requestedWallet !== null && requestedWallet !== walletStr))) {
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
    if (logErr?.code === "23505" && walletStr) {
      // The wallet already accepted this version (e.g. at the marketplace
      // gate) — one row per (wallet, version) since 0065, on every network.
      // Link that row to this dossier when it has no dossier yet; the earlier
      // record stands. When it already belongs to another dossier of the same
      // wallet (another network), this dossier's evidence is that wallet row
      // plus the stamp above and the system note below (see 0065 §2).
      const { error: linkErr } = await sb
        .from("tos_acceptances")
        .update({ client_id: clientId })
        .eq("wallet", walletStr)
        .eq("version", TOS_VERSION)
        .is("client_id", null);
      if (linkErr) {
        console.warn("[api/clients/accept-tos] acceptance link failed:", linkErr.message);
      }
    } else if (logErr) {
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

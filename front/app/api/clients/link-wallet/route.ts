// Invitation token + SIWS v2 proof of the wallet that is being linked.
// The signed params contain client_id and SHA-256(token), never the raw bearer
// credential. 0044's service-only function rechecks the invitation under a row
// lock, binds the wallet once, caps TTL and writes the system note atomically.
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { assertUuid, clientIpOf, rateLimited } from "../_helpers";

export async function POST(request: Request) {
  try {
    if (rateLimited(`link-wallet:${clientIpOf(request)}`, 10, 60_000)) {
      throw new SiwsError(429, "Too many requests — slow down");
    }
    let body: { invitation_token?: unknown };
    try {
      body = await request.clone().json();
    } catch {
      throw new SiwsError(400, "Invalid JSON body");
    }
    const { wallet, params } = await verifySigned(request, "clients.linkWallet");
    const clientId = assertUuid(params.client_id, "client_id");
    const token = body?.invitation_token;
    if (typeof token !== "string" || !token.trim() || token.length > 128) {
      throw new SiwsError(401, "Invalid onboarding token");
    }
    const invitationToken = token.trim();
    const expectedHash = createHash("sha256").update(invitationToken).digest("hex");
    if (params.invitation_hash !== expectedHash) {
      throw new SiwsError(401, "Signature does not match this invitation");
    }

    const { data, error } = await getSupabaseAdmin().rpc("link_client_wallet", {
      p_client_id: clientId,
      p_token: invitationToken,
      p_wallet: wallet,
      p_network: detectNetwork(),
    });
    if (error) {
      if (error.code === "23505") {
        throw new SiwsError(409, "This wallet is already linked to another client dossier — contact the platform operator.");
      }
      console.error("[api/clients/link-wallet] atomic binding unavailable", error.code);
      throw new SiwsError(503, "Wallet linking is unavailable — try again");
    }
    const result = data as { status?: string; already_linked?: boolean } | null;
    switch (result?.status) {
      case "linked":
        return NextResponse.json({ ok: true, data: { linked: true, alreadyLinked: result.already_linked === true } }, { headers: { "Cache-Control": "no-store" } });
      case "invalid_invitation":
        throw new SiwsError(401, "Invalid onboarding invitation for this network");
      case "expired":
        throw new SiwsError(401, "This onboarding link has expired — ask the platform operator for a fresh invitation");
      case "wallet_conflict":
        throw new SiwsError(409, "A different wallet is already linked to this account");
      case "wallet_in_use":
        throw new SiwsError(409, "This wallet is already linked to another client dossier — contact the platform operator.");
      case "terminal_kyc":
        throw new SiwsError(403, "Your KYC dossier is suspended or rejected — contact the compliance team; relinking is disabled.");
      default:
        throw new SiwsError(503, "Wallet linking is unavailable — try again");
    }
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

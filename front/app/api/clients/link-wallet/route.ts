// Invitation token + SIWS v2 proof of the wallet that is being linked.
// The signed params contain client_id and SHA-256(token), never the raw bearer
// credential. 0044's service-only function rechecks the invitation under a row
// lock, binds the wallet once, caps TTL and writes the system note atomically.
//
// A dossier OWNED BY AN ACCOUNT (an email/Google verification: account_id
// set, no wallet yet — isAccountOwnedDossier) binds only a wallet of that
// account. Holding the upload link proves nothing about the identity behind
// it, so the signer must already be one of the account's wallets
// (account_wallets), or the browser must be signed in to that account, in
// which case the wallet is added to the account first — the two-proof rule
// of /api/account/wallets/attach (wallet signature + account session). An
// invitation without an account keeps today's rule: the signer binds itself.
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { readAccountSession } from "@/lib/server/account-auth";
import { attachAccountWallet } from "@/lib/server/account-wallets";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  assertUuid,
  clientIpOf,
  dossierForInvitation,
  isAccountOwnedDossier,
  isAccountWalletMember,
  rateLimited,
} from "../_helpers";

const ACCOUNT_WALLET_REQUIRED =
  "This verification belongs to a Manci account. Sign in to that account in this browser, or add this wallet under Your account → Wallets, then link it here.";

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

    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    // Who may bind a wallet to this dossier (see the header). The read answers
    // like the binding below for an unknown dossier, another network or a
    // wrong token (401); the binding re-checks everything under its row lock.
    const dossier = await dossierForInvitation(sb, clientId, invitationToken);
    if (isAccountOwnedDossier(dossier)) {
      const accountId = dossier.account_id as string;
      if (!(await isAccountWalletMember(sb, accountId, network, wallet))) {
        const session = readAccountSession(request);
        if (!session || session.a !== accountId) {
          throw new SiwsError(403, ACCOUNT_WALLET_REQUIRED);
        }
        // The signed-in owner adds the signer to the account first. A 409
        // from there (another account's wallet, the wallet limit) binds
        // nothing: the dossier keeps waiting for one of the account's wallets.
        await attachAccountWallet(accountId, network, wallet);
      }
    }

    const { data, error } = await sb.rpc("link_client_wallet", {
      p_client_id: clientId,
      p_token: invitationToken,
      p_wallet: wallet,
      p_network: network,
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

// POST /api/clients/create — admin creates a client row (SIWS + requireAdmin).
// Action: "clients.create". Client half: lib/clients.ts createClient().
//
// Magic-link invitations get a 14-day TTL (0041) and, when the client has an
// email, the invite link is sent directly (best-effort) — the admin no longer
// needs to copy/paste it out of the UI.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml } from "@/lib/server/email";
import {
  CLIENT_TYPES,
  assertBase58Wallet,
  detectNetworkServer,
  isMissingTtlColumnError,
  onboardingTokenExpiry,
  optString,
  randomOnboardingToken,
  reqString,
  withoutTtlColumn,
} from "../_helpers";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "clients.create");
    await requireAdmin(wallet);

    const rawTypes = params.types;
    if (!Array.isArray(rawTypes) || rawTypes.length === 0 || rawTypes.length > 4) {
      throw new SiwsError(400, "types must be a non-empty array");
    }
    const types = [...new Set(rawTypes)].map((t) => {
      if (
        typeof t !== "string" ||
        !(CLIENT_TYPES as readonly string[]).includes(t)
      ) {
        throw new SiwsError(400, `types entries must be one of: ${CLIENT_TYPES.join(", ")}`);
      }
      return t;
    });

    const displayName = reqString(params, "display_name", 200);
    const email = optString(params, "email", 320);
    const companyName = optString(params, "company_name", 200);
    const jurisdiction = optString(params, "jurisdiction", 8);
    const tier = optString(params, "tier", 40);
    const source = optString(params, "source", 100) ?? "admin-onboarded";
    const clientWallet =
      params.wallet === undefined || params.wallet === null || params.wallet === ""
        ? null
        : assertBase58Wallet(params.wallet, "wallet");

    const sb = getSupabaseAdmin();
    // Pre-known wallet → skip the magic-link redemption step.
    const token = clientWallet ? null : randomOnboardingToken();
    const insertRow: Record<string, unknown> = {
      network: detectNetworkServer(),
      type: types[0],
      types,
      email,
      display_name: displayName,
      company_name: companyName,
      jurisdiction,
      tier,
      source,
      wallet: clientWallet,
      onboarding_token: token,
      onboarding_token_expires_at: token ? onboardingTokenExpiry() : null,
      onboarding_status: clientWallet ? "connected" : "invited",
    };
    let { data, error } = await sb
      .from("clients")
      .insert(insertRow)
      .select("*")
      .single();
    if (error && isMissingTtlColumnError(error)) {
      // Pre-0041 database — degrade to "no TTL stamp" instead of 500-ing
      // client creation (TTL then falls back to created_at + 14d server-side).
      console.warn(
        "[api/clients/create] 0041 not applied — retrying insert without TTL column",
      );
      ({ data, error } = await sb
        .from("clients")
        .insert(withoutTtlColumn(insertRow))
        .select("*")
        .single());
    }
    if (error && error.code === "23505") {
      // clients_wallet_unique (0041): the pre-known wallet already has a
      // dossier — surface it instead of silently creating a duplicate.
      throw new SiwsError(
        409,
        "A client dossier already exists for this wallet — open it instead of creating a duplicate.",
      );
    }
    if (error) {
      console.error("[api/clients/create] insert failed:", error.message);
      throw new SiwsError(500, error.message);
    }

    // Best-effort invite email with the magic-link (never fails the request).
    if (email && token) {
      const origin =
        process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "") ??
        new URL(request.url).origin;
      const inviteUrl = `${origin}/onboarding/${(data as { id: string }).id}?t=${token}`;
      await sendEmail({
        to: email,
        subject: "You're invited to onboard on Manci",
        html:
          `<p>Hi ${escapeHtml(displayName)},</p>` +
          `<p>You've been invited to onboard on Manci. Open your personal ` +
          `onboarding link, connect a Solana wallet and upload any requested documents:</p>` +
          `<p><a href="${inviteUrl}">${inviteUrl}</a></p>` +
          `<p style="color:#64748b;font-size:12px;">The link is valid for 14 days. — The Manci team</p>`,
      });
    }

    return NextResponse.json({ ok: true, data });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

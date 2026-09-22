// POST /api/auth/email/verify { token } — consume the one-time link, sign in
// (creating the wallet-less account on first use) and set the session cookie.

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { assertSameSite, withAccountSession } from "@/lib/server/auth-login";

export async function POST(request: Request) {
  try {
    const origin = assertSameSite(request);
    const body = await (await boundedRequest(request, 1024)).json().catch(() => null) as { token?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token : "";
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new SiwsError(400, "This sign-in link is invalid.");
    const sb = getSupabaseAdmin();
    const network = detectNetwork();
    const { data: email, error } = await sb.rpc("consume_login_token", {
      p_token_hash: createHash("sha256").update(token).digest("hex"), p_network: network,
    });
    if (error) throw new SiwsError(503, "Sign-in is temporarily unavailable. Please try again.");
    if (typeof email !== "string" || !email) throw new SiwsError(400, "This sign-in link has expired or was already used. Request a new one.");
    const { data: accountId, error: loginErr } = await sb.rpc("login_account_email", { p_network: network, p_email: email });
    if (loginErr || typeof accountId !== "string") throw new SiwsError(503, "Sign-in is temporarily unavailable. Please try again.");
    return withAccountSession(NextResponse.json({ ok: true, data: { account_id: accountId } }), accountId, origin);
  } catch (error) {
    return siwsErrorResponse(error);
  }
}

// POST /api/auth/email/start { email } — send a one-time sign-in link. The
// answer is the same whether or not an account exists (no enumeration).
// Sign-in creates the account on first use.

import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml, emailConfigured } from "@/lib/server/email";
import { consumeAccountRateLimit } from "@/lib/server/account-profile";
import { clientIpOf } from "@/app/api/clients/_helpers";
import { assertSameSite, LOGIN_EMAIL_RE } from "@/lib/server/auth-login";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");

export async function POST(request: Request) {
  try {
    const origin = assertSameSite(request);
    if (!emailConfigured()) throw new SiwsError(503, "Email sign-in is not available right now.");
    const body = await (await boundedRequest(request, 2048)).json().catch(() => null) as { email?: unknown } | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!LOGIN_EMAIL_RE.test(email) || email.length > 254) throw new SiwsError(400, "Enter a valid email address.");
    const network = detectNetwork();
    await consumeAccountRateLimit(`login-ip:${clientIpOf(request)}`, 20, 3600);
    await consumeAccountRateLimit(`login-email:${network}:${email}`, 5, 3600);

    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    const { error } = await getSupabaseAdmin().from("auth_login_tokens").insert({
      token_hash: hash(token), network, email,
      created_at: new Date(now).toISOString(), expires_at: new Date(now + 20 * 60 * 1000).toISOString(),
    });
    if (error) throw new SiwsError(503, "Sign-in is temporarily unavailable. Please try again.");
    const link = new URL("/login/email", origin);
    link.searchParams.set("token", token);
    const sent = await sendEmail({
      to: email, redactErrors: true, subject: "Your Manci sign-in link",
      html: `<p>Use this link to sign in to Manci:</p><p><a href="${escapeHtml(link.toString())}">Sign in to Manci</a></p>` +
        "<p>The link works once and expires in 20 minutes. If you did not ask to sign in, you can ignore this email.</p>",
    });
    if (!sent.sent) throw new SiwsError(503, "We could not send the sign-in email. Please try again later.");
    return NextResponse.json({ ok: true, data: { sent: true } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return siwsErrorResponse(error);
  }
}

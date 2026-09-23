// POST /api/auth/email/start { email, turnstile_token? } — send a one-time
// sign-in link. The answer is the same whether or not an account exists (no
// enumeration). Sign-in creates the account on first use.
//
// Abuse guards, in order: the Turnstile check (when TURNSTILE_SECRET_KEY is
// set), then per-IP, per-address and deployment-wide send caps. The Turnstile
// check comes first so requests without a solved challenge cannot use up the
// caps. The deployment-wide cap bounds how much mail a distributed flood can
// push through our mail server; at worst it delays sign-in links (Google and
// wallet sign-in are unaffected).

import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml, emailConfigured } from "@/lib/server/email";
import { consumeAccountRateLimit } from "@/lib/server/account-profile";
import { clientIpOf } from "@/app/api/clients/_helpers";
import {
  assertSameSite, EMAIL_START_BODY_LIMIT, GLOBAL_LOGIN_EMAIL_LIMIT, GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS, LOGIN_EMAIL_RE,
} from "@/lib/server/auth-login";
import { verifyTurnstile } from "@/lib/server/turnstile";
import { TURNSTILE_ACTIONS, TURNSTILE_BODY_FIELD } from "@/lib/turnstile";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");

export async function POST(request: Request) {
  try {
    const origin = assertSameSite(request);
    if (!emailConfigured()) throw new SiwsError(503, "Email sign-in is not available right now.");
    const body = await (await boundedRequest(request, EMAIL_START_BODY_LIMIT)).json().catch(() => null) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!LOGIN_EMAIL_RE.test(email) || email.length > 254) throw new SiwsError(400, "Enter a valid email address.");
    await verifyTurnstile(request, body?.[TURNSTILE_BODY_FIELD], TURNSTILE_ACTIONS.emailLogin);
    const network = detectNetwork();
    await consumeAccountRateLimit(`login-ip:${clientIpOf(request)}`, 20, 3600);
    await consumeAccountRateLimit(`login-email:${network}:${email}`, 5, 3600);
    await consumeAccountRateLimit(`login-email-all:${network}`, GLOBAL_LOGIN_EMAIL_LIMIT, GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS);

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

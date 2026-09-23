// POST /api/auth/email/start { email, turnstile_token? } — send a one-time
// sign-in link. The answer is the same whether or not an account exists (no
// enumeration). Sign-in creates the account on first use.
//
// Abuse guards, in order:
//   1. an in-memory per-instance burst cap per IP (/64 for IPv6), so junk
//      Turnstile tokens cannot make unbounded siteverify calls;
//   2. the Turnstile check (when TURNSTILE_SECRET_KEY is set), before the DB
//      caps, so requests without a solved challenge cannot use them up;
//   3. per-IP (/64 for IPv6), then deployment-wide, then per-address DB caps.
//
// Trade-off of the deployment-wide cap: it exists to bound mail volume and
// the mail server's reputation under a large distributed flood, not to
// throttle users, so it is a high circuit breaker (see
// GLOBAL_LOGIN_EMAIL_LIMIT). A flood big enough to trip it delays everyone's
// sign-in links for as long as it lasts (Google and wallet sign-in are not
// affected); trips are logged (at most once a minute per instance) so ops
// can turn Turnstile on. It is checked
// before the per-address cap so a real user retrying during a trip does not
// also use up the sends for their own address.

import { createHash, randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { boundedRequest } from "@/lib/server/bounded-request";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { sendEmail, escapeHtml, emailConfigured } from "@/lib/server/email";
import { consumeAccountRateLimit } from "@/lib/server/account-profile";
import { clientIpOf, ipRateLimitKey, rateLimited } from "@/app/api/clients/_helpers";
import {
  assertSameSite, EMAIL_START_BODY_LIMIT, EMAIL_START_BURST_LIMIT, EMAIL_START_BURST_WINDOW_MS,
  GLOBAL_LOGIN_EMAIL_LIMIT, GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS, LOGIN_EMAIL_LIMIT, LOGIN_EMAIL_RE, LOGIN_IP_LIMIT,
} from "@/lib/server/auth-login";
import { verifyTurnstile } from "@/lib/server/turnstile";
import { TURNSTILE_ACTIONS, TURNSTILE_BODY_FIELD } from "@/lib/turnstile";

const hash = (v: string) => createHash("sha256").update(v).digest("hex");

/** Log a deployment-wide cap trip at most once a minute per instance (no
 *  addresses or IPs in the line). */
let lastGlobalCapWarning = -Infinity;
function warnGlobalCapReached(network: string) {
  const now = Date.now();
  if (now - lastGlobalCapWarning < 60_000) return;
  lastGlobalCapWarning = now;
  console.warn(`[auth/email/start] deployment-wide sign-in email cap reached on ${network} — ` +
    "possible flood; sign-in links are refused until it clears. Turn Turnstile on if it persists.");
}

export async function POST(request: Request) {
  try {
    const origin = assertSameSite(request);
    if (!emailConfigured()) throw new SiwsError(503, "Email sign-in is not available right now.");
    const body = await (await boundedRequest(request, EMAIL_START_BODY_LIMIT)).json().catch(() => null) as Record<string, unknown> | null;
    const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
    if (!LOGIN_EMAIL_RE.test(email) || email.length > 254) throw new SiwsError(400, "Enter a valid email address.");
    const ipKey = ipRateLimitKey(clientIpOf(request));
    if (rateLimited(`auth-email-start:${ipKey}`, EMAIL_START_BURST_LIMIT, EMAIL_START_BURST_WINDOW_MS)) {
      throw new SiwsError(429, "Too many requests. Please try again in a minute.");
    }
    await verifyTurnstile(request, body?.[TURNSTILE_BODY_FIELD], TURNSTILE_ACTIONS.emailLogin);
    const network = detectNetwork();
    await consumeAccountRateLimit(`login-ip:${ipKey}`, LOGIN_IP_LIMIT, 3600);
    try {
      await consumeAccountRateLimit(`login-email-all:${network}`, GLOBAL_LOGIN_EMAIL_LIMIT, GLOBAL_LOGIN_EMAIL_WINDOW_SECONDS);
    } catch (error) {
      if (error instanceof SiwsError && error.status === 429) warnGlobalCapReached(network);
      throw error;
    }
    await consumeAccountRateLimit(`login-email:${network}:${email}`, LOGIN_EMAIL_LIMIT, 3600);

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

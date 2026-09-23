// SERVER-ONLY — Cloudflare Turnstile token check for public, unauthenticated
// forms (email sign-in, contact inquiries).
//
// Off until TURNSTILE_SECRET_KEY is set: then every call is a no-op. Once the
// secret is set the check FAILS CLOSED: a missing token, a rejected token, a
// token issued for another action or hostname, an unreachable or slow
// siteverify endpoint and a bad secret all refuse the request.
//
// The secret is read at runtime, but NEXT_PUBLIC_TURNSTILE_SITE_KEY is inlined
// at build time. A deployment with the secret and no site key would ask for a
// token no page can produce: that refuses with 503 and logs a configuration
// error once per instance (next.config.ts also fails such a production build).
//
// Cloudflare's test secrets (1x…/2x…/3x…) answer with hostname "localhost"
// and action "test", so with one of them the action and hostname checks are
// skipped — outside production only. A production build configured with a
// test secret refuses every request instead of silently accepting any token.

import "server-only";
import { SiwsError } from "@/lib/server/siws-error";
import { accountSiteOrigin } from "@/lib/server/account-origin";
import { clientIpOf } from "@/app/api/clients/_helpers";
import { TURNSTILE_TOKEN_MAX_LENGTH, turnstileSiteKey, type TurnstileAction } from "@/lib/turnstile";

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Kept short: the sign-in request waits on it. */
export const TURNSTILE_TIMEOUT_MS = 4_000;

/** Cloudflare's published dummy secret keys (always pass / always fail / already spent). */
const TEST_SECRETS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

type SiteverifyResponse = {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  "error-codes"?: unknown;
};

/** The missing-site-key configuration error is logged once per instance. */
let warnedMissingSiteKey = false;

/** True when this deployment checks Turnstile tokens. */
export function turnstileEnabled(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());
}

function unavailable(): SiwsError {
  return new SiwsError(503, "The security check is unavailable right now. Please try again in a moment.");
}

function rejected(message = "The security check failed. Please try again."): SiwsError {
  return new SiwsError(403, message);
}

/**
 * Verify a Turnstile token for `action` against Cloudflare's siteverify API.
 * Resolves when Turnstile is off or the token is valid; otherwise throws a
 * SiwsError (400 missing token, 403 rejected token, 503 check unavailable).
 * Tokens are single-use: the caller's widget must fetch a new one per request.
 */
export async function verifyTurnstile(request: Request, token: unknown, action: TurnstileAction): Promise<void> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return;
  const testSecret = TEST_SECRETS.has(secret);
  if (testSecret && process.env.NODE_ENV === "production") {
    console.error("[turnstile] TURNSTILE_SECRET_KEY is a Cloudflare test key in a production build — refusing.");
    throw unavailable();
  }
  if (!turnstileSiteKey()) {
    if (!warnedMissingSiteKey) {
      warnedMissingSiteKey = true;
      console.error("[turnstile] TURNSTILE_SECRET_KEY is set but this build has no NEXT_PUBLIC_TURNSTILE_SITE_KEY, " +
        "so no page shows the challenge — refusing. Set both and rebuild, or unset the secret.");
    }
    throw unavailable();
  }
  if (typeof token !== "string" || token.length === 0) {
    throw new SiwsError(400, "Complete the security check and try again.");
  }
  if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) throw rejected();
  // The canonical site hostname (NEXT_PUBLIC_SITE_URL; the request origin only
  // on localhost in development). Throws 503 when the site URL is not set.
  const expectedHostname = new URL(accountSiteOrigin(request)).hostname.toLowerCase();

  const form = new URLSearchParams({ secret, response: token });
  const ip = clientIpOf(request);
  if (ip !== "unknown") form.set("remoteip", ip);

  let result: SiteverifyResponse;
  try {
    const response = await fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      body: form,
      cache: "no-store",
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object") throw new Error("malformed response");
    result = parsed as SiteverifyResponse;
  } catch (error) {
    // Never log the token, the secret or the visitor's IP.
    console.error("[turnstile] siteverify failed:", error instanceof Error ? error.name : "unknown");
    throw unavailable();
  }

  const codes = Array.isArray(result["error-codes"])
    ? result["error-codes"].filter((code): code is string => typeof code === "string")
    : [];
  if (codes.includes("missing-input-secret") || codes.includes("invalid-input-secret")) {
    console.error("[turnstile] siteverify rejected TURNSTILE_SECRET_KEY — check the deployment's configuration.");
    throw unavailable();
  }
  if (result.success !== true) {
    if (codes.includes("internal-error")) throw unavailable();
    if (codes.includes("timeout-or-duplicate")) throw rejected("The security check expired. Please complete it again.");
    throw rejected();
  }
  if (testSecret) return;
  const hostname = typeof result.hostname === "string" ? result.hostname.toLowerCase() : null;
  if (result.action !== action || hostname !== expectedHostname) {
    console.warn("[turnstile] token was issued for another action or hostname.");
    throw rejected();
  }
}

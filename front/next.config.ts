import type { NextConfig } from "next";

// `next build`'s phase (next/constants PHASE_PRODUCTION_BUILD). Spelled out
// rather than imported so this file stays free of runtime imports under both
// of Next's next.config.ts loaders (native Node TS and the SWC fallback).
const PHASE_PRODUCTION_BUILD = "phase-production-build";

const NETWORKS = ["mainnet", "devnet", "testnet", "localnet"];

/**
 * The Terms of Service and the Privacy Policy (app/(marketing)/legal/terms,
 * app/(marketing)/legal/privacy) still carry the devnet-pilot wording: "The
 * current release runs on Solana devnet. No real assets are tokenized…", "No
 * real assets or fiat are ever transferred", "before mainnet launch". That is
 * binding text, it is counsel's to rewrite (not this codebase's), and it would
 * be false on a mainnet deployment. So a mainnet build refuses to ship it until
 * someone sets MAINNET_LEGAL_COPY_APPROVED=true, which asserts that counsel's
 * mainnet terms and privacy copy has landed. Build-time only (not
 * NEXT_PUBLIC_): nothing at runtime reads it.
 */
const MAINNET_LEGAL_ACK = "MAINNET_LEGAL_COPY_APPROVED";

/**
 * NEXT_PUBLIC_NETWORK must be explicit in a deployed build. lib/network.ts
 * falls back to sniffing NEXT_PUBLIC_SOLANA_RPC_URL (and then to devnet) when
 * it is unset — convenient locally, but on Vercel it would silently ship a
 * build that points at the wrong cluster and says "devnet" or "mainnet" on the
 * strength of a URL substring. So:
 *   - any production build with a set-but-invalid value fails (the app would
 *     throw at runtime anyway);
 *   - a production build ON VERCEL (VERCEL=1 or VERCEL_ENV set — Production
 *     and Preview alike) also fails when the variable is unset.
 *   - a MAINNET production build (anywhere) also fails unless
 *     MAINNET_LEGAL_COPY_APPROVED=true — see MAINNET_LEGAL_ACK below.
 * Local devnet/testnet/localnet builds, CI (which sets
 * NEXT_PUBLIC_NETWORK=devnet), `next dev` and tests are unaffected.
 */
export function assertBuildNetwork(
  phase: string,
  env: Record<string, string | undefined> = process.env,
): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  const raw = env.NEXT_PUBLIC_NETWORK;
  const value = raw?.trim().toLowerCase() ?? "";
  if (value && !NETWORKS.includes(value)) {
    throw new Error(
      `NEXT_PUBLIC_NETWORK="${raw}" is invalid. Use one of: ${NETWORKS.join(", ")}.`,
    );
  }
  const onVercel = env.VERCEL === "1" || Boolean(env.VERCEL_ENV);
  if (onVercel && !value) {
    throw new Error(
      `NEXT_PUBLIC_NETWORK is not set for this Vercel build (VERCEL_ENV=${env.VERCEL_ENV ?? "unset"}). ` +
        `Set it explicitly (${NETWORKS.join(" | ")}) in the Vercel project's Environment Variables ` +
        "for this environment — the build refuses to guess the network from the RPC URL.",
    );
  }
  if (value === "mainnet" && env[MAINNET_LEGAL_ACK]?.trim() !== "true") {
    throw new Error(
      `Refusing a mainnet build: the Terms of Service and Privacy Policy (app/(marketing)/legal/) ` +
        "still say the platform runs on Solana devnet with no real assets. Land counsel's mainnet " +
        `legal copy, then set ${MAINNET_LEGAL_ACK}=true for this build.`,
    );
  }
}

/**
 * Cloudflare Turnstile is on for a deployment only when both keys are set:
 * the server checks tokens when TURNSTILE_SECRET_KEY is set (read at
 * runtime), and pages render the widget only when NEXT_PUBLIC_TURNSTILE_SITE_KEY
 * was set at build time. The secret without the site key would refuse every
 * email sign-in and contact submission (the server fails closed and no page
 * can produce a token), so a production build with that combination fails.
 * The site key without the secret only warns: the widget shows, but tokens
 * are not checked.
 */
export function assertBuildTurnstile(
  phase: string,
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): void {
  if (phase !== PHASE_PRODUCTION_BUILD) return;
  const secret = Boolean(env.TURNSTILE_SECRET_KEY?.trim());
  const siteKey = Boolean(env.NEXT_PUBLIC_TURNSTILE_SITE_KEY?.trim());
  if (secret && !siteKey) {
    throw new Error(
      "TURNSTILE_SECRET_KEY is set but NEXT_PUBLIC_TURNSTILE_SITE_KEY is not: every email sign-in and contact " +
        "submission would be refused, because no page would show the challenge. Set both for this environment " +
        "(the site key is read at build time), or unset the secret.",
    );
  }
  if (siteKey && !secret) {
    warn(
      "NEXT_PUBLIC_TURNSTILE_SITE_KEY is set without TURNSTILE_SECRET_KEY: the Turnstile widget shows, but the " +
        "server does not check its tokens.",
    );
  }
}

// Site-wide browser hardening. No Content-Security-Policy yet: it needs the
// wallet, RPC and Supabase origins per network and a nonce for Next's inline
// scripts, and ships separately (report-only first).
const SECURITY_HEADERS = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // Denied for every frame. The planned Sumsub WebSDK runs in an iframe and
  // needs camera and microphone for liveness checks: that integration must
  // delegate them, e.g. camera=(self "https://*.sumsub.com"), and test it.
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  // Isolates this window from pages it did not open, but keeps the opener
  // link to popups it opens (wallet adapters that use a popup window). Google
  // sign-in is a full-page redirect and needs no opener.
  { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
];

// Pages whose URL can carry a live credential (/login/email?token=…,
// /onboarding/[id]?t=…), that show personal or KYC data (/account, /admin),
// or that issue sessions: never stored by the browser or back-forward cache,
// never sent as Referer (not even same-origin), never indexed.
const SENSITIVE_SOURCES = [
  "/account/:path*",
  "/api/account/:path*",
  // Pages under /login (/login/email?token=…), not /login itself: see below.
  "/login/:path+",
  "/onboarding/:path*",
  "/admin/:path*",
  "/api/auth/:path*",
];

// The sign-in page carries no credential in its URL (only ?next=<path>) and
// hosts the Cloudflare Turnstile widget, a cross-origin iframe whose domain
// check may rely on the Referer; no-referrer could break it (error 110200),
// and the server fails closed. So it keeps the site-wide
// strict-origin-when-cross-origin, and is still never stored or indexed.
const SIGN_IN_PAGE = "/login";

const nextConfig: NextConfig = {
  // The local preview uses this exact loopback hostname; production is unchanged.
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  async headers() {
    return [
      { source: "/:path*", headers: SECURITY_HEADERS },
      // Later rules win for the same key: these keep no-referrer.
      ...SENSITIVE_SOURCES.map((source) => ({
        source,
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      })),
      {
        source: SIGN_IN_PAGE,
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      // Absorbed into the homepage. Note: redirect destinations can't carry a
      // hash, so this lands on "/".
      { source: "/why-mancipatio", destination: "/", permanent: true },
      // /how-it-works used to redirect here; it is a real page again. The old
      // redirect was permanent (308), so browsers that followed it have it
      // cached — this temporary redirect exists only to unstick them and can
      // be dropped once the cached entries age out.
      { source: "/invest", destination: "/investors", permanent: false },
    ];
  },
};

export default function config(phase: string): NextConfig {
  assertBuildNetwork(phase);
  assertBuildTurnstile(phase);
  return nextConfig;
}

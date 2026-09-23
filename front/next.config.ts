import type { NextConfig } from "next";

// `next build`'s phase (next/constants PHASE_PRODUCTION_BUILD). Spelled out
// rather than imported so this file stays free of runtime imports under both
// of Next's next.config.ts loaders (native Node TS and the SWC fallback).
const PHASE_PRODUCTION_BUILD = "phase-production-build";

const NETWORKS = ["mainnet", "devnet", "testnet", "localnet"];

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
 * Local `next build`, CI (which sets NEXT_PUBLIC_NETWORK=devnet), `next dev`
 * and tests are unaffected.
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
}

const nextConfig: NextConfig = {
  // The local preview uses this exact loopback hostname; production is unchanged.
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  async headers() {
    return ["/account/:path*", "/api/account/:path*"].map((source) => ({
      source,
      headers: [
        { key: "Cache-Control", value: "no-store" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ],
    }));
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
  return nextConfig;
}

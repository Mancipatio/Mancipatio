// Search-engine indexing policy, shared by app/robots.ts and the root layout's
// `robots` metadata so the two can never disagree.
//
// Default is NOINDEX on every deployment. Indexing is allowed only on a
// mainnet build that also opts in with NEXT_PUBLIC_ALLOW_INDEXING=true, and —
// when built on Vercel — only in the Production environment. So a devnet
// build, or a Vercel Preview build (a PR or a staging branch, possibly on a
// custom domain), stays out of search results even if the mainnet network and
// the opt-in are shared into its environment ("All Environments").
// (The SEO launch decision is the owner's; this keeps the switch off until it
// is made.)
//
// Server-only in practice: VERCEL_ENV is not NEXT_PUBLIC_, so a client bundle
// would read it as undefined. Both consumers (app/robots.ts and the root
// layout's metadata) run on the server.

import { detectNetwork, type Network } from "@/lib/network";

export function indexingAllowed(
  network: Network = detectNetwork(),
  optIn: string | undefined = process.env.NEXT_PUBLIC_ALLOW_INDEXING,
  vercelEnv: string | undefined = process.env.VERCEL_ENV,
): boolean {
  const vercelProductionOrLocal = !vercelEnv || vercelEnv === "production";
  return network === "mainnet" && optIn?.trim() === "true" && vercelProductionOrLocal;
}

/**
 * Paths crawlers are asked to skip even when indexing is allowed: signed-in
 * workspaces, admin tooling and API routes. (/account also carries an
 * X-Robots-Tag: noindex header — see next.config.ts.)
 */
export const NON_INDEXED_PATHS = [
  "/account",
  "/admin",
  "/api/",
  "/issuer",
  "/login",
  "/onboarding",
  "/portfolio",
  "/verify",
] as const;

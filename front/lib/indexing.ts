// Search-engine indexing policy, shared by app/robots.ts and the root layout's
// `robots` metadata so the two can never disagree.
//
// Default is NOINDEX on every deployment. Indexing is allowed only on a
// mainnet build that also opts in with NEXT_PUBLIC_ALLOW_INDEXING=true — a
// devnet/preview build stays out of search results even if the opt-in is
// copied into its environment. (The SEO launch decision is the owner's; this
// keeps the switch off until it is made.)

import { detectNetwork, type Network } from "@/lib/network";

export function indexingAllowed(
  network: Network = detectNetwork(),
  optIn: string | undefined = process.env.NEXT_PUBLIC_ALLOW_INDEXING,
): boolean {
  return network === "mainnet" && optIn?.trim() === "true";
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

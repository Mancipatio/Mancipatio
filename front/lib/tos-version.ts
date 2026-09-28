// Single source of truth for the current Terms-of-Service version, per network.
//
// Deliberately directive-free so BOTH sides can import it:
//   - client code via the re-export in lib/clients.ts (`TOS_VERSION`)
//   - server routes (app/api/clients/accept-tos, app/api/tos/accept,
//     lib/server/tos-gate.ts)
//
// Devnet, testnet and localnet show the devnet pilot's Terms
// (app/(marketing)/legal/terms/devnet-terms.tsx): bump DEVNET_TOS_VERSION when
// that text changes materially. Mainnet shows counsel's Terms
// (lib/legal/mainnet-copy.ts), whose own `version` is the one accepted there.

import { detectNetwork, type Network } from "@/lib/network";
import { MAINNET_TERMS } from "@/lib/legal/mainnet-copy";

/** The devnet pilot's Terms version. */
export const DEVNET_TOS_VERSION = "2026-07-18";

/**
 * Mainnet before counsel's Terms are in the slot. A mainnet build refuses to
 * ship without them (lib/legal/readiness.ts), so only a local mainnet
 * `next dev` (the operator front) ever asks for this version.
 */
export const MAINNET_TOS_UNPUBLISHED = "mainnet-unpublished";

/** The Terms version in force on `network`. */
export function tosVersionFor(network: Network): string {
  if (network !== "mainnet") return DEVNET_TOS_VERSION;
  return MAINNET_TERMS?.version ?? MAINNET_TOS_UNPUBLISHED;
}

/** The Terms version of THIS build (NEXT_PUBLIC_NETWORK, inlined at build time). */
export const TOS_VERSION = tosVersionFor(detectNetwork());

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
// (lib/legal/mainnet-copy.ts), whose own `version` is the one accepted there:
// 2026-10-03, the Terms of the owner's decisions D1-D7 (the acceptance dialog
// shows "v2026-10-03", /legal/terms "Last updated: 2026-10-03"). It replaced
// 2026-10-02, so every mainnet wallet accepts again: the client cache key, the
// /api/tos/accept check and the server gate all take this version, and the
// 2026-10-02 rows stay as history.

import { detectNetwork, type Network } from "@/lib/network";
import { MAINNET_TERMS } from "@/lib/legal/mainnet-copy";

/** The devnet pilot's Terms version. */
export const DEVNET_TOS_VERSION = "2026-07-18";

/**
 * The Terms version in force on `network`. On mainnet it is counsel's Terms'
 * own version, with no fallback: a mainnet build without those Terms is
 * refused (lib/legal/readiness.ts), and a mainnet runtime without them fails
 * here rather than ask wallets to accept a version that was never published.
 */
export function tosVersionFor(network: Network): string {
  if (network !== "mainnet") return DEVNET_TOS_VERSION;
  if (!MAINNET_TERMS) {
    throw new Error("No mainnet Terms of Service in lib/legal/mainnet-copy.ts: there is no version to accept on mainnet");
  }
  return MAINNET_TERMS.version;
}

/** The Terms version of THIS build (NEXT_PUBLIC_NETWORK, inlined at build time). */
export const TOS_VERSION = tosVersionFor(detectNetwork());

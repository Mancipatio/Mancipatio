// SERVER-ONLY — the RPC endpoint for the CURRENT network.
//
// Server authorization (admin gate, holdings verification, issuer-authority
// resolution) MUST be evaluated against the same cluster the public site runs
// on. Pinning to devnet meant that on a mainnet deployment where the env var
// was forgotten, admin checks would be run against devnet accounts. This
// resolver mirrors the client's detectNetwork() and picks the matching RPC
// URL, failing CLOSED for mainnet when no mainnet RPC is configured. Every
// request also requires a matching genesis hash (cached at most 30 seconds).

import "server-only";

import { createNetworkVerifiedRpc } from "@/lib/network-identity";
import { detectNetwork, type Network } from "@/lib/network";

type Rpc = ReturnType<typeof createNetworkVerifiedRpc>;
let cached: Rpc | null = null;
let cachedKey: string | null = null;

/**
 * The current network and its server RPC URL (the URL can carry a provider
 * API key: never log it). Throws on mainnet without a configured provider.
 */
export function serverRpcEndpoint(): { network: Network; url: string } {
  const network = detectNetwork();
  let url: string | undefined;
  switch (network) {
    case "mainnet":
      url = process.env.HELIUS_MAINNET_RPC || process.env.SOLANA_MAINNET_RPC;
      if (!url) {
        // Fail closed rather than silently authorize against devnet.
        throw new Error(
          "Server RPC misconfigured: NEXT_PUBLIC_NETWORK is mainnet but no HELIUS_MAINNET_RPC/SOLANA_MAINNET_RPC is set — refusing to evaluate authorization against a devnet cluster.",
        );
      }
      break;
    case "testnet":
      url = process.env.HELIUS_TESTNET_RPC || "https://api.testnet.solana.com";
      break;
    case "localnet":
      url = process.env.SOLANA_LOCALNET_RPC || "http://127.0.0.1:8899";
      break;
    case "devnet":
    default:
      url = process.env.HELIUS_DEVNET_RPC || "https://api.devnet.solana.com";
      break;
  }
  return { network, url };
}

export function getServerRpc(): Rpc {
  const { network, url } = serverRpcEndpoint();
  const key = `${network}:${url}:${process.env.NEXT_PUBLIC_SOLANA_GENESIS_HASH ?? ""}`;
  if (cached && cachedKey === key) return cached;
  cached = createNetworkVerifiedRpc(url, network);
  cachedKey = key;
  return cached;
}

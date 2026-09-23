export type Network = "mainnet" | "devnet" | "testnet" | "localnet";

/**
 * The network this build targets. `NEXT_PUBLIC_NETWORK` is authoritative; an
 * invalid value throws. When it is unset (local dev and tests only — Vercel
 * builds refuse to start without it, see next.config.ts) the network is
 * sniffed from `NEXT_PUBLIC_SOLANA_RPC_URL`, defaulting to devnet.
 */
export function detectNetwork(): Network {
  const explicit = process.env.NEXT_PUBLIC_NETWORK?.trim().toLowerCase();
  if (
    explicit === "mainnet" ||
    explicit === "devnet" ||
    explicit === "testnet" ||
    explicit === "localnet"
  ) {
    return explicit;
  }
  if (explicit) {
    throw new Error("Invalid NEXT_PUBLIC_NETWORK. Use mainnet, devnet, testnet or localnet.");
  }
  const rpc = process.env.NEXT_PUBLIC_SOLANA_RPC_URL ?? "";
  if (rpc.includes("devnet")) return "devnet";
  if (rpc.includes("testnet")) return "testnet";
  if (rpc.includes("mainnet")) return "mainnet";
  if (rpc.includes("localhost") || rpc.includes("127.0.0.1")) return "localnet";
  return "devnet";
}

/**
 * Client-side RPC URL for the CURRENT network. `NEXT_PUBLIC_SOLANA_RPC_URL`
 * always wins; otherwise the URL is derived from detectNetwork(), so setting
 * `NEXT_PUBLIC_NETWORK=mainnet` alone is enough to point the whole SPA at the
 * right cluster (public mainnet-beta RPC — rate-limited but CORRECT; the old
 * behaviour silently fell back to devnet, which is the one failure mode a
 * mainnet deployment must never have). Server-side authorization uses the
 * stricter fail-closed resolver in lib/server/rpc.ts instead.
 */
export function rpcUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SOLANA_RPC_URL;
  if (explicit) return explicit;
  switch (detectNetwork()) {
    case "mainnet":
      return "https://api.mainnet-beta.solana.com";
    case "testnet":
      return "https://api.testnet.solana.com";
    case "localnet":
      return "http://127.0.0.1:8899";
    case "devnet":
    default:
      return "https://api.devnet.solana.com";
  }
}

/** A local validator's default RPC port on a loopback host, right before the
 *  path/query/fragment/end; the capture is the scheme + host prefix. */
const LOCAL_VALIDATOR_RPC_PORT =
  /^(wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):)8899(?=[/?#]|$)/i;

/**
 * Client-side WebSocket (subscriptions) URL for the CURRENT network.
 * `NEXT_PUBLIC_SOLANA_WS_URL` wins — set it when the RPC provider serves
 * subscriptions on a different host or path than HTTP RPC. Otherwise it is
 * derived from rpcUrl() by swapping the scheme (https → wss, http → ws). A
 * local validator (solana-test-validator, surfpool) serves WebSockets on RPC
 * port + 1, so a loopback URL on the default RPC port 8899 maps to 8900 —
 * whether the RPC URL is explicit or the localnet default. Any other host or
 * port is kept as is; set NEXT_PUBLIC_SOLANA_WS_URL when it differs.
 */
export function wsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SOLANA_WS_URL?.trim();
  if (explicit) return explicit;
  return rpcUrl()
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://")
    .replace(LOCAL_VALIDATOR_RPC_PORT, (_match, prefix: string) => `${prefix}8900`);
}

/** True for every network whose tokens carry no economic value. */
export function isTestNetwork(network: Network): boolean {
  return network !== "mainnet";
}

/** Proper-noun label for UI copy: "Devnet", "Mainnet", … */
export function networkLabel(network: Network): string {
  return network.charAt(0).toUpperCase() + network.slice(1);
}

export function networkColors(network: Network): {
  bg: string;
  text: string;
  border: string;
} {
  switch (network) {
    case "mainnet":
      return {
        bg: "bg-emerald-50",
        text: "text-emerald-700",
        border: "border-emerald-200",
      };
    case "devnet":
      return {
        bg: "bg-orange-50",
        text: "text-orange-700",
        border: "border-orange-300",
      };
    case "testnet":
      return {
        bg: "bg-amber-50",
        text: "text-amber-700",
        border: "border-amber-200",
      };
    case "localnet":
      return {
        bg: "bg-slate-50",
        text: "text-slate-700",
        border: "border-slate-300",
      };
  }
}

export function explorerTxUrl(signature: string, network: Network): string {
  const cluster =
    network === "mainnet" ? "" : `?cluster=${network === "localnet" ? "custom" : network}`;
  return `https://explorer.solana.com/tx/${signature}${cluster}`;
}

export function explorerAddressUrl(address: string, network: Network): string {
  const cluster =
    network === "mainnet" ? "" : `?cluster=${network === "localnet" ? "custom" : network}`;
  return `https://explorer.solana.com/address/${address}${cluster}`;
}

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

/**
 * Client-side WebSocket (subscriptions) URL for the CURRENT network.
 * `NEXT_PUBLIC_SOLANA_WS_URL` wins — set it when the RPC provider serves
 * subscriptions on a different host or path than HTTP RPC. Otherwise it is
 * derived from rpcUrl() by swapping the scheme (https → wss, http → ws); the
 * default local validator serves WebSockets on RPC port + 1 (8900).
 */
export function wsUrl(): string {
  const explicit = process.env.NEXT_PUBLIC_SOLANA_WS_URL?.trim();
  if (explicit) return explicit;
  if (!process.env.NEXT_PUBLIC_SOLANA_RPC_URL && detectNetwork() === "localnet") {
    return "ws://127.0.0.1:8900";
  }
  return rpcUrl()
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://");
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

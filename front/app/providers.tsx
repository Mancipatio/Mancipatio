"use client";

import { autoDiscover, createClient } from "@solana/client";
import { SolanaProvider } from "@solana/react-hooks";
import type { ReactNode } from "react";
import { ToastProvider } from "@/lib/toast";
import { detectNetwork, rpcUrl } from "@/lib/network";
import { withVerifiedTransactions } from "@/lib/verified-solana-client";

// NEXT_PUBLIC_SOLANA_RPC_URL wins; otherwise derived from NEXT_PUBLIC_NETWORK
// (lib/network.ts) — never a silent devnet fallback on a mainnet deployment.
const endpoint = rpcUrl();
const websocketEndpoint = endpoint
  .replace("https://", "wss://")
  .replace("http://", "ws://");

// One Solana client for the whole app — network RPC + Wallet Standard discovery.
const solanaClient = withVerifiedTransactions(createClient({
  endpoint,
  websocketEndpoint,
  walletConnectors: autoDiscover(),
}), detectNetwork());

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SolanaProvider client={solanaClient} walletPersistence={{ autoConnect: true }}>
      <ToastProvider>{children}</ToastProvider>
    </SolanaProvider>
  );
}

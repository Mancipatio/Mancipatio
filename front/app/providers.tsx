"use client";

import { autoDiscover, createClient, type SolanaClient } from "@solana/client";
import { SolanaProvider } from "@solana/react-hooks";
import type { ReactNode } from "react";
import { ToastProvider } from "@/lib/toast";
import { detectNetwork, rpcUrl, wsUrl } from "@/lib/network";
import { withVerifiedTransactions } from "@/lib/verified-solana-client";
import { guardWalletConnectors } from "@/lib/guarded-wallet-connectors";
import { WalletSigningNotice } from "@/components/wallet-signing-notice";

// NEXT_PUBLIC_SOLANA_RPC_URL wins; otherwise derived from NEXT_PUBLIC_NETWORK
// (lib/network.ts) — never a silent devnet fallback on a mainnet deployment.
// NEXT_PUBLIC_SOLANA_WS_URL likewise wins over the scheme-swapped RPC URL.
const endpoint = rpcUrl();
const websocketEndpoint = wsUrl();

// One Solana client for the whole app — network RPC + Wallet Standard discovery.
const connectors = guardWalletConnectors(autoDiscover(), () => {
  const wallet = baseClient.store.getState().wallet;
  return wallet.status === "connected" ? wallet.session : undefined;
});
const baseClient: SolanaClient = createClient({
  endpoint,
  websocketEndpoint,
  walletConnectors: connectors,
});
const solanaClient = withVerifiedTransactions(baseClient, detectNetwork());

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SolanaProvider client={solanaClient} walletPersistence={{ autoConnect: true }}>
      <ToastProvider>
        {children}
        <WalletSigningNotice />
      </ToastProvider>
    </SolanaProvider>
  );
}

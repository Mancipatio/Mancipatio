"use client";

import { autoDiscover, createClient, type SolanaClient } from "@solana/client";
import { SolanaProvider } from "@solana/react-hooks";
import type { ReactNode } from "react";
import { ToastProvider } from "@/lib/toast";
import { detectNetwork, rpcUrl, wsUrl } from "@/lib/network";
import { withVerifiedTransactions } from "@/lib/verified-solana-client";
import { guardWalletConnectors } from "@/lib/guarded-wallet-connectors";
import { walletConnectorOverrides } from "@/lib/wallet-chain";
import { WalletSigningNotice } from "@/components/wallet-signing-notice";
import { RoleProvider } from "@/lib/auth";

// NEXT_PUBLIC_SOLANA_RPC_URL wins; otherwise derived from NEXT_PUBLIC_NETWORK
// (lib/network.ts) — never a silent devnet fallback on a mainnet deployment.
// NEXT_PUBLIC_SOLANA_WS_URL likewise wins over the scheme-swapped RPC URL.
const endpoint = rpcUrl();
const websocketEndpoint = wsUrl();

// One Solana client for the whole app — network RPC + Wallet Standard discovery.
// Wallets are told the build's chain (lib/wallet-chain), not their first one.
const connectors = guardWalletConnectors(autoDiscover({ overrides: walletConnectorOverrides(detectNetwork()) }), () => {
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
      <RoleProvider>
        <ToastProvider>
          {children}
          <WalletSigningNotice />
        </ToastProvider>
      </RoleProvider>
    </SolanaProvider>
  );
}

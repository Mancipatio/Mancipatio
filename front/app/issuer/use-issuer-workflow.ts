"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import type { AccountResponse, AccountVerification } from "@/lib/account";
import { accountFetch, useSignedInAccount } from "@/lib/account-login";
import { signedFetch, WalletSessionRequiredError } from "@/lib/siws-client";
import { detectNetwork } from "@/lib/network";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { withoutArchivedAssets } from "@/lib/archive-client";

type VerificationRead = {
  key: string; verification: AccountVerification | null; error: string | null; needsSignature: boolean; linkedWallets: string[];
};

/** Private reads are scoped to the current account/wallet; connecting alone never verifies it. */
export function useIssuerWorkflow() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const signedIn = useSignedInAccount();
  const wallet = conn.wallet?.account.address.toString() ?? null;
  const accountMode = signedIn.status === "signed_in";
  const actor = accountMode ? `account:${signedIn.account?.id}` : signedIn.status === "signed_out" && wallet ? `wallet:${wallet}` : null;
  const network = detectNetwork();
  const actorKey = actor ? `${network}:${actor}` : null;
  const [read, setRead] = useState<VerificationRead | null>(null);
  const [attempt, setAttempt] = useState<{ key: string | null; count: number }>({ key: null, count: 0 });
  const [chain, setChain] = useState<{ key: string; data: NetworkData | null; failed: boolean } | null>(null);
  const [chainRevision, setChainRevision] = useState(0);
  const chainKey = wallet ? `${network}:${wallet}` : null;
  const refresh = useCallback(async () => { setChainRevision((revision) => revision + 1); }, []);
  const refreshVerification = useCallback(() => {
    setRead(null);
    setAttempt((previous) => ({ key: actorKey, count: previous.count + 1 }));
  }, [actorKey]);

  useEffect(() => {
    if (!actorKey) return;
    let cancelled = false;
    const interactive = attempt.key === actorKey;
    const request = accountMode
      ? accountFetch<AccountResponse>("/api/account/me", "account.me")
      : signedFetch<AccountResponse>(conn.wallet, "/api/account/me", "account.me", {}, { interactive });
    void request.then((response) => {
      if (cancelled || detectNetwork() !== network) return;
      setRead({ key: actorKey, verification: response.verification ?? null, needsSignature: false,
        linkedWallets: response.profile.wallets.map((entry) => entry.wallet),
        error: response.verification ? null : "Verification status is unavailable. Please try again." });
    }).catch((error: unknown) => {
      if (cancelled || detectNetwork() !== network) return;
      const needsSignature = error instanceof WalletSessionRequiredError;
      setRead({ key: actorKey, verification: null, needsSignature, linkedWallets: [],
        error: needsSignature ? null : "Could not load your verification status. Please try again." });
    });
    return () => { cancelled = true; };
  }, [actorKey, accountMode, conn.wallet, attempt, network]);

  useEffect(() => {
    if (!chainKey) return;
    let cancelled = false;
    void loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)).then(withoutArchivedAssets).then((data) => {
      if (!cancelled && detectNetwork() === network) setChain({ key: chainKey, data, failed: false });
    }).catch(() => {
      if (!cancelled && detectNetwork() === network) setChain({ key: chainKey, data: null, failed: true });
    });
    return () => { cancelled = true; };
  }, [chainKey, chainRevision, client, network]);

  const currentRead = actorKey && read?.key === actorKey ? read : null;
  const currentChain = chainKey && chain?.key === chainKey ? chain : null;
  const data = currentChain?.data ?? null;
  const walletMatchesAccount = !accountMode || !!wallet && (currentRead?.linkedWallets.includes(wallet) ?? false);
  const me = useMemo(() => walletMatchesAccount ? data?.issuers.find((issuer) => issuer.authority.toString() === wallet) : undefined, [data, wallet, walletMatchesAccount]);
  return {
    data, me, refresh, failed: currentChain?.failed ?? false,
    verification: currentRead?.verification ?? null,
    verificationLoading: !!actorKey && !currentRead,
    verificationError: currentRead?.error ?? null,
    needsSignature: currentRead?.needsSignature ?? false,
    refreshVerification,
    signedIn: !!actorKey,
    authLoading: !conn.isReady || signedIn.status === "loading",
    accountMode,
    walletMatchesAccount,
  };
}

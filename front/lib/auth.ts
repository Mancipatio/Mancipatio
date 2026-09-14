"use client";

import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import type { Address } from "@solana/kit";
import { useEffect, useState } from "react";
import {
  fetchMaybeAdmin,
  fetchMaybePlatform,
  findAdminRecordPda,
  findPlatformPda,
} from "@/lib/generated/asset_registry";
import { getSupabase } from "@/lib/supabase";
import { detectNetwork } from "@/lib/network";
import { loadNetwork } from "@/lib/enumerate";

export type Role = "superAdmin" | "admin" | "issuer" | "public" | "disconnected";

export type RoleState = {
  loading: boolean;
  role: Role;
  walletAddress: string | null;
  isSuperAdmin: boolean;
  isAdmin: boolean;
  isIssuer: boolean;
  isVerifiedIssuer: boolean;
  platformInitialized: boolean;
  // NOTE: there is deliberately no `isKycProvider` here. The KYC provider is
  // the on-chain `KycRegistry.authority` — a separate role from the platform
  // admin that is never implied by `isSuperAdmin`/`isAdmin`. Resolving it
  // needs a getProgramAccounts scan, which must not run for every connected
  // wallet on every RequireRole mount; passport surfaces resolve it lazily
  // via `loadKycAuthorityContext` / `passportAuthorityFor` (lib/kyc-authority).
};

const INITIAL: RoleState = {
  loading: true,
  role: "disconnected",
  walletAddress: null,
  isSuperAdmin: false,
  isAdmin: false,
  isIssuer: false,
  isVerifiedIssuer: false,
  platformInitialized: false,
};

export function useRole(): RoleState {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const [state, setState] = useState<RoleState>(INITIAL);

  const isReady = conn.isReady;
  const isConnected = conn.connected;
  const walletAddress = conn.wallet?.account.address.toString() ?? null;

  useEffect(() => {
    let cancelled = false;
    async function compute() {
      if (!isReady) {
        if (!cancelled) setState(INITIAL);
        return;
      }
      if (!isConnected || !walletAddress) {
        if (!cancelled)
          setState({
            ...INITIAL,
            loading: false,
            role: "disconnected",
          });
        return;
      }
      const wallet = walletAddress as Address;
      try {
        const [platformPda] = await findPlatformPda();
        const platform = await fetchMaybePlatform(
          client.runtime.rpc,
          platformPda,
        );
        const platformInitialized = platform.exists;

        const isSuperAdmin =
          platform.exists && platform.data.admin.toString() === walletAddress;

        let isAdmin = false;
        if (platformInitialized) {
          const [adminPda] = await findAdminRecordPda({ authority: wallet });
          const admin = await fetchMaybeAdmin(client.runtime.rpc, adminPda);
          isAdmin = admin.exists;
        }

        // Issuer detection via Supabase indexer — match any row whose
        // `authority` equals the connected wallet. Verified status is
        // kybStatus == 1.
        let isIssuer = false;
        let isVerifiedIssuer = false;
        let indexerOk = false;
        const sb = getSupabase();
        if (sb) {
          try {
            const { data, error } = await sb
              .from("issuers")
              .select("kyb_status")
              .eq("network", detectNetwork())
              .eq("authority", walletAddress)
              .limit(1);
            if (!error) {
              indexerOk = true;
              if (data && data.length > 0) {
                isIssuer = true;
                isVerifiedIssuer = data[0].kyb_status === 1;
              }
            }
          } catch {
            // Indexer unreachable — fall back to chain below.
          }
        }

        // On-chain fallback when the indexer was UNREACHABLE (errored/threw):
        // a verified on-chain issuer must not lose their role just because the
        // indexer is down. We deliberately do NOT scan on a successful "no row"
        // (that would make every public user pay a full getProgramAccounts scan
        // on each role check); a dropped register_issuer event is mitigated by
        // the webhook's retry-on-failure path instead.
        if (!indexerOk && !isIssuer) {
          try {
            const net = await loadNetwork(client.runtime.rpc);
            const mine = net.issuers.find(
              (i) => i.authority.toString() === walletAddress,
            );
            if (mine) {
              isIssuer = true;
              isVerifiedIssuer = mine.kybStatus === 1;
            }
          } catch {
            // Chain unreachable too — leave as not-an-issuer.
          }
        }

        const role: Role = isSuperAdmin
          ? "superAdmin"
          : isAdmin
            ? "admin"
            : isIssuer
              ? "issuer"
              : "public";

        if (!cancelled)
          setState({
            loading: false,
            role,
            walletAddress,
            isSuperAdmin,
            isAdmin: isSuperAdmin || isAdmin,
            isIssuer,
            isVerifiedIssuer,
            platformInitialized,
          });
      } catch {
        if (!cancelled)
          setState({
            ...INITIAL,
            loading: false,
            walletAddress,
            role: "public",
          });
      }
    }
    void compute();
    return () => {
      cancelled = true;
    };
  }, [isReady, isConnected, walletAddress, client]);

  return state;
}

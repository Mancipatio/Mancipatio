"use client";

// The connected wallet's roles, for every gate, menu and page (Talas 3.1).
//
// One RoleProvider (app/providers.tsx) reads the roles through the shared,
// generation-guarded cache of lib/role-store and the pure reads/derivation of
// lib/role-resolution — see there for what each role means and where it is
// read from. useRole() only reads the provider's context.
//
// The UI gate is a hint: builders re-read authoritative state and the program
// enforces every rule. The UI reads at `confirmed`, server gates at
// `finalized`, so right after a rotation the server may still answer 403 for
// a few seconds.

import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import type { Address } from "@solana/kit";
import { usePathname } from "next/navigation";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getSupabase } from "@/lib/supabase";
import { detectNetwork, type Network } from "@/lib/network";
import { loadNetwork } from "@/lib/enumerate";
import { createNetworkVerifier } from "@/lib/network-identity";
import { configuredKycRegistry } from "@/lib/kyc-registry-pin";
import { readRoleSnapshot, type Rpc } from "@/lib/role-resolution";
import { roleStore, type RoleReadResult, type RoleStoreView } from "@/lib/role-store";
import {
  deriveView,
  roleKeyFor,
  toRoleState,
  type DerivedRoles,
  type RoleState,
  type RoleStateInput,
} from "@/lib/role-state";

export { invalidateRoles } from "@/lib/role-store";
export type { Capability } from "@/lib/role-resolution";

export type { Role, RoleState } from "@/lib/role-state";

// ── Reading ─────────────────────────────────────────────────────────────────

// One network verifier per rpc (5 min cache). Created lazily: an invalid
// network setup (e.g. localnet without its genesis hash) fails the role read
// instead of the whole provider.
const verifiers = new WeakMap<object, () => Promise<void>>();
function verifierFor(rpc: Rpc, network: Network): () => Promise<void> {
  let verify = verifiers.get(rpc as object);
  if (!verify) {
    verify = createNetworkVerifier(rpc, network, { cacheMs: 300_000 });
    verifiers.set(rpc as object, verify);
  }
  return verify;
}

/** The deployment pin, or the reason it is unusable (fail closed for KYC only). */
function pinState(): { pinned: Address | null; error: string | null } {
  try {
    return { pinned: configuredKycRegistry(), error: null };
  } catch (err) {
    return { pinned: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Issuer detection via the Supabase indexer — any row whose `authority` is
 * the wallet; verified = kyb_status 1. When the indexer is UNREACHABLE the
 * chain is scanned instead, so a verified issuer does not lose the role while
 * the indexer is down. A successful "no row" never scans (that would make
 * every public user pay a getProgramAccounts scan).
 */
async function detectIssuer(
  rpc: Rpc,
  wallet: string,
  network: Network,
): Promise<{ isIssuer: boolean; isVerifiedIssuer: boolean }> {
  const sb = getSupabase();
  if (sb) {
    try {
      const { data, error } = await sb
        .from("issuers")
        .select("kyb_status")
        .eq("network", network)
        .eq("authority", wallet)
        .limit(1);
      if (!error) {
        return data && data.length > 0
          ? { isIssuer: true, isVerifiedIssuer: data[0].kyb_status === 1 }
          : { isIssuer: false, isVerifiedIssuer: false };
      }
    } catch {
      // Indexer unreachable — fall back to the chain below.
    }
  }
  try {
    const net = await loadNetwork(rpc);
    const mine = net.issuers.find((i) => i.authority.toString() === wallet);
    return mine
      ? { isIssuer: true, isVerifiedIssuer: mine.kybStatus === 1 }
      : { isIssuer: false, isVerifiedIssuer: false };
  } catch {
    // Chain unreachable too — not an issuer (the platform roles still resolve).
    return { isIssuer: false, isVerifiedIssuer: false };
  }
}

async function readRoles(
  rpc: Rpc,
  wallet: string,
  network: Network,
  withKyc: boolean,
): Promise<RoleReadResult> {
  const pin = pinState();
  const [snapshot, issuer] = await Promise.all([
    readRoleSnapshot(rpc, wallet as Address, {
      pinned: pin.pinned,
      withKycScan: withKyc && pin.error === null,
      commitment: "confirmed",
      verifyNetwork: () => verifierFor(rpc, network)(),
      network,
    }),
    detectIssuer(rpc, wallet, network),
  ]);
  if (pin.error) {
    return {
      ...issuer,
      snapshot: { ...snapshot, kycRegistry: null, kycTransfer: null, kycResolved: true, kycUnavailable: pin.error },
    };
  }
  return { ...issuer, snapshot };
}

// ── Provider ────────────────────────────────────────────────────────────────

type RoleContextValue = RoleStateInput & {
  /** Registers a consumer that needs the KYC-provider role; returns its release. */
  demandKyc: () => () => void;
};

const RoleContext = createContext<RoleContextValue | null>(null);

const IDLE_VIEW: RoleStoreView<RoleReadResult> = Object.freeze({ status: "idle" as const });

export function RoleProvider({ children }: { children: ReactNode }) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const pathname = usePathname();
  const network = detectNetwork();
  const rpc = client.runtime.rpc;

  const isReady = conn.isReady;
  const wallet = conn.connected ? (conn.wallet?.account.address.toString() ?? null) : null;
  const key = roleKeyFor(isReady, wallet, network);

  const [kycDemand, setKycDemand] = useState(0);
  // Pinned builds read the registry in the same batch at no extra cost, so
  // every read includes it; unpinned builds scan only while a consumer asks.
  const wantKyc = kycDemand > 0 || pinState().pinned !== null;

  const view = useSyncExternalStore(
    roleStore.subscribe,
    () => (key ? roleStore.getView(key) : IDLE_VIEW),
    () => IDLE_VIEW,
  );
  const generation = useSyncExternalStore(
    roleStore.subscribe,
    roleStore.getGeneration,
    () => 0,
  );

  const read = useCallback(
    (withKyc: boolean) => readRoles(rpc, wallet ?? "", network, withKyc),
    [rpc, wallet, network],
  );

  // (Re)request on a wallet switch, a KYC demand change, an invalidation, and
  // on navigation (reused within the 30 s TTL, so at most one read per TTL).
  useEffect(() => {
    if (!key) return;
    void roleStore.request(key, wantKyc, read);
  }, [key, wantKyc, read, generation, pathname]);

  const refresh = useCallback(() => {
    if (!key) return;
    void roleStore.request(key, wantKyc, read, { force: true });
  }, [key, wantKyc, read]);

  const demandKyc = useCallback(() => {
    setKycDemand((n) => n + 1);
    return () => setKycDemand((n) => n - 1);
  }, []);

  const derived = useMemo<DerivedRoles | null>(() => deriveView(view, wallet), [view, wallet]);

  const value = useMemo<RoleContextValue>(
    () => ({ isReady, wallet, view, derived, demandKyc, refresh }),
    [isReady, wallet, view, derived, demandKyc, refresh],
  );
  return createElement(RoleContext.Provider, { value }, children);
}

// ── Consumer ────────────────────────────────────────────────────────────────

/**
 * The connected wallet's roles. Pass `{ kyc: true }` where the KYC-provider
 * role matters (admin gate, KYC and client pages, the account menu while
 * open): on an unpinned build only those consumers trigger the registry scan.
 */
export function useRole(opts: { kyc?: boolean } = {}): RoleState {
  const ctx = useContext(RoleContext);
  const needKyc = opts.kyc === true;
  const demandKyc = ctx?.demandKyc;
  useEffect(() => {
    if (!needKyc || !demandKyc) return;
    return demandKyc();
  }, [needKyc, demandKyc]);
  return useMemo(() => toRoleState(ctx, needKyc), [ctx, needKyc]);
}

"use client";

// The D1 proceeds freeze for a page's own badge (v1.0.0-rc): whether the
// issuer behind an issuer PDA or a share class is frozen, read at
// `confirmed` from ["issuer_freeze", issuer]. null until read, or when it
// cannot be read (fail open: the send path reads the gate accounts again
// before the wallet opens, lib/proceeds-gate.ts, and the program decides).
import { useSolanaClient } from "@solana/react-hooks";
import { useCallback, useEffect, useState } from "react";
import { fetchEncodedAccounts, type Address } from "@solana/kit";
import { findIssuerFreezePda } from "@/lib/pdas";
import { resolveIssuerChain } from "@/lib/issuer-authority";

type Rpc = Parameters<typeof resolveIssuerChain>[0];

/** issuer → frozen, for every issuer given (one getMultipleAccounts). */
export async function readIssuerFreezes(rpc: Rpc, issuers: readonly Address[]): Promise<Map<Address, boolean>> {
  const unique = [...new Set(issuers)];
  const out = new Map<Address, boolean>();
  if (unique.length === 0) return out;
  const pdas = await Promise.all(unique.map((issuer) => findIssuerFreezePda(issuer)));
  const accounts = await fetchEncodedAccounts(rpc as unknown as Parameters<typeof fetchEncodedAccounts>[0], pdas, {
    commitment: "confirmed",
    abortSignal: AbortSignal.timeout(10_000),
  });
  unique.forEach((issuer, i) => out.set(issuer, accounts[i].exists));
  return out;
}

/**
 * Frozen issuers among `issuers` (PDAs), or among the issuers of
 * `shareClasses` (resolved share class → asset → issuer). `frozen` is null
 * until read; `issuerOf` maps each share class to its issuer once resolved.
 */
export function useIssuerFreezes(input: { issuers?: readonly (Address | null | undefined)[]; shareClasses?: readonly (Address | null | undefined)[] }) {
  const client = useSolanaClient();
  const rpc = client.runtime.rpc;
  const issuersKey = (input.issuers ?? []).filter(Boolean).join(",");
  const classesKey = (input.shareClasses ?? []).filter(Boolean).join(",");
  const [state, setState] = useState<{ frozen: Map<string, boolean> | null; issuerOf: Map<string, string> }>({ frozen: null, issuerOf: new Map() });
  const refresh = useCallback(async () => {
    try {
      const issuerOf = new Map<string, string>();
      for (const shareClass of classesKey ? classesKey.split(",") : []) {
        issuerOf.set(shareClass, (await resolveIssuerChain(rpc, shareClass as Address)).issuer);
      }
      const issuers = [...(issuersKey ? issuersKey.split(",") : []), ...issuerOf.values()] as Address[];
      const frozen = await readIssuerFreezes(rpc, issuers);
      setState({ frozen: new Map([...frozen].map(([k, v]) => [String(k), v])), issuerOf });
    } catch {
      setState({ frozen: null, issuerOf: new Map() });
    }
  }, [rpc, issuersKey, classesKey]);
  useEffect(() => {
    // Read the chain after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  /** true / false once read; null while unknown. */
  const isFrozen = useCallback(
    (key: { issuer?: string | null; shareClass?: string | null }): boolean | null => {
      if (!state.frozen) return null;
      const issuer = key.issuer ?? (key.shareClass ? state.issuerOf.get(key.shareClass) : undefined);
      return issuer ? state.frozen.get(issuer) ?? null : null;
    },
    [state],
  );
  return { isFrozen, refresh, anyFrozen: state.frozen ? [...state.frozen.values()].some(Boolean) : false };
}

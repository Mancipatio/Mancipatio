"use client";

import { useEffect, useState } from "react";
import { createNoopSigner, type Address } from "@solana/kit";
import { useSolanaClient } from "@solana/react-hooks";
import { requireProgramUpgradeAuthority } from "@/lib/program-bootstrap";

export type UpgradeAuthorityStatus =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "ok" }
  | { status: "mismatch"; message: string };

/**
 * Whether `wallet` is `program`'s upgrade authority, read from its
 * ProgramData at `finalized` (the check the bootstrap builders repeat at
 * send time). Idle when disabled or without a wallet.
 */
export function useUpgradeAuthorityStatus(
  program: Address,
  wallet: string | null,
  enabled: boolean,
): UpgradeAuthorityStatus {
  const client = useSolanaClient();
  const key = enabled && wallet ? `${program}|${wallet}` : null;
  const [result, setResult] = useState<{ key: string; ok: boolean; message: string } | null>(null);
  useEffect(() => {
    if (!key || !wallet) return;
    let live = true;
    requireProgramUpgradeAuthority(client.runtime.rpc, program, createNoopSigner(wallet as Address))
      .then(() => {
        if (live) setResult({ key, ok: true, message: "" });
      })
      .catch((err: unknown) => {
        if (live) setResult({ key, ok: false, message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      live = false;
    };
  }, [client, key, program, wallet]);
  if (!key) return { status: "idle" };
  if (!result || result.key !== key) return { status: "checking" };
  return result.ok ? { status: "ok" } : { status: "mismatch", message: result.message };
}

export function UpgradeAuthorityNote({ state }: { state: UpgradeAuthorityStatus }) {
  if (state.status === "checking") {
    return <p className="mt-1 text-xs text-slate-500">Checking the program&apos;s upgrade authority…</p>;
  }
  if (state.status === "ok") {
    return <p className="mt-1 text-xs text-emerald-700">The connected wallet is this program&apos;s upgrade authority.</p>;
  }
  if (state.status === "mismatch") return <p className="mt-1 text-xs text-red-700">{state.message}</p>;
  return null;
}

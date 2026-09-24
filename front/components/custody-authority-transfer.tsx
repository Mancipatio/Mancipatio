"use client";
import { invalidateRoles } from "@/lib/role-store";
import { useCallback, useEffect, useState } from "react";
import { type Address, isAddress } from "@solana/kit";
import {
  useSolanaClient,
  useSendTransaction,
  useWalletConnection,
} from "@solana/react-hooks";
import {
  loadCustodyAuthority,
  buildCustodyAuthorityChange,
  isCustodyRotatable,
  type CustodyAuthorityState,
} from "@/lib/custody-authority";
import { VaultState } from "@/lib/generated/asset_registry";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
export function CustodyAuthorityTransfer({
  vaultPda,
  onRefresh,
}: {
  vaultPda: Address;
  onRefresh: () => Promise<void>;
}) {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    tx = useSendTransaction(),
    toast = useToast();
  const [state, setState] = useState<CustodyAuthorityState | null>(null),
    [error, setError] = useState<string | null>(null),
    [next, setNext] = useState("");
  const refresh = useCallback(async () => {
    try {
      setState(await loadCustodyAuthority(client.runtime.rpc, vaultPda));
      setError(null);
    } catch (error) {
      setState(null);
      setError(
        error instanceof Error
          ? error.message
          : "Custody authority unavailable",
      );
    }
  }, [client, vaultPda]);
  useEffect(() => {
    // Synchronize the live authority proposal after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  async function submit(action: "propose" | "accept", target?: string) {
    if (!conn.wallet) return;
    try {
      const signer = walletSigner(conn.wallet),
        ix = await buildCustodyAuthorityChange(
          client.runtime.rpc,
          vaultPda,
          signer,
          action,
          (target ?? next).trim(),
        );
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(sig, {
        title:
          action === "propose"
            ? "Custody operator proposed"
            : "Custody operator accepted",
      });
      invalidateRoles();
      await refresh();
      await onRefresh();
    } catch (error) {
      toast.showError(
        "Custody operator change pending",
        error instanceof Error ? error.message : undefined,
      );
    }
  }
  const wallet = conn.wallet?.account.address;
  const rotatable = state ? isCustodyRotatable(state.vaultState) : false;
  const isSuperAdmin = !!state && wallet === state.superAdmin;
  return (
    <section className="mt-4 rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm">
      <h3 className="font-semibold text-brand-900">
        Transfer custody responsibility
      </h3>
      <p className="mt-1 text-xs text-slate-600">
        The Super Admin proposes an active Admin. That wallet signs acceptance
        (on this page or at /account/roles) before custody responsibility
        changes.
      </p>
      {error && <p className="mt-2 text-amber-800">{error}</p>}
      {state && !rotatable && (
        <p className="mt-2 text-xs text-slate-600">
          The vault is {VaultState[state.vaultState] ?? "closed"}: custody
          responsibility can move only while it is Active or Triggered.
        </p>
      )}
      {state?.proposed && (
        <p className="mt-2 break-all font-mono text-xs">
          Proposed: {state.proposed}
          {state.stale && (
            <span className="ml-1 font-sans text-amber-800">
              (stale: the vault operator or the Super Admin changed after it
              was proposed, so it can no longer be accepted)
            </span>
          )}
        </p>
      )}
      {state && rotatable && isSuperAdmin && (
        <div className="mt-3 flex flex-wrap gap-2">
          <input
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="Replacement Admin wallet"
            className="min-w-64 flex-1 rounded-lg border border-brand-200 px-3 py-2 text-xs"
          />
          <button
            type="button"
            disabled={
              tx.isSending ||
              !isAddress(next.trim()) ||
              next.trim() === state.current
            }
            onClick={() => void submit("propose")}
            className="rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
          >
            {state.proposed ? "Replace proposal" : "Propose operator"}
          </button>
          {state.stale && state.proposed && state.proposed !== state.current && (
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => void submit("propose", state.proposed ?? "")}
              className="rounded-lg border border-brand-300 bg-white px-3 py-2 text-xs font-semibold text-brand-800 disabled:opacity-50"
            >
              Re-propose {short(state.proposed)}
            </button>
          )}
        </div>
      )}
      {state && rotatable && !state.stale && state.proposed === wallet && (
        <button
          type="button"
          disabled={tx.isSending}
          onClick={() => void submit("accept")}
          className="mt-3 rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          Accept custody responsibility
        </button>
      )}
      {state?.stale && state.proposed === wallet && !isSuperAdmin && (
        <p className="mt-2 text-xs text-amber-800">
          This proposal is stale. Ask the Super Admin to propose this wallet
          again.
        </p>
      )}
      <button
        type="button"
        onClick={() => void refresh()}
        className="mt-3 block text-xs text-brand-800 underline"
      >
        Refresh authority
      </button>
    </section>
  );
}

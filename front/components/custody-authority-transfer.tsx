"use client";
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
} from "@/lib/custody-authority";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
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
  const [state, setState] = useState<Awaited<
      ReturnType<typeof loadCustodyAuthority>
    > | null>(null),
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
  async function submit(action: "propose" | "accept") {
    if (!conn.wallet) return;
    try {
      const signer = walletSigner(conn.wallet),
        ix = await buildCustodyAuthorityChange(
          client.runtime.rpc,
          vaultPda,
          signer,
          action,
          next.trim(),
        );
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(sig, {
        title:
          action === "propose"
            ? "Custody operator proposed"
            : "Custody operator accepted",
      });
      await refresh();
      await onRefresh();
    } catch (error) {
      toast.showError(
        "Custody operator change pending",
        error instanceof Error ? error.message : undefined,
      );
    }
  }
  return (
    <section className="mt-4 rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm">
      <h3 className="font-semibold text-brand-900">
        Transfer custody responsibility
      </h3>
      <p className="mt-1 text-xs text-slate-600">
        The Super Admin proposes an active Admin. That wallet signs acceptance
        before custody responsibility changes.
      </p>
      {error && <p className="mt-2 text-amber-800">{error}</p>}
      {state?.proposed && (
        <p className="mt-2 break-all font-mono text-xs">
          Proposed: {state.proposed}
        </p>
      )}
      {state && conn.wallet?.account.address === state.superAdmin && (
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
            Propose operator
          </button>
        </div>
      )}
      {state?.proposed === conn.wallet?.account.address && (
        <button
          type="button"
          disabled={tx.isSending}
          onClick={() => void submit("accept")}
          className="mt-3 rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
        >
          Accept custody responsibility
        </button>
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

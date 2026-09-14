"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { isAddress } from "@solana/kit";
import {
  useSolanaClient,
  useWalletConnection,
  useSendTransaction,
} from "@solana/react-hooks";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { ConfirmModal } from "@/components/confirm-modal";
import {
  loadOperationalAuthority,
  buildProposeOperationalAuthority,
  buildAcceptOperationalAuthority,
  type OperationalAuthorityKind,
  type OperationalAuthorityState,
} from "@/lib/operational-authority";
export function AuthorityRotation({
  kind,
}: {
  kind: OperationalAuthorityKind;
}) {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    tx = useSendTransaction(),
    toast = useToast(),
    wallet = conn.wallet?.account.address;
  const [state, setState] = useState<OperationalAuthorityState | null>(null),
    [error, setError] = useState<string | null>(null),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState<"propose" | "accept" | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await loadOperationalAuthority(client.runtime.rpc, kind));
      setError(null);
    } catch {
      setError(
        "Could not read the current authority and proposal. Retry after RPC recovery.",
      );
    }
  }, [client, kind]);
  useEffect(() => {
    // Load external finalized chain state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  async function submit() {
    if (!conn.wallet || !confirm) return;
    try {
      const signer = walletSigner(conn.wallet);
      const ix =
        confirm === "propose"
          ? await buildProposeOperationalAuthority(
              client.runtime.rpc,
              kind,
              signer,
              next.trim(),
            )
          : await buildAcceptOperationalAuthority(
              client.runtime.rpc,
              kind,
              signer,
            );
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(sig, {
        title:
          confirm === "propose"
            ? "Authority proposal submitted"
            : "Authority acceptance submitted",
      });
      setConfirm(null);
      setNext("");
      void refresh();
    } catch (error) {
      toast.showError(
        "Authority change not completed",
        error instanceof Error ? error.message : undefined,
      );
    }
  }
  const label = kind === "platform" ? "Super Admin" : "blocklist authority";
  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <h2 className="text-base font-semibold text-slate-900">Change {label}</h2>
      <p className="mt-2 text-xs text-slate-600">
        The current authority proposes a replacement. The replacement wallet
        accepts in a separate transaction. Program upgrade authority is
        unchanged.
      </p>
      {error ? (
        <p className="mt-2 text-xs text-amber-800">{error}</p>
      ) : state ? (
        <>
          <p className="mt-3 break-all font-mono text-xs text-slate-700">
            Current: {state.current}
          </p>
          {state.proposed && (
            <p className="mt-1 break-all font-mono text-xs text-brand-800">
              Proposed: {state.proposed}
            </p>
          )}
          {wallet === state.current && (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="Replacement wallet address"
                className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
              />
              <button
                type="button"
                disabled={
                  tx.isSending ||
                  !isAddress(next.trim()) ||
                  next.trim() === state.current
                }
                onClick={() => setConfirm("propose")}
                className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-800 disabled:opacity-50"
              >
                {state.proposed ? "Replace proposal" : "Propose replacement"}
              </button>
            </div>
          )}
          {wallet === state.proposed && (
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => setConfirm("accept")}
              className="mt-3 rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white"
            >
              Accept authority
            </button>
          )}
          {state.proposed && wallet !== state.proposed && (
            <p className="mt-2 text-xs text-slate-500">
              Connect the proposed wallet at{" "}
              <Link href="/issuer/authority" className="underline">
                Authority setup and acceptance
              </Link>{" "}
              after the proposal is finalized. This page is available before
              that wallet has an Admin role.
            </p>
          )}
        </>
      ) : (
        <p className="mt-3 text-xs text-slate-500">
          Initialize this authority before proposing a replacement.
        </p>
      )}
      <button
        type="button"
        onClick={() => void refresh()}
        className="mt-3 text-xs text-slate-500 underline"
      >
        Refresh authority
      </button>
      <ConfirmModal
        open={confirm !== null}
        title={
          confirm === "accept"
            ? `Accept ${label} responsibility?`
            : `Propose a new ${label}?`
        }
        description={
          confirm === "accept"
            ? `The connected wallet becomes ${label}. ${kind === "platform" ? "The former Super Admin's Admin record is closed; issuer-specific or custody roles must be reviewed separately." : "Only the new wallet can manage the blocklist after acceptance."}`
            : `Propose ${next.trim()}. The current authority remains active until that wallet accepts.`
        }
        kind="warning"
        confirmLabel={
          confirm === "accept" ? "Accept authority" : "Create proposal"
        }
        requireReason={false}
        busy={tx.isSending}
        onConfirm={() => void submit()}
        onClose={() => setConfirm(null)}
      />
    </section>
  );
}

"use client";
import { useCallback, useEffect, useState } from "react";
import {
  useSolanaClient,
  useWalletConnection,
  useSendTransaction,
} from "@solana/react-hooks";
import {
  fetchMaybeBlocklistAuthority,
  findBlocklistAuthorityPda,
} from "@/lib/generated/transfer_hook";
import { buildInitializeBlocklistAuthorityInstruction } from "@/lib/program-bootstrap";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
export function BlocklistBootstrap() {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    tx = useSendTransaction(),
    toast = useToast();
  const [authority, setAuthority] = useState<string | null | undefined>(
      undefined,
    ),
    [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [pda] = await findBlocklistAuthorityPda();
      const result = await fetchMaybeBlocklistAuthority(
        client.runtime.rpc,
        pda,
        { commitment: "finalized" },
      );
      setAuthority(result.exists ? result.data.authority : null);
      setError(null);
    } catch {
      setError(
        "Could not verify the hook's operational authority. Retry after RPC recovery.",
      );
    }
  }, [client]);
  useEffect(() => {
    // Fetch and display live finalized authority after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  async function initialize() {
    if (!conn.wallet) return;
    try {
      const signer = walletSigner(conn.wallet);
      const ix = await buildInitializeBlocklistAuthorityInstruction(
        client.runtime.rpc,
        { payer: signer, upgradeAuthority: signer, authority: signer.address },
      );
      const signature = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(signature, {
        title: "Blocklist authority initialization submitted",
      });
      void refresh();
    } catch (error) {
      toast.showError("Initialization unavailable", explainSendError(error));
    }
  }
  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <h2 className="text-lg font-semibold text-slate-900">
        Transfer compliance authority
      </h2>
      {error ? (
        <p className="mt-2 text-sm text-amber-800">{error}</p>
      ) : authority === undefined ? (
        <p className="mt-2 text-sm text-slate-500">Checking authority…</p>
      ) : authority ? (
        <p className="mt-2 break-all font-mono text-xs text-slate-600">
          {authority}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-slate-600">
            The hook’s operational blocklist authority has not been initialized.
            Its deployed program upgrade-authority wallet must authorize setup.
            This sets the connected wallet as blocklist authority; program
            upgrade authority is unchanged.
          </p>
          <button
            type="button"
            disabled={tx.isSending || !conn.wallet}
            onClick={() => void initialize()}
            className="mt-4 rounded-lg border border-brand-200 bg-brand-50 px-4 py-2 text-sm font-medium text-brand-800 disabled:opacity-50"
          >
            Initialize blocklist authority
          </button>
        </>
      )}
      <button
        type="button"
        onClick={() => void refresh()}
        className="mt-3 block text-xs text-slate-500 underline"
      >
        Refresh authority
      </button>
    </section>
  );
}

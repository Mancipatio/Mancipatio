"use client";

// Lock supply (lock_supply) behind a destructive confirmation — moved from
// /admin/share-classes so the issuer's tokenize checklist uses the same code.
// One-way: once locked, mint_to_treasury fails for good (unless the class is
// mintable post-launch, which the tokenize flow never sets).

import { useState } from "react";
import { type Address } from "@solana/kit";
import { createWalletTransactionSigner } from "@solana/client";
import { useSendTransaction, useWalletConnection } from "@solana/react-hooks";
import { getLockSupplyInstructionAsync } from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";

export function LockSupplyButton({
  scPda,
  onRefresh,
  disabled = false,
  label = "Lock supply",
}: {
  scPda: Address | null;
  onRefresh: () => Promise<void>;
  disabled?: boolean;
  label?: string;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [confirmLock, setConfirmLock] = useState(false);

  async function lockSupply(reason: string) {
    if (!wallet || !conn.wallet || !scPda) return;
    const pendingId = toast.showPending("Locking supply…", reason);
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getLockSupplyInstructionAsync({
        authority: signer,
        shareClass: scPda,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Supply locked permanently" });
      void recordAudit({
        ix_name: "lock_supply",
        category: "share-class",
        actor_wallet: wallet.toString(),
        reason,
        target_label: scPda.toString(),
        tx_signature: sig,
      });
      setConfirmLock(false);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = explainSendError(err);
      toast.showError("Failed to lock supply", message);
      void recordAudit({
        ix_name: "lock_supply",
        category: "share-class",
        actor_wallet: wallet.toString(),
        reason,
        target_label: scPda.toString(),
        status: "failed",
        metadata: { error: message },
      });
    }
  }

  return (
    <>
      <button
        type="button"
        disabled={tx.isSending || disabled || !scPda}
        onClick={() => setConfirmLock(true)}
        className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
      >
        {label}
      </button>
      <ConfirmModal
        open={confirmLock}
        onClose={() => setConfirmLock(false)}
        onConfirm={(reason) => lockSupply(reason)}
        title="Lock supply permanently"
        kind="destructive"
        confirmLabel="Lock supply"
        description={
          <>
            <p>
              Locking the supply is <strong>one-way</strong> — once locked, no
              further{" "}
              <code className="rounded bg-slate-100 px-1">
                mint_to_treasury
              </code>{" "}
              calls will succeed, even by Super Admin.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />
    </>
  );
}

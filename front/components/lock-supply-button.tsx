"use client";

// Lock supply (lock_supply) behind a destructive confirmation — moved from
// /admin/share-classes so the issuer's tokenize checklist uses the same code.
// One-way: once locked, mint_to_treasury fails for good (unless the class is
// mintable post-launch, which the tokenize flow never sets). Before anything
// was distributed (`requireZeroConfirm`) the lock fixes the supply at 0, so
// the modal asks for an explicit tick first.

import { useState } from "react";
import { type Address } from "@solana/kit";
import { createWalletTransactionSigner } from "@solana/client";
import { useSendTransaction, useWalletConnection } from "@solana/react-hooks";
import { getLockSupplyInstructionAsync } from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";

/**
 * lock_supply on one class, signed by the connected wallet (an Admin record
 * holder: lock_supply.rs). The app's sender runs the simulation gate first
 * (lib/verified-solana-client), so a lock that would fail never reaches the
 * wallet. Returns the signature, or null after a toast explained the failure.
 * Shared by LockSupplyButton and the archive dialog's "lock at 0" (A2).
 */
export function useLockSupply() {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  async function lock(scPda: Address, reason: string, opts: { atZero?: boolean; context?: string } = {}): Promise<string | null> {
    if (!wallet || !conn.wallet) return null;
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
        metadata: opts.atZero || opts.context ? { ...(opts.atZero ? { locked_at_zero: true } : {}), ...(opts.context ? { context: opts.context } : {}) } : undefined,
      });
      return sig;
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
        metadata: { error: message, ...(opts.context ? { context: opts.context } : {}) },
      });
      return null;
    }
  }

  return { lock, busy: tx.isSending, ready: !!wallet && !!conn.wallet };
}

export function LockSupplyButton({
  scPda,
  onRefresh,
  disabled = false,
  label = "Lock supply",
  requireZeroConfirm = false,
}: {
  scPda: Address | null;
  onRefresh: () => Promise<void>;
  disabled?: boolean;
  label?: string;
  /** Nothing was created yet: the lock fixes the supply at 0, confirmed with a tick. */
  requireZeroConfirm?: boolean;
}) {
  const { lock, busy } = useLockSupply();
  const [confirmLock, setConfirmLock] = useState(false);
  const [zeroConfirmed, setZeroConfirmed] = useState(false);

  async function lockSupply(reason: string) {
    if (!scPda) return;
    if (requireZeroConfirm && !zeroConfirmed) return;
    const sig = await lock(scPda, reason, { atZero: requireZeroConfirm });
    if (!sig) return;
    setConfirmLock(false);
    await onRefresh();
  }

  return (
    <>
      <button
        type="button"
        disabled={busy || disabled || !scPda}
        onClick={() => {
          setZeroConfirmed(false);
          setConfirmLock(true);
        }}
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
            {requireZeroConfirm && (
              <label className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-900">
                <input
                  type="checkbox"
                  checked={zeroConfirmed}
                  onChange={(e) => setZeroConfirmed(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Lock at 0: nothing was distributed yet, so no token of this class can ever be created or sold.
                </span>
              </label>
            )}
            <p className="mt-2 text-xs text-slate-500">
              Reason will be recorded in the audit log.
            </p>
          </>
        }
        confirmDisabled={requireZeroConfirm && !zeroConfirmed}
        busy={busy}
      />
    </>
  );
}

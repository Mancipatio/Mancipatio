"use client";

// A pending recovery of the Super Admin or the blocklist-authority key by the
// program upgrade authority (D4): who gets the role, when, that the role is
// frozen for rotation meanwhile, and who can cancel (with a Cancel button for
// the current holder or the proposer).
import { useCallback, useEffect, useState } from "react";
import { address } from "@solana/kit";
import { useSolanaClient, useWalletConnection, useSendTransaction } from "@solana/react-hooks";
import {
  buildCancelRoleRecovery,
  describeRoleRecovery,
  loadRoleRecovery,
  type RecoveryKind,
  type RoleRecoveryState,
} from "@/lib/role-recovery";
import { describeProposalWindow } from "@/lib/proposal-window";
import { useChainClock } from "@/lib/use-chain-clock";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { ConfirmModal } from "@/components/confirm-modal";

const KINDS: readonly RecoveryKind[] = ["platform", "blocklist"];

export function RoleRecoveryNotice() {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const now = useChainClock();
  const [states, setStates] = useState<Partial<Record<RecoveryKind, RoleRecoveryState | null>>>({});
  const [cancel, setCancel] = useState<RecoveryKind | null>(null);

  const refresh = useCallback(async () => {
    const next: Partial<Record<RecoveryKind, RoleRecoveryState | null>> = {};
    for (const kind of KINDS) {
      try {
        next[kind] = await loadRoleRecovery(client.runtime.rpc, kind);
      } catch {
        next[kind] = null; // Best effort: the program still refuses a blocked rotation.
      }
    }
    setStates(next);
  }, [client]);

  useEffect(() => {
    // Read the finalized recovery state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const wallet = conn.wallet ? address(conn.wallet.account.address) : null;

  async function runCancel(kind: RecoveryKind, reason: string) {
    if (!conn.wallet) return;
    try {
      const signer = walletSigner(conn.wallet);
      const ix = await buildCancelRoleRecovery(client.runtime.rpc, kind, signer);
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      void recordAudit({
        ix_name: kind === "platform" ? "cancel_platform_recovery" : "cancel_blocklist_recovery",
        category: "platform",
        actor_wallet: signer.address,
        reason,
        tx_signature: sig,
      });
      toast.showTx(sig, { title: "Recovery cancelled" });
      setCancel(null);
      void refresh();
    } catch (err) {
      toast.showError("Could not cancel the recovery", explainSendError(err));
    }
  }

  const notices = KINDS.map((kind) => ({
    kind,
    notice: describeRoleRecovery(states[kind] ?? null, wallet, Number(now)),
  })).filter((n) => n.notice !== null);
  if (notices.length === 0) return null;

  return (
    <>
      {notices.map(({ kind, notice }) =>
        notice ? (
          <section key={kind} className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950">
            <h2 className="font-semibold">{notice.title}</h2>
            <p className="mt-1 break-all text-xs">
              Recovered key: <span className="font-mono">{notice.newKey}</span>
              {notice.isNewKey && " (this wallet: execute it under Pending roles once the window opens)"}
            </p>
            <p className="mt-1 text-xs">{describeProposalWindow(notice.window)}</p>
            <p className="mt-2 text-xs font-medium">{notice.blocked}</p>
            <p className="mt-1 break-all text-xs">{notice.cancelers}</p>
            {notice.canCancel && (
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() => setCancel(kind)}
                className="mt-3 rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-950 disabled:opacity-50"
              >
                Cancel the recovery
              </button>
            )}
          </section>
        ) : null,
      )}
      <ConfirmModal
        open={cancel !== null}
        onClose={() => setCancel(null)}
        onConfirm={(reason) => (cancel ? runCancel(cancel, reason) : undefined)}
        title="Cancel this recovery?"
        description="The staged recovery is closed and the role stays with its current key. Cancel only if the current key is not lost."
        confirmLabel="Cancel the recovery"
        kind="warning"
        requireReason
        busy={tx.isSending}
      />
    </>
  );
}

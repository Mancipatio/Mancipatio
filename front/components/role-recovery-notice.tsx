"use client";

// A pending recovery of the Super Admin or the blocklist-authority key by the
// program upgrade authority (D4): who gets the role, when, that the role is
// frozen for rotation meanwhile, and who can cancel (with a Cancel button for
// the current holder or the proposer). Rendered on /account/roles and on
// /admin/platform (where the alarm and the admin badge lead). A state that
// cannot be read is SAID (with a retry), never hidden: inside the 7-day
// window a missing notice is a security problem.
import { useCallback, useEffect, useRef, useState } from "react";
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
import { startFinalityPoll } from "@/lib/finality-poll";

const KINDS: readonly RecoveryKind[] = ["platform", "blocklist"];
const ROLE: Record<RecoveryKind, string> = { platform: "Super Admin", blocklist: "blocklist authority" };

/** What a read failure says instead of hiding the section. */
export const RECOVERY_READ_ERROR = (kind: RecoveryKind) =>
  `Could not read whether a recovery of the ${ROLE[kind]} key is pending (RPC error). A pending recovery may exist: retry before relying on this page.`;

export function RoleRecoveryNotice() {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const now = useChainClock();
  const [states, setStates] = useState<Partial<Record<RecoveryKind, RoleRecoveryState | null>>>({});
  const [failed, setFailed] = useState<RecoveryKind[]>([]);
  const [cancel, setCancel] = useState<RecoveryKind | null>(null);
  /** The kind whose cancel was sent and is not finalized yet (its button stays off). */
  const [settling, setSettling] = useState<RecoveryKind | null>(null);
  const stopPoll = useRef<(() => void) | null>(null);

  /** Resolves the fresh states (null for a kind that could not be read). */
  const refresh = useCallback(async () => {
    const next: Partial<Record<RecoveryKind, RoleRecoveryState | null>> = {};
    const errors: RecoveryKind[] = [];
    for (const kind of KINDS) {
      try {
        next[kind] = await loadRoleRecovery(client.runtime.rpc, kind);
      } catch {
        next[kind] = null;
        errors.push(kind);
      }
    }
    setStates(next);
    setFailed(errors);
    return next;
  }, [client]);

  useEffect(() => {
    // Read the finalized recovery state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    return () => stopPoll.current?.();
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
      // The state is read at finalized (~15–30 s behind the confirmed send):
      // keep the button off and re-read until the recovery is gone.
      setSettling(kind);
      stopPoll.current?.();
      stopPoll.current = startFinalityPoll(
        async () => {
          const next = await refresh();
          const gone = !next[kind]?.recovery;
          if (gone) setSettling(null);
          return gone;
        },
        { onGiveUp: () => setSettling(null) },
      );
    } catch (err) {
      toast.showError("Could not cancel the recovery", explainSendError(err));
    }
  }

  const notices = KINDS.map((kind) => ({
    kind,
    notice: describeRoleRecovery(states[kind] ?? null, wallet, Number(now)),
  })).filter((n) => n.notice !== null);
  if (notices.length === 0 && failed.length === 0) return null;

  return (
    <>
      {failed.map((kind) => (
        <section key={`error-${kind}`} role="alert" className="mt-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <p className="text-xs">{RECOVERY_READ_ERROR(kind)}</p>
          <button type="button" onClick={() => void refresh()} className="mt-2 text-xs font-semibold underline">
            Retry
          </button>
        </section>
      ))}
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
                disabled={tx.isSending || settling === kind}
                onClick={() => setCancel(kind)}
                className="mt-3 rounded-lg border border-amber-400 bg-white px-3 py-2 text-xs font-semibold text-amber-950 disabled:opacity-50"
              >
                {settling === kind ? "Cancelling… (waiting for finality)" : "Cancel the recovery"}
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

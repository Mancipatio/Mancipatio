"use client";

import { type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useState } from "react";
import { ConfirmModal } from "@/components/confirm-modal";
import { fetchMaybePlatform, findPlatformPda } from "@/lib/generated/asset_registry";
import {
  buildCancelIssuerRecovery,
  describeRecoveryState,
  fetchIssuerRecovery,
  formatCountdown,
  formatUtc,
  issuerAuthorityActions,
  issuerRecoveryState,
  type IssuerRecoveryRecord,
} from "@/lib/issuer-authority";
import { features } from "@/lib/features";
import { recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { useChainAlignedClock } from "@/lib/use-chain-aligned-clock";
import { walletSigner } from "@/lib/wallet-signer";

const ENABLED = features().issuerRotation;

/**
 * Issuer-facing notice of a pending timelocked recovery of THIS issuer's key.
 * The 7-day window only protects an issuer who sees it: the banner shows the
 * proposed wallet, a live chain-time countdown and, for the current authority
 * (or the super admin), a Cancel button. Renders nothing when no recovery is
 * pending or the feature is off.
 */
export function IssuerRecoveryBanner({
  issuer,
  issuerAuthority,
  onChanged,
}: {
  issuer: Address;
  issuerAuthority: Address;
  onChanged?: () => void | Promise<void>;
}) {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const { now } = useChainAlignedClock(client.runtime.rpc);
  const wallet = conn.wallet?.account.address?.toString() ?? null;
  const [recovery, setRecovery] = useState<IssuerRecoveryRecord | null>(null);
  const [platformAdmin, setPlatformAdmin] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);

  const load = useCallback(async () => {
    if (!ENABLED) return;
    try {
      const [platformPda] = await findPlatformPda();
      const [record, platform] = await Promise.all([
        fetchIssuerRecovery(client.runtime.rpc, issuer),
        fetchMaybePlatform(client.runtime.rpc, platformPda),
      ]);
      setRecovery(record);
      setPlatformAdmin(platform.exists ? platform.data.admin.toString() : null);
    } catch {
      // Optional notice: a failed read leaves it hidden (the admin panel and
      // /issuer/rotation read the same account).
    }
  }, [client, issuer]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (!ENABLED || !recovery || now === null) return null;
  const state = issuerRecoveryState(
    recovery,
    { address: issuer.toString(), authority: issuerAuthority.toString() },
    platformAdmin,
    now,
  );
  if (state.kind === "none") return null;
  const can = issuerAuthorityActions(wallet, {
    issuerAuthority: issuerAuthority.toString(),
    platformAdmin,
    transfer: { kind: "none" },
    recovery: state,
  });
  const urgent = state.kind === "waiting" || state.kind === "executable";

  async function cancel(reason: string) {
    if (!conn.wallet || !recovery || !wallet) return;
    const pendingId = toast.showPending("Cancelling the issuer recovery…", reason);
    try {
      const signer = walletSigner(conn.wallet);
      const ix = await buildCancelIssuerRecovery({
        cancellerSigner: signer,
        issuer,
        proposer: recovery.proposedBy as Address,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Issuer recovery cancelled" });
      void recordAudit({
        ix_name: "cancel_issuer_recovery",
        category: "issuers",
        actor_wallet: wallet,
        reason,
        target_label: issuer.toString(),
        tx_signature: typeof sig === "string" ? sig : undefined,
        status: "success",
        metadata: { new_authority: recovery.newAuthority, proposed_by: recovery.proposedBy },
      });
      setConfirm(false);
      await load();
      await onChanged?.();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Cancel failed", explainSendError(err));
    }
  }

  return (
    <div
      role="alert"
      className={`mt-6 rounded-lg border px-4 py-3 text-sm ${
        urgent ? "border-red-300 bg-red-50 text-red-900" : "border-amber-200 bg-amber-50 text-amber-900"
      }`}
    >
      <p className="font-semibold">
        {urgent ? "A recovery of this issuer's key is pending" : "A stale issuer recovery is on record"}
      </p>
      <p className="mt-1 text-xs">
        The Super Admin proposed moving this issuer&apos;s authority to{" "}
        <code className="break-all font-mono">{state.newAuthority}</code>.{" "}
        {describeRecoveryState(state)}
      </p>
      {state.kind === "waiting" && (
        <p className="mt-1 text-xs">
          Countdown: <strong className="font-mono">{formatCountdown(state.remaining)}</strong> · expires{" "}
          {formatUtc(state.expiresAt)}. If you still hold this key and did not ask for a recovery, cancel it now
          and contact Manci.
        </p>
      )}
      {can.canCancelRecovery && (
        <button
          type="button"
          disabled={tx.isSending}
          onClick={() => setConfirm(true)}
          className="mt-2 rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-800 disabled:opacity-50"
        >
          Cancel recovery
        </button>
      )}
      <ConfirmModal
        open={confirm}
        busy={tx.isSending}
        onClose={() => setConfirm(false)}
        onConfirm={(reason) => cancel(reason)}
        title="Cancel the issuer recovery?"
        kind="warning"
        confirmLabel="Cancel recovery"
        description={
          <p>
            The recovery to <span className="break-all font-mono">{state.newAuthority}</span> is withdrawn. The
            issuer key stays with the current authority. The rent returns to the Super Admin who proposed it.
          </p>
        }
      />
    </div>
  );
}

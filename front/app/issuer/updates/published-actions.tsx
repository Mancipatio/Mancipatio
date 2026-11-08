"use client";

// What the issuer can still do with a published update on /issuer/updates:
//   - anchor it on chain once: a Memo v2 transaction its wallet signs, with
//     the exact text the server computed ("manci-update:<id> sha256:<digest
//     of the published record>", lib/issuer-updates.ts); the server re-reads
//     the finalized transaction before it records it. A transaction sent but
//     not recorded yet is kept in this browser and can be recorded later;
//   - withdraw it with a reason (the record of it stays; readers no longer
//     see it).
// Anchoring is offered only while issuance is on (KYC-only mode pauses it);
// the withdrawal always.

import { useState } from "react";
import type { WalletSession } from "@solana/client";
import { useSendTransaction, useSolanaClient } from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { documentAnchorInstruction, documentAnchorMemoText, MEMO_PROGRAM_ADDRESS } from "@/lib/document-anchor";
import { ISSUER_UPDATE_LIMITS, type IssuerUpdateRecord } from "@/lib/issuer-updates";
import {
  anchorIssuerUpdate,
  clearPendingUpdateAnchor,
  readPendingUpdateAnchor,
  recordIssuerUpdateAnchor,
  withdrawIssuerUpdate,
} from "@/lib/issuer-updates-client";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { waitForSignature } from "@/lib/simulation-gate";
import { explainSendError } from "@/lib/tx-error";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function PublishedActions({ session, wallet, record, canAnchor, onChanged }: {
  session: WalletSession;
  wallet: string;
  record: IssuerUpdateRecord;
  /** Issuance is on: a new anchor may be sent. */
  canAnchor: boolean;
  onChanged: (record: IssuerUpdateRecord) => void;
}) {
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const [network] = useState(() => detectNetwork());
  const [pending, setPending] = useState(() => readPendingUpdateAnchor(network, record.id));
  const [confirm, setConfirm] = useState<null | "anchor" | "withdraw">(null);
  const [busy, setBusy] = useState<null | "anchor" | "record" | "withdraw">(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (record.status !== "published") return null;
  const anchor = record.anchor;
  const memo = anchor ? documentAnchorMemoText(anchor) : null;

  async function sendAnchor() {
    if (!anchor || busy) return;
    setBusy("anchor");
    setProblem(null);
    try {
      const next = await anchorIssuerUpdate(session, { network, signer: wallet, id: record.id }, {
        send: (track) => {
          // The same tracked signer as memo signer and fee payer.
          const signer = track(walletSigner(session));
          return tx.send({ instructions: [documentAnchorInstruction({ ...anchor, signer })], feePayer: signer });
        },
        wait: (signature) => waitForSignature(client.runtime.rpc, signature, { timeoutMs: 60_000 }),
      });
      setConfirm(null);
      setPending(null);
      onChanged(next);
      if (next.anchor_tx) toast.showTx(next.anchor_tx, { title: "Update anchored on chain" });
    } catch (err) {
      setConfirm(null);
      setPending(readPendingUpdateAnchor(network, record.id));
      setProblem(explainSendError(err) || message(err));
    } finally {
      setBusy(null);
    }
  }

  async function recordPending() {
    if (!pending || busy) return;
    setBusy("record");
    setProblem(null);
    try {
      const next = await recordIssuerUpdateAnchor(session, record.id, pending.signature);
      clearPendingUpdateAnchor(network, record.id);
      setPending(null);
      onChanged(next);
    } catch (err) {
      setProblem(message(err));
    } finally {
      setBusy(null);
    }
  }

  async function withdraw(reason: string) {
    if (busy) return;
    setBusy("withdraw");
    try {
      const next = await withdrawIssuerUpdate(session, record.id, reason);
      setConfirm(null);
      onChanged(next);
      toast.show({ kind: "success", title: "Update withdrawn", description: "Readers no longer see it." });
    } catch (err) {
      setConfirm(null);
      setProblem(message(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      {pending && !record.anchor_tx && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          An anchor transaction was sent from this browser and is not recorded yet:{" "}
          <a href={explorerTxUrl(pending.signature, network)} target="_blank" rel="noopener noreferrer" className="font-mono underline">
            {pending.signature.slice(0, 10)}…
          </a>
          . Record it before sending another.
          <div className="mt-2 flex gap-3">
            <button type="button" onClick={() => void recordPending()} disabled={busy !== null} className="font-medium underline disabled:opacity-50">
              {busy === "record" ? "Recording…" : "Record it"}
            </button>
            <button type="button" onClick={() => { clearPendingUpdateAnchor(network, record.id); setPending(null); }} disabled={busy !== null}
              className="underline disabled:opacity-50" title="Only when the explorer does not show this transaction">
              Forget it
            </button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {anchor && canAnchor && !pending && (
          <button type="button" onClick={() => setConfirm("anchor")} disabled={busy !== null} className="btn-ghost disabled:opacity-50">
            {busy === "anchor" ? "Anchoring…" : "Anchor on chain"}
          </button>
        )}
        <button type="button" onClick={() => setConfirm("withdraw")} disabled={busy !== null} className="btn-ghost text-red-700 disabled:opacity-50">
          Withdraw
        </button>
      </div>
      {problem && <p role="alert" className="mt-2 text-xs text-red-600">{problem}</p>}

      <ConfirmModal
        open={confirm === "anchor" && !!memo}
        onClose={() => setConfirm(null)}
        onConfirm={() => sendAnchor()}
        title="Anchor this update on chain"
        kind="info"
        requireReason={false}
        confirmLabel="Sign and send"
        busy={busy === "anchor"}
        description={
          <div className="space-y-2">
            <p>
              Your issuer wallet signs one Solana transaction with this memo and pays its network fee. The digest covers the published
              text and every document&apos;s SHA-256, so anyone can later check what was published and when.
            </p>
            <code className="block break-all rounded bg-slate-50 px-2 py-1.5 font-mono text-[11px] text-slate-800">{memo}</code>
            <p className="text-xs text-slate-500">Program: Memo v2 ({MEMO_PROGRAM_ADDRESS.slice(0, 8)}…). The memo is public and permanent.</p>
          </div>
        }
      />
      <ConfirmModal
        open={confirm === "withdraw"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => withdraw(reason)}
        title="Withdraw this update"
        requireReason
        reasonMinLength={ISSUER_UPDATE_LIMITS.withdrawReasonMin}
        reasonPlaceholder="Why is it withdrawn? Kept with the update."
        confirmLabel="Withdraw"
        busy={busy === "withdraw"}
        busyLabel="Withdrawing…"
        description="Readers will no longer see the update or open its documents. The update, its documents and your reason stay on record; a withdrawal cannot be undone."
      />
    </div>
  );
}

"use client";

// Freeze / unfreeze the proceeds of ONE issuer (D1, v1.0.0-rc). Any live
// Admin (or the Super Admin) freezes; only the Super Admin lifts it. The
// reason text goes to the audit log; the chain keeps its SHA-256 only.
import { useCallback, useEffect, useState } from "react";
import { type Address } from "@solana/kit";
import { useSolanaClient, useWalletConnection, useSendTransaction } from "@solana/react-hooks";
import {
  FROZEN_PATHS,
  NOT_FROZEN_PATHS,
  buildFreezeIssuerProceeds,
  buildUnfreezeIssuerProceeds,
  describeIssuerFreeze,
  freezeActionGate,
  hashHex,
  isEmptyReasonHash,
  loadIssuerFreeze,
  reasonMatchesHash,
  type IssuerFreezeState,
} from "@/lib/issuer-freeze";
import { walletSigner } from "@/lib/wallet-signer";
import { useRole } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { ConfirmModal } from "@/components/confirm-modal";

export function IssuerFreezePanel({ issuer, label }: { issuer: Address; label: string }) {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const { isAdmin, isSuperAdmin } = useRole();

  // undefined = loading, null = not frozen.
  const [freeze, setFreeze] = useState<IssuerFreezeState | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"freeze" | "unfreeze" | null>(null);
  const [check, setCheck] = useState("");
  const [checkResult, setCheckResult] = useState<boolean | null>(null);

  const refresh = useCallback(async () => {
    try {
      setFreeze(await loadIssuerFreeze(client.runtime.rpc, issuer));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not read the freeze state");
    }
  }, [client, issuer]);

  useEffect(() => {
    // Read the finalized freeze state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const gate = freezeActionGate({ isAdmin, isSuperAdmin }, freeze === undefined ? null : freeze !== null);

  async function run(kind: "freeze" | "unfreeze", reason: string) {
    if (!conn.wallet) return;
    const pendingId = toast.showPending(kind === "freeze" ? "Freezing the proceeds…" : "Lifting the freeze…");
    try {
      const signer = walletSigner(conn.wallet);
      const instruction =
        kind === "freeze"
          ? (await buildFreezeIssuerProceeds(client.runtime.rpc, signer, issuer, reason)).instruction
          : await buildUnfreezeIssuerProceeds(client.runtime.rpc, signer, issuer);
      const sig = await tx.send({ instructions: [instruction], feePayer: signer });
      void recordAudit({
        ix_name: kind === "freeze" ? "freeze_issuer_proceeds" : "unfreeze_issuer_proceeds",
        category: "issuers",
        actor_wallet: signer.address,
        target_label: `${label} · ${issuer}`,
        reason,
        tx_signature: sig,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: kind === "freeze" ? "Proceeds freeze submitted" : "Unfreeze submitted" });
      setConfirm(null);
      void refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(kind === "freeze" ? "Freeze failed" : "Unfreeze failed", explainSendError(err));
    }
  }

  async function verifyReason() {
    if (!freeze) return;
    setCheckResult(await reasonMatchesHash(check, freeze.reasonHash));
  }

  return (
    <section
      className={`mt-5 rounded-lg border p-4 ${
        freeze ? "border-red-200 bg-red-50/60" : "border-slate-200 bg-white"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-slate-900">Proceeds freeze</h3>
        <span
          className={`rounded-full border px-2 py-0.5 text-xs font-semibold ${
            freeze === undefined
              ? "border-slate-200 bg-slate-50 text-slate-600"
              : freeze
                ? "border-red-200 bg-red-100 text-red-800"
                : "border-emerald-200 bg-emerald-50 text-emerald-800"
          }`}
        >
          {freeze === undefined ? "Reading…" : freeze ? "Proceeds frozen" : "Not frozen"}
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-xs text-slate-600">
        A freeze stops money from reaching this issuer: {FROZEN_PATHS.join("; ")}. It does not stop{" "}
        {NOT_FROZEN_PATHS.join("; ")}. Any Admin can freeze; only the Super Admin can lift it.
      </p>

      {error && <p className="mt-2 text-xs text-amber-800">{error}</p>}

      {freeze && (
        <div className="mt-3 space-y-1 text-xs text-slate-800">
          <p>{describeIssuerFreeze(freeze)}</p>
          <p className="break-all">
            Reason:{" "}
            {isEmptyReasonHash(freeze.reasonHash) ? (
              <span className="text-slate-600">none recorded (empty hash)</span>
            ) : (
              <>
                SHA-256 <span className="font-mono">{hashHex(freeze.reasonHash)}</span>{" "}
                <span className="text-slate-600">(the text is in the audit log)</span>
              </>
            )}
          </p>
          {!isEmptyReasonHash(freeze.reasonHash) && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <input
                value={check}
                onChange={(e) => {
                  setCheck(e.target.value);
                  setCheckResult(null);
                }}
                placeholder="Paste a reason to check it against the hash"
                className="w-80 max-w-full rounded-md border border-slate-300 bg-white px-2 py-1 text-xs"
              />
              <button
                type="button"
                disabled={!check.trim()}
                onClick={() => void verifyReason()}
                className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs disabled:opacity-50"
              >
                Check
              </button>
              {checkResult !== null && (
                <span className={checkResult ? "text-emerald-700" : "text-red-700"}>
                  {checkResult ? "Matches the recorded reason" : "Does not match"}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {!freeze && (
          <button
            type="button"
            disabled={!conn.wallet || tx.isSending || gate.freeze !== null}
            title={gate.freeze ?? undefined}
            onClick={() => setConfirm("freeze")}
            className="rounded-lg bg-red-700 px-3 py-2 text-xs font-semibold text-white hover:bg-red-800 disabled:opacity-50"
          >
            Freeze proceeds
          </button>
        )}
        {freeze && (
          <button
            type="button"
            disabled={!conn.wallet || tx.isSending || gate.unfreeze !== null}
            title={gate.unfreeze ?? undefined}
            onClick={() => setConfirm("unfreeze")}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-xs font-semibold text-slate-900 disabled:opacity-50"
          >
            Unfreeze
          </button>
        )}
        <button type="button" onClick={() => void refresh()} className="text-xs text-slate-500 underline">
          Refresh
        </button>
      </div>
      {!freeze && gate.freeze && freeze !== undefined && <p className="mt-2 text-xs text-slate-500">{gate.freeze}</p>}
      {freeze && gate.unfreeze && <p className="mt-2 text-xs text-slate-500">{gate.unfreeze}</p>}

      <ConfirmModal
        open={confirm === "freeze"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => void run("freeze", reason)}
        title={`Freeze the proceeds of ${label}?`}
        description="Sales, withdrawals and founder payouts of this issuer stop until the Super Admin lifts the freeze. The reason's SHA-256 is recorded on chain and the text in the audit log. Your wallet pays the account rent and gets it back on unfreeze."
        confirmLabel="Freeze proceeds"
        kind="destructive"
        requireReason
        reasonMinLength={10}
        reasonPlaceholder="Why (case reference, finding)…"
        busy={tx.isSending}
      />
      <ConfirmModal
        open={confirm === "unfreeze"}
        onClose={() => setConfirm(null)}
        onConfirm={(reason) => void run("unfreeze", reason)}
        title={`Lift the proceeds freeze of ${label}?`}
        description="Sales, withdrawals and founder payouts of this issuer resume immediately. The rent returns to the wallet that froze it."
        confirmLabel="Unfreeze"
        kind="warning"
        requireReason
        reasonPlaceholder="Why the freeze can be lifted…"
        busy={tx.isSending}
      />
    </section>
  );
}

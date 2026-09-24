"use client";

import { WalletRequired } from "@/components/wallet-required";

import { type Address } from "@solana/kit";
import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useState } from "react";
import {
  fetchMaybeAdmin,
  findSuperAdminRecordPda,
  getAddAdminInstructionAsync,
  getRemoveAdminInstructionAsync,
  type Admin,
} from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { recordAudit } from "@/lib/supabase";
import { invalidateRoles } from "@/lib/role-store";
import { useRole } from "@/lib/auth";
import { explainSendError } from "@/lib/tx-error";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { useToast } from "@/lib/toast";

const CARD = "rounded-xl border border-slate-200 bg-white shadow-card p-6";
const BTN =
  "rounded-lg border border-slate-300/60 px-4 py-2 text-sm font-medium text-slate-900 transition-colors hover:border-slate-400 hover:text-slate-900 disabled:opacity-50";
const BTN2 =
  "rounded-lg border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:border-slate-500 disabled:opacity-50";
const INPUT =
  "w-full rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400";

export default function AdminsPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const wallet = conn.wallet?.account.address;
  // add_admin / remove_admin require the Super Admin on-chain (K17, OD12):
  // other Admins see the forms but cannot submit them.
  const { isSuperAdmin } = useRole();
  const superAdminOnly = isSuperAdmin ? undefined : "Super Admin only: the program rejects this from any other wallet";

  const [grantAddr, setGrantAddr] = useState("");
  const [revokeAddr, setRevokeAddr] = useState("");
  const [checkAddr, setCheckAddr] = useState("");
  const [checked, setChecked] = useState<Admin | null | undefined>(undefined);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmGrant, setConfirmGrant] = useState(false);
  const toast = useToast();

  async function grant(reason: string) {
    if (!isSuperAdmin || !wallet || !conn.wallet || !grantAddr.trim()) return;
    const target = grantAddr.trim();
    // add_admin creates the Admin record with `init`: an existing admin makes
    // the transaction fail with an opaque wrapper error, so check first.
    try {
      const [existingPda] = await findSuperAdminRecordPda({ admin: target as Address });
      const existing = await fetchMaybeAdmin(client.runtime.rpc, existingPda);
      if (existing.exists) {
        toast.showError("Already an admin", `${target.slice(0, 6)}…${target.slice(-4)} already has an admin record — nothing to grant.`);
        setConfirmGrant(false);
        return;
      }
    } catch {
      // Lookup failure: fall through; the transaction still enforces the rule.
    }
    const pendingId = toast.showPending(
      `Granting admin ${target.slice(0, 6)}…`,
      reason,
    );
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getAddAdminInstructionAsync({
        superAdmin: signer,
        newAdmin: target as Address,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Admin granted" });
      void recordAudit({
        ix_name: "add_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
      });
      setConfirmGrant(false);
      setGrantAddr("");
      invalidateRoles();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to grant admin", explainSendError(err));
      const message = err instanceof Error ? err.message : String(err);
      void recordAudit({
        ix_name: "add_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { error: message },
      });
    }
  }

  async function revoke(reason: string) {
    if (!isSuperAdmin || !wallet || !conn.wallet || !revokeAddr.trim()) return;
    const target = revokeAddr.trim();
    const pendingId = toast.showPending(
      `Revoking admin ${target.slice(0, 6)}…`,
      reason,
    );
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await getRemoveAdminInstructionAsync({
        superAdmin: signer,
        admin: target as Address,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Admin revoked" });
      void recordAudit({
        ix_name: "remove_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
      });
      setConfirmRevoke(false);
      setRevokeAddr("");
      invalidateRoles();
    } catch (err) {
      toast.dismiss(pendingId);
      const message = err instanceof Error ? err.message : String(err);
      toast.showError("Failed to revoke admin", message);
      void recordAudit({
        ix_name: "remove_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { error: message },
      });
    }
  }

  async function check() {
    if (!checkAddr.trim()) return;
    const [pda] = await findSuperAdminRecordPda({
      admin: checkAddr.trim() as Address,
    });
    const maybe = await fetchMaybeAdmin(client.runtime.rpc, pda);
    setChecked(maybe.exists ? maybe.data : null);
  }

  return (
    <section className="min-w-0 flex-1">
      <h1 className="text-2xl font-semibold">Admins</h1>
      <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
        The super admin grants and revokes the admin role — admins operate
        issuance and custody. The blocklist is changed only by the blocklist
        authority, a separate key.
      </p>

      {!conn.isReady ? (
        <p className="mt-8 text-slate-500">Loading wallet…</p>
      ) : !wallet ? (
        <WalletRequired className="mt-8" />
      ) : (
        <div className="mt-8 space-y-6">
          <div className={CARD}>
            <h2 className="text-lg font-semibold text-slate-900">
              Grant admin role
            </h2>
            <p className="mt-1 text-sm text-slate-500">Super admin only.</p>
            <div className="mt-4 flex gap-2">
              <input
                className={INPUT}
                value={grantAddr}
                placeholder="Wallet address"
                onChange={(e) => setGrantAddr(e.target.value)}
              />
              <button
                type="button"
                disabled={!isSuperAdmin || tx.isSending || !grantAddr.trim()}
                title={superAdminOnly}
                onClick={() => setConfirmGrant(true)}
                className={`shrink-0 ${BTN}`}
              >
                Grant
              </button>
            </div>
          </div>

          <div className={CARD}>
            <h2 className="text-lg font-semibold text-slate-900">
              Revoke admin role
            </h2>
            <p className="mt-1 text-sm text-slate-500">Super admin only.</p>
            <div className="mt-4 flex gap-2">
              <input
                className={INPUT}
                value={revokeAddr}
                placeholder="Admin wallet address"
                onChange={(e) => setRevokeAddr(e.target.value)}
              />
              <button
                type="button"
                disabled={!isSuperAdmin || tx.isSending || !revokeAddr.trim()}
                title={superAdminOnly}
                onClick={() => setConfirmRevoke(true)}
                className={`shrink-0 ${BTN2}`}
              >
                Revoke
              </button>
            </div>
          </div>

          <div className={CARD}>
            <h2 className="text-lg font-semibold text-slate-900">
              Check a wallet
            </h2>
            <div className="mt-4 flex gap-2">
              <input
                className={INPUT}
                value={checkAddr}
                placeholder="Wallet address"
                onChange={(e) => setCheckAddr(e.target.value)}
              />
              <button
                type="button"
                disabled={!checkAddr.trim()}
                onClick={() => void check()}
                className={`shrink-0 ${BTN2}`}
              >
                Check
              </button>
            </div>
            {checked === null && (
              <p className="mt-3 text-sm text-slate-600">
                Not an admin.
              </p>
            )}
            {checked != null && (
              <p className="mt-3 text-sm text-emerald-600">
                Admin — granted by{" "}
                <span className="font-mono break-all">
                  {checked.addedBy.toString()}
                </span>
              </p>
            )}
          </div>
        </div>
      )}

      {tx.signature && (
        <p className="mt-4 text-sm text-emerald-600">
          ✓ Sent —{" "}
          <a
            className="underline"
            href={explorerTxUrl(tx.signature, detectNetwork())}
            target="_blank"
            rel="noreferrer"
          >
            view on explorer
          </a>
        </p>
      )}
      {tx.error != null && (
        <p className="mt-4 break-words text-sm text-red-600">
          {tx.error instanceof Error ? tx.error.message : String(tx.error)}
        </p>
      )}
      <ConfirmModal
        open={confirmGrant}
        onClose={() => setConfirmGrant(false)}
        onConfirm={(reason) => grant(reason)}
        title="Grant admin role"
        kind="info"
        confirmLabel="Grant"
        description={
          <>
            <p>You are about to grant admin permissions to:</p>
            <p className="mt-2 break-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">
              {grantAddr.trim()}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              They will gain access to issuance and custody (the blocklist
              stays with the blocklist authority). Reason will be recorded in
              the audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />
      <ConfirmModal
        open={confirmRevoke}
        onClose={() => setConfirmRevoke(false)}
        onConfirm={(reason) => revoke(reason)}
        title="Revoke admin role"
        kind="destructive"
        confirmLabel="Revoke"
        description={
          <>
            <p>
              You are about to revoke admin permissions from:
            </p>
            <p className="mt-2 break-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">
              {revokeAddr.trim()}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              They will lose access to all operational instructions. Reason
              will be recorded in the audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />
    </section>
  );
}

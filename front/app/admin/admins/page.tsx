"use client";

import Link from "next/link";

import { WalletRequired } from "@/components/wallet-required";

import { type Address } from "@solana/kit";
import { createWalletTransactionSigner } from "@solana/client";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useState } from "react";
import {
  fetchMaybeAdmin,
  findSuperAdminRecordPda,
  getRemoveAdminInstructionAsync,
  type Admin,
} from "@/lib/generated/asset_registry";
import {
  buildCancelAdminProposal,
  buildProposeAdmin,
  listPendingAdmins,
  type PendingAdminRecord,
} from "@/lib/admin-grants";
import { describeProposalWindow, proposalWindowState } from "@/lib/proposal-window";
import { useChainClock } from "@/lib/use-chain-clock";
import { ACCOUNT_ROLES_PATH } from "@/components/require-role";
import { ConfirmModal } from "@/components/confirm-modal";
import { recordAudit } from "@/lib/supabase";
import { invalidateRoles } from "@/lib/role-store";
import { notifyAdminBadges } from "@/lib/admin-badges-events";
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
  // propose_admin / remove_admin require the Super Admin on-chain (K17,
  // OD12): other Admins see the forms but cannot submit them. Any Admin (and
  // the program upgrade authority) may cancel a staged grant.
  const { isSuperAdmin, isAdmin } = useRole();
  const superAdminOnly = isSuperAdmin ? undefined : "Super Admin only: the program rejects this from any other wallet";

  const [grantAddr, setGrantAddr] = useState("");
  const [revokeAddr, setRevokeAddr] = useState("");
  const [checkAddr, setCheckAddr] = useState("");
  const [checked, setChecked] = useState<Admin | null | undefined>(undefined);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmGrant, setConfirmGrant] = useState(false);
  const [pendingGrants, setPendingGrants] = useState<PendingAdminRecord[] | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState<PendingAdminRecord | null>(null);
  const toast = useToast();
  const now = useChainClock();

  const loadPending = useCallback(async () => {
    try {
      setPendingGrants(await listPendingAdmins(client.runtime.rpc));
      setPendingError(null);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [client]);
  useEffect(() => {
    // Load the staged grants after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPending();
  }, [loadPending]);

  /**
   * Step 1 of a grant (D3): propose_admin. The proposed key then takes the
   * role itself (add_admin) at /account/roles after 48 hours, within 14 days.
   */
  async function grant(reason: string) {
    if (!isSuperAdmin || !wallet || !conn.wallet || !grantAddr.trim()) return;
    const target = grantAddr.trim();
    const pendingId = toast.showPending(
      `Proposing admin ${target.slice(0, 6)}…`,
      reason,
    );
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      // Re-reads the Super Admin and refuses a wallet that is already an Admin.
      const ix = await buildProposeAdmin(client.runtime.rpc, signer, target as Address);
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Admin grant proposed" });
      void recordAudit({
        ix_name: "propose_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
      });
      setConfirmGrant(false);
      setGrantAddr("");
      void loadPending();
      // The menu counts grants in their review window (0079 mirror).
      notifyAdminBadges({ afterIndexer: true });
    } catch (err) {
      toast.dismiss(pendingId);
      const explained = explainSendError(err);
      toast.showError("Failed to propose admin", explained);
      const message = err instanceof Error ? err.message : String(err);
      void recordAudit({
        ix_name: "propose_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { error: message, explained },
      });
    }
  }

  async function cancelGrant(p: PendingAdminRecord, reason: string) {
    if (!wallet || !conn.wallet) return;
    const target = p.newAdmin.toString();
    try {
      const { signer } = createWalletTransactionSigner(conn.wallet);
      const ix = await buildCancelAdminProposal(client.runtime.rpc, signer, p.newAdmin);
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(sig, { title: "Admin grant cancelled" });
      void recordAudit({
        ix_name: "cancel_admin_proposal",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        tx_signature: sig,
      });
      setConfirmCancel(null);
      void loadPending();
      notifyAdminBadges({ afterIndexer: true });
    } catch (err) {
      const explained = explainSendError(err);
      toast.showError("Failed to cancel the grant", explained);
      void recordAudit({
        ix_name: "cancel_admin_proposal",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { error: explained },
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
      const explained = explainSendError(err);
      const message = err instanceof Error ? err.message : String(err);
      toast.showError("Failed to revoke admin", explained);
      void recordAudit({
        ix_name: "remove_admin",
        category: "admins",
        actor_wallet: wallet.toString(),
        reason,
        target_label: target,
        status: "failed",
        metadata: { error: message, explained },
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
        The super admin proposes and revokes the admin role — admins operate
        issuance and custody. A grant waits 48 hours (waived while the
        bootstrap window is open): the proposed wallet then takes the role
        itself within 14 days, and any admin or the program upgrade authority
        can cancel it meanwhile (the upgrade authority through the CLI /
        Squads export). A revoke is immediate. The blocklist is
        changed only by the blocklist authority, a separate key.
      </p>

      {!conn.isReady ? (
        <p className="mt-8 text-slate-500">Loading wallet…</p>
      ) : !wallet ? (
        <WalletRequired className="mt-8" />
      ) : (
        <div className="mt-8 space-y-6">
          <div className={CARD}>
            <h2 className="text-lg font-semibold text-slate-900">
              Propose admin role
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Super admin only. The proposed wallet accepts at{" "}
              <a className="underline" href={ACCOUNT_ROLES_PATH}>
                {ACCOUNT_ROLES_PATH}
              </a>{" "}
              once the waiting period ends.
            </p>
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
                Propose
              </button>
            </div>
          </div>

          <div className={CARD}>
            <h2 className="text-lg font-semibold text-slate-900">
              Pending admin grants
            </h2>
            {pendingError ? (
              <p className="mt-2 text-sm text-amber-800">
                Could not read the pending grants: {pendingError}
              </p>
            ) : pendingGrants === null ? (
              <p className="mt-2 text-sm text-slate-500">Loading…</p>
            ) : pendingGrants.length === 0 ? (
              <p className="mt-2 text-sm text-slate-600">No grant is pending.</p>
            ) : (
              <ul className="mt-3 divide-y divide-slate-100">
                {pendingGrants.map((p) => (
                  <li key={p.address} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
                    <div className="min-w-0">
                      <p className="break-all font-mono text-xs text-slate-800">{p.newAdmin}</p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {describeProposalWindow(proposalWindowState(p, now))}
                      </p>
                      {!p.stale && (
                        <p className="mt-1 max-w-xl text-xs text-slate-600">
                          The grant is executed by the proposed wallet itself (it signs{" "}
                          <span className="font-mono">add_admin</span>): send its holder{" "}
                          <Link href="/account/roles" className="font-medium text-brand-700 underline">
                            /account/roles
                          </Link>{" "}
                          — they connect THAT wallet and press Accept under Pending roles once the
                          waiting period ends, before it expires.
                        </p>
                      )}
                      {p.stale && (
                        <p className="mt-0.5 text-xs text-amber-800">
                          Proposed by an earlier Super Admin ({p.proposedBy.slice(0, 6)}…): it can no
                          longer be executed. Cancel it.
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      disabled={!isAdmin || tx.isSending}
                      title={isAdmin ? undefined : "Admins (and the upgrade authority) only"}
                      onClick={() => setConfirmCancel(p)}
                      className={`shrink-0 ${BTN2}`}
                    >
                      Cancel
                    </button>
                  </li>
                ))}
              </ul>
            )}
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
        title="Propose admin role"
        kind="info"
        confirmLabel="Propose"
        description={
          <>
            <p>You are about to propose admin permissions for:</p>
            <p className="mt-2 break-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">
              {grantAddr.trim()}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              After 48 hours (at once while the bootstrap window is open) that
              wallet takes the role itself, within 14 days. It will gain access
              to issuance and custody (the blocklist stays with the blocklist
              authority). Reason will be recorded in the audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />
      <ConfirmModal
        open={confirmCancel !== null}
        onClose={() => setConfirmCancel(null)}
        onConfirm={(reason) => (confirmCancel ? cancelGrant(confirmCancel, reason) : undefined)}
        title="Cancel the admin grant"
        kind="warning"
        confirmLabel="Cancel grant"
        description={
          <p>
            The pending grant for{" "}
            <span className="break-all font-mono text-xs">{confirmCancel?.newAdmin}</span> is
            withdrawn; its rent returns to the Super Admin who proposed it.
          </p>
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

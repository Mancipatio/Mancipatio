"use client";

import { type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ConfirmModal } from "@/components/confirm-modal";
import { JurisdictionSelector } from "@/components/jurisdiction-selector";
import type { KycRegistry } from "@/lib/generated/asset_registry";
import { countryName } from "@/lib/countries";
import { invalidateKycAuthorityContext } from "@/lib/kyc-authority";
import {
  bitmapCodeStrings,
  jurisdictionDiff,
  kycRegistryActions,
  kycTransferState,
  proposedKycAuthorityError,
  toggleJurisdiction,
  type PendingKycTransfer,
} from "@/lib/kyc-registry-rotation";
import {
  buildAcceptKycAuthority,
  buildCancelKycAuthorityTransfer,
  buildProposeKycAuthority,
  buildUpdateRegistryJurisdictions,
  fetchPendingKycAuthorityTransfer,
  jurisdictionBitmap,
} from "@/lib/passport";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { useToast } from "@/lib/toast";
import { walletSigner } from "@/lib/wallet-signer";

type Action =
  | { kind: "propose"; newAuthority: string }
  | { kind: "accept" }
  | { kind: "cancel" }
  | { kind: "jurisdictions" };

const IX_NAME: Record<Action["kind"], string> = {
  propose: "propose_kyc_registry_authority",
  accept: "accept_kyc_registry_authority",
  cancel: "cancel_kyc_registry_authority_transfer",
  jurisdictions: "update_kyc_registry_jurisdictions",
};

const TITLE: Record<Action["kind"], string> = {
  propose: "Propose a new KYC registry authority",
  accept: "Accept the KYC registry authority",
  cancel: "Cancel the pending authority transfer",
  jurisdictions: "Replace the registry jurisdictions",
};

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
const names = (codes: number[]) =>
  codes.map((c) => countryName(String(c).padStart(3, "0"))).join(", ");

/**
 * The live KYC registry's authority rotation (propose / accept / cancel) and
 * its jurisdiction bitmaps. Every action is gated on ON-CHAIN state only.
 * Propose, cancel and the jurisdiction edit need the wallet to be
 * `registry.authority`. Accept needs it to be the staged `new_authority` of a
 * transfer that is still live against the current authority. No app role
 * (Super Admin included) grants anything here, and the program enforces the
 * same rules.
 */
export function KycRegistryPanel({
  registryAddress,
  registry,
  onChanged,
}: {
  registryAddress: Address;
  registry: KycRegistry;
  onChanged: () => void | Promise<void>;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address?.toString() ?? null;
  const authority = registry.authority.toString();

  const [pending, setPending] = useState<PendingKycTransfer | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [proposeInput, setProposeInput] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [editing, setEditing] = useState(false);
  const onChainApproved = useMemo(
    () => bitmapCodeStrings(registry.approvedJurisdictions),
    [registry.approvedJurisdictions],
  );
  const onChainBlocked = useMemo(
    () => bitmapCodeStrings(registry.blockedJurisdictions),
    [registry.blockedJurisdictions],
  );
  const [approved, setApproved] = useState<Set<string>>(() => new Set(onChainApproved));
  const [blocked, setBlocked] = useState<Set<string>>(() => new Set(onChainBlocked));

  const loadPending = useCallback(async () => {
    try {
      const t = await fetchPendingKycAuthorityTransfer(client.runtime.rpc, registryAddress);
      setPending(
        t
          ? {
              target: t.target.toString(),
              currentAuthority: t.currentAuthority.toString(),
              newAuthority: t.newAuthority.toString(),
              proposedBy: t.proposedBy.toString(),
            }
          : null,
      );
      setPendingError(null);
    } catch (err) {
      setPendingError(err instanceof Error ? err.message : String(err));
    }
  }, [client, registryAddress]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadPending();
  }, [loadPending]);

  const state = kycTransferState(registryAddress.toString(), authority, pending);
  const can = kycRegistryActions(wallet, authority, state);
  const proposeError = proposedKycAuthorityError(proposeInput, authority);

  const nextBitmaps = useMemo(
    () => ({
      approved: jurisdictionBitmap(Array.from(approved).map((c) => parseInt(c, 10))),
      blocked: jurisdictionBitmap(Array.from(blocked).map((c) => parseInt(c, 10))),
    }),
    [approved, blocked],
  );
  const diff = useMemo(
    () =>
      jurisdictionDiff(
        { approved: registry.approvedJurisdictions, blocked: registry.blockedJurisdictions },
        nextBitmaps,
      ),
    [registry.approvedJurisdictions, registry.blockedJurisdictions, nextBitmaps],
  );

  function startEditing() {
    setApproved(new Set(onChainApproved));
    setBlocked(new Set(onChainBlocked));
    setEditing(true);
  }

  function toggle(code: string, target: "approved" | "blocked") {
    const next = toggleJurisdiction(approved, blocked, code, target);
    setApproved(next.approved);
    setBlocked(next.blocked);
  }

  async function run(current: Action, reason: string) {
    if (!wallet || !conn.wallet) return;
    const ixName = IX_NAME[current.kind];
    const title = TITLE[current.kind];
    const metadata: Record<string, unknown> = { registry: registryAddress.toString(), authority };
    const pendingId = toast.showPending(`${title}…`, reason);
    try {
      const signer = walletSigner(conn.wallet);
      let ix;
      switch (current.kind) {
        case "propose":
          metadata.new_authority = current.newAuthority;
          ix = await buildProposeKycAuthority({
            authoritySigner: signer,
            registry: registryAddress,
            newAuthority: current.newAuthority as Address,
          });
          break;
        case "accept":
          metadata.new_authority = wallet;
          ix = await buildAcceptKycAuthority({ newAuthoritySigner: signer, registry: registryAddress });
          break;
        case "cancel":
          metadata.cancelled_new_authority = pending?.newAuthority ?? null;
          ix = await buildCancelKycAuthorityTransfer({ authoritySigner: signer, registry: registryAddress });
          break;
        case "jurisdictions":
          metadata.diff = {
            approved_added: diff.approvedAdded,
            approved_removed: diff.approvedRemoved,
            blocked_added: diff.blockedAdded,
            blocked_removed: diff.blockedRemoved,
          };
          ix = await buildUpdateRegistryJurisdictions({
            authoritySigner: signer,
            registry: registryAddress,
            approvedJurisdictions: nextBitmaps.approved,
            blockedJurisdictions: nextBitmaps.blocked,
          });
          break;
      }
      const result = await tx.send({ instructions: [ix], feePayer: signer });
      const sig = typeof result === "string" ? result : "";
      toast.dismiss(pendingId);
      toast.showTx(sig, { title });
      void recordAudit({
        ix_name: ixName,
        category: "issuers",
        actor_wallet: wallet,
        reason,
        target_label: registryAddress.toString(),
        tx_signature: sig || undefined,
        status: "success",
        metadata,
      });
      setAction(null);
      if (current.kind === "propose") setProposeInput("");
      if (current.kind === "jurisdictions") setEditing(false);
      invalidateKycAuthorityContext(client.runtime.rpc);
      await loadPending();
      await onChanged();
    } catch (err) {
      toast.dismiss(pendingId);
      const detail = explainSendError(err);
      toast.showError(`${title} failed`, detail);
      void recordAudit({
        ix_name: ixName,
        category: "issuers",
        actor_wallet: wallet,
        reason,
        target_label: registryAddress.toString(),
        status: "failed",
        metadata: { ...metadata, error: detail },
      });
    }
  }

  return (
    <div className="mt-5 space-y-5 border-t border-brand-200 pt-5">
      {/* Authority rotation */}
      <section aria-labelledby="kyc-authority-heading">
        <h3 id="kyc-authority-heading" className="text-[13px] font-semibold text-slate-900">
          Registry authority
        </h3>
        <p className="mt-0.5 text-xs text-slate-600">
          The registry address never changes. Rotating moves only the key that
          issues and revokes passports and edits jurisdictions. The current
          authority proposes, and the new wallet accepts with its own signature.
        </p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="text-slate-500">Address</dt>
          <dd className="break-all font-mono text-slate-800">{registryAddress.toString()}</dd>
          <dt className="text-slate-500">Authority</dt>
          <dd className="break-all font-mono text-slate-800">{authority}</dd>
          <dt className="text-slate-500">Pending</dt>
          <dd className="text-slate-800">
            {pendingError ? (
              <span className="text-red-600">Could not read the pending transfer: {pendingError}</span>
            ) : state.kind === "none" ? (
              "None"
            ) : (
              <>
                to <span className="break-all font-mono">{state.newAuthority}</span>
                {state.kind === "stale" && (
                  <span className="ml-1 text-amber-700">
                    (stale: proposed under a previous authority, so it cannot be accepted)
                  </span>
                )}
              </>
            )}
          </dd>
        </dl>

        {can.canPropose && (
          <div className="mt-3 flex flex-wrap items-start gap-2">
            <label className="sr-only" htmlFor="kyc-new-authority">
              New authority wallet
            </label>
            <input
              id="kyc-new-authority"
              value={proposeInput}
              onChange={(e) => setProposeInput(e.target.value)}
              placeholder="New authority wallet (e.g. the compliance Ledger)"
              spellCheck={false}
              className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-1.5 font-mono text-xs focus:border-slate-400 focus:outline-none"
            />
            <button
              type="button"
              disabled={tx.isSending || !proposeInput.trim() || proposeError !== null}
              onClick={() => setAction({ kind: "propose", newAuthority: proposeInput.trim() })}
              className="rounded-md bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-50"
            >
              {state.kind === "none" ? "Propose" : "Replace proposal"}
            </button>
            {can.canCancel && (
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() => setAction({ kind: "cancel" })}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                Cancel proposal
              </button>
            )}
            {proposeError && <p className="w-full text-xs text-red-600">{proposeError}</p>}
          </div>
        )}
        {can.canAccept && (
          <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-900">
            This wallet was proposed as the registry authority.{" "}
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => setAction({ kind: "accept" })}
              className="ml-1 rounded-md bg-emerald-700 px-3 py-1 font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              Accept authority
            </button>
          </div>
        )}
        {!can.canPropose && !can.canAccept && (
          <p className="mt-2 text-[11px] text-slate-500">
            Only the registry authority ({short(authority)}) can propose or cancel,
            and only a proposed wallet can accept.
          </p>
        )}
        <p className="mt-2 text-[11px] text-slate-500">
          This page requires an Admin role. A new authority without one can
          accept from the CLI, or be added as an Admin for the handover.
        </p>
      </section>

      {/* Jurisdictions */}
      <section aria-labelledby="kyc-jurisdictions-heading">
        <h3 id="kyc-jurisdictions-heading" className="text-[13px] font-semibold text-slate-900">
          Jurisdictions
        </h3>
        <p className="mt-0.5 text-xs text-slate-600">
          {onChainApproved.size} approved, {onChainBlocked.size} blocked. A change
          applies at once to every KYC-gated mint that names this registry,
          for transfers and for purchases. Blocked wins over approved.
        </p>
        {can.canEditJurisdictions && !editing && (
          <button
            type="button"
            onClick={startEditing}
            className="mt-2 rounded-md border border-brand-300 bg-white px-2.5 py-1 text-xs text-brand-700 hover:bg-brand-50"
          >
            Edit jurisdictions
          </button>
        )}
        {editing && (
          <div className="mt-3 space-y-3">
            <JurisdictionSelector
              approved={approved}
              blocked={blocked}
              onToggle={toggle}
              disabled={tx.isSending}
            />
            <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
              {diff.unchanged ? (
                "No change from the on-chain maps."
              ) : (
                <ul className="space-y-0.5">
                  {diff.approvedAdded.length > 0 && <li>Approve: {names(diff.approvedAdded)}</li>}
                  {diff.approvedRemoved.length > 0 && (
                    <li>No longer approved: {names(diff.approvedRemoved)}</li>
                  )}
                  {diff.blockedAdded.length > 0 && (
                    <li className="text-red-700">Block: {names(diff.blockedAdded)}</li>
                  )}
                  {diff.blockedRemoved.length > 0 && <li>Unblock: {names(diff.blockedRemoved)}</li>}
                </ul>
              )}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={tx.isSending || diff.unchanged}
                onClick={() => setAction({ kind: "jurisdictions" })}
                className="rounded-md bg-brand-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-800 disabled:opacity-50"
              >
                Review and send
              </button>
              <button
                type="button"
                disabled={tx.isSending}
                onClick={() => setEditing(false)}
                className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50"
              >
                Discard
              </button>
            </div>
          </div>
        )}
      </section>

      {action && (
        <ConfirmModal
          open
          busy={tx.isSending}
          onClose={() => setAction(null)}
          onConfirm={(reason) => run(action, reason)}
          title={TITLE[action.kind]}
          kind={action.kind === "cancel" ? "warning" : "destructive"}
          confirmLabel={
            action.kind === "propose"
              ? "Propose"
              : action.kind === "accept"
                ? "Accept"
                : action.kind === "cancel"
                  ? "Cancel proposal"
                  : "Replace maps"
          }
          description={
            action.kind === "propose" ? (
              <p>
                Stage <span className="break-all font-mono">{action.newAuthority}</span> as the
                registry authority. Nothing moves until that wallet accepts. After
                that, only it can issue or revoke passports on this registry.
              </p>
            ) : action.kind === "accept" ? (
              <p>
                Take over registry {short(registryAddress.toString())} from {short(authority)}.
                The previous authority loses every registry power.
              </p>
            ) : action.kind === "cancel" ? (
              <p>Withdraw the pending proposal. The rent returns to this wallet.</p>
            ) : (
              <p>
                Replace both jurisdiction maps on-chain. This takes effect immediately
                for every KYC-gated mint on this registry.
              </p>
            )
          }
        />
      )}
    </div>
  );
}

"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { isAddress } from "@solana/kit";
import {
  useSolanaClient,
  useWalletConnection,
  useSendTransaction,
} from "@solana/react-hooks";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { ConfirmModal } from "@/components/confirm-modal";
import { invalidateRoles } from "@/lib/role-store";
import { notifyAdminBadges } from "@/lib/admin-badges-events";
import { startFinalityPoll } from "@/lib/finality-poll";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { ACCOUNT_ROLES_PATH } from "@/components/require-role";
import { DEFAULT_ADDRESS } from "@/lib/protocol-treasury";
import {
  loadOperationalAuthority,
  buildProposeOperationalAuthority,
  buildAcceptOperationalAuthority,
  buildCancelOperationalAuthority,
  RECOVERY_PENDING_BLOCKER,
  type OperationalAuthorityKind,
  type OperationalAuthorityState,
} from "@/lib/operational-authority";
import { useRole } from "@/lib/auth";
import { useChainClock } from "@/lib/use-chain-clock";
import {
  describeProposalWindow,
  proposalWindowBlocker,
  proposalWindowState,
} from "@/lib/proposal-window";
export function AuthorityRotation({
  kind,
  initialNext,
  awaitInitialization = false,
}: {
  kind: OperationalAuthorityKind;
  /**
   * Pre-fills the successor (the permanent key entered at bootstrap). The
   * parent remounts the panel (key) when it changes.
   */
  initialNext?: string;
  /**
   * The parent just initialized this authority: the finalized read trails
   * the init, so re-read until the account appears (no manual Refresh).
   */
  awaitInitialization?: boolean;
}) {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    tx = useSendTransaction(),
    toast = useToast(),
    wallet = conn.wallet?.account.address;
  const [state, setState] = useState<OperationalAuthorityState | null>(null),
    [error, setError] = useState<string | null>(null),
    [next, setNext] = useState(initialNext ?? ""),
    [confirm, setConfirm] = useState<"propose" | "accept" | "cancel" | null>(null),
    [gaveUp, setGaveUp] = useState(false);
  const role = useRole(),
    now = useChainClock();
  const proposalWindow =
    state?.eta != null && state.expiresAt != null
      ? proposalWindowState({ proposedAt: state.eta, eta: state.eta, expiresAt: state.expiresAt }, now)
      : null;
  // Platform: the Super Admin, any Admin or the upgrade authority may cancel
  // (the program decides); blocklist: only the live authority.
  const canCancel =
    !!state?.proposed &&
    (kind === "platform" ? role.isAdmin || wallet === state.current : wallet === state.current);
  const acceptBlocker = state?.recoveryPending
    ? RECOVERY_PENDING_BLOCKER
    : proposalWindow
      ? proposalWindowBlocker(proposalWindow)
      : null;
  /** Resolves true once the finalized authority exists. */
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const loaded = await loadOperationalAuthority(client.runtime.rpc, kind);
      setState(loaded);
      setError(null);
      return loaded !== null;
    } catch {
      setError(
        "Could not read the current authority and proposal. Retry after RPC recovery.",
      );
      return false;
    }
  }, [client, kind]);
  useEffect(() => {
    // Load external finalized chain state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  const waitingForInit = awaitInitialization && state === null;
  useEffect(() => {
    if (!waitingForInit) return;
    return startFinalityPoll(refresh, { onGiveUp: () => setGaveUp(true) });
  }, [waitingForInit, refresh]);
  async function submit() {
    if (!conn.wallet || !confirm) return;
    const action = confirm;
    const target = next.trim();
    const ixName = AUDIT_IX[kind][action];
    const metadata: Record<string, unknown> = {
      kind,
      current: state?.current ?? null,
      new_authority:
        action === "propose"
          ? target
          : action === "cancel"
            ? (state?.proposed ?? null)
            : conn.wallet.account.address.toString(),
    };
    try {
      const signer = walletSigner(conn.wallet);
      const ix =
        confirm === "propose"
          ? await buildProposeOperationalAuthority(
              client.runtime.rpc,
              kind,
              signer,
              next.trim(),
            )
          : confirm === "cancel"
            ? await buildCancelOperationalAuthority(client.runtime.rpc, kind, signer)
            : await buildAcceptOperationalAuthority(
                client.runtime.rpc,
                kind,
                signer,
              );
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(sig, {
        title:
          action === "propose"
            ? "Authority proposal submitted"
            : action === "cancel"
              ? "Authority proposal cancelled"
              : "Authority acceptance submitted",
      });
      void recordAudit({
        ix_name: ixName,
        category: "platform",
        actor_wallet: signer.address.toString(),
        reason: AUDIT_REASON[action],
        target_label: state?.target?.toString(),
        tx_signature: typeof sig === "string" && sig ? sig : undefined,
        status: "success",
        metadata,
      });
      setConfirm(null);
      setNext("");
      // The platform / blocklist authority (or its proposal) changed; the
      // menu counts pending rotations (0079 mirror).
      invalidateRoles();
      void refresh();
      notifyAdminBadges({ afterIndexer: true });
    } catch (error) {
      const detail = explainSendError(error);
      toast.showError("Authority change not completed", detail);
      void recordAudit({
        ix_name: ixName,
        category: "platform",
        actor_wallet: conn.wallet.account.address.toString(),
        reason: AUDIT_REASON[action],
        target_label: state?.target?.toString(),
        status: "failed",
        metadata: { ...metadata, error: detail },
      });
    }
  }
  const label = kind === "platform" ? "Super Admin" : "blocklist authority";
  return (
    <section className="mt-5 rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <h2 className="text-base font-semibold text-slate-900">Change {label}</h2>
      <p className="mt-2 text-xs text-slate-600">
        The current authority proposes a replacement. The replacement wallet
        accepts in a separate transaction
        {kind === "platform"
          ? " once the 48-hour waiting period has passed (waived while the bootstrap window is open), within 14 days"
          : " within 14 days"}
        . Program upgrade authority is unchanged.
      </p>
      {error ? (
        <p className="mt-2 text-xs text-amber-800">{error}</p>
      ) : state ? (
        <>
          <p className="mt-3 break-all font-mono text-xs text-slate-700">
            Current: {state.current}
          </p>
          {state.proposed && (
            <p className="mt-1 break-all font-mono text-xs text-brand-800">
              Proposed: {state.proposed}
            </p>
          )}
          {state.proposed && proposalWindow && (
            <p className="mt-1 text-xs text-slate-500">{describeProposalWindow(proposalWindow)}</p>
          )}
          {state.recoveryPending && (
            <p className="mt-1 text-xs text-amber-800">{RECOVERY_PENDING_BLOCKER}</p>
          )}
          {wallet === state.current && initialNext && next.trim() === initialNext && (
            <p className="mt-3 text-xs text-brand-800">
              Pre-filled with the permanent key entered at bootstrap: propose
              it now.
            </p>
          )}
          {wallet === state.current && (
            <div className="mt-3 flex flex-wrap gap-2">
              <input
                value={next}
                onChange={(e) => setNext(e.target.value)}
                placeholder="Replacement wallet address"
                className="min-w-64 flex-1 rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs"
              />
              <button
                type="button"
                disabled={
                  tx.isSending ||
                  !isAddress(next.trim()) ||
                  next.trim() === DEFAULT_ADDRESS ||
                  next.trim() === state.current
                }
                onClick={() => setConfirm("propose")}
                className="rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-xs font-semibold text-brand-800 disabled:opacity-50"
              >
                {state.proposed ? "Replace proposal" : "Propose replacement"}
              </button>
              {next.trim() === DEFAULT_ADDRESS && (
                <p className="w-full text-xs text-red-600">
                  The default 1111…1111 address cannot be an authority.
                </p>
              )}
            </div>
          )}
          {wallet === state.proposed && (
            <>
              <button
                type="button"
                disabled={tx.isSending || acceptBlocker !== null}
                onClick={() => setConfirm("accept")}
                className="mt-3 rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50"
              >
                Accept authority
              </button>
              {acceptBlocker && !state.recoveryPending && (
                <p className="mt-1 text-xs text-amber-800">{acceptBlocker}</p>
              )}
            </>
          )}
          {canCancel && (
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => setConfirm("cancel")}
              className="mt-3 ml-2 rounded-lg border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-50"
            >
              Cancel proposal
            </button>
          )}
          {state.proposed && wallet !== state.proposed && (
            <p className="mt-2 text-xs text-slate-500">
              The proposed wallet accepts at{" "}
              <Link href={ACCOUNT_ROLES_PATH} className="underline">
                {ACCOUNT_ROLES_PATH}
              </Link>{" "}
              once the proposal is finalized. That page needs no Admin role.
              {kind === "platform"
                ? " The Super Admin, any Admin or the program upgrade authority can cancel it; the current authority can also replace it."
                : " The blocklist authority can cancel or replace it."}
            </p>
          )}
        </>
      ) : waitingForInit ? (
        <p className="mt-3 text-xs text-slate-500" role="status">
          Initialized: waiting for it to be finalized (usually under 30 s)
          before a replacement can be proposed
          {initialNext ? ", then the permanent key is pre-filled" : ""}.
          {gaveUp && " Still not finalized: use Refresh authority."}
        </p>
      ) : (
        <p className="mt-3 text-xs text-slate-500">
          Initialize this authority before proposing a replacement.
        </p>
      )}
      <button
        type="button"
        onClick={() => void refresh()}
        className="mt-3 text-xs text-slate-500 underline"
      >
        Refresh authority
      </button>
      <ConfirmModal
        open={confirm !== null}
        title={
          confirm === "accept"
            ? `Accept ${label} responsibility?`
            : confirm === "cancel"
              ? `Cancel the ${label} proposal?`
              : `Propose a new ${label}?`
        }
        description={
          confirm === "accept" ? (
            kind === "platform" ? (
              <div className="space-y-2">
                <p>
                  The connected wallet becomes Super Admin. The former Super
                  Admin&apos;s Admin record is closed.
                </p>
                <PlatformAcceptChecklist />
              </div>
            ) : (
              "The connected wallet becomes blocklist authority. Only the new wallet can manage the blocklist and the transfer-hook mode after acceptance."
            )
          ) : confirm === "cancel" ? (
            `The proposal to ${state?.proposed ?? ""} is withdrawn; its rent returns to the proposer. The current authority stays in place.`
          ) : (
            kind === "platform"
              ? `Propose ${next.trim()}. It can accept after 48 hours (at once while the bootstrap window is open), within 14 days. The current authority remains active until then; any Admin or the upgrade authority can cancel it.`
              : `Propose ${next.trim()}. It can accept within 14 days. The current authority remains active until then.`
          )
        }
        kind="warning"
        confirmLabel={
          confirm === "accept"
            ? "Accept authority"
            : confirm === "cancel"
              ? "Cancel proposal"
              : "Create proposal"
        }
        requireReason={false}
        busy={tx.isSending}
        onConfirm={() => void submit()}
        onClose={() => setConfirm(null)}
      />
    </section>
  );
}

/**
 * The rotation panel's key part after a bootstrap on the same page: remounts
 * it (fresh pre-fill, finality wait) once the init landed.
 */
export function initKey(successor: string | null | undefined): string {
  return successor === undefined ? "" : `init:${successor ?? ""}`;
}

const AUDIT_IX: Record<OperationalAuthorityKind, Record<"propose" | "accept" | "cancel", string>> = {
  platform: {
    propose: "propose_platform_admin",
    accept: "accept_platform_admin",
    cancel: "cancel_platform_admin_transfer",
  },
  blocklist: {
    propose: "propose_blocklist_authority",
    accept: "accept_blocklist_authority",
    cancel: "cancel_blocklist_authority_transfer",
  },
};

const AUDIT_REASON: Record<"propose" | "accept" | "cancel", string> = {
  propose: "Operational authority successor proposed",
  accept: "Operational authority accepted by the proposed wallet",
  cancel: "Operational authority proposal cancelled",
};

/**
 * What changes with the Super Admin (Talas 3.1 K10). Shown before a platform
 * accept, here and on /account/roles: these follow the Super Admin and are
 * not moved by the rotation itself.
 */
export function PlatformAcceptChecklist() {
  return (
    <div>
      <p className="font-semibold">After accepting, review:</p>
      <ul className="mt-1 list-disc space-y-1 pl-5">
        <li>
          Custody vaults operated by the former Super Admin: propose a new
          custody operator for each on /admin/custody.
        </li>
        <li>
          Custody operator proposals made by the former Super Admin become
          stale: re-propose them.
        </li>
        <li>
          Pending issuer recoveries become stale: cancel them and propose again
          if still needed.
        </li>
        <li>
          If the former Super Admin is also the KYC registry authority, rotate
          the registry on /admin/kyc: it does not move with this role.
        </li>
      </ul>
    </div>
  );
}

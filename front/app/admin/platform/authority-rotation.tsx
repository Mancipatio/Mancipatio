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
import { startFinalityPoll } from "@/lib/finality-poll";
import { recordAudit } from "@/lib/supabase";
import { explainSendError } from "@/lib/tx-error";
import { ACCOUNT_ROLES_PATH } from "@/components/require-role";
import { DEFAULT_ADDRESS } from "@/lib/protocol-treasury";
import {
  loadOperationalAuthority,
  buildProposeOperationalAuthority,
  buildAcceptOperationalAuthority,
  type OperationalAuthorityKind,
  type OperationalAuthorityState,
} from "@/lib/operational-authority";
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
    [confirm, setConfirm] = useState<"propose" | "accept" | null>(null),
    [gaveUp, setGaveUp] = useState(false);
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
      new_authority: action === "propose" ? target : conn.wallet.account.address.toString(),
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
      // The platform / blocklist authority (or its proposal) changed.
      invalidateRoles();
      void refresh();
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
        accepts in a separate transaction. Program upgrade authority is
        unchanged.
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
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => setConfirm("accept")}
              className="mt-3 rounded-lg bg-brand-700 px-3 py-2 text-xs font-semibold text-white"
            >
              Accept authority
            </button>
          )}
          {state.proposed && wallet !== state.proposed && (
            <p className="mt-2 text-xs text-slate-500">
              The proposed wallet accepts at{" "}
              <Link href={ACCOUNT_ROLES_PATH} className="underline">
                {ACCOUNT_ROLES_PATH}
              </Link>{" "}
              once the proposal is finalized. That page needs no Admin role.
              There is no cancel instruction: to withdraw a proposal, replace
              it.
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
          ) : (
            `Propose ${next.trim()}. The current authority remains active until that wallet accepts.`
          )
        }
        kind="warning"
        confirmLabel={
          confirm === "accept" ? "Accept authority" : "Create proposal"
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

const AUDIT_IX: Record<OperationalAuthorityKind, Record<"propose" | "accept", string>> = {
  platform: { propose: "propose_platform_admin", accept: "accept_platform_admin" },
  blocklist: { propose: "propose_blocklist_authority", accept: "accept_blocklist_authority" },
};

const AUDIT_REASON: Record<"propose" | "accept", string> = {
  propose: "Operational authority successor proposed",
  accept: "Operational authority accepted by the proposed wallet",
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

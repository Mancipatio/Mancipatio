"use client";

// /account/roles sections 3 and 4 (Talas 3.1 §4): what waits for this wallet's
// acceptance, and the proposals it made as the current authority. Every
// action confirms first, re-reads the authoritative state inside its builder
// (lib/pending-roles), records an audit breadcrumb and drops the role cache.

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { ConfirmModal } from "@/components/confirm-modal";
import { PlatformAcceptChecklist } from "@/app/admin/platform/authority-rotation";
import { invalidateRoles, useRole } from "@/lib/auth";
import { features } from "@/lib/features";
import { describeRecoveryState } from "@/lib/issuer-authority";
import { invalidateKycAuthorityContext } from "@/lib/kyc-authority";
import { detectNetwork } from "@/lib/network";
import { createNetworkVerifier } from "@/lib/network-identity";
import {
  ACCEPT_IX_NAME,
  KybStatus,
  VaultState,
  buildAcceptPendingRole,
  buildCancelKycRegistryProposal,
  findPendingRolesForWallet,
  pendingBadgeCount,
  type PendingRoleRow,
  type PendingRoles,
} from "@/lib/pending-roles";
import type { OutgoingProposal, PendingRole } from "@/lib/role-resolution";
import { recordAudit, type AuditCategory } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { walletSigner } from "@/lib/wallet-signer";

const short = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;

const KIND_TITLE: Record<PendingRoleRow["kind"], string> = {
  platform: "Super Admin",
  blocklist: "Blocklist authority",
  kyc: "KYC provider (registry authority)",
  custody: "Custody operator",
  issuer: "Issuer key",
  issuerRecovery: "Issuer key recovery",
};

const AUDIT_CATEGORY: Record<"platform" | "blocklist" | "kyc" | "custody", AuditCategory> = {
  platform: "platform",
  blocklist: "platform",
  kyc: "issuers",
  custody: "custody",
};

type Acceptable = Extract<PendingRoleRow, { kind: "platform" | "blocklist" | "kyc" | "custody" }>;

function isAcceptable(row: PendingRoleRow): row is Acceptable {
  return row.kind === "platform" || row.kind === "blocklist" || row.kind === "kyc" || row.kind === "custody";
}

/** The single-read proposals of the role snapshot, as rows (the scan fallback). */
function singleReadRows(pending: readonly PendingRole[]): PendingRoleRow[] {
  return pending.map((p) =>
    p.kind === "kyc"
      ? {
          kind: "kyc" as const,
          target: p.target,
          currentAuthority: p.currentAuthority,
          proposedBy: p.currentAuthority,
          counted: true,
          blocked: null,
          platformRegistry: true,
        }
      : {
          kind: p.kind,
          target: p.target,
          currentAuthority: p.currentAuthority,
          proposedBy: p.currentAuthority,
          counted: true,
          blocked: null,
        },
  );
}

function rowTitle(row: PendingRoleRow): string {
  switch (row.kind) {
    case "kyc":
      return row.platformRegistry ? KIND_TITLE.kyc : `${KIND_TITLE.kyc} · not the platform registry`;
    case "custody":
      return `${KIND_TITLE.custody} · vault ${short(row.target)} (${VaultState[row.vaultState] ?? "closed"})`;
    case "issuer":
    case "issuerRecovery":
      // Anyone can register an issuer and stage these: never a platform role.
      return `${KIND_TITLE[row.kind]} · Issuer key, not a platform role · KYB: ${KybStatus[row.kybStatus] ?? "unknown"}`;
    default:
      return KIND_TITLE[row.kind];
  }
}

function acceptDescription(row: Acceptable) {
  switch (row.kind) {
    case "platform":
      return (
        <div className="space-y-2">
          <p>
            The connected wallet becomes Super Admin (and admin #1). The former
            Super Admin&apos;s Admin record is closed. Program upgrade authority
            is unchanged.
          </p>
          <PlatformAcceptChecklist />
        </div>
      );
    case "blocklist":
      return "The connected wallet becomes the blocklist authority: it alone adds and removes blocklist entries and switches the transfer-hook mode.";
    case "kyc":
      return row.platformRegistry
        ? "The connected wallet becomes the registry authority: it alone issues and revokes passports and edits the jurisdictions. The registry address does not change."
        : `This registry (${row.target}) is NOT the platform registry. Accept only if you expected to operate it.`;
    case "custody":
      return `The connected wallet becomes the custody operator of vault ${row.target}. The beneficiary and the custody terms do not change.`;
  }
}

export function PendingRolesPanel({ maintenance }: { maintenance: boolean }) {
  const role = useRole({ kyc: true });
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const rpc = client.runtime.rpc;
  const network = detectNetwork();
  const wallet = conn.wallet?.account.address?.toString() ?? null;
  const platformRegistry = role.kycRegistry?.address ?? null;

  const [result, setResult] = useState<PendingRoles | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<Acceptable | null>(null);
  const [busy, setBusy] = useState(false);

  const verifyNetwork = useMemo(() => {
    try {
      return createNetworkVerifier(rpc, network, { cacheMs: 300_000 });
    } catch (err) {
      return async () => {
        throw err;
      };
    }
  }, [rpc, network]);

  const load = useCallback(async () => {
    if (!wallet || role.loading) return;
    try {
      setResult(
        await findPendingRolesForWallet(rpc, wallet as Address, {
          platformRegistry,
          verifyNetwork,
          commitment: "confirmed",
        }),
      );
      setFatal(null);
    } catch (err) {
      setResult(null);
      setFatal(err instanceof Error ? err.message : String(err));
    }
  }, [rpc, wallet, role.loading, platformRegistry, verifyNetwork]);

  useEffect(() => {
    // Load the chain state after hydration and whenever the roles change.
    void load();
  }, [load]);

  const rows = result ? result.rows : fatal ? singleReadRows(role.pending) : null;
  const note = result?.scanError ?? (fatal ? `Could not load every proposal (${fatal}). Showing the platform roles read directly.` : null);

  async function accept(row: Acceptable) {
    if (!conn.wallet || !wallet) return;
    setBusy(true);
    const ixName = ACCEPT_IX_NAME[row.kind];
    const metadata = { kind: row.kind, target: row.target, from: row.currentAuthority };
    try {
      const signer = walletSigner(conn.wallet);
      const ix = await buildAcceptPendingRole(rpc, row, signer);
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      const signature = typeof sig === "string" ? sig : "";
      toast.showTx(signature, { title: `${KIND_TITLE[row.kind]} accepted` });
      void recordAudit({
        ix_name: ixName,
        category: AUDIT_CATEGORY[row.kind],
        actor_wallet: wallet,
        reason: "Proposed role accepted at /account/roles",
        target_label: row.target.toString(),
        tx_signature: signature || undefined,
        status: "success",
        metadata,
      });
      setConfirm(null);
      if (row.kind === "kyc") invalidateKycAuthorityContext(rpc);
      invalidateRoles();
      await load();
    } catch (err) {
      const detail = explainSendError(err);
      toast.showError(`${KIND_TITLE[row.kind]} not accepted`, detail);
      void recordAudit({
        ix_name: ixName,
        category: AUDIT_CATEGORY[row.kind],
        actor_wallet: wallet,
        reason: "Proposed role accepted at /account/roles",
        target_label: row.target.toString(),
        status: "failed",
        metadata: { ...metadata, error: detail },
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel panel-pad">
      <div className="flex items-center justify-between gap-3">
        <p className="page-eyebrow">Waiting for your acceptance</p>
        {rows && (
          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700">
            {pendingBadgeCount(rows)} platform role{pendingBadgeCount(rows) === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {note && <p className="mt-2 text-xs text-amber-800">{note}</p>}
      {rows === null ? (
        <p className="mt-2 text-sm text-slate-500">Checking proposals…</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">No role is waiting for this wallet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {rows.map((row) => (
            <li key={`${row.kind}:${row.target}`} className="py-3 text-sm">
              <p className="font-semibold text-slate-900">{rowTitle(row)}</p>
              <p className="mt-0.5 break-all font-mono text-[11px] text-slate-500">{row.target}</p>
              <p className="mt-1 text-xs text-slate-600">
                From <span className="font-mono">{short(row.currentAuthority)}</span>
                {row.proposedBy !== row.currentAuthority && (
                  <>
                    {" "}· proposed by <span className="font-mono">{short(row.proposedBy)}</span>
                  </>
                )}
              </p>
              <RowAction
                row={row}
                disabled={busy || tx.isSending || maintenance}
                onAccept={(r) => setConfirm(r)}
              />
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => void load()} className="mt-2 text-xs text-slate-500 underline">
        Refresh
      </button>
      <ConfirmModal
        open={confirm !== null}
        title={confirm ? `Accept the ${KIND_TITLE[confirm.kind]} role?` : ""}
        description={confirm ? acceptDescription(confirm) : ""}
        kind="warning"
        requireReason={false}
        confirmLabel="Accept"
        busy={busy || tx.isSending}
        onConfirm={() => (confirm ? accept(confirm) : undefined)}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

function RowAction({
  row,
  disabled,
  onAccept,
}: {
  row: PendingRoleRow;
  disabled: boolean;
  onAccept: (row: Acceptable) => void;
}) {
  if (row.blocked) return <p className="mt-2 text-xs text-amber-800">{row.blocked}</p>;
  if (isAcceptable(row)) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => onAccept(row)}
        className="mt-2 rounded-lg bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
      >
        Accept
      </button>
    );
  }
  // Issuer rows: accepted where the sale / payout-vault syncs are bundled.
  const verb = row.kind === "issuer" ? "Accept" : "Execute";
  return (
    <div className="mt-2 text-xs text-slate-600">
      {row.kind === "issuerRecovery" && <p>{describeRecoveryState(row.recovery)}</p>}
      {features().issuerRotation ? (
        <Link
          href={`/issuer/rotation?issuer=${row.target}`}
          className="font-semibold text-brand-700 underline-offset-2 hover:underline"
        >
          {verb} on /issuer/rotation
        </Link>
      ) : (
        <p>{verb} through the 3.3 CLI (issuer key rotation is off on this deployment).</p>
      )}
    </div>
  );
}

const OUTGOING_TITLE: Record<OutgoingProposal["kind"], string> = {
  platform: "Super Admin",
  blocklist: "Blocklist authority",
  kyc: "KYC registry authority",
};

/** Section 4: proposals this wallet made as the current authority. */
export function OpenProposalsPanel({ maintenance }: { maintenance: boolean }) {
  const role = useRole({ kyc: true });
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const rpc = client.runtime.rpc;
  const wallet = conn.wallet?.account.address?.toString() ?? null;
  const [cancel, setCancel] = useState<OutgoingProposal | null>(null);
  const [busy, setBusy] = useState(false);

  async function cancelKyc(p: OutgoingProposal) {
    if (!conn.wallet || !wallet) return;
    setBusy(true);
    const metadata = { registry: p.target, cancelled_new_authority: p.newAuthority };
    try {
      const signer = walletSigner(conn.wallet);
      const ix = await buildCancelKycRegistryProposal(rpc, p.target, signer);
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      const signature = typeof sig === "string" ? sig : "";
      toast.showTx(signature, { title: "Registry authority proposal cancelled" });
      void recordAudit({
        ix_name: "cancel_kyc_registry_authority_transfer",
        category: "issuers",
        actor_wallet: wallet,
        reason: "Registry authority proposal cancelled at /account/roles",
        target_label: p.target.toString(),
        tx_signature: signature || undefined,
        status: "success",
        metadata,
      });
      setCancel(null);
      invalidateKycAuthorityContext(rpc);
      invalidateRoles();
    } catch (err) {
      const detail = explainSendError(err);
      toast.showError("Proposal not cancelled", detail);
      void recordAudit({
        ix_name: "cancel_kyc_registry_authority_transfer",
        category: "issuers",
        actor_wallet: wallet,
        reason: "Registry authority proposal cancelled at /account/roles",
        target_label: p.target.toString(),
        status: "failed",
        metadata: { ...metadata, error: detail },
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel panel-pad">
      <p className="page-eyebrow">Your open proposals</p>
      {role.outgoing.length === 0 ? (
        <p className="mt-2 text-sm text-slate-600">You have no open proposals.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {role.outgoing.map((p) => (
            <li key={`${p.kind}:${p.target}`} className="py-3 text-sm">
              <p className="font-semibold text-slate-900">
                {OUTGOING_TITLE[p.kind]} → <span className="font-mono text-xs">{p.newAuthority}</span>
              </p>
              {!p.live && (
                <p className="mt-1 text-xs text-amber-800">
                  Stale: it can no longer be accepted. Cancel it or propose again.
                </p>
              )}
              {p.kind === "kyc" ? (
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  <button
                    type="button"
                    disabled={busy || tx.isSending || maintenance}
                    onClick={() => setCancel(p)}
                    className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold text-slate-700 disabled:opacity-50"
                  >
                    Cancel proposal
                  </button>
                  <Link href="/admin/kyc" className="text-brand-700 underline-offset-2 hover:underline">
                    Replace it on /admin/kyc
                  </Link>
                </div>
              ) : (
                <p className="mt-1 text-xs text-slate-600">
                  There is no cancel instruction: replace the proposal in
                  &ldquo;Your operational authorities&rdquo; above.
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <ConfirmModal
        open={cancel !== null}
        title="Cancel the registry authority proposal?"
        description={
          cancel
            ? `The proposal to ${cancel.newAuthority} is withdrawn and its rent returns to you. You stay the registry authority.`
            : ""
        }
        kind="warning"
        requireReason={false}
        confirmLabel="Cancel proposal"
        busy={busy || tx.isSending}
        onConfirm={() => (cancel ? cancelKyc(cancel) : undefined)}
        onClose={() => setCancel(null)}
      />
    </div>
  );
}

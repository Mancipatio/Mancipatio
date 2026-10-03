"use client";

// The pre-clear check (design §4), right before the super admin reopens
// Primary issuance (clears 0x02) for an approved public sale. 0x02 is
// global: while it is clear, buys resume in every Open sale that can still
// take one, every live SaleApproval (up to 90 days old) can be opened and an
// Admin issuer key can mint into its treasury — nothing on chain ties the
// clear to one sale. So:
//   · Open sales that can still take a buy must be 0. One that ended or sold
//     out cannot (it only waits to be closed), nor one whose issuer is frozen
//     (IssuerFreeze, read at finalized: any Admin sets it, only the super
//     admin lifts it; it also stops that issuer's close_sale) — those are
//     listed and do not block (lib/sale-liveness);
//   · live approvals must be 0 except this one — "Revoke" closes a stray one
//     (revoke_sale_approval, any Admin; the rent returns to its approver)
//     and releases its raise-limit reservation.
// "Reopen primary issuance" runs the whole check again inside the click,
// right before signing (lib/public-sale preClearCheck), and refuses unless it
// is clean. Once 0x02 is open and the sale is not opened yet, any Admin can
// close it again from here. After the clear, the 1-hour "0x02 open with no
// sale taking buys" alarm (lib/server/alarm-checks primaryIdleReport) and the
// approve_sale alarm are the backstops.

import { useCallback, useEffect, useState } from "react";
import type { Address } from "@solana/kit";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import {
  fetchMaybeAsset,
  fetchMaybeShareClass,
  getRevokeSaleApprovalInstructionAsync,
  getSetPauseFlagsInstructionAsync,
} from "@/lib/generated/asset_registry";
import { useRole } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { recordAudit } from "@/lib/supabase";
import { walletSigner } from "@/lib/wallet-signer";
import { formatPauseFlags, isPaused, PAUSE_PRIMARY, pauseAuditMetadata } from "@/lib/pause-flags";
import { clearPauseFlagsCache } from "@/lib/pause-gate";
import { shortAddress } from "@/lib/share-transfer";
import { listOpenSales, readPlatformPause, type OpenSale } from "@/lib/distribution-chain";
import { listAllSaleApprovals, listSaleReservations, releaseSaleApproval, type SaleApprovalAccount } from "@/lib/sale-approvals";
import { preClearCheck, type PreClearResult } from "@/lib/public-sale";
import { liveSales, SALE_BUY_STATE_LABEL } from "@/lib/sale-liveness";
import { loadIssuerFreeze } from "@/lib/issuer-freeze";
import { IssuerFreezePanel } from "@/app/admin/issuers/issuer-freeze-panel";

type Snapshot = {
  result: PreClearResult;
  flags: number;
  superAdmin: string;
  sales: OpenSale[];
  approvals: SaleApprovalAccount[];
  /** Issuer PDA of each other Open sale (for IssuerFreeze), by sale address. */
  issuers: Map<string, Address | null>;
  /** Whether that issuer is frozen (finalized), by sale address; null when it could not be read. */
  frozen: Map<string, boolean | null>;
};

type Rpc = ReturnType<typeof useSolanaClient>["runtime"]["rpc"];

/**
 * Everything the check reads, fresh: every Open sale with its issuer and that
 * issuer's freeze (an unread freeze counts as not frozen: it never relaxes
 * the check), every SaleApproval and the Platform.
 */
async function readSnapshot(rpc: Rpc, thisApproval: Address | null): Promise<Snapshot> {
  const [sales, approvals, platform] = await Promise.all([listOpenSales(rpc), listAllSaleApprovals(rpc), readPlatformPause(rpc)]);
  if (!platform) throw new Error("Could not read the platform's pause flags.");
  const issuers = new Map<string, Address | null>();
  const frozen = new Map<string, boolean | null>();
  await Promise.all(
    sales.map(async (s) => {
      let issuer: Address | null = null;
      try {
        const sc = await fetchMaybeShareClass(rpc, s.shareClass, { commitment: "confirmed" });
        const asset = sc.exists ? await fetchMaybeAsset(rpc, sc.data.asset, { commitment: "confirmed" }) : null;
        issuer = asset?.exists ? asset.data.issuer : null;
      } catch {
        issuer = null;
      }
      issuers.set(s.address, issuer);
      try {
        frozen.set(s.address, issuer ? (await loadIssuerFreeze(rpc, issuer)) !== null : null);
      } catch {
        frozen.set(s.address, null);
      }
    }),
  );
  const nowSec = Math.floor(Date.now() / 1000);
  const result = preClearCheck({
    openSales: sales.map((s) => ({ ...s, frozen: frozen.get(s.address) ?? null })),
    approvals,
    thisApproval,
    nowSec,
  });
  return { result, flags: platform.flags, superAdmin: platform.superAdmin.toString(), sales, approvals, issuers, frozen };
}

export function PreClearCheck({ thisApproval, label, onChanged }: { thisApproval: Address | null; label: string; onChanged?: () => void }) {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const { isAdmin, isSuperAdmin } = useRole();
  const rpc = client.runtime.rpc;
  const session = conn.wallet;
  const wallet = session?.account.address ?? null;
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setSnap(await readSnapshot(rpc, thisApproval));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [rpc, thisApproval]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function revoke(a: SaleApprovalAccount) {
    if (!session || !wallet) return;
    setWorking(`Revoking the approval of sale #${a.saleId}…`);
    try {
      const signer = walletSigner(session);
      const ix = await getRevokeSaleApprovalInstructionAsync({ authority: signer, saleApproval: a.address, approvedBy: a.approvedBy });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.showTx(sig, { title: "Stray sale approval revoked" });
      void recordAudit({
        ix_name: "revoke_sale_approval",
        category: "launchpad",
        actor_wallet: wallet.toString(),
        reason: `Pre-clear check before reopening Primary issuance for ${label}: revoked a stray approval (sale #${a.saleId})`,
        target_label: a.address,
        tx_signature: sig,
        metadata: { share_class: a.shareClass, sale_id: a.saleId.toString(), approved_by: a.approvedBy },
      });
      // Its raise-limit reservation is released now when found (the retry worker does it otherwise).
      try {
        const rows = await listSaleReservations(session, { share_class: a.shareClass }, true, { interactive: false });
        const row = rows.find((r) => r.approval_pda === a.address && r.status === "reserved");
        if (row) await releaseSaleApproval(session, row.id, "revoked");
      } catch {
        /* the worker releases it once the closed account is visible */
      }
    } catch (err) {
      toast.showError("Revoke failed", explainSendError(err));
    } finally {
      setWorking(null);
      await load();
      onChanged?.();
    }
  }

  async function reopen() {
    if (!session || !wallet) return;
    setWorking("Checking again right before signing…");
    try {
      // The whole check again, fresh: something may have opened or been approved since the page loaded.
      const fresh = await readSnapshot(rpc, thisApproval);
      setSnap(fresh);
      if (!fresh.result.clear) throw new Error(fresh.result.problems.join(" "));
      if (!isPaused(fresh.flags, PAUSE_PRIMARY)) throw new Error("Primary issuance is already open.");
      if (fresh.superAdmin !== wallet.toString()) throw new Error("Only the super admin can reopen Primary issuance.");
      setWorking("Confirm in your wallet: reopen Primary issuance (clear 0x02)");
      const signer = walletSigner(session);
      const ix = await getSetPauseFlagsInstructionAsync({ authority: signer, setMask: 0, clearMask: PAUSE_PRIMARY });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      clearPauseFlagsCache();
      toast.showTx(sig, { title: "Primary issuance reopened" });
      void recordAudit({
        ix_name: "set_pause_flags",
        category: "platform",
        actor_wallet: wallet.toString(),
        reason: `Reopened Primary issuance for ${label} after the pre-clear check (Open sales taking buys 0, stray approvals 0)`,
        target_label: "Reopen primary issuance",
        tx_signature: sig,
        status: "success",
        metadata: {
          ...pauseAuditMetadata(0, PAUSE_PRIMARY, fresh.flags),
          pre_clear: {
            approval: thisApproval,
            other_open_sales: 0,
            stray_approvals: 0,
            // Open sales that cannot take a buy (ended, sold out, issuer frozen): a frozen one resumes if its freeze is lifted.
            idle_open_sales: fresh.result.idleOpenSales.map((s) => ({ sale: s.address, state: s.state })),
          },
        },
      });
    } catch (err) {
      toast.showError("Primary issuance not reopened", explainSendError(err));
    } finally {
      setWorking(null);
      await load();
      onChanged?.();
    }
  }

  async function closePrimary() {
    if (!session || !wallet) return;
    setWorking("Checking again right before signing…");
    try {
      const fresh = await readSnapshot(rpc, thisApproval);
      setSnap(fresh);
      if (isPaused(fresh.flags, PAUSE_PRIMARY)) throw new Error("Primary issuance is already closed.");
      const live = liveSales(fresh.sales, Math.floor(Date.now() / 1000));
      if (live.length > 0) {
        throw new Error(
          `${live.length} Open ${live.length === 1 ? "sale" : "sales"} can still take buys and ${live.length === 1 ? "needs" : "need"} Primary issuance; pause from /admin/platform if this is an emergency.`,
        );
      }
      setWorking("Confirm in your wallet: close Primary issuance again (set 0x02)");
      const signer = walletSigner(session);
      const ix = await getSetPauseFlagsInstructionAsync({ authority: signer, setMask: PAUSE_PRIMARY, clearMask: 0 });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      clearPauseFlagsCache();
      toast.showTx(sig, { title: "Primary issuance closed again" });
      void recordAudit({
        ix_name: "set_pause_flags",
        category: "platform",
        actor_wallet: wallet.toString(),
        reason: `Closed Primary issuance again before ${label} was opened (no sale taking buys)`,
        target_label: `Close ${formatPauseFlags(PAUSE_PRIMARY)} again`,
        tx_signature: sig,
        status: "success",
        metadata: { ...pauseAuditMetadata(PAUSE_PRIMARY, 0, fresh.flags), pre_clear: { approval: thisApproval } },
      });
    } catch (err) {
      toast.showError("Primary issuance not closed", explainSendError(err));
    } finally {
      setWorking(null);
      await load();
      onChanged?.();
    }
  }

  if (error) {
    return (
      <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        Pre-clear check unavailable: {error}{" "}
        <button type="button" onClick={() => void load()} className="font-medium underline">
          Try again
        </button>
      </p>
    );
  }
  if (!snap) return <p className="mt-2 text-xs text-slate-400">Running the pre-clear check…</p>;
  const { result, flags } = snap;
  const primaryOpen = !isPaused(flags, PAUSE_PRIMARY);
  const busy = working !== null || tx.isSending;

  return (
    <div className="mt-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700" aria-label="Pre-clear check">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-800">Pre-clear check (Primary issuance is platform-wide)</p>
        <button type="button" disabled={busy} onClick={() => void load()} className="text-slate-500 underline hover:text-slate-800 disabled:opacity-50">
          Run again
        </button>
      </div>
      <ul className="mt-1 space-y-1">
        <li className={result.otherOpenSales.length === 0 ? "text-emerald-800" : "text-red-700"}>
          {result.otherOpenSales.length === 0 ? "✓" : "✗"} Open sales that can still take buys: {result.otherOpenSales.length}
          {result.idleOpenSales.length > 0 ? ` (and ${result.idleOpenSales.length} Open that cannot)` : ""}
        </li>
        {snap.sales.map((s) => {
          const issuer = snap.issuers.get(s.address) ?? null;
          const idle = result.idleOpenSales.find((x) => x.address === s.address);
          const frozen = snap.frozen.get(s.address);
          return (
            <li key={s.address} className="ml-4">
              Sale <span className="font-mono">{shortAddress(s.address)}</span> · {s.sold.toString()} / {s.totalForSale.toString()} sold ·{" "}
              {idle ? (
                <span className="text-slate-500">{SALE_BUY_STATE_LABEL[idle.state]}</span>
              ) : (
                <span className="text-red-700">can take buys{frozen === null ? " (freeze state unreadable)" : ""}</span>
              )}
              {issuer && isAdmin && (
                <div className="mt-1">
                  <IssuerFreezePanel issuer={issuer} label={`issuer of sale ${shortAddress(s.address)}`} />
                </div>
              )}
            </li>
          );
        })}
        <li className={result.strayApprovals.length === 0 ? "text-emerald-800" : "text-red-700"}>
          {result.strayApprovals.length === 0 ? "✓" : "✗"} Live approvals other than this one: {result.strayApprovals.length}
        </li>
        {snap.approvals
          .filter((a) => result.strayApprovals.some((s) => s.address === a.address))
          .map((a) => (
            <li key={a.address} className="ml-4">
              Sale #{a.saleId.toString()} of class <span className="font-mono">{shortAddress(a.shareClass)}</span> · open by{" "}
              {new Date(Number(a.expiresAt) * 1000).toLocaleDateString("en-GB")}{" "}
              {isAdmin && (
                <button type="button" disabled={busy} onClick={() => void revoke(a)} className="font-medium text-red-700 underline disabled:opacity-50">
                  Revoke
                </button>
              )}
            </li>
          ))}
        <li className={result.thisApprovalLive ? "text-emerald-800" : "text-red-700"}>
          {result.thisApprovalLive ? "✓" : "✗"} This sale&apos;s approval is live
        </li>
        <li>Primary issuance (0x02): {primaryOpen ? "open" : "closed"}</li>
      </ul>
      {!primaryOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || !result.clear || !isSuperAdmin}
            onClick={() => void reopen()}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Reopen primary issuance
          </button>
          {!isSuperAdmin && <span className="text-slate-500">Only the super admin ({shortAddress(snap.superAdmin as Address)}) can reopen it.</span>}
          {isSuperAdmin && !result.clear && <span className="text-red-700">{result.problems[0]}</span>}
        </div>
      )}
      {primaryOpen && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <p className="text-slate-600">
            Open: the issuer can open the sale now. If it is not opened within the hour (the alarm fires after an hour with no sale
            taking buys), close it again; the super admin reopens it after this check.
          </p>
          {isAdmin && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void closePrimary()}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-800 hover:border-slate-400 disabled:opacity-50"
            >
              Close Primary issuance again (0x02)
            </button>
          )}
        </div>
      )}
      {working && (
        <p className="mt-1 text-slate-600" aria-live="polite">
          {working}
        </p>
      )}
    </div>
  );
}

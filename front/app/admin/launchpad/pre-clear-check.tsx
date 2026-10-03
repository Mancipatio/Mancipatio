"use client";

// The pre-clear check (design §4), right before the super admin reopens
// Primary issuance (clears 0x02) for an approved public sale. 0x02 is
// global: while it is clear, buys resume in every Open sale, every live
// SaleApproval (up to 90 days old) can be opened and an Admin issuer key can
// mint into its treasury — nothing on chain ties the clear to one sale. So:
//   · other issuers' Open sales must be 0 — or their issuer frozen
//     (IssuerFreeze: any Admin sets it, only the super admin lifts it; it
//     also stops that issuer's close_sale);
//   · live approvals must be 0 except this one — "Revoke" closes a stray one
//     (revoke_sale_approval, any Admin; the rent returns to its approver)
//     and releases its raise-limit reservation.
// "Reopen primary issuance" runs the whole check again inside the click,
// right before signing (lib/public-sale preClearCheck), and refuses unless it
// is clean. After the clear, the 1-hour "0x02 open with no sale Open" alarm
// (lib/server/alarm-checks primaryIdleReport) and the approve_sale alarm are
// the backstops.

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
import { isPaused, PAUSE_PRIMARY, pauseAuditMetadata } from "@/lib/pause-flags";
import { clearPauseFlagsCache } from "@/lib/pause-gate";
import { shortAddress } from "@/lib/share-transfer";
import { listOpenSales, readPlatformPause, type OpenSale } from "@/lib/distribution-chain";
import { listAllSaleApprovals, listSaleReservations, releaseSaleApproval, type SaleApprovalAccount } from "@/lib/sale-approvals";
import { preClearCheck, type PreClearResult } from "@/lib/public-sale";
import { IssuerFreezePanel } from "@/app/admin/issuers/issuer-freeze-panel";

type Snapshot = {
  result: PreClearResult;
  flags: number;
  superAdmin: string;
  sales: OpenSale[];
  approvals: SaleApprovalAccount[];
  /** Issuer PDA of each other Open sale (for IssuerFreeze), by sale address. */
  issuers: Map<string, Address | null>;
};

type Rpc = ReturnType<typeof useSolanaClient>["runtime"]["rpc"];

/** Everything the check reads, fresh. `thisSale`: an Open sale this clear is for (excluded from "other"). */
async function readSnapshot(rpc: Rpc, thisApproval: Address | null): Promise<Snapshot> {
  const [sales, approvals, platform] = await Promise.all([listOpenSales(rpc), listAllSaleApprovals(rpc), readPlatformPause(rpc)]);
  if (!platform) throw new Error("Could not read the platform's pause flags.");
  const nowSec = Math.floor(Date.now() / 1000);
  const result = preClearCheck({ openSales: sales, approvals, thisApproval, nowSec });
  const issuers = new Map<string, Address | null>();
  await Promise.all(
    sales.map(async (s) => {
      try {
        const sc = await fetchMaybeShareClass(rpc, s.shareClass, { commitment: "confirmed" });
        const asset = sc.exists ? await fetchMaybeAsset(rpc, sc.data.asset, { commitment: "confirmed" }) : null;
        issuers.set(s.address, asset?.exists ? asset.data.issuer : null);
      } catch {
        issuers.set(s.address, null);
      }
    }),
  );
  return { result, flags: platform.flags, superAdmin: platform.superAdmin.toString(), sales, approvals, issuers };
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
        reason: `Reopened Primary issuance for ${label} after the pre-clear check (other Open sales 0, stray approvals 0)`,
        target_label: "Reopen primary issuance",
        tx_signature: sig,
        status: "success",
        metadata: { ...pauseAuditMetadata(0, PAUSE_PRIMARY, fresh.flags), pre_clear: { approval: thisApproval, other_open_sales: 0, stray_approvals: 0 } },
      });
    } catch (err) {
      toast.showError("Primary issuance not reopened", explainSendError(err));
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
      <p className="font-semibold text-slate-800">Pre-clear check (Primary issuance is platform-wide)</p>
      <ul className="mt-1 space-y-1">
        <li className={result.otherOpenSales.length === 0 ? "text-emerald-800" : "text-red-700"}>
          {result.otherOpenSales.length === 0 ? "✓" : "✗"} Other Open sales: {result.otherOpenSales.length}
        </li>
        {snap.sales.map((s) => {
          const issuer = snap.issuers.get(s.address) ?? null;
          return (
            <li key={s.address} className="ml-4">
              Sale <span className="font-mono">{shortAddress(s.address)}</span> · {s.sold.toString()} / {s.totalForSale.toString()} sold
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
        <p className="mt-2 text-slate-600">
          Open: the issuer can open the sale now. Set it again once the sale closes (or if it is not opened within the hour —
          the alarm fires after an hour with no sale Open).
        </p>
      )}
      {working && (
        <p className="mt-1 text-slate-600" aria-live="polite">
          {working}
        </p>
      )}
    </div>
  );
}

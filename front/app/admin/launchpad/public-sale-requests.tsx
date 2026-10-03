"use client";

// The operator's side of Distribute → Public sale (design §4), on
// /admin/launchpad:
//
//   Requests   every public-sale request waiting for the operator, with the
//              document (✓ when it is the token's own, by its on-chain hash),
//              the offering clearance on mainnet (an SSC-approved whitepaper
//              or the offering exemption the super admin records once per
//              asset — the reserve route refuses without it), the raise
//              limit left, and whether this wallet holds the Admin record
//              approve_sale needs. "Approve sale" opens the approval modal
//              prefilled from the request (reserve → approve_sale → confirm:
//              nothing to type); "Decline" records a reason.
//   Approved   the pre-clear check and "Reopen primary issuance" (super
//              admin), then the issuer opens the sale from its asset page.
//   Proceeds   every Open sale with Primary issuance and issuer proceeds
//              (0x02 / 0x20): the super admin clears 0x20 when an issuer
//              ends its sale; once no sale is Open any Admin sets 0x20 and
//              0x02 again in one transaction.

import { useCallback, useEffect, useState } from "react";
import type { Address } from "@solana/kit";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { fetchMaybeAdmin, findAdminRecordPda, getSetPauseFlagsInstructionAsync } from "@/lib/generated/asset_registry";
import { useRole } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { recordAudit } from "@/lib/supabase";
import { walletSigner } from "@/lib/wallet-signer";
import { detectNetwork } from "@/lib/network";
import { formatPauseFlags, isPaused, PAUSE_ISSUER_PROCEEDS, PAUSE_PRIMARY, pauseAuditMetadata } from "@/lib/pause-flags";
import { clearPauseFlagsCache } from "@/lib/pause-gate";
import { shortAddress } from "@/lib/share-transfer";
import { formatTokens } from "@/lib/tokenize-shares";
import { listOpenSales, readPlatformPause, type OpenSale } from "@/lib/distribution-chain";
import {
  isApprovalLive,
  listAllSaleApprovals,
  listShareClassSaleApprovals,
  saleCapacityFor,
  type Capacity,
  type SaleApprovalAccount,
} from "@/lib/sale-approvals";
import { approvalPrefill, formatUsdc, maxGrossRaise, repauseMask, type ApprovalPrefill } from "@/lib/public-sale";
import { decideSaleRequest, listSaleRequests, type SaleRequestRow } from "@/lib/sale-requests";
import { ConfirmModal } from "@/components/confirm-modal";
import { ApproveSaleModal } from "@/app/admin/applications/sale-approvals";
import { PreClearCheck } from "./pre-clear-check";

const eur = (n: number) => `€${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function documentUrl(path: string): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  return base ? `${base}/storage/v1/object/public/documents/${path.split("/").map(encodeURIComponent).join("/")}` : null;
}

export function PublicSaleRequests() {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const toast = useToast();
  const role = useRole();
  const rpc = client.runtime.rpc;
  const session = conn.wallet;
  const wallet = session?.account.address ?? null;
  const [rows, setRows] = useState<SaleRequestRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [approvals, setApprovals] = useState<Map<string, SaleApprovalAccount[]>>(new Map());
  const [capacity, setCapacity] = useState<Map<string, Capacity | string>>(new Map());
  const [hasAdminRecord, setHasAdminRecord] = useState<boolean | null>(null);
  const [approve, setApprove] = useState<ApprovalPrefill | null>(null);
  const [decline, setDecline] = useState<SaleRequestRow | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = useCallback(
    async (interactive: boolean) => {
      if (!session) return;
      try {
        const data = await listSaleRequests(session, { pending: true }, { interactive });
        setRows(data);
        setError(null);
        setNeedsSignIn(false);
        const byClass = new Map<string, SaleApprovalAccount[]>();
        const caps = new Map<string, Capacity | string>();
        await Promise.all(
          data.map(async (r) => {
            if (!r.request) return;
            const sc = r.request.share_class;
            try {
              // Newest first: the approval this request got; any other live one is a stray for the pre-clear check.
              byClass.set(
                sc,
                (await listShareClassSaleApprovals(rpc, sc as Address))
                  .filter((a) => isApprovalLive(a))
                  .sort((a, b) => (b.saleId > a.saleId ? 1 : b.saleId < a.saleId ? -1 : 0)),
              );
            } catch {
              byClass.set(sc, []);
            }
            try {
              caps.set(sc, (await saleCapacityFor(session, sc)).capacity);
            } catch (err) {
              caps.set(sc, err instanceof Error ? err.message : "unavailable");
            }
          }),
        );
        setApprovals(byClass);
        setCapacity(caps);
      } catch (err) {
        if (!interactive) setNeedsSignIn(true);
        else setError(err instanceof Error ? err.message : String(err));
      }
    },
    [session, rpc],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(false);
  }, [load, refreshKey]);

  // approve_sale needs an Admin record for the signer (the super admin too).
  useEffect(() => {
    if (!wallet) return;
    let cancelled = false;
    void (async () => {
      try {
        const [pda] = await findAdminRecordPda({ authority: wallet });
        const record = await fetchMaybeAdmin(rpc, pda, { commitment: "confirmed" });
        if (!cancelled) setHasAdminRecord(record.exists);
      } catch {
        if (!cancelled) setHasAdminRecord(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, wallet]);

  async function declineRequest(row: SaleRequestRow, reason: string) {
    if (!session || !row.request) return;
    try {
      await decideSaleRequest(session, { share_class: row.request.share_class, request_id: row.request.id, action: "decline", reason });
      toast.show({ kind: "info", title: "Request declined" });
      setDecline(null);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      toast.showError("Decline failed", err instanceof Error ? err.message : String(err));
    }
  }

  const mainnet = detectNetwork() === "mainnet";

  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-slate-800">Public sale requests</p>
        <button type="button" onClick={() => setRefreshKey((k) => k + 1)} className="text-xs text-slate-500 hover:text-slate-800">
          Refresh
        </button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Issuers ask from Distribute → Public sale. Approve (3 confirmations: reserve, approve_sale, confirm), run the pre-clear check
        and reopen Primary issuance; the issuer then opens the sale. Purchases are final (Mature, no refunds), USDC only.
      </p>
      {hasAdminRecord === false && (
        <p className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          This wallet has no Admin record: approve_sale would be refused on chain. Approve with a wallet that holds one (the super
          admin needs its own Admin record), and keep it live until the sale opens.
        </p>
      )}
      {needsSignIn && (
        <p className="mt-2 text-xs text-slate-500">
          The requests need a sign-in.{" "}
          <button type="button" onClick={() => void load(true)} className="font-medium underline">
            Show them
          </button>
        </p>
      )}
      {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      {rows !== null && rows.length === 0 && <p className="mt-2 text-xs text-slate-500">No request waiting.</p>}
      <ul className="mt-2 space-y-3">
        {(rows ?? []).map((row) => {
          const r = row.request;
          if (!r) return null;
          const live = approvals.get(r.share_class) ?? [];
          const thisApproval = live[0] ?? null;
          const cap = capacity.get(r.share_class);
          const gross = maxGrossRaise(BigInt(r.tokens), BigInt(r.price_per_unit));
          const url = documentUrl(r.document.path);
          return (
            <li key={r.id} className="rounded-md border border-slate-200 px-3 py-2 text-xs text-slate-700">
              <p className="text-sm font-medium text-slate-900">
                {row.display_name ?? "Asset"} <span className="font-mono text-[11px] text-slate-500">{shortAddress(row.asset as Address)}</span>
              </p>
              <p className="mt-1">
                {formatTokens(BigInt(r.tokens))} tokens × {formatUsdc(BigInt(r.price_per_unit))} USDC = up to {formatUsdc(gross)} USDC ·{" "}
                {r.duration_days} days · requested {new Date(r.requested_at).toLocaleString("en-GB")} by{" "}
                <span className="font-mono">{shortAddress(r.requested_by as Address)}</span>
              </p>
              <p className="mt-1">
                Document: {r.document.matches_legal_doc ? "✓ the token's own (matches its on-chain hash)" : "a separate offering document"}
                {url && (
                  <>
                    {" "}·{" "}
                    <a href={url} target="_blank" rel="noreferrer" className="underline">
                      read it
                    </a>
                  </>
                )}
              </p>
              {mainnet && row.clearance && (
                <p className={`mt-1 ${row.clearance.cleared ? "text-emerald-800" : "text-red-700"}`}>
                  {row.clearance.cleared
                    ? `Offering cleared (${row.clearance.basis === "exemption" ? "exemption" : "SSC approval"}${"ref" in row.clearance ? `: ${row.clearance.ref}` : ""}).`
                    : `Offering not cleared: ${row.clearance.reason} `}
                  {!row.clearance.cleared && (
                    <a href={`/admin/assets/${row.asset}`} className="font-medium underline">
                      Record the offering exemption (super admin, once per asset) →
                    </a>
                  )}
                </p>
              )}
              <p className="mt-1">
                Raise limit:{" "}
                {cap === undefined ? "…" : typeof cap === "string" ? cap : `${eur(cap.remaining)} left of ${eur(cap.cap)} (rolling 12 months)`}
              </p>
              {thisApproval ? (
                <>
                  <p className="mt-1 text-emerald-800">
                    Approved: sale #{thisApproval.saleId.toString()}, open by {new Date(Number(thisApproval.expiresAt) * 1000).toLocaleDateString("en-GB")}.
                  </p>
                  <PreClearCheck
                    thisApproval={thisApproval.address}
                    label={`the public sale of ${row.display_name ?? shortAddress(row.asset as Address)}`}
                    onChanged={() => setRefreshKey((k) => k + 1)}
                  />
                </>
              ) : (
                <div className="mt-2 flex flex-wrap gap-3">
                  {role.isSuperAdmin ? (
                    <button
                      type="button"
                      disabled={mainnet && row.clearance?.cleared === false}
                      onClick={() => setApprove(approvalPrefill(r))}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                    >
                      Approve sale
                    </button>
                  ) : (
                    <span className="text-slate-500">The super admin approves public sales (no application).</span>
                  )}
                  {role.isAdmin && (
                    <button type="button" onClick={() => setDecline(row)} className="text-red-700 underline">
                      Decline
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <ProceedsAndPause refreshKey={refreshKey} />

      {approve && (
        <ApproveSaleModal
          app={null}
          session={session}
          adminWallet={wallet ?? ""}
          toast={toast}
          rpc={rpc}
          prefill={approve}
          onClose={() => setApprove(null)}
          onDone={() => {
            setApprove(null);
            setRefreshKey((k) => k + 1);
          }}
        />
      )}
      <ConfirmModal
        open={decline !== null}
        onClose={() => setDecline(null)}
        onConfirm={(reason) => (decline ? declineRequest(decline, reason) : undefined)}
        title="Decline the public sale request"
        kind="warning"
        confirmLabel="Decline"
        reasonMinLength={5}
        reasonPlaceholder="Why (the issuer sees it)"
        description={<p>The issuer sees the reason and can send a new request.</p>}
      />
    </div>
  );
}

/**
 * Every Open sale with the two platform bits a sale's end turns on: the super
 * admin clears issuer proceeds (0x20) so an issuer can end and collect; once
 * no sale is Open, any Admin sets 0x20 and Primary issuance (0x02) again in
 * one transaction (an issuer whose key is an Admin does it in its close).
 */
function ProceedsAndPause({ refreshKey }: { refreshKey: number }) {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const { isAdmin, isSuperAdmin } = useRole();
  const rpc = client.runtime.rpc;
  const session = conn.wallet;
  const wallet = session?.account.address ?? null;
  const [state, setState] = useState<{ sales: OpenSale[]; flags: number; superAdmin: string; liveApprovals: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [sales, platform, approvals] = await Promise.all([listOpenSales(rpc), readPlatformPause(rpc), listAllSaleApprovals(rpc)]);
        if (!platform) throw new Error("Could not read the platform's pause flags.");
        if (!cancelled) {
          setState({
            sales,
            flags: platform.flags,
            superAdmin: platform.superAdmin.toString(),
            liveApprovals: approvals.filter((a) => isApprovalLive(a)).length,
          });
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, refreshKey, tick]);

  async function setFlags(setMask: number, clearMask: number, reason: string) {
    if (!session || !wallet || !state) return;
    try {
      // Read again right before signing: a sale may have opened or closed since.
      const [sales, platform] = await Promise.all([listOpenSales(rpc), readPlatformPause(rpc)]);
      if (!platform) throw new Error("Could not read the platform's pause flags.");
      if (setMask !== 0 && sales.length > 0) throw new Error("A sale is Open: it needs Primary issuance and proceeds open until it closes.");
      const signer = walletSigner(session);
      const ix = await getSetPauseFlagsInstructionAsync({ authority: signer, setMask, clearMask });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      clearPauseFlagsCache();
      toast.showTx(sig, { title: reason });
      void recordAudit({
        ix_name: "set_pause_flags",
        category: "platform",
        actor_wallet: wallet.toString(),
        reason,
        target_label: reason,
        tx_signature: sig,
        status: "success",
        metadata: pauseAuditMetadata(setMask, clearMask, platform.flags),
      });
    } catch (err) {
      toast.showError(`${reason}: failed`, explainSendError(err));
    } finally {
      setTick((t) => t + 1);
    }
  }

  if (error) return <p className="mt-3 text-xs text-amber-700">Open sales unavailable: {error}</p>;
  if (!state) return null;
  // With no sale Open: 0x20 again, and 0x02 unless an approved sale waits to be opened (its window).
  const repause = state.sales.length === 0 ? repauseMask(state.flags, 0) & (state.liveApprovals > 0 ? ~PAUSE_PRIMARY : 0xff) : 0;
  return (
    <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-700">
      <p className="font-semibold text-slate-800">Open sales and proceeds</p>
      <p className="mt-1">
        Platform: {formatPauseFlags(state.flags)} · {state.sales.length} Open {state.sales.length === 1 ? "sale" : "sales"} ·{" "}
        {state.liveApprovals} live {state.liveApprovals === 1 ? "approval" : "approvals"} not opened
      </p>
      <ul className="mt-1 space-y-0.5">
        {state.sales.map((s) => (
          <li key={s.address}>
            <a href={`/marketplace/launchpad/${s.address}`} className="font-mono underline">
              {shortAddress(s.address)}
            </a>{" "}
            · {s.sold.toString()} / {s.totalForSale.toString()} sold
          </li>
        ))}
      </ul>
      <div className="mt-2 flex flex-wrap gap-3">
        {state.sales.length > 0 && isPaused(state.flags, PAUSE_ISSUER_PROCEEDS) && isSuperAdmin && (
          <button
            type="button"
            disabled={tx.isSending}
            onClick={() => void setFlags(0, PAUSE_ISSUER_PROCEEDS, "Let issuers end and collect (clear 0x20)")}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Let issuers end and collect (clear 0x20)
          </button>
        )}
        {state.sales.length > 0 && isPaused(state.flags, PAUSE_ISSUER_PROCEEDS) && !isSuperAdmin && (
          <span className="text-slate-500">Only the super admin ({shortAddress(state.superAdmin as Address)}) clears 0x20 for an issuer to collect.</span>
        )}
        {repause !== 0 && isAdmin && (
          <button
            type="button"
            disabled={tx.isSending}
            onClick={() => void setFlags(repause, 0, `Close ${formatPauseFlags(repause)} again (no sale Open)`)}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-800 hover:border-slate-400 disabled:opacity-50"
          >
            Close {formatPauseFlags(repause)} again (no sale is Open)
          </button>
        )}
      </div>
    </div>
  );
}

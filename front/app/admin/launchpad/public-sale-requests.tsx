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
//   Approved   the approval reserved for THIS request (the ledger's
//              reservation, never just the class's newest approval: one an
//              Admin key signed directly is a stray), the pre-clear check and
//              "Reopen primary issuance" (super admin), then the issuer opens
//              the sale from its asset page. Once the class has an Open sale,
//              or the reserved approval is gone, neither "Approve sale" nor
//              "Decline" is offered (the request leaves the list as soon as
//              the server sees its sale on chain).
//   Proceeds   every Open sale with Primary issuance and issuer proceeds
//              (0x02 / 0x20): the super admin clears 0x20 when an issuer
//              ends its sale; once no Open sale can take a buy (ended, sold
//              out or its issuer frozen; an unread freeze never hides the
//              offer) any Admin sets 0x02 again (with live approvals waiting
//              too: the super admin reopens it after the pre-clear check),
//              and 0x20 with it once no sale is Open at all.

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
import { approvalPrefill, formatUsdc, maxGrossRaise, primaryCloseRefusal, repausePlan, type ApprovalPrefill } from "@/lib/public-sale";
import { FREEZE_UNREAD_LABEL, nowSeconds, saleBuyState, SALE_BUY_STATE_LABEL } from "@/lib/sale-liveness";
import { listOpenSalesWithFreezes, type OpenSaleWithFreeze } from "@/lib/open-sales-chain";
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
  /** Open sales by share class (null: not read). */
  const [openByClass, setOpenByClass] = useState<Map<string, OpenSale[]> | null>(null);
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
        const openSales = await listOpenSales(rpc).catch(() => null);
        await Promise.all(
          data.map(async (r) => {
            if (!r.request) return;
            const sc = r.request.share_class;
            try {
              // Newest first. The one this request got is its reservation's approval; any other live one is a stray.
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
        if (openSales) {
          const open = new Map<string, OpenSale[]>();
          for (const s of openSales) open.set(s.shareClass, [...(open.get(s.shareClass) ?? []), s]);
          setOpenByClass(open);
        } else {
          setOpenByClass(null);
        }
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
          // The approval reserved for THIS request (the ledger), never just the class's newest live one.
          const reserved = row.outcome === "approved" ? (row.reservation ?? null) : null;
          const thisApproval = reserved?.approval_pda ? (live.find((a) => a.address === reserved.approval_pda) ?? null) : null;
          const classStrays = live.filter((a) => a.address !== thisApproval?.address);
          const classOpen = openByClass?.get(r.share_class) ?? [];
          const ownOpen = reserved?.sale_pda ? classOpen.find((s) => s.address === reserved.sale_pda) : undefined;
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
              {ownOpen ? (
                <p className="mt-1 text-emerald-800">
                  Opened: sale{" "}
                  <a href={`/marketplace/launchpad/${ownOpen.address}`} className="font-mono underline">
                    {shortAddress(ownOpen.address)}
                  </a>{" "}
                  is Open. The request leaves this list once the server sees it (Refresh).
                </p>
              ) : thisApproval ? (
                <>
                  <p className="mt-1 text-emerald-800">
                    Approved: sale #{thisApproval.saleId.toString()}, open by {new Date(Number(thisApproval.expiresAt) * 1000).toLocaleDateString("en-GB")}.
                  </p>
                  {classStrays.length > 0 && (
                    <p className="mt-1 text-red-700">
                      {classStrays.length} other live {classStrays.length === 1 ? "approval" : "approvals"} of this class{" "}
                      {classStrays.length === 1 ? "was" : "were"} not reserved for this request (sale #
                      {classStrays.map((a) => a.saleId.toString()).join(", #")}): {classStrays.length === 1 ? "a stray" : "strays"} to revoke
                      below.
                    </p>
                  )}
                  <PreClearCheck
                    thisApproval={thisApproval.address}
                    label={`the public sale of ${row.display_name ?? shortAddress(row.asset as Address)}`}
                    onChanged={() => setRefreshKey((k) => k + 1)}
                  />
                </>
              ) : reserved ? (
                <p className="mt-1 text-amber-800">
                  Approved{reserved.sale_id ? ` (sale #${reserved.sale_id})` : ""}, but its approval is no longer on chain: opened,
                  expired or revoked. The ledger catches up within minutes (Refresh); nothing to approve again meanwhile.
                </p>
              ) : classOpen.length > 0 ? (
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <span className="text-amber-800">
                    A sale of this class is Open ({shortAddress(classOpen[0].address)}): no second sale is approved while it runs.
                  </span>
                  {role.isAdmin && (
                    <button type="button" onClick={() => setDecline(row)} className="text-red-700 underline">
                      Decline
                    </button>
                  )}
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap gap-3">
                  {live.length > 0 && (
                    <p className="w-full text-red-700">
                      {live.length} live {live.length === 1 ? "approval" : "approvals"} of this class (sale #
                      {live.map((a) => a.saleId.toString()).join(", #")}) {live.length === 1 ? "was" : "were"} not reserved for this request
                      (e.g. approve_sale signed directly by an Admin key): the pre-clear check counts {live.length === 1 ? "it" : "them"} as{" "}
                      {live.length === 1 ? "a stray" : "strays"} to revoke.
                    </p>
                  )}
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
 * admin clears issuer proceeds (0x20) so an issuer can end and collect. Once
 * no Open sale can take a buy (ended or sold out ones only wait to be
 * closed, a frozen issuer's take none; lib/sale-liveness), any Admin sets
 * Primary issuance (0x02) again — also while approvals wait to be opened or
 * an issuer's freeze could not be read (both said next to the button) — and,
 * once no sale is Open at all, 0x20 with it in one transaction (an issuer
 * whose key is an Admin does it in its close). lib/public-sale repausePlan;
 * the sales and freezes come from lib/open-sales-chain.
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
  const [state, setState] = useState<{
    sales: OpenSaleWithFreeze[];
    flags: number;
    superAdmin: string;
    liveApprovals: number;
    nowSec: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [sales, platform, approvals] = await Promise.all([
          listOpenSalesWithFreezes(rpc),
          readPlatformPause(rpc),
          listAllSaleApprovals(rpc),
        ]);
        if (!platform) throw new Error("Could not read the platform's pause flags.");
        if (!cancelled) {
          setState({
            sales,
            flags: platform.flags,
            superAdmin: platform.superAdmin.toString(),
            liveApprovals: approvals.filter((a) => isApprovalLive(a)).length,
            nowSec: nowSeconds(),
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
      // Read again right before signing: a sale may have opened or closed, or an issuer been frozen or unfrozen, since.
      const [sales, platform] = await Promise.all([listOpenSalesWithFreezes(rpc), readPlatformPause(rpc)]);
      if (!platform) throw new Error("Could not read the platform's pause flags.");
      const refusal = (setMask & PAUSE_PRIMARY) !== 0 ? primaryCloseRefusal(sales, nowSeconds()) : null;
      if (refusal) throw new Error(refusal);
      if ((setMask & PAUSE_ISSUER_PROCEEDS) !== 0 && sales.length > 0) {
        throw new Error("A sale is Open: its issuer needs issuer proceeds (0x20) clear to close it.");
      }
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
  // 0x02 once no Open sale can take a buy (approvals waiting or not: the safe default is closed); 0x20 once none is Open.
  const { nowSec } = state;
  const plan = repausePlan({ flags: state.flags, sales: state.sales, nowSec, liveApprovals: state.liveApprovals });
  const repause = plan.mask;
  return (
    <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-700">
      <p className="font-semibold text-slate-800">Open sales and proceeds</p>
      <p className="mt-1">
        Platform: {formatPauseFlags(state.flags)} · {state.sales.length} Open {state.sales.length === 1 ? "sale" : "sales"} ·{" "}
        {state.liveApprovals} live {state.liveApprovals === 1 ? "approval" : "approvals"} not opened
      </p>
      <ul className="mt-1 space-y-0.5">
        {state.sales.map((s) => {
          const buy = saleBuyState(s, nowSec, s.frozen);
          return (
            <li key={s.address}>
              <a href={`/marketplace/launchpad/${s.address}`} className="font-mono underline">
                {shortAddress(s.address)}
              </a>{" "}
              · {s.sold.toString()} / {s.totalForSale.toString()} sold
              {buy !== "live" && <span className="text-slate-500"> · {SALE_BUY_STATE_LABEL[buy]}</span>}
              {buy === "live" && s.frozen === null && <span className="text-amber-800"> · {FREEZE_UNREAD_LABEL}</span>}
            </li>
          );
        })}
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
            onClick={() =>
              void setFlags(repause, 0, `Close ${formatPauseFlags(repause)} again (${state.sales.length === 0 ? "no sale Open" : "no sale taking buys"})`)
            }
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-800 hover:border-slate-400 disabled:opacity-50"
          >
            Close {formatPauseFlags(repause)} again ({state.sales.length === 0 ? "no sale is Open" : "no sale can take buys"})
          </button>
        )}
      </div>
      {repause !== 0 && plan.warning && <p className="mt-1 text-amber-800">{plan.warning}</p>}
    </div>
  );
}

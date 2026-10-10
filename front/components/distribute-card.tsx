"use client";

// Distribute (the tokenize checklist's fourth step): how tokens reach their
// holders, with the allocation of the capped supply on one line.
//
// Three ways (MODES): "Send to wallets" (components/send-to-wallets-panel),
// "Public sale" (components/public-sale-panel) and "Both" — a list sent
// directly and a public sale for the rest (design §5). In Both the sale
// offers what the list leaves: its default is the room minus what the list
// must create (lib/distribution-supply shortfall), and the order is request →
// approval (Primary issuance reopened) → the list's top-up and sends (0x02
// stays open for the approved sale) → open the sale.
//
// The allocation is counted from `lifetime_minted` (lib/distribution-supply):
// in the treasury · sent or sold · on sale · approved for a sale not opened
// yet · not created yet · cap. The treasury-mint reservations still pending
// are read within an existing wallet session only (no prompt here); the
// panels read everything fresh before they create or offer a token.

import { useEffect, useMemo, useState } from "react";
import type { Address } from "@solana/kit";
import { useWalletConnection } from "@solana/react-hooks";
import type { Asset, ShareClass } from "@/lib/generated/asset_registry";
import { formatTokens } from "@/lib/tokenize-shares";
import { allocation, approximateFigures, shortfall, type AllocationFigure, type SupplyFacts } from "@/lib/distribution-supply";
import { listSaleReservations, reservedTreasuryUnits, type SaleApprovalAccount } from "@/lib/sale-approvals";
import { approvalUnits } from "@/lib/public-sale";
import type { HookMode } from "@/lib/tokenize-shares-chain";
import { SendToWalletsPanel } from "@/components/send-to-wallets-panel";
import { PublicSalePanel } from "@/components/public-sale-panel";
import { PrimaryReopenLink } from "@/components/primary-reopen-link";
import { APPROVED_SALE_HOLDS_ROOM, BOTH_MODE_STEPS, roomHeldByApprovedSale } from "@/lib/distribute-guidance";
import { scopeEnabled } from "@/lib/features";

export type DistributionMode = "wallets" | "sale" | "both";

/** The ways tokens reach holders. */
export const DISTRIBUTION_MODES: readonly { id: DistributionMode; label: string }[] = [
  { id: "wallets", label: "Send to wallets" },
  { id: "sale", label: "Public sale" },
  { id: "both", label: "Both" },
];

export function DistributeCard({
  asset,
  sc,
  scPda,
  hook,
  tokenize,
  treasuryBalance,
  openSaleRemaining,
  approvals,
  canCreate,
  publishedDocument = null,
  onRefresh,
}: {
  asset: Asset;
  sc: ShareClass;
  scPda: Address;
  hook: HookMode | null;
  /** `fields.tokenize` of the private profile (each row's share of the company), or null. */
  tokenize: Record<string, unknown> | null;
  /** The issuer treasury's balance; null when unknown. */
  treasuryBalance: bigint | null;
  /** Σ(total − sold) of the class's Open sales; null when unknown. */
  openSaleRemaining: bigint | null;
  /** Live sale approvals of the class not opened yet; null when unknown. */
  approvals: readonly SaleApprovalAccount[] | null;
  /** The connected issuer key may create tokens (an Admin issuer key: mint_to_treasury). */
  canCreate: boolean;
  /** The asset's published buyer document, when it has one. */
  publishedDocument?: { path: string; sha256: string } | null;
  onRefresh: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const session = conn.wallet;
  // KYC-only mode (lib/features.ts): a non-admin issuer's "Send to wallets"
  // is an issuance entry (api/compliance screen-recipients answers 403), so
  // only the public sale tab stays: its panel keeps the exits of a sale
  // (withdraw the request, end the sale and collect) and hides its entries
  // itself. An Admin issuer key (canCreate: the operator) keeps "Send to
  // wallets", as the route does; a mint it needs is still refused before the
  // wallet (lib/pause-gate.ts KYC_ONLY_FLOWS).
  const walletsOn = scopeEnabled("issuance") || canCreate;
  const modes = scopeEnabled("issuance")
    ? DISTRIBUTION_MODES
    : DISTRIBUTION_MODES.filter((m) => m.id === "sale" || (walletsOn && m.id === "wallets"));
  const [chosenMode, setMode] = useState<DistributionMode>(() => (walletsOn ? "wallets" : "sale"));
  // Always one of the tabs shown (canCreate is read after the first render).
  const mode: DistributionMode = modes.some((m) => m.id === chosenMode) ? chosenMode : modes[0].id;
  /** Units of pending treasury-mint reservations; null until read (or when no session). */
  const [reserved, setReserved] = useState<bigint | null>(null);
  /** Both: the wallet list's total (what it takes from the treasury, then the room). */
  const [listTotal, setListTotal] = useState<bigint>(BigInt(0));

  useEffect(() => {
    if (!session || !canCreate) return;
    let cancelled = false;
    void listSaleReservations(session, { share_class: scPda }, true, { interactive: false })
      .then((rows) => {
        if (!cancelled) setReserved(reservedTreasuryUnits(rows));
      })
      .catch(() => {
        if (!cancelled) setReserved(null);
      });
    return () => {
      cancelled = true;
    };
  }, [session, scPda, canCreate, sc.lifetimeMinted]);

  const supply: SupplyFacts = useMemo(
    () => ({
      maxSupply: sc.maxSupply.__option === "Some" ? sc.maxSupply.value : null,
      lifetimeMinted: sc.lifetimeMinted,
      version: sc.version,
      supplyLocked: sc.supplyLocked,
      mintablePostLaunch: sc.mintablePostLaunch,
      openSaleRemaining: openSaleRemaining ?? BigInt(0),
      reservedUnminted: reserved ?? BigInt(0),
      approvedUnopened: (approvals ?? []).reduce((sum, a) => sum + approvalUnits(a), BigInt(0)),
      treasuryBalance: treasuryBalance ?? BigInt(0),
    }),
    [sc, openSaleRemaining, reserved, approvals, treasuryBalance],
  );
  const a = allocation(supply);
  // "(approximate)" only next to the figures an unread input affects.
  const approx = new Set<AllocationFigure>(
    approximateFigures({
      treasury: treasuryBalance !== null,
      openSales: openSaleRemaining !== null,
      reservations: reserved !== null && approvals !== null,
    }),
  );
  const approxNote = (f: AllocationFigure) => (approx.has(f) ? <span className="text-slate-400"> (approximate)</span> : null);
  // Both: the sale offers what the list leaves (the list's top-up comes out of the room first).
  const reserveForList = mode === "both" ? shortfall(listTotal, treasuryBalance ?? BigInt(0)) : BigInt(0);

  const salePanel = (
    <PublicSalePanel
      asset={asset}
      sc={sc}
      scPda={scPda}
      tokenize={tokenize}
      supply={supply}
      canCreate={canCreate}
      onRefresh={onRefresh}
      reserveForList={reserveForList}
      publishedDocument={publishedDocument}
    />
  );
  const walletsPanel = (
    <SendToWalletsPanel
      asset={asset}
      sc={sc}
      scPda={scPda}
      hook={hook}
      tokenize={tokenize}
      supply={supply}
      reservationsKnown={reserved !== null}
      canCreate={canCreate}
      onRefresh={onRefresh}
      onListTotal={mode === "both" ? setListTotal : undefined}
    />
  );

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <p className="text-[12px] text-slate-600" aria-label="Allocation of the supply">
        In treasury <Figure n={a.inTreasury} />
        {approxNote("inTreasury")} · Sent <Figure n={a.out} />
        {approxNote("out")}
        {(a.onSale > BigInt(0) || approx.has("onSale")) && (
          <>
            {" "}· On sale <Figure n={a.onSale} />
            {approxNote("onSale")}
          </>
        )}
        {a.approved > BigInt(0) && (
          <>
            {" "}· Approved for sale <Figure n={a.approved} />
          </>
        )}{" "}
        · Not created {a.notCreated === null ? "—" : <Figure n={a.notCreated} />}
        {approxNote("notCreated")} · Cap {a.cap === null ? "none" : <Figure n={a.cap} />}
      </p>
      {roomHeldByApprovedSale(supply) && <p className="mt-1 text-[12px] text-amber-800">{APPROVED_SALE_HOLDS_ROOM}</p>}

      <div role="tablist" className="mt-3 flex gap-2">
        {modes.map((m) => (
          <button
            key={m.id}
            role="tab"
            type="button"
            aria-selected={mode === m.id}
            onClick={() => setMode(m.id)}
            className={`rounded-md px-3 py-1 text-xs font-medium ${
              mode === m.id ? "bg-slate-900 text-white" : "border border-slate-300 text-slate-700 hover:border-slate-400"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>

      {mode === "wallets" && walletsPanel}
      {mode === "sale" && salePanel}
      {mode === "both" && (
        <>
          <div className="mt-3 text-[12px] text-slate-600" aria-label="Order">
            <p>A list of wallets gets its tokens directly; a public sale offers the rest. Order:</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              {BOTH_MODE_STEPS.map((step, i) => (
                <li key={step}>
                  {step}
                  {i === 1 && (
                    <>
                      {" "}
                      <PrimaryReopenLink publicSale />
                    </>
                  )}
                </li>
              ))}
            </ol>
          </div>
          <section aria-label="Public sale" className="mt-3 border-t border-slate-200 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Public sale (the rest)</p>
            {salePanel}
          </section>
          <section aria-label="Send to wallets" className="mt-3 border-t border-slate-200 pt-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Send to wallets</p>
            {walletsPanel}
          </section>
        </>
      )}
    </div>
  );
}

function Figure({ n }: { n: bigint }) {
  return <span className="font-mono text-slate-900">{formatTokens(n)}</span>;
}

"use client";

// Distribute (the tokenize checklist's fourth step): how tokens reach their
// holders, with the allocation of the capped supply on one line.
//
// One way today — "Send to wallets" (components/send-to-wallets-panel). The
// modes are a registry: "Public sale" and "Both" join MODES in the next
// change and get their own panels; with a single mode no tabs are drawn
// (no disabled placeholders).
//
// The allocation is counted from `lifetime_minted` (lib/distribution-supply):
// in the treasury · sent or sold · on sale · not created yet · cap. The
// treasury-mint reservations still pending are read within an existing
// wallet session only (no prompt here); the panel reads everything fresh
// before it creates a token.

import { useEffect, useMemo, useState } from "react";
import type { Address } from "@solana/kit";
import { useWalletConnection } from "@solana/react-hooks";
import type { Asset, ShareClass } from "@/lib/generated/asset_registry";
import { formatTokens } from "@/lib/tokenize-shares";
import { allocation, type SupplyFacts } from "@/lib/distribution-supply";
import { listSaleReservations, reservedTreasuryUnits } from "@/lib/sale-approvals";
import type { HookMode } from "@/lib/tokenize-shares-chain";
import { SendToWalletsPanel } from "@/components/send-to-wallets-panel";

export type DistributionMode = "wallets";

/** The ways tokens reach holders. Public sale and Both are added here next. */
const MODES: readonly { id: DistributionMode; label: string }[] = [{ id: "wallets", label: "Send to wallets" }];

export function DistributeCard({
  asset,
  sc,
  scPda,
  hook,
  tokenize,
  treasuryBalance,
  openSaleRemaining,
  canCreate,
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
  /** The connected issuer key may create tokens (an Admin issuer key: mint_to_treasury). */
  canCreate: boolean;
  onRefresh: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const session = conn.wallet;
  const [mode, setMode] = useState<DistributionMode>("wallets");
  /** Units of pending treasury-mint reservations; null until read (or when no session). */
  const [reserved, setReserved] = useState<bigint | null>(null);

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
      treasuryBalance: treasuryBalance ?? BigInt(0),
    }),
    [sc, openSaleRemaining, reserved, treasuryBalance],
  );
  const a = allocation(supply);
  const approximate = reserved === null || openSaleRemaining === null || treasuryBalance === null;

  return (
    <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
      <p className="text-[12px] text-slate-600" aria-label="Allocation of the supply">
        In treasury <Figure n={a.inTreasury} /> · Sent <Figure n={a.out} />
        {a.onSale > BigInt(0) && (
          <>
            {" "}· On sale <Figure n={a.onSale} />
          </>
        )}{" "}
        · Not created {a.notCreated === null ? "—" : <Figure n={a.notCreated} />} · Cap{" "}
        {a.cap === null ? "none" : <Figure n={a.cap} />}
        {approximate && <span className="text-slate-400"> (approximate)</span>}
      </p>

      {MODES.length > 1 && (
        <div role="tablist" className="mt-3 flex gap-2">
          {MODES.map((m) => (
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
      )}

      {mode === "wallets" && (
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
        />
      )}
    </div>
  );
}

function Figure({ n }: { n: bigint }) {
  return <span className="font-mono text-slate-900">{formatTokens(n)}</span>;
}

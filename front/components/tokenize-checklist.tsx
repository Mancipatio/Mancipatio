"use client";

// What happens after "Create token": the steps of a tokenized stake, read
// from chain (lib/tokenize-shares checklistItems). The operator's steps link
// to their admin screens for a wallet that holds the role; an Admin issuer key
// mints and locks right here, through the same components /admin/share-classes
// uses.

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { type Address } from "@solana/kit";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { AssetStatus } from "@/lib/generated/asset_registry";
import { ASSET_STATUS_LABEL } from "@/lib/format";
import { useRole } from "@/lib/auth";
import { loadIssuerPermission, ISSUER_CAPABILITIES } from "@/lib/issuer-permissions";
import { usePauseFlags } from "@/lib/use-pause-flags";
import { isPaused, PAUSE_PRIMARY } from "@/lib/pause-flags";
import {
  checklistItems,
  detailsSaved,
  formatTokens,
  isFlowToken,
  mintSymbolPreview,
  type ChecklistId,
  type ChecklistState,
} from "@/lib/tokenize-shares";
import {
  assetSnapshot,
  classSnapshot,
  readTokenizeState,
  type TokenizeChainState,
} from "@/lib/tokenize-shares-chain";
import { TreasuryMintPanel } from "@/components/treasury-mint-panel";
import { LockSupplyButton } from "@/components/lock-supply-button";
import { SkeletonCard } from "@/components/skeleton";

const TITLES: Record<ChecklistId, string> = {
  created: "Token created",
  details: "Details saved",
  kyc: "Operator: KYC-only",
  activate: "Operator: activate",
  mint: "Mint the tokens",
  lock: "Lock supply (one-way)",
};

const linkClass = "font-medium text-slate-800 underline decoration-slate-300 underline-offset-2 hover:text-slate-950";

export function TokenizeChecklist({
  assetPda,
  issuerAuthority,
  profile,
  refreshKey = 0,
}: {
  assetPda: Address;
  /** The asset's issuer authority (the treasury); minting needs it connected. */
  issuerAuthority: string | null;
  /** The stored off-chain profile, or null. "Details saved" is counted as the flow counts it (detailsSaved). */
  profile: { fields?: Record<string, unknown> | null } | null;
  /** Bump to re-read the chain. */
  refreshKey?: number;
}) {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address?.toString() ?? null;
  const { isAdmin, isBlocklistAuthority } = useRole();
  const flags = usePauseFlags();
  const [state, setState] = useState<TokenizeChainState | null>(null);
  const [failed, setFailed] = useState(false);
  const [permission, setPermission] = useState<{ globalAdmin: boolean; canMint: boolean }>({
    globalAdmin: false,
    canMint: false,
  });

  const isIssuerAuthority = !!wallet && wallet === issuerAuthority;

  const load = useCallback(async () => {
    try {
      const next = await readTokenizeState(client.runtime.rpc, assetPda);
      setState(next);
      setFailed(false);
      if (next.asset && isIssuerAuthority && wallet) {
        try {
          const p = await loadIssuerPermission(client.runtime.rpc, next.asset.issuer, wallet as Address);
          setPermission({ globalAdmin: p.globalAdmin, canMint: (p.capabilities & ISSUER_CAPABILITIES.Mint) !== 0 });
        } catch {
          setPermission({ globalAdmin: false, canMint: false });
        }
      }
    } catch {
      setFailed(true);
    }
  }, [client, assetPda, isIssuerAuthority, wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  if (failed) {
    return (
      <section className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
        <p>Could not read the token&apos;s state from the chain.</p>
        <button type="button" onClick={() => void load()} className="mt-2 font-medium underline">
          Try again
        </button>
      </section>
    );
  }
  if (!state) return <SkeletonCard className="mt-6" rows={4} />;
  const { asset, sc0, hook } = state;
  if (!asset) return null;

  const maxSupply = sc0?.maxSupply.__option === "Some" ? sc0.maxSupply.value : null;
  const circulating = sc0?.circulatingSupply ?? BigInt(0);
  const primaryPaused = flags !== null && isPaused(flags, PAUSE_PRIMARY);
  // A token from the tokenize flow continues there (and needs the flow's
  // figures saved); any other equity asset on the share-class screen and its
  // own profile form.
  const tokenizeLike = isFlowToken(assetSnapshot(asset), sc0 ? classSnapshot(sc0) : null);
  const items = checklistItems({
    classExists: !!sc0,
    mintInitialized: !!sc0?.mintInitialized,
    profileSaved: detailsSaved(tokenizeLike, profile),
    kycGated: hook === null ? null : hook === "kyc-gated",
    active: asset.status === AssetStatus.Active,
    circulating,
    maxSupply,
    supplyLocked: !!sc0?.supplyLocked,
    primaryPaused,
  });
  const byId = Object.fromEntries(items.map((i) => [i.id, i.state])) as Record<ChecklistId, ChecklistState>;
  const resumeHref = tokenizeLike ? `/issuer/assets/tokenize?asset=${assetPda}` : "/issuer/share-classes";
  const remaining = maxSupply !== null && maxSupply > circulating ? maxSupply - circulating : null;

  function detail(id: ChecklistId): ReactNode {
    const s = byId[id];
    switch (id) {
      case "created":
        if (s === "done") {
          return (
            <>
              {asset!.name} · {mintSymbolPreview(asset!.symbolPrefix)}
              {maxSupply !== null && <> · capped at {formatTokens(maxSupply)} tokens</>}
            </>
          );
        }
        if (!sc0) {
          return (
            <>
              The share class is not created yet.{" "}
              <Link href={resumeHref} className={linkClass}>Continue →</Link>
            </>
          );
        }
        return isIssuerAuthority && permission.canMint ? (
          <>
            The token mint is not created yet.{" "}
            <Link href={resumeHref} className={linkClass}>Continue (1 wallet signature) →</Link>
          </>
        ) : (
          "Waiting for the Super Admin to give this issuer the Mint permission; then the mint is created with one signature."
        );
      case "details":
        if (s === "done") return "Name, summary and figures are saved for the asset page.";
        return tokenizeLike ? (
          <>
            {profile
              ? "The token's figures (share, tokens, price) are not saved yet; the asset page text stays as it is."
              : "The description of the token is not saved yet."}{" "}
            <Link href={resumeHref} className={linkClass}>Save details (1 wallet signature) →</Link>
          </>
        ) : (
          "No product profile yet — add one with Edit under Product profile."
        );
      case "kyc":
        if (s === "done") return "Only wallets with a valid KYC passport can receive the token.";
        if (s === "blocked") return "After the token mint exists.";
        return (
          <>
            {hook === "none"
              ? "This mint has no transfer-hook config — the operator must sort it out. "
              : "Every new token starts open to any wallet; the operator turns on KYC-only so only verified wallets can hold it. "}
            {isBlocklistAuthority && (
              <Link href="/admin/share-classes" className={linkClass}>Set KYC-only on Admin → Share classes →</Link>
            )}
          </>
        );
      case "activate":
        if (s === "done") return "The asset is active.";
        if (s === "blocked") return "After the share class exists.";
        return (
          <>
            The asset is {ASSET_STATUS_LABEL[asset!.status]?.toLowerCase() ?? "not active"}; the operator activates it.{" "}
            {isAdmin && <Link href="/admin/assets" className={linkClass}>Activate on Admin → Assets →</Link>}
          </>
        );
      case "mint":
        if (s === "done") return sc0?.supplyLocked && maxSupply !== null && circulating < maxSupply
          ? `${formatTokens(circulating)} tokens minted; supply locked.`
          : `All ${formatTokens(circulating)} tokens are in the treasury.`;
        if (byId.kyc !== "done" || byId.activate !== "done") return "After KYC-only and activation.";
        if (primaryPaused) {
          return "Waiting for the super admin to reopen Primary issuance (pause bit 0x02) on Admin → Platform.";
        }
        return isIssuerAuthority && permission.globalAdmin ? (
          `Mint ${remaining !== null ? formatTokens(remaining) : "the"} tokens into your treasury. The EUR value counts against the raise limit; give a reason of at least 5 characters.`
        ) : (
          <>
            Units reach investors through an approved sale:{" "}
            <Link href="/issuer/launchpad" className={linkClass}>My sales →</Link>
          </>
        );
      case "lock":
        if (s === "done") return "Supply is locked for good — no more tokens can be minted.";
        if (s === "blocked") return "After all tokens are minted.";
        return isAdmin
          ? "Locks the supply for good. Nobody can mint more afterwards, not even the Super Admin."
          : "The operator locks the supply after minting — it is one-way.";
    }
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">Next steps</p>
        <button type="button" onClick={() => void load()} className="text-xs text-slate-500 hover:text-slate-800">
          Refresh
        </button>
      </div>
      <ol className="mt-4 space-y-3">
        {items.map((item) => (
          <li key={item.id} className="flex gap-3">
            <StateIcon state={item.state} />
            <div className="min-w-0 flex-1">
              <p className={`text-sm font-medium ${item.state === "blocked" ? "text-slate-400" : "text-slate-900"}`}>
                {item.id === "mint" && maxSupply !== null ? `Mint ${formatTokens(maxSupply)} tokens` : TITLES[item.id]}
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-slate-600">{detail(item.id)}</p>
              {item.id === "mint" && item.state === "todo" && isIssuerAuthority && permission.globalAdmin && sc0 && (
                <div className="mt-2">
                  <TreasuryMintPanel
                    sc={sc0}
                    scPda={state.addresses.shareClass}
                    issuerPda={asset.issuer}
                    isIssuerAuthority={isIssuerAuthority}
                    onRefresh={load}
                    defaultUnits={remaining !== null ? remaining.toString() : undefined}
                  />
                </div>
              )}
              {item.id === "lock" && item.state === "todo" && isAdmin && (
                <div className="mt-2">
                  <LockSupplyButton scPda={state.addresses.shareClass} onRefresh={load} />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function StateIcon({ state }: { state: ChecklistState }) {
  if (state === "done") {
    return (
      <span aria-label="Done" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-[11px] font-bold text-white">
        ✓
      </span>
    );
  }
  if (state === "todo") {
    return (
      <span aria-label="To do" className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-amber-500 bg-amber-50" />
    );
  }
  return <span aria-label="Waiting" className="mt-0.5 h-5 w-5 shrink-0 rounded-full border-2 border-slate-200" />;
}

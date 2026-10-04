"use client";

// What happens after "Create token": created → details → activate →
// distribute → close (lib/tokenize-shares checklistItems), read from chain.
// The operator's step (activation) links to its admin screen for a wallet
// that holds the role. Distribute hosts the ways tokens reach holders —
// "Send to wallets" now (components/distribute-card); nothing is minted up
// front, so a public sale stays possible. Close is the old one-way lock,
// optional, Admin only, after the last distribution.
//
// No KYC-only step (owner decision 2026-10-03): the tokens are bearer
// instruments in the hook's Open mode, and KYC is asked only when a token is
// converted into the company share. A class made KYC-only elsewhere is only
// said, never required.
//
// The chain reads are retried on a rate limit, a 5xx or a network error
// (lib/rpc-retry withRpcReadRetry: after ~0.5, 1 and 2 s): right after a send
// the checklist re-reads at once, and a public RPC's 429 used to leave "Could
// not read the token's state" up until "Try again". Only the latest load
// commits (lib/latest-load), so a slower, retrying older load never
// overwrites a newer one.

import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { type Address } from "@solana/kit";
import { useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { AssetStatus } from "@/lib/generated/asset_registry";
import { ASSET_STATUS_LABEL } from "@/lib/format";
import { useRole } from "@/lib/auth";
import { loadIssuerPermission, ISSUER_CAPABILITIES } from "@/lib/issuer-permissions";
import {
  KYC_GATED_NOTE,
  OPEN_CLASS_LINE,
  checklistItems,
  closeText,
  detailsSaved,
  distributeDoneText,
  distributeWaitText,
  formatTokens,
  isFlowToken,
  lockAtZeroOffered,
  mintSymbolPreview,
  type ChecklistId,
  type ChecklistInput,
  type ChecklistState,
} from "@/lib/tokenize-shares";
import {
  assetSnapshot,
  classSnapshot,
  issuerKybVerified,
  readTokenizeState,
  readTreasuryBalance,
  type TokenizeChainState,
} from "@/lib/tokenize-shares-chain";
import { listOpenSales, openSaleRemaining } from "@/lib/distribution-chain";
import { isApprovalLive, listShareClassSaleApprovals, type SaleApprovalAccount } from "@/lib/sale-approvals";
import { parseSaleRequest } from "@/lib/public-sale";
import { listSaleRequests } from "@/lib/sale-requests";
import { remainingFromLifetime } from "@/lib/distribution-supply";
import { createLatestGate } from "@/lib/latest-load";
import { withRpcReadRetry } from "@/lib/rpc-retry";
import { LockSupplyButton } from "@/components/lock-supply-button";
import { DistributeCard } from "@/components/distribute-card";
import { SkeletonCard } from "@/components/skeleton";

const TITLES: Record<ChecklistId, string> = {
  created: "Token created",
  details: "Details saved",
  activate: "Operator: activate",
  distribute: "Distribute",
  close: "Close (optional, one-way)",
};

const linkClass = "font-medium text-slate-800 underline decoration-slate-300 underline-offset-2 hover:text-slate-950";

type ChainExtras = {
  issuerVerified: boolean;
  /** The issuer treasury's balance of the mint; null when unknown. */
  treasuryBalance: bigint | null;
  /** Open sales of class 0; null when they could not be read. */
  openSales: { count: number; remaining: bigint } | null;
  /** Live sale approvals of class 0 not opened yet (open_sale closes them); null when they could not be read. */
  approvals: SaleApprovalAccount[] | null;
};

export function TokenizeChecklist({
  assetPda,
  issuerAuthority,
  profile,
  refreshKey = 0,
}: {
  assetPda: Address;
  /** The asset's issuer authority (the treasury); distributing needs it connected. */
  issuerAuthority: string | null;
  /**
   * The stored (private) off-chain profile, or null. "Details saved" is counted as the flow counts it
   * (detailsSaved); its published whitepaper is the public sale's document when the issuer picks the same file,
   * and a public-sale request waiting for the operator (fields.sale_request) holds Close.
   */
  profile: {
    fields?: Record<string, unknown> | null;
    whitepaper_path?: string | null;
    whitepaper_sha256?: string | null;
    whitepaper_status?: string | null;
  } | null;
  /** Bump to re-read the chain. */
  refreshKey?: number;
}) {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address?.toString() ?? null;
  const { isAdmin } = useRole();
  const [state, setState] = useState<TokenizeChainState | null>(null);
  const [extras, setExtras] = useState<ChainExtras | null>(null);
  const [failed, setFailed] = useState(false);
  const [permission, setPermission] = useState<{ globalAdmin: boolean; canMint: boolean; canConvert: boolean }>({
    globalAdmin: false,
    canMint: false,
    canConvert: false,
  });

  const isIssuerAuthority = !!wallet && wallet === issuerAuthority;
  const [latest] = useState(createLatestGate);

  const load = useCallback(async () => {
    const rpc = client.runtime.rpc;
    const current = latest.begin();
    try {
      const next = await withRpcReadRetry(() => readTokenizeState(rpc, assetPda));
      const sc = next.sc0;
      const issuer = next.asset?.issuer ?? null;
      const [issuerVerified, treasuryBalance, openSales, approvals] = await Promise.all([
        issuer ? withRpcReadRetry(() => issuerKybVerified(rpc, issuer)).catch(() => false) : Promise.resolve(false),
        sc?.mintInitialized && issuerAuthority
          ? // 0 when the treasury has no token account yet (exact); null only when unreadable.
            readTreasuryBalance(rpc, issuerAuthority as Address, sc.mint)
          : Promise.resolve(null),
        sc
          ? withRpcReadRetry(() => listOpenSales(rpc, { shareClass: next.addresses.shareClass }))
              .then((sales) => ({ count: sales.length, remaining: openSaleRemaining(sales) }))
              .catch(() => null)
          : Promise.resolve({ count: 0, remaining: BigInt(0) }),
        sc
          ? withRpcReadRetry(() => listShareClassSaleApprovals(rpc, next.addresses.shareClass))
              .then((rows) => rows.filter((a) => isApprovalLive(a)))
              .catch(() => null)
          : Promise.resolve([]),
      ]);
      if (!current()) return;
      setState(next);
      setExtras({ issuerVerified, treasuryBalance, openSales, approvals });
      setFailed(false);
      if (issuer && isIssuerAuthority && wallet) {
        try {
          const p = await withRpcReadRetry(() => loadIssuerPermission(rpc, issuer, wallet as Address));
          if (!current()) return;
          setPermission({
            globalAdmin: p.globalAdmin,
            canMint: (p.capabilities & ISSUER_CAPABILITIES.Mint) !== 0,
            canConvert: (p.capabilities & ISSUER_CAPABILITIES.Conversion) !== 0,
          });
        } catch {
          if (current()) setPermission({ globalAdmin: false, canMint: false, canConvert: false });
        }
      }
    } catch {
      // Not a transient failure, or still failing after the last retry: the "Try again" notice below.
      if (current()) setFailed(true);
    }
  }, [client, assetPda, issuerAuthority, isIssuerAuthority, wallet, latest]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load, refreshKey]);

  // A public-sale request the profile shows as "requested" may already have been served (its sale opened
  // and closed: the raise-cap ledger says so, read by the list route within an existing session). Until
  // that is known it counts as waiting, so Close never runs past a sale on its way.
  const shownRequest = parseSaleRequest(profile?.fields?.sale_request);
  const requestedId = shownRequest?.status === "requested" ? shownRequest.id : null;
  const shareClassAddress = state?.addresses.shareClass ?? null;
  const [requestCheck, setRequestCheck] = useState<{ id: string; waiting: boolean } | null>(null);
  useEffect(() => {
    if (!requestedId || !conn.wallet || !shareClassAddress) return;
    let cancelled = false;
    void listSaleRequests(conn.wallet, { share_class: shareClassAddress }, { interactive: false })
      .then((rows) => {
        const row = rows[0];
        if (!cancelled) setRequestCheck({ id: requestedId, waiting: row?.request?.status === "requested" && row.outcome === null });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [requestedId, conn.wallet, shareClassAddress, refreshKey]);
  const requestWaiting = requestedId === null ? false : requestCheck?.id === requestedId ? requestCheck.waiting : true;

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
  if (!state || !extras) return <SkeletonCard className="mt-6" rows={4} />;
  const { asset, sc0, hook } = state;
  if (!asset) return null;

  const maxSupply = sc0?.maxSupply.__option === "Some" ? sc0.maxSupply.value : null;
  const lifetimeMinted = sc0?.lifetimeMinted ?? BigInt(0);
  // A token from the tokenize flow continues there (and needs the flow's
  // figures saved); any other equity asset on the share-class screen and its
  // own profile form.
  const tokenizeLike = isFlowToken(assetSnapshot(asset), sc0 ? classSnapshot(sc0) : null);
  const facts: ChecklistInput = {
    classExists: !!sc0,
    mintInitialized: !!sc0?.mintInitialized,
    profileSaved: detailsSaved(tokenizeLike, profile),
    active: asset.status === AssetStatus.Active,
    issuerVerified: extras.issuerVerified,
    hookMode: hook,
    maxSupply,
    lifetimeMinted,
    treasuryBalance: extras.treasuryBalance,
    supplyLocked: !!sc0?.supplyLocked,
    openSalesOfClass: extras.openSales?.count ?? null,
    // An approval not opened yet or a request waiting for the operator: unreadable approvals count as one
    // (never lock past a sale on its way).
    pendingSaleOfClass: extras.approvals === null || extras.approvals.length > 0 || requestWaiting,
  };
  const items = checklistItems(facts);
  const byId = Object.fromEntries(items.map((i) => [i.id, i.state])) as Record<ChecklistId, ChecklistState>;
  const resumeHref = tokenizeLike ? `/issuer/assets/tokenize?asset=${assetPda}` : "/issuer/share-classes";
  // Counted from lifetime_minted: a conversion burn never makes room to re-issue.
  const notCreated = remainingFromLifetime(maxSupply, lifetimeMinted);
  const inTreasury = extras.treasuryBalance;
  const tokenize =
    profile?.fields && typeof profile.fields.tokenize === "object" && profile.fields.tokenize !== null
      ? (profile.fields.tokenize as Record<string, unknown>)
      : null;
  // The asset's published buyer document (a verified upload of this asset), if any.
  const publishedDocument =
    profile?.whitepaper_path &&
    profile.whitepaper_sha256 &&
    profile.whitepaper_path.startsWith(`whitepapers/${assetPda}/`) &&
    (profile.whitepaper_status === "published" || profile.whitepaper_status === "ssc_approved")
      ? { path: profile.whitepaper_path, sha256: profile.whitepaper_sha256 }
      : null;

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
      case "activate":
        if (s === "done") return "The asset is active.";
        if (s === "blocked") return "After the share class exists.";
        return (
          <>
            The asset is {ASSET_STATUS_LABEL[asset!.status]?.toLowerCase() ?? "not active"}; the operator activates it.{" "}
            {isAdmin && <Link href="/admin/assets" className={linkClass}>Activate on Admin → Assets →</Link>}
          </>
        );
      case "distribute": {
        if (s === "done") return distributeDoneText(facts);
        const wait = distributeWaitText(facts);
        if (wait) return wait;
        const pool = notCreated !== null ? `${formatTokens(notCreated)} not created yet` : "no cap";
        return isIssuerAuthority
          ? `Choose how the tokens reach their holders. ${inTreasury !== null ? `${formatTokens(inTreasury)} in your treasury, ` : ""}${pool}.`
          : "The issuer's wallet distributes the tokens; connect it to send them.";
      }
      case "close":
        return closeText(facts, isAdmin);
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
                {TITLES[item.id]}
              </p>
              <p className="mt-0.5 text-[13px] leading-relaxed text-slate-600">{detail(item.id)}</p>
              {item.id === "distribute" && item.state === "todo" && isIssuerAuthority && sc0 && (
                <DistributeCard
                  asset={asset}
                  sc={sc0}
                  scPda={state.addresses.shareClass}
                  hook={hook}
                  tokenize={tokenize}
                  treasuryBalance={extras.treasuryBalance}
                  openSaleRemaining={extras.openSales?.remaining ?? null}
                  approvals={extras.approvals}
                  publishedDocument={publishedDocument}
                  canCreate={permission.globalAdmin}
                  onRefresh={load}
                />
              )}
              {item.id === "close" && item.state === "todo" && isAdmin && (
                <div className="mt-2">
                  <LockSupplyButton scPda={state.addresses.shareClass} onRefresh={load} />
                </div>
              )}
              {item.id === "close" && item.state === "blocked" && isAdmin && lockAtZeroOffered(facts) && (
                <div className="mt-2">
                  <LockSupplyButton scPda={state.addresses.shareClass} onRefresh={load} label="Lock at 0…" requireZeroConfirm />
                </div>
              )}
            </div>
          </li>
        ))}
      </ol>
      {hook === "open" && <p className="mt-4 text-[13px] text-emerald-800">{OPEN_CLASS_LINE}</p>}
      {hook === "kyc-gated" && <p className="mt-4 text-[13px] text-amber-800">{KYC_GATED_NOTE}</p>}
      {hook === "none" && (
        <p className="mt-4 text-[13px] text-slate-600">
          This mint has no transfer-hook config — the operator must sort it out.
        </p>
      )}
      {/* C2: holders can ask to convert only when class 0 has an on-chain conversion target.
          Class 1 is added by the issuer key while the asset is a draft; the link needs Conversion. */}
      {tokenizeLike && sc0?.mintInitialized && (state.marker === "none" || state.marker === "unlinked") && (
        <p className="mt-2 text-[12px] text-slate-500">
          {state.marker === "none" && asset.status !== AssetStatus.Draft ? (
            "Conversion into company shares is not available for this token: its conversion class can only be added while the asset is a draft, and the asset is already active."
          ) : state.marker === "none" ? (
            <>
              Conversion into company shares is not set up yet; its conversion class can only be added while the asset is a
              draft:{" "}
              <Link href={resumeHref} className={linkClass}>add it now (1 wallet signature) →</Link>
            </>
          ) : isIssuerAuthority && permission.canConvert ? (
            <>
              Conversion into company shares is not set up yet:{" "}
              <Link href={resumeHref} className={linkClass}>set the conversion target (1 wallet signature) →</Link>
            </>
          ) : (
            "Conversion into company shares is not set up yet: the conversion target is set once the Super Admin gives this issuer the Conversion permission (then 1 wallet signature)."
          )}
        </p>
      )}
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

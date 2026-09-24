"use client";

import {
  WALLET_CONNECT_LABEL,
  WALLET_CONNECT_DESCRIPTION,
} from "@/lib/wallet-copy";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { use, useEffect, useState } from "react";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { type Address } from "@solana/kit";
import {
  RaiseType,
  SaleStatus,
  fetchMaybeKycRegistry,
  type Sale,
  findVaultPda,
  fetchMaybePayoutVault,
  PayoutVaultState,
  type PayoutVault,
} from "@/lib/generated/asset_registry";
import {
  findConfigPda,
  fetchMaybeTransferHookConfig,
  RestrictionMode,
} from "@/lib/generated/transfer_hook";
import { fetchMaybeMint as fetchMaybeClassicMint } from "@solana-program/token";
import {
  bitmapHasCode,
  fetchPassport,
  isPassportExpired,
  KycStatus,
} from "@/lib/passport";
import { countryName } from "@/lib/countries";
import {
  buildDocumentedPurchase,
  waitForPurchasePreparation,
} from "@/lib/purchase-builder";
import { VESTING_COMPUTE_UNITS } from "@/lib/vesting-creation";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findSalePda } from "@/lib/pdas";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import {
  getListing,
  listUpdates,
  getPublicApplication,
  createCommitment,
  recordSettledPurchase,
  commitmentAggregate,
  type CommitAggregate,
  type LaunchListing,
  type LaunchUpdate,
  type PublicApplication,
} from "@/lib/launchpad";
import { fmtMoney } from "@/lib/format";
import {
  UNKNOWN_COMMITMENTS,
  formatPaymentTotal,
} from "@/lib/commitment-totals";
import { purchaseQuote, paymentTokenLabel } from "@/lib/purchase-quote";
import { tokenDecimal } from "@/lib/chain-evidence";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { featureDisabledMessage, features } from "@/lib/features";
import {
  assertChainRecordStorageAvailable,
  type PendingChainRecord,
} from "@/lib/chain-record-recovery";
import { useChainRecordRecovery } from "@/lib/use-chain-record-recovery";
import { type SaleDocumentTerms } from "@/lib/document-terms";
import {
  impliedValuation,
  daysLeft,
  progressPct,
  yourEquity,
  investorYieldShare,
} from "@/lib/launch-math";
import { ConfirmModal } from "@/components/confirm-modal";
import { useToast } from "@/lib/toast";
import { InfoBox, YieldSplit } from "@/components/launchpad/primitives";
import { SkeletonCard } from "@/components/skeleton";

// Payment mints (USDC etc.) are classic SPL Token; share-class mints are Token-2022.
const TOKEN_CLASSIC_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

// ── helpers ─────────────────────────────────────────────────────────────────
/** Returns the URL only when it is a safe http(s) link, otherwise null.
 *  Guards against `javascript:`/`data:` schemes in applicant-supplied URLs. */
function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

/** Exact dollar amount for binding-commitment summaries (no k/M rounding). */
function fmtExact(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Parses a min-ticket label like "$1,000" into a number; 0 when unparseable. */
function parseMinTicket(raw: string | null | undefined): number {
  if (!raw) return 0;
  const digits = raw.replace(/[^0-9.]/g, "");
  const n = Number(digits);
  return Number.isFinite(n) ? n : 0;
}

// ── tab type ────────────────────────────────────────────────────────────────
type Tab = "overview" | "terms" | "founder" | "updates";

// ── page ────────────────────────────────────────────────────────────────────
export default function DealPage({
  params,
}: {
  params: Promise<{ sale: string }>;
}) {
  const { sale: salePubkey } = use(params);
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const walletAddress = conn.wallet?.account.address?.toString() ?? "";
  const toast = useToast();

  const [sale, setSale] = useState<Sale | null | "not_found">(null);
  const [listing, setListing] = useState<LaunchListing | null>(null);
  const [app, setApp] = useState<PublicApplication | null>(null);
  const [updates, setUpdates] = useState<LaunchUpdate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("overview");

  // eligibility gate state. Open classes (the default) need no identity
  // verification to buy; only a KycGated class needs the buyer's investor
  // passport, which the program re-checks on-chain. `unverified` marks the
  // fail-closed case where the class's mode itself could not be read.
  type EligibilityState = {
    gated: boolean;
    eligible: boolean;
    reason: string;
    unverified?: boolean;
  };
  const [eligibility, setEligibility] = useState<EligibilityState>({
    gated: false,
    eligible: true,
    reason: "",
  });
  const [eligibilityChecked, setEligibilityChecked] = useState(false);

  // right-panel state
  const [agg, setAgg] = useState<CommitAggregate>(UNKNOWN_COMMITMENTS);
  const purchaseRecovery = useChainRecordRecovery(
    "purchase",
    detectNetwork(),
    walletAddress,
  );
  const pendingPurchase =
    purchaseRecovery.receipts.find((r) => r.entityId === salePubkey) ?? null;
  const [recordingPurchase, setRecordingPurchase] = useState(false);
  const [documentTerms, setDocumentTerms] = useState<SaleDocumentTerms | null>(
    null,
  );
  const [documentError, setDocumentError] = useState<string | null>(null);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const [vault, setVault] = useState<PayoutVault | null>(null);
  const [amount, setAmount] = useState("");
  const [committedAmount, setCommittedAmount] = useState(0);
  const [showConfirm, setShowConfirm] = useState(false);
  const [commitBusy, setCommitBusy] = useState(false);
  const [committed, setCommitted] = useState(false);
  // Whether the just-completed action settled on-chain (real Buy) vs off-chain
  // (soft commitment) — drives the success-screen copy.
  const [settledOnChain, setSettledOnChain] = useState(false);
  const [settledUnits, setSettledUnits] = useState(0);
  // Payment-mint decimals — used for exact atomic-unit pricing.
  const [paymentDecimals, setPaymentDecimals] = useState<number | null>(null);
  // Live clock so "days left" / expiry update on a long-open page.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        try {
          const docResponse = await fetch(
            `/api/launchpad/terms?sale=${encodeURIComponent(salePubkey)}`,
            { cache: "no-store" },
          );
          const docJson = await docResponse.json();
          if (!cancelled) {
            setDocumentTerms(
              docResponse.ok && docJson.ok
                ? (docJson.data as SaleDocumentTerms)
                : null,
            );
            setDocumentError(
              docResponse.ok && docJson.ok
                ? null
                : (docJson.error ??
                    "Verified investment documents are unavailable"),
            );
            setAcceptedTerms(false);
          }
        } catch {
          if (!cancelled) {
            setDocumentTerms(null);
            setDocumentError(
              "Verified investment documents are unavailable. Refresh to retry.",
            );
          }
        }
        const [network, fetchedListing, fetchedUpdates] = await Promise.all([
          loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)),
          getListing(salePubkey),
          listUpdates(salePubkey),
        ]);
        if (cancelled) return;

        // Match the on-chain Sale by deriving its PDA for every sale in network
        let matchedSale: Sale | null = null;
        for (const s of network.sales) {
          const pda = await findSalePda(s.shareClass, s.saleId);
          if (pda.toString() === salePubkey) {
            matchedSale = s;
            break;
          }
        }
        if (cancelled) return;

        const fetchedApp = fetchedListing?.application_id
          ? await getPublicApplication(fetchedListing.application_id)
          : null;

        if (!cancelled) {
          setSale(matchedSale ?? "not_found");
          setListing(fetchedListing);
          setApp(fetchedApp);
          setUpdates(fetchedUpdates);
        }

        // load commitment aggregate
        const fetchedAgg = await commitmentAggregate(salePubkey);
        if (!cancelled) setAgg(fetchedAgg);

        // load payout vault (best-effort, startup-only)
        if (matchedSale && matchedSale.raiseType === RaiseType.Startup) {
          try {
            const [vaultPda] = await findVaultPda({
              sale: salePubkey as Address,
            });
            const maybe = await fetchMaybePayoutVault(
              client.runtime.rpc,
              vaultPda,
            );
            if (!cancelled) setVault(maybe.exists ? maybe.data : null);
          } catch {
            if (!cancelled) setVault(null);
          }
        }

        if (!cancelled) setLoaded(true);
      } catch {
        if (!cancelled) setFailed(true);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [client, salePubkey]);

  // ── per-deal eligibility pre-check ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    async function checkEligibility() {
      // Only run once we have a matched sale with a known mint
      if (!sale || sale === "not_found") return;
      if (!cancelled) setEligibilityChecked(false);
      const saleData = sale as Sale;
      const mint = saleData.mint as Address;

      // Step 1 — determine whether this mint is KYC-gated. `buy` mints tokens
      // via a mint_to CPI, which does NOT fire the Token-2022 transfer hook —
      // instead the program's buy handler re-checks the receiver fail-closed
      // (require_receiver_kyc_for_mint_to) from the proof tail appended below
      // in handleConfirmedBuy. That on-chain gate exists in the asset_registry
      // source and binds once that build is deployed; until then this
      // client-side gate is the only live protection — so it stays
      // fail-CLOSED regardless: a read failure must NOT degrade to "not
      // gated" — block the buy and prompt a retry instead of letting the
      // program reject the transaction.
      let registry: Address | null = null;
      try {
        const [configPda] = await findConfigPda({ mint });
        const maybeConfig = await fetchMaybeTransferHookConfig(
          client.runtime.rpc,
          configPda,
        );
        if (
          !maybeConfig.exists ||
          maybeConfig.data.restrictionMode === RestrictionMode.Open
        ) {
          // A non-existent config or Open mode is a definitive "not gated" answer
          // (we successfully read the chain), so this branch stays eligible.
          if (!cancelled) {
            setEligibility({ gated: false, eligible: true, reason: "" });
            setEligibilityChecked(true);
          }
          return;
        }
        const registryOption = maybeConfig.data.kycRegistry;
        registry =
          registryOption.__option === "Some" ? registryOption.value : null;
        if (!registry) {
          // KycGated with NO registry: unreachable on a healthy chain (the
          // program requires a registry whenever the mode is KycGated), and
          // certainly not "not gated" — the mint's meta list is in KycGated
          // shape, so the on-chain proof check would reject any tail we could
          // build. Fail CLOSED rather than showing an "Eligible" badge on a
          // buy that can only fail.
          if (!cancelled) {
            setEligibility({
              gated: true,
              eligible: false,
              reason:
                "This sale is KYC-gated but its mint has no KYC registry configured — contact the platform operator.",
            });
            setEligibilityChecked(true);
          }
          return;
        }
      } catch {
        // Could not read the hook config → we do not know whether the sale is
        // gated, and there is no on-chain backstop. Fail CLOSED: block the buy
        // and prompt a retry rather than assume the sale is open.
        if (!cancelled) {
          setEligibility({
            gated: true,
            eligible: false,
            reason:
              "Could not verify this sale's eligibility rules. Please try again.",
            unverified: true,
          });
          setEligibilityChecked(true);
        }
        return;
      }

      // From here the deal IS gated. Any failure below must fail CLOSED.
      if (!walletAddress) {
        if (!cancelled) {
          setEligibility({
            gated: true,
            eligible: false,
            reason: WALLET_CONNECT_DESCRIPTION,
          });
          setEligibilityChecked(true);
        }
        return;
      }
      try {
        // The on-chain gate (util.rs receiver_kyc_outcome) checks THREE things:
        // status == Approved, expiry > now, and the entry's jurisdiction bit
        // set in the registry's approved bitmap while clear in the blocked
        // one. Mirror all three — a badge that only knows the first two shows
        // "Eligible" to a buyer whose tx then fails with
        // ReceiverJurisdictionBlocked after they paid the fee.
        const [entry, maybeRegistry] = await Promise.all([
          fetchPassport(client.runtime.rpc, registry, walletAddress as Address),
          fetchMaybeKycRegistry(client.runtime.rpc, registry),
        ]);
        if (!cancelled) {
          const nowSec = Math.floor(Date.now() / 1000);
          // Chain semantics: valid only while expiry > now, so expiry == 0 is
          // ALWAYS expired — never "no expiry" (isPassportExpired).
          const expired = entry
            ? isPassportExpired(entry.expiry, nowSec)
            : true;
          const jurisdictionOk =
            entry && maybeRegistry.exists
              ? bitmapHasCode(
                  maybeRegistry.data.approvedJurisdictions,
                  entry.jurisdiction,
                ) &&
                !bitmapHasCode(
                  maybeRegistry.data.blockedJurisdictions,
                  entry.jurisdiction,
                )
              : // Registry unreadable → cannot mirror the bitmap check.
                // Fail CLOSED: this client-side gate is the only live
                // protection until the new program build is deployed.
                false;
          const eligible =
            entry !== null &&
            entry.status === KycStatus.Approved &&
            !expired &&
            jurisdictionOk;
          let reason = "";
          if (!entry) {
            reason =
              "Your wallet does not have an investor passport on this registry.";
          } else if (entry.status === KycStatus.Pending) {
            reason =
              "Your passport is pending review. Check back once it is approved.";
          } else if (entry.status === KycStatus.Revoked) {
            reason = "Your investor passport has been revoked.";
          } else if (entry.status === KycStatus.Expired || expired) {
            reason = "Your investor passport has expired. Please reapply.";
          } else if (!maybeRegistry.exists) {
            reason =
              "Could not read this sale's KYC registry — please try again.";
          } else if (!jurisdictionOk) {
            reason = `Your passport's jurisdiction (${countryName(String(entry.jurisdiction).padStart(3, "0"))}) is not approved for this sale.`;
          }
          setEligibility({ gated: true, eligible, reason });
          setEligibilityChecked(true);
        }
      } catch {
        // Gated mint, but we couldn't verify the passport → fail closed.
        if (!cancelled) {
          setEligibility({
            gated: true,
            eligible: false,
            reason:
              "Could not verify your investor passport. Please try again.",
          });
          setEligibilityChecked(true);
        }
      }
    }
    void checkEligibility();
    return () => {
      cancelled = true;
    };
  }, [client, sale, walletAddress]);

  // ── payment-mint decimals (needed to price an on-chain Buy) ───────────────
  useEffect(() => {
    let cancelled = false;
    async function loadDecimals() {
      if (!sale || sale === "not_found") return;
      const paymentMint = (sale as Sale).paymentMint;
      try {
        const maybe = await fetchMaybeClassicMint(
          client.runtime.rpc,
          paymentMint,
        );
        if (!cancelled) {
          setPaymentDecimals(
            maybe.exists &&
              maybe.programAddress === TOKEN_CLASSIC_ADDRESS &&
              maybe.data.decimals <= 18
              ? maybe.data.decimals
              : null,
          );
        }
      } catch {
        if (!cancelled) setPaymentDecimals(null);
      }
    }
    void loadDecimals();
    return () => {
      cancelled = true;
    };
  }, [client, sale]);

  // ── error states ──────────────────────────────────────────────────────────
  if (failed) {
    return (
      <section>
        <p className="text-sm text-red-600">Failed to load sale.</p>
      </section>
    );
  }

  if (!loaded) {
    return (
      <section>
        <SkeletonCard rows={8} />
      </section>
    );
  }

  if (sale === "not_found") {
    return (
      <section>
        <p className="text-xs font-semibold uppercase tracking-widest text-mx-ink-faint">
          Equity Launch
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-mx-ink">
          Sale not found
        </h1>
        <p className="mt-2 text-sm text-mx-ink-soft">
          No on-chain sale with this address is registered on Manci
          ({detectNetwork()}).
        </p>
        <Link
          href="/marketplace/launchpad"
          className="mt-4 inline-block text-sm text-mx-ink-soft underline-offset-2 hover:underline"
        >
          ← All raises
        </Link>
      </section>
    );
  }

  // sale is a Sale at this point
  const saleData = sale as Sale;

  const companyName =
    app?.company_name ??
    `Sale ${salePubkey.slice(0, 4)}…${salePubkey.slice(-4)}`;

  const isStartup = saleData.raiseType === RaiseType.Startup;
  // Settlement path:
  //   Mature  → a real on-chain primary Buy: USDC debited, share units minted
  //             to the buyer this transaction. Binding, immediate.
  //   Startup → a non-binding soft commitment recorded off-chain; the raise
  //             settles later through the vesting/PayoutVault flow (SAFE-style).
  const settlesOnChain = saleData.raiseType === RaiseType.Mature;
  const dLeft = daysLeft(saleData.endTs, now);

  const target = app?.raise_amount ?? 0;
  const equityOffered = app?.equity_offered ?? 0;
  const parsed = Number.isFinite(Number(amount)) ? Number(amount) : 0;
  const minTicket = settlesOnChain ? 0 : parseMinTicket(app?.min_ticket);
  const paymentLabel = paymentTokenLabel(saleData.paymentMint, detectNetwork());

  // ── on-chain share-unit math (Mature path) ─────────────────────────────────
  // `pricePerUnit` is payment-token BASE units per one share-class unit (the
  // share mint has 0 decimals). The user types a whole-dollar amount, so we
  // convert: dollars → payment base units (× 10^paymentDecimals) → share units
  // (÷ pricePerUnit, floored). `paymentDecimals` is fetched from the payment
  // mint; until it loads we cannot price a buy.
  const pricePerUnit = saleData.pricePerUnit; // bigint, payment base units / share unit
  const remainingUnits = saleData.totalForSale - saleData.sold;
  const quote =
    settlesOnChain && paymentDecimals !== null
      ? purchaseQuote(amount, paymentDecimals, pricePerUnit)
      : null;
  const onChainUnits = quote?.units ?? BigInt(0);
  const onChainCostBaseUnits = quote?.cost ?? BigInt(0);
  const formattedPayment =
    paymentDecimals === null
      ? "—"
      : `${tokenDecimal(onChainCostBaseUnits, paymentDecimals)} ${paymentLabel}`;
  // What the buyer actually pays once their dollars are floored to whole units.
  const onChainCostDollars =
    paymentDecimals !== null
      ? Number(onChainCostBaseUnits) / 10 ** paymentDecimals
      : 0;

  // ── sale availability guard ────────────────────────────────────────────────
  // A sale only accepts commitments while it is on-chain Open, within its
  // [startTs, endTs] window, and not sold out.
  const soldOut =
    saleData.totalForSale > BigInt(0) && saleData.sold >= saleData.totalForSale;
  const notStarted =
    saleData.startTs > BigInt(0) && Number(saleData.startTs) > now;
  const expired = saleData.endTs > BigInt(0) && Number(saleData.endTs) <= now;
  // Startup raises are feature-flagged per network (lib/features.ts; off on
  // mainnet unless NEXT_PUBLIC_FEATURE_STARTUP_RAISES=true), and
  // /api/launchpad/commit refuses a Startup sale with it off — so an on-chain
  // Startup sale (opened while the flag was on, or outside the issuer UI)
  // takes no commitments here either.
  const startupUnavailable = isStartup && !features().startupRaises;
  const saleOpen =
    !startupUnavailable &&
    saleData.status === SaleStatus.Open && !soldOut && !notStarted && !expired;
  const closedReason = !saleOpen
    ? startupUnavailable
      ? `${featureDisabledMessage("startupRaises")} This raise is not taking commitments.`
      : saleData.status !== SaleStatus.Open
      ? "This sale has been closed by the issuer."
      : soldOut
        ? "This raise is fully subscribed."
        : notStarted
          ? "This sale has not opened yet."
          : "This sale has ended."
    : "";

  const belowMin = minTicket > 0 && parsed > 0 && parsed < minTicket;
  // On-chain extras: the payment budget must price to ≥ 1 whole share unit, the
  // units must not exceed what's left, and the payment-mint decimals must have
  // loaded so we can size the buy at all.
  const onChainPriceReady = !settlesOnChain || paymentDecimals !== null;
  const onChainBelowOneUnit =
    settlesOnChain &&
    parsed > 0 &&
    paymentDecimals !== null &&
    onChainUnits <= BigInt(0);
  const onChainOverRemaining =
    settlesOnChain && onChainUnits > BigInt(0) && onChainUnits > remainingUnits;
  const canCommit =
    !!walletAddress &&
    purchaseRecovery.ready &&
    documentTerms?.sale === salePubkey &&
    acceptedTerms &&
    !pendingPurchase &&
    saleOpen &&
    parsed > 0 &&
    !belowMin &&
    onChainPriceReady &&
    !onChainBelowOneUnit &&
    !onChainOverRemaining &&
    (!eligibility.gated || eligibility.eligible);

  // ── success screen ─────────────────────────────────────────────────────────
  if (committed) {
    const eqPct =
      app && !settledOnChain
        ? yourEquity(equityOffered, committedAmount, target)
        : 0;
    const impliedVal =
      app && target > 0 && equityOffered > 0
        ? impliedValuation(target, equityOffered)
        : 0;

    return (
      <section className="flex min-h-[60vh] items-center justify-center px-4">
        <div className="w-full max-w-md text-center">
          {/* Checkmark */}
          <div className="mx-auto mb-7 flex h-16 w-16 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-3xl text-emerald-600">
            ✓
          </div>

          <h2 className="mb-3 text-2xl font-semibold tracking-tight text-mx-ink">
            {settledOnChain ? "Shares are yours." : "You're in."}
          </h2>

          <p className="mb-8 text-[15px] leading-relaxed text-mx-ink-faint">
            {settledOnChain ? (
              <>
                You bought{" "}
                <strong className="text-mx-ink">
                  {settledUnits.toLocaleString()} share units
                </strong>{" "}
                for{" "}
                <strong className="text-mx-ink">
                  {formatPaymentTotal(String(committedAmount))} {paymentLabel}
                </strong>{" "}
                in <strong className="text-mx-ink">{companyName}</strong>. The
                tokens are now in your wallet.
              </>
            ) : (
              <>
                You committed{" "}
                <strong className="text-mx-ink">
                  {fmtExact(committedAmount)}
                </strong>
                {app ? (
                  <>
                    {" "}
                    for{" "}
                    <strong className="text-mx-ink">
                      ~{eqPct.toFixed(3)}%
                    </strong>{" "}
                    equity in{" "}
                  </>
                ) : (
                  " in "
                )}
                <strong className="text-mx-ink">{companyName}</strong>.
              </>
            )}
          </p>

          {pendingPurchase && (
            <div
              className="mb-6 rounded border border-amber-200 bg-amber-50 p-4 text-sm"
              role="status"
            >
              <p className="font-semibold">Purchase sent · recording pending</p>
              <p className="mt-1">No further payment is needed.</p>
              <a
                className="mt-2 block underline"
                href={explorerTxUrl(
                  pendingPurchase.signature,
                  pendingPurchase.network,
                )}
                target="_blank"
                rel="noreferrer"
              >
                View transaction
              </a>
              <button
                className="mt-3 rounded border border-amber-300 px-3 py-2 disabled:opacity-50"
                disabled={recordingPurchase}
                onClick={() => void retryPurchaseRecord()}
              >
                {recordingPurchase ? "Verifying…" : "Retry recording"}
              </button>
            </div>
          )}

          {/* Summary box */}
          <div className="mb-8 overflow-hidden rounded-[3px] border border-mx-rule bg-white">
            <div className="flex items-center justify-around divide-x divide-mx-rule px-4 py-5">
              <div className="flex-1 px-3 text-center">
                <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
                  Structure
                </p>
                <p className="text-[15px] font-semibold text-mx-ink">
                  {app?.raise_structure ?? "—"}
                </p>
              </div>
              {impliedVal > 0 && (
                <div className="flex-1 px-3 text-center">
                  <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
                    Valuation
                  </p>
                  <p className="text-[15px] font-semibold text-mx-ink">
                    {fmtMoney(impliedVal)}
                  </p>
                </div>
              )}
              <div className="flex-1 px-3 text-center">
                <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
                  Min ticket
                </p>
                <p className="text-[15px] font-semibold text-mx-ink">
                  {app?.min_ticket ?? "—"}
                </p>
              </div>
            </div>
          </div>

          <Link
            href="/marketplace/launchpad"
            className="inline-flex items-center gap-1 rounded-[3px] border border-mx-rule px-4 py-2 text-sm text-mx-ink-soft transition-colors hover:border-mx-rule-strong hover:text-mx-ink"
          >
            ← Browse more raises
          </Link>
        </div>
      </section>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "overview", label: "Overview" },
    { id: "terms", label: "Deal terms" },
    { id: "founder", label: "Founder" },
    { id: "updates", label: `Updates (${updates.length})` },
  ];

  const pct = isStartup
    ? progressPct(agg.pledged + agg.confirmed, target)
    : progressPct(Number(saleData.sold), Number(saleData.totalForSale));

  // Re-assert every guard at commit time — the button is not the source of
  // truth. Returns the validated dollar amount, or null to abort (already toasted).
  function assertCommitGuards(): number | null {
    if (pendingPurchase) {
      toast.showError(
        "Purchase already sent",
        "Finish recording the previous purchase before sending another payment.",
      );
      return null;
    }
    if (!walletAddress) {
      toast.showError(WALLET_CONNECT_LABEL, WALLET_CONNECT_DESCRIPTION);
      return null;
    }
    if (!eligibilityChecked) {
      toast.showError(
        "Still verifying eligibility",
        "Please try again in a moment.",
      );
      return null;
    }
    if (eligibility.gated && !eligibility.eligible) {
      toast.showError("Not eligible to invest", eligibility.reason);
      return null;
    }
    if (!saleOpen) {
      toast.showError("Sale unavailable", closedReason);
      return null;
    }
    if (parsed <= 0) return null;
    if (belowMin) {
      toast.showError("Below minimum ticket", `Minimum is ${app?.min_ticket}.`);
      return null;
    }
    return parsed;
  }

  // ── on-chain primary Buy (Mature path) ──────────────────────────────────────
  // Mirrors the admin launchpad caller: idempotently create the buyer's
  // share-class (Token-2022) and payment (classic SPL) ATAs, then `buy` the
  // computed number of whole share units. Delivery is a `mint_to` CPI (not a
  // transfer), so the transfer hook never fires here — instead the program's
  // buy handler re-checks the receiver FAIL-CLOSED
  // (require_receiver_kyc_for_mint_to): the appended remaining-accounts tail
  // must PROVE the restriction mode — the hook config when present is
  // authoritative (KycGated then also demands the buyer's approved KycEntry
  // and the registry), and for Open mints the ExtraAccountMetaList in its
  // Open shape is the proof. A tail carrying neither fails with
  // KycProofRequired, so EVERY buy appends a tail (empty is never valid).
  // NOTE: that gate lives in the asset_registry source and binds once that
  // build is deployed — against an older deployed program the tail is inert
  // and the fail-closed client check above is the only live protection.
  async function handleConfirmedBuy() {
    const dollars = assertCommitGuards();
    if (dollars === null) return;
    if (paymentDecimals === null) {
      toast.showError(
        "Still loading sale price",
        "Please try again in a moment.",
      );
      return;
    }
    if (onChainUnits <= BigInt(0)) {
      toast.showError(
        "Amount too small",
        "Your amount does not cover one whole share unit at this price.",
      );
      return;
    }
    if (onChainUnits > remainingUnits) {
      toast.showError(
        "Not enough units left",
        `Only ${String(remainingUnits)} share units remain in this sale.`,
      );
      return;
    }
    const units = onChainUnits;
    setCommitBusy(true);
    const pendingId = toast.showPending(`Buying ${String(units)} share units…`);
    try {
      assertChainRecordStorageAvailable();
      if (!acceptedTerms || documentTerms?.sale !== salePubkey)
        throw new Error(
          "Read and accept the verified investment document first",
        );
      const signer = walletSigner(conn.wallet);
      const plan = await buildDocumentedPurchase(client.runtime.rpc, {
        buyer: signer,
        sale: saleData,
        amount: units,
        terms: documentTerms,
      });
      if (plan.preparationInstructions.length) {
        const preparationSignature = await tx.send({
          instructions: plan.preparationInstructions,
          feePayer: signer,
          version: 0,
          computeUnitLimit: VESTING_COMPUTE_UNITS,
          prepareTransaction: false,
        });
        toast.showTx(preparationSignature, {
          title: "Token-account preparation submitted — purchase follows",
        });
        await waitForPurchasePreparation(
          client.runtime.rpc,
          preparationSignature,
        );
      }
      const sig = await tx.send({
        instructions: plan.purchaseInstructions,
        feePayer: signer,
        version: 0,
        computeUnitLimit: VESTING_COMPUTE_UNITS,
        prepareTransaction: false,
      });
      if (!sig)
        throw new Error(
          "The wallet did not return a transaction signature. Check wallet activity before attempting another purchase.",
        );
      const signature = sig;
      toast.dismiss(pendingId);
      toast.showTx(signature, { title: "Purchase confirmed" });

      setCommittedAmount(onChainCostDollars);
      setSettledUnits(Number(units));
      setSettledOnChain(true);
      setShowConfirm(false);
      setCommitted(true);
      const receipt: PendingChainRecord = {
        kind: "purchase",
        network: detectNetwork(),
        wallet: walletAddress,
        entityId: salePubkey,
        signature,
        createdAt: new Date().toISOString(),
        version: 1,
      };
      try {
        purchaseRecovery.remember(salePubkey, signature);
      } catch {
        toast.showError(
          "Keep your purchase receipt",
          "Browser storage could not save this receipt. Keep the transaction link; do not buy again to update the record.",
        );
      }
      await retryPurchaseRecord(receipt);
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Purchase not confirmed", explainSendError(err));
    } finally {
      setCommitBusy(false);
    }
  }

  async function retryPurchaseRecord(receipt = pendingPurchase) {
    if (
      !receipt ||
      receipt.wallet !== walletAddress ||
      receipt.network !== detectNetwork() ||
      receipt.entityId !== salePubkey
    )
      return;
    setRecordingPurchase(true);
    try {
      const result = await recordSettledPurchase(
        conn.wallet,
        salePubkey,
        walletAddress,
        receipt.signature,
      );
      if (result.status === "complete") {
        try {
          purchaseRecovery.forget(receipt);
        } catch {
          /* A leftover receipt is safe: server recording is idempotent. */
        }
        toast.show({
          kind: "success",
          title: "Purchase recorded",
          description: "The payment was verified on-chain.",
        });
      } else {
        toast.show({
          kind: "info",
          title: "Purchase recording queued",
          description:
            "Your transaction was sent. The payment record is waiting for finalization; no further payment is needed.",
        });
      }
      setAgg(await commitmentAggregate(salePubkey));
    } catch (error) {
      toast.showError(
        "Purchase sent; recording needs attention",
        error instanceof Error
          ? error.message
          : "Retry recording this receipt without sending another payment.",
      );
    } finally {
      setRecordingPurchase(false);
    }
  }

  // ── off-chain soft commitment (Startup / SAFE path) ─────────────────────────
  // A non-binding intent recorded off-chain; the raise settles later through
  // the vesting/PayoutVault flow. No tokens move now.
  async function handleConfirmedCommit() {
    const dollars = assertCommitGuards();
    if (dollars === null) return;
    setCommitBusy(true);
    try {
      if (!acceptedTerms || documentTerms?.sale !== salePubkey)
        throw new Error(
          "Read and accept the verified investment document first",
        );
      await createCommitment(
        conn.wallet,
        salePubkey,
        walletAddress,
        dollars,
        documentTerms,
      );
      setCommittedAmount(dollars);
      setSettledOnChain(false);
      setSettledUnits(0);
      // Optimistically reflect this commitment in the live aggregate.
      setAgg(await commitmentAggregate(salePubkey));
      setShowConfirm(false);
      setCommitted(true);
    } catch (err) {
      // Surface the server's message — the 403 compliance copy (suspended /
      // rejected client profile; no KYC is required to commit) or the 409
      // document-terms copy from /api/launchpad/commit must reach the user,
      // not a generic "unavailable" excuse that sends them into a retry loop.
      toast.showError(
        "Could not record commitment",
        err instanceof Error && err.message
          ? err.message
          : "Supabase unavailable — try again.",
      );
    } finally {
      setCommitBusy(false);
    }
  }

  // Dispatch to the right settlement path.
  async function handleConfirmedAction() {
    if (settlesOnChain) {
      await handleConfirmedBuy();
    } else {
      await handleConfirmedCommit();
    }
  }

  return (
    <section>
      {/* Back link */}
      <Link
        href="/marketplace/launchpad"
        className="text-xs text-mx-ink-faint underline-offset-2 hover:underline"
      >
        ← All raises
      </Link>

      {/* 2-column grid */}
      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_360px]">
        {/* ═══ LEFT COLUMN ═══ */}
        <div>
          {/* Company header */}
          <div className="mb-8">
            <div className="flex items-center gap-4">
              {/* Logo */}
              <div
                className="flex h-14 w-14 flex-shrink-0 items-center justify-center rounded-[3px] text-2xl font-bold text-mx-paper"
                style={
                  listing?.logo_gradient
                    ? { background: listing.logo_gradient }
                    : { background: "var(--mx-indigo)" }
                }
              >
                {listing?.logo_letter ?? companyName[0] ?? "?"}
              </div>

              <div className="min-w-0 flex-1">
                {/* Name + badges row */}
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-2xl font-semibold leading-tight text-mx-ink">
                    {companyName}
                  </h1>
                  {app?.category && (
                    <span className="inline-flex rounded-full border border-mx-indigo bg-mx-indigo-soft px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide text-mx-indigo">
                      {app.category}
                    </span>
                  )}
                  {app?.stage && (
                    <span className="inline-flex rounded-full border border-mx-rule bg-mx-paper px-2.5 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide text-mx-ink-soft">
                      {app.stage}
                    </span>
                  )}
                </div>

                {/* One-liner */}
                {app?.one_liner && (
                  <p className="mt-1 text-sm leading-relaxed text-mx-ink-faint">
                    {app.one_liner}
                  </p>
                )}
              </div>
            </div>

            {/* External links row */}
            {(() => {
              const websiteUrl = safeHttpUrl(app?.website);
              const twitterUrl = app?.founder_twitter
                ? app.founder_twitter.startsWith("@")
                  ? `https://x.com/${app.founder_twitter.slice(1)}`
                  : safeHttpUrl(app.founder_twitter)
                : null;
              const deckUrl = safeHttpUrl(app?.pitch_deck);
              if (!websiteUrl && !twitterUrl && !deckUrl) return null;
              return (
                <div className="mt-4 flex flex-wrap gap-2">
                  {websiteUrl && (
                    <a
                      href={websiteUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-[3px] border border-mx-rule px-2.5 py-1 font-mono text-[11px] text-mx-ink-faint transition-colors hover:border-mx-rule-strong hover:text-mx-ink-soft"
                    >
                      ↗ Website
                    </a>
                  )}
                  {twitterUrl && (
                    <a
                      href={twitterUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-[3px] border border-mx-rule px-2.5 py-1 font-mono text-[11px] text-mx-ink-faint transition-colors hover:border-mx-rule-strong hover:text-mx-ink-soft"
                    >
                      𝕏 {app?.founder_twitter}
                    </a>
                  )}
                  {deckUrl && (
                    <a
                      href={deckUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 rounded-[3px] border border-mx-indigo bg-mx-indigo-soft px-2.5 py-1 font-mono text-[11px] text-mx-indigo transition-colors hover:bg-mx-indigo-soft"
                    >
                      Pitch deck ↗
                    </a>
                  )}
                </div>
              );
            })()}
          </div>

          {/* Tab bar */}
          <div className="flex border-b border-mx-rule">
            {tabs.map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  className={`px-4 py-3 text-[13px] font-medium transition-colors ${
                    active
                      ? "-mb-px border-b-2 border-mx-indigo text-foreground"
                      : "text-mx-ink-faint hover:text-mx-ink-soft"
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {/* ── Tab content ── */}
          <div className="mt-6">
            {/* Overview */}
            {activeTab === "overview" && (
              <OverviewTab listing={listing} app={app} />
            )}

            {/* Deal terms */}
            {activeTab === "terms" && (
              <TermsTab
                sale={saleData}
                app={app}
                isStartup={isStartup}
                dLeft={dLeft}
              />
            )}

            {/* Founder */}
            {activeTab === "founder" && <FounderTab app={app} />}

            {/* Updates */}
            {activeTab === "updates" && <UpdatesTab updates={updates} />}
          </div>
        </div>

        {/* ═══ RIGHT COLUMN: invest panel ═══ */}
        <aside className="lg:sticky lg:top-20 space-y-4 self-start">
          <div className="rounded-[3px] border border-mx-rule bg-white p-4 text-sm">
            <p className="font-semibold">Investment documents</p>
            {documentTerms?.sale === salePubkey ? (
              <>
                <a
                  className="mt-2 block underline"
                  href={documentTerms.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Read the verified document ↗
                </a>
                <p className="mt-2 break-all text-xs text-mx-ink-faint">
                  SHA-256: {documentTerms.sha256}
                </p>
                <label className="mt-3 flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={acceptedTerms}
                    onChange={(e) => setAcceptedTerms(e.target.checked)}
                    className="mt-1 accent-emerald-800"
                  />
                  <span>
                    I have read and accept this document version and its stated
                    risks and rights.
                  </span>
                </label>
              </>
            ) : (
              <p className="mt-2 text-mx-ink-faint">
                {documentError ?? "Loading the verified document…"}
              </p>
            )}
          </div>
          {pendingPurchase && (
            <div
              className="rounded-[3px] border border-amber-200 bg-amber-50 p-4 text-sm"
              role="status"
            >
              <p className="font-semibold">Purchase sent · recording pending</p>
              <p className="mt-1">
                Update this payment record without buying again.
              </p>
              <a
                className="mt-2 block underline"
                href={explorerTxUrl(
                  pendingPurchase.signature,
                  pendingPurchase.network,
                )}
                target="_blank"
                rel="noreferrer"
              >
                View transaction
              </a>
              <button
                className="mt-3 rounded border border-amber-300 px-3 py-2 disabled:opacity-50"
                disabled={recordingPurchase}
                onClick={() => void retryPurchaseRecord()}
              >
                {recordingPurchase ? "Verifying…" : "Retry recording"}
              </button>
            </div>
          )}
          {/* 1) Raise progress card */}
          <div className="rounded-[3px] border border-mx-rule bg-white p-6">
            <p className="mb-2 text-xs text-mx-ink-faint">
              {isStartup
                ? agg.unverifiedPledged !== null
                  ? "Pledged by verified investors · not paid"
                  : "Pledged commitments · not paid"
                : "Verified payments · payment token units"}
            </p>
            <div className="mb-4 flex items-baseline justify-between">
              <div>
                <span className="text-[26px] font-bold text-mx-indigo">
                  {!agg.available
                    ? "Unavailable"
                    : isStartup
                      ? fmtMoney(agg.pledged + agg.confirmed)
                      : `${formatPaymentTotal(agg.settled)} tokens`}
                </span>
                {isStartup && target > 0 && (
                  <span className="ml-2 text-sm text-mx-ink-faint">
                    of {fmtMoney(target)}
                  </span>
                )}
              </div>
              <span
                className={`text-sm font-semibold ${
                  pct >= 90 ? "text-emerald-600" : "text-mx-ink-soft"
                }`}
              >
                {agg.available
                  ? `${pct}% ${isStartup ? "pledged" : "sold"}`
                  : "Awaiting totals"}
              </span>
            </div>

            {!agg.available && (
              <p className="text-xs text-amber-800">
                Payment totals are temporarily unavailable.
              </p>
            )}
            {/* Pledging needs no KYC (policy 2026-09-23), so pledges from
                wallets without a live verification are not counted above
                (commitment_totals, migration 0062) — shown here instead. */}
            {agg.available &&
              isStartup &&
              agg.unverifiedPledgers !== null &&
              agg.unverifiedPledgers > 0 && (
                <p className="mb-2 text-xs text-mx-ink-faint">
                  Not counted: {fmtMoney(agg.unverifiedPledged ?? 0)} pledged
                  from {agg.unverifiedPledgers}{" "}
                  {agg.unverifiedPledgers === 1 ? "wallet" : "wallets"} without
                  identity verification.
                </p>
              )}
            {agg.available && agg.unverified > 0 && (
              <p className="text-xs text-amber-800">
                Historical payment records awaiting verification are excluded.
              </p>
            )}

            {/* Progress bar */}
            {target > 0 && (
              <div className="h-1.5 overflow-hidden rounded-full bg-mx-indigo-soft">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${
                    pct >= 90 ? "bg-emerald-500" : "bg-mx-indigo-soft"
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}

            {/* Stats footer */}
            <div className="mt-5 flex items-center justify-between border-t border-mx-rule pt-4">
              <div className="text-center">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
                  {isStartup
                    ? agg.unverifiedPledged !== null
                      ? "Verified pledgers"
                      : "Pledgers"
                    : "Buyers"}
                </p>
                <p className="mt-1 text-[15px] font-semibold text-mx-ink">
                  {!agg.available
                    ? "—"
                    : isStartup
                      ? agg.pledgers
                      : agg.backers}
                </p>
              </div>
              {equityOffered > 0 && (
                <div className="text-center">
                  <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
                    Equity
                  </p>
                  <p className="mt-1 text-[15px] font-semibold text-mx-ink">
                    {equityOffered}%
                  </p>
                </div>
              )}
              <div className="text-center">
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
                  Days left
                </p>
                <p
                  className={`mt-1 text-[15px] font-semibold ${
                    dLeft > 0 && dLeft <= 7 ? "text-rose-600" : "text-mx-ink"
                  }`}
                >
                  {dLeft > 0 ? dLeft : "—"}
                </p>
              </div>
            </div>
          </div>

          {/* 2) Payout health card — startup only, best-effort */}
          {isStartup && vault && <PayoutHealthCard vault={vault} />}

          {/* 2b) Startup raise disclosure — shown before the commit panel */}
          {isStartup && (
            <InfoBox>
              <p className="mb-1.5 font-semibold text-mx-indigo">
                Startup raise disclosure
              </p>
              <p>
                Startup raises settle through an escrowed payout vault: revenue
                routed through the vault is split 1/3 founder · 1/3 investor
                pool · 1/3 platform. Proceeds unlock monthly against posted
                progress updates; investors can freeze and vote after 3 missed
                updates.
              </p>
            </InfoBox>
          )}

          {/* 3) Commit panel */}
          <div className="rounded-[3px] border border-mx-rule bg-white p-6">
            <div className="mb-4 flex items-center justify-between gap-2">
              <p className="text-[15px] font-semibold text-mx-ink">
                {settlesOnChain ? "Buy shares" : "Back this company"}
              </p>
              {settlesOnChain ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-emerald-700">
                  On-chain
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 rounded-full border border-mx-rule bg-mx-paper px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-mx-ink-soft">
                  Soft commit
                </span>
              )}
            </div>

            {/* Sale-closed notice */}
            {!saleOpen && (
              <div className="mb-4 rounded-[3px] border border-mx-rule bg-mx-paper px-4 py-3">
                <p className="text-[13px] font-semibold text-mx-ink-soft">
                  Not accepting {settlesOnChain ? "buys" : "commitments"}
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-mx-ink-faint">
                  {closedReason}
                </p>
              </div>
            )}

            {/* Amount input */}
            <div className="relative mb-3">
              <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-lg font-semibold text-mx-ink-faint">
                {settlesOnChain ? "◈" : "$"}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9.]/g, "");
                  // collapse to a single decimal point
                  const parts = v.split(".");
                  setAmount(
                    parts.length > 2
                      ? `${parts[0]}.${parts.slice(1).join("")}`
                      : v,
                  );
                }}
                placeholder="0"
                className="w-full rounded-[3px] border border-mx-rule bg-white py-3.5 pl-8 pr-4 text-[22px] font-semibold text-mx-ink placeholder:text-mx-ink-faint focus:border-mx-indigo focus:outline-none focus:ring-2 focus:ring-mx-indigo-soft"
              />
            </div>

            {/* Preset buttons */}
            <div className="mb-4 flex flex-wrap gap-1.5">
              {["500", "1000", "2500", "5000", "10000"].map((preset) => {
                const isActive = amount === preset;
                return (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setAmount(preset)}
                    className={`rounded-[3px] border px-2.5 py-1 font-mono text-[11px] font-medium transition-colors ${
                      isActive
                        ? "border-mx-indigo bg-mx-indigo-soft text-mx-indigo"
                        : "border-mx-rule text-mx-ink-faint hover:border-mx-rule-strong hover:text-mx-ink-soft"
                    }`}
                  >
                    {settlesOnChain ? "" : "$"}
                    {Number(preset).toLocaleString()}
                  </button>
                );
              })}
            </div>

            {/* On-chain share-unit breakdown (Mature path) */}
            {settlesOnChain &&
              parsed > 0 &&
              paymentDecimals !== null &&
              onChainUnits > BigInt(0) && (
                <div className="mb-4 space-y-2">
                  <div className="flex items-center justify-between rounded-[3px] border border-mx-rule bg-mx-paper px-4 py-3">
                    <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-mx-ink-faint">
                      Share units
                    </span>
                    <span className="text-[16px] font-bold text-mx-ink">
                      {Number(onChainUnits).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-[3px] border border-mx-rule bg-mx-paper px-4 py-3">
                    <div>
                      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-mx-ink-faint">
                        You pay
                      </span>
                      <p className="mt-0.5 text-[10px] text-mx-ink-faint">
                        {String(pricePerUnit)} base units / share unit
                      </p>
                    </div>
                    <span className="text-[16px] font-bold text-mx-ink">
                      {formattedPayment}
                    </span>
                  </div>
                </div>
              )}

            {/* Equity calculator */}
            {isStartup && parsed > 0 && (
              <div className="mb-4 space-y-2">
                {/* Your equity */}
                <div className="flex items-center justify-between rounded-[3px] border border-mx-indigo bg-mx-indigo-soft px-4 py-3">
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-mx-indigo">
                    Your equity
                  </span>
                  <span className="text-[16px] font-bold text-mx-indigo">
                    {app
                      ? `~${yourEquity(equityOffered, parsed, target).toFixed(3)}%`
                      : "—"}
                  </span>
                </div>

                {/* Yield bonus — startup with app only */}
                {isStartup && app && (
                  <div className="flex items-center justify-between rounded-[3px] border border-emerald-100 bg-emerald-50 px-4 py-3">
                    <div>
                      <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.06em] text-emerald-600">
                        Yield bonus
                      </span>
                      <p className="mt-0.5 text-[10px] text-emerald-500">
                        Your 33% share · {saleData.vestingMonths}mo vest
                      </p>
                    </div>
                    <span className="text-[16px] font-bold text-emerald-700">
                      +
                      {fmtMoney(
                        investorYieldShare(
                          target,
                          saleData.vestingMonths,
                          parsed,
                        ),
                      )}
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Below-minimum notice */}
            {belowMin && (
              <div className="mb-4 rounded-[3px] border border-amber-200 bg-amber-50 px-4 py-2.5">
                <p className="text-[12px] font-semibold text-amber-800">
                  Minimum ticket is {app?.min_ticket}.
                </p>
              </div>
            )}

            {/* On-chain amount-too-small notice (Mature path) */}
            {onChainBelowOneUnit && !belowMin && (
              <div className="mb-4 rounded-[3px] border border-amber-200 bg-amber-50 px-4 py-2.5">
                <p className="text-[12px] font-semibold text-amber-800">
                  Increase your amount — it doesn&apos;t cover one whole share
                  unit at {String(pricePerUnit)} base units each.
                </p>
              </div>
            )}

            {/* On-chain over-remaining notice (Mature path) */}
            {onChainOverRemaining && (
              <div className="mb-4 rounded-[3px] border border-amber-200 bg-amber-50 px-4 py-2.5">
                <p className="text-[12px] font-semibold text-amber-800">
                  Only {String(remainingUnits)} share units remain — lower your
                  amount.
                </p>
              </div>
            )}

            {/* Eligibility gate notice */}
            {!!walletAddress && eligibility.gated && !eligibility.eligible && (
              <div className="mb-4 rounded-[3px] border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-[13px] font-semibold text-amber-800">
                  {eligibility.unverified
                    ? "Could not check this class's transfer rules"
                    : "KYC-gated class — investor passport required"}
                </p>
                <p className="mt-1 text-[12px] leading-relaxed text-amber-700">
                  {eligibility.reason}
                </p>
                {!eligibility.unverified && (
                  <>
                    <p className="mt-1 text-[12px] leading-relaxed text-amber-700">
                      Most classes can be bought without identity
                      verification. The platform made this one KYC-gated, so
                      buying and receiving it requires an approved investor
                      passport for your wallet.
                    </p>
                    <Link
                      href="/portfolio"
                      className="mt-2 inline-flex items-center gap-1 rounded-[3px] border border-amber-300 bg-white px-2.5 py-1 font-mono text-[11px] font-semibold text-amber-800 transition-colors hover:bg-amber-50"
                    >
                      View investor passport →
                    </Link>
                  </>
                )}
              </div>
            )}

            {/* Eligible badge — gated deal, user is approved */}
            {eligibility.gated && eligibility.eligible && (
              <div className="mb-4 flex items-center gap-2 rounded-[3px] border border-emerald-200 bg-emerald-50 px-3 py-2">
                <span className="h-2 w-2 rounded-full bg-emerald-500" />
                <p className="text-[12px] font-semibold text-emerald-700">
                  Eligible — your investor passport is verified
                </p>
              </div>
            )}

            {/* Commit / Buy button */}
            {!walletAddress ? (
              <WalletRequired />
            ) : (
              <button
                type="button"
                disabled={!canCommit}
                onClick={() => {
                  if (canCommit) {
                    setCommittedAmount(parsed);
                    setShowConfirm(true);
                  }
                }}
                className={`w-full rounded-[3px] py-3.5 text-[14px] font-semibold transition-all ${
                  canCommit
                    ? "bg-mx-ink text-mx-paper hover:opacity-90 active:scale-[0.98]"
                    : "cursor-default bg-mx-indigo-soft text-mx-ink-faint"
                }`}
              >
                {!saleOpen
                  ? startupUnavailable
                    ? "Not available"
                    : "Sale closed"
                  : eligibility.gated && !eligibility.eligible
                    ? eligibility.unverified
                      ? "Eligibility check failed"
                      : "Investor passport required"
                    : belowMin
                      ? `Minimum ${app?.min_ticket}`
                      : settlesOnChain && parsed > 0 && paymentDecimals === null
                        ? "Loading price…"
                        : onChainBelowOneUnit
                          ? "Amount too small"
                          : onChainOverRemaining
                            ? "Exceeds units left"
                            : parsed > 0
                              ? settlesOnChain
                                ? `Buy ${Number(onChainUnits).toLocaleString()} units · ${formattedPayment}`
                                : `Commit ${fmtExact(parsed)}`
                              : "Enter an amount"}
              </button>
            )}

            {/* Disclaimer */}
            <p className="mt-3 text-center text-[11px] leading-relaxed text-mx-ink-faint">
              {settlesOnChain ? (
                <>
                  Settles on-chain now: payment tokens debited, share tokens
                  minted to your wallet.
                </>
              ) : (
                <>
                  Non-binding intent — this raise settles off-chain through its
                  vesting schedule.
                </>
              )}
              <br />
              Min ticket: {app?.min_ticket ?? "—"} · Structure:{" "}
              {app?.raise_structure ?? "—"}
            </p>
          </div>
        </aside>
      </div>

      {/* ── Confirm modal ── */}
      <ConfirmModal
        open={showConfirm}
        onClose={() => setShowConfirm(false)}
        onConfirm={async () => {
          await handleConfirmedAction();
        }}
        title={
          settlesOnChain ? "Confirm your purchase" : "Confirm your commitment"
        }
        kind="info"
        requireReason={false}
        confirmLabel={
          settlesOnChain ? "Confirm purchase →" : "Confirm commitment →"
        }
        cancelLabel="Cancel"
        busy={commitBusy || tx.isSending}
        description={
          <div className="space-y-3">
            {documentTerms && (
              <p className="break-all text-xs text-mx-ink-faint">
                Accepted document: {documentTerms.versionId} · SHA-256{" "}
                {documentTerms.sha256}
              </p>
            )}
            <p className="text-sm text-mx-ink-soft">
              {settlesOnChain ? (
                <>
                  You&apos;re about to{" "}
                  <strong className="text-mx-ink">buy shares on-chain</strong>{" "}
                  in <strong className="text-mx-ink">{companyName}</strong>.
                  Your payment token will be debited and share tokens minted to
                  your wallet. Review the details below.
                </>
              ) : (
                <>
                  You&apos;re about to record a{" "}
                  <strong className="text-mx-ink">
                    non-binding commitment
                  </strong>{" "}
                  to invest in{" "}
                  <strong className="text-mx-ink">{companyName}</strong>. This
                  raise settles off-chain. Review the details below.
                </>
              )}
            </p>
            <div className="overflow-hidden rounded-[3px] border border-mx-rule">
              {(settlesOnChain
                ? [
                    { label: "Company", value: companyName },
                    {
                      label: "Share units",
                      value: Number(onChainUnits).toLocaleString(),
                    },
                    { label: "You pay", value: formattedPayment },
                    {
                      label: "Payment mint",
                      value: saleData.paymentMint,
                    },
                    { label: "Structure", value: app?.raise_structure ?? "—" },
                  ]
                : [
                    { label: "Company", value: companyName },
                    {
                      label: "Your commitment",
                      value: fmtExact(committedAmount),
                    },
                    {
                      label: "Your equity",
                      value: app
                        ? `~${yourEquity(equityOffered, committedAmount, target).toFixed(3)}%`
                        : "—",
                    },
                    { label: "Structure", value: app?.raise_structure ?? "—" },
                    { label: "Min ticket", value: app?.min_ticket ?? "—" },
                  ]
              ).map((row, i, arr) => (
                <div
                  key={row.label}
                  className={`flex items-center justify-between px-4 py-3 ${
                    i < arr.length - 1 ? "border-b border-mx-rule" : ""
                  }`}
                >
                  <span className="font-mono text-[11px] font-medium uppercase tracking-[0.06em] text-mx-ink-faint">
                    {row.label}
                  </span>
                  <span className="text-sm font-semibold text-mx-ink">
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        }
      />
    </section>
  );
}

// ── Payout health card ────────────────────────────────────────────────────────
function PayoutHealthCard({ vault }: { vault: PayoutVault }) {
  type StateConfig = {
    badge: string;
    dot: string;
    border: string;
    label: string;
    desc: string;
  };

  const stateConfig: Record<PayoutVaultState, StateConfig> = {
    [PayoutVaultState.Active]: {
      badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
      dot: "bg-emerald-500",
      border: "border-mx-rule",
      label: "Active",
      desc: "Founder is posting updates. Payouts flowing.",
    },
    [PayoutVaultState.Frozen]: {
      badge: "border-rose-200 bg-rose-50 text-rose-700",
      dot: "bg-rose-500",
      border: "border-rose-200",
      label: "Frozen",
      desc: "3+ missed updates. Investor vote in progress.",
    },
    [PayoutVaultState.Completed]: {
      badge: "border-mx-rule bg-mx-paper text-mx-ink-soft",
      dot: "bg-emerald-400",
      border: "border-mx-rule",
      label: "Completed",
      desc: "All tranches released.",
    },
    [PayoutVaultState.Cancelled]: {
      badge: "border-mx-rule bg-mx-paper text-mx-ink-faint",
      dot: "bg-mx-rule-strong",
      border: "border-mx-rule",
      label: "Cancelled",
      desc: "Vault cancelled — capital returned.",
    },
  };

  const cfg = stateConfig[vault.state] ?? stateConfig[PayoutVaultState.Active];

  return (
    <div className={`rounded-[3px] border bg-white p-5 ${cfg.border}`}>
      {/* Header */}
      <div className="mb-3 flex items-center justify-between">
        <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
          Payout health
        </p>
        <span
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-semibold ${cfg.badge}`}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${cfg.dot}`} />
          {cfg.label}
        </span>
      </div>

      {/* Progress dots */}
      {vault.numTranches > 0 && (
        <div className="mb-3 flex gap-1">
          {Array.from({ length: vault.numTranches }).map((_, i) => (
            <div
              key={i}
              className={`h-1 flex-1 rounded-full ${
                i < vault.tranchesReleased ? "bg-emerald-500" : "bg-mx-rule"
              }`}
            />
          ))}
        </div>
      )}

      {/* Stat line */}
      <p className="text-[12px] text-mx-ink-faint">
        {vault.tranchesReleased} of {vault.numTranches} payouts released ·{" "}
        {vault.updatesPosted} updates posted
      </p>

      {/* Description */}
      <p className="mt-1.5 text-[11px] leading-relaxed text-mx-ink-faint">
        {cfg.desc}
      </p>
    </div>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────
function OverviewTab({
  listing,
  app,
}: {
  listing: LaunchListing | null;
  app: PublicApplication | null;
}) {
  const problem = listing?.problem ?? app?.problem_or_why;
  const whyNow = listing?.why_now;
  const traction = listing?.traction ?? {};
  const tractionEntries = Object.entries(traction);
  const investors = app?.existing_investors ?? listing?.existing_investors;

  return (
    <div className="space-y-8">
      {/* The problem */}
      <section>
        <h2 className="mb-3 text-[15px] font-semibold text-mx-ink">
          The problem
        </h2>
        {problem ? (
          <p className="text-sm leading-relaxed text-mx-ink-soft">{problem}</p>
        ) : (
          <p className="text-sm text-mx-ink-faint">—</p>
        )}
      </section>

      {/* Why now */}
      <section>
        <h2 className="mb-3 text-[15px] font-semibold text-mx-ink">Why now</h2>
        {whyNow ? (
          <p className="text-sm leading-relaxed text-mx-ink-soft">{whyNow}</p>
        ) : (
          <p className="text-sm text-mx-ink-faint">—</p>
        )}
      </section>

      {/* Traction */}
      {tractionEntries.length > 0 && (
        <section>
          <h2 className="mb-3 text-[15px] font-semibold text-mx-ink">
            Traction
          </h2>
          <div className="grid grid-cols-3 gap-3">
            {tractionEntries.map(([key, value]) => (
              <div
                key={key}
                className="rounded-[3px] border border-mx-rule bg-white p-4 text-center"
              >
                <p className="font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
                  {key}
                </p>
                <p className="mt-1.5 text-xl font-semibold text-mx-indigo">
                  {value}
                </p>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Notable investors */}
      {investors && (
        <section>
          <InfoBox>
            <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-[0.08em] text-mx-ink-faint">
              Notable investors
            </p>
            <p className="font-medium text-mx-ink">{investors}</p>
          </InfoBox>
        </section>
      )}
    </div>
  );
}

// ── Terms tab ────────────────────────────────────────────────────────────────
function TermsTab({
  sale,
  app,
  isStartup,
  dLeft,
}: {
  sale: Sale;
  app: PublicApplication | null;
  isStartup: boolean;
  dLeft: number;
}) {
  type TermRow = {
    label: string;
    value: string;
    note?: string;
  };

  const disbursementValue =
    isStartup && sale.vestingMonths > 0
      ? `${sale.vestingMonths} months linear (monthly)`
      : "Immediate upon close";
  const disbursementNote =
    isStartup && sale.cliffMonths > 0
      ? `${sale.cliffMonths}-month cliff before first payout`
      : undefined;

  const rows: TermRow[] = [
    {
      label: "Raise amount",
      value: app ? fmtMoney(app.raise_amount) : "—",
      note: app ? "Annual equity sale, max $3M" : undefined,
    },
    {
      label: "Equity offered",
      value: app ? `${app.equity_offered}%` : "—",
      note: app ? "Actual company ownership" : undefined,
    },
    {
      label: "Implied valuation",
      value:
        app && app.raise_amount > 0 && app.equity_offered > 0
          ? fmtMoney(impliedValuation(app.raise_amount, app.equity_offered))
          : "—",
    },
    {
      label: "Structure",
      value: app?.raise_structure ?? "—",
    },
    {
      label: "Disbursement",
      value: disbursementValue,
      note: disbursementNote,
    },
    ...(isStartup && sale.vestingMonths > 0
      ? [
          {
            label: "Safeguard",
            value: "Monthly update required",
            note: "Miss 3 → funds freeze, investor vote",
          } as TermRow,
        ]
      : []),
    {
      label: "Min ticket",
      value: app?.min_ticket ?? "—",
    },
    {
      label: "Incorporation",
      value: app?.incorporation ?? "—",
    },
    {
      label: "Time remaining",
      value: dLeft === 0 ? "—" : `${dLeft} days`,
    },
  ];

  return (
    <div className="space-y-5">
      {/* Terms table */}
      <div className="overflow-hidden rounded-[3px] border border-mx-rule bg-white">
        {rows.map((row, i) => (
          <div
            key={row.label}
            className={`flex items-center justify-between px-5 py-4 ${
              i < rows.length - 1 ? "border-b border-mx-rule" : ""
            }`}
          >
            <div>
              <p className="text-sm text-mx-ink-faint">{row.label}</p>
              {row.note && (
                <p className="mt-0.5 font-mono text-[11px] text-mx-ink-faint">
                  {row.note}
                </p>
              )}
            </div>
            <p className="text-[15px] font-semibold text-mx-ink">{row.value}</p>
          </div>
        ))}
      </div>

      {/* What you're buying */}
      <InfoBox>
        <p className="mb-1.5 font-semibold text-mx-indigo">
          What you&apos;re buying
        </p>
        <p>
          This is <strong className="text-mx-ink">real equity</strong> in a real
          company — not a token. You will receive a{" "}
          {app?.raise_structure ?? "SAFE"} agreement granting you pro-rata
          ownership. Founders can sell up to $3M/year of company equity through
          this platform.
        </p>
      </InfoBox>

      {/* Yield bonus — startup only */}
      {isStartup && sale.vestingMonths > 0 && (
        <InfoBox tone="good">
          <p className="mb-2 font-semibold text-emerald-800">
            Yield bonus for backers
          </p>
          <p className="mb-3">
            Unvested funds sit in treasury-backed stablecoins earning ~5% APY.
            Yield is split equally three ways over {sale.vestingMonths} months.
          </p>
          <YieldSplit
            labels={["33% founder", "33% investors", "33% platform"]}
          />
        </InfoBox>
      )}
    </div>
  );
}

// ── Founder tab ───────────────────────────────────────────────────────────────
function FounderTab({ app }: { app: PublicApplication | null }) {
  const founderName = app?.founder_name;
  const initials = founderName
    ? founderName
        .split(" ")
        .map((n) => n[0])
        .join("")
    : "?";

  return (
    <div>
      {/* Founder identity row */}
      <div className="mb-6 flex items-start gap-4">
        <div className="flex h-[52px] w-[52px] flex-shrink-0 items-center justify-center rounded-full border border-mx-rule bg-mx-indigo-soft text-lg font-semibold text-mx-ink-faint">
          {initials}
        </div>
        <div>
          <p className="text-[17px] font-semibold text-mx-ink">
            {founderName ?? "—"}
          </p>
          {app?.founder_twitter && (
            <p className="mt-0.5 font-mono text-[12px] text-mx-ink-faint">
              {app.founder_twitter}
            </p>
          )}
        </div>
      </div>

      {/* Why the right person */}
      <h2 className="mb-3 text-[14px] font-semibold text-mx-ink">
        Why they&apos;re the right person
      </h2>
      {app?.founder_why ? (
        <p className="text-sm leading-relaxed text-mx-ink-soft">
          {app.founder_why}
        </p>
      ) : (
        <p className="text-sm text-mx-ink-faint">—</p>
      )}
    </div>
  );
}

// ── Updates tab ───────────────────────────────────────────────────────────────
function UpdatesTab({ updates }: { updates: LaunchUpdate[] }) {
  if (updates.length === 0) {
    return <p className="text-sm text-mx-ink-faint">No updates yet.</p>;
  }

  return (
    <div>
      {updates.map((u, i) => (
        <div
          key={u.id}
          className={`py-5 ${i < updates.length - 1 ? "border-b border-mx-rule" : ""}`}
        >
          <p className="mb-2 font-mono text-[11px] tracking-[0.04em] text-mx-ink-faint">
            {new Date(u.posted_at).toLocaleDateString()}
          </p>
          <p className="mb-2 text-[15px] font-semibold text-mx-ink">
            {u.title}
          </p>
          <p className="text-[13px] leading-relaxed text-mx-ink-faint">
            {u.body}
          </p>
        </div>
      ))}
    </div>
  );
}

"use client";

// Distribute → "Public sale" (design §4, lib/public-sale): the tokens not
// created yet, offered at one price for 30, 90 or 365 days; buyers pay USDC
// on the sale page (no KYC to buy — a platform-linked wallet: signed in, the
// Terms accepted, sanctions screened — enforced there), purchases are final
// (Mature sale, no refunds) and the proceeds go to the issuer's USDC account.
//
// Where the class stands decides what the panel shows (publicSaleStage):
//   form       price (prefilled from the tokenize price), tokens (default: the
//              room left), 30 / 90 / 365 days and the buyer document → one
//              "Request public sale" (the document uploaded — 2 signatures —
//              unless it is the asset's published one, then the request,
//              which publishes it: 1 signature);
//   requested  waiting for the operator (approve, then reopen Primary
//              issuance after the pre-clear check) — withdraw any time;
//   approved   "Open sale": one transaction, start now, end = the chosen
//              duration, tokens = the request's, never past the approval or
//              the room read fresh; then the listing (1 signature);
//   open       the live sale and "End and collect": once the super admin
//              cleared 0x20, close_sale to the issuer's USDC account (another
//              USDC account only after its owner is shown and confirmed); an
//              Admin issuer key sets 0x20 (and 0x02, unless another Open sale
//              can still take a buy: lib/open-sales-chain reads every Open
//              sale with its issuer's freeze) again in the same transaction.
// Nothing here touches the program's rules: every step is checked again on
// chain and by the server.

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchEncodedAccount, isAddress, type Address } from "@solana/kit";
import { getTokenDecoder } from "@solana-program/token-2022";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { fetchMaybeSale, fetchMaybeShareClass, type Asset, type Sale, type ShareClass } from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { recordAudit } from "@/lib/supabase";
import { walletSigner } from "@/lib/wallet-signer";
import { features } from "@/lib/features";
import { isPaused, PAUSE_ISSUER_PROCEEDS, PAUSE_PRIMARY } from "@/lib/pause-flags";
import { clearPauseFlagsCache } from "@/lib/pause-gate";
import { signedUpload, sha256HexOfFile } from "@/lib/storage-client";
import { formatTokens } from "@/lib/tokenize-shares";
import { shortAddress } from "@/lib/share-transfer";
import { roomToCreate, type SupplyFacts } from "@/lib/distribution-supply";
import { listOpenSales, openSaleRemaining, readPlatformPause } from "@/lib/distribution-chain";
import { listOpenSalesWithFreezes, type OpenSaleWithFreeze } from "@/lib/open-sales-chain";
import { nowSeconds } from "@/lib/sale-liveness";
import {
  isApprovalLive,
  listSaleReservations,
  listShareClassSaleApprovals,
  maxUnitsAt,
  reservedTreasuryUnits,
  type SaleApprovalAccount,
} from "@/lib/sale-approvals";
import {
  DEFAULT_SALE_DURATION_DAYS,
  SALE_DURATION_DAYS,
  USDC_DECIMALS,
  approvalUnits,
  closeFlowStep,
  docMatchesLegalHash,
  formatUsdc,
  maxGrossRaise,
  publicSaleStage,
  saleEndTs,
  tokenizePricePerTokenE6,
  tokensToOffer,
  usdcToBaseUnits,
  type SaleDurationDays,
} from "@/lib/public-sale";
import { decideSaleRequest, listSaleRequests, submitSaleRequest, type SaleRequestRow } from "@/lib/sale-requests";
import { openApprovedSale, OpenSaleError } from "@/lib/open-sale";
import { buildEndAndCollect, readProceedsAccount, type ProceedsAccount } from "@/lib/close-sale";
import { fromBaseUnits } from "@/lib/sale-approvals";

type Props = {
  asset: Asset;
  sc: ShareClass;
  scPda: Address;
  tokenize: Record<string, unknown> | null;
  /** The card's view of the supply (refreshed with the page). */
  supply: SupplyFacts;
  /** The connected issuer key is an Admin (it can set pause bits again itself). */
  canCreate: boolean;
  onRefresh: () => Promise<void>;
  /** "Both": tokens the wallet list takes from the room first (the sale offers the rest). */
  reserveForList?: bigint;
  /** The asset's published buyer document, when it has one (choosing the same file skips the upload). */
  publishedDocument?: { path: string; sha256: string } | null;
};

type ChainView = {
  openSale: (Sale & { address: Address }) | null;
  /** USDC in the open sale's proceeds escrow. */
  proceeds: bigint | null;
  approvals: SaleApprovalAccount[];
  /** Open sales of every issuer other than this class's open one, with their issuers' freezes (lib/open-sales-chain). */
  otherSales: OpenSaleWithFreeze[];
  /** When these were read (unix seconds): what "can take a buy" is judged at. */
  nowSec: number;
  flags: number | null;
  superAdmin: string | null;
};

const inputClass =
  "rounded-md border border-slate-300 px-2 py-1 font-mono text-sm focus:border-slate-400 focus:outline-none";
const ZERO = BigInt(0);

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dateOf(ts: bigint): string {
  return new Date(Number(ts) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

export function PublicSalePanel({ asset, sc, scPda, tokenize, supply, canCreate, onRefresh, reserveForList = ZERO, publishedDocument = null }: Props) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const rpc = client.runtime.rpc;
  const session = conn.wallet;
  const wallet = session?.account.address ?? null;

  const [refreshKey, setRefreshKey] = useState(0);
  const [chain, setChain] = useState<ChainView | null>(null);
  const [chainError, setChainError] = useState<string | null>(null);
  const [row, setRow] = useState<SaleRequestRow | null>(null);
  const [rowState, setRowState] = useState<"loading" | "ready" | "sign-in" | "error">("loading");
  const [priceText, setPriceText] = useState<string | null>(null);
  const [tokensText, setTokensText] = useState<string | null>(null);
  const [days, setDays] = useState<SaleDurationDays>(DEFAULT_SALE_DURATION_DAYS);
  const [doc, setDoc] = useState<{ file: File; sha: string } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"request" | "open" | "close" | null>(null);
  const [useOther, setUseOther] = useState(false);
  const [otherText, setOtherText] = useState("");
  const [other, setOther] = useState<{ text: string; account: ProceedsAccount } | null>(null);
  const [otherProblem, setOtherProblem] = useState<string | null>(null);
  const [otherConfirmed, setOtherConfirmed] = useState(false);

  // ── Chain: the class's open sale and live approvals, every Open sale, the Platform ──
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [classSales, approvals, all, platform] = await Promise.all([
          listOpenSales(rpc, { shareClass: scPda }),
          listShareClassSaleApprovals(rpc, scPda),
          listOpenSalesWithFreezes(rpc),
          readPlatformPause(rpc),
        ]);
        let openSale: ChainView["openSale"] = null;
        let proceeds: bigint | null = null;
        if (classSales[0]) {
          const found = await fetchMaybeSale(rpc, classSales[0].address, { commitment: "confirmed" });
          if (found.exists) {
            openSale = { ...found.data, address: classSales[0].address };
            try {
              const escrow = await fetchEncodedAccount(rpc, found.data.proceeds, { commitment: "confirmed" });
              proceeds = escrow.exists ? getTokenDecoder().decode(escrow.data).amount : ZERO;
            } catch {
              proceeds = null;
            }
          }
        }
        if (cancelled) return;
        setChain({
          openSale,
          proceeds,
          approvals: approvals.filter((a) => isApprovalLive(a)).sort((a, b) => (b.saleId > a.saleId ? 1 : b.saleId < a.saleId ? -1 : 0)),
          otherSales: all.filter((s) => s.address !== openSale?.address),
          nowSec: nowSeconds(),
          flags: platform?.flags ?? null,
          superAdmin: platform?.superAdmin.toString() ?? null,
        });
        setChainError(null);
      } catch (err) {
        if (!cancelled) setChainError(`Could not read the sale state from the network: ${errorText(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc, scPda, refreshKey]);

  // ── The class's request (a session read; no prompt) ──
  const loadRequest = useCallback(
    async (interactive: boolean) => {
      if (!session) return;
      try {
        const rows = await listSaleRequests(session, { share_class: scPda }, { interactive });
        setRow(rows[0] ?? null);
        setRowState("ready");
      } catch (err) {
        if (!interactive) setRowState("sign-in");
        else {
          setRowState("error");
          setProblem(errorText(err));
        }
      }
    },
    [session, scPda],
  );
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadRequest(false);
  }, [loadRequest, refreshKey]);

  const refreshAll = useCallback(async () => {
    setRefreshKey((k) => k + 1);
    await onRefresh().catch(() => undefined);
  }, [onRefresh]);

  // ── Derived ──
  const request = row?.request ?? null;
  // A request whose sale opened (or closed) is history: the form is offered again.
  const liveRequest = request && request.status === "requested" && row?.outcome !== "opened" && row?.outcome !== "closed" ? request : null;
  const stage = publicSaleStage({ request: liveRequest, liveApprovals: chain?.approvals.length ?? 0, openSales: chain?.openSale ? 1 : 0 });
  const company = typeof tokenize?.company_name === "string" ? tokenize.company_name : asset.name;
  const tokenizeE6 = useMemo(() => tokenizePricePerTokenE6(tokenize), [tokenize]);
  const defaultPrice = tokenizeE6 !== null ? fromBaseUnits(tokenizeE6, USDC_DECIMALS) : "";
  const price = usdcToBaseUnits(priceText ?? defaultPrice);
  const room = roomToCreate(supply);
  const offerable = room === null ? null : room > reserveForList ? room - reserveForList : ZERO;
  const defaultTokens = offerable === null ? "" : offerable.toString();
  const tokensRaw = (tokensText ?? defaultTokens).trim();
  const tokens = /^\d{1,19}$/.test(tokensRaw) ? BigInt(tokensRaw) : null;
  const docMatches = doc ? docMatchesLegalHash(doc.sha, asset.legalDocHash) : false;
  const docPublished = !!doc && !!publishedDocument && publishedDocument.sha256 === doc.sha;
  const flags = chain?.flags ?? null;
  const primaryOpen = flags !== null && !isPaused(flags, PAUSE_PRIMARY);
  const proceedsPaused = flags !== null && isPaused(flags, PAUSE_ISSUER_PROCEEDS);
  const superAdminText = chain?.superAdmin ? `the super admin (${shortAddress(chain.superAdmin as Address)})` : "the super admin";
  // The approval the operator reserved for this request when it is live, else the class's newest live one.
  const approval = chain?.approvals.find((a) => a.address === row?.reservation?.approval_pda) ?? chain?.approvals[0] ?? null;
  const busy = working !== null || tx.isSending;

  const formProblem =
    price === null
      ? "Enter the price per token in USDC (up to 6 decimals)."
      : tokens === null || tokens <= ZERO
        ? "Enter how many tokens to offer (at least 1)."
        : offerable !== null && tokens > offerable
          ? `At most ${formatTokens(offerable)} tokens can be offered (the cap minus everything created, on sale or reserved${reserveForList > ZERO ? ", and the wallet list" : ""}).`
          : !doc
            ? "Choose the document buyers read before they buy."
            : null;

  // ── Request ──
  async function submitRequest() {
    setConfirm(null);
    if (!session || formProblem || price === null || tokens === null || !doc) return;
    setProblem(null);
    try {
      let document = { path: publishedDocument?.path ?? "", sha256: doc.sha };
      if (!docPublished) {
        setWorking("Confirm in your wallet: upload the document (2 signatures)");
        const safeName = doc.file.name.replace(/[^A-Za-z0-9._-]+/g, "_");
        const uploaded = await signedUpload(session, { path: `whitepapers/${sc.asset}/${doc.sha.slice(0, 8)}-${safeName}`, file: doc.file, sha256: doc.sha });
        document = { path: uploaded.path, sha256: uploaded.sha256 };
      }
      setWorking("Confirm in your wallet: request the public sale (it also publishes the document)");
      const result = await submitSaleRequest(session, {
        share_class: scPda,
        price_per_unit: price.toString(),
        tokens: tokens.toString(),
        duration_days: days,
        document,
      });
      setRow({ asset: result.asset, display_name: row?.display_name ?? null, request: result.request, outcome: null });
      setRowState("ready");
      toast.show({ kind: "success", title: "Public sale requested", description: "The operator reviews and approves it; you then open it here." });
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setWorking(null);
    }
  }

  async function withdraw() {
    if (!session || !liveRequest) return;
    setProblem(null);
    setWorking("Confirm in your wallet: withdraw the request");
    try {
      const result = await decideSaleRequest(session, { share_class: scPda, request_id: liveRequest.id, action: "withdraw" });
      setRow((r) => (r ? { ...r, request: result.request } : r));
    } catch (err) {
      setProblem(errorText(err));
    } finally {
      setWorking(null);
    }
  }

  // ── Open ──
  const openDays: SaleDurationDays = liveRequest?.duration_days ?? days;
  async function openSale() {
    setConfirm(null);
    if (!session || !wallet || !approval) return;
    setProblem(null);
    try {
      setWorking("Checking the supply and Primary issuance…");
      const [platform, scNow, classSales, approvals, reservations] = await Promise.all([
        readPlatformPause(rpc),
        fetchMaybeShareClass(rpc, scPda, { commitment: "confirmed" }),
        listOpenSales(rpc, { shareClass: scPda }),
        listShareClassSaleApprovals(rpc, scPda),
        canCreate
          ? listSaleReservations(session, { share_class: scPda }, true, { interactive: false }).catch(() => null)
          : Promise.resolve(null),
      ]);
      if (!platform) throw new Error("Could not read the platform's pause flags; nothing was sent. Try again.");
      if (isPaused(platform.flags, PAUSE_PRIMARY)) {
        throw new Error(`Primary issuance (0x02) is closed: only ${superAdminText} can reopen it, after the pre-clear check.`);
      }
      if (!scNow.exists) throw new Error("The share class could not be read.");
      if (classSales.length > 0) throw new Error("A sale of this class is already open.");
      const live = approvals.filter((a) => isApprovalLive(a));
      const mine = live.find((a) => a.address === approval.address);
      if (!mine) throw new Error("The approval is no longer live (expired, opened or revoked). Refresh.");
      const price = mine.minPricePerUnit;
      const roomNow = roomToCreate({
        maxSupply: scNow.data.maxSupply.__option === "Some" ? scNow.data.maxSupply.value : null,
        lifetimeMinted: scNow.data.lifetimeMinted,
        version: scNow.data.version,
        supplyLocked: scNow.data.supplyLocked,
        mintablePostLaunch: scNow.data.mintablePostLaunch,
        openSaleRemaining: openSaleRemaining(classSales),
        reservedUnminted: reservations ? reservedTreasuryUnits(reservations) : supply.reservedUnminted,
        // Other approvals of the class keep their tokens; this one is what is being opened.
        approvedUnopened: live.filter((a) => a.address !== mine.address).reduce((s, a) => s + approvalUnits(a), ZERO),
        treasuryBalance: ZERO,
      });
      const requested = liveRequest ? BigInt(liveRequest.tokens) : approvalUnits(mine);
      const n = tokensToOffer({ requested, approvalMaxUnits: maxUnitsAt(mine, price), room: roomNow });
      if (n <= ZERO) throw new Error("No tokens are left to offer (the cap is reached or reserved).");
      setWorking(`Confirm in your wallet: open the sale of ${formatTokens(n)} tokens for ${openDays} days`);
      const result = await openApprovedSale({
        rpc,
        session,
        send: (request) => tx.send(request),
        issuerPda: asset.issuer,
        assetPda: sc.asset,
        approval: mine,
        mint: sc.mint,
        pricePerUnit: price,
        totalForSale: n,
        endTs: saleEndTs(openDays, Math.floor(Date.now() / 1000)),
        listing: { application_id: null, logo_letter: (company[0] ?? "•").toUpperCase() },
      });
      clearPauseFlagsCache();
      toast.showTx(result.signature, { title: `Sale open: ${formatTokens(n)} tokens at ${formatUsdc(price)} USDC` });
      if (!result.published) {
        setProblem(`The sale is open, but its listing could not be published (${result.publishError}). Publish it from My sales → "Publish existing sale"; no second transaction is needed.`);
      }
      void recordAudit({
        ix_name: "open_sale",
        category: "launchpad",
        actor_wallet: wallet.toString(),
        reason: `Public sale opened: ${n} tokens at ${formatUsdc(price)} USDC for ${openDays} days`,
        target_label: result.salePda,
        tx_signature: result.signature,
        metadata: { share_class: scPda, approval: mine.address, request_id: liveRequest?.id ?? null, duration_days: openDays, total_for_sale: n.toString() },
      });
    } catch (err) {
      const e = err instanceof OpenSaleError ? err : null;
      setProblem(
        e?.stage === "submitted" || e?.stage === "intent-saved"
          ? `${explainSendError(e.cause ?? e)} The sale may still have opened: check My sales before trying again.`
          : explainSendError(e?.cause ?? err),
      );
    } finally {
      setWorking(null);
      await refreshAll();
    }
  }

  // ── End and collect ──
  const openSaleNow = chain?.openSale ?? null;
  const step =
    chain && openSaleNow && flags !== null
      ? closeFlowStep({ flags, saleOpen: true, otherSales: chain.otherSales, nowSec: chain.nowSec })
      : null;
  const otherReady = !useOther || (other !== null && other.text === otherText.trim() && otherConfirmed);

  async function checkOther() {
    setOtherProblem(null);
    setOther(null);
    setOtherConfirmed(false);
    const text = otherText.trim();
    if (!openSaleNow || !isAddress(text)) {
      setOtherProblem("Enter a USDC token account address.");
      return;
    }
    try {
      const read = await readProceedsAccount(rpc, text as Address, openSaleNow);
      if ("problem" in read) setOtherProblem(read.problem);
      else setOther({ text, account: read.account });
    } catch (err) {
      setOtherProblem(`Could not read that account: ${errorText(err)}`);
    }
  }

  async function endAndCollect() {
    setConfirm(null);
    if (!session || !wallet || !openSaleNow) return;
    setProblem(null);
    try {
      setWorking("Checking the sale and the pause flags…");
      const [platform, all, saleNow] = await Promise.all([
        readPlatformPause(rpc),
        listOpenSalesWithFreezes(rpc),
        fetchMaybeSale(rpc, openSaleNow.address, { commitment: "confirmed" }),
      ]);
      if (!platform) throw new Error("Could not read the platform's pause flags; nothing was sent. Try again.");
      if (!saleNow.exists) throw new Error("The sale could not be read.");
      const flow = closeFlowStep({
        flags: platform.flags,
        saleOpen: true,
        // Another sale that ended, sold out or whose issuer is frozen does not need Primary issuance: only one that can
        // still take a buy (an unread freeze never keeps 0x02 open).
        otherSales: all.filter((s) => s.address !== openSaleNow.address),
        nowSec: nowSeconds(),
      });
      if (flow.step === "clear-proceeds") throw new Error(`Proceeds are paused (0x20): ${superAdminText} clears it first.`);
      let destination: ProceedsAccount | null = null;
      if (useOther) {
        if (!other || !otherConfirmed) throw new Error("Check and confirm the other USDC account first.");
        const again = await readProceedsAccount(rpc, other.account.tokenAccount, saleNow.data);
        if ("problem" in again || again.account.owner !== other.account.owner) throw new Error("The other USDC account changed; check it again.");
        destination = again.account;
      }
      const repause = canCreate && flow.step === "close" ? flow.repause : 0;
      const signer = walletSigner(session);
      const built = await buildEndAndCollect(rpc, {
        signer,
        sale: { ...saleNow.data, address: openSaleNow.address },
        destination,
        repause,
        syncIssuerKey: features().issuerRotation,
      });
      setWorking(`Confirm in your wallet: end the sale and collect the proceeds${repause ? " (and close Primary issuance / proceeds again)" : ""}`);
      const signature = await tx.send({ instructions: built.instructions, feePayer: signer });
      clearPauseFlagsCache();
      toast.showTx(signature, { title: "Sale ended, proceeds collected" });
      void recordAudit({
        ix_name: "close_sale",
        category: "launchpad",
        actor_wallet: wallet.toString(),
        reason: `Public sale ended: ${saleNow.data.sold} of ${saleNow.data.totalForSale} tokens sold; proceeds to ${built.destination.tokenAccount}`,
        target_label: openSaleNow.address,
        tx_signature: signature,
        metadata: {
          share_class: scPda,
          destination: built.destination.tokenAccount,
          destination_owner: built.destination.owner,
          own_account: destination === null,
          proceeds: chain?.proceeds?.toString() ?? null,
          repause_mask: repause,
        },
      });
      if (!canCreate) {
        setProblem("The sale is closed. An Admin now sets Primary issuance (0x02) and issuer proceeds (0x20) again (Admin → Launchpad).");
      }
    } catch (err) {
      setProblem(explainSendError(err));
    } finally {
      setWorking(null);
      await refreshAll();
    }
  }

  if (!wallet) return null;

  return (
    <div className="mt-3 space-y-3 text-[13px] text-slate-700">
      {chainError && <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">{chainError}</p>}
      {!chain && !chainError && <p className="text-slate-500">Reading the sale state…</p>}

      {chain && stage === "form" && (
        <>
          {request && request.status !== "requested" && (
            <p className="text-[12px] text-slate-500">
              The last request was {request.status}
              {request.reason ? `: ${request.reason}` : ""}.
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">Price per token (USDC)</span>
              <input
                value={priceText ?? defaultPrice}
                onChange={(e) => setPriceText(e.target.value)}
                inputMode="decimal"
                placeholder="e.g. 2.5"
                className={`${inputClass} w-full text-right`}
              />
              {tokenizeE6 !== null && priceText === null && <span className="mt-0.5 block text-[11px] text-slate-500">Your tokenize price.</span>}
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">Tokens offered</span>
              <input
                value={tokensText ?? defaultTokens}
                onChange={(e) => setTokensText(e.target.value.replace(/[^\d]/g, ""))}
                inputMode="numeric"
                className={`${inputClass} w-full text-right`}
              />
              <span className="mt-0.5 block text-[11px] text-slate-500">
                {offerable === null ? "No cap." : `At most ${formatTokens(offerable)} (everything not created yet${reserveForList > ZERO ? " beside the wallet list" : ""}).`}
              </span>
            </label>
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-600">Sale runs for</span>
            <div role="radiogroup" aria-label="Sale duration" className="flex gap-2">
              {SALE_DURATION_DAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={days === d}
                  onClick={() => setDays(d)}
                  className={`rounded-md px-3 py-1 text-xs font-medium ${days === d ? "bg-slate-900 text-white" : "border border-slate-300 text-slate-700 hover:border-slate-400"}`}
                >
                  {d} days
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="mb-1 block text-xs font-medium text-slate-600">Document buyers read</span>
            <label className="inline-block cursor-pointer rounded-md border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-slate-400">
              {doc ? "Choose another file" : "Choose a file (PDF)"}
              <input
                type="file"
                accept=".pdf,.docx,application/pdf"
                className="sr-only"
                onChange={(e) => {
                  const file = e.target.files?.[0] ?? null;
                  if (!file) return;
                  void sha256HexOfFile(file).then((sha) => setDoc({ file, sha }));
                }}
              />
            </label>
            {doc && (
              <span className={`ml-2 text-[12px] ${docMatches ? "text-emerald-800" : "text-slate-600"}`}>
                {doc.file.name} ·{" "}
                {docMatches
                  ? "✓ the document of your token (matches its on-chain hash)"
                  : "a separate offering document (buyers read this one)"}
                {docPublished ? " · already published" : ""}
              </span>
            )}
          </div>
          {price !== null && tokens !== null && tokens > ZERO && (
            <p className="text-[12px] text-slate-600">
              {formatTokens(tokens)} tokens × {formatUsdc(price)} USDC = up to <strong>{formatUsdc(maxGrossRaise(tokens, price))} USDC</strong>, paid
              in USDC; purchases are final. Proceeds go to your USDC account when you end the sale.
            </p>
          )}
          <p className="text-[12px] text-slate-500">
            Wallet prompts: {docPublished ? "1 (the request; your document is already published)" : "2 to upload the document + 1 for the request (it also publishes the document)"}.
            Next: the operator approves the sale and reopens Primary issuance; you then open it here with one transaction.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              disabled={!!formProblem || busy || !session}
              onClick={() => setConfirm("request")}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Request public sale
            </button>
            {working ? <span aria-live="polite">{working}</span> : formProblem && <span className="text-[12px] text-amber-700">{formProblem}</span>}
          </div>
        </>
      )}

      {chain && stage === "requested" && liveRequest && (
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
          <p>
            Requested {new Date(liveRequest.requested_at).toLocaleDateString("en-GB")}: {formatTokens(BigInt(liveRequest.tokens))} tokens at{" "}
            {formatUsdc(BigInt(liveRequest.price_per_unit))} USDC for {liveRequest.duration_days} days ·{" "}
            {liveRequest.document.matches_legal_doc ? "✓ your token's document" : "separate offering document"}.
          </p>
          <p className="mt-1 text-[12px] text-slate-500">
            Waiting for the operator: they approve the sale and reopen Primary issuance after checking that nothing else could
            open or sell meanwhile. Then you open it here (one transaction).
          </p>
          <button type="button" disabled={busy} onClick={() => void withdraw()} className="mt-1 text-[12px] font-medium underline disabled:opacity-50">
            Withdraw the request
          </button>
        </div>
      )}

      {chain && stage === "approved" && approval && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-950">
          <p className="font-medium">Approved by the operator</p>
          <p className="mt-1">
            {formatUsdc(approval.minPricePerUnit)} USDC per token · up to {formatTokens(maxUnitsAt(approval, approval.minPricePerUnit))} tokens · open by{" "}
            {dateOf(approval.expiresAt)}
            {liveRequest ? ` · ${formatTokens(BigInt(liveRequest.tokens))} tokens requested` : ""}.
          </p>
          {!liveRequest && (
            <div className="mt-2 flex gap-2" role="radiogroup" aria-label="Sale duration">
              {SALE_DURATION_DAYS.map((d) => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={days === d}
                  onClick={() => setDays(d)}
                  className={`rounded-md px-3 py-1 text-xs font-medium ${days === d ? "bg-emerald-900 text-white" : "border border-emerald-300 text-emerald-900"}`}
                >
                  {d} days
                </button>
              ))}
            </div>
          )}
          {!primaryOpen ? (
            <p className="mt-2 text-[12px] text-amber-800">
              Waiting for Primary issuance (0x02): only {superAdminText} can reopen it, after checking that nothing else could open or
              sell meanwhile.
            </p>
          ) : (
            <p className="mt-2 text-[12px]">
              Opens now and runs {openDays} days. Wallet prompts: 1 transaction + 1 to publish the listing.
            </p>
          )}
          <button
            type="button"
            disabled={!primaryOpen || busy}
            onClick={() => setConfirm("open")}
            className="mt-2 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
          >
            Open sale
          </button>
          {working && <span className="ml-3" aria-live="polite">{working}</span>}
        </div>
      )}

      {chain && stage === "open" && openSaleNow && (
        <div className="space-y-2">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-emerald-950">
            <p className="font-medium">Sale live</p>
            <p className="mt-1">
              {formatTokens(openSaleNow.sold)} of {formatTokens(openSaleNow.totalForSale)} sold at {formatUsdc(openSaleNow.pricePerUnit)} USDC ·{" "}
              {openSaleNow.endTs > ZERO ? `ends ${dateOf(openSaleNow.endTs)}` : "no end"}
              {chain.proceeds !== null ? ` · ${formatUsdc(chain.proceeds)} USDC collected so far` : ""} ·{" "}
              <a href={`/marketplace/launchpad/${openSaleNow.address}`} className="underline">
                sale page
              </a>
            </p>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
            <p className="font-medium text-slate-900">End and collect</p>
            {step?.step === "clear-proceeds" || proceedsPaused ? (
              <p className="mt-1 text-[12px] text-amber-800">
                Proceeds are paused platform-wide (0x20): {superAdminText} clears it when you want to end the sale (Admin → Launchpad).
                Buyers keep buying until then.
              </p>
            ) : (
              <>
                <p className="mt-1 text-[12px] text-slate-600">
                  Ends the sale now (no more buys) and sends all proceeds
                  {chain.proceeds !== null ? ` (${formatUsdc(chain.proceeds)} USDC)` : ""} to your USDC account
                  {canCreate
                    ? step?.step === "close" && (step.repause & PAUSE_PRIMARY) === 0
                      ? "; closes issuer proceeds again in the same transaction (Primary issuance stays open: another sale can still take buys)"
                      : "; closes issuer proceeds and Primary issuance again in the same transaction"
                    : ""}
                  .
                  Purchases are final: there are no refunds.
                </p>
                <label className="mt-2 flex items-center gap-2 text-[12px]">
                  <input
                    type="checkbox"
                    checked={useOther}
                    onChange={(e) => {
                      setUseOther(e.target.checked);
                      setOther(null);
                      setOtherConfirmed(false);
                    }}
                  />
                  Send the proceeds to another USDC account
                </label>
                {useOther && (
                  <div className="mt-1 space-y-1">
                    <div className="flex flex-wrap gap-2">
                      <input
                        value={otherText}
                        onChange={(e) => {
                          setOtherText(e.target.value);
                          setOther(null);
                          setOtherConfirmed(false);
                        }}
                        placeholder="USDC token account address"
                        className={`${inputClass} min-w-[18rem] flex-1 text-xs`}
                      />
                      <button type="button" onClick={() => void checkOther()} className="text-[12px] font-medium underline">
                        Check
                      </button>
                    </div>
                    {otherProblem && <p className="text-[12px] text-red-700">{otherProblem}</p>}
                    {other && (
                      <label className="flex items-start gap-2 text-[12px] text-amber-900">
                        <input type="checkbox" checked={otherConfirmed} onChange={(e) => setOtherConfirmed(e.target.checked)} className="mt-0.5" />
                        <span>
                          A USDC account owned by <span className="font-mono">{other.account.owner}</span>, not your issuer wallet. I confirm all
                          proceeds go there.
                        </span>
                      </label>
                    )}
                  </div>
                )}
                <button
                  type="button"
                  disabled={busy || !otherReady || flags === null}
                  onClick={() => setConfirm("close")}
                  className="mt-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                >
                  End sale and collect
                </button>
                {working && <span className="ml-3" aria-live="polite">{working}</span>}
              </>
            )}
          </div>
        </div>
      )}

      {rowState === "sign-in" && stage !== "open" && (
        <p className="text-[12px] text-slate-500">
          Your request status needs a sign-in.{" "}
          <button type="button" onClick={() => void loadRequest(true)} className="font-medium underline">
            Show it
          </button>
        </p>
      )}
      {problem && (
        <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-800">
          {problem}
        </p>
      )}

      <ConfirmModal
        open={confirm === "request" && !formProblem && price !== null && tokens !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => submitRequest()}
        title="Request a public sale"
        kind="info"
        confirmLabel="Request"
        requireReason={false}
        busy={busy}
        description={
          price !== null && tokens !== null ? (
            <ul className="list-disc space-y-1 pl-5 text-[13px]">
              <li>
                {formatTokens(tokens)} tokens at {formatUsdc(price)} USDC each (up to {formatUsdc(maxGrossRaise(tokens, price))} USDC), for {days}{" "}
                days from when you open it.
              </li>
              <li>Anyone with a wallet linked to Manci can buy (signed in, Terms accepted, sanctions screened); no KYC to buy or hold.</li>
              <li>Buyers pay in USDC; purchases are final (no refunds). The proceeds go to your USDC account when you end the sale.</li>
              <li>The document is published on the asset page so buyers can read it before they buy.</li>
            </ul>
          ) : null
        }
      />
      <ConfirmModal
        open={confirm === "open" && !!approval}
        onClose={() => setConfirm(null)}
        onConfirm={() => openSale()}
        title="Open the public sale"
        kind="info"
        confirmLabel="Open sale"
        requireReason={false}
        busy={busy}
        description={
          approval ? (
            <ul className="list-disc space-y-1 pl-5 text-[13px]">
              <li>
                Starts now and ends in {openDays} days, at {formatUsdc(approval.minPricePerUnit)} USDC per token
                {liveRequest ? `, ${formatTokens(BigInt(liveRequest.tokens))} tokens (fewer if the room left is smaller)` : ""}.
              </li>
              <li>Tokens are created when bought; the listing is published on the launchpad.</li>
            </ul>
          ) : null
        }
      />
      <ConfirmModal
        open={confirm === "close" && !!openSaleNow}
        onClose={() => setConfirm(null)}
        onConfirm={() => endAndCollect()}
        title="End the sale and collect"
        kind="warning"
        confirmLabel="End and collect"
        requireReason={false}
        busy={busy}
        description={
          <ul className="list-disc space-y-1 pl-5 text-[13px]">
            <li>The sale stops now; unsold tokens are never created.</li>
            <li>
              All proceeds{chain?.proceeds !== null && chain?.proceeds !== undefined ? ` (${formatUsdc(chain.proceeds)} USDC)` : ""} go to{" "}
              {useOther && other ? <span className="font-mono">{shortAddress(other.account.tokenAccount)}</span> : "your USDC account"}.
            </li>
            {canCreate && <li>Issuer proceeds (0x20) and, with no other sale open, Primary issuance (0x02) are closed again in the same transaction.</li>}
          </ul>
        }
      />
    </div>
  );
}

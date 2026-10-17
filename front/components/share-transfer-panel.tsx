"use client";

// "Send to holder": the issuer authority of a class (or a Manci Admin) sends
// share tokens it holds to one recipient wallet, for example a buyer who paid
// outside Manci. Treasury transfer only: no price, listing or order book, and
// nothing here reads or changes the secondary-trading switch.
//
// Everything a sender needs to know is checked in plain words before the
// wallet opens (lib/share-transfer shareTransferChecks, read live from chain),
// the recipient is screened against the sanctions lists in the background
// (/api/compliance/screen-recipients, the screen "Send to wallets" runs: a hit
// blocks the send), then the exact transaction is test-run on the network
// (lib/simulation-gate); Send stays disabled until every row is green. Right
// before the wallet opens the recipient is screened again under this send's
// run id and the server's evidence of that screening is taken
// (/api/compliance/distribution-evidence; an unavailable list refuses on
// mainnet, 503): every audit row of the send cites it. The send itself goes
// through the verified client, which simulates it once more before the
// wallet. A "pending" audit row is written as soon as the network took the
// transaction (keepalive), the final row once the network decided; a send not
// confirmed in time clears the form and keeps it disabled until the operator
// checked the explorer. Every chain read is retried (lib/rpc-retry) and can
// be tried again by hand.
//
// Self-contained: the share-class screens embed it with the class row's data,
// and other screens (the one-screen tokenization flow) can embed it the same way.

import { useEffect, useMemo, useRef, useState } from "react";
import { isAddress, type Address } from "@solana/kit";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { type Asset, type ShareClass } from "@/lib/generated/asset_registry";
import { ConfirmModal } from "@/components/confirm-modal";
import { useRole } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { AUDIT_RETRY_DELAYS_MS, recordAudit, type AuditStatus } from "@/lib/supabase";
import { PENDING_AUDIT_ATTEMPT_TIMEOUT_MS } from "@/lib/distribution-audit-writer";
import { getPrivateAssetProfile } from "@/lib/asset-profiles";
import { distributionEvidence, screenRecipients } from "@/lib/compliance";
import { SCREENING_HIT_TEXT, SCREENING_PENDING_TEXT, type ScreeningState } from "@/lib/distribution-checks";
import { distributionRunId } from "@/lib/distribution-journal";
import { companyFiguresFrom, percentOfCompany, type CompanyFigures } from "@/lib/distribution-rows";
import { screeningAuditEntry, type ScreeningEvidence } from "@/lib/distribution-screening";
import { walletSigner } from "@/lib/wallet-signer";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { withRpcReadRetry } from "@/lib/rpc-retry";
import {
  buildShareTransfer,
  formatExpiryDate,
  formatTokens,
  loadSenderHolding,
  loadShareTransferFacts,
  readSignatureOutcome,
  shareTransferChecks,
  shareTransferSummary,
  shortAddress,
  type ShareTransferFacts,
  type ShareTransferVerdict,
} from "@/lib/share-transfer";
import { simulateInstructions, waitForSignature } from "@/lib/simulation-gate";
import { confirmThenReport } from "@/lib/send-outcome";

export type ShareTransferPanelProps = {
  sc: ShareClass;
  /** The class's asset (its issuer decides who sees the panel; its name is the fallback company name). */
  asset: Asset | undefined;
  /** The ShareClass PDA (audit target, and the class the sanctions screen is asked for). */
  scPda: Address | null;
  /** Called once a send has settled on the network (refresh the page's own data). */
  onSent?: () => void | Promise<void>;
  /** The panel's heading ("Send to holder" on the share-class screens). */
  title?: string;
  /**
   * The tokenize flow's figures (`fields.tokenize` of the private profile)
   * when the page has them; otherwise the panel reads them within an
   * existing wallet session (no prompt). Without them no percent is shown.
   */
  tokenize?: Record<string, unknown> | null;
  /** Bump to re-read the chain (the page's own confirmed write, e.g. a treasury mint). */
  reloadKey?: number;
};

/** Read for one wallet and one mint (`key`), so a switched class or wallet never shows another's balance. */
type Treasury = { key: string; issuerAuthority: string | null; hookConfigured: boolean; balance: bigint };

type TestRun = { state: "skipped" } | { state: "passed" } | { state: "failed"; text: string };

type Preflight =
  | { key: string; state: "checking" }
  | { key: string; state: "error"; text: string }
  | { key: string; state: "done"; facts: ShareTransferFacts; verdict: ShareTransferVerdict; testRun: TestRun };

/** The sanctions screen's answer for one class and recipient (`key`). */
type Screened = { key: string; state: "clear" | "hit" };

/**
 * A send the network had not confirmed when the wait ended (for one wallet
 * and mint, `key`): shown until the operator checked the explorer, the form
 * disabled meanwhile. `report` writes the final audit row when "Check again"
 * finds the outcome.
 */
type Unsettled = {
  key: string;
  signature: string;
  recipient: string;
  amount: bigint;
  report: (outcome: "confirmed" | "failed") => void;
};

/** About 0.002 SOL: a Token-2022 account with ImmutableOwner and the transfer-hook extension. */
const ACCOUNT_RENT_NOTE = "about 0.002 SOL rent, paid by you";

const BALANCE_READ_FAILED = "Could not read your balance of this class from the network, so nothing can be sent yet.";

const linkClass = "font-medium underline disabled:opacity-50";

export function ShareTransferPanel({ sc, asset, scPda, onSent, title = "Send to holder", tokenize, reloadKey = 0 }: ShareTransferPanelProps) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const { isAdmin } = useRole();
  const rpc = client.runtime.rpc;
  const session = conn.wallet;
  const wallet = session?.account.address;
  const issuer = asset?.issuer ?? null;
  const [network] = useState(() => detectNetwork());

  const [treasury, setTreasury] = useState<Treasury | null>(null);
  /** The wallet and mint (`key`) whose balance could not be read after the retries. */
  const [treasuryError, setTreasuryError] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ company: string | null; figures: CompanyFigures | null } | null>(null);
  const [recipientInput, setRecipientInput] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [screened, setScreened] = useState<Screened | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** From the click to the wallet's answer (the screening and the evidence included): no second send. */
  const [working, setWorking] = useState<string | null>(null);
  // One send at a time, from the click to the network's answer: a state alone lags a render, so a
  // second click in the same tick would pass it (the same lock as TreasuryMintPanel's mintLock).
  const sendLock = useRef(false);
  /** Between the wallet's signature and the network's answer: no second send. */
  const [confirming, setConfirming] = useState(false);
  const [unsettled, setUnsettled] = useState<Unsettled | null>(null);
  const [checking, setChecking] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const treasuryKey = `${wallet ?? ""}|${sc.mint}`;

  // Who may send and what this wallet holds, read live in one round trip
  // (the table rows come from the indexer mirror, which can lag), a refused
  // read retried; read again when the class's supply changes or the page
  // bumps `reloadKey` (a treasury mint on the same screen shows the panel).
  // A load a newer one supersedes, or the unmount abandons, is aborted.
  useEffect(() => {
    if (!wallet || !issuer || !sc.mintInitialized) return;
    const controller = new AbortController();
    const { signal } = controller;
    const key = `${wallet}|${sc.mint}`;
    void (async () => {
      try {
        const holding = await withRpcReadRetry(
          (abortSignal) => loadSenderHolding(rpc, { wallet, mint: sc.mint, issuer }, { abortSignal }),
          { signal },
        );
        if (signal.aborted) return;
        setTreasury({ key, ...holding });
        setTreasuryError(null);
        if (!amountTouched) setAmountInput(holding.balance > BigInt(0) ? holding.balance.toString() : "");
      } catch {
        if (signal.aborted) return;
        setTreasury(null);
        setTreasuryError(key);
      }
    })();
    return () => controller.abort();
    // amountTouched is read once per load on purpose: typing must not reload the chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, issuer, sc.mint, sc.mintInitialized, sc.circulatingSupply, rpc, refreshKey, reloadKey]);

  const visible =
    !!wallet &&
    sc.mintInitialized &&
    !!treasury &&
    treasury.key === treasuryKey &&
    treasury.hookConfigured &&
    treasury.balance > BigInt(0) &&
    (isAdmin || treasury.issuerAuthority === wallet.toString());

  // The company and the tokenize figures, for "= P % of <company>": one token
  // is a fixed share of the company (fields.tokenize: tokens, token size,
  // percent), never the public `total_shares` column. Read within an existing
  // wallet session only (no prompt); without it no percent is shown.
  useEffect(() => {
    if (!visible) return;
    if (tokenize !== undefined) {
      const company = typeof tokenize?.company_name === "string" ? tokenize.company_name : null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setProfile({ company, figures: companyFiguresFrom(tokenize) });
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const row = session ? await getPrivateAssetProfile(session, sc.asset.toString(), { interactive: false }) : null;
        if (cancelled) return;
        const t = row?.fields?.tokenize;
        const company = typeof (t as Record<string, unknown> | undefined)?.company_name === "string"
          ? String((t as Record<string, unknown>).company_name)
          : (row?.display_name ?? null);
        setProfile(row ? { company, figures: companyFiguresFrom(t) } : null);
      } catch {
        if (!cancelled) setProfile(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, sc.asset, session, tokenize]);

  const recipient = recipientInput.trim();
  const validRecipient = recipient && isAddress(recipient) ? (recipient as Address) : null;
  // A result is shown only for the inputs, wallet and class it was computed for.
  const preflightKey = `${wallet ?? ""}|${sc.mint}|${recipient}|${amountInput.trim()}|${refreshKey}`;
  const screeningKey = scPda && validRecipient ? `${scPda}|${validRecipient}` : null;

  // The checks and the test run, a moment after the inputs settle; a chain
  // read the RPC refused for a moment is retried, and a run a newer one
  // supersedes is aborted (its retries stop).
  useEffect(() => {
    if (!visible || !wallet || !session || !validRecipient) return;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => {
      void (async () => {
        setPreflight({ key: preflightKey, state: "checking" });
        try {
          const facts = await withRpcReadRetry(
            () => loadShareTransferFacts(rpc, { mint: sc.mint, sender: wallet, recipient: validRecipient }),
            { signal },
          );
          const verdict = shareTransferChecks(facts, { amount: amountInput, nowSec: Math.floor(Date.now() / 1000) });
          let testRun: TestRun = { state: "skipped" };
          if (verdict.ok && verdict.amount !== null && facts.decimals !== null) {
            const built = await buildShareTransfer({
              mint: sc.mint,
              from: walletSigner(session),
              to: validRecipient,
              amount: verdict.amount,
              decimals: facts.decimals,
              hookConfig: facts.hookConfig,
            });
            // A simulation has no side effects, and a refusal comes back as a value, not an error.
            const { refusal } = await withRpcReadRetry(
              () => simulateInstructions(rpc, { feePayer: wallet, instructions: built.instructions, network }),
              { signal },
            );
            testRun = refusal ? { state: "failed", text: refusal.detail } : { state: "passed" };
          }
          if (!signal.aborted) setPreflight({ key: preflightKey, state: "done", facts, verdict, testRun });
        } catch (err) {
          if (!signal.aborted) {
            setPreflight({
              key: preflightKey,
              state: "error",
              text: `Could not read the network, so nothing can be sent yet: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      })();
    }, 400);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [visible, wallet, session, validRecipient, preflightKey, amountInput, rpc, sc.mint, network]);

  // The sanctions screen of the recipient, in the background: once per class
  // and recipient (not per keystroke of the amount), within an existing
  // wallet session only (no prompt). A throw (no session yet, 403, 503)
  // leaves it unknown: the send screens again before the wallet opens.
  useEffect(() => {
    if (!visible || !session || !scPda || !validRecipient) return;
    const key = `${scPda}|${validRecipient}`;
    let cancelled = false;
    const timer = setTimeout(() => {
      void screenRecipients(session, { shareClass: scPda, wallets: [validRecipient] }, { interactive: false })
        .then((hits) => {
          if (!cancelled) setScreened({ key, state: hits.has(validRecipient) ? "hit" : "clear" });
        })
        .catch(() => undefined);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [visible, session, scPda, validRecipient]);

  const current = preflight && preflight.key === preflightKey ? preflight : null;
  const screening: ScreeningState = screened && screeningKey !== null && screened.key === screeningKey ? screened.state : "unknown";
  const ready =
    current?.state === "done" && current.verdict.ok && current.testRun.state === "passed" && scPda !== null && screening !== "hit"
      ? current
      : null;
  const percent = ready && ready.verdict.amount !== null ? percentOfCompany(ready.verdict.amount, profile?.figures ?? null) : null;
  const company = profile?.company ?? asset?.name ?? null;
  const summary = useMemo(
    () =>
      ready && ready.verdict.amount !== null
        ? shareTransferSummary({ amount: ready.verdict.amount, recipient: ready.facts.recipient, percent, company })
        : null,
    [ready, percent, company],
  );
  /** A send of this wallet and class the network has not confirmed: the form stays disabled. */
  const pendingSend = unsettled !== null && unsettled.key === treasuryKey ? unsettled : null;
  const balanceUnread = !!wallet && sc.mintInitialized && treasuryError === treasuryKey && !treasury;

  // Shown only to a wallet that holds tokens of the class (and may send them),
  // for a balance that could not be read (so it can be tried again), and for a
  // send still waiting for the explorer check.
  if (!visible && !balanceUnread && !pendingSend) return null;

  async function send(reason: string) {
    if (sendLock.current || working !== null || confirming || tx.isSending || pendingSend) return;
    if (!session || !wallet || !scPda || !ready || ready.verdict.amount === null || ready.facts.decimals === null) return;
    const { facts, verdict } = ready;
    const amount = verdict.amount!;
    const tokens = `${formatTokens(amount)} ${amount === BigInt(1) ? "token" : "tokens"}`;
    const shareClass = scPda;
    sendLock.current = true;
    setWorking("Screening the recipient…");
    try {
      // 1. The recipient screened again under this send's run id (one sign-in at most: a session
      //    read), the screen recorded by the server, then the server's evidence that it has a
      //    fresh clear screening (lib/distribution-screening). Nothing is signed without it: a hit,
      //    an unavailable list (503 on mainnet) or a refusal (403 in KYC-only mode) stops here.
      let runId: string;
      let evidence: ScreeningEvidence;
      try {
        runId = await distributionRunId({
          network,
          mint: sc.mint,
          sender: wallet,
          rows: [{ wallet: facts.recipient, amount }],
          nonce: new Date().toISOString(),
        });
        const hits = await screenRecipients(session, { shareClass, wallets: [facts.recipient], runId });
        setScreened({ key: `${shareClass}|${facts.recipient}`, state: hits.has(facts.recipient) ? "hit" : "clear" });
        if (hits.size > 0) {
          setConfirmOpen(false);
          toast.showError("Tokens not sent", SCREENING_HIT_TEXT);
          return;
        }
        setWorking("Recording the screening evidence…");
        evidence = await distributionEvidence(session, { shareClass, runId, wallets: [facts.recipient] });
      } catch (err) {
        toast.showError("Tokens not sent", err instanceof Error ? err.message : String(err));
        return;
      }

      const metadata: Record<string, unknown> = {
        mint: sc.mint.toString(),
        to: facts.recipient.toString(),
        amount: amount.toString(),
        decimals: 0,
        recipient_token_account: facts.recipientTokenAccount.toString(),
        hook_mode: facts.hook.kind,
        kyc_registry: facts.passport?.registry.toString() ?? null,
        passport_expiry: verdict.passportExpiry !== null ? new Date(Number(verdict.passportExpiry) * 1000).toISOString() : null,
        percent,
        // The same per-recipient shape as a share_class_distribution row (distributionAuditRow).
        screening: screeningAuditEntry(evidence, facts.recipient),
        screening_run: runId,
      };
      // keepalive: a row whose request already left is delivered even when the tab closes right
      // after; each attempt is cut off, so a stuck write never hangs (lib/distribution-audit-writer).
      const audit = (status: AuditStatus, sig: string | null, extra: Record<string, unknown> = {}) =>
        void recordAudit(
          {
            ix_name: "share_class_transfer",
            category: "share-class",
            actor_wallet: wallet.toString(),
            reason,
            target_label: shareClass.toString(),
            ...(sig ? { tx_signature: sig } : {}),
            status,
            metadata: { ...metadata, ...extra },
          },
          AUDIT_RETRY_DELAYS_MS,
          { keepalive: true, timeoutMs: PENDING_AUDIT_ATTEMPT_TIMEOUT_MS },
        );

      // 2. The wallet signs and the network takes the transaction.
      setWorking(`Confirm in your wallet: send ${tokens}`);
      let pendingId = toast.showPending(`Sending ${tokens}…`);
      let sig: string;
      try {
        const signer = walletSigner(session);
        const built = await buildShareTransfer({
          mint: sc.mint,
          from: signer,
          to: facts.recipient,
          amount,
          decimals: facts.decimals!,
          hookConfig: facts.hookConfig,
        });
        sig = await tx.send({ instructions: built.instructions, feePayer: signer });
      } catch (err) {
        toast.dismiss(pendingId);
        const message = explainSendError(err);
        toast.showError("Tokens not sent", message);
        audit("failed", null, { error: message });
        return;
      }
      // The "pending" row as soon as the network took it (before the wait): a tab closed now still
      // leaves a trace, and the retry worker settles rows that have one.
      audit("pending", sig, { phase: "submitted" });

      // 3. Only the network's confirmation makes it "sent": the success toast,
      //    the audit row and the refresh wait for it (tx.send returns on
      //    submission) — lib/send-outcome confirmThenReport keeps that order.
      //    A status read the RPC refused for a moment (429) is retried within
      //    the timeout, never answered "unknown" at once.
      setConfirming(true);
      setConfirmOpen(false);
      setWorking(null);
      toast.dismiss(pendingId);
      pendingId = toast.showPending(`Confirming ${tokens} on the network…`);
      const sentToast = () => toast.showTx(sig, { title: "Tokens sent", description: summary ?? undefined });
      const refusedToast = () =>
        toast.show({
          kind: "error",
          title: "The transfer failed on the network",
          description: "Your wallet sent it, but the network refused it. Balances are unchanged; open the explorer link for details.",
          signature: sig,
        });
      try {
        await confirmThenReport(() => waitForSignature(rpc, sig, { timeoutMs: 45_000, retryReads: true }), {
          confirmed: () => {
            toast.dismiss(pendingId);
            sentToast();
            audit("success", sig);
            setRecipientInput("");
            setAmountTouched(false);
            setUnsettled(null);
          },
          failed: () => {
            toast.dismiss(pendingId);
            refusedToast();
            audit("failed", sig, { error: "refused by the network" });
          },
          unconfirmed: () => {
            // Not confirmed in time, or its status could not be read: it may still land. The
            // pending row stands; the form is cleared and stays disabled until the operator
            // checked the explorer (no second send of bearer tokens by accident). "Check again"
            // writes the final row once the network has decided.
            toast.dismiss(pendingId);
            toast.show({
              kind: "error",
              title: "Not confirmed yet",
              description:
                "Outcome unknown — check the explorer before sending again. The form was cleared so the tokens are not sent twice by accident.",
              signature: sig,
            });
            setRecipientInput("");
            setAmountTouched(false);
            setUnsettled({
              key: `${wallet}|${sc.mint}`,
              signature: sig,
              recipient: facts.recipient.toString(),
              amount,
              report: (outcome) => {
                if (outcome === "confirmed") {
                  sentToast();
                  audit("success", sig);
                } else {
                  refusedToast();
                  audit("failed", sig, { error: "refused by the network" });
                }
              },
            });
          },
          settled: async () => {
            setRefreshKey((k) => k + 1);
            await onSent?.();
          },
        });
      } finally {
        setConfirming(false);
      }
    } finally {
      sendLock.current = false;
      setWorking(null);
    }
  }

  /** One status read (retried, the history searched) of the unconfirmed send: confirmed or failed settles it. */
  async function checkAgain() {
    if (!pendingSend || checking) return;
    const { signature, report } = pendingSend;
    setChecking(true);
    try {
      const outcome = await readSignatureOutcome(rpc, signature);
      if (outcome === "unknown") {
        toast.show({
          kind: "info",
          title: "Still not confirmed",
          description: "The network has no answer for this transfer yet. Check the explorer, or try again in a minute.",
          signature,
        });
        return;
      }
      report(outcome);
      setUnsettled(null);
      setRefreshKey((k) => k + 1);
      await onSent?.();
    } catch (err) {
      toast.showError("Could not read the transfer's status", explainSendError(err));
    } finally {
      setChecking(false);
    }
  }

  const passportLine = (() => {
    if (!ready) return null;
    if (ready.facts.hook.kind === "open") return "Open class: no investor passport needed.";
    if (ready.verdict.passportExpiry === null) return null;
    return `The recipient's investor passport is valid until ${formatExpiryDate(ready.verdict.passportExpiry)}.`;
  })();

  const busy = tx.isSending || confirming || working !== null;

  return (
    <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</p>
        {visible && treasury && (
          <span className="text-xs text-slate-500">
            You hold <span className="font-mono text-slate-800">{formatTokens(treasury.balance)}</span>
          </span>
        )}
      </div>

      {balanceUnread && !visible && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          {BALANCE_READ_FAILED}{" "}
          <button type="button" onClick={() => setRefreshKey((k) => k + 1)} className={linkClass}>
            Try again
          </button>
        </p>
      )}

      {pendingSend && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[13px] text-amber-900">
          <p>
            {formatTokens(pendingSend.amount)} {pendingSend.amount === BigInt(1) ? "token" : "tokens"} to{" "}
            {shortAddress(pendingSend.recipient)} were sent but are not confirmed yet. Outcome unknown — check the{" "}
            <a href={explorerTxUrl(pendingSend.signature, network)} target="_blank" rel="noreferrer" className="font-medium underline">
              explorer
            </a>{" "}
            before sending again: sending again may pay this wallet twice.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
            <button type="button" onClick={() => void checkAgain()} disabled={checking} className={linkClass}>
              {checking ? "Checking…" : "Check again"}
            </button>
            <button type="button" onClick={() => setUnsettled(null)} disabled={checking} className={linkClass}>
              I checked the explorer — allow sending again
            </button>
          </div>
        </div>
      )}

      {visible && treasury && (
        <>
          <p className="text-[13px] leading-relaxed text-slate-600">
            Send tokens of this class from your wallet to an investor&apos;s wallet, for example after a sale paid
            outside Manci. Everything below is checked before your wallet opens.
          </p>

          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">Recipient wallet address</span>
              <input
                value={recipientInput}
                onChange={(e) => setRecipientInput(e.target.value)}
                placeholder="The wallet address from the recipient's wallet app"
                spellCheck={false}
                autoComplete="off"
                disabled={!!pendingSend}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-600">Tokens</span>
              <div className="flex gap-2">
                <input
                  value={amountInput}
                  onChange={(e) => {
                    setAmountTouched(true);
                    setAmountInput(e.target.value);
                  }}
                  inputMode="numeric"
                  disabled={!!pendingSend}
                  className="w-32 rounded-lg border border-slate-300 px-3 py-2 text-right font-mono text-sm focus:border-slate-400 focus:outline-none disabled:opacity-50"
                />
                <button
                  type="button"
                  onClick={() => {
                    setAmountTouched(false);
                    setAmountInput(treasury.balance.toString());
                  }}
                  disabled={!!pendingSend}
                  className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
                >
                  All
                </button>
              </div>
            </label>
          </div>

          {recipient !== "" && (
            <ul className="space-y-1.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-[13px] leading-snug">
              {!validRecipient ? (
                <CheckRow ok={false} text="That is not a valid Solana address." />
              ) : !current || current.state === "checking" ? (
                <li className="text-slate-500">Checking…</li>
              ) : current.state === "error" ? (
                <li className="flex gap-2 text-red-700">
                  <span aria-hidden="true" className="w-4 shrink-0 text-center font-semibold">✕</span>
                  <span>
                    <span className="sr-only">Failed: </span>
                    {current.text}{" "}
                    <button type="button" onClick={() => setRefreshKey((k) => k + 1)} className={linkClass}>
                      Try again
                    </button>
                  </span>
                </li>
              ) : (
                <>
                  {current.verdict.checks.map((check) => (
                    <CheckRow key={check.id} ok={check.ok} text={check.text} />
                  ))}
                  {screening === "hit" ? (
                    <CheckRow ok={false} text={SCREENING_HIT_TEXT} />
                  ) : screening === "clear" ? (
                    <CheckRow ok text="Sanctions screening: clear." />
                  ) : (
                    <li className="flex gap-2 text-slate-500">
                      <span aria-hidden="true" className="w-4 shrink-0 text-center">·</span>
                      <span>{SCREENING_PENDING_TEXT}</span>
                    </li>
                  )}
                  {current.testRun.state === "passed" ? (
                    <CheckRow ok text="Test run on the network: this exact transfer would go through (nothing was sent)." />
                  ) : current.testRun.state === "failed" ? (
                    <CheckRow ok={false} text={`Test run on the network: ${current.testRun.text}`} />
                  ) : (
                    <li className="flex gap-2 text-slate-500">
                      <span aria-hidden="true" className="w-4 shrink-0 text-center">·</span>
                      <span>Test run on the network: runs once every check above is green.</span>
                    </li>
                  )}
                </>
              )}
            </ul>
          )}

          {summary && <p className="text-sm font-medium text-slate-900">{summary}</p>}

          <button
            type="button"
            disabled={!ready || busy || !!pendingSend}
            onClick={() => setConfirmOpen(true)}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : confirming ? "Confirming…" : (working ?? "Send tokens")}
          </button>
          {working && <p className="text-sm text-slate-600" aria-live="polite">{working}</p>}

          <ConfirmModal
            open={confirmOpen && !!ready}
            onClose={() => setConfirmOpen(false)}
            onConfirm={(reason) => send(reason)}
            title="Send tokens to holder"
            kind="info"
            confirmLabel="Send tokens"
            busy={tx.isSending || working !== null}
            description={
              ready && (
                <div className="space-y-2">
                  <p className="font-medium text-slate-900">{summary}</p>
                  <ul className="list-disc space-y-1 pl-5 text-[13px]">
                    <li>
                      {ready.facts.recipientTokenAccountExists
                        ? "The recipient already has a token account for this class."
                        : `The recipient's token account for this class is created in the same transaction (${ACCOUNT_RENT_NOTE}).`}
                    </li>
                    {passportLine && <li>{passportLine}</li>}
                    <li>
                      The recipient is screened against the sanctions lists again right before your wallet opens; the
                      screening is recorded.
                    </li>
                    <li>Payment, if any, is handled outside Manci. This only moves the tokens.</li>
                    <li>Your wallet shows the transaction next; nothing is sent until you approve it there.</li>
                  </ul>
                  {working && (
                    <p className="text-[13px] font-medium text-slate-700" aria-live="polite">
                      {working}
                    </p>
                  )}
                </div>
              )
            }
          />
        </>
      )}
    </div>
  );
}

function CheckRow({ ok, text }: { ok: boolean; text: string }) {
  return (
    <li className={`flex gap-2 ${ok ? "text-emerald-800" : "text-red-700"}`}>
      <span aria-hidden="true" className="w-4 shrink-0 text-center font-semibold">
        {ok ? "✓" : "✕"}
      </span>
      <span>
        <span className="sr-only">{ok ? "Passed: " : "Failed: "}</span>
        {text}
      </span>
    </li>
  );
}

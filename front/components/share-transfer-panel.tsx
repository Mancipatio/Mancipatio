"use client";

// "Send to holder": the issuer authority of a class (or a Manci Admin) sends
// share tokens it holds to one recipient wallet, for example a buyer who paid
// outside Manci. Treasury transfer only: no price, listing or order book, and
// nothing here reads or changes the secondary-trading switch.
//
// Everything a sender needs to know is checked in plain words before the
// wallet opens (lib/share-transfer shareTransferChecks, read live from chain),
// then the exact transaction is test-run on the network (lib/simulation-gate);
// Send stays disabled until every row is green. The send itself goes through
// the verified client, which simulates it once more before the wallet.
//
// Self-contained: the share-class screens embed it with the class row's data,
// and other screens (the one-screen tokenization flow) can embed it the same way.

import { useEffect, useMemo, useState } from "react";
import { fetchEncodedAccount, isAddress, type Address } from "@solana/kit";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { getTokenDecoder } from "@solana-program/token-2022";
import { fetchMaybeIssuer, type Asset, type ShareClass } from "@/lib/generated/asset_registry";
import { findConfigPda } from "@/lib/generated/transfer_hook";
import { ConfirmModal } from "@/components/confirm-modal";
import { useRole } from "@/lib/auth";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { recordAudit, type AuditStatus } from "@/lib/supabase";
import { getPrivateAssetProfile } from "@/lib/asset-profiles";
import { companyFiguresFrom, percentOfCompany, type CompanyFigures } from "@/lib/distribution-rows";
import { walletSigner } from "@/lib/wallet-signer";
import { detectNetwork } from "@/lib/network";
import {
  buildShareTransfer,
  formatExpiryDate,
  formatTokens,
  loadShareTransferFacts,
  shareTransferChecks,
  shareTransferSummary,
  tokenAccountOf,
  TOKEN_2022,
  type ShareTransferFacts,
  type ShareTransferVerdict,
} from "@/lib/share-transfer";
import { simulateInstructions, waitForSignature } from "@/lib/simulation-gate";
import { confirmThenReport } from "@/lib/send-outcome";

export type ShareTransferPanelProps = {
  sc: ShareClass;
  /** The class's asset (its issuer decides who sees the panel; its name is the fallback company name). */
  asset: Asset | undefined;
  /** The ShareClass PDA (audit target). */
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
};

/** Read for one wallet and one mint (`key`), so a switched class or wallet never shows another's balance. */
type Treasury = { key: string; issuerAuthority: string | null; hookConfigured: boolean; balance: bigint };

type TestRun = { state: "skipped" } | { state: "passed" } | { state: "failed"; text: string };

type Preflight =
  | { key: string; state: "checking" }
  | { key: string; state: "error"; text: string }
  | { key: string; state: "done"; facts: ShareTransferFacts; verdict: ShareTransferVerdict; testRun: TestRun };

/** About 0.002 SOL: a Token-2022 account with ImmutableOwner and the transfer-hook extension. */
const ACCOUNT_RENT_NOTE = "about 0.002 SOL rent, paid by you";

export function ShareTransferPanel({ sc, asset, scPda, onSent, title = "Send to holder", tokenize }: ShareTransferPanelProps) {
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
  const [profile, setProfile] = useState<{ company: string | null; figures: CompanyFigures | null } | null>(null);
  const [recipientInput, setRecipientInput] = useState("");
  const [amountInput, setAmountInput] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [preflight, setPreflight] = useState<Preflight | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** Between the wallet's signature and the network's answer: no second send. */
  const [confirming, setConfirming] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  // Who may send and what this wallet holds, read live (the table rows come
  // from the indexer mirror, which can lag); read again when the class's
  // supply changes, so a treasury mint on the same screen shows the panel.
  useEffect(() => {
    if (!wallet || !issuer || !sc.mintInitialized) return;
    let cancelled = false;
    void (async () => {
      try {
        const [configPda] = await findConfigPda({ mint: sc.mint });
        const [issuerAccount, config, holding] = await Promise.all([
          fetchMaybeIssuer(rpc, issuer),
          fetchEncodedAccount(rpc, configPda),
          fetchEncodedAccount(rpc, await tokenAccountOf(wallet, sc.mint)),
        ]);
        let balance = BigInt(0);
        if (holding.exists && holding.programAddress === TOKEN_2022) {
          balance = getTokenDecoder().decode(holding.data).amount;
        }
        if (cancelled) return;
        setTreasury({
          key: `${wallet}|${sc.mint}`,
          issuerAuthority: issuerAccount.exists ? issuerAccount.data.authority.toString() : null,
          hookConfigured: config.exists,
          balance,
        });
        if (!amountTouched) setAmountInput(balance > BigInt(0) ? balance.toString() : "");
      } catch {
        if (!cancelled) setTreasury(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // amountTouched is read once per load on purpose: typing must not reload the chain.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, issuer, sc.mint, sc.mintInitialized, sc.circulatingSupply, rpc, refreshKey]);

  const visible =
    !!wallet &&
    sc.mintInitialized &&
    !!treasury &&
    treasury.key === `${wallet}|${sc.mint}` &&
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

  // The checks and the test run, a moment after the inputs settle.
  useEffect(() => {
    if (!visible || !wallet || !session || !validRecipient) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        setPreflight({ key: preflightKey, state: "checking" });
        try {
          const facts = await loadShareTransferFacts(rpc, { mint: sc.mint, sender: wallet, recipient: validRecipient });
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
            const { refusal } = await simulateInstructions(rpc, { feePayer: wallet, instructions: built.instructions, network });
            testRun = refusal ? { state: "failed", text: refusal.detail } : { state: "passed" };
          }
          if (!cancelled) setPreflight({ key: preflightKey, state: "done", facts, verdict, testRun });
        } catch (err) {
          if (!cancelled) {
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
      cancelled = true;
      clearTimeout(timer);
    };
  }, [visible, wallet, session, validRecipient, preflightKey, amountInput, rpc, sc.mint, network]);

  const current = preflight && preflight.key === preflightKey ? preflight : null;
  const ready = current?.state === "done" && current.verdict.ok && current.testRun.state === "passed" ? current : null;
  const percent = ready && ready.verdict.amount !== null ? percentOfCompany(ready.verdict.amount, profile?.figures ?? null) : null;
  const company = profile?.company ?? asset?.name ?? null;
  const summary = useMemo(
    () =>
      ready && ready.verdict.amount !== null
        ? shareTransferSummary({ amount: ready.verdict.amount, recipient: ready.facts.recipient, percent, company })
        : null,
    [ready, percent, company],
  );

  if (!visible || !treasury) return null;

  async function send(reason: string) {
    if (confirming || !session || !wallet || !ready || ready.verdict.amount === null || ready.facts.decimals === null) return;
    const { facts, verdict } = ready;
    const amount = verdict.amount!;
    const tokens = `${formatTokens(amount)} ${amount === BigInt(1) ? "token" : "tokens"}`;
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
    };
    const audit = (status: AuditStatus, sig: string | null, extra: Record<string, unknown> = {}) =>
      void recordAudit({
        ix_name: "share_class_transfer",
        category: "share-class",
        actor_wallet: wallet.toString(),
        reason,
        target_label: (scPda ?? sc.mint).toString(),
        ...(sig ? { tx_signature: sig } : {}),
        status,
        metadata: { ...metadata, ...extra },
      });

    // 1. The wallet signs and the network takes the transaction.
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

    // 2. Only the network's confirmation makes it "sent": the success toast,
    //    the audit row and the refresh wait for it (tx.send returns on
    //    submission) — lib/send-outcome confirmThenReport keeps that order.
    setConfirming(true);
    setConfirmOpen(false);
    toast.dismiss(pendingId);
    pendingId = toast.showPending(`Confirming ${tokens} on the network…`);
    try {
      await confirmThenReport(() => waitForSignature(rpc, sig, { timeoutMs: 45_000 }), {
        confirmed: () => {
          toast.dismiss(pendingId);
          toast.showTx(sig, { title: "Tokens sent", description: summary ?? undefined });
          audit("success", sig);
          setRecipientInput("");
          setAmountTouched(false);
        },
        failed: () => {
          toast.dismiss(pendingId);
          toast.show({
            kind: "error",
            title: "The transfer failed on the network",
            description: "Your wallet sent it, but the network refused it. Balances are unchanged; open the explorer link for details.",
            signature: sig,
          });
          audit("failed", sig, { error: "refused by the network" });
        },
        unconfirmed: (outcome) => {
          toast.dismiss(pendingId);
          toast.show({
            kind: "error",
            title: "Not confirmed yet",
            description:
              "The network has not confirmed the transfer yet. Check the explorer link before sending again; the balance here is read again now.",
            signature: sig,
          });
          audit("pending", sig, { confirmation: outcome });
        },
        settled: async () => {
          setRefreshKey((k) => k + 1);
          await onSent?.();
        },
      });
    } finally {
      setConfirming(false);
    }
  }

  const passportLine = (() => {
    if (!ready) return null;
    if (ready.facts.hook.kind === "open") return "Open class: no investor passport needed.";
    if (ready.verdict.passportExpiry === null) return null;
    return `The recipient's investor passport is valid until ${formatExpiryDate(ready.verdict.passportExpiry)}.`;
  })();

  return (
    <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
      <div className="flex items-center justify-between gap-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</p>
        <span className="text-xs text-slate-500">
          You hold <span className="font-mono text-slate-800">{formatTokens(treasury.balance)}</span>
        </span>
      </div>
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
            className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
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
              className="w-32 rounded-lg border border-slate-300 px-3 py-2 text-right font-mono text-sm focus:border-slate-400 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                setAmountTouched(false);
                setAmountInput(treasury.balance.toString());
              }}
              className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-slate-400"
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
            <CheckRow ok={false} text={current.text} />
          ) : (
            <>
              {current.verdict.checks.map((check) => (
                <CheckRow key={check.id} ok={check.ok} text={check.text} />
              ))}
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
        disabled={!ready || tx.isSending || confirming}
        onClick={() => setConfirmOpen(true)}
        className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {tx.isSending ? "Sending…" : confirming ? "Confirming…" : "Send tokens"}
      </button>

      <ConfirmModal
        open={confirmOpen && !!ready}
        onClose={() => setConfirmOpen(false)}
        onConfirm={(reason) => send(reason)}
        title="Send tokens to holder"
        kind="info"
        confirmLabel="Send tokens"
        busy={tx.isSending}
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
                <li>Payment, if any, is handled outside Manci. This only moves the tokens.</li>
                <li>Your wallet shows the transaction next; nothing is sent until you approve it there.</li>
              </ul>
            </div>
          )
        }
      />
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

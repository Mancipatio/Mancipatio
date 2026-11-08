"use client";

// Token migration (V1), the holder's side: exchange a token a company
// already issued on Solana for units of that company's Manci share class.
// During a campaign's opt-in window the holder deposits exact multiples of
// the published lot into the campaign's deposit account; Manci's operator
// then sends the units from the treasury. Nothing here is a Manci program
// instruction: the deposit is a plain SPL transfer, so the platform's gates
// are the signed precheck (module, window, sanctions, Terms, excluded wallet,
// cap headroom, balance) and the record that verifies the finalized
// transaction (app/api/token-migrations).
//
// The deposit: precheck (a session read) → the wallet signs [create the
// deposit account (idempotent), the memo manci:migration:v1:<id>:<lots>,
// TransferChecked of exactly lots × lot] → the receipt is saved in this
// browser BEFORE anything else (lib/chain-record-recovery, kind
// "migration_deposit", one per transaction) → wait for finalization (plain
// RPC reads) → ONE signed record. A receipt that could not be recorded stays
// across reloads and is offered as "Retry recording" (the operator's
// reconcile records it too); it is discarded only when the network shows the
// transaction failed or can no longer land.
//
// With the module off (and in KYC-only mode) this is a notice page
// (lib/pilot-scope.ts): no new deposit; the recording of a deposit that
// already landed and the holder's deposits stay. "My deposits" comes from the
// public proof table, filtered by this wallet: the same facts anyone can see
// on chain.

import Link from "next/link";
import { address, fetchEncodedAccount } from "@solana/kit";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { getTokenDecoder } from "@solana-program/token-2022";
import { useCallback, useEffect, useRef, useState } from "react";
import { WalletRequired } from "@/components/wallet-required";
import { ChainRecordRecoveryPanel } from "@/components/chain-record-recovery-panel";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import { assertChainRecordStorageAvailable, type PendingChainRecord } from "@/lib/chain-record-recovery";
import { useChainRecordRecovery } from "@/lib/use-chain-record-recovery";
import { useChainClock } from "@/lib/use-chain-clock";
import { moduleEnabled } from "@/lib/features";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { withRpcReadRetry } from "@/lib/rpc-retry";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { walletSigner } from "@/lib/wallet-signer";
import { fetchPublicMigration, fetchPublicMigrations, precheckDeposit, recordMigrationDeposit } from "@/lib/token-migration/client";
import { DEPOSIT_STATUS_LABEL, ratioSentence, windowStateAt } from "@/lib/token-migration/model";
import { formatBaseUnits, formatUnits, lotsFor, percentClause, percentFigure, percentText, unitPercent } from "@/lib/token-migration/ratio";
import type { PublicDeposit, PublicMigration } from "@/lib/token-migration/rows";
import { associatedTokenAccount, buildDepositInstructions } from "@/lib/token-migration/transactions";

const DEPOSIT_FAILED_MESSAGE = "The deposit failed on the network: nothing moved and the receipt was discarded. You can deposit again.";
const DEPOSIT_NOT_FINALIZED_MESSAGE = "The deposit is not finalized yet. Use Retry recording in a minute; do not deposit again.";

/** The receipt's entity: one per deposit transaction, naming its campaign. */
function receiptEntity(migrationId: string, signature: string): string {
  return `${migrationId}:${signature}`;
}
function receiptMigration(receipt: PendingChainRecord): string {
  return receipt.entityId.split(":", 1)[0];
}

/** The holder's share of the company, marked "≈" when rounded. */
function percentOf(units: bigint, granularity: number): string {
  return percentText(percentFigure(units, BigInt(granularity)));
}

function dateText(iso: string): string {
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

export default function MigrationPage() {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  if (!conn.isReady || (conn.connecting && !wallet)) {
    return (
      <main className="min-w-0 flex-1" aria-busy="true">
        <p role="status" className="text-sm text-slate-500">Connecting your wallet…</p>
        <div className="mt-6"><SkeletonTable rows={3} cols={4} /></div>
      </main>
    );
  }
  if (!wallet) {
    return (
      <main className="min-w-0 flex-1">
        <Intro />
        <div className="mt-6"><WalletRequired context="Connect the wallet that holds the token you want to exchange." /></div>
      </main>
    );
  }
  // A wallet or network switch mounts a fresh workspace before any new read.
  return <MigrationWorkspace key={`${detectNetwork()}:${wallet}`} />;
}

function Intro() {
  return (
    <div className="max-w-2xl">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Token migration</p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">Migrate a token</h1>
      <p className="mt-2 text-sm text-slate-600">
        Exchange a token a company already issued on Solana for units of that company&apos;s share class on Manci, at the
        ratio its campaign publishes. Deposits are whole lots of the old token, sent during the campaign&apos;s opt-in window;
        Manci then sends your units to the same wallet.
      </p>
      <p className="mt-1 text-xs text-slate-500">
        The exchange itself needs no identity verification. Converting units into a registered ownership stake later is a
        separate step that requires KYC, where it is offered. Read the campaign&apos;s Swap Terms before you deposit.{" "}
        <Link href="/migrations" className="text-brand-700 underline underline-offset-2">All campaigns</Link>
      </p>
    </div>
  );
}

function MigrationWorkspace() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const network = detectNetwork();
  const wallet = conn.wallet?.account.address.toString() ?? "";
  const entryOpen = moduleEnabled("tokenMigration");
  const recovery = useChainRecordRecovery("migration_deposit", network, wallet);
  const nowSec = useChainClock();
  const [campaigns, setCampaigns] = useState<PublicMigration[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [balances, setBalances] = useState<Map<string, bigint | null>>(new Map());
  const [lotsInput, setLotsInput] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<{ campaign: PublicMigration; lots: bigint } | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const list = await fetchPublicMigrations();
      const details = await Promise.all(list.map((m) => fetchPublicMigration(m.slug)));
      if (mounted.current) setCampaigns(details);
    } catch (err) {
      if (mounted.current) setLoadError(err instanceof Error ? err.message : "Could not load the campaigns.");
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // The wallet's balance of each open campaign's old token (its associated token account).
  useEffect(() => {
    if (!campaigns || !wallet) return;
    let cancelled = false;
    void (async () => {
      const next = new Map<string, bigint | null>();
      await Promise.all(
        campaigns.filter((c) => c.status === "open").map(async (c) => {
          try {
            const ata = await associatedTokenAccount(wallet, c.old_mint, c.old_token_program);
            const account = await withRpcReadRetry(() => fetchEncodedAccount(client.runtime.rpc, ata, { commitment: "confirmed" }));
            if (!account.exists || account.programAddress !== c.old_token_program) {
              next.set(c.id, BigInt(0));
              return;
            }
            const decoded = getTokenDecoder().decode(account.data);
            next.set(c.id, decoded.mint === address(c.old_mint) && decoded.owner === address(wallet) ? decoded.amount : BigInt(0));
          } catch {
            next.set(c.id, null);
          }
        }),
      );
      if (!cancelled) setBalances(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [campaigns, wallet, client]);

  async function finishRecord(receipt: PendingChainRecord) {
    const session = conn.wallet;
    if (!session || receipt.wallet !== wallet || receipt.network !== network) {
      throw new Error("Connect the wallet and network that sent this deposit.");
    }
    const migrationId = receiptMigration(receipt);
    const outcome = await recovery.recordFinalized(receipt, async () => {
      await recordMigrationDeposit(session, { migrationId, signature: receipt.signature });
    });
    if (outcome === "failed") throw new Error(DEPOSIT_FAILED_MESSAGE);
    if (outcome === "not_finalized") throw new Error(DEPOSIT_NOT_FINALIZED_MESSAGE);
    recovery.forget(receipt);
    void load();
  }

  async function retryRecord(receipt: PendingChainRecord) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    const pendingId = toast.showPending("Recording your deposit…");
    try {
      await finishRecord(receipt);
      toast.show({ kind: "success", title: "Deposit recorded" });
    } catch (err) {
      toast.showError("Deposit recording pending", err instanceof Error ? err.message : "Retry recording this receipt later.");
    } finally {
      toast.dismiss(pendingId);
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function discardReceipt(receipt: PendingChainRecord) {
    const { discarded, state } = await recovery.discard(receipt);
    if (discarded) {
      toast.show({ kind: "success", title: "Receipt discarded", description: "Nothing moved on the network. You can deposit again." });
      return;
    }
    toast.showError(
      "Receipt kept",
      state === "pending" ? "The transaction is still pending on the network." : state === "landed" ? "The transaction landed: use Retry recording instead." : "The network could not be asked. Try again in a moment.",
    );
  }

  async function deposit(campaign: PublicMigration, lots: bigint) {
    const session = conn.wallet;
    if (!session || busyRef.current || !entryOpen) return;
    if (recovery.receipts.some((r) => receiptMigration(r) === campaign.id)) {
      toast.showError("Record your earlier deposit first", "A deposit to this campaign was sent and is not recorded yet: use Retry recording above before depositing again.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    let sent: string | null = null;
    let pendingId = toast.showPending("Checking the campaign and your wallet…");
    try {
      assertChainRecordStorageAvailable();
      const plan = await precheckDeposit(session, { migrationId: campaign.id, lots });
      const amount = lots * BigInt(campaign.lot_base_units);
      if (plan.deposit_ata !== campaign.deposit_ata || plan.old_mint !== campaign.old_mint || plan.amount_base !== amount.toString()) {
        throw new Error("The campaign changed while you were on this page. Reload it before depositing.");
      }
      const signer = walletSigner(session);
      const built = await buildDepositInstructions({
        holder: signer,
        depositOwner: plan.deposit_owner,
        oldMint: plan.old_mint,
        oldTokenProgram: plan.old_token_program,
        decimals: plan.old_decimals,
        migrationId: campaign.id,
        lots,
        amount,
      });
      if (built.destination !== plan.deposit_ata) throw new Error("The deposit account does not match the campaign. Nothing was sent.");
      toast.dismiss(pendingId);
      pendingId = toast.showPending(`Confirm in your wallet: deposit ${formatBaseUnits(amount, campaign.old_decimals)} ${campaign.old_symbol}`);
      const signature = await tx.send({ instructions: built.instructions, feePayer: signer });
      sent = signature;
      const receipt = recovery.remember(receiptEntity(campaign.id, signature), signature);
      toast.dismiss(pendingId);
      pendingId = toast.showPending("Deposit sent: waiting for Solana to finalize it (usually 15–30 s). Keep this page open; you will sign once to record it.");
      await finishRecord(receipt);
      toast.dismiss(pendingId);
      toast.showTx(signature, { title: "Deposit recorded" });
    } catch (err) {
      toast.dismiss(pendingId);
      if (sent) {
        toast.showTx(sent, { title: "Deposit sent: recording pending" });
        toast.showError("Retry recording the deposit", explainSendError(err));
      } else {
        toast.showError("Deposit not sent", explainSendError(err));
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      setConfirm(null);
      void load();
    }
  }

  const open = (campaigns ?? []).filter((c) => c.status === "open");
  const mine: Array<{ campaign: PublicMigration; deposit: PublicDeposit }> = (campaigns ?? []).flatMap((c) =>
    c.deposits.filter((d) => d.holder_wallet === wallet).map((d) => ({ campaign: c, deposit: d })),
  );
  // A display clock (lib/use-chain-clock); the record route judges the window by the transaction's block time.
  const now = Number(nowSec) * 1000;

  return (
    <main className="min-w-0 flex-1">
      <Intro />

      <ChainRecordRecoveryPanel
        receipts={recovery.receipts}
        busy={busy || tx.isSending}
        onRetry={retryRecord}
        states={recovery.states}
        onDiscard={discardReceipt}
      />

      {loadError && (
        <div className="mt-6 flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 sm:flex-row sm:items-center sm:justify-between">
          <span role="alert">Could not load the campaigns: {loadError}</span>
          <button type="button" onClick={() => void load()} className="min-h-10 shrink-0 rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400">
            Retry loading
          </button>
        </div>
      )}

      <section aria-labelledby="open-campaigns" className="mt-8">
        <h2 id="open-campaigns" className="text-base font-semibold text-slate-900">Open campaigns</h2>
        {campaigns === null && !loadError && <div className="mt-3"><SkeletonTable rows={2} cols={3} /></div>}
        {campaigns !== null && open.length === 0 && (
          <p className="mt-2 text-sm text-slate-600">No campaign is open right now. <Link href="/migrations" className="text-brand-700 underline underline-offset-2">See past campaigns</Link>.</p>
        )}
        <div className="mt-3 space-y-4">
          {open.map((c) => {
            const lot = BigInt(c.lot_base_units);
            const left = BigInt(c.units_cap) - BigInt(c.progress.unitsDue) - BigInt(c.progress.unitsDelivered);
            const balance = balances.get(c.id);
            const affordable = balance === undefined || balance === null ? null : lotsFor(balance, lot);
            const maxLots = affordable === null ? null : affordable < left ? affordable : left;
            const raw = lotsInput[c.id] ?? "1";
            const lots = /^[1-9]\d{0,15}$/.test(raw.trim()) ? BigInt(raw.trim()) : null;
            const window = windowStateAt(c.window_opens_at, c.window_closes_at, now);
            const problem = !entryOpen
              ? "New deposits are not available here."
              : window === "not_yet"
                ? `The window opens on ${dateText(c.window_opens_at)}.`
                : window === "ended"
                  ? "The window has ended."
                  : lots === null
                    ? "Enter a whole number of lots (at least 1)."
                    : maxLots !== null && lots > maxLots
                      ? maxLots === BigInt(0)
                        ? left <= BigInt(0) ? "Every unit of this campaign is claimed." : `Your wallet holds less than one lot (${formatBaseUnits(lot, c.old_decimals)} ${c.old_symbol}).`
                        : `You can deposit at most ${formatUnits(maxLots)} lots.`
                      : null;
            return (
              <article key={c.id} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-base font-semibold text-slate-900">{c.old_name} ({c.old_symbol}) → {c.company_name}</h3>
                  <Link href={`/migrations/${c.slug}`} className="text-xs text-brand-700 underline underline-offset-2">Campaign page and proof</Link>
                </div>
                <p className="mt-2 text-sm text-slate-700">
                  {ratioSentence(formatBaseUnits(lot, c.old_decimals), c.old_symbol)}; 1 unit {percentClause(unitPercent(BigInt(c.granularity)))} of {c.company_name}.
                </p>
                <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-2">
                  <div><dt className="inline font-medium">Window: </dt><dd className="inline">{dateText(c.window_opens_at)} to {dateText(c.window_closes_at)}</dd></div>
                  <div><dt className="inline font-medium">Units left: </dt><dd className="inline">{formatUnits(left > BigInt(0) ? left : BigInt(0))} of {formatUnits(BigInt(c.units_cap))}</dd></div>
                  <div><dt className="inline font-medium">Your {c.old_symbol}: </dt><dd className="inline">{balance === undefined ? "reading…" : balance === null ? "could not be read" : formatBaseUnits(balance, c.old_decimals)}</dd></div>
                  <div><dt className="inline font-medium">Lots you can deposit: </dt><dd className="inline">{maxLots === null ? "—" : formatUnits(maxLots)}</dd></div>
                </dl>
                {c.terms_doc_url && (
                  <p className="mt-2 text-xs text-slate-500">
                    Swap Terms: <a href={c.terms_doc_url} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline underline-offset-2">read the document</a>
                    {c.terms_doc_sha256 && <> · SHA-256 <span className="break-all font-mono">{c.terms_doc_sha256}</span></>}
                  </p>
                )}
                <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end">
                  <label className="text-xs font-medium text-slate-700">
                    Lots to deposit
                    <input
                      inputMode="numeric"
                      value={raw}
                      onChange={(e) => setLotsInput((m) => ({ ...m, [c.id]: e.target.value }))}
                      className="mt-1 block w-32 rounded-md border border-slate-300 px-2 py-1.5 font-mono text-sm"
                      aria-describedby={`preview-${c.id}`}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={problem !== null || busy || tx.isSending || lots === null}
                    onClick={() => lots && setConfirm({ campaign: c, lots })}
                    className="min-h-10 rounded-lg bg-brand-700 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-800 disabled:opacity-50"
                  >
                    Deposit {lots ? formatUnits(lots) : ""} {lots === BigInt(1) ? "lot" : "lots"}
                  </button>
                </div>
                <p id={`preview-${c.id}`} className="mt-2 text-xs text-slate-600" role="status">
                  {problem ?? (lots
                    ? `You send ${formatBaseUnits(lots * lot, c.old_decimals)} ${c.old_symbol} and receive ${formatUnits(lots)} ${lots === BigInt(1) ? "unit" : "units"} (${percentOf(lots, c.granularity)} % of ${c.company_name}) once Manci delivers them.`
                    : "")}
                </p>
              </article>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="my-deposits" className="mt-10">
        <h2 id="my-deposits" className="text-base font-semibold text-slate-900">My deposits</h2>
        {mine.length === 0 ? (
          <p className="mt-2 text-sm text-slate-600">No recorded deposit from this wallet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full text-left text-xs">
              <thead className="text-slate-500">
                <tr><th className="py-2 pr-4">Campaign</th><th className="py-2 pr-4">Deposited</th><th className="py-2 pr-4">Units</th><th className="py-2 pr-4">Status</th><th className="py-2 pr-4">Transactions</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {mine.map(({ campaign, deposit: d }) => (
                  <tr key={d.deposit_tx}>
                    <td className="py-2 pr-4"><Link href={`/migrations/${campaign.slug}`} className="text-brand-700 underline underline-offset-2">{campaign.old_symbol} → {campaign.company_name}</Link></td>
                    <td className="py-2 pr-4 font-mono">{formatBaseUnits(BigInt(d.amount_base), campaign.old_decimals)} {campaign.old_symbol}</td>
                    <td className="py-2 pr-4 font-mono">{formatUnits(BigInt(d.units_due))}</td>
                    <td className="py-2 pr-4">{DEPOSIT_STATUS_LABEL[d.status]}{d.reason ? ` (${d.reason})` : ""}</td>
                    <td className="py-2 pr-4 space-x-2">
                      <a href={explorerTxUrl(d.deposit_tx, network)} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline underline-offset-2">deposit</a>
                      {d.delivery_tx && <a href={explorerTxUrl(d.delivery_tx, network)} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline underline-offset-2">delivery</a>}
                      {d.refund_tx && <a href={explorerTxUrl(d.refund_tx, network)} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline underline-offset-2">refund</a>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <ConfirmModal
        open={confirm !== null}
        onClose={() => !busy && setConfirm(null)}
        onConfirm={() => (confirm ? deposit(confirm.campaign, confirm.lots) : undefined)}
        title="Deposit into the campaign"
        kind="info"
        requireReason={false}
        busy={busy}
        confirmLabel="Deposit"
        description={confirm ? (
          <div className="space-y-2 text-sm">
            <p>
              You send {formatBaseUnits(confirm.lots * BigInt(confirm.campaign.lot_base_units), confirm.campaign.old_decimals)} {confirm.campaign.old_symbol} to
              the campaign&apos;s deposit account and are owed {formatUnits(confirm.lots)} {confirm.lots === BigInt(1) ? "unit" : "units"} of {confirm.campaign.company_name}&apos;s share class.
            </p>
            <p className="text-xs text-slate-600">
              The deposit cannot be withdrawn: Manci delivers the units, or refunds a deposit that does not meet the campaign&apos;s
              rules. You sign twice: the deposit, then one message to record it.
            </p>
          </div>
        ) : null}
      />
    </main>
  );
}

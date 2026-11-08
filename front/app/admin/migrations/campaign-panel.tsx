"use client";

// One token migration campaign in the admin console: its facts and the
// lifecycle steps (open, close, cancel, complete: app/api/token-migrations/
// admin/transition), the daily reconcile, the deposits with their internal
// reasons, refunds, the burn of the collected old tokens, the delivery panel
// and the record of a transaction made elsewhere (a Squads vault's proposal).
//
// Opening is the module's holder-facing entry: the admin's wallet creates
// the deposit account (the deposit owner's ATA of the old mint, idempotent;
// any owner, a Squads vault's program address included), then the server
// checks it and opens the campaign; with the module off the button says so.
// Refunds and the burn are signed by the deposit owner: when the connected
// wallet is that owner the page sends them; otherwise the multisig executes
// them and their signatures are recorded here. Every record is verified on
// chain by the server.

import { useCallback, useEffect, useRef, useState } from "react";
import { address, fetchEncodedAccount } from "@solana/kit";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { getTokenDecoder } from "@solana-program/token-2022";
import { ChainRecordRecoveryPanel } from "@/components/chain-record-recovery-panel";
import { ConfirmModal } from "@/components/confirm-modal";
import { assertChainRecordStorageAvailable, type PendingChainRecord } from "@/lib/chain-record-recovery";
import { moduleDisabledMessage, moduleEnabled } from "@/lib/features";
import { detectNetwork } from "@/lib/network";
import { withRpcReadRetry } from "@/lib/rpc-retry";
import { waitForFinalizedSignature } from "@/lib/chain-record-recovery";
import { waitForSignature } from "@/lib/simulation-gate";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { useChainRecordRecovery } from "@/lib/use-chain-record-recovery";
import { useChainClock } from "@/lib/use-chain-clock";
import { walletSigner } from "@/lib/wallet-signer";
import { readAdminMigration, reconcileMigration, recordMigrationSettlement, transitionMigration } from "@/lib/token-migration/client";
import {
  DEPOSIT_STATUS_LABEL,
  MIGRATION_STATUS_LABEL,
  TOKEN_PROGRAM_2022,
  MIGRATION_SOURCE_LABEL,
  UNCLAIMED_POLICY_LABEL,
  windowStateAt,
  type MigrationStatus,
} from "@/lib/token-migration/model";
import { formatBaseUnits, formatEquityBps, formatPercentE4, formatUnits, unitPercent } from "@/lib/token-migration/ratio";
import type { DepositRow, MigrationProgress, MigrationRow } from "@/lib/token-migration/rows";
import { associatedTokenAccount, buildBurnInstructions, buildOpenDepositAccount, buildRefundInstructions } from "@/lib/token-migration/transactions";
import { DeliveryPanel } from "./delivery-panel";
import { AddressLink, Card, dangerButton, errorText, Field, inputClass, Notes, primaryButton, secondaryButton, short, TxLink, utcText } from "./ui";

type Loaded = { migration: MigrationRow; deposits: DepositRow[]; progress: MigrationProgress };

export function CampaignPanel({ id, onEdit, onChanged }: { id: string; onEdit: (m: MigrationRow) => void; onChanged: () => void }) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const network = detectNetwork();
  const wallet = conn.wallet?.account.address.toString() ?? "";
  const refundRecovery = useChainRecordRecovery("migration_refund", network, wallet);
  // A display clock (lib/use-chain-clock); the server decides with its own.
  const nowSec = useChainClock();
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<MigrationStatus | null>(null);
  const [refunding, setRefunding] = useState<DepositRow | null>(null);
  const [complianceCleared, setComplianceCleared] = useState(false);
  const [record, setRecord] = useState({ kind: "delivery", signature: "", depositId: "", cleared: false });
  const [reconcileNote, setReconcileNote] = useState<string | null>(null);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!conn.wallet) return;
    setError(null);
    try {
      setData(await readAdminMigration(conn.wallet, id));
    } catch (err) {
      setError(errorText(err));
    }
  }, [conn.wallet, id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // The treasury's units of the class against the cap and what is due (re-read with every reload).
  const [treasuryUnits, setTreasuryUnits] = useState<bigint | null | undefined>(undefined);
  useEffect(() => {
    if (!data) return;
    let cancelled = false;
    void (async () => {
      try {
        const ata = await associatedTokenAccount(data.migration.treasury_wallet, data.migration.new_mint, TOKEN_PROGRAM_2022);
        const account = await withRpcReadRetry(() => fetchEncodedAccount(client.runtime.rpc, ata, { commitment: "confirmed" }));
        const units = account.exists && account.programAddress === TOKEN_PROGRAM_2022 ? getTokenDecoder().decode(account.data).amount : BigInt(0);
        if (!cancelled) setTreasuryUnits(units);
      } catch {
        if (!cancelled) setTreasuryUnits(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data, client]);

  const refresh = useCallback(() => {
    void load();
    onChanged();
  }, [load, onChanged]);

  async function run<T>(label: string, work: () => Promise<T>): Promise<T | undefined> {
    if (busyRef.current) return undefined;
    busyRef.current = true;
    setBusy(true);
    const pendingId = toast.showPending(label);
    try {
      return await work();
    } catch (err) {
      toast.showError(label.replace(/…$/, " failed"), explainSendError(err));
      return undefined;
    } finally {
      toast.dismiss(pendingId);
      busyRef.current = false;
      setBusy(false);
      refresh();
    }
  }

  if (error) return <Card title="Campaign"><Notes tone="bad" items={[error]} /><button type="button" className={`${secondaryButton} mt-3`} onClick={() => void load()}>Retry</button></Card>;
  if (!data) return <Card title="Campaign"><p className="text-sm text-slate-500">Loading…</p></Card>;
  const { migration: m, deposits, progress } = data;
  const lot = BigInt(m.lot_base_units);
  const cap = BigInt(m.units_cap);
  const granularity = BigInt(m.granularity);
  const entryOpen = moduleEnabled("tokenMigration");
  const delivered = deposits.some((d) => d.status === "delivered");
  const unsettled = deposits.filter((d) => d.status === "accepted" || d.status === "irregular").length;
  const isDepositOwner = wallet === m.deposit_owner;

  async function open() {
    await run("Opening the campaign…", async () => {
      const session = conn.wallet;
      if (!session) throw new Error("Connect your wallet.");
      const existing = await withRpcReadRetry(() => fetchEncodedAccount(client.runtime.rpc, address(m.deposit_ata), { commitment: "confirmed" }));
      if (!existing.exists) {
        const signer = walletSigner(session);
        const instructions = await buildOpenDepositAccount({ payer: signer, depositOwner: m.deposit_owner, oldMint: m.old_mint, oldTokenProgram: m.old_token_program });
        const signature = await tx.send({ instructions, feePayer: signer });
        const outcome = await waitForSignature(client.runtime.rpc, signature, { timeoutMs: 45_000, retryReads: true });
        if (outcome !== "confirmed") throw new Error(`The deposit account was not confirmed in time (${outcome}); check ${signature} on the explorer and open again.`);
      }
      await transitionMigration(session, { id: m.id, to: "open" });
      toast.show({ kind: "success", title: "Campaign open", description: "Holders can deposit from the window's start." });
    });
  }

  async function transition(to: MigrationStatus) {
    await run(`Moving the campaign to ${MIGRATION_STATUS_LABEL[to].toLowerCase()}…`, async () => {
      if (!conn.wallet) throw new Error("Connect your wallet.");
      await transitionMigration(conn.wallet, { id: m.id, to: to as "closed" | "cancelled" | "completed" });
      toast.show({ kind: "success", title: `Campaign ${MIGRATION_STATUS_LABEL[to].toLowerCase()}` });
    });
    setConfirm(null);
  }

  /** The next stretch of the deposit account's history, or one transaction the operator names. */
  async function reconcile(signature?: string) {
    await run("Reconciling the deposit account…", async () => {
      if (!conn.wallet) throw new Error("Connect your wallet.");
      const answer = await reconcileMigration(conn.wallet, m.id, signature);
      const recorded = answer.results.filter((r) => r.outcome === "recorded").length;
      const skipped = answer.results.filter((r) => r.outcome === "not_a_deposit" || r.outcome === "other_campaign");
      setReconcileNote(
        `${answer.examined} ${answer.examined === 1 ? "transaction" : "transactions"} read; ${recorded} new ${recorded === 1 ? "deposit" : "deposits"} recorded` +
          (skipped.length ? `; ${skipped.length} not a deposit of this campaign (${skipped.map((x) => `${short(x.signature)}: ${x.detail}`).join("; ")})` : "") +
          (answer.stopped ? `. Stopped: ${answer.stopped}` : answer.complete ? ". The deposit account's history is read up to now." : ". More history is left: run it again."),
      );
    });
  }

  async function recordRefund(receipt: PendingChainRecord, depositId: string, cleared: boolean) {
    const session = conn.wallet;
    if (!session) throw new Error("Connect your wallet.");
    const outcome = await refundRecovery.recordFinalized(receipt, async () => {
      await recordMigrationSettlement(session, { id: m.id, kind: "refund", signature: receipt.signature, deposit_ids: [depositId], compliance_cleared: cleared });
    });
    if (outcome === "failed") throw new Error("The refund failed on the network: nothing moved.");
    if (outcome === "not_finalized") throw new Error("The refund is not finalized yet: use Retry recording in a minute; do not refund again.");
    refundRecovery.forget(receipt);
  }

  async function refund(d: DepositRow, cleared: boolean) {
    await run("Refunding the deposit…", async () => {
      const session = conn.wallet;
      if (!session) throw new Error("Connect your wallet.");
      if (refundRecovery.receipts.some((r) => r.entityId === `${m.id}:${d.id}`)) throw new Error("A refund of this deposit was sent: retry recording it instead.");
      assertChainRecordStorageAvailable();
      const signer = walletSigner(session);
      const instructions = await buildRefundInstructions({ depositOwner: signer, holder: d.holder_wallet, oldMint: m.old_mint, oldTokenProgram: m.old_token_program, decimals: m.old_decimals, amount: BigInt(d.amount_base) });
      const signature = await tx.send({ instructions, feePayer: signer });
      const receipt = refundRecovery.remember(`${m.id}:${d.id}`, signature);
      await recordRefund(receipt, d.id, cleared);
      toast.showTx(signature, { title: "Refund recorded" });
    });
    setRefunding(null);
    setComplianceCleared(false);
  }

  async function burn() {
    await run("Burning the collected tokens…", async () => {
      const session = conn.wallet;
      if (!session) throw new Error("Connect your wallet.");
      const account = await withRpcReadRetry(() => fetchEncodedAccount(client.runtime.rpc, address(m.deposit_ata), { commitment: "confirmed" }));
      const amount = account.exists ? getTokenDecoder().decode(account.data).amount : BigInt(0);
      if (amount <= BigInt(0)) throw new Error("The deposit account holds nothing to burn.");
      const signer = walletSigner(session);
      const instructions = await buildBurnInstructions({ depositOwner: signer, oldMint: m.old_mint, oldTokenProgram: m.old_token_program, decimals: m.old_decimals, amount });
      const signature = await tx.send({ instructions, feePayer: signer });
      const outcome = await waitForFinalizedSignature(client.runtime.rpc, signature);
      if (outcome !== "finalized") throw new Error(`The burn ${signature} is not finalized yet (${outcome}): record it below once it is.`);
      await recordMigrationSettlement(session, { id: m.id, kind: "burn", signature });
      toast.showTx(signature, { title: "Burn recorded" });
    });
  }

  async function recordElsewhere() {
    if (record.kind === "reconcile") {
      await reconcile(record.signature.trim());
      setRecord({ kind: record.kind, signature: "", depositId: "", cleared: false });
      return;
    }
    await run("Recording the transaction…", async () => {
      if (!conn.wallet) throw new Error("Connect your wallet.");
      const signature = record.signature.trim();
      const input = record.kind === "refund"
        ? { id: m.id, kind: "refund" as const, signature, deposit_ids: record.depositId.split(/[\s,]+/).filter(Boolean), compliance_cleared: record.cleared }
        : record.kind === "burn" ? { id: m.id, kind: "burn" as const, signature } : { id: m.id, kind: "delivery" as const, signature };
      const answer = await recordMigrationSettlement(conn.wallet, input);
      toast.show({ kind: "success", title: answer.created === false ? "Already recorded" : "Transaction recorded" });
      setRecord({ kind: record.kind, signature: "", depositId: "", cleared: false });
    });
  }

  const window = windowStateAt(m.window_opens_at, m.window_closes_at, Number(nowSec) * 1000);
  const canClose = m.status === "open" && (window === "ended" || BigInt(progress.unitsDue) + BigInt(progress.unitsDelivered) >= cap);

  return (
    <div className="space-y-6">
      <Card
        title={`${m.old_symbol} → ${m.company_name} (${m.slug})`}
        aside={<span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold text-slate-700">{MIGRATION_STATUS_LABEL[m.status]}</span>}
      >
        <dl className="grid gap-x-6 gap-y-1.5 text-[13px] text-slate-700 sm:grid-cols-2">
          <div><dt className="inline text-slate-500">Ratio: </dt><dd className="inline">1 unit per {formatBaseUnits(lot, m.old_decimals)} {m.old_symbol}; 1 unit = {unitPercent(granularity)} %</dd></div>
          <div><dt className="inline text-slate-500">E / cap: </dt><dd className="inline">{formatEquityBps(m.equity_bps)} % decided; cap {formatUnits(cap)} units ({formatPercentE4((cap * BigInt(1_000_000)) / granularity)} %)</dd></div>
          <div><dt className="inline text-slate-500">Window: </dt><dd className="inline">{utcText(m.window_opens_at)} to {utcText(m.window_closes_at)}</dd></div>
          <div><dt className="inline text-slate-500">Progress: </dt><dd className="inline">{formatUnits(BigInt(progress.unitsDelivered))} delivered, {formatUnits(BigInt(progress.unitsDue))} due, {progress.holders} holders, {progress.refundsDue} refunds due</dd></div>
          <div><dt className="inline text-slate-500">Deposit account: </dt><dd className="inline"><AddressLink address={m.deposit_ata} /> (owner <AddressLink address={m.deposit_owner} />)</dd></div>
          <div><dt className="inline text-slate-500">Treasury: </dt><dd className="inline"><AddressLink address={m.treasury_wallet} /> holds {treasuryUnits === undefined ? "…" : treasuryUnits === null ? "(unreadable)" : formatUnits(treasuryUnits)} units of mint <AddressLink address={m.new_mint} /></dd></div>
          <div><dt className="inline text-slate-500">Source: </dt><dd className="inline">{MIGRATION_SOURCE_LABEL[m.source]}; {UNCLAIMED_POLICY_LABEL[m.unclaimed_policy].toLowerCase()}</dd></div>
          <div><dt className="inline text-slate-500">Swap Terms: </dt><dd className="inline">{m.terms_doc_url ? <a href={m.terms_doc_url} target="_blank" rel="noopener noreferrer" className="text-brand-700 underline">document</a> : "not set"}{m.terms_doc_sha256 ? ` · ${short(m.terms_doc_sha256)}` : ""}</dd></div>
          {m.final_report_sha256 && <div className="sm:col-span-2"><dt className="inline text-slate-500">Final report: </dt><dd className="inline"><a href={`/api/token-migrations/report?slug=${m.slug}`} className="text-brand-700 underline">JSON</a> · SHA-256 <span className="font-mono">{m.final_report_sha256}</span></dd></div>}
          {m.old_tokens_burn_tx && m.old_tokens_burned && <div className="sm:col-span-2"><dt className="inline text-slate-500">Burned: </dt><dd className="inline">{formatBaseUnits(BigInt(m.old_tokens_burned), m.old_decimals)} {m.old_symbol} in <TxLink signature={m.old_tokens_burn_tx} /></dd></div>}
        </dl>
        <Notes tone="warn" items={[
          ...(m.deposit_owner === wallet && m.status === "draft" ? ["The deposit owner is your own wallet: one key could then move every deposit. A Squads vault is recommended."] : []),
          ...(m.status === "draft" && !entryOpen ? [moduleDisabledMessage("tokenMigration")] : []),
          ...(typeof treasuryUnits === "bigint" && (m.status === "open" || m.status === "closed") && treasuryUnits < BigInt(progress.unitsDue)
            ? [`The treasury holds ${formatUnits(treasuryUnits)} units, fewer than the ${formatUnits(BigInt(progress.unitsDue))} due: put units in the treasury before the next delivery.`]
            : []),
          ...(typeof treasuryUnits === "bigint" && m.status === "draft" && m.source === "founder_transfer" && treasuryUnits < cap
            ? [`The treasury holds ${formatUnits(treasuryUnits)} of the ${formatUnits(cap)} units the cap can claim: the founders' units go to the treasury before opening (runbook §24).`]
            : []),
        ]} />
        <div className="mt-4 flex flex-wrap gap-2">
          {m.status === "draft" && (
            <>
              <button type="button" className={secondaryButton} disabled={busy} onClick={() => onEdit(m)}>Edit draft</button>
              <button type="button" className={primaryButton} disabled={busy || !entryOpen || !m.terms_doc_sha256 || !m.terms_doc_url} onClick={() => setConfirm("open")}>Create the deposit account and open</button>
            </>
          )}
          {(m.status === "open" || m.status === "closed" || m.status === "cancelled") && (
            <button type="button" className={secondaryButton} disabled={busy} onClick={() => void reconcile()}>Reconcile deposits</button>
          )}
          {m.status === "open" && <button type="button" className={secondaryButton} disabled={busy || !canClose} title={canClose ? undefined : "After the window, or once every unit is claimed"} onClick={() => setConfirm("closed")}>Close</button>}
          {m.status === "closed" && <button type="button" className={primaryButton} disabled={busy || unsettled > 0} title={unsettled > 0 ? `${unsettled} deposit(s) still to deliver or refund` : undefined} onClick={() => setConfirm("completed")}>Complete and publish the report</button>}
          {(m.status === "closed" || m.status === "completed") && !m.old_tokens_burn_tx && isDepositOwner && (
            <button type="button" className={secondaryButton} disabled={busy} onClick={() => void burn()}>Burn the collected tokens</button>
          )}
          {(m.status === "draft" || m.status === "open" || m.status === "closed") && !delivered && (
            <button type="button" className={dangerButton} disabled={busy} onClick={() => setConfirm("cancelled")}>Cancel the campaign</button>
          )}
        </div>
        {reconcileNote && <Notes tone="info" items={[reconcileNote]} />}
      </Card>

      {(m.status === "open" || m.status === "closed") && <DeliveryPanel migration={m} deposits={deposits} onRecorded={refresh} />}

      <Card title={`Deposits (${deposits.length})`}>
        <ChainRecordRecoveryPanel
          receipts={refundRecovery.receipts}
          busy={busy || tx.isSending}
          states={refundRecovery.states}
          onRetry={async (receipt) => {
            const depositId = receipt.entityId.split(":")[1] ?? "";
            await run("Recording the refund…", () => recordRefund(receipt, depositId, deposits.find((d) => d.id === depositId)?.reason_code === "compliance_hold"));
          }}
        />
        {deposits.length === 0 ? (
          <p className="text-sm text-slate-600">No deposit recorded yet. Holders record their own; Reconcile records the rest.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-xs">
              <thead className="bg-slate-50 text-slate-500"><tr><th className="px-3 py-2">Holder</th><th className="px-3 py-2 text-right">Deposited</th><th className="px-3 py-2 text-right">Units</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Deposit</th><th className="px-3 py-2">Settled by</th><th className="px-3 py-2">Action</th></tr></thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {deposits.map((d) => {
                  const refundable = d.status === "irregular" || (d.status === "accepted" && m.status === "cancelled");
                  return (
                    <tr key={d.id}>
                      <td className="px-3 py-1.5"><AddressLink address={d.holder_wallet} /></td>
                      <td className="px-3 py-1.5 text-right font-mono">{formatBaseUnits(BigInt(d.amount_base), m.old_decimals)}</td>
                      <td className="px-3 py-1.5 text-right font-mono">{formatUnits(BigInt(d.units_due))}</td>
                      <td className="px-3 py-1.5">{DEPOSIT_STATUS_LABEL[d.status]}{d.reason && <span className="block text-[11px] text-slate-500">{d.reason}</span>}</td>
                      <td className="px-3 py-1.5"><TxLink signature={d.deposit_tx} /> <span className="text-slate-400">({d.recorded_via})</span></td>
                      <td className="px-3 py-1.5">{d.delivery_tx ? <TxLink signature={d.delivery_tx} /> : d.refund_tx ? <TxLink signature={d.refund_tx} /> : "—"}</td>
                      <td className="px-3 py-1.5">
                        {refundable && isDepositOwner && <button type="button" className="text-xs font-semibold text-red-700 underline disabled:opacity-50" disabled={busy} onClick={() => setRefunding(d)}>Refund</button>}
                        {refundable && !isDepositOwner && <span className="text-[11px] text-slate-500">Refund from the deposit owner, then record it (id {d.id.slice(0, 8)})</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {m.status !== "draft" && (
        <Card title="Record a transaction made elsewhere">
          <p className="text-[13px] text-slate-600">A delivery, refund or burn a Squads vault executed, or one deposit seen on an explorer: the server reads it at finalized and records it only when its balances prove exactly that. One refund transaction may return several irregular deposits of one holder.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[10rem_1fr]">
            <Field label="Kind">
              <select className={inputClass} value={record.kind} onChange={(e) => setRecord({ ...record, kind: e.target.value })}>
                <option value="delivery">Delivery</option>
                <option value="refund">Refund</option>
                <option value="burn">Burn</option>
                <option value="reconcile">Deposit (one transaction)</option>
              </select>
            </Field>
            <Field label="Transaction signature"><input className={`${inputClass} font-mono text-xs`} value={record.signature} onChange={(e) => setRecord({ ...record, signature: e.target.value })} /></Field>
            {record.kind === "refund" && (
              <>
                <Field label="Deposit ids (one holder's, comma-separated)"><input className={`${inputClass} font-mono text-xs`} value={record.depositId} onChange={(e) => setRecord({ ...record, depositId: e.target.value })} placeholder={deposits.find((d) => d.status === "irregular")?.id} /></Field>
                <label className="flex items-center gap-2 self-end text-xs text-slate-700"><input type="checkbox" checked={record.cleared} onChange={(e) => setRecord({ ...record, cleared: e.target.checked })} /> The compliance team decided this refund (needed for a compliance hold)</label>
              </>
            )}
          </div>
          <button type="button" className={`${secondaryButton} mt-3`} disabled={busy || !record.signature.trim() || (record.kind === "refund" && !record.depositId.trim())} onClick={() => void recordElsewhere()}>Record</button>
        </Card>
      )}

      <ConfirmModal
        open={confirm !== null}
        onClose={() => !busy && setConfirm(null)}
        onConfirm={() => (confirm === "open" ? open().then(() => setConfirm(null)) : confirm ? transition(confirm) : undefined)}
        title={confirm === "open" ? "Open the campaign" : confirm === "completed" ? "Complete the campaign" : confirm === "cancelled" ? "Cancel the campaign" : "Close the campaign"}
        kind={confirm === "cancelled" ? "destructive" : "warning"}
        requireReason={false}
        busy={busy}
        confirmLabel={confirm === "open" ? "Create and open" : "Confirm"}
        description={
          confirm === "open" ? `Your wallet creates the deposit account (the deposit owner's ${m.old_symbol} account; you pay its rent) if it does not exist, then the campaign opens: its terms are frozen and holders can deposit from ${utcText(m.window_opens_at)}.`
            : confirm === "completed" ? "The final report is built from every deposit, stored with its SHA-256 and published. It can never change afterwards."
              : confirm === "cancelled" ? "No new deposit is accepted. Accepted deposits must then be refunded to their holders; nothing was delivered yet."
                : "The campaign stops taking deposits. Deliver the units due and refund the irregular deposits, then complete it."
        }
      />
      <ConfirmModal
        open={refunding !== null}
        onClose={() => !busy && setRefunding(null)}
        onConfirm={() => (refunding ? refund(refunding, complianceCleared) : undefined)}
        title="Refund the deposit"
        kind="warning"
        requireReason={false}
        busy={busy}
        confirmDisabled={refunding?.reason_code === "compliance_hold" && !complianceCleared}
        confirmLabel="Refund"
        description={refunding ? (
          <div className="space-y-2 text-sm">
            <p>Send {formatBaseUnits(BigInt(refunding.amount_base), m.old_decimals)} {m.old_symbol} back to {short(refunding.holder_wallet)} from the deposit account.</p>
            {refunding.reason_code === "compliance_hold" && (
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={complianceCleared} onChange={(e) => setComplianceCleared(e.target.checked)} /> The compliance team decided to refund this held deposit.</label>
            )}
          </div>
        ) : null}
      />
    </div>
  );
}

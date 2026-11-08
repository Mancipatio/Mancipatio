"use client";

// Token migration (V1) delivery: the operator sends each holder with
// accepted deposits its units of the share class from the treasury wallet,
// with the hook-aware tooling of "Send to wallets" (lib/distribution-checks,
// lib/distribution-plan, the transfer hook's account tail of
// lib/share-transfer):
//   1. the connected wallet must be the campaign's treasury wallet (a Squads
//      treasury delivers through a proposal instead, and its transaction is
//      recorded with "Record a transaction made elsewhere");
//   2. per-row checks read from chain (recipient is a wallet, not frozen, not
//      blocklisted, the KYC passport on a KycGated class) and the class
//      checks (hook config, 0 decimals, the treasury not blocklisted);
//   3. every recipient screened against the sanctions lists under this run's
//      id (/api/compliance/screen-recipients: a hit leaves that holder's
//      deposits accepted for the compliance team), then the server's
//      evidence of those screenings (/api/compliance/distribution-evidence:
//      nothing is signed without it);
//   4. the rows packed into as few transactions as fit and test-run on the
//      network (a refused row is dropped with its reason);
//   5. each transaction signed and sent, its receipt saved in this browser
//      (lib/chain-record-recovery "migration_delivery"), then recorded once
//      finalized (app/api/token-migrations/admin/record kind "delivery"),
//      which derives the deposits from the transaction: every holder it paid
//      gets ALL of its accepted deposits, so delivery is per holder.
// A receipt that could not be recorded stays for "Retry recording".

import { useEffect, useMemo, useRef, useState } from "react";
import { address, fetchEncodedAccount, type Address } from "@solana/kit";
import { useSendTransaction, useSolanaClient, useWalletConnection } from "@solana/react-hooks";
import { getTokenDecoder } from "@solana-program/token-2022";
import { ChainRecordRecoveryPanel } from "@/components/chain-record-recovery-panel";
import type { PendingChainRecord } from "@/lib/chain-record-recovery";
import { assertChainRecordStorageAvailable } from "@/lib/chain-record-recovery";
import { distributionEvidence, screenRecipients } from "@/lib/compliance";
import { distributionClassChecks, distributionRowChecks, loadDistributionFacts } from "@/lib/distribution-checks";
import { distributionRunId } from "@/lib/distribution-journal";
import { planWithSimulation, rowInstructions } from "@/lib/distribution-plan";
import { detectNetwork } from "@/lib/network";
import { withRpcReadRetry } from "@/lib/rpc-retry";
import { nowSeconds } from "@/lib/sale-liveness";
import { simulateInstructions } from "@/lib/simulation-gate";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { useChainRecordRecovery } from "@/lib/use-chain-record-recovery";
import { walletSigner } from "@/lib/wallet-signer";
import { recordMigrationSettlement } from "@/lib/token-migration/client";
import { TOKEN_PROGRAM_2022 } from "@/lib/token-migration/model";
import { formatUnits } from "@/lib/token-migration/ratio";
import type { DepositRow, MigrationRow } from "@/lib/token-migration/rows";
import { associatedTokenAccount } from "@/lib/token-migration/transactions";
import { AddressLink, Card, errorText, Notes, primaryButton, short } from "./ui";

/** Holders one run delivers to at most (a few transactions, one wallet prompt each). */
const MAX_HOLDERS_PER_RUN = 40;

type HolderDue = { wallet: string; units: bigint; deposits: number };

export function DeliveryPanel({ migration, deposits, onRecorded }: { migration: MigrationRow; deposits: DepositRow[]; onRecorded: () => void }) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const network = detectNetwork();
  const wallet = conn.wallet?.account.address.toString() ?? "";
  const recovery = useChainRecordRecovery("migration_delivery", network, wallet);
  const [treasuryUnits, setTreasuryUnits] = useState<bigint | null | undefined>(undefined);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [notes, setNotes] = useState<{ bad: string[]; info: string[] }>({ bad: [], info: [] });
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);

  const due = useMemo((): HolderDue[] => {
    const byHolder = new Map<string, HolderDue>();
    for (const d of deposits) {
      if (d.status !== "accepted") continue;
      const entry = byHolder.get(d.holder_wallet) ?? { wallet: d.holder_wallet, units: BigInt(0), deposits: 0 };
      entry.units += BigInt(d.units_due);
      entry.deposits += 1;
      byHolder.set(d.holder_wallet, entry);
    }
    return [...byHolder.values()];
  }, [deposits]);
  const chosen = selected ?? new Set(due.slice(0, MAX_HOLDERS_PER_RUN).map((h) => h.wallet));
  const rows = due.filter((h) => chosen.has(h.wallet));
  const total = rows.reduce((s, h) => s + h.units, BigInt(0));
  const isTreasury = wallet === migration.treasury_wallet;
  const canDeliver = migration.status === "open" || migration.status === "closed";

  // The treasury's units of the class (its associated Token-2022 account).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ata = await associatedTokenAccount(migration.treasury_wallet, migration.new_mint, TOKEN_PROGRAM_2022);
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
  }, [client, migration.treasury_wallet, migration.new_mint, deposits]);

  async function record(receipt: PendingChainRecord): Promise<boolean> {
    const session = conn.wallet;
    if (!session) throw new Error("Connect the wallet that sent the delivery.");
    const outcome = await recovery.recordFinalized(receipt, async () => {
      await recordMigrationSettlement(session, { id: migration.id, kind: "delivery", signature: receipt.signature });
    });
    if (outcome === "failed") throw new Error("The delivery failed on the network: nothing moved and the receipt was discarded.");
    if (outcome === "not_finalized") return false;
    recovery.forget(receipt);
    return true;
  }

  async function retry(receipt: PendingChainRecord) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const done = await record(receipt);
      if (done) toast.show({ kind: "success", title: "Delivery recorded" });
      else toast.showError("Delivery recording pending", "Not finalized yet: retry in a minute. Do not send it again.");
      onRecorded();
    } catch (err) {
      toast.showError("Delivery recording pending", errorText(err));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function deliver() {
    const session = conn.wallet;
    if (!session || busyRef.current || rows.length === 0 || !isTreasury) return;
    busyRef.current = true;
    setBusy(true);
    const bad: string[] = [];
    const info: string[] = [];
    setNotes({ bad, info });
    try {
      assertChainRecordStorageAvailable();
      if (treasuryUnits !== undefined && treasuryUnits !== null && treasuryUnits < total) {
        throw new Error(`The treasury holds ${formatUnits(treasuryUnits)} units, fewer than the ${formatUnits(total)} to deliver. Mint the units to the treasury first.`);
      }
      const rpc = client.runtime.rpc;
      const mint = address(migration.new_mint);
      const facts = await withRpcReadRetry(() => loadDistributionFacts(rpc, { mint, sender: address(wallet), recipients: rows.map((r) => address(r.wallet)) }));
      const classProblems = distributionClassChecks(facts).filter((c) => !c.ok).map((c) => c.text);
      if (classProblems.length) throw new Error(classProblems.join(" "));
      if (facts.senderBalance < total) throw new Error(`The treasury holds ${formatUnits(facts.senderBalance)} units, fewer than ${formatUnits(total)}.`);

      // Sanctions screening of every recipient under this run's id, then the server's evidence.
      const runId = await distributionRunId({ network, mint: migration.new_mint, sender: wallet, rows: rows.map((r) => ({ wallet: r.wallet, amount: r.units })), nonce: new Date().toISOString() });
      const hits = await screenRecipients(session, { shareClass: migration.share_class_pda, wallets: rows.map((r) => r.wallet), runId });
      for (const w of hits) bad.push(`${short(w)}: held for the compliance team (screening hit); its deposits stay accepted.`);
      const nowSec = nowSeconds();
      const ok = rows.filter((r) => {
        if (hits.has(r.wallet)) return false;
        const verdict = distributionRowChecks(facts, { wallet: r.wallet as Address, amount: r.units }, { nowSec, screening: "clear" });
        if (!verdict.ok) bad.push(`${short(r.wallet)}: ${verdict.problem ?? "a check failed"}`);
        return verdict.ok;
      });
      if (ok.length === 0) throw new Error("No holder of this selection can receive units now.");
      await distributionEvidence(session, { shareClass: migration.share_class_pda, runId, wallets: ok.map((r) => r.wallet) });

      // Packed and test-run on the network; a refused row is dropped with its reason.
      const signer = walletSigner(session);
      const built = await Promise.all(ok.map((r) => rowInstructions({
        mint,
        sender: signer,
        wallet: address(r.wallet),
        amount: r.units,
        decimals: 0,
        hookConfig: facts.hookConfig,
        accountExists: facts.rows.get(r.wallet)?.recipientTokenAccountExists ?? false,
      })));
      const plan = await planWithSimulation(built, {
        feePayer: signer.address,
        simulate: async (instructions) => (await simulateInstructions(rpc, { feePayer: signer.address, instructions, network })).refusal,
      });
      for (const d of plan.dropped) bad.push(`${short(d.row)}: ${d.reason}`);
      if (plan.transactions.length === 0) throw new Error("The network would refuse every transfer of this selection; nothing was sent.");

      let recorded = 0;
      let pending = 0;
      for (const [i, packed] of plan.transactions.entries()) {
        const pendingId = toast.showPending(`Confirm delivery ${i + 1} of ${plan.transactions.length} in your wallet…`);
        let signature: string;
        try {
          signature = await tx.send({ instructions: packed.instructions, feePayer: signer });
        } catch (err) {
          toast.dismiss(pendingId);
          bad.push(`Delivery ${i + 1} not sent: ${explainSendError(err)}`);
          break;
        }
        toast.dismiss(pendingId);
        const receipt = recovery.remember(`${migration.id}:${signature}`, signature);
        try {
          if (await record(receipt)) recorded += packed.index.length;
          else pending += 1;
        } catch (err) {
          pending += 1;
          bad.push(`Delivery ${i + 1} sent, recording pending: ${errorText(err)}`);
        }
      }
      info.push(`${recorded} ${recorded === 1 ? "holder" : "holders"} delivered and recorded.${pending ? ` ${pending} transaction(s) sent and waiting to be recorded: use Retry recording.` : ""}`);
      toast.show({ kind: recorded > 0 ? "success" : "info", title: "Delivery run finished", description: info[0] });
    } catch (err) {
      bad.push(errorText(err));
    } finally {
      setNotes({ bad: [...bad], info: [...info] });
      busyRef.current = false;
      setBusy(false);
      setSelected(null);
      onRecorded();
    }
  }

  return (
    <Card title="Deliver units" aside={<span className="text-xs text-slate-500">Treasury <AddressLink address={migration.treasury_wallet} />: {treasuryUnits === undefined ? "reading…" : treasuryUnits === null ? "unreadable" : `${formatUnits(treasuryUnits)} units`}</span>}>
      <ChainRecordRecoveryPanel receipts={recovery.receipts} busy={busy || tx.isSending} onRetry={retry} states={recovery.states} />
      {due.length === 0 ? (
        <p className="text-sm text-slate-600">No accepted deposit waits for delivery.</p>
      ) : (
        <>
          <p className="text-[13px] text-slate-600">
            {due.length} {due.length === 1 ? "holder has" : "holders have"} units due ({formatUnits(due.reduce((s, h) => s + h.units, BigInt(0)))} in all). Each holder gets all of its accepted deposits at once.
            {due.length > MAX_HOLDERS_PER_RUN && ` One run delivers to at most ${MAX_HOLDERS_PER_RUN} holders.`}
          </p>
          <div className="mt-3 max-h-72 overflow-y-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500"><tr><th className="px-3 py-2">Deliver</th><th className="px-3 py-2">Holder</th><th className="px-3 py-2 text-right">Units</th><th className="px-3 py-2 text-right">Deposits</th></tr></thead>
              <tbody className="divide-y divide-slate-100">
                {due.map((h) => (
                  <tr key={h.wallet}>
                    <td className="px-3 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Deliver to ${h.wallet}`}
                        checked={chosen.has(h.wallet)}
                        onChange={(e) => {
                          const next = new Set(chosen);
                          if (e.target.checked) next.add(h.wallet);
                          else next.delete(h.wallet);
                          setSelected(next);
                        }}
                      />
                    </td>
                    <td className="px-3 py-1.5"><AddressLink address={h.wallet} /></td>
                    <td className="px-3 py-1.5 text-right font-mono">{formatUnits(h.units)}</td>
                    <td className="px-3 py-1.5 text-right">{h.deposits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={primaryButton}
              disabled={busy || tx.isSending || rows.length === 0 || rows.length > MAX_HOLDERS_PER_RUN || !isTreasury || !canDeliver}
              onClick={() => void deliver()}
            >
              {busy ? "Delivering…" : `Deliver ${formatUnits(total)} units to ${rows.length} ${rows.length === 1 ? "holder" : "holders"}`}
            </button>
            {!isTreasury && <span className="text-xs text-amber-800">Connect the treasury wallet {short(migration.treasury_wallet)} to deliver. A Squads treasury delivers through a proposal; record its transaction below.</span>}
            {!canDeliver && <span className="text-xs text-slate-600">Deliveries happen while the campaign is open or closed.</span>}
          </div>
        </>
      )}
      <Notes tone="bad" items={notes.bad} />
      <Notes tone="info" items={notes.info} />
    </Card>
  );
}

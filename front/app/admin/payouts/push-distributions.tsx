"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { address, isAddress, type Instruction } from "@solana/kit";
import {
  useSolanaClient,
  useWalletConnection,
  useSendTransaction,
} from "@solana/react-hooks";
import {
  findAssociatedTokenPda,
} from "@solana-program/token-2022";
import {
  DistributionStatus,
  findDistributionPda,
} from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findShareClassPda } from "@/lib/pdas";
import {
  loadDistributions,
  loadMintHolders,
  computeDistributionAllocation,
  parseWeightCsv,
  detectTokenProgram,
  newDistributionId,
  DISTRIBUTION_STATUS_LABEL,
  type DistributionRecord,
  type HolderWeight,
} from "@/lib/distributions";
import {
  prepareDistributionPlan,
  bindDistributionPlan,
  listDistributionPlans,
  readDistributionPlan,
  type DistributionPlanSummary,
} from "@/lib/distribution-plans-client";
import {
  assertStoredDistributionPlan,
  DISTRIBUTION_PLAN_MAX_ENTRIES,
  type PreparedDistributionPlan,
} from "@/lib/distribution-plans";
import {
  buildDistributionClose,
  buildDistributionFunding,
  buildDistributionPayment,
  readCommittedDistribution,
  isDistributionBatchPaid,
  readPaidDistributionBatches,
} from "@/lib/distribution-transactions";
import { waitForPurchasePreparation } from "@/lib/purchase-builder";
import { VESTING_COMPUTE_UNITS } from "@/lib/vesting-creation";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { ConfirmModal } from "@/components/confirm-modal";
import { detectNetwork } from "@/lib/network";
import { fetchMintTokenProgram } from "@/lib/transaction-builders";
import { explainSendError } from "@/lib/tx-error";
export type DistributionPrefill = {
  shareClassPda: string;
  totalAmount?: string;
  paymentMint?: string;
};
type ShareOption = { pda: string; label: string; mint: string };
const U64_MAX = (BigInt(1) << BigInt(64)) - BigInt(1);
const button =
  "rounded-lg border border-brand-200 bg-brand-50 px-3 py-2 text-sm font-semibold text-brand-900 disabled:opacity-50";
const input =
  "mt-1 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm";

export function PushDistributions({
  prefill,
}: {
  prefill?: DistributionPrefill | null;
}) {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    toast = useToast();
  const [options, setOptions] = useState<ShareOption[]>([]),
    [records, setRecords] = useState<DistributionRecord[]>([]),
    [loading, setLoading] = useState(true),
    [error, setError] = useState<string | null>(null),
    [saved, setSaved] = useState<DistributionPlanSummary[] | null>(null),
    [plan, setPlan] = useState<PreparedDistributionPlan | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [showCreate, setShowCreate] = useState(false),
    [restoring, setRestoring] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  useEffect(() => {
    // Drop previously authorized private recipient data when the wallet changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlan(null);
    setSaved(null);
    setSelected(null);
    setNextCursor(null);
  }, [conn.wallet?.account.address]);
  const refresh = useCallback(async () => {
    try {
      const [data, distributions] = await Promise.all([
        loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)),
        loadDistributions(client.runtime.rpc),
      ]);
      setOptions(
        await Promise.all(
          data.shareClasses
            .filter((sc) => sc.version === 2 && sc.mintInitialized)
            .map(async (sc) => ({
              pda: await findShareClassPda(sc.asset, sc.classIndex),
              label: `Class ${sc.classIndex} · ${sc.mint.slice(0, 8)}…`,
              mint: sc.mint,
            })),
        ),
      );
      setRecords(distributions);
      setError(null);
    } catch {
      setError(
        "Could not load finalized distribution accounts. Retry when RPC is available.",
      );
    } finally {
      setLoading(false);
    }
  }, [client]);
  useEffect(() => {
    // Read-only finalized chain inventory after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  useEffect(() => {
    // Open the form for an explicitly selected payout schedule.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (prefill) setShowCreate(true);
  }, [prefill]);
  async function restore(cursor?: string) {
    if (!conn.wallet) return;
    setRestoring(true);
    try {
      const response = await listDistributionPlans(
        conn.wallet,
        undefined,
        cursor,
      );
      setSaved((previous) =>
        cursor ? [...(previous ?? []), ...response.plans] : response.plans,
      );
      setNextCursor(response.next_cursor);
    } catch (error) {
      toast.showError(
        "Saved plans unavailable",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setRestoring(false);
    }
  }
  async function openPlan(id: string) {
    if (!conn.wallet) return;
    setRestoring(true);
    try {
      const p = await readDistributionPlan(conn.wallet, id);
      await assertStoredDistributionPlan(p);
      setPlan(p);
      setSelected(p.distribution_pda);
      setShowCreate(false);
    } catch (error) {
      toast.showError(
        "Could not restore the original plan",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setRestoring(false);
    }
  }
  async function openRecord(record: DistributionRecord) {
    setSelected(record.address);
    setPlan(null);
    if (!conn.wallet || record.distribution.version !== 2) return;
    setRestoring(true);
    try {
      const response = await listDistributionPlans(conn.wallet, record.address);
      if (response.plans[0]) await openPlan(response.plans[0].id);
    } catch (error) {
      toast.showError(
        "Original plan unavailable",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setRestoring(false);
    }
  }
  const currentPlan = plan?.network === detectNetwork() ? plan : null,
    record = records.find((r) => r.address === selected);
  return (
    <section
      id="push-distributions"
      className="mt-12 space-y-5 border-t-2 border-slate-200 pt-8"
    >
      <div>
        <h2 className="text-lg font-semibold text-slate-900">
          Push distributions
        </h2>
        <p className="mt-2 text-sm text-slate-600">
          Review and save recipients before funding. Resume uses the original
          committed batches and their on-chain receipts.
        </p>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          disabled={!conn.wallet || !options.length}
          className={button}
        >
          Prepare a new distribution
        </button>
        <button
          type="button"
          disabled={!conn.wallet || restoring}
          onClick={() => void restore()}
          className={button}
        >
          {restoring ? "Restoring…" : "Restore saved plans"}
        </button>
        <button
          type="button"
          onClick={() => void refresh()}
          className="text-sm text-slate-500 underline"
        >
          Refresh chain state
        </button>
      </div>
      <p className="text-xs text-slate-500">
        After a refresh or interrupted funding, restore the saved plan first. It
        reuses the same distribution address. Recording an existing funded plan
        never sends funds again.
      </p>
      {saved && (
        <div className="rounded-xl border border-brand-200 bg-brand-50 p-4">
          <h3 className="text-sm font-semibold">Saved plans</h3>
          {!saved.length ? (
            <p className="mt-2 text-xs">No saved plans were found.</p>
          ) : (
            <div className="mt-3 space-y-2">
              {saved.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => void openPlan(p.id)}
                  disabled={restoring}
                  className="block w-full rounded-lg bg-white p-3 text-left text-xs"
                >
                  <span className="font-semibold">
                    #{p.distribution_id} · {p.total_amount} base units ·{" "}
                    {p.entry_count} recipients
                  </span>
                  <span className="ml-2">
                    {p.status === "bound"
                      ? "Bound to finalized chain"
                      : "Prepared — check funding state"}
                  </span>
                  <span className="mt-1 block break-all font-mono text-slate-500">
                    {p.distribution_pda}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {nextCursor && (
        <button
          type="button"
          disabled={restoring}
          onClick={() => void restore(nextCursor)}
          className={button}
        >
          Load more saved plans
        </button>
      )}
      {showCreate && (
        <CreateDistributionCard
          options={options}
          initial={prefill ?? undefined}
          onPrepared={(p) => {
            setPlan(p);
            setSelected(p.distribution_pda);
            setShowCreate(false);
            setSaved((items) => [
              p,
              ...(items ?? []).filter((i) => i.id !== p.id),
            ]);
          }}
          onClose={() => setShowCreate(false)}
        />
      )}
      {error && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
          {error}
        </p>
      )}
      {loading ? (
        <p className="text-sm text-slate-500">Loading distributions…</p>
      ) : records.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50">
              <tr>
                {[
                  "Distribution",
                  "Funded",
                  "Paid",
                  "Recipients paid",
                  "Status",
                ].map((label) => (
                  <th key={label} className="px-4 py-3">
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={r.address} className="border-t border-slate-100">
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => void openRecord(r)}
                      className="font-semibold text-brand-800 underline"
                    >
                      #{String(r.distribution.distributionId)}
                    </button>
                  </td>
                  <td className="px-4 py-3">
                    {String(r.distribution.totalAmount)}
                  </td>
                  <td className="px-4 py-3">
                    {String(r.distribution.distributedAmount)}
                  </td>
                  <td className="px-4 py-3">{r.distribution.paidCount}</td>
                  <td className="px-4 py-3">
                    {DISTRIBUTION_STATUS_LABEL[r.distribution.status]}
                    {r.distribution.version < 2 ? " · legacy" : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-500">No funded distributions found.</p>
      )}
      {currentPlan && (
        <PreparedDistributionCard
          key={currentPlan.id}
          plan={currentPlan}
          onUpdate={(p) => setPlan(p)}
          onRefresh={refresh}
        />
      )}
      {record && !currentPlan && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          {record.distribution.version < 2
            ? "Legacy distribution: batch execution is disabled. Its original recipient plan cannot be reconstructed from current holders. Review it and close/refund if appropriate."
            : "Restore this distribution's original saved plan to resume. A live holder scan cannot substitute for the funded commitment."}
        </div>
      )}
      {record && <DistributionClose record={record} onRefresh={refresh} />}
    </section>
  );
}

function CreateDistributionCard({
  options,
  initial,
  onPrepared,
  onClose,
}: {
  options: ShareOption[];
  initial?: DistributionPrefill;
  onPrepared: (plan: PreparedDistributionPlan) => void;
  onClose: () => void;
}) {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    toast = useToast();
  const [share, setShare] = useState(
      initial?.shareClassPda ?? options[0]?.pda ?? "",
    ),
    [mint, setMint] = useState(initial?.paymentMint ?? ""),
    [amount, setAmount] = useState(initial?.totalAmount ?? ""),
    [csv, setCsv] = useState(""),
    [rows, setRows] = useState<HolderWeight[] | null>(null),
    [source, setSource] = useState(""),
    [excluded, setExcluded] = useState(0),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const lock = useRef(false),
    selected = options.find((o) => o.pda === share),
    validAmount = /^[1-9]\d*$/.test(amount) && BigInt(amount) <= U64_MAX;
  const preview = useMemo(
    () =>
      rows && validAmount
        ? computeDistributionAllocation(rows, BigInt(amount))
        : null,
    [rows, validAmount, amount],
  );
  async function scan() {
    if (!selected) return;
    setBusy(true);
    try {
      const scan = await loadMintHolders(
        client.runtime.rpc,
        address(selected.mint),
      );
      setRows(scan.holders);
      setSource("Finalized holder snapshot");
      setExcluded(scan.excluded.length);
    } catch (error) {
      toast.showError(
        "Holder snapshot unavailable",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setBusy(false);
    }
  }
  function parseCsv() {
    const parsed = parseWeightCsv(csv);
    if (parsed.errors.length || !parsed.rows.length) {
      toast.showError(
        "Invalid integer-weight CSV",
        parsed.errors.slice(0, 3).join(" · ") || "No recipients",
      );
      return;
    }
    setRows(parsed.rows);
    setSource("Reviewed CSV snapshot");
    setExcluded(0);
  }
  async function prepare() {
    if (
      !conn.wallet ||
      !selected ||
      !preview ||
      !isAddress(mint.trim()) ||
      lock.current
    )
      return;
    lock.current = true;
    setBusy(true);
    try {
      const paymentMint = address(mint.trim()),
        program = await detectTokenProgram(client.runtime.rpc, paymentMint),
        id = newDistributionId(),
        [distribution] = await findDistributionPda({
          shareClass: address(share),
          distributionId: id,
        });
      const entries = await Promise.all(
        preview.eligible.map(async (row) => {
          const [ata] = await findAssociatedTokenPda({
            owner: address(row.wallet),
            mint: paymentMint,
            tokenProgram: program,
          });
          return {
            token_account: ata,
            token_owner: row.wallet,
            amount: String(row.amount),
          };
        }),
      );
      const plan = await prepareDistributionPlan(
        conn.wallet,
        {
          distribution_pda: distribution,
          distribution_id: String(id),
          share_class: share,
          payment_mint: paymentMint,
          payment_token_program: program,
          funder: conn.wallet.account.address,
          total_amount: amount,
          snapshot_supply: String(preview.totalWeight),
        },
        entries,
      );
      await assertStoredDistributionPlan(plan);
      onPrepared(plan);
      toast.show({
        kind: "success",
        title: "Recipient plan saved; escrow is not funded yet",
      });
    } catch (error) {
      toast.showError(
        "Plan preparation not completed",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      setBusy(false);
      lock.current = false;
      setConfirm(false);
    }
  }
  return (
    <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex justify-between">
        <h3 className="font-semibold">Prepare recipients before funding</h3>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-500 underline"
        >
          Close
        </button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs sm:col-span-2">
          Share class
          <select
            className={input}
            value={share}
            onChange={(e) => {
              setShare(e.target.value);
              setRows(null);
            }}
          >
            {options.map((o) => (
              <option key={o.pda} value={o.pda}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs">
          Payment mint
          <input
            className={input}
            value={mint}
            onChange={(e) => setMint(e.target.value)}
          />
        </label>
        <label className="text-xs">
          Funding amount (integer base units)
          <input
            className={input}
            value={amount}
            inputMode="numeric"
            onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
          />
        </label>
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void scan()}
          disabled={busy || !selected}
          className={button}
        >
          Capture current wallet holders
        </button>
        <span className="self-center text-xs text-slate-500">
          Program escrow owners are excluded and disclosed below.
        </span>
      </div>
      <label className="block text-xs">
        Or import reviewed integer weights (wallet,weight)
        <textarea
          className={`${input} font-mono text-xs`}
          rows={4}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder="wallet,weight"
        />
      </label>
      <button
        type="button"
        onClick={parseCsv}
        disabled={busy || !csv.trim()}
        className={button}
      >
        Review CSV recipients
      </button>
      {preview && (
        <div className="space-y-2 rounded-lg bg-brand-50 p-4 text-xs">
          <p className="font-semibold">
            {source}: {preview.eligible.length} recipients ·{" "}
            {String(preview.allocated)} base units allocated
          </p>
          <p>
            {preview.skipped.length} zero-rounded recipients excluded.{" "}
            {excluded} program-owned holders excluded. Unallocated:{" "}
            {String(BigInt(amount) - preview.allocated)} base units.
          </p>
          <p>
            Snapshot weight: {String(preview.totalWeight)}. Maximum{" "}
            {DISTRIBUTION_PLAN_MAX_ENTRIES} recipients. The saved plan fixes
            their payment ATAs and amounts.
          </p>
          <div className="max-h-48 overflow-auto">
            <table className="w-full text-left">
              <tbody>
                {preview.eligible.map((row) => (
                  <tr key={row.wallet}>
                    <td className="break-all py-1 font-mono">{row.wallet}</td>
                    <td className="pl-3 text-right">{String(row.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <button
        type="button"
        onClick={() => setConfirm(true)}
        disabled={
          busy ||
          !conn.wallet ||
          !isAddress(mint.trim()) ||
          !preview?.eligible.length ||
          preview.eligible.length > DISTRIBUTION_PLAN_MAX_ENTRIES
        }
        className={button}
      >
        {busy ? "Preparing…" : "Save reviewed recipient plan"}
      </button>
      <ConfirmModal
        open={confirm}
        title="Save this immutable distribution plan?"
        description={`${preview?.eligible.length ?? 0} recipients, ${preview?.allocated ?? 0} allocated base units, ${amount} total funding. The plan is saved before any payment is sent; changing recipients later requires a separate new distribution.`}
        kind="warning"
        requireReason={false}
        confirmLabel="Save plan"
        busy={busy}
        onConfirm={() => void prepare()}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}

function PreparedDistributionCard({
  plan,
  onUpdate,
  onRefresh,
}: {
  plan: PreparedDistributionPlan;
  onUpdate: (plan: PreparedDistributionPlan) => void;
  onRefresh: () => Promise<void>;
}) {
  const client = useSolanaClient(),
    conn = useWalletConnection(),
    tx = useSendTransaction(),
    toast = useToast(),
    wallet = conn.wallet?.account.address;
  const [paid, setPaid] = useState<number[] | null>(null),
    [funded, setFunded] = useState<boolean | null>(null),
    [error, setError] = useState<string | null>(null),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState<"fund" | "execute" | null>(null);
  const lock = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const chain = await readCommittedDistribution(client.runtime.rpc, plan);
      setFunded(!!chain);
      if (chain) {
        setPaid(await readPaidDistributionBatches(client.runtime.rpc, plan));
      } else setPaid([]);
      setError(null);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not verify committed state",
      );
    }
  }, [client, plan]);
  useEffect(() => {
    // Read immutable plan and finalized receipt state after hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);
  async function send(instructions: readonly Instruction[]) {
    if (!conn.wallet) throw new Error("Connect a wallet");
    return tx.send({
      instructions,
      feePayer: walletSigner(conn.wallet),
      version: 0,
      computeUnitLimit: VESTING_COMPUTE_UNITS,
      prepareTransaction: false,
    });
  }
  async function bindOnly() {
    if (!conn.wallet || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      onUpdate(await bindDistributionPlan(conn.wallet, plan.id));
      toast.show({ kind: "success", title: "Existing funded plan recorded" });
      await refresh();
      await onRefresh();
    } catch (error) {
      toast.showError(
        "Record remains pending; do not fund again",
        error instanceof Error ? error.message : undefined,
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function fund() {
    if (!conn.wallet || wallet !== plan.funder || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const existing = await readCommittedDistribution(
        client.runtime.rpc,
        plan,
      );
      if (!existing) {
        const ix = await buildDistributionFunding(
            client.runtime.rpc,
            plan,
            walletSigner(conn.wallet),
          ),
          sig = await send([ix]);
        toast.showTx(sig, {
          title: "Distribution funding submitted",
          description:
            "The saved address is retained. Record the existing funded plan after finalization.",
        });
      }
      try {
        onUpdate(await bindDistributionPlan(conn.wallet, plan.id));
      } catch {
        toast.show({
          kind: "info",
          title: "Funding record awaits finalization",
          description:
            "Use Record existing funded plan. This action never sends the payment again.",
        });
      }
      await refresh();
      await onRefresh();
      setConfirm(null);
    } catch (error) {
      toast.showError(
        "Funding not completed; check the saved address before retrying",
        explainSendError(error),
      );
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  async function execute() {
    if (!conn.wallet || lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const bound = await bindDistributionPlan(conn.wallet, plan.id);
      await assertStoredDistributionPlan(bound);
      onUpdate(bound);
      const signer = walletSigner(conn.wallet);
      for (const batch of bound.batches) {
        if (await isDistributionBatchPaid(client.runtime.rpc, bound, batch))
          continue;
        const built = await buildDistributionPayment(
          client.runtime.rpc,
          bound,
          batch,
          signer,
        );
        for (const preparation of built.preparation) {
          const sig = await send(preparation);
          await waitForPurchasePreparation(client.runtime.rpc, sig);
        }
        const sig = await send(built.payment);
        toast.showTx(sig, {
          title: `Batch ${batch.batch_id + 1}/${bound.batch_count} submitted`,
          description:
            "An identical retry is protected by the on-chain receipt.",
        });
      }
      setConfirm(null);
      await refresh();
      await onRefresh();
      toast.show({
        kind: "success",
        title: "Committed batches submitted; refresh finalized receipts",
      });
    } catch (error) {
      toast.showError(
        "Batch execution paused",
        explainSendError(error),
      );
    } finally {
      setBusy(false);
      lock.current = false;
    }
  }
  const remaining = plan.batches.filter(
    (batch) => !paid?.includes(batch.batch_id),
  );
  return (
    <div className="space-y-3 rounded-xl border border-brand-200 bg-white p-5">
      <h3 className="font-semibold">
        Saved distribution #{plan.distribution_id}
      </h3>
      <p className="break-all font-mono text-xs text-slate-500">
        {plan.distribution_pda}
      </p>
      <p className="text-sm">
        {plan.total_amount} funding · {plan.allocated_amount} allocated base
        units · {plan.entry_count} recipients · {plan.batch_count} committed
        batches
      </p>
      <p className="break-all font-mono text-xs text-slate-500">
        Root: {plan.root_hex}
      </p>
      <p className="text-xs text-slate-600">
        {funded === null
          ? "Checking funding…"
          : funded
            ? "Funded account verified"
            : "No finalized funded account found"}{" "}
        ·{" "}
        {paid === null
          ? "Checking receipts…"
          : `${paid.length}/${plan.batch_count} finalized receipts`}{" "}
        · database {plan.status}
      </p>
      {error && (
        <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
          {error}
        </p>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer font-semibold text-brand-800">
          Review the saved recipient amounts
        </summary>
        <div className="mt-2 max-h-64 overflow-auto">
          {plan.batches.map((batch) => (
            <div key={batch.batch_id} className="mb-3">
              <p className="font-semibold">
                Batch {batch.batch_id + 1}{" "}
                {paid?.includes(batch.batch_id) ? "· paid" : ""}
              </p>
              {batch.entries.map((entry) => (
                <p key={entry.token_account} className="break-all font-mono">
                  {entry.token_owner}: {entry.amount}
                </p>
              ))}
            </div>
          ))}
        </div>
      </details>
      <div className="flex flex-wrap gap-3">
        {wallet === plan.funder && !funded && (
          <button
            type="button"
            disabled={busy || funded === null || !!error}
            onClick={() => setConfirm("fund")}
            className={button}
          >
            Check and fund this saved plan
          </button>
        )}
        <button
          type="button"
          disabled={busy || !conn.wallet}
          onClick={() => void bindOnly()}
          className={button}
        >
          Record existing funded plan
        </button>
        {funded && (
          <button
            type="button"
            disabled={busy || paid === null || !remaining.length || !!error}
            onClick={() => setConfirm("execute")}
            className={button}
          >
            Resume unpaid committed batches ({remaining.length})
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => void refresh()}
          className="text-xs text-slate-500 underline"
        >
          Refresh receipts
        </button>
      </div>
      <p className="text-xs text-slate-500">
        Recipient account preparation may request a separate transaction so each
        payment fits the wallet limit. Batch identity and amounts always remain
        unchanged. The paid-count display is informational and is never used to
        select recipients.
      </p>
      <ConfirmModal
        open={confirm !== null}
        title={
          confirm === "fund"
            ? "Fund the reviewed distribution?"
            : "Execute the saved unpaid batches?"
        }
        description={
          confirm === "fund"
            ? `Debit ${plan.total_amount} base units of ${plan.payment_mint} from funder ${plan.funder}. All ${plan.entry_count} recipients are fixed by root ${plan.root_hex}. If the account already exists, only its database record is completed.`
            : `Execute up to ${remaining.length} batches from the saved plan. Each existing valid receipt is skipped; an exact retry cannot pay the batch twice.`
        }
        kind="warning"
        requireReason={false}
        confirmLabel={
          confirm === "fund" ? "Check and fund" : "Execute committed batches"
        }
        busy={busy}
        onConfirm={() => void (confirm === "fund" ? fund() : execute())}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

function DistributionClose({
  record,
  onRefresh,
}: {
  record: DistributionRecord;
  onRefresh: () => Promise<void>;
}) {
  const conn = useWalletConnection(),
    client = useSolanaClient(),
    tx = useSendTransaction(),
    toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const d = record.distribution;
  async function close() {
    if (!conn.wallet) return;
    try {
      const signer = walletSigner(conn.wallet),
        tokenProgram = await fetchMintTokenProgram(
          client.runtime.rpc,
          d.paymentMint,
          { commitment: "finalized" },
        );
      // 2D: remainder to the funder, all rent (escrow + marker) to d.admin.
      const instructions = await buildDistributionClose({
        authority: signer,
        distribution: record.address,
        data: d,
        tokenProgram,
      });
      const sig = await tx.send({
        instructions,
        feePayer: signer,
      });
      toast.showTx(sig, { title: "Distribution close submitted" });
      setConfirm(false);
      await onRefresh();
    } catch (error) {
      toast.showError(
        "Close/refund failed",
        explainSendError(error),
      );
    }
  }
  if (d.status === DistributionStatus.Closed) return null;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4">
      <button
        type="button"
        onClick={() => setConfirm(true)}
        disabled={tx.isSending}
        className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900"
      >
        Close distribution and refund the funder
      </button>
      <ConfirmModal
        open={confirm}
        title="Close and refund this distribution?"
        description={`No further unpaid batches can execute. The remaining balance is returned only to the original funder ${d.funder}; the escrow and marker rent go to the creating Admin ${d.admin}. Review unfinished recipients first.`}
        kind="destructive"
        requireReason={false}
        confirmLabel="Close and refund"
        busy={tx.isSending}
        onConfirm={() => void close()}
        onClose={() => setConfirm(false)}
      />
    </div>
  );
}

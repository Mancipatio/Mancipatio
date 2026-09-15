"use client";

import { WalletRequired } from "@/components/wallet-required";

// Issuer — Vesting series (spec: "11. Vesting — Manci"). The full
// self-serve flow: fill the form → team review → create the on-chain series
// (your wallet is the authority) → deposit → approve tranches / recover /
// cancel. One series = one token + one schedule.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { address, signature as toSignature } from "@solana/kit";
import {
  fetchMaybeVestingSeries,
  fetchAllMaybeVestingPosition,
  findPositionPda,
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  VestingSeriesStatus,
} from "@/lib/generated/asset_registry";
import {
  assertVestingSeriesTerms,
  assertVestingPosition,
  buildVestingCreationSteps,
  VESTING_COMPUTE_UNITS,
} from "@/lib/vesting-creation";
import {
  hashVestingTerms,
  assertVestingCreationOpen,
} from "@/lib/vesting-terms";
import { assertChainRecordStorageAvailable } from "@/lib/chain-record-recovery";
import {
  readVestingStepReceipts,
  saveVestingStepReceipt,
  clearVestingStepReceipt,
} from "@/lib/vesting-creation-recovery";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { SkeletonTable } from "@/components/skeleton";
import { Kpi } from "@/components/kpi";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { walletSigner } from "@/lib/wallet-signer";
import { fetchVestingMintTokenProgram } from "@/lib/transaction-builders";
import {
  prepareVestingCreation,
  recordVestingCreationStep,
  fetchVestingCreationState,
  createVestingSeriesRequest,
  listMyVestingSeries,
  markVestingSeriesCreated,
  resubmitVestingSeries,
  type CreateVestingSeriesInput,
  type VestingSeriesRow,
} from "@/lib/vesting-series";
import { EMPTY_FORM, SeriesForm, type SeriesFormValues } from "./series-form";
import { SeriesPanel } from "./series-panel";

const STATUS_LABEL: Record<VestingSeriesRow["status"], string> = {
  submitted: "In review",
  needs_changes: "Needs changes",
  approved: "Approved — create on-chain",
  rejected: "Rejected",
  created: "Finalized on-chain — check funding",
  cancelled: "Cancelled",
};

const STATUS_BADGE: Record<VestingSeriesRow["status"], string> = {
  submitted: "bg-amber-100 text-amber-800 border-amber-200",
  needs_changes: "bg-orange-100 text-orange-800 border-orange-200",
  approved: "bg-emerald-100 text-emerald-800 border-emerald-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  created: "bg-brand-100 text-brand-800 border-brand-200",
  cancelled: "bg-slate-200 text-slate-600 border-slate-300",
};

export default function IssuerVestingSeriesPage() {
  const client = useSolanaClient();
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();

  const [rows, setRows] = useState<VestingSeriesRow[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editRow, setEditRow] = useState<VestingSeriesRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [creationBusy, setCreationBusy] = useState<string | null>(null);
  const [creationProgress, setCreationProgress] = useState("");
  const [lastCreationSignature, setLastCreationSignature] = useState<
    string | null
  >(null);
  const [reconcileSignature, setReconcileSignature] = useState("");
  const creationLock = useRef(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!conn.wallet) return;
    try {
      const data = await listMyVestingSeries(conn.wallet);
      setRows(data);
      setListError(null);
    } catch (err) {
      setListError(
        err instanceof Error ? err.message : "Could not load your series",
      );
    }
  }, [conn.wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  function formValuesOf(row: VestingSeriesRow): SeriesFormValues {
    return {
      ...EMPTY_FORM,
      tokenMint: row.token_mint,
      tokenLabel: row.token_label,
      timingMode: row.timing_mode,
      deliveryMode: row.delivery_mode,
      approvalWindowSecs: row.approval_window_secs,
      recoveryEnabled: row.recovery_enabled,
      cancellationEnabled: row.cancellation_enabled,
      preCliffBps: row.pre_cliff_bps,
      schedule: row.schedule,
      recipients: row.recipients,
    };
  }

  async function submitForm(input: CreateVestingSeriesInput) {
    if (!conn.wallet) return;
    setSubmitting(true);
    try {
      if (editRow) {
        await resubmitVestingSeries(conn.wallet, editRow.id, input);
        toast.show({ kind: "success", title: "Series resubmitted for review" });
      } else {
        await createVestingSeriesRequest(conn.wallet, input);
        toast.show({ kind: "success", title: "Series submitted for review" });
      }
      setShowForm(false);
      setEditRow(null);
      await refresh();
    } catch (err) {
      toast.showError(
        "Submit failed",
        err instanceof Error ? err.message : undefined,
      );
    } finally {
      setSubmitting(false);
    }
  }

  /** Resume the persisted PDA. Atomic position seeds make retries safe even if a wallet response was lost. */
  async function createOnChain(input: VestingSeriesRow) {
    if (!conn.wallet || creationLock.current) return;
    creationLock.current = true;
    setCreationBusy(input.id);
    setCreationProgress(
      "Preparing the reviewed terms and persistent series address…",
    );
    const session = conn.wallet;
    const signer = walletSigner(session);
    let row = input;
    try {
      if (
        row.network !== detectNetwork() ||
        row.client_wallet !== signer.address
      )
        throw new Error(
          "Connect the approved authority on the request's network.",
        );
      if (
        !row.approved_terms_hash ||
        (await hashVestingTerms(row)) !== row.approved_terms_hash
      )
        throw new Error("The request needs a fresh review before creation.");
      assertChainRecordStorageAvailable();
      row = await prepareVestingCreation(session, row);
      setRows(
        (current) => current?.map((r) => (r.id === row.id ? row : r)) ?? [row],
      );
      const rpc = client.runtime.rpc;
      const tokenProgram = await fetchVestingMintTokenProgram(
        rpc,
        address(row.token_mint),
      );
      async function waitFinalized(
        signature: string,
        lastValidBlockHeight?: string,
      ) {
        const until = Date.now() + 65_000;
        while (Date.now() < until) {
          const result = await rpc
            .getSignatureStatuses([toSignature(signature)], {
              searchTransactionHistory: true,
            })
            .send({ abortSignal: AbortSignal.timeout(10_000) });
          const status = result.value[0];
          if (status?.err) {
            clearVestingStepReceipt(row, signature);
            throw new Error(
              "This transaction failed on-chain. Resume to retry its missing step on the same prepared series.",
            );
          }
          if (
            !status &&
            lastValidBlockHeight &&
            (await rpc.getBlockHeight({ commitment: "finalized" }).send()) >
              BigInt(lastValidBlockHeight)
          ) {
            clearVestingStepReceipt(row, signature);
            throw new Error(
              "The unconfirmed transaction expired. Resume to retry its missing step on the same prepared series.",
            );
          }
          if (status?.confirmationStatus === "finalized") return;
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        throw new Error(
          "Finalization is still pending. The signature is saved; use Resume to record and continue the same series.",
        );
      }
      async function record(
        step: string,
        signature: string,
        lastValidBlockHeight?: string,
      ) {
        setLastCreationSignature(signature);
        setCreationProgress(
          `Waiting for ${step} to finalize, then recording its receipt…`,
        );
        await waitFinalized(signature, lastValidBlockHeight);
        await recordVestingCreationStep(session, row.id, step, signature);
        // Keep finalization in storage until the full approved-state comparison is recorded.
        if (step !== "finalize") clearVestingStepReceipt(row, signature);
      }
      for (const receipt of readVestingStepReceipts(row).filter(
        (receipt) => receipt.step !== "cancel" && receipt.step !== "deposit",
      )) {
        const status = (
          await rpc
            .getSignatureStatuses([toSignature(receipt.signature)], {
              searchTransactionHistory: true,
            })
            .send()
        ).value[0];
        if (status?.err) {
          clearVestingStepReceipt(row, receipt.signature);
          continue;
        }
        await record(
          receipt.step,
          receipt.signature,
          receipt.lastValidBlockHeight,
        );
      }
      // Reload finalized state at every boundary; no counter or PDA is guessed from the UI.
      for (let attempt = 0; attempt < 205; attempt++) {
        const account = await fetchMaybeVestingSeries(
          rpc,
          address(row.series_pda!),
          { commitment: "finalized", abortSignal: AbortSignal.timeout(12_000) },
        );
        const existing = account.exists ? account.data : null;
        if (account.exists) {
          if (account.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS)
            throw new Error("Unexpected series account owner");
          assertVestingSeriesTerms(
            row,
            account.data,
            account.data.status === VestingSeriesStatus.Active,
          );
          const pdas = await Promise.all(
            Array.from({ length: account.data.positionsCount }, (_, index) =>
              findPositionPda({
                series: address(row.series_pda!),
                positionIndex: index,
              }).then(([pda]) => pda),
            ),
          );
          for (let start = 0; start < pdas.length; start += 100) {
            const positions = await fetchAllMaybeVestingPosition(
              rpc,
              pdas.slice(start, start + 100),
              { commitment: "finalized" },
            );
            positions.forEach((position, index) => {
              if (
                !position.exists ||
                position.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS
              )
                throw new Error("An existing approved position is missing");
              assertVestingPosition(row, position.data, start + index);
            });
          }
        }
        if (existing?.status === VestingSeriesStatus.Active) {
          const local = readVestingStepReceipts(row).find(
            (r) => r.step === "finalize",
          );
          const state = await fetchVestingCreationState(session, row.id);
          const signature =
            local?.signature ??
            state.receipts.find(
              (r) => r.step_key === "finalize" && r.state !== "failed",
            )?.signature ??
            reconcileSignature.trim();
          if (!signature)
            throw new Error(
              "The series is finalized. Paste its finalization transaction signature below and Resume to record it; no new series will be created.",
            );
          await markVestingSeriesCreated(
            session,
            row.id,
            row.series_id!,
            row.series_pda!,
            row.escrow!,
            signature,
          );
          clearVestingStepReceipt(row, signature);
          toast.showTx(signature, {
            title: "Series finalized and recorded — fund it before releases",
          });
          setExpanded(row.id);
          setReconcileSignature("");
          await refresh();
          return;
        }
        assertVestingCreationOpen(row);
        const [step] = await buildVestingCreationSteps(
          row,
          tokenProgram,
          signer,
          existing,
        );
        if (!step) throw new Error("No valid creation step is available");
        setCreationProgress(
          step.kind === "positions"
            ? `Adding approved positions ${step.from + 1}–${step.to} of ${row.recipients.length} (${step.bytes} bytes)…`
            : `${step.kind === "create" ? "Creating Draft" : "Finalizing and locking allocations"} (${step.bytes} bytes)…`,
        );
        assertChainRecordStorageAvailable();
        const lifetime = (
          await rpc.getLatestBlockhash({ commitment: "confirmed" }).send()
        ).value;
        const signature = await tx.send({
          lifetime,
          instructions: step.instructions,
          feePayer: signer,
          version: 0,
          computeUnitLimit: VESTING_COMPUTE_UNITS,
          computeUnitPrice: BigInt(0),
          prepareTransaction: false,
        });
        setLastCreationSignature(signature);
        saveVestingStepReceipt(row, {
          step: step.key,
          signature,
          lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
        });
        await record(
          step.key,
          signature,
          lifetime.lastValidBlockHeight.toString(),
        );
      }
      throw new Error(
        "Creation progress limit reached; reload the same prepared series.",
      );
    } catch (err) {
      toast.showError(
        "Creation paused — resume this request",
        explainSendError(err),
      );
      void refresh();
    } finally {
      creationLock.current = false;
      setCreationBusy(null);
      setCreationProgress("");
    }
  }

  if (!conn.wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  const counts = rows
    ? {
        total: rows.length,
        live: rows.filter((r) => r.status === "created").length,
        inReview: rows.filter(
          (r) => r.status === "submitted" || r.status === "needs_changes",
        ).length,
      }
    : null;

  return (
    <main className="min-w-0 flex-1">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
            Vesting
          </p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">
            Vesting series
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-600">
            Lock your tokens into a contract that releases them to recipients on
            your schedule. One series = one token + one schedule; for another
            token or schedule, create a new series. Positions are
            non-transferable — for transferable vesting rights, ask the
            Manci team about the Rights Token.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setEditRow(null);
            setShowForm(true);
          }}
          className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + New vesting series
        </button>
      </div>

      {counts && (
        <section className="mt-6 grid gap-3 sm:grid-cols-3">
          <Kpi label="Total series" value={String(counts.total)} />
          <Kpi label="Live on-chain" value={String(counts.live)} />
          <Kpi
            label="In review"
            value={String(counts.inReview)}
            tone={counts.inReview > 0 ? "warn" : "default"}
          />
        </section>
      )}

      {creationProgress && (
        <p
          role="status"
          className="mt-5 rounded-lg border border-brand-200 bg-brand-50 p-3 text-sm text-brand-800"
        >
          {creationProgress}
        </p>
      )}
      {lastCreationSignature && (
        <p className="mt-2 break-all text-xs text-slate-600">
          Last submitted receipt:{" "}
          <a
            href={explorerTxUrl(lastCreationSignature, detectNetwork())}
            target="_blank"
            rel="noreferrer"
            className="font-mono underline"
          >
            {lastCreationSignature}
          </a>
        </p>
      )}
      <div className="mt-6">
        {rows === null && !listError ? (
          <SkeletonTable rows={3} cols={5} />
        ) : listError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {listError}
          </p>
        ) : rows!.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <p className="text-sm font-medium text-slate-900">
              No vesting series yet
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Submit your first series — the team reviews it, then you create
              the contract from here and fund it.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {rows!.map((row) => (
              <div
                key={row.id}
                className="rounded-xl border border-slate-200 bg-white p-4 shadow-card"
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold text-slate-900">
                      {row.token_label || "Vesting series"}
                    </p>
                    <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                      mint {row.token_mint.slice(0, 6)}…
                      {row.token_mint.slice(-4)} · {row.recipients.length}{" "}
                      recipients · {row.schedule.length} tranches ·{" "}
                      {row.timing_mode}/{row.delivery_mode}
                      {row.recovery_enabled ? " · recovery" : ""}
                      {row.cancellation_enabled ? " · cancellable" : ""}
                    </p>
                    {(row.status === "needs_changes" ||
                      row.status === "rejected") &&
                      row.review_reason && (
                        <p className="mt-1 text-xs text-orange-700">
                          Team: {row.review_reason}
                        </p>
                      )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_BADGE[row.status]}`}
                    >
                      {STATUS_LABEL[row.status]}
                    </span>
                    {row.status === "needs_changes" && (
                      <button
                        type="button"
                        onClick={() => {
                          setEditRow(row);
                          setShowForm(true);
                        }}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400"
                      >
                        Fix & resubmit
                      </button>
                    )}
                    {row.status === "approved" && (
                      <button
                        type="button"
                        disabled={
                          tx.isSending ||
                          creationBusy !== null ||
                          !row.approved_terms_hash
                        }
                        onClick={() => void createOnChain(row)}
                        className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                      >
                        {row.creation_prepared_at
                          ? "Resume creation / record"
                          : "Create on-chain"}
                      </button>
                    )}
                    {(row.status === "created" ||
                      row.status === "cancelled" ||
                      !!row.creation_prepared_at) && (
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((e) => (e === row.id ? null : row.id))
                        }
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400"
                      >
                        {expanded === row.id ? "Hide" : "Manage"}
                      </button>
                    )}
                  </div>
                </div>
                {row.status === "approved" && row.creation_prepared_at && (
                  <p className="mt-3 text-xs text-slate-600">
                    Creation uses the same prepared series after refresh.
                    Finalization locks every allocation; funding is a separate
                    step. If the finalization receipt was lost, paste it here to
                    record the existing series:
                    <input
                      value={reconcileSignature}
                      onChange={(e) => setReconcileSignature(e.target.value)}
                      placeholder="Finalization transaction signature (only for recovery)"
                      className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
                    />
                  </p>
                )}
                {row.status === "approved" && !row.approved_terms_hash && (
                  <p className="mt-2 text-xs text-amber-800">
                    This earlier approval needs a fresh review before creation.
                  </p>
                )}
                {(row.status === "created" ||
                  row.status === "cancelled" ||
                  !!row.creation_prepared_at) &&
                  expanded === row.id && (
                    <SeriesPanel row={row} onChanged={() => void refresh()} />
                  )}
              </div>
            ))}
          </div>
        )}
      </div>

      {showForm && (
        <SeriesForm
          title={
            editRow ? "Fix & resubmit vesting series" : "New vesting series"
          }
          initial={editRow ? formValuesOf(editRow) : undefined}
          submitting={submitting}
          onSubmit={submitForm}
          onClose={() => {
            setShowForm(false);
            setEditRow(null);
          }}
        />
      )}
    </main>
  );
}

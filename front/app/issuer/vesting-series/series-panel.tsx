"use client";

// On-chain management panel for a created vesting series: funding (deposit),
// tranche approvals (Approval mode), position recovery, cancellation +
// unvested withdrawal. Every action signs with the CLIENT wallet — the
// on-chain authority (Manci holds no key).

import { useCallback, useEffect, useState } from "react";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { address, signature as toSignature, type Address } from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import { findAssociatedTokenPda as findClassicAtaPda } from "@solana-program/token";
import {
  getApproveVestingTrancheInstruction,
  getCancelVestingSeriesInstruction,
  getDepositToVestingEscrowInstruction,
  findPlatformPda,
  getDisableVestingCancellationInstruction,
  getRecoverVestingPositionInstructionAsync,
  getWithdrawUnvestedInstruction,
  getWithdrawVestingSurplusInstruction,
  findCreateVestingSeriesIdentityPda,
  VestingSeriesStatus,
  VestingTimingMode,
} from "@/lib/generated/asset_registry";
import { assertChainRecordStorageAvailable } from "@/lib/chain-record-recovery";
import {
  readVestingStepReceipts,
  saveVestingStepReceipt,
  clearVestingStepReceipt,
} from "@/lib/vesting-creation-recovery";
import { loadVestingEscrow } from "@/lib/vesting-escrow";
import { fetchVestingMintTokenProgram } from "@/lib/transaction-builders";
import {
  fetchMintDecimals,
  formatTokenAmount,
  formatUtcAndLocal,
  groupDigits,
  parseBaseUnits,
} from "@/lib/vesting-amounts";
import { hookTransferMetas, mintHasManciHook } from "@/lib/hook-metas";
import { detectNetwork, explorerTxUrl } from "@/lib/network";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { useToast } from "@/lib/toast";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import {
  fetchSeriesByPda,
  loadPositionsForSeries,
  loadSeriesByPda,
  markVestingSeriesCancelled,
  positionEntitlement,
  vestingDeliverableCumulative,
  type LoadedPosition,
  type VestingSeries,
  type VestingSeriesRow,
} from "@/lib/vesting-series";

const TOKEN_CLASSIC = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

function fmtTs(ts: number | bigint): string {
  return formatUtcAndLocal(ts);
}

/** Base units, plus the token reading once the mint decimals are known. */
function fmtAmount(base: bigint, decimals: number | null): string {
  const raw = `${groupDigits(base)} base units`;
  if (decimals === null) return raw;
  return `${formatTokenAmount(base, decimals)} tokens (${raw})`;
}

export function SeriesPanel({
  row,
  onChanged,
}: {
  row: VestingSeriesRow;
  onChanged: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();

  const [series, setSeries] = useState<VestingSeries | null>(null);
  const [positions, setPositions] = useState<LoadedPosition[] | null>(null);
  const [mintProgram, setMintProgram] = useState<Address | null>(null);
  const [mintDecimals, setMintDecimals] = useState<number | null>(null);
  const [escrowState, setEscrowState] = useState<Awaited<
    ReturnType<typeof loadVestingEscrow>
  > | null>(null);
  const [depositAmount, setDepositAmount] = useState("");
  const [recoverIdx, setRecoverIdx] = useState<number | null>(null);
  const [recoverWallet, setRecoverWallet] = useState("");
  const [confirm, setConfirm] = useState<
    "cancel" | "disable" | "withdraw" | "surplus" | null
  >(null);
  const [fundingSignature, setFundingSignature] = useState("");
  const [cancelSignature, setCancelSignature] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now] = useState(() => Math.floor(Date.now() / 1000));

  const refresh = useCallback(async () => {
    if (!row.series_pda) return;
    try {
      // fetchSeriesByPda throws on RPC/decoding failure, so a read error and
      // a genuinely absent account get different messages below.
      const [s, p] = await Promise.all([
        fetchSeriesByPda(client.runtime.rpc, row.series_pda),
        loadPositionsForSeries(client.runtime.rpc, row.series_pda),
      ]);
      const escrow = s
        ? await loadVestingEscrow(
            client.runtime.rpc,
            address(row.series_pda),
            s,
          )
        : null;
      setEscrowState(escrow);
      setSeries(s);
      setPositions(p);
      setLoadError(
        s
          ? null
          : "The prepared series account does not exist on this network yet. Resume creation first.",
      );
    } catch (err) {
      setLoadError(
        `Could not read the series (${err instanceof Error ? err.message : String(err)}). The on-chain state is unknown — retry after RPC recovery.`,
      );
    }
  }, [client, row.series_pda]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  useEffect(() => {
    try {
      const receipts = readVestingStepReceipts(row);
      const funding = receipts.find((r) => r.step === "deposit");
      // Synchronize this request's public receipts from browser storage after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (funding) setFundingSignature(funding.signature);
      const receipt = receipts.find((r) => r.step === "cancel");
      if (receipt) setCancelSignature(receipt.signature);
    } catch {
      /* The signature input remains available for manual reconciliation. */
    }
  }, [row]);

  async function checkFundingReceipt() {
    try {
      const receipt = readVestingStepReceipts(row).find(
        (r) => r.step === "deposit",
      );
      const signature = fundingSignature || receipt?.signature;
      if (!signature) return;
      let status = (
        await client.runtime.rpc
          .getSignatureStatuses([toSignature(signature)], {
            searchTransactionHistory: true,
          })
          .send()
      ).value[0];
      const expired =
        !status &&
        receipt?.lastValidBlockHeight &&
        (await client.runtime.rpc
          .getBlockHeight({ commitment: "finalized" })
          .send()) > BigInt(receipt.lastValidBlockHeight);
      // Re-read after expiry: a null status from an older bank is insufficient.
      if (expired)
        status = (
          await client.runtime.rpc
            .getSignatureStatuses([toSignature(signature)], {
              searchTransactionHistory: true,
            })
            .send()
        ).value[0];
      if (
        status?.confirmationStatus === "finalized" ||
        status?.err ||
        (expired && !status)
      ) {
        clearVestingStepReceipt(row, signature);
        setFundingSignature("");
        void refresh();
        if (status?.err || expired)
          toast.showError(
            "Deposit did not finalize",
            "The failed or expired receipt was cleared. Check the refreshed outstanding allocation before a new deposit.",
          );
      } else
        toast.showError(
          "Deposit is still pending",
          "Keep this receipt; checking it never sends another deposit.",
        );
    } catch (error) {
      toast.showError(
        "Receipt check unavailable",
        error instanceof Error ? error.message : undefined,
      );
    }
  }

  async function recordCancellation(signature: string) {
    if (!conn.wallet) return;
    await markVestingSeriesCancelled(conn.wallet, row.id, signature);
    clearVestingStepReceipt(row, signature);
    setCancelSignature("");
    onChanged();
  }
  useEffect(() => {
    let cancelled = false;
    fetchMintDecimals(client.runtime.rpc, address(row.token_mint))
      .then((d) => {
        if (!cancelled) setMintDecimals(d);
      })
      .catch(() => {
        if (!cancelled) setMintDecimals(null);
      });
    fetchVestingMintTokenProgram(client.runtime.rpc, address(row.token_mint))
      .then((program) => {
        if (!cancelled) setMintProgram(program);
      })
      .catch(() => {
        if (!cancelled) {
          setMintProgram(null);
          setLoadError(
            "Could not verify the token program; transaction controls remain disabled.",
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, row.token_mint]);

  const draft = series?.status === VestingSeriesStatus.Draft;
  const funded = series
    ? series.totalAllocated > BigInt(0) &&
      series.deposited >= series.totalAllocated
    : false;
  const cancelled = series?.status === VestingSeriesStatus.Cancelled;

  async function ataFor(owner: Address): Promise<Address> {
    if (!mintProgram)
      throw new Error("The mint token program has not been verified");
    const program = mintProgram;
    const finder =
      program === TOKEN_CLASSIC ? findClassicAtaPda : findAssociatedTokenPda;
    const [ata] = await finder({
      mint: address(row.token_mint),
      owner,
      tokenProgram: program,
    });
    return ata;
  }

  async function runTx(
    instructions: Parameters<typeof tx.send>[0]["instructions"],
    pending: string,
    successTitle: string,
    receiptStep?: "deposit",
  ): Promise<string | null> {
    if (!conn.wallet || tx.isSending) return null;
    const signer = walletSigner(conn.wallet);
    const pendingId = toast.showPending(pending);
    try {
      const lifetime = (
        await client.runtime.rpc
          .getLatestBlockhash({ commitment: "confirmed" })
          .send()
      ).value;
      const sig = await tx.send({ instructions, feePayer: signer, lifetime });
      if (receiptStep) {
        setFundingSignature(sig);
        try {
          saveVestingStepReceipt(row, {
            step: receiptStep,
            signature: sig,
            lastValidBlockHeight: lifetime.lastValidBlockHeight.toString(),
          });
        } catch {
          toast.showError(
            "Receipt storage failed",
            `Keep this submitted signature and do not deposit again: ${sig}`,
          );
        }
      }
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: successTitle });
      return sig;
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Transaction failed", explainSendError(err));
      return null;
    }
  }

  async function deposit() {
    if (!conn.wallet || !series || !mintProgram || !/^\d+$/.test(depositAmount))
      return;
    if (
      fundingSignature ||
      readVestingStepReceipts(row).some((r) => r.step === "deposit")
    ) {
      toast.showError(
        "An earlier deposit needs checking",
        "Use Check deposit receipt before sending another deposit.",
      );
      return;
    }
    assertChainRecordStorageAvailable();
    const signer = walletSigner(conn.wallet);
    const amount = BigInt(depositAmount);
    const fresh = await loadSeriesByPda(client.runtime.rpc, row.series_pda!);
    if (
      !fresh ||
      fresh.status !== VestingSeriesStatus.Active ||
      row.status !== "created" ||
      amount <= BigInt(0) ||
      amount > fresh.totalAllocated - fresh.deposited
    ) {
      toast.showError(
        "Deposit unavailable",
        "Finalize and record the complete series first, then deposit at most the outstanding allocation shown after refresh.",
      );
      void refresh();
      return;
    }
    const latestEscrow = await loadVestingEscrow(
      client.runtime.rpc,
      address(row.series_pda!),
      fresh,
    );
    if (!latestEscrow.identity || !latestEscrow.immutableOwner)
      throw new Error(
        "Escrow identity or immutable owner could not be verified; deposits are unavailable.",
      );
    const fromAta = await ataFor(signer.address);
    const mint = address(row.token_mint);
    const escrow = series.escrow;
    // Emergency-pause gate (read-only) — the last named account.
    const [platform] = await findPlatformPda();
    const baseIx = getDepositToVestingEscrowInstruction({
      platform,
      depositor: signer,
      series: address(row.series_pda!),
      tokenMint: mint,
      escrow,
      depositorTokenAccount: fromAta,
      tokenProgram: mintProgram,
      amount,
      identity: (
        await findCreateVestingSeriesIdentityPda({
          series: address(row.series_pda!),
        })
      )[0],
    });
    const metas = (await mintHasManciHook(client.runtime.rpc, mint))
      ? await hookTransferMetas(client.runtime.rpc, mint, {
          sourceTokenAccount: fromAta,
          destTokenAccount: escrow,
          transferAuthority: signer.address,
          sourceOwner: signer.address,
          destOwner: address(row.series_pda!),
        })
      : [];
    const sig = await runTx(
      [{ ...baseIx, accounts: [...baseIx.accounts, ...metas] }],
      `Depositing ${groupDigits(depositAmount.trim())} base units into the vesting escrow…`,
      "Deposit submitted — waiting for confirmation",
      "deposit",
    );
    if (sig) {
      setDepositAmount("");
      void refresh();
    }
  }

  async function approveTranche(index: number) {
    if (!conn.wallet || draft || !funded || cancelled) return;
    const signer = walletSigner(conn.wallet);
    const ix = getApproveVestingTrancheInstruction({
      authority: signer,
      series: address(row.series_pda!),
      trancheIndex: index,
    });
    const sig = await runTx(
      [ix],
      `Approving tranche #${index}…`,
      "Tranche approved",
    );
    if (sig) void refresh();
  }

  async function recoverPosition() {
    if (!conn.wallet || draft || recoverIdx === null || !positions) return;
    const signer = walletSigner(conn.wallet);
    const pos = positions.find((p) => p.account.index === recoverIdx);
    if (!pos) return;
    const ix = await getRecoverVestingPositionInstructionAsync({
      authority: signer,
      series: address(row.series_pda!),
      position: pos.pda,
      positionIndex: recoverIdx,
      newWallet: address(recoverWallet.trim()),
    });
    const sig = await runTx(
      [ix],
      `Recovering position #${recoverIdx} to the replacement wallet…`,
      "Position recovered",
    );
    if (sig) {
      setRecoverIdx(null);
      setRecoverWallet("");
      void refresh();
    }
  }

  async function doConfirm() {
    if (!conn.wallet || !series || !mintProgram) return;
    const signer = walletSigner(conn.wallet);
    setBusy(true);
    try {
      if (confirm === "cancel") {
        const ix = getCancelVestingSeriesInstruction({
          authority: signer,
          series: address(row.series_pda!),
        });
        const sig = await runTx(
          [ix],
          "Cancelling the vesting series…",
          "Series cancelled",
        );
        if (sig && conn.wallet) {
          setCancelSignature(sig);
          try {
            saveVestingStepReceipt(row, { step: "cancel", signature: sig });
            await recordCancellation(sig);
          } catch {
            toast.showError(
              "Status update failed",
              "The series was cancelled on-chain but the record could not be updated.",
            );
          }
          onChanged();
        }
      } else if (confirm === "disable") {
        const ix = getDisableVestingCancellationInstruction({
          authority: signer,
          series: address(row.series_pda!),
        });
        await runTx(
          [ix],
          "Permanently disabling cancellation…",
          "Cancellation disabled",
        );
      } else if (confirm === "withdraw" || confirm === "surplus") {
        const toAta = await ataFor(signer.address);
        const mint = address(row.token_mint);
        const baseIx = (
          confirm === "surplus"
            ? getWithdrawVestingSurplusInstruction
            : getWithdrawUnvestedInstruction
        )({
          authority: signer,
          series: address(row.series_pda!),
          tokenMint: mint,
          escrow: series.escrow,
          authorityTokenAccount: toAta,
          tokenProgram: mintProgram,
          identity: (
            await findCreateVestingSeriesIdentityPda({
              series: address(row.series_pda!),
            })
          )[0],
        });
        const metas = (await mintHasManciHook(client.runtime.rpc, mint))
          ? await hookTransferMetas(client.runtime.rpc, mint, {
              sourceTokenAccount: series.escrow,
              destTokenAccount: toAta,
              transferAuthority: address(row.series_pda!),
              sourceOwner: address(row.series_pda!),
              destOwner: signer.address,
            })
          : [];
        await runTx(
          [
            await getCreateAssociatedTokenIdempotentInstructionAsync({
              payer: signer,
              owner: signer.address,
              mint,
              tokenProgram: mintProgram,
            }),
            { ...baseIx, accounts: [...baseIx.accounts, ...metas] },
          ],
          confirm === "surplus"
            ? "Withdrawing only the active escrow surplus…"
            : "Withdrawing the unvested remainder…",
          confirm === "surplus"
            ? "Surplus withdrawal submitted"
            : "Unvested withdrawal submitted",
        );
      }
      setConfirm(null);
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  if (loadError)
    return (
      <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
        {loadError}{" "}
        <button
          type="button"
          onClick={() => void refresh()}
          className="underline"
        >
          Retry reading
        </button>
      </p>
    );

  if (!series || !positions) {
    return (
      <div className="mt-3">
        <SkeletonTable rows={3} cols={4} />
      </div>
    );
  }

  const deliverable = vestingDeliverableCumulative(series, now);

  return (
    <div className="mt-4 space-y-5 rounded-lg border border-slate-200 bg-slate-50/50 p-4">
      {/* On-chain header */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-slate-600">
        <span>
          Series PDA:{" "}
          <span className="font-mono">
            {row.series_pda!.slice(0, 6)}…{row.series_pda!.slice(-4)}
          </span>
        </span>
        <span>
          Status on-chain:{" "}
          <span className="font-semibold">
            {draft
              ? "Draft — allocations are not locked"
              : cancelled
                ? "Cancelled"
                : "Finalized — allocations locked"}
          </span>
        </span>
        {row.created_tx && (
          <a
            href={explorerTxUrl(row.created_tx, detectNetwork())}
            target="_blank"
            rel="noreferrer"
            className="underline-offset-2 hover:underline"
          >
            Creation tx ↗
          </a>
        )}
      </div>

      {cancelled && row.status !== "cancelled" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          Cancellation is on-chain; record its signature to update the request.
          This action sends no transaction.
          <input
            value={cancelSignature}
            onChange={(e) => setCancelSignature(e.target.value)}
            placeholder="Cancellation transaction signature"
            className="mt-2 w-full rounded border border-amber-200 bg-white p-2 font-mono"
          />
          <button
            type="button"
            disabled={!cancelSignature || busy}
            onClick={() => {
              setBusy(true);
              void recordCancellation(cancelSignature)
                .catch((error) =>
                  toast.showError(
                    "Recording pending",
                    error instanceof Error ? error.message : undefined,
                  ),
                )
                .finally(() => setBusy(false));
            }}
            className="mt-2 underline"
          >
            Retry recording cancellation
          </button>
        </div>
      )}
      {fundingSignature && (
        <div className="rounded-lg border border-brand-200 bg-brand-50 p-3 text-xs text-brand-900">
          Deposit submitted. Check this receipt before sending another deposit.
          <a
            href={explorerTxUrl(fundingSignature, detectNetwork())}
            target="_blank"
            rel="noreferrer"
            className="mt-1 block break-all font-mono underline"
          >
            {fundingSignature}
          </a>
          <button
            type="button"
            onClick={() => void checkFundingReceipt()}
            className="mt-2 underline"
          >
            Check deposit receipt
          </button>
        </div>
      )}
      {/* Funding */}
      <div>
        <div className="flex items-center justify-between text-xs">
          <p className="font-semibold uppercase tracking-wider text-slate-500">
            Funding
          </p>
          <p className="font-mono text-slate-700">
            {fmtAmount(series.deposited, mintDecimals)} /{" "}
            {fmtAmount(series.totalAllocated, mintDecimals)} cumulative
            deposits
          </p>
        </div>
        <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-200">
          <div
            className={`h-full ${funded ? "bg-emerald-500" : "bg-amber-500"}`}
            style={{
              width: `${
                series.totalAllocated === BigInt(0)
                  ? 0
                  : Math.min(
                      100,
                      Number(
                        (series.deposited * BigInt(10_000)) /
                          series.totalAllocated,
                      ) / 100,
                    )
              }%`,
            }}
          />
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {draft
            ? "Draft releases are blocked. Add all reviewed positions and finalize before funding this request."
            : funded
              ? "Fully funded — releases follow the schedule and approval rules."
              : "Release is blocked until deposits cover the full allocation."}
        </p>
        {!cancelled && !draft && row.status === "created" && (
          <div className="mt-2 flex flex-wrap items-start gap-2">
            <div>
              <input
                value={depositAmount}
                inputMode="numeric"
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="Amount to deposit (base units)"
                className="w-64 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-slate-400 focus:outline-none"
              />
              {depositAmount.trim() !== "" &&
                (() => {
                  const parsed = parseBaseUnits(depositAmount);
                  if (!parsed.ok)
                    return (
                      <p className="mt-1 text-[11px] text-red-600">
                        {parsed.error}
                      </p>
                    );
                  const remaining = series.totalAllocated - series.deposited;
                  return (
                    <p
                      className={`mt-1 text-[11px] ${parsed.baseUnits > remaining ? "text-red-600" : "text-slate-500"}`}
                    >
                      = {fmtAmount(parsed.baseUnits, mintDecimals)}
                      {parsed.baseUnits > remaining &&
                        ` — exceeds the ${groupDigits(remaining)} base units still missing`}
                    </p>
                  );
                })()}
            </div>
            <button
              type="button"
              disabled={
                !!fundingSignature ||
                tx.isSending ||
                !mintProgram ||
                !escrowState?.identity ||
                !escrowState.immutableOwner ||
                !/^\d+$/.test(depositAmount) ||
                BigInt(depositAmount || "0") <= BigInt(0) ||
                BigInt(depositAmount || "0") >
                  series.totalAllocated - series.deposited
              }
              onClick={() =>
                void deposit().catch((error) =>
                  toast.showError(
                    "Deposit unavailable",
                    error instanceof Error ? error.message : undefined,
                  ),
                )
              }
              className="rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              Deposit
            </button>
          </div>
        )}
      </div>

      {/* Tranches */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Schedule ({series.tranches.length} tranches)
        </p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Unlocks</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">State</th>
                {series.timingMode === VestingTimingMode.Approval &&
                  !cancelled &&
                  !draft && <th className="px-3 py-2"></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {series.tranches.map((t, i) => {
                const vested = Number(t.unlockTs) <= now;
                const approved =
                  (series.approvedMask & (BigInt(1) << BigInt(i))) !==
                  BigInt(0);
                const lapsed =
                  Number(t.unlockTs) + Number(series.approvalWindowSecs) <= now;
                return (
                  <tr key={i}>
                    <td className="px-3 py-2 text-slate-500">{i}</td>
                    <td className="px-3 py-2 text-slate-700">
                      {fmtTs(t.unlockTs)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-900">
                      {t.amount.toString()}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {draft ? (
                        <span className="text-slate-500">
                          Draft — release blocked
                        </span>
                      ) : !vested ? (
                        <span className="text-slate-500">Scheduled</span>
                      ) : cancelled ? (
                        <span className="text-slate-600">Frozen at cancel</span>
                      ) : funded &&
                        (series.timingMode === VestingTimingMode.Auto ||
                          approved ||
                          lapsed) ? (
                        <span className="font-medium text-emerald-700">
                          Deliverable
                        </span>
                      ) : (
                        <span className="font-medium text-amber-700">
                          {funded
                            ? "Awaiting approval"
                            : "Awaiting full funding"}
                        </span>
                      )}
                    </td>
                    {series.timingMode === VestingTimingMode.Approval &&
                      !cancelled &&
                      !draft && (
                        <td className="px-3 py-2 text-right">
                          {vested && !approved && !lapsed && funded ? (
                            <button
                              type="button"
                              disabled={tx.isSending || busy || !mintProgram}
                              onClick={() => void approveTranche(i)}
                              className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-slate-400"
                            >
                              Approve
                            </button>
                          ) : approved ? (
                            <span className="text-xs text-slate-400">
                              Approved
                            </span>
                          ) : null}
                        </td>
                      )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Positions */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Recipients ({positions.length})
        </p>
        <div className="mt-2 overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">Wallet</th>
                <th className="px-3 py-2 text-right">Allocation</th>
                <th className="px-3 py-2 text-right">Released</th>
                <th className="px-3 py-2 text-right">Deliverable now</th>
                {series.recoveryEnabled && !draft && (
                  <th className="px-3 py-2"></th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {positions.map((p) => {
                const ent = positionEntitlement(
                  p.account.allocation,
                  deliverable,
                  series.totalAllocated,
                );
                const claimable =
                  ent > p.account.released
                    ? ent - p.account.released
                    : BigInt(0);
                return (
                  <tr key={p.pda}>
                    <td className="px-3 py-2 text-slate-500">
                      {p.account.index}
                    </td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-700">
                      {p.account.wallet.toString().slice(0, 6)}…
                      {p.account.wallet.toString().slice(-4)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-900">
                      {fmtAmount(p.account.allocation, mintDecimals)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-700">
                      {fmtAmount(p.account.released, mintDecimals)}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-slate-700">
                      {fmtAmount(claimable, mintDecimals)}
                    </td>
                    {series.recoveryEnabled && !draft && (
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          onClick={() => setRecoverIdx(p.account.index)}
                          className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-slate-400"
                        >
                          Recover
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {escrowState && (
        <div className="rounded-lg border border-brand-200 bg-brand-50 p-3 text-xs text-brand-900">
          <p>
            Actual escrow balance: {String(escrowState.balance)} · active
            recipient reserve: {String(escrowState.reserved)} · active surplus:{" "}
            {String(escrowState.surplus)}
          </p>
          <p className="mt-1">
            Cumulative deposits are historical. New program deposits cannot
            exceed the schedule total. Gifts or transferred surplus require
            the current receiver KYC before withdrawal.
          </p>
          {!escrowState.immutableOwner && (
            <p className="mt-2 font-semibold">
              This escrow has mutable ownership, so new deposits are
              unavailable. Reserved recipient payouts and permitted refunds
              remain separate.
            </p>
          )}
          {!escrowState.identity && (
            <p className="mt-2 font-semibold">
              The escrow identity could not be verified, so deposits and
              surplus withdrawals are unavailable.
            </p>
          )}
        </div>
      )}
      {/* Danger zone */}
      <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
        {(series.cancellationEnabled || draft) && !cancelled && (
          <>
            <button
              type="button"
              onClick={() => setConfirm("cancel")}
              className="rounded-md border border-red-300 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-800 hover:bg-red-100"
            >
              {draft ? "Abort incomplete Draft" : "Cancel series"}
            </button>
            {!draft && (
              <button
                type="button"
                onClick={() => setConfirm("disable")}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400"
              >
                Disable cancellation forever
              </button>
            )}
          </>
        )}
        {!draft &&
          !cancelled &&
          escrowState &&
          escrowState.surplus > BigInt(0) && (
            <button
              type="button"
              disabled={!escrowState.identity || busy || tx.isSending}
              onClick={() => setConfirm("surplus")}
              className="rounded-md border border-brand-300 bg-brand-50 px-3 py-1.5 text-xs text-brand-900"
            >
              Withdraw active surplus
            </button>
          )}
        {cancelled && (
          <button
            type="button"
            disabled={!escrowState?.identity || busy || tx.isSending}
            onClick={() => setConfirm("withdraw")}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400"
          >
            Withdraw unvested remainder
          </button>
        )}
      </div>

      {/* Recovery modal */}
      {recoverIdx !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setRecoverIdx(null);
          }}
        >
          <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-5 shadow-xl">
            <p className="text-sm font-semibold text-slate-900">
              Recover position #{recoverIdx}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Re-points the position to a replacement wallet (same recipient,
              lost keys). The full position — unreleased balance plus all future
              tranches — moves; the old wallet can no longer claim. Confirming
              the replacement belongs to the same person is your own off-chain
              verification.
            </p>
            <input
              value={recoverWallet}
              onChange={(e) => setRecoverWallet(e.target.value)}
              placeholder="Replacement wallet address"
              className="mt-3 w-full rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setRecoverIdx(null)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={recoverWallet.trim().length < 32}
                onClick={() => void recoverPosition()}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                Recover
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Confirm modal */}
      <ConfirmModal
        open={confirm !== null}
        title={
          confirm === "cancel"
            ? "Cancel this vesting series?"
            : confirm === "disable"
              ? "Disable cancellation forever?"
              : confirm === "surplus"
                ? "Withdraw the active escrow surplus?"
                : "Withdraw the unvested remainder?"
        }
        description={
          confirm === "cancel"
            ? draft
              ? "Abort this incomplete Draft. No recipient entitlement exists before finalization, including pre-cliff percentages. You can withdraw any deposits after aborting; submit a new request to restart."
              : "Recipients keep everything already vested (including tranches awaiting approval) — only the unvested remainder returns to you. This cannot be undone."
            : confirm === "disable"
              ? "You irrevocably give up the cancellation power. The series will run to completion exactly as scheduled."
              : confirm === "surplus"
                ? "Withdraw only the actual balance above the unreleased allocation. Recipient reserves remain in escrow. Gifts and transferred surplus require receiver KYC."
                : "Only the unvested remainder leaves the escrow — the amount reserved for recipients can never be withdrawn here."
        }
        kind={confirm === "cancel" ? "destructive" : "warning"}
        confirmLabel={
          confirm === "cancel"
            ? "Cancel series"
            : confirm === "disable"
              ? "Disable forever"
              : "Withdraw"
        }
        requireReason={false}
        busy={busy || tx.isSending}
        onConfirm={() => void doConfirm()}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}

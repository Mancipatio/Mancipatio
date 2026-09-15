"use client";

import { WalletRequired } from "@/components/wallet-required";

// Portfolio — my vesting positions (spec §11.1.10: the recipient sees EVERY
// setting of the series when they view their position — schedule, cancellable
// or not, pre-cliff percentage, recovery). Claim-mode positions are claimed
// here; push-mode positions can be pushed by anyone.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { type Address } from "@solana/kit";
import { findAssociatedTokenPda as findClassicAtaPda } from "@solana-program/token";
import {
  getClaimVestedInstruction,
  getPushVestedInstruction,
  VestingDeliveryMode,
  VestingSeriesStatus,
  VestingTimingMode,
} from "@/lib/generated/asset_registry";
import { hookTransferMetas, mintHasManciHook } from "@/lib/hook-metas";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { useToast } from "@/lib/toast";
import { SkeletonTable } from "@/components/skeleton";
import {
  type LoadedPosition,
  type VestingSeries,
} from "@/lib/vesting-series";
import {
  deriveClaimState,
  formatCountdown,
  loadPositionEntries,
  type PositionEntry,
} from "@/lib/vesting-claim-state";
import {
  fetchMintDecimals,
  formatTokenAmount,
  formatUtc,
  formatUtcAndLocal,
  groupDigits,
  localZoneLabel,
} from "@/lib/vesting-amounts";

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const TOKEN_CLASSIC = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

/** Background re-read of positions/series while the page stays open. */
const REFRESH_INTERVAL_MS = 60_000;

type Entry = { position: LoadedPosition; series: VestingSeries };

/** Base units + token reading when the mint decimals are known. */
function fmtAmount(base: bigint, decimals: number | null | undefined): string {
  const raw = `${groupDigits(base)} base units`;
  if (decimals === null || decimals === undefined) return raw;
  return `${formatTokenAmount(base, decimals)} tokens (${raw})`;
}

export default function PortfolioVestingPage() {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();

  const [entries, setEntries] = useState<PositionEntry[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  /** Guards against the 60 s timer and "Refresh now" overlapping an
   *  in-flight load (duplicate RPC calls + out-of-order setEntries). */
  const refreshInFlight = useRef(false);
  const [lastLoadedAt, setLastLoadedAt] = useState<number | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  /** Unix seconds, ticking every second so claim availability, the
   *  countdown and "fully vested" flip without a manual reload (F04). */
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  /** Mint → decimals (null = could not be read; amounts stay in base units). */
  const [decimalsByMint, setDecimalsByMint] = useState<
    Record<string, number | null>
  >({});
  const zoneLabel = useMemo(() => localZoneLabel(), []);

  const refresh = useCallback(async () => {
    if (!wallet || refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    try {
      const out = await loadPositionEntries(client.runtime.rpc, wallet);
      setEntries(out);
      setFailed(null);
      setLastLoadedAt(Math.floor(Date.now() / 1000));
      setNow(Math.floor(Date.now() / 1000));
      const mints = Array.from(
        new Set(
          out
            .filter((e): e is Extract<PositionEntry, { kind: "ok" }> =>
              e.kind === "ok",
            )
            .map((e) => e.series.tokenMint.toString()),
        ),
      );
      const found: Record<string, number | null> = {};
      await Promise.all(
        mints.map(async (m) => {
          try {
            found[m] = await fetchMintDecimals(client.runtime.rpc, m as Address);
          } catch {
            found[m] = null;
          }
        }),
      );
      setDecimalsByMint((prev) => ({ ...prev, ...found }));
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err));
    } finally {
      refreshInFlight.current = false;
      setRefreshing(false);
    }
  }, [client, wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const reload = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => clearInterval(reload);
  }, [refresh]);

  useEffect(() => {
    const tick = setInterval(
      () => setNow(Math.floor(Date.now() / 1000)),
      1_000,
    );
    return () => clearInterval(tick);
  }, []);

  const okEntries = useMemo(
    () =>
      (entries ?? []).filter(
        (e): e is Extract<PositionEntry, { kind: "ok" }> => e.kind === "ok",
      ),
    [entries],
  );
  const errorEntries = useMemo(
    () =>
      (entries ?? []).filter(
        (e): e is Extract<PositionEntry, { kind: "error" }> =>
          e.kind === "error",
      ),
    [entries],
  );

  async function release(entry: Entry) {
    if (!conn.wallet) return;
    const signer = walletSigner(conn.wallet);
    const { series, position } = entry;
    const push = series.deliveryMode === VestingDeliveryMode.Push;
    const pendingId = toast.showPending(
      push
        ? "Pushing the vested amount to your wallet…"
        : "Claiming your vested tokens…",
    );
    try {
      const mint = series.tokenMint;
      const info = await client.runtime.rpc
        .getAccountInfo(mint, { encoding: "base64" })
        .send();
      const program =
        info.value?.owner === TOKEN_CLASSIC ? TOKEN_CLASSIC : TOKEN_2022;
      const {
        getCreateAssociatedTokenIdempotentInstructionAsync: createAtaIx,
      } =
        program === TOKEN_CLASSIC
          ? await import("@solana-program/token")
          : await import("@solana-program/token-2022");
      const [ata] = await findClassicAtaPda({
        owner: signer.address,
        tokenProgram: program,
        mint,
      });
      const createAta = await createAtaIx({
        payer: signer,
        owner: signer.address,
        mint,
        tokenProgram: program,
      });
      const baseIx = push
        ? getPushVestedInstruction({
            payer: signer,
            series: position.account.series,
            position: position.pda,
            tokenMint: mint,
            escrow: series.escrow,
            recipientTokenAccount: ata,
            tokenProgram: program,
            positionIndex: position.account.index,
          })
        : getClaimVestedInstruction({
            recipient: signer,
            series: position.account.series,
            position: position.pda,
            tokenMint: mint,
            escrow: series.escrow,
            recipientTokenAccount: ata,
            tokenProgram: program,
            positionIndex: position.account.index,
          });
      const metas = (await mintHasManciHook(client.runtime.rpc, mint))
        ? await hookTransferMetas(client.runtime.rpc, mint, {
            sourceTokenAccount: series.escrow,
            destTokenAccount: ata,
            transferAuthority: position.account.series,
            sourceOwner: position.account.series,
            destOwner: signer.address,
          })
        : [];
      const sig = await tx.send({
        instructions: [
          createAta,
          { ...baseIx, accounts: [...baseIx.accounts, ...metas] },
        ],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, {
        title: push ? "Vested amount delivered" : "Vested tokens claimed",
      });
      void refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Transaction failed", explainSendError(err));
    }
  }

  if (!wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  return (
    <main className="min-w-0 flex-1">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
        Vesting
      </p>
      <h1 className="mt-1 text-2xl font-semibold text-slate-900">
        My vesting positions
      </h1>
      <p className="mt-2 max-w-2xl text-sm text-slate-600">
        Tokens locked for you under a vesting series — non-transferable by
        design: only this wallet can receive them. Every setting of the series
        is shown here.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-xs text-slate-500">
        <span>
          Clock: {formatUtc(now)} · your zone {zoneLabel}
          {lastLoadedAt !== null &&
            ` · positions read ${Math.max(0, now - lastLoadedAt)}s ago (auto-refresh every ${REFRESH_INTERVAL_MS / 1000}s)`}
        </span>
        <button
          type="button"
          disabled={refreshing}
          onClick={() => void refresh()}
          className="rounded-md border border-slate-300 px-2.5 py-1 font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
        >
          {refreshing ? "Refreshing…" : "Refresh now"}
        </button>
      </div>

      <div className="mt-4">
        {entries === null && !failed ? (
          <SkeletonTable rows={3} cols={4} />
        ) : failed && entries === null ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <p>Could not load your vesting positions: {failed}</p>
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-2 rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium hover:border-red-400"
            >
              Retry
            </button>
          </div>
        ) : entries === null ? null : entries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-10 text-center">
            <p className="text-sm font-medium text-slate-900">
              No vesting positions
            </p>
            <p className="mt-2 text-xs text-slate-500">
              When a client adds this wallet as a recipient in a vesting series,
              your position appears here.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {failed && (
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
                The last refresh failed ({failed}) — showing positions read{" "}
                {lastLoadedAt !== null ? `${now - lastLoadedAt}s ago` : "earlier"}
                . Amounts below may be stale.
              </p>
            )}
            {errorEntries.map((entry) => (
              <div
                key={entry.position.pda.toString()}
                className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900"
              >
                <p className="font-semibold">
                  Position #{entry.position.account.index} — series could not
                  be read
                </p>
                <p className="mt-1 text-xs">
                  Allocation {groupDigits(entry.position.account.allocation)}{" "}
                  base units, released{" "}
                  {groupDigits(entry.position.account.released)}. Series{" "}
                  <span className="font-mono">
                    {entry.seriesPda.slice(0, 6)}…{entry.seriesPda.slice(-4)}
                  </span>
                  : {entry.error}
                </p>
                <p className="mt-1 text-xs">
                  This position exists on-chain; its claim state is unknown
                  until the series account can be read.
                </p>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  className="mt-2 rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium hover:border-red-400"
                >
                  Retry
                </button>
              </div>
            ))}
            {okEntries.map((entry) => {
              const { series, position } = entry;
              const state = deriveClaimState(series, position.account, now);
              const claimable = state.claimable;
              const decimals = decimalsByMint[series.tokenMint.toString()];
              const push = series.deliveryMode === VestingDeliveryMode.Push;
              const draft = series.status === VestingSeriesStatus.Draft;
              const cancelled = series.status === VestingSeriesStatus.Cancelled;
              const done = state.status === "done";
              const key = position.pda.toString();
              return (
                <div
                  key={key}
                  className="rounded-xl border border-slate-200 bg-white p-4 shadow-card"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-slate-900">
                        Position #{position.account.index} ·{" "}
                        <span className="font-mono text-xs">
                          mint {series.tokenMint.toString().slice(0, 6)}…
                          {series.tokenMint.toString().slice(-4)}
                        </span>
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        {fmtAmount(position.account.released, decimals)} /{" "}
                        {fmtAmount(position.account.allocation, decimals)}{" "}
                        released ·{" "}
                        {push ? "push delivery" : "claim delivery"} ·{" "}
                        {series.timingMode === VestingTimingMode.Approval
                          ? "approval timing"
                          : "auto timing"}
                        {draft
                          ? " · Draft — release blocked until finalization"
                          : cancelled
                            ? " · cancelled"
                            : " · finalized"}
                      </p>
                      {!done && (
                        <p className="mt-0.5 text-xs text-slate-500">
                          {state.status === "claimable"
                            ? `${push ? "Deliverable" : "Claimable"} now: ${fmtAmount(claimable, decimals)}`
                            : state.status === "locked" &&
                                state.nextUnlockTs !== null
                              ? `Next unlock in ${formatCountdown(state.secondsToNextUnlock ?? 0)} — ${formatUtcAndLocal(state.nextUnlockTs)}`
                              : state.status === "awaiting_approval"
                                ? "A tranche is unlocked but waits for the authority's approval (or the approval window to lapse)."
                                : state.status === "unfunded"
                                  ? "Nothing deliverable: the escrow does not yet cover the full allocation."
                                  : state.status === "draft"
                                    ? "Nothing deliverable until the series is finalized."
                                    : state.status === "cancelled"
                                      ? series.finalCumulative === BigInt(0)
                                        ? "Cancelled before anything vested — nothing is deliverable from this series."
                                        : "Cancelled — your vested share has been fully delivered."
                                      : "Nothing unlocked yet."}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {done ? (
                        <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-800">
                          Fully vested
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={tx.isSending || claimable === BigInt(0)}
                          title={
                            claimable === BigInt(0)
                              ? draft
                                ? "The authority must finish adding positions and finalize this series first."
                                : "Nothing deliverable yet — check the schedule and funding below."
                              : undefined
                          }
                          onClick={() => void release(entry)}
                          className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
                        >
                          {push ? "Push " : "Claim "}
                          {decimals !== null && decimals !== undefined
                            ? `${formatTokenAmount(claimable, decimals)} tokens`
                            : `${groupDigits(claimable)} base units`}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() =>
                          setExpanded((e) => (e === key ? null : key))
                        }
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:border-slate-400"
                      >
                        {expanded === key ? "Hide" : "Series settings"}
                      </button>
                    </div>
                  </div>

                  {expanded === key && (
                    <div className="mt-4 space-y-3 border-t border-slate-100 pt-4 text-xs text-slate-600">
                      <div className="flex flex-wrap gap-x-6 gap-y-1">
                        <span>
                          Schedule: {series.tranches.length} tranche
                          {series.tranches.length === 1 ? "" : "s"}
                        </span>
                        <span>
                          Cancellation:{" "}
                          {draft
                            ? "Draft can be aborted before finalization"
                            : cancelled
                              ? "cancelled"
                              : series.cancellationEnabled
                                ? "cancellable"
                                : "not cancellable"}
                        </span>
                        <span>
                          Pre-cliff keep after finalization:{" "}
                          {(series.preCliffBps / 100).toFixed(0)}%
                        </span>
                        <span>
                          Recovery:{" "}
                          {series.recoveryEnabled ? "enabled" : "disabled"}
                        </span>
                        {series.timingMode === VestingTimingMode.Approval && (
                          <span>
                            Approval window:{" "}
                            {Math.round(
                              Number(series.approvalWindowSecs) / 3600,
                            )}
                            h
                          </span>
                        )}
                        <span>
                          Funding: {fmtAmount(series.deposited, decimals)} /{" "}
                          {fmtAmount(series.totalAllocated, decimals)}
                        </span>
                        <span>
                          Decimals:{" "}
                          {decimals === undefined
                            ? "reading…"
                            : decimals === null
                              ? "unknown (mint unreadable) — amounts shown in base units"
                              : decimals}
                        </span>
                      </div>
                      <table className="min-w-full divide-y divide-slate-200 rounded-lg border border-slate-200 text-xs">
                        <thead className="bg-slate-50 text-left font-semibold uppercase tracking-wider text-slate-500">
                          <tr>
                            <th className="px-3 py-1.5">#</th>
                            <th className="px-3 py-1.5">Unlocks (UTC · local)</th>
                            <th className="px-3 py-1.5 text-right">
                              Amount, all recipients (base units)
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 bg-white">
                          {series.tranches.map((t, i) => (
                            <tr key={i}>
                              <td className="px-3 py-1.5 text-slate-500">
                                {i}
                              </td>
                              <td className="px-3 py-1.5">
                                {formatUtcAndLocal(t.unlockTs)}
                                {Number(t.unlockTs) > now && (
                                  <span className="text-slate-400">
                                    {" "}
                                    · in {formatCountdown(Number(t.unlockTs) - now)}
                                  </span>
                                )}
                              </td>
                              <td className="px-3 py-1.5 text-right font-mono">
                                {groupDigits(t.amount)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {draft && (
                        <p className="text-amber-700">
                          This allocation is provisional until the authority
                          finalizes the complete series. Draft cancellation
                          creates no recipient entitlement.
                        </p>
                      )}
                      {cancelled && (
                        <p className="text-amber-700">
                          This series was cancelled on{" "}
                          {formatUtcAndLocal(series.cancelledAt)} — your vested amount stays
                          yours and remains {push ? "deliverable" : "claimable"}{" "}
                          forever.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}

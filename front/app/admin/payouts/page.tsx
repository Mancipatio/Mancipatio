"use client";

import Link from "next/link";
import {PushDistributions} from "./push-distributions";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isAddress, type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import { preparePayoutSnapshot, bindPayoutSnapshot, readPayoutSnapshots } from "@/lib/payout-snapshots-client";
import { snapshotBytes, type PayoutSnapshotKind, type PreparedPayoutSnapshot } from "@/lib/payout-snapshots";
import { PayoutSnapshotReview } from "@/components/payout-snapshot-review";
import { VaultVoteHistory } from "@/components/vault-vote-history";
import { FieldError, FieldLabel } from "@/components/field";
import { RequireRole } from "@/components/require-role";
import { Kpi } from "@/components/kpi";
import { SkeletonTable } from "@/components/skeleton";
import { ConfirmModal } from "@/components/confirm-modal";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybePlatform,
  findAssetPda,
  findPlatformPda,
  getFinalizeVaultVoteInstruction,
  getFreezeVaultInstruction,
  getOpenVaultVoteInstructionAsync,
  getRouteYieldInstructionAsync,
  PayoutVaultState,
} from "@/lib/generated/asset_registry";
import { loadNetwork } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findShareClassPda } from "@/lib/pdas";
import {
  parseWeightCsv,
  type SnapshotMerkle,
} from "@/lib/distributions";
import {
  base58Pubkey,
  combine,
  positiveNumber,
  required,
  validateAll,
} from "@/lib/form-validation";
import { getSupabase, recordAudit } from "@/lib/supabase";
import { inspectPaymentMint } from "@/lib/transaction-builders";
import { detectNetwork } from "@/lib/network";
import { defaultPaymentMint } from "@/lib/payment-mints";
import { walletSigner } from "@/lib/wallet-signer";
import { explainSendError } from "@/lib/tx-error";
import { useToast } from "@/lib/toast";
import { features } from "@/lib/features";
import {
  isFreezable,
  loadPayoutVaults,
  loadVaultVoteHistory,
  vaultVotePda,
  vaultVoteActions,
  type VaultVoteRecord,
  payoutEscrowPda,
  payoutVaultPda,
  periodsOverdue,
  VAULT_STATE_BADGE,
  VAULT_STATE_LABEL,
  type PayoutVaultRecord,
} from "@/lib/payout-vault";
import {
  buildMerkle,
  parseSnapshotCsv,
  createPayout,
  type Payout,
  type PayoutKind,
  type PayoutStatus,
  type SnapshotRow,
} from "@/lib/payouts";
import {
  advanceCadence,
  CADENCE_LABEL,
  CADENCES,
  daysUntil,
  deletePayoutSchedule,
  listPayoutSchedules,
  scheduleDueStatus,
  todayIso,
  upsertPayoutSchedule,
  type PayoutCadence,
  type PayoutSchedule,
} from "@/lib/payout-schedules";

const KIND_LABEL: Record<PayoutKind, string> = {
  dividend: "Dividend",
  buyback: "Buyback",
  airdrop: "Airdrop",
  other: "Other",
};

const STATUS_LABEL: Record<PayoutStatus, string> = {
  draft: "Draft",
  snapshot_taken: "Snapshot",
  merkle_built: "Merkle built",
  funded: "Funded",
  live: "Live",
  claimed_full: "Fully claimed",
  cancelled: "Cancelled",
};

const STATUS_BADGE: Record<PayoutStatus, string> = {
  draft: "bg-slate-100 text-slate-600 border-slate-300",
  snapshot_taken: "bg-brand-100 text-brand-800 border-brand-200",
  merkle_built: "bg-brand-100 text-brand-800 border-brand-200",
  funded: "bg-amber-100 text-amber-800 border-amber-200",
  live: "bg-emerald-100 text-emerald-800 border-emerald-200",
  claimed_full: "bg-emerald-50 text-emerald-700 border-emerald-200",
  cancelled: "bg-slate-200 text-slate-600 border-slate-300",
};

/** Values a payout schedule hands to the create-distribution card. */
type DistributionPrefill = {
  shareClassPda: string;
  /** Payment-mint base units (best-effort from the schedule's amount hint). */
  totalAmount?: string;
  paymentMint?: string;
};

export default function PayoutsPage() {
  const [distPrefill, setDistPrefill] = useState<DistributionPrefill | null>(
    null,
  );
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Payouts
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Dividend & buyback drops
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Snapshot a share-class&apos; holder base, compute a Merkle tree, and
          publish per-recipient amounts. Once the issuer funds the drop, the
          proportionate amount is <em>pushed</em> to each holder wallet from
          the per-payout page — recipients don&apos;t need to claim anything.
        </p>
      </div>
      <RequireRole role="admin">
        <DueSchedulesPanel
          onStartDistribution={(p) => {
            setDistPrefill(p);
            // Let the create card mount, then bring it into view.
            setTimeout(() => {
              document
                .getElementById("push-distributions")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }, 60);
          }}
        />
        <PayoutsOps />
        <PushDistributions prefill={distPrefill} />
        <PayoutVaultOversight />
      </RequireRole>
    </section>
  );
}

function PayoutsOps() {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  const toast = useToast();
  const [rows, setRows] = useState<Payout[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    const { data, error } = await sb
      .from("payouts")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) {
      toast.showError("Load failed", error.message);
      return;
    }
    setRows((data ?? []) as Payout[]);
  }, [toast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const counts = useMemo(() => {
    if (!rows) return null;
    return {
      total: rows.length,
      live: rows.filter(
        (r) => r.status === "funded" || r.status === "live",
      ).length,
      pendingMerkle: rows.filter(
        (r) =>
          r.status === "draft" ||
          r.status === "snapshot_taken",
      ).length,
      totalAmount: rows
        .filter((r) => r.status !== "cancelled" && r.status !== "draft")
        .reduce((acc, r) => acc + Number(r.total_amount ?? 0), 0),
    };
  }, [rows]);

  return (
    <div className="mt-8 space-y-6">
      {counts && (
        <section className="grid gap-3 sm:grid-cols-4">
          <Kpi label="Total drops" value={String(counts.total)} />
          <Kpi label="Live or funded" value={String(counts.live)} />
          <Kpi
            label="Pending merkle"
            value={String(counts.pendingMerkle)}
            tone={counts.pendingMerkle > 0 ? "warn" : "default"}
          />
          <Kpi
            label="Total committed"
            value={counts.totalAmount.toLocaleString("en-US", {
              maximumFractionDigits: 2,
            })}
          />
        </section>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          disabled={!wallet}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          New payout
        </button>
      </div>

      {rows === null ? (
        <SkeletonTable rows={4} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No payouts yet. Use{" "}
          <span className="font-semibold">New payout</span> to upload a
          snapshot CSV and build the Merkle tree.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="min-w-full divide-y divide-slate-200 text-sm">
            <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3">Asset</th>
                <th className="px-4 py-3">Kind</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-right">Holders</th>
                <th className="px-4 py-3 text-right">Per share</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Created</th>
                <th className="px-4 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-slate-900">
                      {r.asset_label || "—"}
                    </p>
                    <p className="font-mono text-[11px] text-slate-500">
                      {r.asset_mint.slice(0, 8)}…{r.asset_mint.slice(-4)}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-slate-700">
                    {KIND_LABEL[r.kind]}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-900">
                    {Number(r.total_amount).toLocaleString("en-US", {
                      maximumFractionDigits: 4,
                    })}{" "}
                    <span className="text-xs text-slate-500">{r.currency}</span>
                  </td>
                  <td className="px-4 py-3 text-right text-slate-700">
                    {r.holder_count}
                  </td>
                  <td className="px-4 py-3 text-right text-slate-700">
                    {r.per_share
                      ? Number(r.per_share).toLocaleString("en-US", {
                          maximumFractionDigits: 8,
                        })
                      : "—"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${STATUS_BADGE[r.status]}`}
                    >
                      {STATUS_LABEL[r.status]}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">
                    {new Date(r.created_at)
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/admin/payouts/${r.id}`}
                      className="text-slate-700 underline-offset-2 hover:underline"
                    >
                      Open
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            void refresh();
            setShowCreate(false);
          }}
        />
      )}

      <p className="text-xs text-slate-400">
        Merkle trees are built off operator-asserted snapshots (CSV upload).
        {features().payoutAirdrop ? (
          <>
            {" "}After the issuer funds the drop, run the airdrop from the
            per-payout page: batched token transfers push each recipient&apos;s
            share straight to their wallet and record the signature next to
            each row.
          </>
        ) : (
          " The admin-wallet push airdrop is not enabled on this network."
        )}
      </p>
    </div>
  );
}

function CreateModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  const toast = useToast();

  const [assetMint, setAssetMint] = useState("");
  const [assetLabel, setAssetLabel] = useState("");
  const [kind, setKind] = useState<PayoutKind>("dividend");
  const [totalAmount, setTotalAmount] = useState("");
  const [currency, setCurrency] = useState("USDC");
  const [paymentMint, setPaymentMint] = useState(() => defaultPaymentMint(detectNetwork()) ?? "");
  const [paymentDecimals, setPaymentDecimals] = useState("6");
  const [notes, setNotes] = useState("");
  const [csvText, setCsvText] = useState("");
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState<SnapshotRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});

  const validation = useMemo(
    () =>
      validateAll(
        { assetMint, totalAmount, currency, paymentMint, paymentDecimals },
        {
          assetMint: combine(required("Asset mint"), base58Pubkey),
          totalAmount: positiveNumber("Total amount"),
          currency: required("Currency"),
          paymentMint: (v: string) => (v.trim() ? base58Pubkey(v) : null),
          paymentDecimals: (v: string) =>
            /^\d{1,2}$/.test(v.trim()) && Number(v) <= 12
              ? null
              : "Decimals must be a whole number between 0 and 12.",
        },
      ),
    [assetMint, totalAmount, currency, paymentMint, paymentDecimals],
  );
  const errors = validation.errors;
  const touch = (k: string) =>
    setTouched((t) => (t[k] ? t : { ...t, [k]: true }));

  function handleCsvChange(text: string) {
    setCsvText(text);
    if (!text.trim()) {
      setSnapshot([]);
      setParseErrors([]);
      return;
    }
    const { rows, errors } = parseSnapshotCsv(text);
    setSnapshot(rows);
    setParseErrors(errors);
  }

  function handleFile(file: File) {
    void file.text().then(handleCsvChange);
  }

  const totalShares = useMemo(
    () => snapshot.reduce((acc, r) => acc + r.shares, 0),
    [snapshot],
  );
  const totalAmountNum = Number(totalAmount);
  const perShare =
    totalShares > 0 && Number.isFinite(totalAmountNum)
      ? totalAmountNum / totalShares
      : 0;

  const canSubmit =
    snapshot.length > 0 &&
    parseErrors.length === 0 &&
    validation.isValid &&
    !!wallet;

  async function submit() {
    if (!wallet || !conn.wallet) return;
    setBusy(true);
    try {
      const built = await buildMerkle(snapshot, totalAmountNum);

      // Signed + admin-gated server route (/api/payouts/create); the route
      // stamps author, holder_count and merkle_built_at server-side.
      const payoutId = await createPayout(
        conn.wallet,
        {
          asset_mint: assetMint.trim(),
          asset_label: assetLabel.trim() || assetMint.slice(0, 8),
          kind,
          total_amount: totalAmountNum,
          currency: currency.trim().toUpperCase(),
          per_share: built.perShare,
          snapshot_source: "csv",
          total_shares: built.totalShares,
          merkle_root: built.rootHex,
          status: "merkle_built",
          payment_mint: paymentMint.trim() || null,
          payment_decimals: Number(paymentDecimals),
          notes,
        },
        built.perWallet.map((w) => ({
          wallet: w.wallet,
          shares: w.shares,
          amount: w.amount,
          merkle_index: w.index,
          merkle_proof: w.proofHex,
        })),
      );

      void recordAudit({
        ix_name: "create_payout",
        category: "other",
        actor_wallet: wallet,
        reason: notes || `${KIND_LABEL[kind]} for ${assetLabel || assetMint}`,
        target_label: assetLabel || assetMint.slice(0, 8),
        metadata: {
          payout_id: payoutId,
          kind,
          total_amount: totalAmountNum,
          currency,
          holder_count: snapshot.length,
          merkle_root: built.rootHex,
        },
      });

      toast.show({
        kind: "success",
        title: "Payout created",
        description: `${snapshot.length} recipients, root ${built.rootHex.slice(0, 12)}…`,
      });
      onSuccess();
    } catch (err) {
      toast.showError(
        "Create failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            New payout
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Upload a snapshot CSV (wallet,shares), choose the asset, kind and
            total amount. Merkle root is computed locally before save.
          </p>
        </div>
        <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <FieldLabel required>Asset mint</FieldLabel>
            <input
              type="text"
              value={assetMint}
              onChange={(e) => setAssetMint(e.target.value)}
              onBlur={() => touch("assetMint")}
              placeholder="Base58 mint address"
              aria-invalid={touched.assetMint && !!errors.assetMint}
              className={`mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs focus:outline-none ${
                touched.assetMint && errors.assetMint
                  ? "border-red-400 focus:border-red-500"
                  : "border-slate-300 focus:border-slate-400"
              }`}
            />
            <FieldError error={touched.assetMint ? errors.assetMint : null} />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Asset label
            </span>
            <input
              type="text"
              value={assetLabel}
              onChange={(e) => setAssetLabel(e.target.value)}
              placeholder="e.g. ACME Series A"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Kind
            </span>
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as PayoutKind)}
              className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            >
              {Object.entries(KIND_LABEL).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <FieldLabel required>Total amount</FieldLabel>
            <input
              type="number"
              min="0"
              step="any"
              value={totalAmount}
              onChange={(e) => setTotalAmount(e.target.value)}
              onBlur={() => touch("totalAmount")}
              placeholder="0"
              aria-invalid={touched.totalAmount && !!errors.totalAmount}
              className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
                touched.totalAmount && errors.totalAmount
                  ? "border-red-400 focus:border-red-500"
                  : "border-slate-300 focus:border-slate-400"
              }`}
            />
            <FieldError
              error={touched.totalAmount ? errors.totalAmount : null}
            />
          </label>
          <label className="block">
            <FieldLabel required>Currency</FieldLabel>
            <input
              type="text"
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              onBlur={() => touch("currency")}
              placeholder="USDC"
              aria-invalid={touched.currency && !!errors.currency}
              className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
                touched.currency && errors.currency
                  ? "border-red-400 focus:border-red-500"
                  : "border-slate-300 focus:border-slate-400"
              }`}
            />
            <FieldError error={touched.currency ? errors.currency : null} />
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Payment mint
            </span>
            <input
              type="text"
              value={paymentMint}
              onChange={(e) => setPaymentMint(e.target.value)}
              onBlur={() => touch("paymentMint")}
              placeholder="Base58 mint of the payout token (e.g. USDC)"
              aria-invalid={touched.paymentMint && !!errors.paymentMint}
              className={`mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs focus:outline-none ${
                touched.paymentMint && errors.paymentMint
                  ? "border-red-400 focus:border-red-500"
                  : "border-slate-300 focus:border-slate-400"
              }`}
            />
            <FieldError
              error={touched.paymentMint ? errors.paymentMint : null}
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              {features().payoutAirdrop
                ? "Needed to run the push airdrop. Can be left blank for off-chain payouts."
                : "Recorded with the payout. Can be left blank for off-chain payouts."}
            </span>
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Decimals
            </span>
            <input
              type="number"
              min="0"
              max="12"
              step="1"
              value={paymentDecimals}
              onChange={(e) => setPaymentDecimals(e.target.value)}
              onBlur={() => touch("paymentDecimals")}
              aria-invalid={touched.paymentDecimals && !!errors.paymentDecimals}
              className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
                touched.paymentDecimals && errors.paymentDecimals
                  ? "border-red-400 focus:border-red-500"
                  : "border-slate-300 focus:border-slate-400"
              }`}
            />
            <FieldError
              error={touched.paymentDecimals ? errors.paymentDecimals : null}
            />
          </label>

          <label className="block sm:col-span-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Snapshot CSV
            </span>
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) handleFile(f);
              }}
              className="mt-1 block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-white hover:file:bg-slate-800"
            />
            <textarea
              value={csvText}
              onChange={(e) => handleCsvChange(e.target.value)}
              rows={6}
              placeholder={"wallet,shares\nFc1234...abcd,100\nGh5678...wxyz,50"}
              className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
            />
            {parseErrors.length > 0 && (
              <ul className="mt-2 list-disc space-y-0.5 pl-5 text-[11px] text-red-700">
                {parseErrors.slice(0, 5).map((e) => (
                  <li key={e}>{e}</li>
                ))}
                {parseErrors.length > 5 && (
                  <li>+ {parseErrors.length - 5} more…</li>
                )}
              </ul>
            )}
          </label>

          <label className="block sm:col-span-2">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Notes
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Q4 2026 dividend, snapshot taken from cap table"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
        </div>

        {snapshot.length > 0 && (
          <div className="border-t border-slate-100 bg-slate-50 px-5 py-3 text-xs text-slate-700">
            <p>
              <span className="font-semibold">{snapshot.length}</span>{" "}
              recipients,{" "}
              <span className="font-semibold">
                {totalShares.toLocaleString("en-US", {
                  maximumFractionDigits: 4,
                })}
              </span>{" "}
              shares.
              {totalAmountNum > 0 && (
                <>
                  {" "}
                  Per-share ≈{" "}
                  <span className="font-mono">
                    {perShare.toLocaleString("en-US", {
                      maximumFractionDigits: 8,
                    })}
                  </span>{" "}
                  {currency.toUpperCase()}.
                </>
              )}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 bg-white px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit || busy}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? "Building…" : "Build Merkle & save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// On-chain PayoutVault oversight (startup-raise vested escrows)
//
// Separate from the off-chain Merkle drop tool above. These are the
// program-owned payout vaults opened when a startup sale closes; admins enforce
// the founder-accountability lifecycle: freeze a vault on missed updates, open
// and finalize the investor vote, and route distributed yield.
// ════════════════════════════════════════════════════════════════════════════

function PayoutVaultOversight() {
  const client = useSolanaClient();
  const [vaults, setVaults] = useState<PayoutVaultRecord[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const all = await loadPayoutVaults(client.runtime.rpc);
      setVaults(all);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    if (!vaults) return [];
    return [...vaults].sort((a, b) =>
      Number(b.vault.startTs - a.vault.startTs),
    );
  }, [vaults]);

  const selectedRecord = useMemo(
    () => rows.find((r) => r.address.toString() === selected) ?? null,
    [rows, selected],
  );

  return (
    <section className="mt-12 border-t-2 border-slate-200 pt-8">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          On-chain · startup raises
        </p>
        <h2 className="mt-1 text-lg font-semibold text-slate-900">
          Payout vaults
        </h2>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Program-owned vested escrows for startup raises. Enforce founder
          accountability — freeze on missed updates, run the investor vote, and
          route distributed yield. All actions are admin-gated and logged.
        </p>
      </div>

      {failed ? (
        <p className="mt-6 text-sm text-red-600">
          Failed to load payout vaults.
        </p>
      ) : vaults === null ? (
        <div className="mt-6">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
          No payout vaults on-chain yet. They appear when a startup sale closes.
        </div>
      ) : (
        <div className="mt-6 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Vault</th>
                <th className="px-4 py-3 text-right font-medium">Released</th>
                <th className="px-4 py-3 text-right font-medium">Overdue</th>
                <th className="px-4 py-3 font-medium">State</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((r) => {
                const v = r.vault;
                const isSel = selected === r.address.toString();
                const overdue = periodsOverdue(v, now);
                return (
                  <tr
                    key={r.address.toString()}
                    onClick={() =>
                      setSelected(isSel ? null : r.address.toString())
                    }
                    className={`cursor-pointer transition-colors ${
                      isSel ? "bg-slate-50" : "hover:bg-slate-50/60"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-mono text-xs text-slate-900">
                        {r.address.toString().slice(0, 8)}…
                        {r.address.toString().slice(-4)}
                      </p>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        founder {v.founder.toString().slice(0, 4)}…
                        {v.founder.toString().slice(-4)}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {v.tranchesReleased}/{v.numTranches}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {v.state === PayoutVaultState.Active && overdue > 0 ? (
                        <span className="font-mono text-rose-600">
                          {overdue}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                          VAULT_STATE_BADGE[v.state]
                        }`}
                      >
                        {VAULT_STATE_LABEL[v.state]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-xs text-slate-500">
                        {isSel ? "▾ collapse" : "▸ manage"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedRecord && (
        <VaultOversightDetail
          key={selectedRecord.address}
          record={selectedRecord}
          now={now}
          onRefresh={refresh}
          onClose={() => setSelected(null)}
        />
      )}
    </section>
  );
}

function VaultOversightDetail({
  record,
  now,
  onRefresh,
  onClose,
}: {
  record: PayoutVaultRecord;
  now: number;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const v = record.vault;
  const vaultAddr = record.address.toString();

  const [confirmFreeze, setConfirmFreeze] = useState(false);
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [showVote, setShowVote] = useState(false);
  const [showRoute, setShowRoute] = useState(false);

  const client = useSolanaClient();
  const [votes, setVotes] = useState<VaultVoteRecord[]>([]);
  const [voteError, setVoteError] = useState(false);
  useEffect(() => {
    let active = true;
    void loadVaultVoteHistory(client.runtime.rpc, record.address).then((rows) => { if (active) { setVotes(rows); setVoteError(false); } }).catch(() => { if (active) setVoteError(true); });
    return () => { active = false; };
  }, [client, record.address, v.voteRound, v.votePending]);
  const currentVote = votes.find(({ vote }) => vote.payoutVault === record.address && vote.round === v.voteRound)?.vote ?? null;
  const voteActions = vaultVoteActions(v, currentVote, now);
  const overdue = periodsOverdue(v, now);
  const freezable = isFreezable(v, now);

  function logAudit(
    ixName: string,
    reason: string,
    extra: Record<string, unknown>,
    status: "success" | "failed",
    signature?: string,
  ) {
    if (!wallet) return;
    void recordAudit({
      ix_name: ixName,
      category: "launchpad",
      actor_wallet: wallet.toString(),
      reason,
      target_label: `payout vault ${vaultAddr.slice(0, 8)}…`,
      tx_signature: signature,
      status,
      metadata: { vault: vaultAddr, ...extra },
    });
  }

  async function freeze(reason: string) {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending("Freezing vault…", reason);
    try {
      const signer = walletSigner(conn.wallet);
      const vaultPda = await payoutVaultPda(v.sale);
      const ix = getFreezeVaultInstruction({ vault: vaultPda });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Vault frozen" });
      logAudit("freeze_vault", reason, { overdue }, "success", sig);
      setConfirmFreeze(false);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const msg = explainSendError(err);
      toast.showError("Failed to freeze", msg);
      logAudit("freeze_vault", reason, { error: msg }, "failed");
    }
  }

  async function finalize(reason: string) {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending("Finalizing vault vote…", reason);
    try {
      const signer = walletSigner(conn.wallet);
      const vaultPda = await payoutVaultPda(v.sale);
      if (!voteActions.canFinalize) throw new Error("The current vote is not ready to finalize");
      const ix = getFinalizeVaultVoteInstruction({ vault: vaultPda, vote: await vaultVotePda(vaultPda, v.voteRound) });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Vote finalized" });
      logAudit("finalize_vault_vote", reason, {}, "success", sig);
      setConfirmFinalize(false);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      const msg = explainSendError(err);
      toast.showError("Failed to finalize", msg);
      logAudit("finalize_vault_vote", reason, { error: msg }, "failed");
    }
  }

  return (
    <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Vault oversight
          </p>
          <h3 className="mt-1 break-all font-mono text-sm font-semibold text-slate-900">
            {vaultAddr}
          </h3>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-xs text-slate-400 hover:text-slate-700"
        >
          Close ✕
        </button>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Field label="State" value={VAULT_STATE_LABEL[v.state]} />
        <Field
          label="Tranches"
          value={`${v.tranchesReleased} / ${v.numTranches} released`}
        />
        <Field
          label="Updates posted"
          value={`${v.updatesPosted} / ${v.numTranches}`}
        />
        <Field
          label="Periods overdue"
          value={
            v.state === PayoutVaultState.Active ? String(overdue) : "—"
          }
        />
        <Field
          label="Escrowed"
          value={`${String(v.totalAmount)} (released ${String(v.released)})`}
        />
        <Field
          label="Total voting weight"
          value={String(v.totalWeight)}
        />
        <Field label="Founder" value={v.founder.toString()} mono />
        <Field label="Payment mint" value={v.paymentMint.toString()} mono />
        <Field label="Escrow" value={v.escrow.toString()} mono />
        <Field label="Sale" value={v.sale.toString()} mono />
      </dl>

      <PayoutSnapshotReview key={vaultAddr} vault={vaultAddr} currentRound={v.voteRound} />
      <p className="mt-3 text-sm">Vote round: {String(v.voteRound)} · {v.votePending ? "Pending" : "No open vote"}</p>
      {voteError ? <p className="mt-2 text-xs text-rose-700">Vote history is unavailable. Finalization is disabled until the current round is verified.</p> : <VaultVoteHistory records={votes} currentRound={v.voteRound} />}
      <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Admin actions
        </p>
        <div className="flex flex-wrap gap-2">
          {v.state === PayoutVaultState.Active && (
            <button
              type="button"
              disabled={tx.isSending || !freezable}
              onClick={() => setConfirmFreeze(true)}
              title={
                !freezable
                  ? `Needs ${MISSED_UPDATES_TO_FREEZE}+ overdue updates (currently ${overdue}).`
                  : undefined
              }
              className="rounded-lg border border-rose-300 bg-rose-50 px-4 py-2 text-sm font-medium text-rose-900 hover:bg-rose-100 disabled:opacity-50"
            >
              Freeze vault
            </button>
          )}
          {v.state === PayoutVaultState.Active && (
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => setShowRoute(true)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
            >
              Route yield
            </button>
          )}
          {v.state === PayoutVaultState.Frozen && (
            <>
              <button
                type="button"
                disabled={tx.isSending || !voteActions.canOpen}
                onClick={() => setShowVote(true)}
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                Open vault vote
              </button>
              <button
                type="button"
                disabled={tx.isSending || voteError || !voteActions.canFinalize}
                onClick={() => setConfirmFinalize(true)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
              >
                Finalize vote
              </button>
            </>
          )}
          {(v.state === PayoutVaultState.Completed ||
            v.state === PayoutVaultState.Cancelled) && (
            <p className="text-sm text-slate-500">
              Terminal state — no further admin actions.
            </p>
          )}
        </div>
      </div>

      <ConfirmModal
        open={confirmFreeze}
        onClose={() => setConfirmFreeze(false)}
        onConfirm={(reason) => freeze(reason)}
        title="Freeze payout vault"
        kind="destructive"
        confirmLabel="Freeze vault"
        description={
          <>
            <p>
              Freezing halts founder tranche releases after{" "}
              {MISSED_UPDATES_TO_FREEZE}+ missed monthly updates (currently{" "}
              {overdue} overdue). Investors can then vote to return capital or
              resume.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason recorded in audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />

      <ConfirmModal
        open={confirmFinalize}
        onClose={() => setConfirmFinalize(false)}
        onConfirm={(reason) => finalize(reason)}
        title="Finalize vault vote"
        kind="warning"
        confirmLabel="Finalize vote"
        description={
          <>
            <p>
              Tallies the investor vote (only after its voting period ends). A
              return-capital majority <strong>cancels</strong> the vault;
              otherwise the schedule resumes from where it stalled.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason recorded in audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />

      {showVote && (
        <OpenVoteModal
          record={record}
          onClose={() => setShowVote(false)}
          onSuccess={() => {
            void onRefresh();
            setShowVote(false);
          }}
        />
      )}

      {showRoute && (
        <RouteYieldModal
          record={record}
          onClose={() => setShowRoute(false)}
          onSuccess={() => {
            void onRefresh();
            setShowRoute(false);
          }}
        />
      )}
    </div>
  );
}

const MISSED_UPDATES_TO_FREEZE = 3;

type PreparedVaultSnapshot = SnapshotMerkle & { snapshot: PreparedPayoutSnapshot };
/** Persist the approved original investor list before creating an on-chain root. */
function VaultSnapshotBuilder({ record, kind, built, onBuilt, disabled }: {
  record: PayoutVaultRecord; kind: PayoutSnapshotKind; built: PreparedVaultSnapshot | null;
  onBuilt: (b: PreparedVaultSnapshot | null) => void; disabled: boolean;
}) {
  const conn = useWalletConnection();
  const [csvText, setCsvText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const round = kind === "vault_vote" ? String(record.vault.voteRound + BigInt(1)) : "0";
  function show(snapshot: PreparedPayoutSnapshot) {
    onBuilt({ snapshot, root: snapshotBytes(snapshot.root_hex), rootHex: snapshot.root_hex,
      totalWeight: BigInt(snapshot.total_weight), count: snapshot.entry_count });
  }
  async function prepare() {
    setBusy(true); setError(null); onBuilt(null);
    try {
      const parsed = parseWeightCsv(csvText);
      if (parsed.errors.length) throw new Error(parsed.errors.slice(0, 3).join(" · "));
      show(await preparePayoutSnapshot(conn.wallet, kind, record.address, round, parsed.rows.map((r) => ({ wallet: r.wallet, weight: String(r.weight) }))));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  async function restore() {
    setBusy(true); setError(null); onBuilt(null);
    try {
      const { snapshots } = await readPayoutSnapshots(conn.wallet, record.address);
      const root = Array.from(record.vault.investorYieldRoot, (b) => b.toString(16).padStart(2, "0")).join("");
      const match = snapshots.find((s) => s.kind === kind && s.round === round && (kind !== "investor_yield" || /^0+$/.test(root) || s.root_hex === root));
      if (!match) throw new Error("No saved original snapshot for this vault and round. Restore the approved original investor CSV.");
      show(match);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  return <div className="space-y-3 rounded-lg border border-slate-200 p-3">
    <p className="text-xs text-slate-600">Use the approved original investor list. The saved snapshot preserves entitlements after token balances change. It must be saved before the transaction; chain verification follows separately.</p>
    <textarea value={csvText} disabled={disabled || busy} onChange={(e) => { setCsvText(e.target.value); onBuilt(null); }} rows={4} placeholder={"wallet,weight\nInvestorAddress,100"} aria-label="Original investor snapshot CSV" className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs" />
    <div className="flex flex-wrap gap-2"><button type="button" disabled={disabled || busy || !conn.wallet} onClick={() => void prepare()} className="rounded-md bg-emerald-700 px-3 py-2 text-xs font-medium text-white disabled:opacity-50">{busy ? "Working…" : "Save original snapshot"}</button><button type="button" disabled={disabled || busy || !conn.wallet} onClick={() => void restore()} className="rounded-md border border-slate-300 px-3 py-2 text-xs disabled:opacity-50">Load saved snapshot</button></div>
    {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
    {built && <dl className="space-y-1 break-all text-xs text-slate-700"><dt className="font-semibold">{built.snapshot.status === "bound" ? "Verified on chain" : "Saved · awaiting on-chain verification"}</dt><dd>{built.count} investors · total weight {String(built.totalWeight)}</dd><dd>Root: {built.rootHex}</dd><dd>Snapshot: {built.snapshot.id}</dd></dl>}
  </div>;
}

function OpenVoteModal({
  record,
  onClose,
  onSuccess,
}: {
  record: PayoutVaultRecord;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const v = record.vault;

  const [built, setBuilt] = useState<PreparedVaultSnapshot | null>(null);
  const [votingDays, setVotingDays] = useState("7");
  const [reason, setReason] = useState("");
  const [submittedSignature, setSubmittedSignature] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  async function verifySaved() {
    if (!built) return;
    setVerifying(true); setVerificationError(null);
    try { await bindPayoutSnapshot(conn.wallet, built.snapshot.id); onSuccess(); }
    catch (err) { setVerificationError(err instanceof Error ? err.message : String(err)); }
    finally { setVerifying(false); }
  }

  const daysOk = /^[1-9]\d*$/.test(votingDays.trim());
  const canSubmit =
    !!wallet &&
    !!built &&
    built.totalWeight > BigInt(0) &&
    daysOk &&
    reason.trim().length >= 4;

  async function submit() {
    if (submittedSignature) { await verifySaved(); return; }
    if (
      !wallet ||
      !conn.wallet ||
      !built ||
      built.totalWeight <= BigInt(0) ||
      !daysOk
    )
      return;
    const pendingId = toast.showPending("Opening vault vote…", reason);
    try {
      const signer = walletSigner(conn.wallet);
      const vaultPda = await payoutVaultPda(v.sale);
      const votingPeriod = BigInt(votingDays) * BigInt(86400);
      if (!vaultVoteActions(v, null, Math.floor(Date.now() / 1000)).canOpen) throw new Error("A vote is already pending or the vault is not frozen");
      const ix = await getOpenVaultVoteInstructionAsync({
        authority: signer,
        vault: vaultPda,
        vote: await vaultVotePda(vaultPda, v.voteRound + BigInt(1)),
        snapshotRoot: built.root,
        totalWeight: built.totalWeight,
        votingPeriod,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      setSubmittedSignature(sig);
      toast.showTx(sig, { title: "Vault vote opened" });
      void recordAudit({
        ix_name: "open_vault_vote",
        category: "launchpad",
        actor_wallet: wallet.toString(),
        reason,
        target_label: `payout vault ${record.address.toString().slice(0, 8)}…`,
        tx_signature: sig,
        metadata: {
          vault: record.address.toString(),
          vote_round: String(v.voteRound + BigInt(1)),
          snapshot_root: built.rootHex,
          total_weight: String(built.totalWeight),
          holder_count: built.count,
          voting_days: votingDays,
        },
      });
      await verifySaved();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to open vote", explainSendError(err));
    }
  }

  if (!wallet) return null;

  return (
    <ModalShell title="Open vault vote" busy={tx.isSending} onClose={onClose}>
      <p className="text-xs text-slate-500">
        Opens the frozen-vault investor governance vote. The voting-weight
        snapshot uses the saved original investor list. The verified root and
        total weight below are read-only.
      </p>
      <VaultSnapshotBuilder
        record={record}
        kind="vault_vote"
        built={built}
        onBuilt={setBuilt}
        disabled={tx.isSending || verifying || !!submittedSignature}
      />
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Voting window (days)
        </span>
        <input
          value={votingDays}
          inputMode="numeric"
          onChange={(e) => setVotingDays(e.target.value.replace(/\D/g, ""))}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Reason (audit log)
        </span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why this vote is being opened"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        />
      </label>
      {submittedSignature && <p className="text-xs text-emerald-800">Transaction sent: {submittedSignature}. Only snapshot verification remains; this action will not send it again.</p>}
      {verificationError && <p role="alert" className="text-xs text-rose-700">{verificationError}</p>}
      <ModalFooter
        onClose={onClose}
        onConfirm={() => void submit()}
        busy={tx.isSending || verifying}
        disabled={!canSubmit && !submittedSignature}
        confirmLabel={submittedSignature ? "Verify saved snapshot" : "Open vote"}
      />
    </ModalShell>
  );
}

function RouteYieldModal({
  record,
  onClose,
  onSuccess,
}: {
  record: PayoutVaultRecord;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const v = record.vault;
  const paymentMint = v.paymentMint;

  const [amount, setAmount] = useState("");
  const [built, setBuilt] = useState<PreparedVaultSnapshot | null>(null);
  const [treasury, setTreasury] = useState<{
    ata: Address;
    owner: string;
    ownerAddress: Address;
    tokenProgram: Address;
  } | null>(null);
  const [treasuryError, setTreasuryError] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [submittedSignature, setSubmittedSignature] = useState<string | null>(null);
  const [verificationError, setVerificationError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  async function verifySaved() {
    if (!built) return;
    setVerifying(true); setVerificationError(null);
    try { await bindPayoutSnapshot(conn.wallet, built.snapshot.id); onSuccess(); }
    catch (err) { setVerificationError(err instanceof Error ? err.message : String(err)); }
    finally { setVerifying(false); }
  }

  // Resolve the finalized protocol treasury and actual payment token program.
  // The program independently binds treasury token ownership to Platform.
  // Routing yield deposits into the vault (an entry path): the payment mint
  // must pass the plain-payment rule (and, on mainnet, the allowlist).
  const resolveTreasury = useCallback(async () => {
    setTreasury(null);
    setTreasuryError(null);
    try {
      const [platformPda] = await findPlatformPda();
      const [maybe, { owner: tokenProgram }] = await Promise.all([
        fetchMaybePlatform(client.runtime.rpc, platformPda, { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) }),
        inspectPaymentMint(client.runtime.rpc, paymentMint, detectNetwork(), { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) }),
      ]);
      if (!maybe.exists || maybe.programAddress !== ASSET_REGISTRY_PROGRAM_ADDRESS) {
        throw new Error("Platform account not found on this network.");
      }
      const owner = maybe.data.protocolTreasury;
      const [ata] = await findAssociatedTokenPda({
        owner,
        tokenProgram,
        mint: paymentMint,
      });
      setTreasury({ ata, owner: owner.toString(), ownerAddress: owner, tokenProgram });
    } catch (err) {
      setTreasuryError(err instanceof Error ? err.message : String(err));
    }
  }, [client, paymentMint]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void resolveTreasury();
  }, [resolveTreasury]);

  const amountOk = /^[1-9]\d{0,19}$/.test(amount.trim()) && BigInt(amount) >= BigInt(3) && BigInt(amount) <= BigInt("18446744073709551615");
  const canSubmit =
    !!wallet &&
    amountOk &&
    !!built &&
    built.totalWeight > BigInt(0) &&
    !!treasury &&
    reason.trim().length >= 4;

  async function submit() {
    if (submittedSignature) { await verifySaved(); return; }
    if (
      !wallet ||
      !conn.wallet ||
      !built ||
      built.totalWeight <= BigInt(0) ||
      !amountOk ||
      !treasury
    )
      return;
    const pendingId = toast.showPending("Routing yield…", reason);
    try {
      const signer = walletSigner(conn.wallet);
      const vaultPda = await payoutVaultPda(v.sale);
      const escrow = await payoutEscrowPda(vaultPda);
      // Admin's own payment ATA is the distribution source (authority-owned).
      const [source] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: treasury.tokenProgram,
        mint: v.paymentMint,
      });
      // route_yield reads platform_treasury as an existing token account (no
      // init_if_needed on-chain), so its ATA must exist or the tx reverts with
      // AccountNotInitialized. The treasury is a derived ATA that may never have
      // been created — prepend an idempotent create-ATA (payer = admin signer),
      // matching the funder/holder/refund ATA pattern used elsewhere here.
      const createTreasuryAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: treasury.ownerAddress,
          mint: v.paymentMint,
          tokenProgram: treasury.tokenProgram,
        });
      // adminRecord (["admin", authority]) is auto-resolved by the async builder.
      const ix = await getRouteYieldInstructionAsync({
        authority: signer,
        vault: vaultPda,
        source,
        escrow,
        platformTreasury: treasury.ata,
        paymentMint: v.paymentMint,
        paymentTokenProgram: treasury.tokenProgram,
        amount: BigInt(amount),
        investorRoot: built.root,
        totalWeight: built.totalWeight,
      });
      const sig = await tx.send({
        instructions: [createTreasuryAtaIx, ix],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      setSubmittedSignature(sig);
      toast.showTx(sig, { title: "Yield routed" });
      void recordAudit({
        ix_name: "route_yield",
        category: "launchpad",
        actor_wallet: wallet.toString(),
        reason,
        target_label: `payout vault ${record.address.toString().slice(0, 8)}…`,
        tx_signature: sig,
        metadata: {
          vault: record.address.toString(),
          amount,
          investor_root: built.rootHex,
          total_weight: String(built.totalWeight),
          holder_count: built.count,
          platform_treasury: treasury.ata.toString(),
        },
      });
      await verifySaved();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to route yield", explainSendError(err));
    }
  }

  if (!wallet) return null;

  return (
    <ModalShell title="Route yield" busy={tx.isSending} onClose={onClose}>
      <p className="text-xs text-slate-500">
        Splits distributed yield in thirds: founder + investor pool stay in the
        vault escrow, the platform third is sent immediately to the treasury. The
        amount comes from your own payment account. The investor distribution
        root comes from the saved original investor list and cannot change after funding.
      </p>
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Amount (base units, ≥ 3)
        </span>
        <input
          value={amount}
          inputMode="numeric"
          onChange={(e) => setAmount(e.target.value.replace(/\D/g, ""))}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        />
      </label>
      <div className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Platform treasury token account
        </span>
        {treasury ? (
          <>
            <p className="mt-1 break-all rounded-md border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-800">
              {treasury.ata.toString()}
            </p>
            <span className="mt-1 block text-[11px] text-slate-400">
              Resolved on-chain: the payment-mint ATA of the platform&apos;s
              protocol treasury ({treasury.owner.slice(0, 4)}…
              {treasury.owner.slice(-4)}).
            </span>
          </>
        ) : treasuryError ? (
          <p className="mt-1 text-[11px] text-rose-600">
            {treasuryError}{" "}
            <button
              type="button"
              onClick={() => void resolveTreasury()}
              className="underline underline-offset-2"
            >
              Retry
            </button>
          </p>
        ) : (
          <p className="mt-1 text-[11px] text-slate-400">
            Resolving the protocol treasury on-chain…
          </p>
        )}
      </div>
      <VaultSnapshotBuilder
        record={record}
        kind="investor_yield"
        built={built}
        onBuilt={setBuilt}
        disabled={tx.isSending || verifying || !!submittedSignature}
      />
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Reason (audit log)
        </span>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Source / purpose of this distribution"
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
        />
      </label>
      {submittedSignature && <p className="text-xs text-emerald-800">Transaction sent: {submittedSignature}. Only snapshot verification remains; this action will not send it again.</p>}
      {verificationError && <p role="alert" className="text-xs text-rose-700">{verificationError}</p>}
      <ModalFooter
        onClose={onClose}
        onConfirm={() => void submit()}
        busy={tx.isSending || verifying}
        disabled={!canSubmit && !submittedSignature}
        confirmLabel={submittedSignature ? "Verify saved snapshot" : "Route yield"}
      />
    </ModalShell>
  );
}

function ModalShell({
  title,
  busy,
  onClose,
  children,
}: {
  title: string;
  busy: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="mx-auto w-full max-w-xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
        <div className="border-b border-slate-100 px-5 py-4">
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
            {title}
          </p>
        </div>
        <div className="space-y-4 px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

function ModalFooter({
  onClose,
  onConfirm,
  busy,
  disabled,
  confirmLabel,
}: {
  onClose: () => void;
  onConfirm: () => void;
  busy: boolean;
  disabled: boolean;
  confirmLabel: string;
}) {
  return (
    <div className="-mx-5 -mb-4 mt-2 flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy || disabled}
        className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
      >
        {busy ? "Sending…" : confirmLabel}
      </button>
    </div>
  );
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd
        className={`mt-0.5 break-all text-slate-800 ${mono ? "font-mono text-xs" : "text-sm"}`}
      >
        {value}
      </dd>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════════
// Payout schedules (table payout_schedules, migration 0033)
//
// Planning registry for recurring payouts: the panel flags OVERDUE schedules
// (red) and ones due within 14 days (amber). "Start distribution" prefills the
// push-distribution card below; "Mark done" advances next_due by one cadence
// period through the signed upsert route. No keeper/cron exists — "due" is
// computed at read time (follow-up documented in lib/payout-schedules.ts).
// ════════════════════════════════════════════════════════════════════════════

type ScheduleScOption = { pda: string; label: string; mint: string };

const DUE_BADGE: Record<string, string> = {
  overdue: "bg-rose-100 text-rose-800 border-rose-200",
  due_soon: "bg-amber-100 text-amber-800 border-amber-200",
  upcoming: "bg-slate-100 text-slate-600 border-slate-300",
};

function DueSchedulesPanel({
  onStartDistribution,
}: {
  onStartDistribution: (p: DistributionPrefill) => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [schedules, setSchedules] = useState<PayoutSchedule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scOptions, setScOptions] = useState<ScheduleScOption[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [editing, setEditing] = useState<PayoutSchedule | "new" | null>(null);
  const [markDone, setMarkDone] = useState<PayoutSchedule | null>(null);
  const [deleting, setDeleting] = useState<PayoutSchedule | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const rows = await listPayoutSchedules();
      setSchedules(rows);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Share-class labels + mints (cosmetic for the table, feeds the CRUD modal).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const network = await loadNetworkPreferIndexer(() =>
          loadNetwork(client.runtime.rpc),
        );
        const assetName = new Map<string, string>();
        for (const a of network.assets) {
          const [apda] = await findAssetPda({
            issuer: a.issuer,
            assetId: a.assetId,
          });
          assetName.set(apda.toString(), a.name);
        }
        const opts: ScheduleScOption[] = [];
        for (const sc of network.shareClasses) {
          const scPda = await findShareClassPda(sc.asset, sc.classIndex);
          const name =
            assetName.get(sc.asset.toString()) ??
            `${sc.asset.toString().slice(0, 8)}…`;
          opts.push({
            pda: scPda.toString(),
            label: `${name} · class #${sc.classIndex}`,
            mint: sc.mint.toString(),
          });
        }
        if (!cancelled) setScOptions(opts);
      } catch {
        // Label resolution failing must not break the panel — PDAs render raw.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  const scLabel = useCallback(
    (pda: string) =>
      scOptions.find((o) => o.pda === pda)?.label ??
      `${pda.slice(0, 8)}…${pda.slice(-4)}`,
    [scOptions],
  );

  const today = todayIso();
  const dueRows = useMemo(
    () =>
      (schedules ?? []).filter(
        (s) => s.active && scheduleDueStatus(s.next_due, today) !== "upcoming",
      ),
    [schedules, today],
  );
  const overdueCount = dueRows.filter(
    (s) => scheduleDueStatus(s.next_due, today) === "overdue",
  ).length;
  const visible = showAll ? (schedules ?? []) : dueRows;

  async function confirmMarkDone(reason: string) {
    const s = markDone;
    if (!s || !conn.wallet) return;
    setBusy(true);
    try {
      const nextDue = advanceCadence(s.next_due, s.cadence);
      await upsertPayoutSchedule(conn.wallet, {
        id: s.id,
        share_class_pda: s.share_class_pda,
        mint: s.mint,
        label: s.label,
        cadence: s.cadence,
        next_due: nextDue,
        // numeric may deserialize as a string depending on the PostgREST
        // version — the route strictly requires a number.
        amount_hint: s.amount_hint === null ? null : Number(s.amount_hint),
        payment_mint: s.payment_mint,
        active: s.active,
        notes: s.notes,
      });
      void recordAudit({
        ix_name: "payout_schedule_mark_done",
        category: "other",
        actor_wallet: wallet?.toString() ?? "",
        reason: reason || `Marked ${s.label || s.share_class_pda} as paid`,
        target_label: scLabel(s.share_class_pda),
        metadata: {
          schedule_id: s.id,
          previous_due: s.next_due,
          next_due: nextDue,
          cadence: s.cadence,
        },
      });
      toast.show({
        kind: "success",
        title: "Schedule advanced",
        description: `Next due ${nextDue}.`,
      });
      setMarkDone(null);
      await refresh();
    } catch (err) {
      toast.showError(
        "Mark done failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(reason: string) {
    const s = deleting;
    if (!s || !conn.wallet) return;
    setBusy(true);
    try {
      await deletePayoutSchedule(conn.wallet, s.id);
      void recordAudit({
        ix_name: "payout_schedule_delete",
        category: "other",
        actor_wallet: wallet?.toString() ?? "",
        reason,
        target_label: scLabel(s.share_class_pda),
        metadata: { schedule_id: s.id, next_due: s.next_due },
      });
      toast.show({ kind: "success", title: "Schedule removed" });
      setDeleting(null);
      await refresh();
    } catch (err) {
      toast.showError(
        "Delete failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      id="payout-schedules"
      className="mt-8 rounded-xl border border-slate-200 bg-white p-6 shadow-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Recurring · payout schedules
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            Due schedules
          </h2>
          <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
            Registered payout cadences per share class. Overdue rows are red,
            rows due within 14 days amber. Start the distribution from the row,
            then mark it done to roll the date forward one period.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing("new")}
          disabled={!wallet}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          New schedule
        </button>
      </div>

      {loadError ? (
        <p className="mt-4 text-sm text-red-600">
          Failed to load schedules: {loadError}
        </p>
      ) : schedules === null ? (
        <div className="mt-4">
          <SkeletonTable rows={2} cols={5} />
        </div>
      ) : (
        <>
          {overdueCount > 0 && (
            <div className="mt-4 rounded-lg border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-medium text-rose-800">
              {overdueCount} schedule{overdueCount === 1 ? "" : "s"} overdue —
              start the distribution or mark the row done.
            </div>
          )}
          {visible.length === 0 ? (
            <p className="mt-4 rounded-lg border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-500">
              {showAll
                ? "No payout schedules yet."
                : "Nothing overdue or due in the next 14 days."}
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-lg border border-slate-200">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5">Share class</th>
                    <th className="px-4 py-2.5">Cadence</th>
                    <th className="px-4 py-2.5">Next due</th>
                    <th className="px-4 py-2.5 text-right">Amount hint</th>
                    <th className="px-4 py-2.5 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {visible.map((s) => {
                    const status = scheduleDueStatus(s.next_due, today);
                    const days = daysUntil(s.next_due, today);
                    const dueText = !s.active
                      ? "inactive"
                      : status === "overdue"
                        ? `${-days}d overdue`
                        : status === "due_soon"
                          ? days === 0
                            ? "due today"
                            : `in ${days}d`
                          : `in ${days}d`;
                    return (
                      <tr
                        key={s.id}
                        className={
                          !s.active
                            ? "bg-slate-50/60 text-slate-400"
                            : status === "overdue"
                              ? "bg-rose-50/60"
                              : status === "due_soon"
                                ? "bg-amber-50/50"
                                : undefined
                        }
                      >
                        <td className="px-4 py-2.5">
                          <p className="font-medium text-slate-900">
                            {s.label || scLabel(s.share_class_pda)}
                          </p>
                          <p className="font-mono text-[11px] text-slate-500">
                            {s.label
                              ? scLabel(s.share_class_pda)
                              : `${s.share_class_pda.slice(0, 8)}…${s.share_class_pda.slice(-4)}`}
                          </p>
                        </td>
                        <td className="px-4 py-2.5 text-slate-700">
                          {CADENCE_LABEL[s.cadence]}
                        </td>
                        <td className="px-4 py-2.5">
                          <span className="text-slate-800">{s.next_due}</span>{" "}
                          <span
                            className={`ml-1 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                              s.active
                                ? DUE_BADGE[status]
                                : "border-slate-300 bg-slate-100 text-slate-500"
                            }`}
                          >
                            {dueText}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-slate-700">
                          {s.amount_hint !== null
                            ? Number(s.amount_hint).toLocaleString("en-US", {
                                maximumFractionDigits: 6,
                              })
                            : "—"}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <div className="flex justify-end gap-2 whitespace-nowrap text-xs">
                            <button
                              type="button"
                              onClick={() =>
                                onStartDistribution({
                                  shareClassPda: s.share_class_pda,
                                  totalAmount:
                                    s.amount_hint !== null
                                      ? String(Math.trunc(Number(s.amount_hint)))
                                      : undefined,
                                  paymentMint: s.payment_mint ?? undefined,
                                })
                              }
                              className="rounded-md border border-slate-300 px-2.5 py-1 font-medium text-slate-700 hover:border-slate-400"
                            >
                              Start distribution
                            </button>
                            <button
                              type="button"
                              onClick={() => setMarkDone(s)}
                              disabled={!wallet}
                              className="rounded-md border border-emerald-300 bg-emerald-50 px-2.5 py-1 font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
                            >
                              Mark done
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditing(s)}
                              disabled={!wallet}
                              className="rounded-md px-2 py-1 text-slate-500 underline-offset-2 hover:underline disabled:opacity-50"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => setDeleting(s)}
                              disabled={!wallet}
                              className="rounded-md px-2 py-1 text-rose-600 underline-offset-2 hover:underline disabled:opacity-50"
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="mt-3 text-xs text-slate-500 underline-offset-2 hover:underline"
          >
            {showAll
              ? "Show due only"
              : `Show all schedules (${schedules.length})`}
          </button>
        </>
      )}

      {editing !== null && (
        <ScheduleModal
          schedule={editing === "new" ? null : editing}
          scOptions={scOptions}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refresh();
          }}
          scLabel={scLabel}
        />
      )}

      <ConfirmModal
        open={markDone !== null}
        onClose={() => setMarkDone(null)}
        onConfirm={confirmMarkDone}
        title="Mark schedule as paid"
        kind="info"
        confirmLabel="Mark done"
        requireReason={false}
        description={
          markDone && (
            <p>
              Advances <strong>{markDone.label || scLabel(markDone.share_class_pda)}</strong>{" "}
              from {markDone.next_due} to{" "}
              <strong>
                {advanceCadence(markDone.next_due, markDone.cadence)}
              </strong>{" "}
              ({CADENCE_LABEL[markDone.cadence].toLowerCase()} cadence). Use
              after the payout for the current period has been executed.
            </p>
          )
        }
        busy={busy}
      />

      <ConfirmModal
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={confirmDelete}
        title="Delete payout schedule"
        kind="destructive"
        confirmLabel="Delete schedule"
        description={
          deleting && (
            <p>
              Removes the {CADENCE_LABEL[deleting.cadence].toLowerCase()}{" "}
              schedule for{" "}
              <strong>
                {deleting.label || scLabel(deleting.share_class_pda)}
              </strong>{" "}
              (next due {deleting.next_due}). To pause instead of deleting,
              edit the row and untick <em>Active</em>.
            </p>
          )
        }
        busy={busy}
      />
    </section>
  );
}

function ScheduleModal({
  schedule,
  scOptions,
  scLabel,
  onClose,
  onSaved,
}: {
  /** null = create. */
  schedule: PayoutSchedule | null;
  scOptions: ScheduleScOption[];
  scLabel: (pda: string) => string;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  // If the edited row references a share class the network scan didn't return
  // (e.g. indexer lag), keep it selectable so editing never corrupts the PDA.
  const options = useMemo<ScheduleScOption[]>(() => {
    if (
      schedule &&
      !scOptions.some((o) => o.pda === schedule.share_class_pda)
    ) {
      return [
        {
          pda: schedule.share_class_pda,
          label: scLabel(schedule.share_class_pda),
          mint: schedule.mint ?? "",
        },
        ...scOptions,
      ];
    }
    return scOptions;
  }, [schedule, scOptions, scLabel]);

  const [scPda, setScPda] = useState(
    schedule?.share_class_pda ?? options[0]?.pda ?? "",
  );
  const [label, setLabel] = useState(schedule?.label ?? "");
  const [cadence, setCadence] = useState<PayoutCadence>(
    schedule?.cadence ?? "monthly",
  );
  const [nextDue, setNextDue] = useState(schedule?.next_due ?? todayIso());
  const [amountHint, setAmountHint] = useState(
    schedule?.amount_hint !== null && schedule?.amount_hint !== undefined
      ? String(schedule.amount_hint)
      : "",
  );
  // A new schedule starts with the network's USDC; an edited one keeps its own (or none).
  const [paymentMint, setPaymentMint] = useState(() =>
    schedule ? (schedule.payment_mint ?? "") : (defaultPaymentMint(detectNetwork()) ?? ""),
  );
  const [active, setActive] = useState(schedule?.active ?? true);
  const [notes, setNotes] = useState(schedule?.notes ?? "");
  const [busy, setBusy] = useState(false);

  const amountOk =
    amountHint.trim() === "" ||
    (Number.isFinite(Number(amountHint)) && Number(amountHint) >= 0);
  const paymentMintOk =
    paymentMint.trim() === "" || isAddress(paymentMint.trim());
  const dateOk = /^\d{4}-\d{2}-\d{2}$/.test(nextDue);
  const canSubmit = !!wallet && !!scPda && dateOk && amountOk && paymentMintOk;

  async function submit() {
    if (!conn.wallet || !canSubmit) return;
    setBusy(true);
    try {
      const selected = options.find((o) => o.pda === scPda);
      const id = await upsertPayoutSchedule(conn.wallet, {
        id: schedule?.id,
        share_class_pda: scPda,
        mint: selected?.mint || schedule?.mint || null,
        label: label.trim() || null,
        cadence,
        next_due: nextDue,
        amount_hint: amountHint.trim() === "" ? null : Number(amountHint),
        payment_mint: paymentMint.trim() || null,
        active,
        notes: notes.trim() || null,
      });
      void recordAudit({
        ix_name: schedule
          ? "payout_schedule_update"
          : "payout_schedule_create",
        category: "other",
        actor_wallet: wallet?.toString() ?? "",
        reason: label.trim() || `${CADENCE_LABEL[cadence]} payout schedule`,
        target_label: scLabel(scPda),
        metadata: {
          schedule_id: id,
          cadence,
          next_due: nextDue,
          amount_hint: amountHint.trim() || null,
          active,
        },
      });
      toast.show({
        kind: "success",
        title: schedule ? "Schedule updated" : "Schedule created",
        description: `${CADENCE_LABEL[cadence]} · next due ${nextDue}.`,
      });
      await onSaved();
    } catch (err) {
      toast.showError(
        "Save failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      title={schedule ? "Edit payout schedule" : "New payout schedule"}
      busy={busy}
      onClose={onClose}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <FieldLabel required>Share class</FieldLabel>
          <select
            value={scPda}
            onChange={(e) => setScPda(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          >
            {options.map((o) => (
              <option key={o.pda} value={o.pda}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Label
          </span>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={120}
            placeholder="e.g. Quarterly dividend"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
        </label>
        <label className="block">
          <FieldLabel required>Cadence</FieldLabel>
          <select
            value={cadence}
            onChange={(e) => setCadence(e.target.value as PayoutCadence)}
            className="mt-1 w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          >
            {CADENCES.map((c) => (
              <option key={c} value={c}>
                {CADENCE_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <FieldLabel required>Next due</FieldLabel>
          <input
            type="date"
            value={nextDue}
            onChange={(e) => setNextDue(e.target.value)}
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
          <FieldError error={dateOk ? null : "Pick a valid date."} />
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Amount hint
          </span>
          <input
            type="number"
            min="0"
            step="any"
            value={amountHint}
            onChange={(e) => setAmountHint(e.target.value)}
            placeholder="e.g. 1000000"
            aria-invalid={!amountOk}
            className={`mt-1 w-full rounded-md border px-3 py-2 text-sm focus:outline-none ${
              amountOk
                ? "border-slate-300 focus:border-slate-400"
                : "border-red-400 focus:border-red-500"
            }`}
          />
          <span className="mt-1 block text-[11px] text-slate-400">
            Optional. Prefills the distribution amount — use payment-mint base
            units to make the prefill exact.
          </span>
          <FieldError
            error={amountOk ? null : "Must be a non-negative number."}
          />
        </label>
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Payment mint
          </span>
          <input
            type="text"
            value={paymentMint}
            onChange={(e) => setPaymentMint(e.target.value)}
            placeholder="Base58 mint (e.g. USDC) — optional"
            aria-invalid={!paymentMintOk}
            className={`mt-1 w-full rounded-md border px-3 py-2 font-mono text-xs focus:outline-none ${
              paymentMintOk
                ? "border-slate-300 focus:border-slate-400"
                : "border-red-400 focus:border-red-500"
            }`}
          />
          <FieldError
            error={paymentMintOk ? null : "Not a valid base58 address."}
          />
        </label>
        <label className="flex items-center gap-2 sm:col-span-2">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
          />
          <span className="text-sm text-slate-700">
            Active (shows in the due panel and on the issuer page)
          </span>
        </label>
        <label className="block sm:col-span-2">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
            Notes
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder="PUBLIC — readable by anyone (the table is world-readable via the anon key). Never record client-specific commercial terms here."
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
          />
          <span className="mt-1 block text-[11px] text-amber-700">
            Not an internal field: payout_schedules has a public read policy,
            so this text is visible to anyone — keep confidential terms in the
            fees register, not here.
          </span>
        </label>
      </div>
      <ModalFooter
        onClose={onClose}
        onConfirm={() => void submit()}
        busy={busy}
        disabled={!canSubmit}
        confirmLabel={schedule ? "Save changes" : "Create schedule"}
      />
    </ModalShell>
  );
}

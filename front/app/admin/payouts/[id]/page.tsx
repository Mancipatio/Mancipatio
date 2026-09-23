"use client";

import { WALLET_CONNECT_DESCRIPTION } from "@/lib/wallet-copy";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type Address } from "@solana/kit";
import { useSendTransaction, useWalletConnection } from "@solana/react-hooks";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getTransferCheckedInstruction,
} from "@solana-program/token-2022";
import { ConfirmModal } from "@/components/confirm-modal";
import { RequireRole } from "@/components/require-role";
import { SkeletonCard, SkeletonTable } from "@/components/skeleton";
import { useRole } from "@/lib/auth";
import { featureDisabledMessage, features } from "@/lib/features";
import {
  markPayoutRecipientsClaimed,
  setPayoutRecipientsSendError,
  toBaseUnits,
  updatePayout,
  type Payout,
  type PayoutRecipient,
  type PayoutStatus,
} from "@/lib/payouts";
import { getSupabase, recordAudit } from "@/lib/supabase";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { walletSigner } from "@/lib/wallet-signer";

const TOKEN_2022_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const TOKEN_CLASSIC_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

/** Recipients per transaction: 2 instructions each (create ATA + transfer). */
const AIRDROP_BATCH = 8;

/** Admin-wallet push airdrop — feature-flagged per network (lib/features.ts;
 *  off on mainnet unless NEXT_PUBLIC_FEATURE_PAYOUT_AIRDROP=true). The API
 *  refuses airdropStarted / mark_claimed with it off, so the UI must never
 *  send a transfer it could not record. */
const AIRDROP_ENABLED = features().payoutAirdrop;

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

export default function PayoutDetailPage() {
  const params = useParams<{ id: string }>();
  return (
    <section className="min-w-0 flex-1">
      <Link
        href="/admin/payouts"
        className="text-xs uppercase tracking-widest text-slate-500 hover:text-slate-700"
      >
        ← Payouts
      </Link>
      <RequireRole role="admin">
        <PayoutDetail id={params.id} />
      </RequireRole>
    </section>
  );
}

function PayoutDetail({ id }: { id: string }) {
  const router = useRouter();
  const conn = useWalletConnection();
  const wallet = conn.wallet?.account.address;
  const { isSuperAdmin } = useRole();
  const toast = useToast();

  const [payout, setPayout] = useState<Payout | null | "missing">(null);
  const [recipients, setRecipients] = useState<PayoutRecipient[] | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const tx = useSendTransaction();
  const [confirmAirdrop, setConfirmAirdrop] = useState(false);
  const [airdropRunning, setAirdropRunning] = useState(false);
  const [tokenProgramChoice, setTokenProgramChoice] = useState<
    "classic" | "token2022"
  >("classic");

  const refresh = useCallback(async () => {
    const sb = getSupabase();
    if (!sb) return;
    const [{ data: p, error: pErr }, { data: rc }] = await Promise.all([
      sb.from("payouts").select("*").eq("id", id).maybeSingle(),
      sb
        .from("payout_recipients")
        .select("*")
        .eq("payout_id", id)
        .order("merkle_index", { ascending: true }),
    ]);
    if (pErr) {
      toast.showError("Load failed", pErr.message);
      return;
    }
    setPayout((p as Payout | null) ?? "missing");
    setRecipients((rc ?? []) as PayoutRecipient[]);
  }, [id, toast]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const claimedCount = useMemo(
    () => recipients?.filter((r) => r.claimed).length ?? 0,
    [recipients],
  );
  const claimedAmount = useMemo(
    () =>
      recipients
        ?.filter((r) => r.claimed)
        .reduce((acc, r) => acc + Number(r.amount), 0) ?? 0,
    [recipients],
  );
  const filtered = useMemo(() => {
    if (!recipients) return [];
    const q = query.trim().toLowerCase();
    if (!q) return recipients;
    return recipients.filter((r) => r.wallet.toLowerCase().includes(q));
  }, [recipients, query]);

  async function updateStatus(next: PayoutStatus, reason: string) {
    if (!payout || payout === "missing" || !wallet || !conn.wallet) return;
    setBusy(true);
    try {
      // Signed + admin-gated route; funded_at is stamped server-side.
      await updatePayout(conn.wallet, id, { status: next });
      void recordAudit({
        ix_name: "update_payout_status",
        category: "other",
        actor_wallet: wallet,
        reason,
        target_label: payout.asset_label || payout.asset_mint.slice(0, 8),
        metadata: {
          payout_id: id,
          previous: payout.status,
          next,
        },
      });
      toast.show({ kind: "success", title: `Status → ${STATUS_LABEL[next]}` });
      await refresh();
    } catch (err) {
      toast.showError(
        "Update failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function runAirdrop(reason: string) {
    if (!AIRDROP_ENABLED) {
      toast.showError("Airdrop disabled", featureDisabledMessage("payoutAirdrop"));
      return;
    }
    if (!payout || payout === "missing" || !recipients) return;
    if (!wallet || !conn.wallet) return;
    const session = conn.wallet;
    if (payout.status === "cancelled") return;
    if (!payout.payment_mint) {
      toast.showError(
        "No payment mint",
        "This payout was created without a payment mint, so the airdrop cannot run.",
      );
      return;
    }

    setAirdropRunning(true);
    const pendingId = toast.showPending(
      "Running airdrop…",
      "Batched transfers — approve each transaction in your wallet.",
    );
    try {
      const signer = walletSigner(conn.wallet);
      const mint = payout.payment_mint as Address;
      const tokenProgram =
        tokenProgramChoice === "token2022"
          ? TOKEN_2022_ADDRESS
          : TOKEN_CLASSIC_ADDRESS;
      const decimals = payout.payment_decimals ?? 6;
      const [sourceAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram,
        mint,
      });

      if (!payout.airdrop_started_at) {
        await updatePayout(session, id, { airdropStarted: true });
      }

      void recordAudit({
        ix_name: "run_airdrop",
        category: "other",
        actor_wallet: wallet,
        reason,
        target_label: payout.asset_label || payout.asset_mint.slice(0, 8),
        metadata: {
          payout_id: id,
          payment_mint: payout.payment_mint,
          payment_decimals: decimals,
          token_program: tokenProgramChoice,
          pending: recipients.filter((r) => !r.claimed).length,
          total: recipients.length,
        },
      });

      const pending = recipients.filter((r) => !r.claimed);
      for (let i = 0; i < pending.length; i += AIRDROP_BATCH) {
        const batch = pending.slice(i, i + AIRDROP_BATCH);
        const batchWallets = batch.map((r) => r.wallet);
        try {
          const instructions = [];
          for (const r of batch) {
            const owner = r.wallet as Address;
            const [destAta] = await findAssociatedTokenPda({
              owner,
              tokenProgram,
              mint,
            });
            instructions.push(
              await getCreateAssociatedTokenIdempotentInstructionAsync({
                payer: signer,
                owner,
                mint,
                tokenProgram,
              }),
            );
            // A RAW `transfer_checked` is correct here and must stay raw.
            // This is a wallet → wallet airdrop of the PAYMENT token from the
            // distributing admin's own account: no program escrow is involved,
            // so there is no deposit ledger to credit and no program
            // instruction that would accept it. (Contrast the escrow-funding
            // paths — offers, custody vaults, OTC legs — which all go through
            // the program precisely because their payouts are decided against
            // a ledger, not against a token balance.)
            instructions.push(
              getTransferCheckedInstruction(
                {
                  source: sourceAta,
                  mint,
                  destination: destAta,
                  authority: signer,
                  amount: toBaseUnits(r.amount, decimals),
                  decimals,
                },
                { programAddress: tokenProgram },
              ),
            );
          }
          const signature = await tx.send({ instructions, feePayer: signer });
          const nowIso = new Date().toISOString();
          try {
            await markPayoutRecipientsClaimed(session, id, batchWallets, signature);
          } catch (markErr) {
            throw new Error(
              `Batch sent (tx ${signature}) but recording failed: ${
                markErr instanceof Error ? markErr.message : String(markErr)
              }. Fix connectivity before resuming or this batch will be re-sent.`,
            );
          }
          const done = new Set(batchWallets);
          setRecipients((prev) =>
            prev
              ? prev.map((r) =>
                  done.has(r.wallet)
                    ? {
                        ...r,
                        claimed: true,
                        claimed_at: nowIso,
                        claimed_tx: signature,
                        send_error: null,
                      }
                    : r,
                )
              : prev,
          );
        } catch (err) {
          const msg = explainSendError(err);
          try {
            await setPayoutRecipientsSendError(session, id, batchWallets, msg);
          } catch (recErr) {
            console.warn("[payouts] recording send_error failed:", recErr);
          }
          toast.dismiss(pendingId);
          toast.showError("Airdrop halted", msg);
          await refresh();
          return;
        }
      }

      // Everyone is paid — stamp completion and advance the status.
      if (recipients.length > 0) {
        await updatePayout(session, id, {
          airdropCompleted: true,
          status: "claimed_full",
        });
      }
      toast.dismiss(pendingId);
      toast.show({
        kind: "success",
        title: "Airdrop complete",
        description: `${recipients.length} recipients paid out.`,
      });
      await refresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Airdrop failed",
        err instanceof Error ? err.message : String(err),
      );
      await refresh();
    } finally {
      setAirdropRunning(false);
    }
  }

  function exportCsv() {
    if (!recipients || !payout || payout === "missing") return;
    const header =
      "wallet,shares,amount,merkle_index,claimed,claimed_tx,send_error,merkle_proof";
    const lines = recipients.map((r) =>
      [
        r.wallet,
        r.shares,
        r.amount,
        r.merkle_index,
        r.claimed ? "true" : "false",
        r.claimed_tx ?? "",
        (r.send_error ?? "").replace(/[,\r\n]+/g, " "),
        r.merkle_proof.join("|"),
      ].join(","),
    );
    const blob = new Blob([header + "\n" + lines.join("\n")], {
      type: "text/csv;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `payout-${id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (payout === null) {
    return (
      <div className="mt-6 space-y-4">
        <SkeletonCard rows={4} />
        <SkeletonTable rows={5} cols={5} />
      </div>
    );
  }

  if (payout === "missing") {
    return (
      <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
        Payout <span className="font-mono">{id}</span> not found. It may have
        been deleted.{" "}
        <button
          type="button"
          onClick={() => router.push("/admin/payouts")}
          className="ml-2 underline"
        >
          Back to list
        </button>
      </div>
    );
  }

  return (
    <div className="mt-4 space-y-6">
      <header className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-slate-500">
              {payout.kind}
            </p>
            <h1 className="mt-1 text-xl font-semibold text-slate-900">
              {payout.asset_label || "Unlabeled asset"}
            </h1>
            <p className="mt-1 font-mono text-xs text-slate-500">
              {payout.asset_mint}
            </p>
          </div>
          <span
            className={`rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wider ${STATUS_BADGE[payout.status]}`}
          >
            {STATUS_LABEL[payout.status]}
          </span>
        </div>

        <dl className="mt-6 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">
              Total amount
            </dt>
            <dd className="mt-1 text-lg font-semibold text-slate-900">
              {Number(payout.total_amount).toLocaleString("en-US", {
                maximumFractionDigits: 4,
              })}{" "}
              <span className="text-sm text-slate-500">{payout.currency}</span>
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">
              Per share
            </dt>
            <dd className="mt-1 font-mono text-sm text-slate-900">
              {payout.per_share
                ? Number(payout.per_share).toLocaleString("en-US", {
                    maximumFractionDigits: 8,
                  })
                : "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">
              Holders
            </dt>
            <dd className="mt-1 text-sm text-slate-900">
              {payout.holder_count} ({Number(payout.total_shares).toLocaleString(
                "en-US",
                { maximumFractionDigits: 4 },
              )}{" "}
              shares)
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">
              Snapshot at
            </dt>
            <dd className="mt-1 text-sm text-slate-700">
              {new Date(payout.snapshot_at)
                .toISOString()
                .replace("T", " ")
                .slice(0, 19)}{" "}
              ({payout.snapshot_source})
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">
              Merkle root
            </dt>
            <dd className="mt-1 break-all font-mono text-[11px] text-slate-700">
              {payout.merkle_root ?? "—"}
            </dd>
          </div>
          <div>
            <dt className="text-[10px] uppercase tracking-wider text-slate-500">
              Author
            </dt>
            <dd className="mt-1 font-mono text-[11px] text-slate-700">
              {payout.author.slice(0, 8)}…{payout.author.slice(-4)}
            </dd>
          </div>
        </dl>

        {payout.notes && (
          <p className="mt-4 rounded-md bg-slate-50 p-3 text-xs text-slate-700">
            {payout.notes}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {payout.status === "merkle_built" && (
            <button
              type="button"
              onClick={() =>
                void updateStatus("funded", "Escrow funded off-chain")
              }
              disabled={busy}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-700 disabled:opacity-50"
            >
              Mark as funded
            </button>
          )}
          {/* "live" means the admin-wallet airdrop is running; with that
              feature off the API refuses it (payouts/update), so no button. */}
          {payout.status === "funded" && AIRDROP_ENABLED && (
            <button
              type="button"
              onClick={() =>
                void updateStatus("live", "Airdrop execution opened")
              }
              disabled={busy}
              className="rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Go live
            </button>
          )}
          {payout.status === "live" &&
            recipients !== null &&
            claimedCount === recipients.length &&
            recipients.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  void updateStatus("claimed_full", "All recipients claimed")
                }
                disabled={busy}
                className="rounded-md bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
              >
                Mark fully claimed
              </button>
            )}
          {isSuperAdmin &&
            payout.status !== "cancelled" &&
            payout.status !== "claimed_full" && (
              <button
                type="button"
                onClick={() => setConfirmCancel(true)}
                disabled={busy}
                className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
              >
                Cancel payout
              </button>
            )}
          <button
            type="button"
            onClick={exportCsv}
            className="ml-auto rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            Export CSV
          </button>
        </div>
      </header>

      {(payout.status === "funded" || payout.status === "live") &&
        !AIRDROP_ENABLED && (
          <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">
              Airdrop execution
            </h2>
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-slate-600">
              {featureDisabledMessage("payoutAirdrop")} Distribute on-chain
              from{" "}
              <Link
                href="/admin/payouts#push-distributions"
                className="font-medium text-slate-900 underline underline-offset-2"
              >
                Push distributions
              </Link>{" "}
              on the Payouts page instead.
            </p>
          </section>
        )}

      {(payout.status === "funded" || payout.status === "live") &&
        AIRDROP_ENABLED && (
        <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">
                Airdrop execution
              </h2>
              <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-slate-600">
                Pushes each recipient&apos;s proportionate amount straight to
                their wallet in batches of {AIRDROP_BATCH} transfers per
                transaction. Missing recipient token accounts are created
                automatically (rent paid by you). Already-sent rows are skipped
                on resume.
              </p>
            </div>
            <p className="text-sm font-semibold text-slate-900">
              {claimedCount}/{recipients?.length ?? 0}{" "}
              <span className="font-normal text-slate-500">sent</span>
            </p>
          </div>

          <dl className="mt-4 grid gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                Payment mint
              </dt>
              <dd className="mt-1 break-all font-mono text-[11px] text-slate-700">
                {payout.payment_mint ?? "— not set (created before airdrops)"}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                Decimals
              </dt>
              <dd className="mt-1 text-sm text-slate-900">
                {payout.payment_decimals ?? 6}
              </dd>
            </div>
            <div>
              <dt className="text-[10px] uppercase tracking-wider text-slate-500">
                Started / completed
              </dt>
              <dd className="mt-1 text-xs text-slate-700">
                {payout.airdrop_started_at
                  ? new Date(payout.airdrop_started_at)
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")
                  : "not started"}
                {" · "}
                {payout.airdrop_completed_at
                  ? new Date(payout.airdrop_completed_at)
                      .toISOString()
                      .slice(0, 16)
                      .replace("T", " ")
                  : "—"}
              </dd>
            </div>
          </dl>

          <p className="mt-3 rounded-md bg-slate-50 p-3 text-xs text-slate-600">
            Funds are drawn from the{" "}
            <span className="font-semibold">
              connected wallet&apos;s associated token account
            </span>{" "}
            for the payment mint — make sure the issuer&apos;s funding has
            landed there before running.
            {wallet ? (
              <>
                {" "}
                Connected:{" "}
                <span className="font-mono">
                  {wallet.toString().slice(0, 8)}…{wallet.toString().slice(-4)}
                </span>
              </>
            ) : (
              ` ${WALLET_CONNECT_DESCRIPTION}`
            )}
          </p>

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Token program
              </span>
              <select
                value={tokenProgramChoice}
                onChange={(e) =>
                  setTokenProgramChoice(
                    e.target.value as "classic" | "token2022",
                  )
                }
                disabled={airdropRunning}
                className="mt-1 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              >
                <option value="classic">Classic SPL (USDC etc.)</option>
                <option value="token2022">Token-2022</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => setConfirmAirdrop(true)}
              disabled={
                airdropRunning ||
                busy ||
                !wallet ||
                !payout.payment_mint ||
                recipients === null ||
                recipients.length === 0 ||
                claimedCount === recipients.length
              }
              className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800 disabled:opacity-50"
            >
              {airdropRunning
                ? "Sending…"
                : payout.airdrop_started_at || claimedCount > 0
                  ? "Resume airdrop"
                  : "Run airdrop"}
            </button>
          </div>
        </section>
      )}

      <section>
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-widest text-slate-500">
            Recipients
          </h2>
          <p className="text-xs text-slate-600">
            {claimedCount} / {recipients?.length ?? 0} sent (
            {claimedAmount.toLocaleString("en-US", {
              maximumFractionDigits: 4,
            })}{" "}
            {payout.currency})
          </p>
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search wallet…"
          className="mt-3 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none sm:max-w-sm"
        />

        {recipients === null ? (
          <div className="mt-3">
            <SkeletonTable rows={5} cols={5} />
          </div>
        ) : recipients.length === 0 ? (
          <p className="mt-3 rounded-md border border-dashed border-slate-300 bg-white p-4 text-center text-xs text-slate-500">
            No recipients on this payout.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">#</th>
                  <th className="px-4 py-3">Wallet</th>
                  <th className="px-4 py-3 text-right">Shares</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Tx / error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.slice(0, 500).map((r) => (
                  <tr key={r.wallet} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-mono text-[11px] text-slate-500">
                      {r.merkle_index}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-700">
                      {r.wallet}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {Number(r.shares).toLocaleString("en-US", {
                        maximumFractionDigits: 4,
                      })}
                    </td>
                    <td className="px-4 py-2 text-right">
                      {Number(r.amount).toLocaleString("en-US", {
                        maximumFractionDigits: 8,
                      })}
                    </td>
                    <td className="px-4 py-2 text-xs">
                      {r.claimed ? (
                        <span className="text-emerald-700">
                          Sent{" "}
                          {r.claimed_at &&
                            new Date(r.claimed_at)
                              .toISOString()
                              .slice(0, 10)}
                        </span>
                      ) : r.send_error ? (
                        <span className="text-red-700">Failed</span>
                      ) : (
                        <span className="text-slate-500">Pending</span>
                      )}
                    </td>
                    <td className="max-w-[200px] px-4 py-2 text-xs">
                      {r.claimed && r.claimed_tx ? (
                        <span
                          className="block truncate font-mono text-[11px] text-slate-500"
                          title={r.claimed_tx}
                        >
                          {r.claimed_tx.slice(0, 10)}…{r.claimed_tx.slice(-6)}
                        </span>
                      ) : r.send_error ? (
                        <span
                          className="block truncate text-[11px] text-red-600"
                          title={r.send_error}
                        >
                          {r.send_error}
                        </span>
                      ) : (
                        <span className="text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {filtered.length > 500 && (
              <p className="border-t border-slate-100 bg-slate-50 px-4 py-2 text-[11px] text-slate-500">
                Showing first 500 of {filtered.length} matching rows. Use{" "}
                <button
                  type="button"
                  onClick={exportCsv}
                  className="underline"
                >
                  Export CSV
                </button>{" "}
                for the full list.
              </p>
            )}
          </div>
        )}
      </section>

      <ConfirmModal
        open={confirmAirdrop}
        kind="warning"
        title={
          payout.airdrop_started_at || claimedCount > 0
            ? "Resume the airdrop?"
            : "Run the airdrop?"
        }
        description={
          <>
            <p>
              This sends{" "}
              <strong>
                {(recipients?.length ?? 0) - claimedCount} on-chain transfers
              </strong>{" "}
              of {payout.currency} from your connected wallet, in batches of{" "}
              {AIRDROP_BATCH} per transaction. Rows already marked as sent are
              skipped. Transfers are irreversible.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason is recorded in the audit log.
            </p>
          </>
        }
        confirmLabel={
          payout.airdrop_started_at || claimedCount > 0
            ? "Resume airdrop"
            : "Run airdrop"
        }
        requireReason
        reasonPlaceholder="e.g. Q4 dividend distribution, issuer funds received"
        busy={airdropRunning}
        onClose={() => setConfirmAirdrop(false)}
        onConfirm={async (reason) => {
          setConfirmAirdrop(false);
          await runAirdrop(reason);
        }}
      />

      <ConfirmModal
        open={confirmCancel}
        kind="destructive"
        title="Cancel this payout?"
        description="Recipients lose access to their proofs. This cannot be reversed — you'd have to create a new payout to restart."
        confirmLabel="Cancel payout"
        cancelLabel="Keep"
        requireReason
        reasonPlaceholder="Why are we cancelling this drop?"
        busy={busy}
        onClose={() => setConfirmCancel(false)}
        onConfirm={async (reason) => {
          await updateStatus("cancelled", reason);
          setConfirmCancel(false);
        }}
      />
    </div>
  );
}

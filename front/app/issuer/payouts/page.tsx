"use client";

import { WalletRequired } from "@/components/wallet-required";

import Link from "next/link";
import { type Address } from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findAssetPda,
  findIssuerPda,
  getPostUpdateInstruction,
  getReleasePayoutInstruction,
  findPlatformPda,
  PayoutVaultState,
  type Sale,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import {
  DISTRIBUTION_STATUS_BADGE,
  DISTRIBUTION_STATUS_LABEL,
  loadDistributions,
  type DistributionRecord,
} from "@/lib/distributions";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { findSalePda, findShareClassPda } from "@/lib/pdas";
import {
  hashUpdateContent,
  isFreezable,
  loadPayoutVaults,
  nextReleaseReady,
  nextUpdateDue,
  payoutEscrowPda,
  payoutVaultPda,
  periodsOverdue,
  periodTs,
  toHex,
  VAULT_STATE_BADGE,
  VAULT_STATE_LABEL,
  type PayoutVaultRecord,
} from "@/lib/payout-vault";
import {
  CADENCE_LABEL,
  listPayoutSchedules,
  type PayoutSchedule,
} from "@/lib/payout-schedules";
import { walletSigner } from "@/lib/wallet-signer";
import { fetchMintTokenProgram } from "@/lib/transaction-builders";
import { features } from "@/lib/features";
import { issuerSyncInstructions, issuerVaultsFor } from "@/lib/issuer-authority";
import { explainSendError } from "@/lib/tx-error";
import { SkeletonTable } from "@/components/skeleton";
import { ConfirmModal } from "@/components/confirm-modal";
import { useToast } from "@/lib/toast";

const ISSUER_ROTATION = features().issuerRotation;

type VaultLink = {
  record: PayoutVaultRecord;
  sale: Sale | undefined;
  shareClass: ShareClass | undefined;
  assetName: string | undefined;
  assetId: string | undefined;
  /** The vault's founder is an earlier issuer key (2C-2): sync before acting. */
  founderOutOfSync: boolean;
  /** The Issuer PDA (for the sync instruction). */
  issuer: string | undefined;
};

export default function IssuerPayoutsPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const wallet = conn.wallet?.account.address;

  const [data, setData] = useState<NetworkData | null>(null);
  const [vaults, setVaults] = useState<PayoutVaultRecord[] | null>(null);
  const [distributions, setDistributions] = useState<
    DistributionRecord[] | null
  >(null);
  const [failed, setFailed] = useState(false);
  const [saleByPda, setSaleByPda] = useState<Map<string, Sale>>(new Map());
  const [scByPda, setScByPda] = useState<Map<string, ShareClass>>(new Map());
  const [assetByScPda, setAssetByScPda] = useState<
    Map<string, { name: string; assetId: string; issuer: string }>
  >(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  // Recurring payout schedules (payout_schedules, anon read) — read-only card.
  const [schedules, setSchedules] = useState<PayoutSchedule[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const rows = await listPayoutSchedules();
        if (!cancelled) setSchedules(rows);
      } catch {
        // Optional card — stays hidden if the read fails.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  // Live clock so "due / overdue" tracking updates on a long-open page.
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [network, allVaults, allDistributions] = await Promise.all([
        loadNetworkPreferIndexer(() => loadNetwork(client.runtime.rpc)),
        loadPayoutVaults(client.runtime.rpc),
        loadDistributions(client.runtime.rpc),
      ]);
      setData(network);
      setVaults(allVaults);
      setDistributions(allDistributions);

      // Resolve sale PDA → Sale.
      const sales = new Map<string, Sale>();
      for (const s of network.sales) {
        const pda = await findSalePda(s.shareClass, s.saleId);
        sales.set(pda.toString(), s);
      }
      setSaleByPda(sales);

      // Resolve share-class PDA → ShareClass, and → owning asset metadata.
      const scs = new Map<string, ShareClass>();
      const scAsset = new Map<
        string,
        { name: string; assetId: string; issuer: string }
      >();
      const assetPdaToMeta = new Map<
        string,
        { name: string; assetId: string; issuer: string }
      >();
      for (const a of network.assets) {
        const [apda] = await findAssetPda({
          issuer: a.issuer,
          assetId: a.assetId,
        });
        assetPdaToMeta.set(apda.toString(), {
          name: a.name,
          assetId: a.assetId,
          issuer: a.issuer.toString(),
        });
      }
      for (const sc of network.shareClasses) {
        const scPda = await findShareClassPda(sc.asset, sc.classIndex);
        scs.set(scPda.toString(), sc);
        const meta = assetPdaToMeta.get(sc.asset.toString());
        if (meta) scAsset.set(scPda.toString(), meta);
      }
      setScByPda(scs);
      setAssetByScPda(scAsset);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
     
    void refresh();
  }, [refresh]);

  // Connected issuer's PDA (matched by wallet authority).
  const me = useMemo(
    () =>
      data?.issuers.find((i) => i.authority.toString() === wallet?.toString()) ??
      null,
    [data, wallet],
  );
  const [myIssuerPda, setMyIssuerPda] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    async function derive() {
      if (!me) {
        setMyIssuerPda(null);
        return;
      }
      const [pda] = await findIssuerPda({ legalEntityId: me.legalEntityId });
      if (!cancelled) setMyIssuerPda(pda.toString());
    }
    void derive();
    return () => {
      cancelled = true;
    };
  }, [me]);

  // Distributions whose share class belongs to one of the issuer's assets.
  const myDistributions = useMemo(() => {
    if (!distributions || !myIssuerPda) return [];
    return distributions
      .filter(
        (r) =>
          assetByScPda.get(r.distribution.shareClass.toString())?.issuer ===
          myIssuerPda,
      )
      .sort((a, b) =>
        Number(
          b.distribution.distributionId - a.distribution.distributionId,
        ),
      );
  }, [distributions, myIssuerPda, assetByScPda]);

  // Vaults whose founder is the connected wallet, plus (2C-2) vaults of this
  // issuer's share classes still naming an earlier issuer key.
  const myVaults = useMemo<VaultLink[]>(() => {
    if (!vaults || !wallet) return [];
    return issuerVaultsFor(vaults, {
      wallet: wallet.toString(),
      issuer: myIssuerPda,
      issuerOfShareClass: (sc) => assetByScPda.get(sc)?.issuer,
      rotation: ISSUER_ROTATION,
    })
      .map(({ record, founderOutOfSync }) => {
        const sale = saleByPda.get(record.vault.sale.toString());
        const shareClass = scByPda.get(record.vault.shareClass.toString());
        const meta = assetByScPda.get(record.vault.shareClass.toString());
        return {
          record,
          sale,
          shareClass,
          assetName: meta?.name,
          assetId: meta?.assetId,
          founderOutOfSync,
          issuer: meta?.issuer,
        };
      })
      .sort((a, b) => Number(b.record.vault.startTs - a.record.vault.startTs));
  }, [vaults, wallet, myIssuerPda, saleByPda, scByPda, assetByScPda]);

  const selectedLink = useMemo(
    () => myVaults.find((v) => v.record.address.toString() === selected) ?? null,
    [myVaults, selected],
  );

  // Active schedules attached to one of this issuer's share classes
  // (listPayoutSchedules already returns them soonest-due first).
  const myUpcoming = useMemo(() => {
    if (!schedules || !myIssuerPda) return [];
    return schedules.filter(
      (s) =>
        s.active &&
        assetByScPda.get(s.share_class_pda)?.issuer === myIssuerPda,
    );
  }, [schedules, myIssuerPda, assetByScPda]);

  return (
    <main className="min-w-0 flex-1">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Payout vaults
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">
          Vested startup raises
        </h1>
        <p className="mt-2 text-sm text-slate-600">
          When a startup sale closes its proceeds are escrowed in a program-owned
          payout vault. Post a monthly update, then draw each time-gated tranche.
        </p>
      </div>

      {!wallet ? (
        <WalletRequired className="mt-8" />
      ) : failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load payout vaults.</p>
      ) : vaults === null || data === null ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : myVaults.length === 0 ? (
        <Empty />
      ) : (
        <div className="mt-8 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Vault</th>
                <th className="px-4 py-3 text-right font-medium">Released</th>
                <th className="px-4 py-3 text-right font-medium">Updates</th>
                <th className="px-4 py-3 font-medium">State</th>
                <th className="px-4 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {myVaults.map((vl) => {
                const v = vl.record.vault;
                const isSel = selected === vl.record.address.toString();
                const overdue = periodsOverdue(v, now);
                return (
                  <tr
                    key={vl.record.address.toString()}
                    onClick={() =>
                      setSelected(
                        isSel ? null : vl.record.address.toString(),
                      )
                    }
                    className={`cursor-pointer transition-colors ${
                      isSel ? "bg-slate-50" : "hover:bg-slate-50/60"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {vl.assetName ?? "(asset unknown)"}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        sale #{vl.sale ? String(vl.sale.saleId) : "?"} ·{" "}
                        {vl.assetId ?? "—"}
                      </p>
                      {vl.founderOutOfSync && (
                        <p className="mt-0.5 text-[11px] font-medium text-amber-700">
                          Founder out of sync: open to sync
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {v.tranchesReleased}/{v.numTranches}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-700">
                      <span className="font-mono">{v.updatesPosted}</span>
                      {v.state === PayoutVaultState.Active && overdue > 0 && (
                        <span className="ml-1.5 text-[11px] text-rose-600">
                          {overdue} overdue
                        </span>
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

      {selectedLink && (
        <VaultDetail
          link={selectedLink}
          now={now}
          onRefresh={refresh}
          onClose={() => setSelected(null)}
        />
      )}

      {/* ── Upcoming payouts (recurring schedules, read-only) ── */}
      {wallet && myUpcoming.length > 0 && (
        <section className="mt-12 border-t-2 border-slate-200 pt-8">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Recurring · payout schedules
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">
              Upcoming payouts
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
              Payout cadences the platform has registered for your share
              classes. Informational only — the platform runs each
              distribution on or after the due date.
            </p>
          </div>
          <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-4 py-3">Share class</th>
                  <th className="px-4 py-3">Cadence</th>
                  <th className="px-4 py-3">Next due</th>
                  <th className="px-4 py-3 text-right">Amount hint</th>
                  <th className="px-4 py-3">Payment mint</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {myUpcoming.map((s) => {
                  const meta = assetByScPda.get(s.share_class_pda);
                  const sc = scByPda.get(s.share_class_pda);
                  return (
                    <tr key={s.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-slate-900">
                          {s.label ||
                            (meta
                              ? `${meta.name}${sc ? ` · class #${sc.classIndex}` : ""}`
                              : `${s.share_class_pda.slice(0, 8)}…`)}
                        </p>
                        {s.label && meta && (
                          <p className="mt-0.5 text-xs text-slate-500">
                            {meta.name}
                            {sc ? ` · class #${sc.classIndex}` : ""}
                          </p>
                        )}
                      </td>
                      <td className="px-4 py-3 text-slate-700">
                        {CADENCE_LABEL[s.cadence]}
                      </td>
                      <td className="px-4 py-3 text-slate-800">{s.next_due}</td>
                      <td className="px-4 py-3 text-right font-mono text-slate-700">
                        {s.amount_hint !== null
                          ? Number(s.amount_hint).toLocaleString("en-US", {
                              maximumFractionDigits: 6,
                            })
                          : "—"}
                      </td>
                      <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                        {s.payment_mint
                          ? `${s.payment_mint.slice(0, 8)}…${s.payment_mint.slice(-4)}`
                          : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* ── Push distributions (on-chain revenue share) ── */}
      {wallet && data !== null && distributions !== null && (
        <section className="mt-12 border-t-2 border-slate-200 pt-8">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              On-chain · revenue share
            </p>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">
              Distributions
            </h2>
            <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
              Revenue distributions the platform runs for your share classes.
              Funds are escrowed on-chain and pushed pro-rata to holder
              payment-token accounts — amounts are payment-mint base units.
            </p>
          </div>

          {myDistributions.length === 0 ? (
            <div className="mt-6 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500">
              No distributions yet for your share classes.
            </div>
          ) : (
            <div className="mt-6 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-card">
              <table className="min-w-full divide-y divide-slate-200 text-sm">
                <thead className="bg-slate-50 text-left text-xs font-semibold uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Distribution</th>
                    <th className="px-4 py-3">Share class</th>
                    <th className="px-4 py-3">Payment mint</th>
                    <th className="px-4 py-3 text-right">Total</th>
                    <th className="px-4 py-3 text-right">Distributed</th>
                    <th className="px-4 py-3 text-right">Paid</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {myDistributions.map((r) => {
                    const d = r.distribution;
                    const meta = assetByScPda.get(d.shareClass.toString());
                    const sc = scByPda.get(d.shareClass.toString());
                    return (
                      <tr key={r.address.toString()} className="hover:bg-slate-50">
                        <td className="px-4 py-3 font-mono text-xs text-slate-900">
                          #{String(d.distributionId)}
                        </td>
                        <td className="px-4 py-3 text-slate-700">
                          {meta
                            ? `${meta.name}${sc ? ` · class #${sc.classIndex}` : ""}`
                            : `${d.shareClass.toString().slice(0, 8)}…`}
                        </td>
                        <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                          {d.paymentMint.toString().slice(0, 8)}…
                          {d.paymentMint.toString().slice(-4)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-900">
                          {String(d.totalAmount)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700">
                          {String(d.distributedAmount)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-slate-700">
                          {d.paidCount}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${DISTRIBUTION_STATUS_BADGE[d.status]}`}
                          >
                            {DISTRIBUTION_STATUS_LABEL[d.status]}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );

  function Empty() {
    return (
      <div className="mt-8 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
        <p className="text-sm text-slate-600">No payout vaults yet.</p>
        <p className="mt-1 text-xs text-slate-400">
          A vault is created when you close a{" "}
          <Link href="/issuer/launchpad" className="font-semibold underline">
            startup sale
          </Link>
          .
        </p>
      </div>
    );
  }
}

function VaultDetail({
  link,
  now,
  onRefresh,
  onClose,
}: {
  link: VaultLink;
  now: number;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const v = link.record.vault;

  const [showUpdate, setShowUpdate] = useState(false);
  const [updateText, setUpdateText] = useState("");
  const [confirmRelease, setConfirmRelease] = useState(false);

  // 2C-2: the vault still names an earlier issuer key. Every founder action
  // below prepends the permissionless sync (atomic with the action).
  const founderSyncIxs = () =>
    link.founderOutOfSync && wallet && link.issuer && link.shareClass
      ? issuerSyncInstructions({
          issuer: link.issuer as Address,
          issuerAuthority: wallet,
          vaults: [
            {
              address: link.record.address,
              shareClass: v.shareClass,
              asset: link.shareClass.asset,
              founder: v.founder,
            },
          ],
        })
      : [];

  async function syncFounder() {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending("Syncing the vault founder…");
    try {
      const signer = walletSigner(conn.wallet);
      const sig = await tx.send({ instructions: founderSyncIxs(), feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Vault founder synced" });
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to sync the vault founder", explainSendError(err));
    }
  }

  const updateDue = nextUpdateDue(v, now);
  const releaseReady = nextReleaseReady(v, now);
  const overdue = periodsOverdue(v, now);
  const freezable = isFreezable(v, now);
  const terminal =
    v.state === PayoutVaultState.Completed ||
    v.state === PayoutVaultState.Cancelled;

  async function postUpdate() {
    if (!wallet || !conn.wallet || !updateText.trim()) return;
    const pendingId = toast.showPending(
      `Posting update for period ${v.updatesPosted + 1}…`,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const vaultPda = await payoutVaultPda(v.sale);
      const contentHash = await hashUpdateContent(updateText.trim());
      const ix = getPostUpdateInstruction({
        founder: signer,
        vault: vaultPda,
        contentHash,
      });
      const sig = await tx.send({ instructions: [...founderSyncIxs(), ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Update posted" });
      setShowUpdate(false);
      setUpdateText("");
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to post update", explainSendError(err));
    }
  }

  async function release() {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending(
      `Releasing tranche ${v.tranchesReleased + 1}…`,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const vaultPda = await payoutVaultPda(v.sale);
      const escrow = await payoutEscrowPda(vaultPda);
      // The payment mint's actual token program (SPL Token or Token-2022),
      // read from chain; never assumed classic. Releasing a tranche takes
      // money OUT of the vault escrow — an exit path — so only the permissive
      // owner check applies: an existing vault can always be paid out.
      const tokenProgram = await fetchMintTokenProgram(client.runtime.rpc, v.paymentMint, {
        commitment: "finalized",
        abortSignal: AbortSignal.timeout(10_000),
      });
      // Founder payment ATA — create idempotently in case it doesn't exist yet.
      const [founderAccount] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram,
        mint: v.paymentMint,
      });
      const createAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: wallet,
          mint: v.paymentMint,
          tokenProgram,
        });
      // Emergency-pause gate (read-only) — the last named account.
      const [platform] = await findPlatformPda();
      const ix = getReleasePayoutInstruction({
        platform,
        vault: vaultPda,
        escrow,
        paymentMint: v.paymentMint,
        founderAccount,
        paymentTokenProgram: tokenProgram,
      });
      const sig = await tx.send({
        instructions: [...founderSyncIxs(), createAtaIx, ix],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Tranche released" });
      setConfirmRelease(false);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to release", explainSendError(err));
    }
  }

  const nextTrancheTs =
    v.tranchesReleased < v.numTranches
      ? periodTs(v, v.tranchesReleased)
      : null;
  const nextUpdateTs =
    v.updatesPosted < v.numTranches ? periodTs(v, v.updatesPosted) : null;

  return (
    <div className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Vault detail
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {link.assetName ?? "(asset unknown)"} ·{" "}
            {VAULT_STATE_LABEL[v.state]}
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

      {link.founderOutOfSync && (
        <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          This vault still names an earlier issuer key as its founder. Updates, releases and yield claims
          below sync it first; you can also sync it on its own.{" "}
          <button
            type="button"
            disabled={tx.isSending}
            onClick={() => void syncFounder()}
            className="ml-1 rounded-md bg-amber-700 px-2.5 py-1 font-medium text-white hover:bg-amber-800 disabled:opacity-50"
          >
            Sync founder
          </button>
        </div>
      )}

      {/* Tranche progress */}
      {v.numTranches > 0 && (
        <div className="mt-4 flex gap-1">
          {Array.from({ length: v.numTranches }).map((_, i) => (
            <div
              key={i}
              className={`h-1.5 flex-1 rounded-full ${
                i < v.tranchesReleased
                  ? "bg-emerald-500"
                  : i < v.updatesPosted
                    ? "bg-amber-300"
                    : "bg-slate-200"
              }`}
              title={
                i < v.tranchesReleased
                  ? "released"
                  : i < v.updatesPosted
                    ? "update posted"
                    : "pending"
              }
            />
          ))}
        </div>
      )}

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
        <Field
          label="Total escrowed"
          value={`${String(v.totalAmount)} (released ${String(v.released)})`}
        />
        <Field
          label="Per-tranche"
          value={String(v.trancheAmount)}
        />
        <Field
          label="Schedule"
          value={`${v.cliffMonths}mo cliff · ${v.vestingMonths}mo vesting · ${v.numTranches} tranches`}
        />
        <Field
          label="Vesting start"
          value={
            v.startTs === BigInt(0)
              ? "—"
              : new Date(Number(v.startTs) * 1000).toISOString().slice(0, 10)
          }
        />
        <Field
          label="Next update due"
          value={
            nextUpdateTs === null
              ? "all posted"
              : new Date(nextUpdateTs * 1000).toISOString().slice(0, 10)
          }
        />
        <Field
          label="Next tranche due"
          value={
            nextTrancheTs === null
              ? "all released"
              : new Date(nextTrancheTs * 1000).toISOString().slice(0, 10)
          }
        />
        <Field
          label="Updates posted"
          value={`${v.updatesPosted} / ${v.numTranches}`}
        />
        <Field label="Escrow" value={v.escrow.toString()} mono />
      </dl>

      {v.state === PayoutVaultState.Frozen && (
        <div className="mt-5 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-800">
          This vault is <strong>frozen</strong> after {overdue} missed update
          {overdue === 1 ? "" : "s"}. An investor vote decides whether capital is
          returned or the schedule resumes — handled by admins.
        </div>
      )}
      {v.state === PayoutVaultState.Active && freezable && (
        <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
          {overdue} update{overdue === 1 ? "" : "s"} overdue — at the freeze
          threshold. Post your update now to keep payouts flowing and avoid an
          investor freeze.
        </div>
      )}

      {/* Actions */}
      <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Available actions
        </p>
        <div className="flex flex-wrap gap-2">
          {v.state === PayoutVaultState.Active && (
            <>
              <button
                type="button"
                disabled={tx.isSending || !updateDue}
                onClick={() => setShowUpdate(true)}
                title={
                  !updateDue
                    ? v.updatesPosted >= v.numTranches
                      ? "All period updates posted."
                      : "Next update period has not started yet."
                    : undefined
                }
                className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                Post update
              </button>
              <button
                type="button"
                disabled={tx.isSending || !releaseReady}
                onClick={() => setConfirmRelease(true)}
                title={
                  !releaseReady
                    ? v.tranchesReleased >= v.numTranches
                      ? "All tranches released."
                      : v.updatesPosted <= v.tranchesReleased
                        ? "Post this period's update before releasing."
                        : "Next tranche is not yet time-due."
                    : undefined
                }
                className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
              >
                Release tranche
              </button>
            </>
          )}
          {terminal && (
            <p className="text-sm text-slate-500">
              {v.state === PayoutVaultState.Completed
                ? "All tranches released — vault complete."
                : "Vault cancelled — capital returned to investors."}
            </p>
          )}
          {v.state === PayoutVaultState.Frozen && (
            <p className="text-sm text-slate-500">
              No founder actions while frozen.
            </p>
          )}
        </div>
      </div>

      {/* Post-update modal */}
      {showUpdate && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget && !tx.isSending)
              setShowUpdate(false);
          }}
        >
          <div className="mx-auto w-full max-w-lg overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
            <div className="border-b border-slate-100 px-5 py-4">
              <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
                Post period {v.updatesPosted + 1} update
              </p>
              <p className="mt-1 text-xs text-slate-500">
                A SHA-256 hash of this text is committed on-chain as the period
                content hash. Keep the full text in your investor update channel.
              </p>
            </div>
            <div className="px-5 py-4">
              <textarea
                value={updateText}
                onChange={(e) => setUpdateText(e.target.value)}
                rows={5}
                placeholder="Shipped v2, MRR up 18% MoM, hired 2 engineers…"
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
              {updateText.trim() && (
                <HashPreview text={updateText.trim()} />
              )}
            </div>
            <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
              <button
                type="button"
                onClick={() => setShowUpdate(false)}
                disabled={tx.isSending}
                className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void postUpdate()}
                disabled={tx.isSending || !updateText.trim()}
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {tx.isSending ? "Sending…" : "Post update"}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmRelease}
        onClose={() => setConfirmRelease(false)}
        onConfirm={() => release()}
        title={`Release tranche ${v.tranchesReleased + 1}`}
        kind="warning"
        confirmLabel="Release tranche"
        requireReason={false}
        description={
          <>
            <p>
              Transfers tranche {v.tranchesReleased + 1} of {v.numTranches} (
              {String(v.trancheAmount)} base units, or the remainder on the final
              tranche) from the vault escrow to your payment account.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Releases are time-gated and require this period&apos;s update to be
              posted first.
            </p>
          </>
        }
        busy={tx.isSending}
      />
    </div>
  );
}

function HashPreview({ text }: { text: string }) {
  const [hex, setHex] = useState<string>("");
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const bytes = await hashUpdateContent(text);
      if (!cancelled) {
         
        setHex(toHex(bytes));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [text]);
  if (!hex) return null;
  return (
    <p className="mt-2 break-all font-mono text-[11px] text-slate-400">
      hash: {hex}
    </p>
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

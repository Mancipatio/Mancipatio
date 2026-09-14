"use client";

import { type Address } from "@solana/kit";
import { walletSigner } from "@/lib/wallet-signer";
import { hookTransferMetas } from "@/lib/hook-metas";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  fetchMaybeRightsIssuance,
  findAssetPda,
  findIssuerPda,
  getClaimMilestoneInstruction,
  getCreateRightsIssuanceInstructionAsync,
  getPublishMilestoneInstructionAsync,
  type Asset,
  type RightsIssuance,
  type ShareClass,
  type VestingMilestone,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import { fromBytes32, toBytes32 } from "@/lib/format";
import { merkleProof, merkleRoot, snapshotLeaf } from "@/lib/merkle";
import {
  findClaimPda,
  findMilestonePda,
  findRightsIssuancePda,
  findShareClassPda,
} from "@/lib/pdas";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import { RequireRole } from "@/components/require-role";
import { useToast } from "@/lib/toast";

const TOKEN_2022_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

type Entry = { address: Address; weight: bigint };

function parseSnapshot(text: string): Entry[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, w] = l.split(",").map((s) => s.trim());
      return { address: a as Address, weight: BigInt(w || "0") };
    });
}

export default function RightsPage() {
  return (
    <section className="min-w-0 flex-1">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
            Rights Token
          </p>
          <h1 className="mt-1 text-xl font-semibold text-slate-900">
            Vesting issuances
          </h1>
          <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
            Open a Rights Token issuance, publish milestone snapshots (Merkle
            roots) and watch claims arrive. Beneficiaries claim with a proof.
          </p>
        </div>
        <a
          href="/admin/rights/builder"
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400"
        >
          Open builder →
        </a>
      </div>
      <RequireRole role="admin">
        <RightsOps />
      </RequireRole>
    </section>
  );
}

function RightsOps() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  const [shareClassPdaMap, setShareClassPdaMap] = useState<
    Map<string, ShareClass>
  >(new Map());
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);
      const am = new Map<string, Asset>();
      for (const asset of network.assets) {
        const [pda] = await findAssetPda({
          issuer: asset.issuer,
          assetId: asset.assetId,
        });
        am.set(pda.toString(), asset);
      }
      setAssetPdaMap(am);
      const scm = new Map<string, ShareClass>();
      for (const sc of network.shareClasses) {
        const scPda = await findShareClassPda(sc.asset, sc.classIndex);
        scm.set(scPda.toString(), sc);
      }
      setShareClassPdaMap(scm);
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    return data.rightsIssuances
      .map((issuance, i) => {
        const sc = shareClassPdaMap.get(issuance.shareClass.toString());
        const asset = sc ? assetPdaMap.get(sc.asset.toString()) : undefined;
        return { issuance, sc, asset, originalIndex: i };
      })
      .filter(({ issuance, asset }) => {
        if (!q) return true;
        return (
          (asset?.name ?? "").toLowerCase().includes(q) ||
          String(issuance.issuanceId).includes(q)
        );
      })
      .sort((a, b) => Number(b.issuance.issuanceId - a.issuance.issuanceId));
  }, [data, assetPdaMap, shareClassPdaMap, query]);

  // Group milestones by issuance PDA.
  const milestonesByIssuance = useMemo(() => {
    if (!data) return new Map<string, VestingMilestone[]>();
    const m = new Map<string, VestingMilestone[]>();
    for (const ms of data.milestones) {
      const key = ms.issuance.toString();
      const arr = m.get(key) ?? [];
      arr.push(ms);
      m.set(key, arr);
    }
    return m;
  }, [data]);

  const selectedRow = useMemo(() => {
    if (selectedIdx === null) return null;
    return rows.find((r) => r.originalIndex === selectedIdx) ?? null;
  }, [rows, selectedIdx]);

  if (failed) {
    return (
      <p className="mt-8 text-sm text-red-600">
        Failed to load rights directory.
      </p>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by asset, issuance ID…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + New issuance
        </button>
      </div>

      {data === null ? (
        <SkeletonTable rows={5} cols={5} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {data.rightsIssuances.length === 0
              ? "No Rights Token issuances yet."
              : "No issuances match the current filter."}
          </p>
          {data.rightsIssuances.length === 0 && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Open the first issuance
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Issuance</th>
                <th className="px-4 py-3 font-medium">Underlying</th>
                <th className="px-4 py-3 text-right font-medium">Milestones</th>
                <th className="px-4 py-3 text-right font-medium">Total claimed</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ issuance, asset, originalIndex }) => {
                const isSelected = selectedIdx === originalIndex;
                return (
                  <tr
                    key={originalIndex}
                    onClick={() =>
                      setSelectedIdx(isSelected ? null : originalIndex)
                    }
                    className={`cursor-pointer transition-colors ${
                      isSelected ? "bg-slate-50" : "hover:bg-slate-50/60"
                    }`}
                  >
                    <td className="px-4 py-3">
                      <p className="font-medium text-slate-900">
                        {asset?.name || "(asset unknown)"}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-500">
                        issuance #{String(issuance.issuanceId)}
                      </p>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">
                      {issuance.underlyingMint.toString().slice(0, 6)}…
                      {issuance.underlyingMint.toString().slice(-4)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {issuance.milestonesCount}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-700">
                      {String(issuance.totalClaimed)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="text-xs text-slate-500">
                        {isSelected ? "▾ collapse" : "▸ expand"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedRow && (
        <IssuanceDetail
          issuance={selectedRow.issuance}
          asset={selectedRow.asset}
          milestonesByIssuance={milestonesByIssuance}
          onRefresh={refresh}
          onClose={() => setSelectedIdx(null)}
        />
      )}

      {showCreate && data && (
        <CreateIssuanceModal
          data={data}
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            void refresh();
            setShowCreate(false);
          }}
        />
      )}
    </div>
  );
}

function IssuanceDetail({
  issuance,
  asset,
  milestonesByIssuance,
  onRefresh,
  onClose,
}: {
  issuance: RightsIssuance;
  asset: Asset | undefined;
  milestonesByIssuance: Map<string, VestingMilestone[]>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [issuancePda, setIssuancePda] = useState<Address | null>(null);
  const [snapshot, setSnapshot] = useState("");
  const [publishIndex, setPublishIndex] = useState("0");
  const [amountPool, setAmountPool] = useState("");
  const [unlockDate, setUnlockDate] = useState("");
  const [claimIndex, setClaimIndex] = useState("0");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const pda = await findRightsIssuancePda(
        issuance.shareClass,
        issuance.issuanceId,
      );
      if (!cancelled) setIssuancePda(pda);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [issuance.shareClass, issuance.issuanceId]);

  const milestones = useMemo(() => {
    if (!issuancePda) return [];
    return (milestonesByIssuance.get(issuancePda.toString()) ?? []).sort(
      (a, b) => a.index - b.index,
    );
  }, [issuancePda, milestonesByIssuance]);

  async function publishMilestone() {
    if (!wallet || !issuancePda) return;
    const entries = parseSnapshot(snapshot);
    if (entries.length === 0) {
      toast.showError(
        "Empty snapshot",
        "Add at least one (claimer,entitlement) line.",
      );
      return;
    }
    const pendingId = toast.showPending(`Publishing milestone #${publishIndex}…`);
    try {
      const leaves = await Promise.all(
        entries.map((e) => snapshotLeaf(e.address, e.weight)),
      );
      const root = await merkleRoot(leaves);
      const unlockTs = unlockDate.trim()
        ? BigInt(Math.floor(new Date(unlockDate).getTime() / 1000))
        : BigInt(0);
      const signer = walletSigner(conn.wallet);
      const ix = await getPublishMilestoneInstructionAsync({
        authority: signer,
        rightsIssuance: issuancePda,
        index: Number(publishIndex) || 0,
        merkleRoot: root,
        amountPool: BigInt(amountPool || "0"),
        unlockTs,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Milestone published" });
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to publish",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function claim() {
    if (!wallet || !issuancePda) return;
    const entries = parseSnapshot(snapshot);
    const idx = entries.findIndex((e) => e.address === wallet);
    if (idx < 0) {
      toast.showError(
        "Not in snapshot",
        "Connected wallet does not appear in the snapshot CSV.",
      );
      return;
    }
    const pendingId = toast.showPending(
      `Claiming from milestone #${claimIndex}…`,
    );
    try {
      const leaves = await Promise.all(
        entries.map((e) => snapshotLeaf(e.address, e.weight)),
      );
      const proof = await merkleProof(leaves, idx);
      // Re-fetch issuance for up-to-date escrow/underlying.
      const iss = await fetchMaybeRightsIssuance(
        client.runtime.rpc,
        issuancePda,
      );
      if (!iss.exists) {
        toast.dismiss(pendingId);
        toast.showError("Issuance vanished", "Account no longer exists.");
        return;
      }
      const milestone = await findMilestonePda(
        issuancePda,
        Number(claimIndex) || 0,
      );
      const claimPda = await findClaimPda(milestone, wallet);
      const [claimerAta] = await findAssociatedTokenPda({
        owner: wallet,
        tokenProgram: TOKEN_2022_ADDRESS,
        mint: iss.data.underlyingMint,
      });
      const signer = walletSigner(conn.wallet);
      const createAtaIx =
        await getCreateAssociatedTokenIdempotentInstructionAsync({
          payer: signer,
          owner: wallet,
          mint: iss.data.underlyingMint,
          tokenProgram: TOKEN_2022_ADDRESS,
        });
      const baseIx = getClaimMilestoneInstruction({
        claimer: signer,
        rightsIssuance: issuancePda,
        milestone,
        claim: claimPda,
        underlyingMint: iss.data.underlyingMint,
        escrow: iss.data.escrow,
        claimerTokenAccount: claimerAta,
        tokenProgram: TOKEN_2022_ADDRESS,
        amount: entries[idx].weight,
        proof,
      });
      // Mode-aware hook tail for the escrow→claimer leg (matches the on-chain
      // meta list): the fixed 3-account Open tail breaks claims on KycGated
      // mints, whose meta list is 9 accounts. Rights escrows carry no
      // EscrowMarker, so on a KycGated mint the claimer must hold a valid KYC.
      const hookTail = await hookTransferMetas(
        client.runtime.rpc,
        iss.data.underlyingMint,
        {
          sourceTokenAccount: iss.data.escrow,
          destTokenAccount: claimerAta,
          transferAuthority: issuancePda,
          sourceOwner: issuancePda,
          destOwner: wallet,
        },
      );
      const claimIx = {
        ...baseIx,
        accounts: [...baseIx.accounts, ...hookTail],
      };
      const sig = await tx.send({
        instructions: [createAtaIx, claimIx],
        feePayer: signer,
      });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Milestone claimed" });
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to claim",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Issuance detail
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {asset?.name ?? "(asset unknown)"} · issuance #
            {String(issuance.issuanceId)}
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
        <Field
          label="Underlying mint"
          value={issuance.underlyingMint.toString()}
          mono
        />
        <Field label="Escrow" value={issuance.escrow.toString()} mono />
        <Field label="Authority" value={issuance.authority.toString()} mono />
        <Field label="Issuance PDA" value={issuancePda?.toString() ?? "…"} mono />
        <Field
          label="Milestones published"
          value={String(issuance.milestonesCount)}
        />
        <Field label="Total claimed" value={String(issuance.totalClaimed)} />
      </dl>

      {/* Milestones table */}
      {milestones.length > 0 && (
        <div className="mt-6 border-t border-slate-100 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Milestones ({milestones.length})
          </p>
          <div className="mt-3 overflow-hidden rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 text-right font-medium">Pool</th>
                  <th className="px-3 py-2 text-right font-medium">Claimed</th>
                  <th className="px-3 py-2 text-right font-medium">Progress</th>
                  <th className="px-3 py-2 font-medium">Unlock</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {milestones.map((m) => {
                  const pct =
                    m.amountPool > BigInt(0)
                      ? Number((m.claimed * BigInt(1000)) / m.amountPool) / 10
                      : 0;
                  const unlockLabel =
                    m.unlockTs === BigInt(0)
                      ? "immediate"
                      : new Date(Number(m.unlockTs) * 1000)
                          .toISOString()
                          .slice(0, 16) + "Z";
                  return (
                    <tr key={m.index} className="text-slate-700">
                      <td className="px-3 py-2 font-mono">#{m.index}</td>
                      <td className="px-3 py-2 text-right font-mono">
                        {String(m.amountPool)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {String(m.claimed)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-1.5 bg-emerald-500"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="font-mono text-[11px]">
                            {pct.toFixed(0)}%
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500">
                        {unlockLabel}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Publish milestone */}
      <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Publish a milestone
        </p>
        <textarea
          value={snapshot}
          onChange={(e) => setSnapshot(e.target.value)}
          rows={5}
          placeholder="claimer1,100&#10;claimer2,250"
          className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Index
            </span>
            <input
              value={publishIndex}
              inputMode="numeric"
              onChange={(e) =>
                setPublishIndex(e.target.value.replace(/\D/g, ""))
              }
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Pool (underlying)
            </span>
            <input
              value={amountPool}
              inputMode="numeric"
              onChange={(e) => setAmountPool(e.target.value.replace(/\D/g, ""))}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Unlock (optional)
            </span>
            <input
              type="datetime-local"
              value={unlockDate}
              onChange={(e) => setUnlockDate(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
        </div>
        <button
          type="button"
          disabled={tx.isSending || !snapshot.trim() || !amountPool.trim()}
          onClick={() => void publishMilestone()}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {tx.isSending ? "Sending…" : `Publish milestone #${publishIndex}`}
        </button>
      </div>

      {/* Claim milestone */}
      <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
        <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Claim a milestone (beneficiary)
        </p>
        <p className="text-xs text-slate-500">
          Paste the snapshot CSV (
          <code className="rounded bg-slate-100 px-1">claimer,entitlement</code>
          ) used to build the milestone root — your wallet must appear in it.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="block">
            <span className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
              Milestone index
            </span>
            <input
              value={claimIndex}
              inputMode="numeric"
              onChange={(e) =>
                setClaimIndex(e.target.value.replace(/\D/g, ""))
              }
              className="mt-1 w-32 rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
          <button
            type="button"
            disabled={tx.isSending || !snapshot.trim()}
            onClick={() => void claim()}
            className="self-end rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Claim
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateIssuanceModal({
  data,
  onClose,
  onSuccess,
}: {
  data: NetworkData;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [confirmCreate, setConfirmCreate] = useState(false);

  const [issuerLegalId, setIssuerLegalId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [classIndex, setClassIndex] = useState("0");
  const [issuanceId, setIssuanceId] = useState("1");
  const [underlyingMint, setUnderlyingMint] = useState("");

  const matchedIssuer = useMemo(() => {
    if (!issuerLegalId.trim()) return null;
    return (
      data.issuers.find(
        (i) => fromBytes32(i.legalEntityId) === issuerLegalId.trim(),
      ) ?? null
    );
  }, [data, issuerLegalId]);

  async function create(reason: string) {
    if (
      !wallet ||
      !issuerLegalId.trim() ||
      !assetId.trim() ||
      !underlyingMint.trim()
    )
      return;
    const pendingId = toast.showPending(
      `Creating issuance #${issuanceId}…`,
      reason,
    );
    try {
      const [ip] = await findIssuerPda({
        legalEntityId: toBytes32(issuerLegalId.trim()),
      });
      const [ap] = await findAssetPda({
        issuer: ip,
        assetId: assetId.trim(),
      });
      const scPda = await findShareClassPda(ap, Number(classIndex) || 0);
      const signer = walletSigner(conn.wallet);
      const ix = await getCreateRightsIssuanceInstructionAsync({
        authority: signer,
        shareClass: scPda,
        underlyingMint: underlyingMint.trim() as Address,
        tokenProgram: TOKEN_2022_ADDRESS,
        issuanceId: BigInt(issuanceId || "0"),
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Rights issuance opened" });
      setConfirmCreate(false);
      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to create issuance",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (!wallet) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-slate-900/40 p-4 backdrop-blur-sm"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget && !tx.isSending) onClose();
        }}
      >
        <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="border-b border-slate-100 px-5 py-4">
            <p className="text-sm font-semibold uppercase tracking-wide text-slate-700">
              New Rights Token issuance
            </p>
          </div>
          <div className="space-y-4 px-5 py-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Issuer legal entity ID
                </span>
                <input
                  value={issuerLegalId}
                  maxLength={32}
                  onChange={(e) => setIssuerLegalId(e.target.value)}
                  placeholder="e.g. ACME-DOO-2026"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
                {issuerLegalId.trim() && matchedIssuer === null && (
                  <span className="mt-1 block text-[11px] text-amber-700">
                    No issuer with this legal entity ID.
                  </span>
                )}
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Class index
                </span>
                <input
                  value={classIndex}
                  inputMode="numeric"
                  onChange={(e) =>
                    setClassIndex(e.target.value.replace(/\D/g, ""))
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Asset ID
                </span>
                <input
                  value={assetId}
                  maxLength={32}
                  onChange={(e) => setAssetId(e.target.value)}
                  placeholder="SERIES-A"
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                  Issuance ID
                </span>
                <input
                  value={issuanceId}
                  inputMode="numeric"
                  onChange={(e) =>
                    setIssuanceId(e.target.value.replace(/\D/g, ""))
                  }
                  className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Underlying mint (token delivered on claim)
              </span>
              <input
                value={underlyingMint}
                onChange={(e) => setUnderlyingMint(e.target.value)}
                placeholder="Token-2022 mint address"
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm font-mono text-xs focus:border-slate-400 focus:outline-none"
              />
            </label>
            <p className="text-[11px] text-slate-400">
              After creation, fund the escrow with the underlying tokens before
              publishing the first milestone — either by transferring from the
              issuer treasury (hook-checked) or with{" "}
              <code className="font-mono">mint_to_treasury</code> whose
              destination is this issuance&apos;s escrow and whose remaining
              accounts carry the issuance PDA (the program deserializes it and
              requires underlying_mint + escrow to match). There is no UI for
              the mint variant — the /admin/share-classes screen mints to the
              treasury only.
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
            <button
              type="button"
              onClick={onClose}
              disabled={tx.isSending}
              className="rounded-md px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => setConfirmCreate(true)}
              disabled={
                tx.isSending ||
                !issuerLegalId.trim() ||
                !assetId.trim() ||
                !underlyingMint.trim()
              }
              className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {tx.isSending ? "Sending…" : "Open issuance"}
            </button>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={confirmCreate}
        onClose={() => setConfirmCreate(false)}
        onConfirm={(reason) => create(reason)}
        title="Open Rights Token issuance"
        kind="info"
        confirmLabel="Open issuance"
        description={
          <p>
            This locks the parameters of the issuance (share class, underlying
            mint, escrow). Reason recorded in audit log.
          </p>
        }
        busy={tx.isSending}
      />
    </>
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

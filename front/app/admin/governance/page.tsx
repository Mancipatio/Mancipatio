"use client";

import { type Address } from "@solana/kit";
import { walletSigner } from "@/lib/wallet-signer";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findAssetPda,
  findIssuerPda,
  getCastVoteInstructionAsync,
  getCreateProposalInstructionAsync,
  getFinalizeProposalInstruction,
  ProposalOutcome,
  ProposalStatus,
  VoteChoice,
  type Asset,
  type Proposal,
  type ShareClass,
} from "@/lib/generated/asset_registry";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import {
  loadNetworkPreferIndexer,
  loadProposalsFromIndexer,
} from "@/lib/indexer";
import { fromBytes32, toBytes32 } from "@/lib/format";
import { merkleProof, merkleRoot, snapshotLeaf } from "@/lib/merkle";
import { findProposalPda, findShareClassPda } from "@/lib/pdas";
import { ConfirmModal } from "@/components/confirm-modal";
import { SkeletonTable } from "@/components/skeleton";
import { RequireRole } from "@/components/require-role";
import { useToast } from "@/lib/toast";
import { notifyAdminBadges } from "@/lib/admin-badges-events";
import { proposalAwaitsFinalize } from "@/lib/admin-badge-rules";

type StatusFilter = "all" | "active" | "ended" | "passed" | "rejected";

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  ended: "bg-amber-100 text-amber-800 border-amber-200",
  passed: "bg-brand-100 text-brand-800 border-brand-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  pending: "bg-slate-200 text-slate-700 border-slate-300",
};

const FILTER_LABEL: Record<StatusFilter, string> = {
  all: "All",
  active: "Active",
  ended: "Ended — finalize",
  passed: "Passed",
  rejected: "Rejected",
};

/**
 * `ended`: still Active on-chain but past its end time — anyone may finalize
 * it now (the Governance menu count, lib/admin-badge-rules.ts).
 */
function lifecycleOf(p: Proposal): "active" | "ended" | "passed" | "rejected" | "pending" {
  if (proposalAwaitsFinalize(p, Math.floor(Date.now() / 1000))) return "ended";
  if (p.status === ProposalStatus.Active) return "active";
  if (p.outcome === ProposalOutcome.Passed) return "passed";
  if (p.outcome === ProposalOutcome.Rejected) return "rejected";
  return "pending";
}

type SnapshotEntry = { address: Address; weight: bigint };

function parseSnapshot(text: string): SnapshotEntry[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, w] = l.split(",").map((s) => s.trim());
      return { address: a as Address, weight: BigInt(w || "0") };
    });
}

export default function GovernancePage() {
  return (
    <section className="min-w-0 flex-1">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
          Governance
        </p>
        <h1 className="mt-1 text-xl font-semibold text-slate-900">
          Advisory voting
        </h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-slate-600">
          Proposals carry a holder-snapshot Merkle root; holders vote with a
          proof. Outcomes are advisory only.
        </p>
      </div>
      <RequireRole role="admin">
        <GovernanceOps />
      </RequireRole>
    </section>
  );
}

function GovernanceOps() {
  const client = useSolanaClient();
  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  const [shareClassPdaMap, setShareClassPdaMap] = useState<
    Map<string, ShareClass>
  >(new Map());
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [proposals, setProposals] = useState<Proposal[]>([]);

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

      // Proposals — indexer first, on-chain fallback.
      const fromIndexer = await loadProposalsFromIndexer().catch(() => []);
      if (fromIndexer.length > 0) {
        setProposals(fromIndexer);
      } else {
        const {
          ASSET_REGISTRY_PROGRAM_ADDRESS,
          getProposalDecoder,
          getProposalDiscriminatorBytes,
        } = await import("@/lib/generated/asset_registry");
        const rpc = client.runtime.rpc;
        const res = await rpc
          .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, { encoding: "base64" })
          .send();
        const disc = getProposalDiscriminatorBytes();
        const decoder = getProposalDecoder();
        const out: Proposal[] = [];
        for (const r of res) {
          const b64 = (r.account.data as readonly [string, string])[0];
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
          if (bytes.length < 8) continue;
          let match = true;
          for (let i = 0; i < 8; i += 1) {
            if (bytes[i] !== disc[i]) {
              match = false;
              break;
            }
          }
          if (match) out.push(decoder.decode(bytes));
        }
        setProposals(out);
      }
    } catch {
      setFailed(true);
    }
  }, [client]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return proposals
      .map((p, i) => {
        const sc = shareClassPdaMap.get(p.shareClass.toString());
        const asset = sc ? assetPdaMap.get(sc.asset.toString()) : undefined;
        return { proposal: p, sc, asset, originalIndex: i };
      })
      .filter(({ proposal: p, asset }) => {
        const lc = lifecycleOf(p);
        if (statusFilter !== "all" && lc !== statusFilter) return false;
        if (!q) return true;
        return (
          (asset?.name ?? "").toLowerCase().includes(q) ||
          String(p.proposalId).includes(q)
        );
      })
      .sort((a, b) => Number(b.proposal.proposalId - a.proposal.proposalId));
  }, [proposals, assetPdaMap, shareClassPdaMap, query, statusFilter]);

  const selectedRow = useMemo(() => {
    if (selectedIdx === null) return null;
    return rows.find((r) => r.originalIndex === selectedIdx) ?? null;
  }, [rows, selectedIdx]);

  if (failed) {
    return (
      <p className="mt-8 text-sm text-red-600">
        Failed to load governance directory.
      </p>
    );
  }

  return (
    <div className="mt-8 space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by asset, proposal ID…"
          className="min-w-[280px] flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
        />
        <div className="flex gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs">
          {(["all", "active", "ended", "passed", "rejected"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                statusFilter === s
                  ? "bg-slate-900 text-white"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              {FILTER_LABEL[s]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          + Create proposal
        </button>
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
        <strong>Advisory only</strong> — proposal outcomes are signaling. No
        on-chain execution layer is wired up yet (see SCOPE §2.10).
      </div>

      {data === null ? (
        <SkeletonTable rows={5} cols={6} />
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            {proposals.length === 0
              ? "No proposals created yet."
              : "No proposals match the current filter."}
          </p>
          {proposals.length === 0 && (
            <button
              type="button"
              onClick={() => setShowCreate(true)}
              className="mt-4 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
            >
              Create the first proposal
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-4 py-3 font-medium">Proposal</th>
                <th className="px-4 py-3 text-right font-medium">For</th>
                <th className="px-4 py-3 text-right font-medium">Against</th>
                <th className="px-4 py-3 text-right font-medium">Abstain</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(({ proposal: p, asset, originalIndex }) => {
                const lc = lifecycleOf(p);
                const isSelected = selectedIdx === originalIndex;
                const total = p.forWeight + p.againstWeight + p.abstainWeight;
                const forPct =
                  total > BigInt(0)
                    ? Number((p.forWeight * BigInt(1000)) / total) / 10
                    : 0;
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
                        proposal #{String(p.proposalId)}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-emerald-700">
                      {String(p.forWeight)}
                      <span className="ml-1 text-[11px] text-slate-400">
                        {forPct.toFixed(0)}%
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-red-700">
                      {String(p.againstWeight)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-500">
                      {String(p.abstainWeight)}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[lc]}`}
                      >
                        {lc.charAt(0).toUpperCase() + lc.slice(1)}
                      </span>
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
        <ProposalDetail
          proposal={selectedRow.proposal}
          asset={selectedRow.asset}
          onRefresh={refresh}
          onClose={() => setSelectedIdx(null)}
        />
      )}

      {showCreate && data && (
        <CreateProposalModal
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

function ProposalDetail({
  proposal,
  asset,
  onRefresh,
  onClose,
}: {
  proposal: Proposal;
  asset: Asset | undefined;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const conn = useWalletConnection();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;
  const [snapshot, setSnapshot] = useState("");
  const [confirmFinalize, setConfirmFinalize] = useState(false);
  const [proposalPda, setProposalPda] = useState<Address | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const pda = await findProposalPda(proposal.shareClass, proposal.proposalId);
      if (!cancelled) setProposalPda(pda);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [proposal.shareClass, proposal.proposalId]);

  async function castVote(choice: VoteChoice) {
    if (!wallet || !proposalPda) return;
    const entries = parseSnapshot(snapshot);
    const idx = entries.findIndex((e) => e.address === wallet);
    if (idx < 0) {
      toast.showError(
        "Not in snapshot",
        "Connected wallet does not appear in the snapshot CSV.",
      );
      return;
    }
    const choiceLabel = ["For", "Against", "Abstain"][choice] ?? "?";
    const pendingId = toast.showPending(`Voting ${choiceLabel}…`);
    try {
      const leaves = await Promise.all(
        entries.map((e) => snapshotLeaf(e.address, e.weight)),
      );
      const proof = await merkleProof(leaves, idx);
      const signer = walletSigner(conn.wallet);
      const ix = await getCastVoteInstructionAsync({
        voter: signer,
        proposal: proposalPda,
        choice,
        weight: entries[idx].weight,
        proof,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: `Voted ${choiceLabel}` });
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to vote",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async function finalize(reason: string) {
    if (!wallet || !proposalPda) return;
    const pendingId = toast.showPending(
      `Finalizing proposal #${proposal.proposalId}…`,
      reason,
    );
    try {
      const signer = walletSigner(conn.wallet);
      const ix = getFinalizeProposalInstruction({
        payer: signer,
        proposal: proposalPda,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Proposal finalized" });
      notifyAdminBadges({ afterIndexer: true });
      setConfirmFinalize(false);
      await onRefresh();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to finalize",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  const total =
    proposal.forWeight + proposal.againstWeight + proposal.abstainWeight;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Proposal detail
          </p>
          <h3 className="mt-1 text-lg font-semibold text-slate-900">
            {asset?.name ?? "(asset unknown)"} · proposal #{String(proposal.proposalId)}
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
          label="Status"
          value={
            proposal.status === ProposalStatus.Active ? "Active" : "Finalized"
          }
        />
        <Field
          label="Outcome"
          value={
            proposal.outcome === ProposalOutcome.Pending
              ? "Pending"
              : proposal.outcome === ProposalOutcome.Passed
                ? "Passed"
                : "Rejected"
          }
        />
        <Field label="For weight" value={String(proposal.forWeight)} />
        <Field label="Against weight" value={String(proposal.againstWeight)} />
        <Field label="Abstain weight" value={String(proposal.abstainWeight)} />
        <Field label="Total votes" value={String(total)} />
        <Field label="Authority" value={proposal.authority.toString()} mono />
        <Field label="Snapshot slot" value={String(proposal.snapshotSlot)} />
        <Field
          label="Proposal PDA"
          value={proposalPda?.toString() ?? "…"}
          mono
        />
      </dl>

      {/* Vote bars */}
      {total > BigInt(0) && (
        <div className="mt-5 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Vote breakdown
          </p>
          {[
            { label: "For", value: proposal.forWeight, color: "bg-emerald-500" },
            {
              label: "Against",
              value: proposal.againstWeight,
              color: "bg-red-500",
            },
            {
              label: "Abstain",
              value: proposal.abstainWeight,
              color: "bg-slate-400",
            },
          ].map(({ label, value, color }) => {
            const pct = Number((value * BigInt(1000)) / total) / 10;
            return (
              <div key={label} className="flex items-center gap-2 text-xs">
                <span className="w-16 text-slate-600">{label}</span>
                <div className="flex-1 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-2 ${color}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="w-16 text-right font-mono text-slate-700">
                  {pct.toFixed(1)}%
                </span>
              </div>
            );
          })}
        </div>
      )}

      {proposal.status === ProposalStatus.Active && (
        <div className="mt-6 space-y-3 border-t border-slate-100 pt-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Cast vote
          </p>
          <p className="text-xs text-slate-500">
            Paste the snapshot CSV (
            <code className="rounded bg-slate-100 px-1">wallet,weight</code>{" "}
            per line) — same one used to build the proposal root — to generate
            your Merkle proof.
          </p>
          <textarea
            value={snapshot}
            onChange={(e) => setSnapshot(e.target.value)}
            rows={4}
            placeholder="wallet1,100&#10;wallet2,250"
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={tx.isSending || !snapshot.trim()}
              onClick={() => void castVote(VoteChoice.For)}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              Vote For
            </button>
            <button
              type="button"
              disabled={tx.isSending || !snapshot.trim()}
              onClick={() => void castVote(VoteChoice.Against)}
              className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
            >
              Vote Against
            </button>
            <button
              type="button"
              disabled={tx.isSending || !snapshot.trim()}
              onClick={() => void castVote(VoteChoice.Abstain)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
            >
              Abstain
            </button>
            <button
              type="button"
              disabled={tx.isSending}
              onClick={() => setConfirmFinalize(true)}
              className="ml-auto rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
            >
              Finalize
            </button>
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmFinalize}
        onClose={() => setConfirmFinalize(false)}
        onConfirm={(reason) => finalize(reason)}
        title={`Finalize proposal #${proposal.proposalId}`}
        kind="warning"
        confirmLabel="Finalize"
        description={
          <>
            <p>
              Finalizing seals the tally and computes the outcome. No further
              votes can be cast.
            </p>
            <p className="mt-2 text-xs text-slate-500">
              Reason recorded in audit log.
            </p>
          </>
        }
        busy={tx.isSending}
      />
    </div>
  );
}

function CreateProposalModal({
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

  const [issuerLegalId, setIssuerLegalId] = useState("");
  const [assetId, setAssetId] = useState("");
  const [classIndex, setClassIndex] = useState("0");
  const [proposalId, setProposalId] = useState("1");
  const [snapshot, setSnapshot] = useState("");
  const [endTs, setEndTs] = useState("");

  const matchedIssuer = useMemo(() => {
    if (!issuerLegalId.trim()) return null;
    return (
      data.issuers.find(
        (i) => fromBytes32(i.legalEntityId) === issuerLegalId.trim(),
      ) ?? null
    );
  }, [data, issuerLegalId]);

  async function create() {
    if (!wallet || !issuerLegalId.trim() || !assetId.trim()) return;
    const entries = parseSnapshot(snapshot);
    if (entries.length === 0) {
      toast.showError(
        "Empty snapshot",
        "Add at least one (wallet,weight) line.",
      );
      return;
    }
    const pendingId = toast.showPending(`Creating proposal #${proposalId}…`);
    try {
      const [ip] = await findIssuerPda({
        legalEntityId: toBytes32(issuerLegalId.trim()),
      });
      const [ap] = await findAssetPda({
        issuer: ip,
        assetId: assetId.trim(),
      });
      const scPda = await findShareClassPda(ap, Number(classIndex) || 0);
      const leaves = await Promise.all(
        entries.map((e) => snapshotLeaf(e.address, e.weight)),
      );
      const root = await merkleRoot(leaves);
      const endTsBig = endTs.trim()
        ? BigInt(Math.floor(new Date(endTs).getTime() / 1000))
        : BigInt(0);
      const signer = walletSigner(conn.wallet);
      const ix = await getCreateProposalInstructionAsync({
        authority: signer,
        shareClass: scPda,
        proposalId: BigInt(proposalId || "0"),
        metadataHash: new Uint8Array(32),
        snapshotSlot: BigInt(0),
        snapshotRoot: root,
        startTs: BigInt(0),
        endTs: endTsBig,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Proposal created" });
      onSuccess();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError(
        "Failed to create proposal",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  if (!wallet) return null;

  return (
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
            Create proposal
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
                Proposal ID
              </span>
              <input
                value={proposalId}
                inputMode="numeric"
                onChange={(e) =>
                  setProposalId(e.target.value.replace(/\D/g, ""))
                }
                className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              Snapshot CSV (wallet,weight per line)
            </span>
            <textarea
              value={snapshot}
              onChange={(e) => setSnapshot(e.target.value)}
              rows={6}
              placeholder="wallet1,100&#10;wallet2,250&#10;wallet3,75"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
            />
            <span className="mt-1 block text-[11px] text-slate-400">
              Save this exact CSV — voters will need it to generate their proof.
            </span>
          </label>
          <label className="block">
            <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
              End date (optional)
            </span>
            <input
              type="datetime-local"
              value={endTs}
              onChange={(e) => setEndTs(e.target.value)}
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none"
            />
          </label>
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
            onClick={() => void create()}
            disabled={
              tx.isSending ||
              !issuerLegalId.trim() ||
              !assetId.trim() ||
              !snapshot.trim()
            }
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {tx.isSending ? "Sending…" : "Create proposal"}
          </button>
        </div>
      </div>
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

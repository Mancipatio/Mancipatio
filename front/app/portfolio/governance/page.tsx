"use client";

import { WalletRequired } from "@/components/wallet-required";

import {
  type Address,
  type Base58EncodedBytes,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { walletSigner } from "@/lib/wallet-signer";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  findAssetPda,
  getCastVoteInstructionAsync,
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
import { findProposalPda, findShareClassPda } from "@/lib/pdas";
import { merkleProof, merkleRoot, snapshotLeaf } from "@/lib/merkle";
import { explainSendError } from "@/lib/tx-error";
import { SkeletonTable } from "@/components/skeleton";
import { useToast } from "@/lib/toast";

type Rpc = ReturnType<typeof useSolanaClient>["runtime"]["rpc"];

type SnapshotProof = { weight: bigint; proof: Uint8Array[] };

const TOKEN_2022_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

function bytesEqual(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Every non-zero Token-2022 holder of a mint, via a memcmp scan on the mint at
 * offset 0 of the token-account layout. Used to rebuild snapshot trees.
 */
async function loadMintHolders(
  rpc: Rpc,
  mint: Address,
): Promise<Array<{ owner: string; balance: bigint }>> {
  const res = await rpc
    .getProgramAccounts(TOKEN_2022_PROGRAM, {
      encoding: "jsonParsed",
      filters: [
        {
          memcmp: {
            offset: BigInt(0),
            bytes: mint.toString() as Base58EncodedBytes,
            encoding: "base58",
          },
        },
      ],
    })
    .send();
  const byOwner = new Map<string, bigint>();
  for (const item of res) {
    const data = item.account?.data as unknown;
    if (!data || typeof data !== "object" || !("parsed" in data)) continue;
    const info = (
      data as {
        parsed?: {
          info?: { owner?: string; tokenAmount?: { amount?: string } };
        };
      }
    ).parsed?.info;
    if (!info?.owner || !info?.tokenAmount?.amount) continue;
    const amount = BigInt(info.tokenAmount.amount);
    if (amount === BigInt(0)) continue;
    byOwner.set(info.owner, (byOwner.get(info.owner) ?? BigInt(0)) + amount);
  }
  return [...byOwner.entries()].map(([owner, balance]) => ({ owner, balance }));
}

/**
 * Auto-derive the connected wallet's snapshot leaf + Merkle proof.
 *
 * The admin builds proposal / vault / yield snapshot roots over `(holder,
 * balance)` leaves (sorted-pair SHA-256, same shape as `lib/merkle.ts`). We
 * rebuild that exact set from the live on-chain holder list of the share-class
 * mint, recompute the root, and only return a proof if it matches the on-chain
 * `expectedRoot` — guaranteeing the program will accept it. Returns `null` when
 * the live set no longer matches (e.g. balances changed after the snapshot) so
 * callers can fall back to a pasted CSV.
 */
async function deriveSnapshotProof(
  rpc: Rpc,
  mint: Address,
  expectedRoot: ReadonlyUint8Array,
  wallet: Address,
): Promise<SnapshotProof | null> {
  try {
    const holders = await loadMintHolders(rpc, mint);
    if (holders.length === 0) return null;
    const sorted = [...holders].sort((a, b) =>
      a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0,
    );
    const leaves = await Promise.all(
      sorted.map((h) => snapshotLeaf(h.owner as Address, h.balance)),
    );
    const root = await merkleRoot(leaves);
    if (!bytesEqual(root, expectedRoot)) return null;
    const idx = sorted.findIndex((h) => h.owner === wallet.toString());
    if (idx < 0) return null;
    const proof = await merkleProof(leaves, idx);
    return { weight: sorted[idx].balance, proof };
  } catch {
    return null;
  }
}

type CsvEntry = { address: Address; weight: bigint };

function parseSnapshotCsv(text: string): CsvEntry[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, w] = l.split(",").map((s) => s.trim());
      return { address: a as Address, weight: BigInt(w || "0") };
    });
}

/** Build leaf+proof from a pasted snapshot CSV, verifying root match. */
async function proofFromCsv(
  csv: string,
  expectedRoot: ReadonlyUint8Array,
  wallet: Address,
): Promise<SnapshotProof | null> {
  try {
    const entries = parseSnapshotCsv(csv);
    if (entries.length === 0) return null;
    const leaves = await Promise.all(
      entries.map((e) => snapshotLeaf(e.address, e.weight)),
    );
    const root = await merkleRoot(leaves);
    if (!bytesEqual(root, expectedRoot)) return null;
    const idx = entries.findIndex((e) => e.address === wallet);
    if (idx < 0) return null;
    const proof = await merkleProof(leaves, idx);
    return { weight: entries[idx].weight, proof };
  } catch {
    return null;
  }
}

type Lifecycle = "active" | "passed" | "rejected" | "pending";

const STATUS_BADGE: Record<Lifecycle, string> = {
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  passed: "bg-brand-100 text-brand-800 border-brand-200",
  rejected: "bg-red-100 text-red-800 border-red-200",
  pending: "bg-slate-200 text-slate-700 border-slate-300",
};

function lifecycleOf(p: Proposal): Lifecycle {
  if (p.status === ProposalStatus.Active) return "active";
  if (p.outcome === ProposalOutcome.Passed) return "passed";
  if (p.outcome === ProposalOutcome.Rejected) return "rejected";
  return "pending";
}

const VOTE_LABEL = ["For", "Against", "Abstain"];

export default function MyGovernancePage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const wallet = conn.wallet?.account.address;

  const [data, setData] = useState<NetworkData | null>(null);
  const [proposals, setProposals] = useState<Proposal[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [myMints, setMyMints] = useState<Set<string>>(new Set());
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  const [shareClassPdaMap, setShareClassPdaMap] = useState<
    Map<string, ShareClass>
  >(new Map());

  const refresh = useCallback(async () => {
    if (!wallet) return;
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

      // Share-class mints the connected wallet currently holds.
      const { loadHoldings } = await import("@/lib/holdings");
      const holdings = await loadHoldings(client.runtime.rpc, wallet);
      setMyMints(new Set(holdings.map((h) => h.mint)));

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
        const res = await client.runtime.rpc
          .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, {
            encoding: "base64",
          })
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
  }, [client, wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Active proposals on a share class whose mint the wallet holds.
  const rows = useMemo(() => {
    if (!proposals) return [];
    return proposals
      .map((p, i) => {
        const sc = shareClassPdaMap.get(p.shareClass.toString());
        const asset = sc ? assetPdaMap.get(sc.asset.toString()) : undefined;
        return { proposal: p, sc, asset, originalIndex: i };
      })
      .filter(
        ({ proposal: p, sc }) =>
          p.status === ProposalStatus.Active &&
          sc !== undefined &&
          myMints.has(sc.mint.toString()),
      )
      .sort((a, b) => Number(b.proposal.proposalId - a.proposal.proposalId));
  }, [proposals, assetPdaMap, shareClassPdaMap, myMints]);

  if (!conn.isReady || !wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  const loading = proposals === null || data === null;

  return (
    <main className="min-w-0 flex-1">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Governance
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">
          Proposals you can vote on
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Active advisory votes for the share classes{" "}
          <code className="font-mono text-xs">
            {wallet.toString().slice(0, 6)}…{wallet.toString().slice(-4)}
          </code>{" "}
          holds. Your weight is proven against the proposal&apos;s holder
          snapshot Merkle root.
        </p>
      </div>

      {failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load governance.</p>
      ) : loading ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={5} />
        </div>
      ) : rows.length === 0 ? (
        <div className="mt-8 rounded-xl border border-slate-200 bg-white p-12 text-center shadow-card">
          <p className="text-sm text-slate-600">
            No active proposals for share classes you hold.
          </p>
          <p className="mt-1 text-xs text-slate-400">
            When an issuer opens a vote on a class you own, it appears here.
          </p>
        </div>
      ) : (
        <div className="mt-8 space-y-4">
          {rows.map(({ proposal, asset, sc }) => (
            <ProposalVoteCard
              key={`${proposal.shareClass.toString()}-${String(proposal.proposalId)}`}
              proposal={proposal}
              asset={asset}
              shareClassMint={sc!.mint}
              onVoted={refresh}
            />
          ))}
        </div>
      )}

      <div className="mt-8 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs text-amber-900">
        <strong>Advisory only</strong> — proposal outcomes are signaling.
        Issuers act on them off-chain (no automatic on-chain execution in v0.1).
      </div>
    </main>
  );
}

function ProposalVoteCard({
  proposal,
  asset,
  shareClassMint,
  onVoted,
}: {
  proposal: Proposal;
  asset: Asset | undefined;
  shareClassMint: Address;
  onVoted: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const [proposalPda, setProposalPda] = useState<Address | null>(null);
  const [proof, setProof] = useState<SnapshotProof | "loading" | "missing">(
    "loading",
  );
  const [csv, setCsv] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!wallet) return;
      const pda = await findProposalPda(
        proposal.shareClass,
        proposal.proposalId,
      );
      if (cancelled) return;
      setProposalPda(pda);
      // Auto-derive the wallet's leaf+proof from the live holder set, verified
      // against the proposal's on-chain snapshot root.
      const derived = await deriveSnapshotProof(
        client.runtime.rpc,
        shareClassMint,
        proposal.snapshotRoot,
        wallet,
      );
      if (!cancelled) setProof(derived ?? "missing");
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    client,
    wallet,
    proposal.shareClass,
    proposal.proposalId,
    proposal.snapshotRoot,
    shareClassMint,
  ]);

  const total =
    proposal.forWeight + proposal.againstWeight + proposal.abstainWeight;

  async function castVote(choice: VoteChoice) {
    if (!wallet || !conn.wallet || !proposalPda) return;
    // Prefer the auto-derived proof; fall back to a pasted snapshot CSV.
    let resolved: SnapshotProof | null =
      proof !== "loading" && proof !== "missing" ? proof : null;
    if (!resolved && csv.trim()) {
      resolved = await proofFromCsv(csv, proposal.snapshotRoot, wallet);
      if (!resolved) {
        toast.showError(
          "Snapshot mismatch",
          "The pasted CSV does not contain your wallet or its root does not match the proposal snapshot.",
        );
        return;
      }
    }
    if (!resolved) {
      toast.showError(
        "No proof available",
        "Could not derive your snapshot proof. Paste the snapshot CSV used to open the proposal.",
      );
      return;
    }
    const choiceLabel = VOTE_LABEL[choice] ?? "?";
    const pendingId = toast.showPending(`Voting ${choiceLabel}…`);
    try {
      const signer = walletSigner(conn.wallet);
      const ix = await getCastVoteInstructionAsync({
        voter: signer,
        proposal: proposalPda,
        choice,
        weight: resolved.weight,
        proof: resolved.proof,
      });
      const sig = await tx.send({ instructions: [ix], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: `Voted ${choiceLabel}` });
      await onVoted();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to vote", explainSendError(err));
    }
  }

  const weightLabel =
    proof === "loading"
      ? "deriving…"
      : proof === "missing"
        ? "—"
        : String(proof.weight);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            {asset?.name ?? "(asset unknown)"} · proposal #
            {String(proposal.proposalId)}
          </h3>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">
            share-class {proposal.shareClass.toString().slice(0, 6)}…
            {proposal.shareClass.toString().slice(-4)}
            {proposal.endTs > BigInt(0) && (
              <>
                {" · "}closes{" "}
                {new Date(Number(proposal.endTs) * 1000)
                  .toISOString()
                  .slice(0, 16)
                  .replace("T", " ")}
                Z
              </>
            )}
          </p>
        </div>
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${STATUS_BADGE[lifecycleOf(proposal)]}`}
        >
          {lifecycleOf(proposal).charAt(0).toUpperCase() +
            lifecycleOf(proposal).slice(1)}
        </span>
      </div>

      {/* Tally bars */}
      <div className="mt-4 space-y-2">
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
          const pct = total > BigInt(0) ? Number((value * BigInt(1000)) / total) / 10 : 0;
          return (
            <div key={label} className="flex items-center gap-2 text-xs">
              <span className="w-16 text-slate-600">{label}</span>
              <div className="flex-1 overflow-hidden rounded-full bg-slate-100">
                <div className={`h-2 ${color}`} style={{ width: `${pct}%` }} />
              </div>
              <span className="w-20 text-right font-mono text-slate-700">
                {String(value)}
              </span>
            </div>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-4">
        <p className="text-xs text-slate-500">
          Your voting weight:{" "}
          <span className="font-mono text-slate-700">{weightLabel}</span>
        </p>
      </div>

      {proof === "missing" && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-amber-700">
            Could not auto-derive your proof (the snapshot was likely taken at a
            different moment than the current holder set). Paste the snapshot CSV
            (
            <code className="rounded bg-slate-100 px-1">wallet,weight</code> per
            line) the issuer used to open this proposal.
          </p>
          <textarea
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            rows={4}
            placeholder="wallet1,100&#10;wallet2,250"
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-xs focus:border-slate-400 focus:outline-none"
          />
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={tx.isSending || proof === "loading"}
          onClick={() => void castVote(VoteChoice.For)}
          className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          Vote For
        </button>
        <button
          type="button"
          disabled={tx.isSending || proof === "loading"}
          onClick={() => void castVote(VoteChoice.Against)}
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
        >
          Vote Against
        </button>
        <button
          type="button"
          disabled={tx.isSending || proof === "loading"}
          onClick={() => void castVote(VoteChoice.Abstain)}
          className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
        >
          Abstain
        </button>
      </div>
    </div>
  );
}

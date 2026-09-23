"use client";

import { LegacyPayoutRefunds } from "@/components/legacy-payout-refunds";
import { getPayoutSnapshotProof } from "@/lib/payout-snapshots-client";
import { snapshotHex, snapshotBytes, verifyOriginalSnapshotProof } from "@/lib/payout-snapshots";
import { VaultVoteHistory } from "@/components/vault-vote-history";
import { currentVaultVote, loadVaultVoteHistory, vaultVotePda, payoutVaultPda, vaultVoteActions, type VaultVoteRecord } from "@/lib/payout-vault";
import { decodeReadablePayoutVault, isLegacyPayoutVault, type LegacyPayoutVault } from "@/lib/legacy-accounts";
import { publishLegacyPayoutVaults } from "@/lib/legacy-accounts-store";
import { detectNetwork } from "@/lib/network";
import { WalletRequired } from "@/components/wallet-required";

import {
  getProgramDerivedAddress,
  getAddressEncoder,
  type Address,
  type Base58EncodedBytes,
  type ReadonlyUint8Array,
} from "@solana/kit";
import {
  useSendTransaction,
  useSolanaClient,
  useWalletConnection,
} from "@solana/react-hooks";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
} from "@solana-program/token-2022";
import { findAssociatedTokenPda as findClassicAtaPda } from "@solana-program/token";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS,
  fetchMaybeRightsIssuance,
  findAssetPda,
  getCastVaultVoteInstructionAsync,
  getClaimFounderYieldInstruction,
  findPlatformPda,
  getClaimInvestorYieldInstruction,
  getClaimMilestoneInstruction,
  getClaimRefundInstruction,
  getDistributionDecoder,
  getDistributionDiscriminatorBytes,
  getPayoutVaultDiscriminatorBytes,
  PayoutVaultState,
  VaultVoteChoice,
  type Asset,
  type PayoutVault,
  type RightsIssuance,
  type ShareClass,
  type VaultVote,
  type VestingMilestone,
} from "@/lib/generated/asset_registry";
import {
  findVaultPda,
} from "@/lib/generated/asset_registry/pdas";
import { loadNetwork, type NetworkData } from "@/lib/enumerate";
import { loadNetworkPreferIndexer } from "@/lib/indexer";
import {
  DISTRIBUTION_STATUS_BADGE,
  DISTRIBUTION_STATUS_LABEL,
  type DistributionRecord,
} from "@/lib/distributions";
import { merkleProof, merkleRoot, snapshotLeaf } from "@/lib/merkle";
import { hookTransferMetas } from "@/lib/hook-metas";
import {
  findClaimPda,
  findMilestonePda,
  findRightsIssuancePda,
  findShareClassPda,
} from "@/lib/pdas";
import { fetchMintTokenProgram } from "@/lib/transaction-builders";
import { walletSigner } from "@/lib/wallet-signer";
import { features } from "@/lib/features";
import { issuerSyncInstructions, resolveIssuerChain } from "@/lib/issuer-authority";
import type { Instruction } from "@solana/kit";

const ISSUER_ROTATION = features().issuerRotation;
import { explainSendError } from "@/lib/tx-error";
import { SkeletonTable } from "@/components/skeleton";
import { useToast } from "@/lib/toast";

const TOKEN_2022_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;

type Rpc = ReturnType<typeof useSolanaClient>["runtime"]["rpc"];
type SnapshotProof = { weight: bigint; proof: Uint8Array[] };

const addrEnc = getAddressEncoder();

// ── snapshot proof derivation (shared shape with admin/governance) ──────────────

function bytesEqual(a: ReadonlyUint8Array, b: ReadonlyUint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function isZeroRoot(r: ReadonlyUint8Array): boolean {
  for (let i = 0; i < r.length; i += 1) if (r[i] !== 0) return false;
  return true;
}

/** Every non-zero Token-2022 holder of a mint (memcmp on mint at offset 0). */
async function loadMintHolders(
  rpc: Rpc,
  mint: Address,
): Promise<Array<{ owner: string; balance: bigint }>> {
  const res = await rpc
    .getProgramAccounts(TOKEN_2022_ADDRESS, {
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
 * Auto-derive the wallet's leaf + Merkle proof by rebuilding the snapshot tree
 * from the live `(holder, balance)` set and verifying the local root matches
 * the on-chain `expectedRoot`. Returns null if the live set has drifted from
 * the snapshot (then callers fall back to a pasted CSV).
 */
async function deriveSnapshotProof(
  rpc: Rpc,
  mint: Address,
  expectedRoot: ReadonlyUint8Array,
  wallet: Address,
): Promise<SnapshotProof | null> {
  if (isZeroRoot(expectedRoot)) return null;
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

function parseSnapshotCsv(text: string): Array<{ address: Address; weight: bigint }> {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [a, w] = l.split(",").map((s) => s.trim());
      return { address: a as Address, weight: BigInt(w || "0") };
    });
}

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

/** ClaimRecord PDA: `["pv_claim", vault, [kind as u8], investor]`. */
async function findPvClaimPda(
  vault: Address,
  kind: number,
  investor: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS,
    seeds: [
      new TextEncoder().encode("pv_claim"),
      addrEnc.encode(vault),
      new Uint8Array([kind]),
      addrEnc.encode(investor),
    ],
  });
  return pda;
}

// ClaimKind discriminants (state.rs): Refund = 0, InvestorYield = 1.
const CLAIM_KIND_REFUND = 0;
const CLAIM_KIND_INVESTOR_YIELD = 1;

export default function MyRightsPage() {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const wallet = conn.wallet?.account.address;

  const [data, setData] = useState<NetworkData | null>(null);
  const [failed, setFailed] = useState(false);
  const [myMints, setMyMints] = useState<Set<string>>(new Set());
  const [assetPdaMap, setAssetPdaMap] = useState<Map<string, Asset>>(new Map());
  const [shareClassByPda, setShareClassByPda] = useState<
    Map<string, ShareClass>
  >(new Map());
  const [issuancePdaMap, setIssuancePdaMap] = useState<
    Map<string, RightsIssuance>
  >(new Map());
  const [vaults, setVaults] = useState<PayoutVault[] | null>(null);
  const [distributions, setDistributions] = useState<
    DistributionRecord[] | null
  >(null);

  const refresh = useCallback(async () => {
    if (!wallet) return;
    try {
      const network = await loadNetworkPreferIndexer(() =>
        loadNetwork(client.runtime.rpc),
      );
      setData(network);

      const am = new Map<string, Asset>();
      for (const a of network.assets) {
        const [pda] = await findAssetPda({
          issuer: a.issuer,
          assetId: a.assetId,
        });
        am.set(pda.toString(), a);
      }
      setAssetPdaMap(am);

      const scm = new Map<string, ShareClass>();
      for (const sc of network.shareClasses) {
        const scPda = await findShareClassPda(sc.asset, sc.classIndex);
        scm.set(scPda.toString(), sc);
      }
      setShareClassByPda(scm);

      const im = new Map<string, RightsIssuance>();
      for (const iss of network.rightsIssuances) {
        const pda = await findRightsIssuancePda(iss.shareClass, iss.issuanceId);
        im.set(pda.toString(), iss);
      }
      setIssuancePdaMap(im);

      const { loadHoldings } = await import("@/lib/holdings");
      const holdings = await loadHoldings(client.runtime.rpc, wallet);
      setMyMints(new Set(holdings.map((h) => h.mint)));

      // PayoutVaults + their VaultVotes — direct program scan (not in NetworkData).
      const res = await client.runtime.rpc
        .getProgramAccounts(ASSET_REGISTRY_PROGRAM_ADDRESS, { encoding: "base64", commitment: "finalized" })
        .send();
      const raws: Uint8Array[] = [];
      for (const r of res) {
        const b64 = (r.account.data as readonly [string, string])[0];
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
        raws.push(bytes);
      }
      const vDisc = getPayoutVaultDiscriminatorBytes();
      const legacy: { address: string; vault: LegacyPayoutVault }[] = [];
      const dDisc = getDistributionDiscriminatorBytes();
      const dDec = getDistributionDecoder();
      const matches = (b: Uint8Array, d: ArrayLike<number>) => {
        if (b.length < 8) return false;
        for (let i = 0; i < 8; i += 1) if (b[i] !== d[i]) return false;
        return true;
      };
      const vs: PayoutVault[] = [];
      const ds: DistributionRecord[] = [];
      for (let i = 0; i < raws.length; i += 1) {
        const b = raws[i];
        if (res[i].account.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS) throw new Error("Unexpected program owner");
        if (matches(b, vDisc)) {
          const v = decodeReadablePayoutVault(b);
          if (await payoutVaultPda(v.sale) !== res[i].pubkey) throw new Error("Payout vault PDA mismatch");
          if (isLegacyPayoutVault(v)) legacy.push({ address: res[i].pubkey, vault: v });
          else vs.push(v);
        } else if (matches(b, dDisc)) ds.push({ address: res[i].pubkey, distribution: dDec.decode(b) });
      }
      publishLegacyPayoutVaults(detectNetwork(), legacy);
      setVaults(vs);
      setDistributions(ds);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [client, wallet]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
  }, [refresh]);

  // Milestones grouped by issuance PDA.
  const milestonesByIssuance = useMemo(() => {
    const m = new Map<string, VestingMilestone[]>();
    if (!data) return m;
    for (const ms of data.milestones) {
      const arr = m.get(ms.issuance.toString()) ?? [];
      arr.push(ms);
      m.set(ms.issuance.toString(), arr);
    }
    return m;
  }, [data]);

  // Rights issuances whose share-class mint the wallet holds.
  const myIssuances = useMemo(() => {
    if (!data) return [];
    const out: Array<{ pda: string; issuance: RightsIssuance; asset?: Asset }> =
      [];
    for (const [pda, iss] of issuancePdaMap) {
      const sc = shareClassByPda.get(iss.shareClass.toString());
      if (!sc || !myMints.has(sc.mint.toString())) continue;
      out.push({ pda, issuance: iss, asset: assetPdaMap.get(sc.asset.toString()) });
    }
    return out.sort((a, b) =>
      Number(b.issuance.issuanceId - a.issuance.issuanceId),
    );
  }, [data, issuancePdaMap, shareClassByPda, myMints, assetPdaMap]);

  // Original investors may have sold every token. Keep every public vault
  // discoverable; the signed original proof determines actual entitlement.
  const myVaults = useMemo(() => {
    if (!vaults) return [];
    const out: Array<{ vault: PayoutVault; sc?: ShareClass; asset?: Asset }> =
      [];
    for (const v of vaults) {
      const sc = shareClassByPda.get(v.shareClass.toString());
      out.push({
        vault: v,
        sc,
        asset: sc ? assetPdaMap.get(sc.asset.toString()) : undefined,
      });
    }
    return out;
  }, [vaults, shareClassByPda, assetPdaMap]);

  // Distributions for share classes the wallet holds (informational only).
  const myDistributions = useMemo(() => {
    if (!distributions) return [];
    return distributions
      .filter((r) => {
        const sc = shareClassByPda.get(r.distribution.shareClass.toString());
        return sc ? myMints.has(sc.mint.toString()) : false;
      })
      .sort((a, b) =>
        Number(b.distribution.distributionId - a.distribution.distributionId),
      );
  }, [distributions, shareClassByPda, myMints]);

  if (!conn.isReady || !wallet) {
    return (
      <main className="min-w-0 flex-1">
        <WalletRequired />
      </main>
    );
  }

  const loading = data === null || vaults === null || distributions === null;

  return (
    <main className="min-w-0 flex-1">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">
          Rights &amp; payouts
        </p>
        <h1 className="mt-1 text-2xl font-semibold text-slate-900">My claims</h1>
        <p className="mt-2 max-w-2xl text-sm text-slate-600">
          Vesting milestones and public payout vaults available for entitlement checks by{" "}
          <code className="font-mono text-xs">
            {wallet.toString().slice(0, 6)}…{wallet.toString().slice(-4)}
          </code>{" "}
          . An original investor can retain payout rights after selling tokens.
          A listed vault does not confirm entitlement; load your original proof to verify it.
        </p>
      </div>

      {failed ? (
        <p className="mt-8 text-sm text-red-600">Failed to load.</p>
      ) : loading ? (
        <div className="mt-8">
          <SkeletonTable rows={3} cols={4} />
        </div>
      ) : (
        <div className="mt-8 space-y-10">
          <LegacyPayoutRefunds onDone={refresh} />
          {/* ── Payout vaults: investor yield / refund / vault vote ── */}
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              Payout vaults
            </h2>
            {myVaults.length === 0 ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center shadow-card">
                <p className="text-sm text-slate-600">
                  No payout vaults on this network.
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                {myVaults.map(({ vault, asset }) => (
                  <VaultCard
                    key={vault.sale.toString()}
                    vault={vault}
                    asset={asset}
                    onDone={refresh}
                  />
                ))}
              </div>
            )}
          </section>

          {/* ── Revenue distributions (informational) ── */}
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              Revenue distributions
            </h2>
            {myDistributions.length === 0 ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center shadow-card">
                <p className="text-sm text-slate-600">
                  No revenue distributions for share classes you hold.
                </p>
              </div>
            ) : (
              <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-card">
                <table className="w-full text-sm">
                  <thead className="border-b border-slate-100 bg-slate-50 text-left text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-3 font-medium">Distribution</th>
                      <th className="px-4 py-3 font-medium">Asset</th>
                      <th className="px-4 py-3 font-medium">Payment mint</th>
                      <th className="px-4 py-3 text-right font-medium">
                        Total
                      </th>
                      <th className="px-4 py-3 text-right font-medium">
                        Distributed
                      </th>
                      <th className="px-4 py-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {myDistributions.map((r) => {
                      const d = r.distribution;
                      const sc = shareClassByPda.get(d.shareClass.toString());
                      const asset = sc
                        ? assetPdaMap.get(sc.asset.toString())
                        : undefined;
                      return (
                        <tr key={r.address.toString()}>
                          <td className="px-4 py-3 font-mono text-xs text-slate-900">
                            #{String(d.distributionId)}
                          </td>
                          <td className="px-4 py-3 text-slate-700">
                            {asset?.name ?? "(asset unknown)"}
                          </td>
                          <td className="px-4 py-3 font-mono text-[11px] text-slate-500">
                            {d.paymentMint.toString().slice(0, 8)}…
                            {d.paymentMint.toString().slice(-4)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-slate-900">
                            {String(d.totalAmount)}
                          </td>
                          <td className="px-4 py-3 text-right font-mono text-slate-700">
                            {String(d.distributedAmount)} · {d.paidCount} payout
                            {d.paidCount === 1 ? "" : "s"}
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
            <p className="mt-2 text-xs text-slate-400">
              Informational only — payouts are pushed directly to your payment
              token account by the platform (payment-mint base units shown).
              Nothing to claim here.
            </p>
          </section>

          {/* ── Rights-token vesting milestones ── */}
          <section>
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              Rights-token milestones
            </h2>
            {myIssuances.length === 0 ? (
              <div className="mt-4 rounded-xl border border-slate-200 bg-white p-8 text-center shadow-card">
                <p className="text-sm text-slate-600">
                  No Rights-Token issuances for classes you hold.
                </p>
              </div>
            ) : (
              <div className="mt-4 space-y-4">
                {myIssuances.map(({ pda, issuance, asset }) => (
                  <IssuanceCard
                    key={pda}
                    issuancePda={pda as Address}
                    issuance={issuance}
                    asset={asset}
                    milestones={milestonesByIssuance.get(pda) ?? []}
                    onDone={refresh}
                  />
                ))}
              </div>
            )}
          </section>

          <p className="text-xs text-slate-400">
            This page lets you claim vested milestones and vote directly from
            your wallet. Issuers and the Manci team manage the underlying
            milestones and payout vaults.
          </p>
        </div>
      )}
    </main>
  );
}

// ── Payout-vault card: investor yield + refund + frozen-vault vote ──────────────

function VaultCard({
  vault,
  asset,
  onDone,
}: {
  vault: PayoutVault;
  asset: Asset | undefined;
  onDone: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  // 2C-2: after an issuer key rotation the vault still names the earlier
  // key until `sync_payout_founder` runs. When this wallet is the issuer's
  // CURRENT key, it is the founder in all but the snapshot: the founder
  // actions below prepend the (permissionless) sync.
  const [founderSync, setFounderSync] = useState<Instruction[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!ISSUER_ROTATION || !wallet || wallet.toString() === vault.founder.toString()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFounderSync([]);
      return;
    }
    void (async () => {
      try {
        const [chain, vaultPda] = await Promise.all([
          resolveIssuerChain(client.runtime.rpc, vault.shareClass),
          payoutVaultPda(vault.sale),
        ]);
        if (cancelled || chain.issuerAuthority !== wallet.toString()) return;
        setFounderSync(
          issuerSyncInstructions({
            issuer: chain.issuer,
            issuerAuthority: chain.issuerAuthority,
            vaults: [{ address: vaultPda, shareClass: vault.shareClass, asset: chain.asset, founder: vault.founder }],
          }),
        );
      } catch {
        // Not resolvable: this wallet simply is not the founder.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, wallet, vault]);
  const isFounder = wallet?.toString() === vault.founder.toString() || founderSync.length > 0;
  const [yieldProof, setYieldProof] = useState<
    SnapshotProof | "loading" | "missing"
  >("loading");
  const [vaultVote, setVaultVote] = useState<VaultVote | null>(null);
  const [voteHistory, setVoteHistory] = useState<VaultVoteRecord[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [originalProofError, setOriginalProofError] = useState<string | null>(null);
  const proofGeneration = useRef(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000); return () => clearInterval(id); }, []);
  const voteActions = vaultVoteActions(vault, vaultVote, now);
  const [voteProof, setVoteProof] = useState<
    SnapshotProof | "loading" | "missing" | "n/a"
  >("n/a");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      proofGeneration.current++;
      if (!wallet) return;
      setVaultVote(null); setVoteProof("n/a"); setVoteHistory([]); setYieldProof("missing"); setOriginalProofError(null);
      // Entitlement proofs come only from the durable original snapshot.
      // Loading current balances is not a recovery path for an immutable root.
      const vaultPda = await payoutVaultPda(vault.sale);
      if (!cancelled) { setVaultVote(null); setVoteProof("n/a"); setVoteHistory([]); }
      try {
        const [current, history] = await Promise.all([
          currentVaultVote(client.runtime.rpc, vaultPda, vault.voteRound),
          loadVaultVoteHistory(client.runtime.rpc, vaultPda),
        ]);
        if (cancelled) return;
        setVaultVote(current?.vote ?? null); setVoteHistory(history); setHistoryError(false);
        setVoteProof(current ? "missing" : "n/a");
      } catch {
        if (!cancelled) { setVoteProof("missing"); setHistoryError(true); setVaultVote(null); }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    client,
    wallet,
    isFounder,
    vault.sale,
    vault.shareClass,
    vault.paymentMint,
    vault.state,
    vault.voteRound,
    vault.votePending,
    vault.investorYieldPool,
    vault.investorYieldRoot,
  ]);

  async function loadOriginalProof(kind: "vault_vote" | "investor_yield") {
    if (!wallet || !conn.wallet || (kind === "vault_vote" && !vaultVote)) return;
    const generation = proofGeneration.current;
    const setProof = kind === "vault_vote" ? setVoteProof : setYieldProof;
    setProof("loading"); setOriginalProofError(null);
    try {
      const root = snapshotHex(kind === "vault_vote" ? vaultVote!.snapshotRoot : vault.investorYieldRoot);
      const result = await getPayoutSnapshotProof(conn.wallet, kind, await payoutVaultPda(vault.sale), kind === "vault_vote" ? String(vault.voteRound) : "0", root);
      if (result.root_hex !== root || result.total_weight !== String(vault.totalWeight) || !await verifyOriginalSnapshotProof(wallet, result.weight, result.proof, root)) throw new Error("Original proof does not match this wallet and on-chain entitlement");
      if (generation === proofGeneration.current) setProof({ weight: BigInt(result.weight), proof: result.proof.map(snapshotBytes) });
    } catch (err) { if (generation === proofGeneration.current) { setProof("missing"); setOriginalProofError(err instanceof Error ? err.message : String(err)); } }
  }

  async function withTx(
    label: string,
    build: (signer: ReturnType<typeof walletSigner>) => Promise<{
      instructions: Parameters<typeof tx.send>[0]["instructions"];
    }>,
  ) {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending(label);
    try {
      const signer = walletSigner(conn.wallet);
      const { instructions } = await build(signer);
      const sig = await tx.send({ instructions, feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: label.replace("…", "") });
      await onDone();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Transaction failed", explainSendError(err));
    }
  }

  async function claimInvestorYield() {
    if (yieldProof === "loading" || yieldProof === "missing") return;
    await withTx("Claiming investor yield…", async (signer) => {
      const payTokenProgram = await fetchMintTokenProgram(client.runtime.rpc, vault.paymentMint, { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) });
      const [vaultPda] = await findVaultPda({ sale: vault.sale });
      const claim = await findPvClaimPda(
        vaultPda,
        CLAIM_KIND_INVESTOR_YIELD,
        wallet!,
      );
      const [investorAta] = await findClassicAtaPda({
        owner: wallet!,
        tokenProgram: payTokenProgram,
        mint: vault.paymentMint,
      });
      const { getCreateAssociatedTokenIdempotentInstructionAsync: createClassicAtaIx } =
        await import("@solana-program/token");
      const createAta = await createClassicAtaIx({
        payer: signer,
        owner: wallet!,
        mint: vault.paymentMint,
        tokenProgram: payTokenProgram,
      });
      const ix = getClaimInvestorYieldInstruction({
        investor: signer,
        vault: vaultPda,
        claim,
        escrow: vault.escrow,
        paymentMint: vault.paymentMint,
        investorAccount: investorAta,
        paymentTokenProgram: payTokenProgram,
        weight: (yieldProof as SnapshotProof).weight,
        proof: (yieldProof as SnapshotProof).proof,
      });
      return { instructions: [createAta, ix] };
    });
  }

  async function claimFounderYield() {
    await withTx("Claiming founder yield…", async (signer) => {
      const payTokenProgram = await fetchMintTokenProgram(client.runtime.rpc, vault.paymentMint, { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) });
      const [vaultPda] = await findVaultPda({ sale: vault.sale });
      const [founderAta] = await findClassicAtaPda({
        owner: wallet!,
        tokenProgram: payTokenProgram,
        mint: vault.paymentMint,
      });
      const { getCreateAssociatedTokenIdempotentInstructionAsync: createClassicAtaIx } =
        await import("@solana-program/token");
      const createAta = await createClassicAtaIx({
        payer: signer,
        owner: wallet!,
        mint: vault.paymentMint,
        tokenProgram: payTokenProgram,
      });
      // Emergency-pause gate (read-only) — the last named account.
      const [platform] = await findPlatformPda();
      const ix = getClaimFounderYieldInstruction({
        platform,
        founder: signer,
        vault: vaultPda,
        escrow: vault.escrow,
        paymentMint: vault.paymentMint,
        founderAccount: founderAta,
        paymentTokenProgram: payTokenProgram,
      });
      return { instructions: [...founderSync, createAta, ix] };
    });
  }

  async function claimRefund() {
    if (voteProof === "loading" || voteProof === "missing" || voteProof === "n/a")
      return;
    await withTx("Claiming refund…", async (signer) => {
      const payTokenProgram = await fetchMintTokenProgram(client.runtime.rpc, vault.paymentMint, { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) });
      const [vaultPda] = await findVaultPda({ sale: vault.sale });
      const claim = await findPvClaimPda(vaultPda, CLAIM_KIND_REFUND, wallet!);
      const [investorAta] = await findClassicAtaPda({
        owner: wallet!,
        tokenProgram: payTokenProgram,
        mint: vault.paymentMint,
      });
      const { getCreateAssociatedTokenIdempotentInstructionAsync: createClassicAtaIx } =
        await import("@solana-program/token");
      const createAta = await createClassicAtaIx({
        payer: signer,
        owner: wallet!,
        mint: vault.paymentMint,
        tokenProgram: payTokenProgram,
      });
      if (!voteActions.canRefund) throw new Error("A finalized return-capital decision for the current round is required");
      const ix = getClaimRefundInstruction({
        investor: signer,
        vault: vaultPda,
        vote: await vaultVotePda(vaultPda, vault.voteRound),
        claim,
        escrow: vault.escrow,
        paymentMint: vault.paymentMint,
        investorAccount: investorAta,
        paymentTokenProgram: payTokenProgram,
        weight: (voteProof as SnapshotProof).weight,
        proof: (voteProof as SnapshotProof).proof,
      });
      return { instructions: [createAta, ix] };
    });
  }

  async function castVaultVote(choice: VaultVoteChoice) {
    if (voteProof === "loading" || voteProof === "missing" || voteProof === "n/a")
      return;
    const label =
      choice === VaultVoteChoice.ReturnCapital ? "Return capital" : "Extend";
    await withTx(`Voting: ${label}…`, async (signer) => {
      const [vaultPda] = await findVaultPda({ sale: vault.sale });
      if (!voteActions.canCast) throw new Error("The current vote round is not open");
      const votePda = await vaultVotePda(vaultPda, vault.voteRound);
      const ix = await getCastVaultVoteInstructionAsync({
        voter: signer,
        vault: vaultPda,
        vote: votePda,
        weight: (voteProof as SnapshotProof).weight,
        proof: (voteProof as SnapshotProof).proof,
        choice,
      });
      return { instructions: [ix] };
    });
  }

  const stateLabel: Record<PayoutVaultState, string> = {
    [PayoutVaultState.Active]: "Active",
    [PayoutVaultState.Frozen]: "Frozen",
    [PayoutVaultState.Completed]: "Completed",
    [PayoutVaultState.Cancelled]: "Cancelled",
  };
  const stateBadge: Record<PayoutVaultState, string> = {
    [PayoutVaultState.Active]: "bg-emerald-100 text-emerald-800 border-emerald-200",
    [PayoutVaultState.Frozen]: "bg-amber-100 text-amber-800 border-amber-200",
    [PayoutVaultState.Completed]: "bg-brand-100 text-brand-800 border-brand-200",
    [PayoutVaultState.Cancelled]: "bg-red-100 text-red-800 border-red-200",
  };

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            {asset?.name ?? "(asset unknown)"}
          </h3>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">
            sale {vault.sale.toString().slice(0, 6)}…
            {vault.sale.toString().slice(-4)}
            {isFounder && " · you are the founder"}
          </p>
        </div>
        <span
          className={`inline-flex rounded-full border px-2 py-0.5 text-[11px] font-semibold ${stateBadge[vault.state]}`}
        >
          {stateLabel[vault.state]}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <Field label="Total proceeds" value={String(vault.totalAmount)} />
        <Field label="Released" value={String(vault.released)} />
        <Field
          label="Investor yield pool"
          value={String(vault.investorYieldPool)}
        />
      </dl>

      <p className="mt-3 text-xs text-slate-600">Vote round #{String(vault.voteRound)} · {vault.votePending ? "Pending" : "No open vote"}</p>
      {historyError ? <p className="mt-2 text-xs text-rose-700">Current vote and history are unavailable; vote and refund actions require verification.</p> : <VaultVoteHistory records={voteHistory} currentRound={vault.voteRound} />}
      <div className="mt-3 flex flex-wrap gap-2">
        {!isFounder && vault.investorYieldPool > BigInt(0) && <button type="button" disabled={yieldProof === "loading"} onClick={() => void loadOriginalProof("investor_yield")} className="rounded-lg border border-emerald-200 px-3 py-2 text-xs text-emerald-800 disabled:opacity-50">{yieldProof === "loading" ? "Loading original proof…" : "Load original yield entitlement"}</button>}
        {!isFounder && vaultVote && <button type="button" disabled={voteProof === "loading"} onClick={() => void loadOriginalProof("vault_vote")} className="rounded-lg border border-emerald-200 px-3 py-2 text-xs text-emerald-800 disabled:opacity-50">{voteProof === "loading" ? "Loading original proof…" : "Load original vote / refund entitlement"}</button>}
      </div>
      {originalProofError && <p role="alert" className="mt-2 text-xs text-rose-700">{originalProofError}</p>}
      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-4">
        {/* Investor yield */}
        {!isFounder && vault.investorYieldPool > BigInt(0) && (
          <button
            type="button"
            disabled={
              tx.isSending ||
              yieldProof === "loading" ||
              yieldProof === "missing"
            }
            onClick={() => void claimInvestorYield()}
            title={
              yieldProof === "missing"
                ? "Load your entitlement from the saved original investor snapshot."
                : undefined
            }
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {yieldProof === "loading"
              ? "Loading original proof…"
              : "Claim investor yield"}
          </button>
        )}

        {/* Founder yield */}
        {isFounder && vault.founderYieldClaimable > BigInt(0) && (
          <button
            type="button"
            disabled={tx.isSending}
            onClick={() => void claimFounderYield()}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Claim founder yield ({String(vault.founderYieldClaimable)})
          </button>
        )}

        {/* Frozen-vault investor vote */}
        {vault.state === PayoutVaultState.Frozen &&
          !isFounder &&
          voteActions.canCast && (
            <>
              <button
                type="button"
                disabled={
                  tx.isSending ||
                  voteProof === "loading" ||
                  voteProof === "missing"
                }
                onClick={() => void castVaultVote(VaultVoteChoice.ReturnCapital)}
                className="rounded-lg border border-red-300 bg-red-50 px-4 py-2 text-sm font-medium text-red-900 hover:bg-red-100 disabled:opacity-50"
              >
                Vote: return capital
              </button>
              <button
                type="button"
                disabled={
                  tx.isSending ||
                  voteProof === "loading" ||
                  voteProof === "missing"
                }
                onClick={() => void castVaultVote(VaultVoteChoice.Extend)}
                className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:border-slate-400 disabled:opacity-50"
              >
                Vote: extend
              </button>
            </>
          )}

        {/* Refund (cancelled vaults) */}
        {vault.state === PayoutVaultState.Cancelled && !isFounder && (
          <button
            type="button"
            disabled={
              tx.isSending || !voteActions.canRefund || voteProof === "loading" || voteProof === "missing"
            }
            onClick={() => void claimRefund()}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            Claim refund
          </button>
        )}
      </div>

      {((vault.state === PayoutVaultState.Frozen ||
        vault.state === PayoutVaultState.Cancelled) &&
        !isFounder &&
        voteProof === "missing") && (
        <p className="mt-2 text-xs text-amber-700">
          Load the saved original snapshot for this vote round. Current token
          balances are not used to replace your original entitlement. If the
          snapshot is missing, an administrator must restore and verify the
          original investor CSV.
        </p>
      )}
    </div>
  );
}

// ── Rights-token issuance card: per-milestone claims ────────────────────────────

function IssuanceCard({
  issuancePda,
  issuance,
  asset,
  milestones,
  onDone,
}: {
  issuancePda: Address;
  issuance: RightsIssuance;
  asset: Asset | undefined;
  milestones: VestingMilestone[];
  onDone: () => Promise<void>;
}) {
  const conn = useWalletConnection();
  const client = useSolanaClient();
  const tx = useSendTransaction();
  const toast = useToast();
  const wallet = conn.wallet?.account.address;

  const sorted = useMemo(
    () => [...milestones].sort((a, b) => a.index - b.index),
    [milestones],
  );

  const [csvByIndex, setCsvByIndex] = useState<Record<number, string>>({});
  const [now] = useState(() => Math.floor(Date.now() / 1000));

  async function claim(milestone: VestingMilestone) {
    if (!wallet || !conn.wallet) return;
    const pendingId = toast.showPending(
      `Claiming milestone #${milestone.index}…`,
    );
    try {
      // Prove entitlement: try auto-derive from live holders, else CSV.
      let resolved = await deriveSnapshotProof(
        client.runtime.rpc,
        await mintForIssuance(client.runtime.rpc, issuance.shareClass),
        milestone.merkleRoot,
        wallet,
      );
      if (!resolved && csvByIndex[milestone.index]?.trim()) {
        resolved = await proofFromCsv(
          csvByIndex[milestone.index],
          milestone.merkleRoot,
          wallet,
        );
      }
      if (!resolved) {
        toast.dismiss(pendingId);
        toast.showError(
          "No proof available",
          "Could not derive your entitlement. Paste the milestone snapshot CSV (claimer,entitlement).",
        );
        return;
      }
      const iss = await fetchMaybeRightsIssuance(
        client.runtime.rpc,
        issuancePda,
      );
      if (!iss.exists) {
        toast.dismiss(pendingId);
        toast.showError("Issuance vanished", "Account no longer exists.");
        return;
      }
      const milestonePda = await findMilestonePda(issuancePda, milestone.index);
      const claimPda = await findClaimPda(milestonePda, wallet);
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
        milestone: milestonePda,
        claim: claimPda,
        underlyingMint: iss.data.underlyingMint,
        escrow: iss.data.escrow,
        claimerTokenAccount: claimerAta,
        tokenProgram: TOKEN_2022_ADDRESS,
        amount: resolved.weight,
        proof: resolved.proof,
      });
      // Mode-aware hook tail for the escrow→claimer leg. On a KycGated mint the
      // meta list is 9 accounts (config/registry/KycEntry/markers), not the
      // fixed 3-account Open tail — a wrong-length tail makes Token-2022 fail to
      // resolve the transfer and the claim reverts. Rights escrows carry no
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
      const sig = await tx.send({ instructions: [createAtaIx, claimIx], feePayer: signer });
      toast.dismiss(pendingId);
      toast.showTx(sig, { title: "Milestone claimed" });
      await onDone();
    } catch (err) {
      toast.dismiss(pendingId);
      toast.showError("Failed to claim", explainSendError(err));
    }
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            {asset?.name ?? "(asset unknown)"} · issuance #
            {String(issuance.issuanceId)}
          </h3>
          <p className="mt-0.5 font-mono text-[11px] text-slate-500">
            underlying {issuance.underlyingMint.toString().slice(0, 6)}…
            {issuance.underlyingMint.toString().slice(-4)} ·{" "}
            {issuance.milestonesCount} milestone
            {issuance.milestonesCount === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      {sorted.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500">
          No milestones published yet.
        </p>
      ) : (
        <div className="mt-4 space-y-3">
          {sorted.map((m) => {
            const locked = m.unlockTs > BigInt(0) && Number(m.unlockTs) > now;
            const exhausted = m.claimed >= m.amountPool;
            const unlockLabel =
              m.unlockTs === BigInt(0)
                ? "immediate"
                : new Date(Number(m.unlockTs) * 1000)
                    .toISOString()
                    .slice(0, 16)
                    .replace("T", " ") + "Z";
            return (
              <div
                key={m.index}
                className="rounded-lg border border-slate-200 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-mono text-slate-900">
                      milestone #{m.index}
                    </span>
                    <span className="ml-2 text-xs text-slate-500">
                      pool {String(m.amountPool)} · claimed{" "}
                      {String(m.claimed)} · unlock {unlockLabel}
                    </span>
                  </div>
                  <button
                    type="button"
                    disabled={tx.isSending || locked || exhausted}
                    onClick={() => void claim(m)}
                    title={
                      locked
                        ? "Milestone not yet unlocked."
                        : exhausted
                          ? "Milestone pool fully claimed."
                          : undefined
                    }
                    className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {locked ? "Locked" : exhausted ? "Exhausted" : "Claim"}
                  </button>
                </div>
                <textarea
                  value={csvByIndex[m.index] ?? ""}
                  onChange={(e) =>
                    setCsvByIndex((prev) => ({
                      ...prev,
                      [m.index]: e.target.value,
                    }))
                  }
                  rows={2}
                  placeholder="optional: snapshot CSV (claimer,entitlement) if auto-derive fails"
                  className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-[11px] focus:border-slate-400 focus:outline-none"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── helpers ─────────────────────────────────────────────────────────────────────

/** Resolve the Token-2022 mint of a share-class PDA (for snapshot rebuilds). */
async function scMintFor(
  rpc: Rpc,
  shareClassPda: Address,
): Promise<Address | null> {
  try {
    const { fetchMaybeShareClass } = await import(
      "@/lib/generated/asset_registry"
    );
    const maybe = await fetchMaybeShareClass(rpc, shareClassPda);
    return maybe.exists ? maybe.data.mint : null;
  } catch {
    return null;
  }
}

async function mintForIssuance(rpc: Rpc, shareClassPda: Address): Promise<Address> {
  return (await scMintFor(rpc, shareClassPda)) ?? shareClassPda;
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">
        {label}
      </dt>
      <dd className="mt-0.5 break-all font-mono text-sm text-slate-800">
        {value}
      </dd>
    </div>
  );
}

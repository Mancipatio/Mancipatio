"use client";
import { useState, useSyncExternalStore } from "react";
import { address } from "@solana/kit";
import { useWalletConnection, useSolanaClient, useSendTransaction } from "@solana/react-hooks";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync } from "@solana-program/token-2022";
import { PayoutVaultState } from "@/lib/generated/asset_registry";
import { getLegacySnapshot, getLegacyServerSnapshot, subscribeLegacy } from "@/lib/legacy-accounts-store";
import { readLegacyRefundState, legacyRefundInstructions } from "@/lib/legacy-payout-refund";
import { getPayoutSnapshotProof } from "@/lib/payout-snapshots-client";
import { snapshotHex, snapshotBytes, verifyOriginalSnapshotProof, type PayoutSnapshotProof } from "@/lib/payout-snapshots";
import { fetchMintTokenProgram } from "@/lib/transaction-builders";
import { walletSigner } from "@/lib/wallet-signer";
import { useToast } from "@/lib/toast";
import { explainSendError } from "@/lib/tx-error";
import { useRole } from "@/lib/auth";
import { detectNetwork } from "@/lib/network";
import { PayoutSnapshotReview } from "@/components/payout-snapshot-review";
export function LegacyPayoutRefunds({ onDone }: { onDone: () => Promise<void> }) {
  const state = useSyncExternalStore(subscribeLegacy, getLegacySnapshot, getLegacyServerSnapshot);
  const conn = useWalletConnection(); const role = useRole();
  if (state.network !== detectNetwork()) return null;
  const records = state.payoutVaults.filter((r) => r.vault.state === PayoutVaultState.Cancelled);
  if (!records.length) return null;
  return <section className="space-y-3"><h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">Original legacy capital refunds</h2><p className="text-sm text-slate-600">These cancelled v1 vaults remain separate from current votes. A refund requires the original return-capital decision and your original investor proof. Current token balances do not determine this entitlement.</p>{records.map((r) => <LegacyRefundCard key={`${r.address}:${conn.wallet?.account.address}`} vaultAddress={r.address} admin={role.isAdmin || role.isSuperAdmin} onDone={onDone} />)}</section>;
}
function LegacyRefundCard({ vaultAddress, admin, onDone }: { vaultAddress: string; admin: boolean; onDone: () => Promise<void> }) {
  const conn = useWalletConnection(); const client = useSolanaClient(); const tx = useSendTransaction(); const toast = useToast();
  const [proof, setProof] = useState<PayoutSnapshotProof | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  async function loadProof() {
    if (!conn.wallet) return; setBusy(true); setError(null); setProof(null);
    try {
      const state = await readLegacyRefundState(client.runtime.rpc, address(vaultAddress)); const root = snapshotHex(state.vote.snapshotRoot);
      const saved = await getPayoutSnapshotProof(conn.wallet, "legacy_vault_vote", vaultAddress, "0", root);
      if (saved.root_hex !== root || saved.total_weight !== String(state.vault.totalWeight) || !await verifyOriginalSnapshotProof(conn.wallet.account.address, saved.weight, saved.proof, root)) throw new Error("Original legacy entitlement proof does not match this wallet or vault");
      setProof(saved);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  async function claim() {
    if (!conn.wallet || !proof) return; setBusy(true); setError(null);
    try {
      const state = await readLegacyRefundState(client.runtime.rpc, address(vaultAddress));
      if (snapshotHex(state.vote.snapshotRoot) !== proof.root_hex || String(state.vault.totalWeight) !== proof.total_weight || !await verifyOriginalSnapshotProof(conn.wallet.account.address, proof.weight, proof.proof, proof.root_hex)) throw new Error("Original entitlement changed; reload its verified proof");
      const signer = walletSigner(conn.wallet); const tokenProgram = await fetchMintTokenProgram(client.runtime.rpc, state.vault.paymentMint, { commitment: "finalized", abortSignal: AbortSignal.timeout(10_000) });
      const [investorAccount] = await findAssociatedTokenPda({ owner: signer.address, mint: state.vault.paymentMint, tokenProgram });
      const createAta = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: signer, owner: signer.address, mint: state.vault.paymentMint, tokenProgram });
      const instructions = await legacyRefundInstructions(state, signer, tokenProgram, investorAccount, BigInt(proof.weight), proof.proof.map(snapshotBytes));
      const sig = await tx.send({ instructions: [createAta, ...instructions], feePayer: signer });
      toast.showTx(sig, { title: "Original legacy capital refund" }); setProof(null); await onDone();
    } catch (err) { setError(explainSendError(err)); }
    finally { setBusy(false); }
  }
  return <div className="rounded-xl border border-emerald-200 bg-white p-4 text-sm"><p className="break-all font-mono text-xs">{vaultAddress}</p><p className="mt-2 text-slate-600">The claim prepares the original vault and vote allocation if needed. It preserves v1 rights and pays any required additional account rent from your wallet.</p><div className="mt-3 flex flex-wrap gap-3"><button type="button" disabled={busy || !conn.wallet} onClick={() => void loadProof()} className="rounded border border-emerald-300 px-3 py-2 text-emerald-800 disabled:opacity-50">Load original refund entitlement</button><button type="button" disabled={busy || !proof} onClick={() => void claim()} className="rounded bg-emerald-700 px-3 py-2 text-white disabled:opacity-50">{busy ? "Working…" : "Prepare and claim original refund"}</button></div>{proof && <p className="mt-2">Verified original weight: {proof.weight} of {proof.total_weight}.</p>}{error && <p role="alert" className="mt-2 text-rose-700">{error}</p>}{admin && <PayoutSnapshotReview vault={vaultAddress} currentRound={BigInt(0)} legacy />}</div>;
}

"use client";
import type { WalletSession } from "@solana/client";
import { signedFetch, createSignedRequest } from "@/lib/siws-client";
import { canonicalPayoutSnapshot, type PayoutSnapshotKind, type SnapshotWeight, type PreparedPayoutSnapshot, type PayoutSnapshotProof } from "@/lib/payout-snapshots";
export async function preparePayoutSnapshot(session: WalletSession | null | undefined, kind: PayoutSnapshotKind, target_pda: string, round: string, rows: SnapshotWeight[]): Promise<PreparedPayoutSnapshot> {
  const canonical = await canonicalPayoutSnapshot(rows);
  const payload = await createSignedRequest(session, "payout-snapshots.prepare", { kind, target_pda, round, root_hex: canonical.root_hex, total_weight: canonical.total_weight, rows_hash: canonical.rows_hash });
  const response = await fetch("/api/payout-snapshots/prepare", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, snapshot_rows: canonical.rows }), cache: "no-store" });
  const result = await response.json();
  if (!response.ok || result?.ok !== true) throw new Error(result?.error ?? "Snapshot preparation failed");
  return result.data as PreparedPayoutSnapshot;
}
export function bindPayoutSnapshot(session: WalletSession | null | undefined, snapshot_id: string) {
  return signedFetch<PreparedPayoutSnapshot>(session, "/api/payout-snapshots/bind", "payout-snapshots.bind", { snapshot_id });
}
export function getPayoutSnapshotProof(session: WalletSession | null | undefined, kind: PayoutSnapshotKind, target_pda: string, round: string, root_hex: string) {
  return signedFetch<PayoutSnapshotProof>(session, "/api/payout-snapshots/proof", "payout-snapshots.proof", { kind, target_pda, round, root_hex });
}
export function readPayoutSnapshots(session: WalletSession | null | undefined, target_pda: string) {
  return signedFetch<{ snapshots: PreparedPayoutSnapshot[] }>(session, "/api/payout-snapshots/admin-read", "payout-snapshots.adminRead", { target_pda });
}

export function readOriginalPayoutEntries(session: WalletSession | null | undefined, target_pda: string, snapshot_id: string) {
  return signedFetch<{ entries: SnapshotWeight[] }>(session, "/api/payout-snapshots/admin-read", "payout-snapshots.adminRead", { target_pda, snapshot_id });
}

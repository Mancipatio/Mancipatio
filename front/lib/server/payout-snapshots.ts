import "server-only";
import { address } from "@solana/kit";
import { ASSET_REGISTRY_PROGRAM_ADDRESS, getVaultVoteDecoder, getVaultVoteDiscriminatorBytes, findVaultPda, PayoutVaultState, VaultVoteOutcome } from "@/lib/generated/asset_registry";
import { decodeReadablePayoutVault, isLegacyPayoutVault, decodeReadableVaultVote, isLegacyVaultVote } from "@/lib/legacy-accounts";
import { vaultVotePda, legacyVaultVotePda } from "@/lib/payout-vote-pda";
import { canonicalPayoutSnapshot, snapshotHex, type PayoutSnapshotKind, type PreparedPayoutSnapshot } from "@/lib/payout-snapshots";
import { getServerRpc } from "@/lib/server/rpc";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { SiwsError } from "@/lib/server/siws";
export type SnapshotLocator = { kind: PayoutSnapshotKind; target_pda: string; round: string; root_hex: string; total_weight: string };
export type StoredPayoutSnapshot = PreparedPayoutSnapshot & { network: string; rows_hash: string; bound_slot: string | null };
const timeout = () => AbortSignal.timeout(10_000);
export function payoutSnapshotLocator(params: Record<string, unknown>, requireTotal = true): SnapshotLocator {
  const { kind, target_pda, round, root_hex, total_weight } = params;
  if (kind !== "vault_vote" && kind !== "investor_yield" && kind !== "legacy_vault_vote") throw new SiwsError(400, "Invalid snapshot kind");
  if (typeof target_pda !== "string") throw new SiwsError(400, "Invalid payout vault address");
  try { address(target_pda); } catch { throw new SiwsError(400, "Invalid payout vault address"); }
  if (typeof round !== "string" || !/^(0|[1-9]\d{0,19})$/.test(round) || BigInt(round) > BigInt("18446744073709551615") || (kind === "vault_vote" ? round === "0" : round !== "0")) throw new SiwsError(400, "Invalid snapshot round");
  if (typeof root_hex !== "string" || !/^[a-f0-9]{64}$/.test(root_hex) || /^0+$/.test(root_hex)) throw new SiwsError(400, "Invalid snapshot root");
  if (requireTotal && (typeof total_weight !== "string" || !/^[1-9]\d{0,19}$/.test(total_weight) || BigInt(total_weight) > BigInt("18446744073709551615"))) throw new SiwsError(400, "Invalid snapshot total weight");
  return { kind, target_pda, round, root_hex, total_weight: typeof total_weight === "string" ? total_weight : "" };
}
function accountBytes(value: unknown): Uint8Array {
  const data = value as { owner?: unknown; data?: unknown };
  if (!data || data.owner !== ASSET_REGISTRY_PROGRAM_ADDRESS || !Array.isArray(data.data) || data.data[1] !== "base64" || typeof data.data[0] !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.data[0])) throw new SiwsError(409, "Unexpected snapshot account owner or encoding");
  return new Uint8Array(Buffer.from(data.data[0], "base64"));
}
async function vaultSnapshot(locator: SnapshotLocator, withVote: boolean) {
  const addrs = [address(locator.target_pda)];
  if (withVote && locator.kind === "vault_vote") addrs.push(await vaultVotePda(addrs[0], BigInt(locator.round)));
  if (withVote && locator.kind === "legacy_vault_vote") addrs.push(await legacyVaultVotePda(addrs[0]));
  const snapshot = await getServerRpc().getMultipleAccounts(addrs, { commitment: "finalized", encoding: "base64" }).send({ abortSignal: timeout() }).catch(() => { throw new SiwsError(503, "Finalized payout snapshot unavailable — retry"); });
  if (!snapshot?.context || !["number", "bigint"].includes(typeof snapshot.context.slot) || !Array.isArray(snapshot.value)) throw new SiwsError(503, "Incomplete finalized snapshot");
  const slot = Number(snapshot.context.slot);
  if (!Number.isSafeInteger(slot) || slot < 0 || snapshot.value.length !== addrs.length) throw new SiwsError(503, "Incomplete finalized snapshot");
  if (!snapshot.value[0]) throw new SiwsError(409, "Payout vault is not finalized on this network");
  const vault = decodeReadablePayoutVault(accountBytes(snapshot.value[0]));
  if ((await findVaultPda({ sale: vault.sale }))[0] !== locator.target_pda) throw new SiwsError(409, "Payout vault identity mismatch");
  return { vault, snapshot, slot };
}
export async function verifyPayoutSnapshotBinding(locator: SnapshotLocator) {
  const { vault, snapshot, slot } = await vaultSnapshot(locator, true);
  let root: string;
  if (locator.kind === "legacy_vault_vote") {
    if (!isLegacyPayoutVault(vault) || vault.state !== PayoutVaultState.Cancelled || !snapshot.value[1]) throw new SiwsError(409, "Only a cancelled legacy vault with an original return-capital vote supports this recovery");
    const vote = decodeReadableVaultVote(accountBytes(snapshot.value[1]));
    if (!isLegacyVaultVote(vote) || vote.payoutVault !== locator.target_pda || vote.outcome !== VaultVoteOutcome.ReturnCapital) throw new SiwsError(409, "The original legacy vote has no terminal return-capital decision");
    root = snapshotHex(vote.snapshotRoot);
  } else if (isLegacyPayoutVault(vault)) throw new SiwsError(409, "Legacy payout vault requires its separately verified terminal refund flow");
  else if (locator.kind === "vault_vote") {
    if (!snapshot.value[1]) throw new SiwsError(409, "Vote round is not finalized yet; retry snapshot verification");
    const bytes = accountBytes(snapshot.value[1]);
    if (!getVaultVoteDiscriminatorBytes().every((b, i) => b === bytes[i])) throw new SiwsError(409, "Unexpected vote account discriminator");
    const vote = getVaultVoteDecoder().decode(bytes);
    if (vote.version !== 2 || vote.payoutVault !== locator.target_pda || vote.round.toString() !== locator.round || vote.round > vault.voteRound) throw new SiwsError(409, "Snapshot vote round does not match the vault");
    root = snapshotHex(vote.snapshotRoot);
  } else root = snapshotHex(vault.investorYieldRoot);
  if (root !== locator.root_hex || vault.totalWeight.toString() !== locator.total_weight) throw new SiwsError(409, "Stored snapshot does not match the finalized on-chain root and total");
  return { slot, root, total: vault.totalWeight.toString() };
}
export async function prepareOriginalPayoutSnapshot(wallet: string, params: Record<string, unknown>, input: unknown) {
  const locator = payoutSnapshotLocator(params);
  let canonical: Awaited<ReturnType<typeof canonicalPayoutSnapshot>>;
  try { canonical = await canonicalPayoutSnapshot(input); } catch (err) { throw new SiwsError(400, err instanceof Error ? err.message : "Invalid snapshot"); }
  if (params.rows_hash !== canonical.rows_hash || locator.root_hex !== canonical.root_hex || locator.total_weight !== canonical.total_weight) throw new SiwsError(400, "Snapshot rows do not match signed digest, root or total");
  if (locator.kind === "legacy_vault_vote") {
    await verifyPayoutSnapshotBinding(locator);
    return persistOriginalSnapshot(wallet, locator, canonical);
  }
  const { vault } = await vaultSnapshot(locator, false);
  if (isLegacyPayoutVault(vault)) throw new SiwsError(409, "Legacy payout vault requires its separately verified terminal refund flow");
  if (vault.totalWeight !== BigInt(0) && vault.totalWeight.toString() !== locator.total_weight) throw new SiwsError(409, "Original investor total weight cannot change");
  if (locator.kind === "vault_vote") {
    const round = BigInt(locator.round);
    if (round > vault.voteRound + BigInt(1)) throw new SiwsError(409, "Prepare the next vote round only");
    if (round > vault.voteRound && (vault.state !== PayoutVaultState.Frozen || vault.votePending)) throw new SiwsError(409, "Vault is not ready for a new vote round");
    if (round <= vault.voteRound) await verifyPayoutSnapshotBinding(locator); // original-data recovery must match the existing round
  } else {
    const root = snapshotHex(vault.investorYieldRoot);
    if (!/^0+$/.test(root) && root !== locator.root_hex) throw new SiwsError(409, "Original investor entitlement snapshot cannot change");
    if (/^0+$/.test(root) && vault.state !== PayoutVaultState.Active) throw new SiwsError(409, "Vault is not active for first yield funding");
  }
  return persistOriginalSnapshot(wallet, locator, canonical);
}
async function persistOriginalSnapshot(wallet: string, locator: SnapshotLocator, canonical: Awaited<ReturnType<typeof canonicalPayoutSnapshot>>) {
  const { data, error } = await getSupabaseAdmin().rpc("prepare_payout_snapshot", {
    p_snapshot: { ...locator, network: detectNetwork(), rows_hash: canonical.rows_hash, entry_count: canonical.count, created_by: wallet }, p_entries: canonical.entries,
  }).abortSignal(timeout());
  if (error || !data) throw new SiwsError(503, "Durable snapshot preparation unavailable");
  return data as StoredPayoutSnapshot;
}
export async function getStoredPayoutSnapshot(id: unknown): Promise<StoredPayoutSnapshot> {
  if (typeof id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new SiwsError(400, "Invalid snapshot id");
  const { data, error } = await getSupabaseAdmin().from("payout_snapshot_metadata").select("*").eq("id", id).eq("network", detectNetwork()).abortSignal(timeout()).maybeSingle();
  if (error) throw new SiwsError(503, "Snapshot lookup unavailable");
  if (!data) throw new SiwsError(404, "Snapshot not found on this network");
  return data as StoredPayoutSnapshot;
}
export async function bindOriginalPayoutSnapshot(id: unknown) {
  const stored = await getStoredPayoutSnapshot(id);
  const proof = await verifyPayoutSnapshotBinding(stored);
  const { data, error } = await getSupabaseAdmin().rpc("bind_payout_snapshot", { p_id: stored.id, p_network: detectNetwork(), p_root: proof.root, p_total: proof.total, p_slot: proof.slot }).abortSignal(timeout());
  if (error || !data) throw new SiwsError(503, "Snapshot verification could not be saved; retry verification");
  return data as StoredPayoutSnapshot;
}

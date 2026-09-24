import "server-only";
import { address, getAddressEncoder, getProgramDerivedAddress, isSome, type Address } from "@solana/kit";
import { getMintDecoder } from "@solana-program/token-2022";
import {
  ASSET_REGISTRY_PROGRAM_ADDRESS, getDistributionDecoder, getDistributionDiscriminatorBytes,
  getDistributionPlanDecoder, getDistributionPlanDiscriminatorBytes,
  getDistributionBatchDecoder, getDistributionBatchDiscriminatorBytes,
  getShareClassDecoder, getShareClassDiscriminatorBytes,
} from "@/lib/generated/asset_registry";
import { canonicalDistributionPlan, assertStoredDistributionPlan, distributionPlanPda, distributionBatchPda,
  type CanonicalDistributionPlan, type DistributionPlanContext, type DistributionPlanEntry,
  type DistributionPlanBatch, type PreparedDistributionPlan } from "@/lib/distribution-plans";
import { snapshotHex } from "@/lib/payout-snapshots";
import { detectNetwork } from "@/lib/network";
import { getServerRpc } from "@/lib/server/rpc";
import { assertAllowedPaymentMint } from "@/lib/server/payment-mint";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { SiwsError } from "@/lib/server/siws";

type Metadata = Omit<PreparedDistributionPlan, "batches">;
const timeout = () => AbortSignal.timeout(10_000);
const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const U64 = BigInt("18446744073709551615");
function id(value: unknown) { if (typeof value !== "string" || !ID.test(value)) throw new SiwsError(400, "Invalid distribution plan id"); return value; }
function pubkey(value: unknown) { try { if (typeof value !== "string") throw Error(); return address(value); } catch { throw new SiwsError(400, "Invalid distribution address"); } }
function integer(value: unknown, zero = false) { if (typeof value !== "string" || !/^(0|[1-9]\d{0,19})$/.test(value) || BigInt(value) > U64 || (!zero && value === "0")) throw new SiwsError(400, "Distribution values must be exact u64 strings"); return value; }
function context(params: Record<string, unknown>): DistributionPlanContext {
  return { distribution_pda: pubkey(params.distribution_pda), distribution_id: integer(params.distribution_id, true),
    share_class: pubkey(params.share_class), payment_mint: pubkey(params.payment_mint), payment_token_program: pubkey(params.payment_token_program),
    funder: pubkey(params.funder), total_amount: integer(params.total_amount), snapshot_supply: integer(params.snapshot_supply) };
}
type Encoded = { owner: string; data: readonly [string, string] };
function bytes(value: unknown, owner: string, discriminator?: ArrayLike<number>) {
  const account = value as Encoded;
  if (!account || account.owner !== owner || !Array.isArray(account.data) || account.data[1] !== "base64" || typeof account.data[0] !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(account.data[0])) throw new SiwsError(409, "Unexpected distribution account owner or encoding");
  const result = new Uint8Array(Buffer.from(account.data[0], "base64"));
  if (discriminator && !Array.from(discriminator).every((b, i) => b === result[i])) throw new SiwsError(409, "Unexpected distribution account discriminator");
  return result;
}
async function snapshot(keys: Address[], minSlot?: number) {
  const result = await getServerRpc().getMultipleAccounts(keys, { commitment: "finalized", encoding: "base64", ...(minSlot === undefined ? {} : { minContextSlot: BigInt(minSlot) }) }).send({ abortSignal: timeout() }).catch(() => { throw new SiwsError(503, "Finalized distribution state unavailable; retry"); });
  if (!result?.context || !["number", "bigint"].includes(typeof result.context.slot) || !Array.isArray(result.value) || result.value.length !== keys.length) throw new SiwsError(503, "Incomplete finalized distribution snapshot");
  const slot = Number(result.context.slot);
  if (!Number.isSafeInteger(slot) || slot < (minSlot ?? 0)) throw new SiwsError(503, "Stale or invalid distribution snapshot slot");
  return { accounts: result.value, slot };
}
async function shareClassAndMint(ctx: DistributionPlanContext, account: unknown, mintAccount: unknown) {
  let shareClass: ReturnType<ReturnType<typeof getShareClassDecoder>["decode"]>;
  try { shareClass = getShareClassDecoder().decode(bytes(account, ASSET_REGISTRY_PROGRAM_ADDRESS, getShareClassDiscriminatorBytes())); }
  catch (err) { if (err instanceof SiwsError) throw err; throw new SiwsError(409, "Share class layout is unsupported"); }
  const expected = (await getProgramDerivedAddress({ programAddress: ASSET_REGISTRY_PROGRAM_ADDRESS, seeds: [new TextEncoder().encode("share_class"), getAddressEncoder().encode(shareClass.asset), new Uint8Array([shareClass.classIndex])] }))[0];
  if (shareClass.version !== 2 || expected !== ctx.share_class || !shareClass.mintInitialized) throw new SiwsError(409, "An initialized current-version share class is required");
  const data = bytes(mintAccount, ctx.payment_token_program);
  const isClassic = ctx.payment_token_program === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
  const is2022 = ctx.payment_token_program === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
  if ((!isClassic && !is2022) || !(data.length === 82 || (is2022 && data.length >= 166 && data[165] === 1))) throw new SiwsError(409, "Payment account is not a supported token mint");
  try {
    const mint = getMintDecoder().decode(data);
    if (!mint.isInitialized) throw Error("Uninitialized mint");
    const benign = new Set(["MintCloseAuthority", "MetadataPointer", "TokenMetadata", "GroupPointer", "TokenGroup", "GroupMemberPointer", "TokenGroupMember"]);
    if (isSome(mint.extensions) && mint.extensions.value.some((extension) => !benign.has(extension.__kind))) throw Error("Unsupported payment mint extension");
  } catch { throw new SiwsError(409, "Payment mint is uninitialized or has unsupported transfer behavior"); }
  return shareClass;
}
export async function verifyDistributionPlanBinding(plan: CanonicalDistributionPlan) {
  const distribution = pubkey(plan.distribution_pda);
  const { accounts, slot } = await snapshot([distribution, await distributionPlanPda(distribution), pubkey(plan.share_class), pubkey(plan.payment_mint)]);
  if (!accounts[0] || !accounts[1]) throw new SiwsError(409, "Distribution funding is not finalized yet; retry verification");
  const sc = await shareClassAndMint(plan, accounts[2], accounts[3]);
  try {
    const d = getDistributionDecoder().decode(bytes(accounts[0], ASSET_REGISTRY_PROGRAM_ADDRESS, getDistributionDiscriminatorBytes()));
    const committed = getDistributionPlanDecoder().decode(bytes(accounts[1], ASSET_REGISTRY_PROGRAM_ADDRESS, getDistributionPlanDiscriminatorBytes()));
    if (d.version !== 2 || committed.version !== 1 || committed.distribution !== distribution || snapshotHex(committed.batchRoot) !== plan.root_hex || committed.batchCount !== plan.batch_count
      || d.distributionId.toString() !== plan.distribution_id || d.shareClass !== plan.share_class || d.funder !== plan.funder || d.admin !== plan.funder
      || d.mint !== sc.mint || d.paymentMint !== plan.payment_mint || d.totalAmount.toString() !== plan.total_amount || d.snapshotSupply.toString() !== plan.snapshot_supply) throw Error("Binding mismatch");
    return { slot, distribution: d };
  } catch (err) { if (err instanceof SiwsError) throw err; throw new SiwsError(409, "Saved plan differs from the finalized distribution commitment"); }
}
export async function prepareDistributionPlan(wallet: string, params: Record<string, unknown>, rawEntries: unknown) {
  const ctx = context(params);
  if (ctx.funder !== wallet) throw new SiwsError(403, "The funding wallet must sign preparation of its distribution plan");
  let canonical: CanonicalDistributionPlan;
  try { canonical = await canonicalDistributionPlan(ctx, rawEntries as DistributionPlanEntry[]); }
  catch (error) { throw new SiwsError(400, error instanceof Error ? error.message : "Invalid distribution plan"); }
  if (params.root_hex !== canonical.root_hex || params.plan_hash !== canonical.plan_hash || params.batch_count !== canonical.batch_count) throw new SiwsError(400, "Distribution entries differ from the signed plan commitment");
  const { accounts } = await snapshot([pubkey(ctx.share_class), pubkey(ctx.payment_mint), pubkey(ctx.distribution_pda)]);
  await shareClassAndMint(ctx, accounts[0], accounts[1]);
  if (accounts[2]) await verifyDistributionPlanBinding(canonical); // Recovery must match the original funded plan.
  // A new plan is funded next (an ENTRY path): on mainnet only an allowlisted
  // payment mint. Recovering an existing funded distribution stays possible.
  else assertAllowedPaymentMint(detectNetwork(), ctx.payment_mint);
  const { data, error } = await getSupabaseAdmin().rpc("prepare_distribution_plan", { p_plan: { ...canonical, batches: undefined, network: detectNetwork(), created_by: wallet }, p_batches: canonical.batches }).abortSignal(timeout());
  if (error || !data) throw new SiwsError(error?.message?.includes("Immutable distribution") ? 409 : 503, error?.message?.includes("Immutable distribution") ? "A different immutable plan already exists for this distribution id" : "Durable distribution preparation unavailable; retry the same id");
  return readDistributionPlan(data);
}
export async function getDistributionPlanMetadata(value: unknown): Promise<Metadata> {
  const planId = id(value);
  const { data, error } = await getSupabaseAdmin().from("distribution_plan_metadata").select("*").eq("id", planId).eq("network", detectNetwork()).abortSignal(timeout()).maybeSingle();
  if (error) throw new SiwsError(503, "Distribution plan lookup unavailable");
  if (!data) throw new SiwsError(404, "Distribution plan not found on this network");
  return data as Metadata;
}
export async function readDistributionPlan(value: unknown): Promise<PreparedDistributionPlan> {
  const meta = await getDistributionPlanMetadata(value);
  const { data, error } = await getSupabaseAdmin().from("distribution_plan_batches").select("batch_id,entries,leaf_hex,proof").eq("plan_id", meta.id).order("batch_id", { ascending: true }).limit(834).abortSignal(timeout());
  if (error || !data) throw new SiwsError(503, "Original distribution batches unavailable");
  const plan = { ...meta, batches: data as DistributionPlanBatch[] };
  try { await assertStoredDistributionPlan(plan); } catch { throw new SiwsError(503, "Original distribution plan failed integrity verification"); }
  return plan;
}
export async function bindDistributionPlan(value: unknown) {
  const plan = await readDistributionPlan(value); const proof = await verifyDistributionPlanBinding(plan);
  const { error } = await getSupabaseAdmin().rpc("bind_distribution_plan", { p_id: plan.id, p_network: detectNetwork(), p_root: plan.root_hex, p_hash: plan.plan_hash, p_slot: proof.slot }).abortSignal(timeout());
  if (error) throw new SiwsError(503, "Distribution verification could not be saved; retry verification without funding again");
  return { ...plan, status: "bound" as const, bound_slot: plan.bound_slot ?? String(proof.slot) };
}
export async function listDistributionPlans(params: Record<string, unknown>) {
  let query = getSupabaseAdmin().from("distribution_plan_metadata").select("*").eq("network", detectNetwork()).order("id", { ascending: true }).limit(100);
  if (params.distribution_pda !== undefined) query = query.eq("distribution_pda", pubkey(params.distribution_pda));
  if (params.cursor !== undefined) query = query.gt("id", id(params.cursor));
  const { data, error } = await query.abortSignal(timeout());
  if (error || !data) throw new SiwsError(503, "Distribution plan review unavailable");
  return { plans: data as Metadata[], next_cursor: data.length === 100 ? String(data[99].id) : null };
}
/** A recipient sees their own payment and a verified receipt status, never the
 * other recipients in the same batch. Only administrators obtain full proofs. */
export async function readDistributionSelfProof(wallet: string, value: unknown) {
  const meta = await getDistributionPlanMetadata(value);
  const member = await getSupabaseAdmin().from("distribution_plan_batches").select("batch_id").eq("plan_id", meta.id).contains("entries", [{ token_owner: wallet }]).abortSignal(timeout()).maybeSingle();
  if (member.error) throw new SiwsError(503, "Distribution entitlement unavailable");
  if (!member.data) throw new SiwsError(404, "No distribution entitlement for the connected wallet");
  const batchId = member.data.batch_id;
  const plan = await readDistributionPlan(meta.id);
  const batch = plan.batches.find((b) => b.batch_id === batchId);
  const entry = batch?.entries.find((e) => e.token_owner === wallet);
  if (!batch || !entry) throw new SiwsError(503, "Distribution entitlement failed integrity verification");
  const { slot } = await verifyDistributionPlanBinding(plan);
  const receiptPda = await distributionBatchPda(pubkey(plan.distribution_pda), batch.batch_id);
  const receiptSnapshot = await snapshot([receiptPda], slot); const receipt = receiptSnapshot.accounts[0];
  if (receipt) {
    try {
      const paid = getDistributionBatchDecoder().decode(bytes(receipt, ASSET_REGISTRY_PROGRAM_ADDRESS, getDistributionBatchDiscriminatorBytes()));
      const total = batch.entries.reduce((sum, e) => sum + BigInt(e.amount), BigInt(0));
      if (paid.version !== 1 || paid.distribution !== plan.distribution_pda || paid.batchId !== batch.batch_id || snapshotHex(paid.batchHash) !== batch.leaf_hex || paid.totalAmount !== total || paid.paidCount !== batch.entries.length) throw Error("Receipt mismatch");
    } catch (error) { if (error instanceof SiwsError) throw error; throw new SiwsError(409, "Distribution receipt does not match the original batch"); }
  }
  return { plan_id: plan.id, distribution_pda: plan.distribution_pda, root_hex: plan.root_hex, batch_id: batch.batch_id,
    token_account: entry.token_account, amount: entry.amount, payment_mint: plan.payment_mint,
    receipt_pda: receiptPda, paid: Boolean(receipt), checked_slot: String(receiptSnapshot.slot) };
}

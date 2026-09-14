import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { requirePurchaseEvidence } from "@/lib/server/chain-evidence";
import { SiwsError } from "@/lib/server/siws";

type PurchaseJob = {
  id: string;
  network: string;
  buyer: string;
  sale_pubkey: string;
  signature: string;
  requested_instruction: number;
  attempts: number;
};
export type PurchaseRecordResult = {
  id: string | null;
  jobId: string;
  status: "pending" | "complete";
};
export async function enqueuePurchase(
  buyer: string,
  sale: string,
  signature: string,
  instruction?: number,
): Promise<PurchaseJob> {
  const sb = getSupabaseAdmin();
  const input = {
    network: detectNetwork(),
    buyer,
    sale_pubkey: sale,
    signature,
    requested_instruction: instruction ?? -1,
  };
  const { error } = await sb.from("purchase_evidence_jobs").upsert(input, {
    onConflict: "network,signature,buyer,sale_pubkey,requested_instruction",
    ignoreDuplicates: true,
  });
  if (error)
    throw new SiwsError(
      503,
      "Purchase queue unavailable; retry recording without buying again",
    );
  const { data, error: lookup } = await sb
    .from("purchase_evidence_jobs")
    .select("*")
    .match(input)
    .single();
  if (lookup || !data) throw new SiwsError(503, "Purchase queue unavailable");
  return data as PurchaseJob;
}
function databaseSignal(signal: AbortSignal): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
}
export async function processPurchaseJob(
  job: PurchaseJob,
  signal: AbortSignal = AbortSignal.timeout(20_000),
  deadlineMs = Date.now() + 20_000,
): Promise<PurchaseRecordResult> {
  if (job.network !== detectNetwork())
    throw new SiwsError(400, "Purchase belongs to another network");
  if (signal.aborted || Date.now() >= deadlineMs)
    return { id: null, jobId: job.id, status: "pending" };
  const sb = getSupabaseAdmin();
  try {
    signal.throwIfAborted();
    const proof = await requirePurchaseEvidence(
      job.signature,
      job.sale_pubkey,
      job.buyer,
      job.requested_instruction >= 0 ? job.requested_instruction : undefined,
      signal,
    );
    if (Date.now() >= deadlineMs)
      return { id: null, jobId: job.id, status: "pending" };
    signal.throwIfAborted();
    let documentVersionId: string | null = null;
    if (proof.terms && proof.asset) {
      const version = await sb
        .from("document_versions")
        .select("id,path,sha256,bucket")
        .eq("id", proof.terms.versionId)
        .eq("network", job.network)
        .abortSignal(databaseSignal(signal))
        .maybeSingle();
      if (version.error)
        throw new SiwsError(
          503,
          "Purchase document verification unavailable; queued for retry",
        );
      if (
        version.data?.bucket === "documents" &&
        version.data.sha256 === proof.terms.sha256 &&
        version.data.path.startsWith(`whitepapers/${proof.asset}/`)
      )
        documentVersionId = version.data.id;
    }
    const row = {
      network: job.network,
      sale_pubkey: job.sale_pubkey,
      investor_wallet: job.buyer,
      amount: proof.amount,
      status: "settled",
      settled_tx: job.signature,
      evidence_verified: true,
      payment_mint: proof.paymentMint,
      payment_decimals: proof.decimals,
      amount_atomic: proof.amountAtomic,
      units: proof.units,
      instruction_index: proof.instructionIndex,
      finalized_slot: proof.slot,
      document_version_id: documentVersionId,
      terms_acceptance: proof.terms
        ? {
            ...proof.terms,
            signature: job.signature,
            verified: !!documentVersionId,
          }
        : null,
    };
    const { data, error } = await sb
      .from("commitments")
      .insert(row)
      .select("id")
      .abortSignal(databaseSignal(signal))
      .single();
    if (signal.aborted || Date.now() >= deadlineMs)
      return { id: null, jobId: job.id, status: "pending" };
    let id = data?.id as string | undefined;
    if (error?.code === "23505") {
      const existing = await sb
        .from("commitments")
        .select("id,sale_pubkey,investor_wallet")
        .eq("network", job.network)
        .eq("settled_tx", job.signature)
        .eq("instruction_index", proof.instructionIndex)
        .eq("evidence_verified", true)
        .abortSignal(databaseSignal(signal))
        .maybeSingle();
      if (
        !existing.error &&
        existing.data?.sale_pubkey === job.sale_pubkey &&
        existing.data.investor_wallet === job.buyer
      )
        id = existing.data.id;
    }
    if (signal.aborted || Date.now() >= deadlineMs)
      return { id: null, jobId: job.id, status: "pending" };
    if (!id)
      throw new SiwsError(
        503,
        "Verified purchase write unavailable; queued for retry",
      );
    const completed = await sb
      .from("purchase_evidence_jobs")
      .update({
        status: "complete",
        commitment_id: id,
        last_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .abortSignal(databaseSignal(signal));
    if (completed.error)
      throw new SiwsError(
        503,
        "Purchase recorded; queue acknowledgment will retry",
      );
    return { id, jobId: job.id, status: "complete" };
  } catch (error) {
    // An exhausted worker budget is not invalid evidence. Do not acknowledge or
    // reschedule it with an aborted request; the persistent job remains pending.
    if (signal.aborted || Date.now() >= deadlineMs)
      return { id: null, jobId: job.id, status: "pending" };
    const invalid =
      error instanceof SiwsError && error.status >= 400 && error.status < 500;
    const message =
      error instanceof SiwsError
        ? error.message
        : "Verification temporarily unavailable";
    const retry = await sb
      .from("purchase_evidence_jobs")
      .update({
        status: invalid ? "invalid" : "pending",
        attempts: job.attempts + 1,
        next_attempt_at: new Date(
          Date.now() +
            Math.min(60_000 * 2 ** Math.min(job.attempts, 6), 3_600_000),
        ).toISOString(),
        last_error: message,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id)
      .neq("status", "complete")
      .abortSignal(databaseSignal(signal));
    if (signal.aborted || Date.now() >= deadlineMs || retry.error)
      return { id: null, jobId: job.id, status: "pending" };
    if (invalid) throw error;
    return { id: null, jobId: job.id, status: "pending" };
  }
}
/** Idempotent persistent retry, shared by signed admin and scheduler routes.
 * Every RPC and database operation shares the deadline; unfinished jobs stay pending. */
export async function reconcilePurchases(
  limit = 10,
  deadlineMs = Date.now() + 20_000,
  parentSignal?: AbortSignal,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20)
    throw new SiwsError(400, "Retry limit must be between 1 and 20");
  const counts = { complete: 0, pending: 0, invalid: 0 };
  const budgetMs = Math.min(20_000, deadlineMs - Date.now());
  if (budgetMs <= 0 || parentSignal?.aborted) return counts;
  const timeout = AbortSignal.timeout(budgetMs);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, timeout])
    : timeout;
  const { data, error } = await getSupabaseAdmin()
    .from("purchase_evidence_jobs")
    .select("*")
    .eq("network", detectNetwork())
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at")
    .limit(limit)
    .abortSignal(databaseSignal(signal));
  if (signal.aborted) return counts;
  if (error) throw new SiwsError(503, "Purchase queue unavailable");
  for (const row of data ?? []) {
    if (signal.aborted || Date.now() >= deadlineMs) break;
    try {
      const result = await processPurchaseJob(
        row as PurchaseJob,
        signal,
        deadlineMs,
      );
      if (result.status === "complete") counts.complete++;
      else counts.pending++;
    } catch (err) {
      if (signal.aborted) break;
      if (err instanceof SiwsError && err.status < 500) counts.invalid++;
      else throw err;
    }
  }
  return counts;
}

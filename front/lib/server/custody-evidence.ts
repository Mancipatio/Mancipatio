import "server-only";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { SiwsError } from "@/lib/server/siws";
import {
  requireDepositEvidence,
  requireRequestVault,
  transactionSignature,
  type CustodyRequestEvidence,
} from "@/lib/server/chain-evidence";
import { VaultState } from "@/lib/generated/asset_registry";
import { signature as toSignature } from "@solana/kit";
import { getServerRpc } from "@/lib/server/rpc";
import {
  ChainEvidenceError,
  custodyReturnEvidence,
  custodyRealizationEvidence,
  type ChainTransaction,
} from "@/lib/chain-evidence";

type RequestTable = "delivery_requests" | "conversion_requests";
async function requireReturnedDeposit(
  row: CustodyRequestEvidence,
  signature: unknown,
) {
  const outcomeTx = transactionSignature(signature);
  try {
    const tx = await getServerRpc()
      .getTransaction(toSignature(outcomeTx), {
        commitment: "finalized",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send({ abortSignal: AbortSignal.timeout(12_000) });
    if (!tx)
      throw new SiwsError(
        503,
        "Return is awaiting finalization. Retry recording without sending another transaction",
      );
    const { vault, escrow } = await requireRequestVault(row, tx.slot);
    const proof = custodyReturnEvidence(tx as ChainTransaction, outcomeTx, {
      holder: row.holder_wallet,
      vault: row.vault_pda!,
      shareClass: row.share_class_pda,
      mint: row.mint,
      escrow: vault.escrow,
      amount: BigInt(row.amount),
    });
    if (vault.deposited !== BigInt(0))
      throw new SiwsError(
        409,
        "The holder deposit has not been fully returned",
      );
    return {
      signature: outcomeTx,
      ...proof,
      vault: row.vault_pda,
      surplusRemaining: escrow.amount.toString(),
    };
  } catch (error) {
    if (error instanceof SiwsError) throw error;
    if (error instanceof ChainEvidenceError)
      throw new SiwsError(400, error.message);
    throw new SiwsError(
      503,
      "Return verification unavailable. Retry recording without returning tokens again",
    );
  }
}
export async function recordCustodyReturn(
  table: RequestTable,
  id: string,
  wallet: string,
  signature: unknown,
) {
  const outcomeTx = transactionSignature(signature);
  const sb = getSupabaseAdmin();
  const { data: row, error } = await sb
    .from(table)
    .select("*")
    .eq("id", id)
    .eq("network", detectNetwork())
    .maybeSingle();
  if (error) throw new SiwsError(503, "Request lookup unavailable");
  if (!row) throw new SiwsError(404, "Request not found");
  if (row.holder_wallet !== wallet)
    throw new SiwsError(403, "Only the request holder may record a return");
  if (
    row.status === "returned" &&
    row.outcome_tx === outcomeTx &&
    row.outcome_evidence
  )
    return { id, status: "returned" };
  const repairUnverifiedReturn =
    row.status === "returned" && !row.outcome_evidence;
  if (
    !repairUnverifiedReturn &&
    !["deposited", "in_delivery", "vault_opened"].includes(row.status)
  )
    throw new SiwsError(
      409,
      "Request cannot be returned from its current state",
    );
  const proof = await requireReturnedDeposit(row, outcomeTx);
  const result = await sb
    .from(table)
    .update({
      status: "returned",
      outcome_tx: outcomeTx,
      outcome_evidence: proof,
      admin_note:
        proof.surplusRemaining !== "0"
          ? "Holder deposit returned; unrelated surplus remains in the vault"
          : "On-chain return verified for the request holder",
    })
    .eq("id", id)
    .eq("network", detectNetwork())
    .eq("status", row.status)
    .select("id")
    .maybeSingle();
  if (result.error)
    throw new SiwsError(
      503,
      "Return confirmed; recording unavailable. Retry recording without another transaction",
    );
  if (!result.data)
    throw new SiwsError(409, "Request changed; refresh and retry recording");
  return { id, status: "returned" };
}
export async function recordCustodyDeposit(
  table: RequestTable,
  id: string,
  wallet: string,
  signature: unknown,
) {
  const depositTx = transactionSignature(signature);
  const sb = getSupabaseAdmin();
  const { data: row, error } = await sb
    .from(table)
    .select("*")
    .eq("id", id)
    .eq("network", detectNetwork())
    .maybeSingle();
  if (error) throw new SiwsError(503, "Request lookup unavailable");
  if (!row) throw new SiwsError(404, "Request not found");
  if (row.holder_wallet !== wallet)
    throw new SiwsError(403, "Only the request holder may record a deposit");
  if (row.deposit_tx === depositTx && row.deposit_evidence)
    return { id, status: row.status };
  if (row.status !== "vault_opened")
    throw new SiwsError(409, "Deposit recording requires an opened vault");
  const proof = await requireDepositEvidence(
    depositTx,
    row as CustodyRequestEvidence,
  );
  const updated = await sb
    .from(table)
    .update({
      status: "deposited",
      deposit_tx: depositTx,
      deposit_evidence: {
        ...proof,
        signature: depositTx,
        vault: row.vault_pda,
      },
    })
    .eq("id", id)
    .eq("network", detectNetwork())
    .eq("status", "vault_opened")
    .select("id")
    .maybeSingle();
  if (updated.error)
    throw new SiwsError(
      503,
      "Deposit confirmed; recording unavailable. Retry recording without depositing again",
    );
  if (!updated.data)
    throw new SiwsError(409, "Request changed; refresh before recording again");
  return { id, status: "deposited" };
}

/** Admin status changes use the same chain evidence as holder changes. */
export async function validateCustodyUpdate(
  table: RequestTable,
  id: string,
  patch: Record<string, unknown>,
) {
  const { data: row, error } = await getSupabaseAdmin()
    .from(table)
    .select("*")
    .eq("id", id)
    .eq("network", detectNetwork())
    .maybeSingle();
  if (error) throw new SiwsError(503, "Request lookup unavailable");
  if (!row) throw new SiwsError(404, "Request not found");
  if (
    row.vault_pda &&
    patch.vault_pda !== undefined &&
    row.vault_pda !== patch.vault_pda
  )
    throw new SiwsError(409, "A linked vault cannot be replaced");
  if (
    row.deposit_evidence &&
    patch.deposit_tx !== undefined &&
    patch.deposit_tx !== row.deposit_tx
  )
    throw new SiwsError(409, "Verified deposit evidence cannot be replaced");
  if (
    row.outcome_evidence &&
    patch.outcome_tx !== undefined &&
    patch.outcome_tx !== row.outcome_tx
  )
    throw new SiwsError(409, "Verified outcome evidence cannot be replaced");
  const expected = { ...row, ...patch } as CustodyRequestEvidence;
  const status = typeof patch.status === "string" ? patch.status : row.status;
  if (
    status === "deposited" &&
    (!row.deposit_evidence || patch.deposit_tx !== undefined)
  ) {
    const signature = transactionSignature(patch.deposit_tx ?? row.deposit_tx);
    const proof = await requireDepositEvidence(signature, expected);
    patch.deposit_tx = signature;
    patch.deposit_evidence = { ...proof, signature, vault: expected.vault_pda };
  }
  if (expected.vault_pda) {
    const { vault, escrow } = await requireRequestVault(expected);
    if (
      !row.vault_pda &&
      status === "vault_opened" &&
      (vault.deadline <= BigInt(0) ||
        !vault.metadataHash.some((byte) => byte !== 0))
    )
      throw new SiwsError(
        409,
        "New delivery or conversion custody needs a deadline and attestation hash",
      );
    if (status === "vault_opened" && vault.state !== VaultState.Active)
      throw new SiwsError(409, "Vault is not active");
    if (status === "deposited" || status === "in_delivery") {
      if (!row.deposit_evidence && !patch.deposit_evidence)
        throw new SiwsError(409, "Verify the holder deposit before proceeding");
      if (
        (vault.state !== VaultState.Active &&
          vault.state !== VaultState.Triggered) ||
        vault.deposited < BigInt(expected.amount) ||
        escrow.amount < BigInt(expected.amount)
      )
        throw new SiwsError(
          409,
          "Requested deposit is no longer held in custody",
        );
    }
    if (
      (status === "delivered" || status === "converted") &&
      !row.outcome_evidence
    ) {
      if (vault.state !== VaultState.Realized)
        throw new SiwsError(409, "On-chain realization is not finalized");
      const signature = transactionSignature(
        patch.outcome_tx ?? row.outcome_tx,
      );
      try {
        const tx = await getServerRpc()
          .getTransaction(toSignature(signature), {
            commitment: "finalized",
            encoding: "json",
            maxSupportedTransactionVersion: 0,
          })
          .send({ abortSignal: AbortSignal.timeout(12_000) });
        if (!tx)
          throw new SiwsError(
            503,
            "Realization is awaiting finalization. Retry recording the existing transaction",
          );
        const proof = custodyRealizationEvidence(
          tx as ChainTransaction,
          signature,
          {
            holder: expected.holder_wallet,
            vault: expected.vault_pda!,
            shareClass: expected.share_class_pda,
            mint: expected.mint,
            escrow: vault.escrow,
            amount: BigInt(expected.amount),
          },
        );
        patch.outcome_tx = signature;
        patch.outcome_evidence = {
          ...proof,
          signature,
          vault: expected.vault_pda,
        };
      } catch (error) {
        if (error instanceof SiwsError) throw error;
        if (error instanceof ChainEvidenceError)
          throw new SiwsError(400, error.message);
        throw new SiwsError(
          503,
          "Realization verification unavailable. Retry recording the existing transaction",
        );
      }
    }
    if (status === "returned" && !row.outcome_evidence) {
      const proof = await requireReturnedDeposit(
        expected,
        patch.outcome_tx ?? row.outcome_tx,
      );
      patch.outcome_evidence = proof;
      patch.outcome_tx = proof.signature;
    }
    if (
      status === "cancelled" &&
      (escrow.amount !== BigInt(0) || vault.deposited !== BigInt(0))
    )
      throw new SiwsError(
        409,
        "Funded custody must be returned before cancellation",
      );
  } else if (
    [
      "vault_opened",
      "deposited",
      "in_delivery",
      "delivered",
      "converted",
      "returned",
    ].includes(status)
  ) {
    throw new SiwsError(409, "A verified custody vault is required");
  }
  return row.status as string;
}

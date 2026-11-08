// POST /api/token-migrations/admin/record — an Admin records a transaction
// that settled part of a token migration, once the network finalized it.
// The server reads the transaction at finalized and records it only when its
// token balances prove exactly that settlement (lib/token-migration/
// evidence.ts); signers are not required, so a treasury or a deposit owner
// held by a Squads vault (which signs inside the multisig's CPI) records
// the same way as a wallet the page drove.
//   delivery  units of the share class went from the treasury wallet's token
//             account to holders. Without `deposit_ids`, the deposits are
//             taken from the transaction: every holder it paid gets ALL of
//             its accepted deposits marked delivered, and the units must
//             match them exactly (the delivery page sends per holder); with
//             `deposit_ids`, exactly those. The holders are screened
//             report-only (the units already moved: a hit raises the
//             compliance alert). record_token_migration_delivery marks them
//             atomically and never reuses a signature for other deposits.
//   refund    one irregular deposit (or an accepted one of a cancelled
//             campaign) went back to the wallet that made it, in full; a
//             signature refunds one deposit (a unique index). A compliance
//             hold is refunded only with `compliance_cleared: true`, the
//             compliance team's decision.
//   burn      the deposit owner burned collected old tokens from the deposit
//             account, after the window (closed or completed); recorded once.
// 409 "awaiting finalization" while the network has not finalized it. Admin
// only, fresh signature; open while the module is off (these settle what
// exists).

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { readFinalizedTransaction } from "@/lib/server/chain-evidence";
import { reportSanctionsHits } from "@/lib/server/sanctions";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { ChainEvidenceError, type ChainTransaction } from "@/lib/chain-evidence";
import {
  dbFailure,
  DEPOSITS,
  idListParam,
  MIGRATIONS,
  readDeposits,
  readMigration,
  signatureParam,
  uuidParam,
} from "@/lib/server/token-migrations";
import { burnEvidence, deliveryEvidence, mintBalanceChanges, refundEvidence } from "@/lib/token-migration/evidence";
import { TOKEN_PROGRAM_2022 } from "@/lib/token-migration/model";
import { type DepositRow, type MigrationRow } from "@/lib/token-migration/rows";
import { associatedTokenAccount } from "@/lib/token-migration/transactions";

export const maxDuration = 60;

async function finalized(signature: string): Promise<ChainTransaction> {
  return (await readFinalizedTransaction(signature)) as unknown as ChainTransaction;
}

function proven<T>(prove: () => T): T {
  try {
    return prove();
  } catch (err) {
    if (err instanceof ChainEvidenceError) throw new SiwsError(400, err.message);
    throw err;
  }
}

async function recordDelivery(migration: MigrationRow, signature: string, depositIdsInput: unknown) {
  if (migration.status !== "open" && migration.status !== "closed") throw new SiwsError(409, "Deliveries are recorded while the campaign is open or closed");
  const sb = getSupabaseAdmin();
  const all = await readDeposits(sb, [migration.id]);
  const tx = await finalized(signature);
  let chosen: DepositRow[];
  const recorded = all.filter((d) => d.delivery_tx === signature);
  if (recorded.length > 0 && (depositIdsInput === undefined || depositIdsInput === null)) {
    // Recorded before: the same deposits again (the database answers "already").
    chosen = recorded;
  } else if (depositIdsInput === undefined || depositIdsInput === null) {
    // The holders the transaction paid, from its share-class balances; each with all of its accepted deposits.
    const paid = new Set(mintBalanceChanges(tx, migration.new_mint).filter((c) => c.post > c.pre && c.owner).map((c) => c.owner as string));
    chosen = all.filter((d) => paid.has(d.holder_wallet) && d.status === "accepted");
    if (chosen.length === 0) throw new SiwsError(400, "This transaction paid no holder with deposits waiting for delivery");
  } else {
    const ids = new Set(idListParam(depositIdsInput, "deposit_ids", 100));
    chosen = all.filter((d) => ids.has(d.id));
    if (chosen.length !== ids.size) throw new SiwsError(404, "Some of these deposits do not belong to this campaign");
  }
  if (chosen.length > 100) throw new SiwsError(400, "One transaction delivers to at most 100 deposits; record it with deposit_ids");
  const recipients = new Map<string, { ata: string; units: bigint }>();
  for (const d of chosen) {
    const entry = recipients.get(d.holder_wallet) ?? { ata: await associatedTokenAccount(d.holder_wallet, migration.new_mint, TOKEN_PROGRAM_2022), units: BigInt(0) };
    entry.units += BigInt(d.units_due);
    recipients.set(d.holder_wallet, entry);
  }
  const treasuryAta = await associatedTokenAccount(migration.treasury_wallet, migration.new_mint, TOKEN_PROGRAM_2022);
  const { total } = proven(() => deliveryEvidence(tx, signature, { newMint: migration.new_mint, treasuryAta, recipients }));
  const { data, error } = await sb.rpc("record_token_migration_delivery", {
    p_migration_id: migration.id,
    p_delivery_tx: signature,
    p_deposit_ids: chosen.map((d) => d.id),
  });
  if (error) dbFailure(error, "delivery");
  // The units already moved: a hit raises the compliance alert, nothing is undone here.
  await reportSanctionsHits(sb, {
    route: "token-migrations/delivery",
    wallets: [...recipients.keys()].map((wallet) => ({ wallet, role: "counterparty" as const })),
    txSignature: signature,
  }).catch(() => undefined);
  return {
    created: (data as { created?: unknown } | null)?.created === true,
    deposits: chosen.length,
    holders: recipients.size,
    units: total.toString(),
  };
}

async function recordRefund(migration: MigrationRow, signature: string, params: Record<string, unknown>) {
  if (migration.status === "draft" || migration.status === "completed") throw new SiwsError(409, "Refunds are recorded while the campaign is open, closed or cancelled");
  const sb = getSupabaseAdmin();
  const depositId = uuidParam(params.deposit_id, "deposit_id");
  const deposit = (await readDeposits(sb, [migration.id])).find((d) => d.id === depositId);
  if (!deposit) throw new SiwsError(404, "This deposit does not belong to this campaign");
  if (deposit.status === "refunded" && deposit.refund_tx === signature) return { created: false, deposit_id: deposit.id };
  const refundable = deposit.status === "irregular" || (deposit.status === "accepted" && migration.status === "cancelled");
  if (!refundable) throw new SiwsError(409, `A deposit that is ${deposit.status} is not refunded${deposit.status === "accepted" ? " unless the campaign is cancelled" : ""}`);
  if (deposit.reason_code === "compliance_hold" && params.compliance_cleared !== true) {
    throw new SiwsError(409, "This deposit is held for compliance review: record its refund only with the compliance team's decision (compliance_cleared)");
  }
  const tx = await finalized(signature);
  proven(() => refundEvidence(tx, signature, {
    oldMint: migration.old_mint,
    depositAta: migration.deposit_ata,
    holder: deposit.holder_wallet,
    amount: BigInt(deposit.amount_base),
  }));
  const { data, error } = await sb
    .from(DEPOSITS)
    .update({ status: "refunded", refund_tx: signature })
    .eq("network", detectNetwork())
    .eq("id", deposit.id)
    .eq("status", deposit.status)
    .select("id")
    .maybeSingle();
  if (error?.code === "23505") throw new SiwsError(409, "This transaction is already recorded as the refund of another deposit");
  if (error) dbFailure(error, "refund");
  if (!data) throw new SiwsError(409, "The deposit changed meanwhile: reload the campaign");
  return { created: true, deposit_id: deposit.id };
}

async function recordBurn(migration: MigrationRow, signature: string) {
  if (migration.old_tokens_burn_tx === signature) return { created: false, burned: migration.old_tokens_burned };
  if (migration.old_tokens_burn_tx) throw new SiwsError(409, "The burn of this campaign is already recorded");
  if (migration.status !== "closed" && migration.status !== "completed") {
    throw new SiwsError(409, "The collected tokens are burned after the window: close the campaign first");
  }
  const tx = await finalized(signature);
  const { burned } = proven(() => burnEvidence(tx, signature, {
    oldMint: migration.old_mint,
    tokenProgram: migration.old_token_program,
    depositAta: migration.deposit_ata,
  }));
  const { data, error } = await getSupabaseAdmin()
    .from(MIGRATIONS)
    .update({ old_tokens_burn_tx: signature, old_tokens_burned: burned.toString() })
    .eq("network", detectNetwork())
    .eq("id", migration.id)
    .is("old_tokens_burn_tx", null)
    .select("id")
    .maybeSingle();
  if (error) dbFailure(error, "burn");
  if (!data) throw new SiwsError(409, "The burn of this campaign was recorded meanwhile: reload it");
  return { created: true, burned: burned.toString() };
}

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "tokenMigration.adminRecord");
    await requireAdmin(wallet);
    const migration = await readMigration(getSupabaseAdmin(), uuidParam(params.id, "id"));
    const signature = signatureParam(params.signature);
    const kind = params.kind;
    let result: Record<string, unknown>;
    if (kind === "delivery") result = await recordDelivery(migration, signature, params.deposit_ids);
    else if (kind === "refund") result = await recordRefund(migration, signature, params);
    else if (kind === "burn") result = await recordBurn(migration, signature);
    else throw new SiwsError(400, "kind must be delivery, refund or burn");

    if (result.created) {
      try {
        await writeServerAudit(getSupabaseAdmin(), {
          ix_name: `token_migration_${kind}`,
          category: "share-class",
          actor_wallet: wallet,
          actor_source: actorSourceOf(via),
          reason: `Token migration ${migration.slug}: ${kind} recorded`,
          target_label: migration.share_class_pda,
          tx_signature: signature,
          metadata: { migration_id: migration.id, ...result },
        });
      } catch {
        // Best effort: the deposit and campaign rows are the record.
      }
    }
    return NextResponse.json({ ok: true, data: result }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

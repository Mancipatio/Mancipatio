// POST /api/token-migrations/admin/reconcile — an Admin records the deposits
// that reached a campaign's deposit account without the holder recording
// them (a closed tab, a wallet that sent by hand, a holder who never came
// back). It reads the deposit account's history (getSignaturesForAddress at
// finalized, oldest first), skips every signature already recorded (as a
// deposit, a refund or the burn), and runs each remaining one through the
// same recording path as the holder's own record
// (lib/server/token-migrations.ts recordDepositFromChain, with the depositing
// wallet taken from the balances instead of a signature): proven, classified,
// screened report-only, inserted under the units cap. A transaction that is
// not a deposit (the account's creation, a refund recorded elsewhere) is
// skipped; a deposit that cannot be attributed to one wallet is listed for
// the operator to handle by hand.
//
// At most RECONCILE_READS unrecorded signatures are read per call (each is a
// finalized transaction read inside the route's 60 s), and at most
// RECONCILE_RECORDS of them recorded; the answer says how many remain, and
// the page calls again. Signatures that are not deposits do not use up the
// records, so a few of them can never hold the newer deposits back. A screen or a node that cannot
// answer stops the run (503): nothing is ever recorded unscreened. Admin
// only, fresh signature; open while the module is off (it records what
// already landed).

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { NotADepositError, readDeposits, readMigration, recordDepositFromChain, uuidParam } from "@/lib/server/token-migrations";
import { depositAccountSignatures } from "@/lib/server/token-migration-chain";

export const maxDuration = 60;

/** Unrecorded signatures one call reads, and deposits it records at most. */
const RECONCILE_READS = 40;
const RECONCILE_RECORDS = 20;

type Outcome = { signature: string; outcome: "recorded" | "already" | "not_a_deposit" | "awaiting_finalization"; detail?: string; status?: string };

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "tokenMigration.adminReconcile");
    await requireAdmin(wallet);
    const sb = getSupabaseAdmin();
    const migration = await readMigration(sb, uuidParam(params.id, "id"));
    if (migration.status === "draft") throw new SiwsError(409, "A draft has no deposits: open the campaign first");
    if (migration.status === "completed") throw new SiwsError(409, "A completed campaign is final: a late deposit is refunded by hand (runbook §22)");

    const known = new Set<string>();
    for (const d of await readDeposits(sb, [migration.id])) {
      known.add(d.deposit_tx);
      if (d.refund_tx) known.add(d.refund_tx);
    }
    if (migration.old_tokens_burn_tx) known.add(migration.old_tokens_burn_tx);
    const history = await depositAccountSignatures(migration.deposit_ata);
    const pending = history.signatures.filter((s) => !known.has(s));

    const results: Outcome[] = [];
    for (const signature of pending) {
      if (results.length >= RECONCILE_READS) break;
      if (results.filter((r) => r.outcome === "recorded" || r.outcome === "already").length >= RECONCILE_RECORDS) break;
      try {
        const { created, deposit } = await recordDepositFromChain(sb, migration, signature, { holder: null, via: "reconcile" });
        results.push({ signature, outcome: created ? "recorded" : "already", status: deposit.status });
      } catch (err) {
        if (err instanceof NotADepositError) {
          results.push({ signature, outcome: "not_a_deposit", detail: err.message });
          continue;
        }
        if (err instanceof SiwsError && err.status === 409 && (err as { code?: unknown }).code === "awaiting_finalization") {
          results.push({ signature, outcome: "awaiting_finalization" });
          continue;
        }
        // A screen or a node that cannot answer, or a database refusal: stop here (what was recorded stays).
        if (results.some((r) => r.outcome === "recorded")) break;
        throw err;
      }
    }
    const recorded = results.filter((r) => r.outcome === "recorded").length;
    if (recorded > 0) {
      try {
        await writeServerAudit(sb, {
          ix_name: "token_migration_reconcile",
          category: "share-class",
          actor_wallet: wallet,
          actor_source: actorSourceOf(via),
          reason: `Token migration ${migration.slug}: ${recorded} deposit(s) recorded by reconcile`,
          target_label: migration.share_class_pda,
          metadata: { migration_id: migration.id, recorded: results.filter((r) => r.outcome === "recorded").map((r) => r.signature) },
        });
      } catch {
        // Best effort: the deposit rows are the record.
      }
    }
    return NextResponse.json(
      {
        ok: true,
        data: {
          scanned: history.signatures.length,
          truncated: history.truncated,
          processed: results.length,
          remaining: Math.max(0, pending.length - results.length),
          results,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

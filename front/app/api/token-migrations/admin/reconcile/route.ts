// POST /api/token-migrations/admin/reconcile — an Admin records the deposits
// that reached a campaign's deposit account without the holder recording
// them (a closed tab, a wallet that sent by hand, a holder who never came
// back). Each one goes through the same recording path as the holder's own
// record (lib/server/token-migrations.ts recordDepositFromChain, with the
// depositing wallet taken from the balances instead of a signature): proven,
// classified, screened report-only, inserted under the units cap. A
// transaction that is not a deposit (the account's creation, a refund, a
// transfer that cannot be attributed to one wallet) is examined and skipped,
// and listed for the operator (runbook §24: an unattributable transfer is
// returned by hand).
//
// The deposit account is public, so anyone can make transactions that touch
// it: the history is swept BACKWARDS in bounded runs and the progress is
// stored on the campaign (migration 0085), so no amount of noise can make a
// run read the same signatures again or hold newer deposits back.
//   reconcile_cursor        newest signature of the last completed sweep:
//                           everything from it down to the opening slot
//                           was examined
//   reconcile_sweep_top     newest signature when the sweep in progress began
//   reconcile_sweep_before  oldest signature that sweep examined so far
// A run continues the sweep in progress (or starts one from the newest
// signature down to the cursor), examines at most RECONCILE_READS unknown
// transactions or RECONCILE_BUDGET_MS, and saves its position; once a sweep
// reaches the cursor (or the opening slot), its top becomes the cursor.
// Signatures already recorded (deposits, refunds, the burn) and failed
// transactions are passed over without a read. A screen or a node that
// cannot answer stops the run at that signature (it is examined again next
// time): nothing is ever recorded unscreened. The position is saved only if
// the campaign row did not change meanwhile (a concurrent run or step), and
// recording is idempotent, so a lost update only means a re-read.
//
// Admin only, fresh signature; open while the module is off (it records what
// already landed). With `signature`, it records that one transaction instead
// (the operator's fallback for a transaction seen on an explorer).

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  dbFailure,
  MIGRATIONS,
  NotADepositError,
  readDeposits,
  readMigration,
  recordDepositFromChain,
  signatureParam,
  uuidParam,
} from "@/lib/server/token-migrations";
import { depositAccountPage } from "@/lib/server/token-migration-chain";
import type { MigrationRow } from "@/lib/token-migration/rows";

export const maxDuration = 60;

/** Unknown transactions one run reads at most, and how long it may spend on them. */
const RECONCILE_READS = 40;
const RECONCILE_BUDGET_MS = 40_000;
/** Signatures one history page lists. */
const PAGE_LIMIT = 200;

type Outcome = {
  signature: string;
  outcome: "recorded" | "already" | "not_a_deposit" | "other_campaign";
  detail?: string;
  status?: string;
};

type Stop = { signature: string; reason: string };

/** What a recording failure means for the sweep: examined (go on) or stop here. */
function examine(err: unknown, signature: string): Outcome | Stop {
  if (err instanceof NotADepositError) return { signature, outcome: "not_a_deposit", detail: err.message };
  if (err instanceof SiwsError && err.status === 409 && /another campaign/.test(err.message)) {
    return { signature, outcome: "other_campaign", detail: err.message };
  }
  return { signature, reason: err instanceof Error ? err.message : "The transaction could not be examined" };
}

async function recordOne(migration: MigrationRow, signature: string, results: Outcome[]): Promise<Stop | null> {
  try {
    const { created, deposit } = await recordDepositFromChain(getSupabaseAdmin(), migration, signature, { holder: null, via: "reconcile" });
    results.push({ signature, outcome: created ? "recorded" : "already", status: deposit.status });
    return null;
  } catch (err) {
    const verdict = examine(err, signature);
    if ("outcome" in verdict) {
      results.push(verdict);
      return null;
    }
    return verdict;
  }
}

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "tokenMigration.adminReconcile");
    await requireAdmin(wallet);
    const sb = getSupabaseAdmin();
    const migration = await readMigration(sb, uuidParam(params.id, "id"));
    if (migration.status === "draft" || migration.opened_slot === null) throw new SiwsError(409, "A draft has no deposits: open the campaign first");
    if (migration.status === "completed") throw new SiwsError(409, "A completed campaign is final: a late deposit is returned by hand (runbook §24)");

    const results: Outcome[] = [];
    let stop: Stop | null = null;

    // One transaction, named by the operator: its refusal comes back as it is.
    if (params.signature !== undefined && params.signature !== null) {
      const signature = signatureParam(params.signature);
      try {
        const { created, deposit } = await recordDepositFromChain(sb, migration, signature, { holder: null, via: "reconcile" });
        results.push({ signature, outcome: created ? "recorded" : "already", status: deposit.status });
      } catch (err) {
        if (!(err instanceof NotADepositError)) throw err;
        results.push({ signature, outcome: "not_a_deposit", detail: err.message });
      }
    } else {
      const known = new Set<string>();
      for (const d of await readDeposits(sb, [migration.id])) {
        known.add(d.deposit_tx);
        if (d.refund_tx) known.add(d.refund_tx);
        if (d.delivery_tx) known.add(d.delivery_tx);
      }
      if (migration.old_tokens_burn_tx) known.add(migration.old_tokens_burn_tx);

      let cursor = migration.reconcile_cursor;
      let top = migration.reconcile_sweep_top;
      let before = migration.reconcile_sweep_before;
      const deadline = Date.now() + RECONCILE_BUDGET_MS;
      let reads = 0;
      let swept = false;
      sweep: while (reads < RECONCILE_READS && Date.now() < deadline) {
        const page = await depositAccountPage(migration.deposit_ata, {
          before,
          until: cursor,
          minSlot: BigInt(migration.opened_slot),
          limit: PAGE_LIMIT,
        });
        if (top === null) {
          if (page.entries.length === 0) break; // nothing new since the last sweep
          top = page.entries[0].signature;
        }
        for (const entry of page.entries) {
          if (!entry.failed && !known.has(entry.signature)) {
            if (reads >= RECONCILE_READS || Date.now() >= deadline) break sweep;
            reads += 1;
            stop = await recordOne(migration, entry.signature, results);
            if (stop) break sweep;
          }
          before = entry.signature;
        }
        if (page.exhausted) {
          swept = true;
          break;
        }
      }
      if (swept && top !== null) {
        cursor = top;
        top = null;
        before = null;
      }
      // A sweep that examined nothing yet is not saved: the next run starts it again from the newest signature.
      if (top !== null && before === null) top = null;
      const moved =
        cursor !== migration.reconcile_cursor || top !== migration.reconcile_sweep_top || before !== migration.reconcile_sweep_before;
      if (moved) {
        const { data, error } = await sb
          .from(MIGRATIONS)
          .update({ reconcile_cursor: cursor, reconcile_sweep_top: top, reconcile_sweep_before: before })
          .eq("network", detectNetwork())
          .eq("id", migration.id)
          .eq("updated_at", migration.updated_at)
          .select("id")
          .maybeSingle();
        if (error) dbFailure(error, "reconcile position");
        if (!data) stop = stop ?? { signature: "", reason: "The campaign changed during this run: its position was not saved; run it again" };
      }
      if (stop && results.length === 0 && stop.signature) throw new SiwsError(503, stop.reason);
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
            examined: results.length,
            complete: top === null && !stop,
            stopped: stop ? stop.reason : null,
            results,
          },
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return NextResponse.json(
      { ok: true, data: { examined: results.length, complete: false, stopped: null, results } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

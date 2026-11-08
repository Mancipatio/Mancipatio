// POST /api/token-migrations/admin/transition — an Admin moves a token
// migration along its lifecycle (lib/token-migration/model.ts; the 0085
// guard trigger is the authority under this route):
//   open       draft → open. The holder-facing entry, so the pilot module
//              must be on (lib/features.ts tokenMigration: 403 while it is
//              off, KYC-only mode included). The Swap Terms hash and link
//              must be set, the window must not have ended, the old mint is
//              checked again (an extension can change after the draft), and
//              the deposit account must exist as the admin's wallet created
//              it: the deposit owner's ATA of the old mint, not frozen, no
//              delegate, no close authority, and empty (every token in it
//              must be a recorded deposit). One live campaign per deposit
//              account (a unique index).
//   closed     open → closed, once the window has ended or every unit is
//              claimed (the Swap Terms promise the window to the holders).
//   cancelled  from draft, open or closed while no deposit was delivered;
//              accepted deposits of a cancelled campaign are then refunded.
//   completed  closed → completed, once every deposit is delivered or
//              refunded: the final report (lib/token-migration/report.ts) is
//              built here, stored with its SHA-256, and immutable from then on.
// Every step but the opening stays available while the module is off: they
// close or wind down what exists.

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { actorSourceOf, writeServerAudit } from "@/lib/server/audit";
import { requireModule } from "@/lib/server/feature-gate";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { dbFailure, MIGRATIONS, readDeposits, readMigration, unitsTaken, uuidParam } from "@/lib/server/token-migrations";
import { readDepositAccount, readOldMint } from "@/lib/server/token-migration-chain";
import { migrationTransitionAllowed, MIGRATION_STATUS_LABEL, type MigrationStatus } from "@/lib/token-migration/model";
import { buildFinalReport, sha256Hex } from "@/lib/token-migration/report";
import { MIGRATION_SELECT, parseMigrationRow } from "@/lib/token-migration/rows";
import { associatedTokenAccount } from "@/lib/token-migration/transactions";

export const maxDuration = 60;

const TARGETS: readonly MigrationStatus[] = ["open", "closed", "cancelled", "completed"];
/** How long after its window opened a draft may still open (a few hours of preparation). */
const OPEN_LATE_SLACK_MS = 86_400_000;

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "tokenMigration.adminTransition");
    await requireAdmin(wallet);
    const id = uuidParam(params.id, "id");
    const to = params.to;
    if (typeof to !== "string" || !(TARGETS as readonly string[]).includes(to)) {
      throw new SiwsError(400, "to must be open, closed, cancelled or completed");
    }
    const target = to as MigrationStatus;
    const sb = getSupabaseAdmin();
    const migration = await readMigration(sb, id);
    if (!migrationTransitionAllowed(migration.status, target)) {
      throw new SiwsError(409, `A ${MIGRATION_STATUS_LABEL[migration.status].toLowerCase()} campaign cannot become ${MIGRATION_STATUS_LABEL[target].toLowerCase()}`);
    }

    const patch: Record<string, unknown> = { status: target, updated_by: wallet };
    let reportSha: string | null = null;
    if (target === "open") {
      // The holder-facing entry of the module.
      requireModule("tokenMigration");
      if (!migration.terms_doc_sha256 || !migration.terms_doc_url) {
        throw new SiwsError(409, "Add the Swap Terms document (its SHA-256 and its https link) to the draft before opening");
      }
      if (Date.parse(migration.window_closes_at) <= Date.now()) throw new SiwsError(409, "The window of this draft has already ended: change its dates first");
      // The Swap Terms promise the holders the whole window: a campaign opened late would shorten it.
      if (Date.now() - Date.parse(migration.window_opens_at) > OPEN_LATE_SLACK_MS) {
        throw new SiwsError(409, "The window of this draft opened more than a day ago: move its dates (and the Swap Terms) so the holders get the whole window");
      }
      const derived = await associatedTokenAccount(migration.deposit_owner, migration.old_mint, migration.old_token_program);
      if (derived !== migration.deposit_ata) throw new SiwsError(500, "The stored deposit account does not match its owner and mint");
      const verdict = await readOldMint(migration.old_mint);
      if (!verdict.ok || verdict.tokenProgram !== migration.old_token_program || verdict.decimals !== migration.old_decimals) {
        throw new SiwsError(409, `The old token changed since the draft was saved: ${verdict.refusals.map((r) => r.reason).join(" ") || "its program or decimals differ"} Save the draft again.`);
      }
      const account = await readDepositAccount({
        depositAta: migration.deposit_ata,
        depositOwner: migration.deposit_owner,
        oldMint: migration.old_mint,
        program: migration.old_token_program,
      });
      if (!account.ok) throw new SiwsError(409, account.problem);
    }
    if (target === "closed") {
      const ended = Date.now() >= Date.parse(migration.window_closes_at);
      const full = unitsTaken(await readDeposits(sb, [migration.id])) >= BigInt(migration.units_cap);
      if (!ended && !full) {
        throw new SiwsError(409, `The window is open until ${new Date(migration.window_closes_at).toUTCString()}: a campaign closes after its window, or once every unit is claimed`);
      }
    }
    if (target === "completed") {
      const deposits = await readDeposits(sb, [migration.id]);
      const open = deposits.filter((d) => d.status === "accepted" || d.status === "irregular");
      if (open.length > 0) {
        throw new SiwsError(409, `${open.length} deposit(s) still wait for delivery or refund: settle every deposit before completing`);
      }
      const report = buildFinalReport(migration, deposits, new Date().toISOString());
      reportSha = await sha256Hex(report);
      patch.final_report = report;
      patch.final_report_sha256 = reportSha;
    }

    const { data, error } = await sb
      .from(MIGRATIONS)
      .update(patch)
      .eq("network", detectNetwork())
      .eq("id", id)
      .eq("status", migration.status)
      .select(MIGRATION_SELECT)
      .maybeSingle();
    if (error?.code === "23505") throw new SiwsError(409, "Another open campaign already uses this deposit account");
    if (error) dbFailure(error, "status change");
    if (!data) throw new SiwsError(409, "The campaign changed meanwhile: reload it and try again");
    const updated = parseMigrationRow(data);

    try {
      await writeServerAudit(sb, {
        ix_name: `token_migration_${target}`,
        category: "share-class",
        actor_wallet: wallet,
        actor_source: actorSourceOf(via),
        reason: `Token migration ${migration.slug}: ${migration.status} → ${target}`,
        target_label: migration.share_class_pda,
        metadata: { migration_id: id, from: migration.status, to: target, ...(reportSha ? { final_report_sha256: reportSha } : {}) },
      });
    } catch {
      // Best effort: the campaign row and its stamps are the record.
    }
    return NextResponse.json({ ok: true, data: { migration: updated } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

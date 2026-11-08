// POST /api/token-migrations/record — the holder records a deposit its wallet
// already sent into a token migration (the receipt of a transaction that
// landed: the "Retry recording" of /portfolio/migration posts the same).
// Signed with a fresh signature (it writes a business row); the deposit is
// bound to the SIGNING wallet: the server reads the transaction at finalized
// and records it only when it proves a deposit from that wallet's own token
// accounts into the campaign's deposit account (lib/server/token-migrations.ts
// recordDepositFromChain: evidence, classification, report-only sanctions
// screen, then the serialized insert under the units cap).
//
// Not module-gated, like conversion/deposited: the tokens already moved, and
// a deposit made before the module was switched off must still be recorded
// (and refunded if it is irregular). Maintenance lets it through for the same
// reason (lib/maintenance.ts). 409 "awaiting finalization" while the network
// has not finalized the transaction: the page keeps its receipt and records
// again, sending nothing again.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { readMigration, recordDepositFromChain, uuidParam } from "@/lib/server/token-migrations";
import { publicDeposit } from "@/lib/token-migration/rows";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "tokenMigration.recordDeposit");
    const migrationId = uuidParam(params.migration_id, "migration_id");
    const sb = getSupabaseAdmin();
    const migration = await readMigration(sb, migrationId);
    const { created, deposit } = await recordDepositFromChain(sb, migration, params.signature, { holder: wallet, via: "holder" });
    return NextResponse.json(
      { ok: true, data: { created, deposit: { id: deposit.id, ...publicDeposit(deposit) } } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

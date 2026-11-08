// POST /api/token-migrations/admin/list — the admin console's view of token
// migrations: without `id`, every campaign of this network (drafts
// included) with its progress; with `id`, one campaign and every deposit with
// its internal reason (a compliance hold says so here, unlike the public
// pages). Admin only; a session read (reads only).

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/server/admin-gate";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { listMigrations, readDeposits, readMigration, uuidParam } from "@/lib/server/token-migrations";
import { chainOrder, migrationProgress } from "@/lib/token-migration/rows";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "tokenMigration.adminList");
    await requireAdmin(wallet);
    const sb = getSupabaseAdmin();
    if (params.id === undefined || params.id === null) {
      const migrations = await listMigrations(sb, { publicOnly: false });
      const deposits = await readDeposits(sb, migrations.map((m) => m.id));
      const data = migrations.map((m) => ({ ...m, progress: migrationProgress(deposits.filter((d) => d.migration_id === m.id)) }));
      return NextResponse.json({ ok: true, data: { migrations: data } }, { headers: { "Cache-Control": "private, no-store" } });
    }
    const migration = await readMigration(sb, uuidParam(params.id, "id"));
    const deposits = (await readDeposits(sb, [migration.id])).sort(chainOrder);
    return NextResponse.json(
      { ok: true, data: { migration, deposits, progress: migrationProgress(deposits) } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

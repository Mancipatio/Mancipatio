// SERVER-ONLY — the public face of token migrations: what /migrations, its
// campaign pages and GET /api/token-migrations/public show. Drafts never
// leave the database; a campaign shows from the moment it opens, and stays
// public after it completes or is cancelled (its proof table and final
// report are the record holders and their accountants rely on). Everything
// in it is public on chain anyway (wallets, amounts, signatures): no
// personal data is stored, the operator's wallet is left out, and an
// irregular deposit shows only its public reason (a compliance hold reads
// "Held for review").

import "server-only";

import { getSupabaseAdmin } from "@/lib/supabase-server";
import { listMigrations, readDeposits, readMigrationBySlug } from "@/lib/server/token-migrations";
import { validSlug } from "@/lib/token-migration/model";
import { publicMigration, type PublicMigration } from "@/lib/token-migration/rows";

/** A campaign in a list: its facts and progress, without the proof table. */
export type PublicMigrationSummary = Omit<PublicMigration, "deposits">;

export async function loadPublicMigrations(): Promise<PublicMigrationSummary[]> {
  const sb = getSupabaseAdmin();
  const migrations = await listMigrations(sb, { publicOnly: true });
  const deposits = await readDeposits(sb, migrations.map((m) => m.id));
  return migrations.map((m) => {
    const view = publicMigration(m, deposits.filter((d) => d.migration_id === m.id));
    const { deposits: proof, ...summary } = view;
    void proof;
    return summary;
  });
}

/** One campaign with its proof table, or null for an unknown slug or a draft. */
export async function loadPublicMigration(slug: string): Promise<PublicMigration | null> {
  if (!validSlug(slug)) return null;
  const sb = getSupabaseAdmin();
  const migration = await readMigrationBySlug(sb, slug);
  if (!migration || migration.status === "draft") return null;
  return publicMigration(migration, await readDeposits(sb, [migration.id]));
}

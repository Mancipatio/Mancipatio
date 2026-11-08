// GET /api/token-migrations/public — the campaigns of token migrations as the
// public sees them (lib/server/token-migrations-public.ts): without `slug`,
// every campaign that has opened (facts and progress); with `?slug=`, one
// campaign and its proof table (wallet, amount, units, deposit, delivery and
// refund signatures, public reason). Drafts are never shown.
//
// Open, unsigned and not module-gated on purpose: it is a read of facts that
// are public on chain anyway, and a campaign's proof stays readable after
// the module is switched off. The holder page reads its own deposits from
// here (filtered by its wallet in the browser): nothing private is in it.

import { NextResponse } from "next/server";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { loadPublicMigration, loadPublicMigrations } from "@/lib/server/token-migrations-public";

export async function GET(request: Request) {
  try {
    const slug = new URL(request.url).searchParams.get("slug");
    if (slug === null) {
      return NextResponse.json({ ok: true, data: await loadPublicMigrations() }, { headers: { "Cache-Control": "no-store" } });
    }
    const migration = await loadPublicMigration(slug);
    if (!migration) throw new SiwsError(404, "No public token migration has that address");
    return NextResponse.json({ ok: true, data: migration }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

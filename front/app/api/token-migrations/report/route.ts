// GET /api/token-migrations/report?slug=<slug> — the final report of a
// completed token migration, byte for byte as it was stored when the
// campaign completed (lib/token-migration/report.ts; migration 0085 keeps
// the text and its SHA-256 immutable). The response carries the hash in
// X-Content-SHA256 and the server checks it before answering: anyone can
// hash the body and compare it with the hash published on the campaign page.
//
// Open and unsigned: a public record, readable whatever the module switch says.

import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { SiwsError, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { SHA256_HEX_RE, validSlug } from "@/lib/token-migration/model";
import { sha256Hex } from "@/lib/token-migration/report";

export async function GET(request: Request) {
  try {
    const slug = new URL(request.url).searchParams.get("slug") ?? "";
    if (!validSlug(slug)) throw new SiwsError(400, "slug must name a token migration");
    const { data, error } = await getSupabaseAdmin()
      .from("token_migrations")
      .select("status, final_report, final_report_sha256")
      .eq("network", detectNetwork())
      .eq("slug", slug)
      .maybeSingle();
    if (error) {
      console.error("[api/token-migrations/report] read failed:", error.message);
      throw new SiwsError(503, "The final report could not be read — try again");
    }
    const row = data as { status?: unknown; final_report?: unknown; final_report_sha256?: unknown } | null;
    if (!row || row.status !== "completed" || typeof row.final_report !== "string" || typeof row.final_report_sha256 !== "string") {
      throw new SiwsError(404, "This token migration has no final report (it is not completed)");
    }
    const hash = row.final_report_sha256;
    if (!SHA256_HEX_RE.test(hash) || (await sha256Hex(row.final_report)) !== hash) {
      console.error("[api/token-migrations/report] stored report does not match its hash:", slug);
      throw new SiwsError(500, "The stored final report does not match its published hash; contact Manci");
    }
    return new NextResponse(row.final_report, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `inline; filename="${slug}-final-report.json"`,
        "X-Content-SHA256": hash,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

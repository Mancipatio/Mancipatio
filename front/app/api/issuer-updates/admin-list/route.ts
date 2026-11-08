// POST /api/issuer-updates/admin-list — the published and withdrawn updates
// of every issuer, for moderation (/admin/updates). Signed
// "issuerUpdates.adminList" (a session read) and requireAdmin (on-chain
// Admin PDA or the super admin). params { status?: "published" |
// "withdrawn" | "all" } (default "all"). Drafts are the issuers' private
// work and are not listed. Each row carries the issuer's company name from
// its profile, when it has one.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { byPublicationDesc, type AdminIssuerUpdate } from "@/lib/issuer-updates";
import {
  UPDATES_TABLE,
  UPDATE_COLUMNS,
  loadDocuments,
  toRecord,
  unavailable,
  type IssuerUpdateRow,
} from "@/lib/server/issuer-updates";

const LIST_LIMIT = 200;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "issuerUpdates.adminList");
    await requireAdmin(wallet);
    const status = params.status ?? "all";
    if (status !== "published" && status !== "withdrawn" && status !== "all") throw new SiwsError(400, "Invalid status filter");

    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const network = detectNetwork();
    const { data, error } = await sb.from(UPDATES_TABLE).select(UPDATE_COLUMNS)
      .eq("network", network).in("status", status === "all" ? ["published", "withdrawn"] : [status])
      .order("published_at", { ascending: false }).limit(LIST_LIMIT);
    if (error) unavailable();
    const rows = ((data ?? []) as unknown as IssuerUpdateRow[]).sort(byPublicationDesc);
    const docs = await loadDocuments(sb, rows.map((r) => r.id));

    const issuers = [...new Set(rows.map((r) => r.issuer_pda))];
    const names = new Map<string, string | null>();
    if (issuers.length) {
      const profiles = await sb.from("issuer_profiles").select("issuer_pda,company_name").eq("network", network).in("issuer_pda", issuers);
      if (profiles.error) unavailable();
      for (const p of (profiles.data ?? []) as { issuer_pda: string; company_name: string | null }[]) names.set(p.issuer_pda, p.company_name);
    }
    const updates: AdminIssuerUpdate[] = rows.map((r) => ({ ...toRecord(r, docs.get(r.id)), company_name: names.get(r.issuer_pda) ?? null }));
    return NextResponse.json({ ok: true, data: { updates } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

// GET /api/issuer-updates/public?issuer=<Issuer PDA>[&asset=<Asset PDA>] —
// open: the PUBLISHED, PUBLIC updates of an issuer (with `asset`: that
// asset's and the issuer-wide ones), newest first, at most PUBLIC_LIMIT, with
// their documents (name, SHA-256, size, type; never a storage path), plus how
// many published holders-only updates the same scope has: a number and no
// content, so the asset page can offer holders the signed read
// (/api/issuer-updates/holder).
//
// Drafts, withdrawn updates and holders-only content never leave this route
// (lib/server/issuer-updates toPublic projects published rows only). An
// archived issuer or asset answers nothing, like the public profile lists.
// Reading stays open in KYC-only mode.
import { NextResponse } from "next/server";
import { siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { byPublicationDesc, type PublicIssuerUpdate } from "@/lib/issuer-updates";
import {
  UPDATES_TABLE,
  UPDATE_COLUMNS,
  hiddenByArchive,
  loadDocuments,
  readAddress,
  toPublic,
  unavailable,
  type IssuerUpdateRow,
} from "@/lib/server/issuer-updates";

export const dynamic = "force-dynamic";

const PUBLIC_LIMIT = 50;
/** Rows read per scope: enough to fill the public list and count the holders-only ones. */
const SCAN_LIMIT = 200;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const issuer = readAddress(url.searchParams.get("issuer"), "The issuer");
    const assetParam = url.searchParams.get("asset");
    const asset = assetParam ? readAddress(assetParam, "The asset") : null;
    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const answer = (updates: PublicIssuerUpdate[], holdersOnly: number) =>
      NextResponse.json({ ok: true, data: { updates, holders_only: holdersOnly } }, { headers: { "Cache-Control": "no-store" } });
    if (await hiddenByArchive(sb, issuer, asset)) return answer([], 0);

    const published = () => sb.from(UPDATES_TABLE).select(UPDATE_COLUMNS)
      .eq("network", detectNetwork()).eq("issuer_pda", issuer).eq("status", "published");
    const scopes = asset ? [published().eq("asset_pda", asset), published().is("asset_pda", null)] : [published()];
    const results = await Promise.all(scopes.map((q) => q.order("published_at", { ascending: false }).limit(SCAN_LIMIT)));
    if (results.some((r) => r.error)) unavailable();
    const rows = results.flatMap((r) => (r.data ?? []) as unknown as IssuerUpdateRow[]).filter((r) => r.status === "published");

    const visible = rows.filter((r) => r.visibility === "public").sort(byPublicationDesc).slice(0, PUBLIC_LIMIT);
    const docs = await loadDocuments(sb, visible.map((r) => r.id));
    const updates = visible.flatMap((r) => {
      const update = toPublic(r, docs.get(r.id));
      return update ? [update] : [];
    });
    return answer(updates, rows.filter((r) => r.visibility === "holders").length);
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

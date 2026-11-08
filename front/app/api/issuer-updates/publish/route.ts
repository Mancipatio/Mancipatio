// POST /api/issuer-updates/publish — publish a saved DRAFT exactly as the
// issuer last saw it. KYC-only mode: publishing is issuance activity, refused
// before the signature (requireArea). Signed "issuerUpdates.publish".
//
// params: { id, expected_updated_at }. requireIssuerAuthor: the signer is the
// issuer's on-chain authority, its KYB is Verified and the update's asset (if
// any) is still one of its own. The status changes by compare-and-swap on
// updated_at, so a draft edited in another tab is never published unseen.
// From here the update is frozen (0090): published_at is the database's
// clock, and only an on-chain anchor (once) and a withdrawal with a reason
// can follow. The answer carries the memo to anchor it.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireArea } from "@/lib/server/feature-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import {
  UPDATES_TABLE,
  loadUpdate,
  readRevision,
  readUuid,
  recordOf,
  requireIssuerAuthor,
  unavailable,
} from "@/lib/server/issuer-updates";

export async function POST(request: Request) {
  try {
    requireArea("issuance");
    const { wallet, params } = await verifySigned(request, "issuerUpdates.publish");
    const id = readUuid(params.id);
    const expected = readRevision(params.expected_updated_at);
    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const update = await loadUpdate(sb, id);
    if (!update) throw new SiwsError(404, "Update not found");
    await requireIssuerAuthor(wallet, update.issuer_pda, update.asset_pda);
    if (update.status !== "draft") throw new SiwsError(409, "This update is already published");

    const { data, error } = await sb.from(UPDATES_TABLE)
      .update({ status: "published", published_by: wallet })
      .eq("network", detectNetwork()).eq("id", id).eq("issuer_pda", update.issuer_pda)
      .eq("status", "draft").eq("updated_at", expected)
      .select("id").maybeSingle();
    if (error) unavailable();
    if (!data) throw new SiwsError(409, "This draft changed or was published meanwhile. Reload it and review it again.");
    return NextResponse.json({ ok: true, data: { update: await recordOf(sb, id) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

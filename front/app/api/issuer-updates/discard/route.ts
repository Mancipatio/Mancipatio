// POST /api/issuer-updates/discard — delete a DRAFT and its attachment rows
// (the verified files stay where they are: private, content-addressed, and
// no longer reachable through any update). Signed "issuerUpdates.discard";
// params { id, expected_updated_at }; the issuer's on-chain authority
// (requireProfileOwner). A published update is withdrawn instead (0090 lets
// only a draft be deleted). A take-down: open in KYC-only mode.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { requireProfileOwner } from "@/lib/server/profile-read";
import { UPDATES_TABLE, loadUpdate, readRevision, readUuid, unavailable } from "@/lib/server/issuer-updates";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "issuerUpdates.discard");
    const id = readUuid(params.id);
    const expected = readRevision(params.expected_updated_at);
    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const update = await loadUpdate(sb, id);
    if (!update) throw new SiwsError(404, "Update not found");
    await requireProfileOwner(wallet, update.issuer_pda, "issuer");
    if (update.status !== "draft") throw new SiwsError(409, "Only a draft can be discarded; withdraw a published update instead");

    const { data, error } = await sb.from(UPDATES_TABLE).delete()
      .eq("network", detectNetwork()).eq("id", id).eq("issuer_pda", update.issuer_pda)
      .eq("status", "draft").eq("updated_at", expected)
      .select("id").maybeSingle();
    if (error) unavailable();
    if (!data) throw new SiwsError(409, "This draft changed or was published. Reload it first.");
    return NextResponse.json({ ok: true, data: { id } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

// POST /api/issuer-updates/save — create or edit a DRAFT update. KYC-only
// mode: composing is issuance activity, refused before the signature
// (requireArea). Signed "issuerUpdates.save".
//
// params: { issuer: <Issuer PDA>, update: { asset_pda, kind, title, body,
// period_label, visibility }, id?: <draft id>, expected_updated_at?: <its
// updated_at> }. The update is parsed field by field (lib/issuer-updates.ts
// parseIssuerUpdateDraft, the page's own check; unknown fields refused).
// requireIssuerAuthor: the signer is the issuer's on-chain authority, its KYB
// is Verified, and a named asset is one of the issuer's own.
//   - no id: a new draft (at most ISSUER_UPDATE_LIMITS.drafts open drafts per
//     issuer); network, status, authors and timestamps are the server's;
//   - id: an edit, compare-and-swap on updated_at, and only while the row is
//     a draft of this issuer (409 otherwise: changed, published or deleted).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireArea } from "@/lib/server/feature-gate";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { ISSUER_UPDATE_LIMITS, parseIssuerUpdateDraft } from "@/lib/issuer-updates";
import {
  UPDATES_TABLE,
  parseOrRefuse,
  readAddress,
  readRevision,
  readUuid,
  recordOf,
  requireIssuerAuthor,
  unavailable,
} from "@/lib/server/issuer-updates";

export async function POST(request: Request) {
  try {
    requireArea("issuance");
    const { wallet, params } = await verifySigned(request, "issuerUpdates.save");
    const issuer = readAddress(params.issuer, "The issuer");
    const draft = parseOrRefuse(parseIssuerUpdateDraft, params.update);
    const id = params.id === undefined || params.id === null ? null : readUuid(params.id);
    const expected = id ? readRevision(params.expected_updated_at) : null;
    await requireIssuerAuthor(wallet, issuer, draft.asset_pda);

    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const network = detectNetwork();
    let savedId: string;
    if (!id) {
      const open = await sb.from(UPDATES_TABLE).select("id", { count: "exact", head: true })
        .eq("network", network).eq("issuer_pda", issuer).eq("status", "draft");
      if (open.error) unavailable();
      if ((open.count ?? 0) >= ISSUER_UPDATE_LIMITS.drafts) {
        throw new SiwsError(409, `Your issuer already has ${ISSUER_UPDATE_LIMITS.drafts} drafts. Publish or discard one first.`);
      }
      const { data, error } = await sb.from(UPDATES_TABLE)
        .insert({ network, issuer_pda: issuer, ...draft, status: "draft", created_by: wallet, updated_by: wallet })
        .select("id").maybeSingle();
      if (error || !data) unavailable();
      savedId = (data as { id: string }).id;
    } else {
      const { data, error } = await sb.from(UPDATES_TABLE)
        .update({ ...draft, updated_by: wallet })
        .eq("network", network).eq("id", id).eq("issuer_pda", issuer).eq("status", "draft").eq("updated_at", expected)
        .select("id").maybeSingle();
      if (error) unavailable();
      if (!data) throw new SiwsError(409, "This draft changed, was published or was discarded. Reload it before saving.");
      savedId = id;
    }
    return NextResponse.json({ ok: true, data: { update: await recordOf(sb, savedId) } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

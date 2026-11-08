// POST /api/issuer-updates/mine — every update of the signer's issuer
// (drafts, published, withdrawn with who and why) with its documents and,
// while a published update is unanchored, the memo the issuer authority may
// sign (lib/issuer-updates.ts). Signed "issuerUpdates.mine" (a session read);
// params { issuer: <Issuer PDA> }; requireProfileOwner: the issuer's
// on-chain authority, like every issuer profile route. Open in KYC-only
// mode: the issuer keeps seeing, withdrawing and discarding what exists.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { requireProfileOwner } from "@/lib/server/profile-read";
import { byPublicationDesc } from "@/lib/issuer-updates";
import {
  UPDATES_TABLE,
  UPDATE_COLUMNS,
  loadDocuments,
  readAddress,
  toRecord,
  unavailable,
  type IssuerUpdateRow,
} from "@/lib/server/issuer-updates";

const LIST_LIMIT = 200;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "issuerUpdates.mine");
    const issuer = readAddress(params.issuer, "The issuer");
    await requireProfileOwner(wallet, issuer, "issuer");

    const sb = getSupabaseAdmin(AbortSignal.timeout(8_000));
    const { data, error } = await sb.from(UPDATES_TABLE).select(UPDATE_COLUMNS)
      .eq("network", detectNetwork()).eq("issuer_pda", issuer)
      .order("created_at", { ascending: false }).limit(LIST_LIMIT);
    if (error) unavailable();
    const rows = ((data ?? []) as unknown as IssuerUpdateRow[]).sort(byPublicationDesc);
    const docs = await loadDocuments(sb, rows.map((r) => r.id));
    return NextResponse.json(
      { ok: true, data: { updates: rows.map((r) => toRecord(r, docs.get(r.id))) } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

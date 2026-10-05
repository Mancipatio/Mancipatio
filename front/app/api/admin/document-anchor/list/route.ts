// POST /api/admin/document-anchor/list — the newest recorded document anchors
// of this network (audit rows "operator" / "document_anchor", written only by
// /api/admin/document-anchor after it verified the transaction on chain).
// Signed session read ("admin.documentAnchorList") + requireSuperAdmin: the
// panel that shows them is the Super Admin's (app/admin/platform).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireSuperAdmin } from "@/lib/server/admin-gate";
import { listAnchorRecords } from "@/lib/server/document-anchor";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";
import { DOCUMENT_ANCHOR_LIST_ACTION } from "@/lib/document-anchor";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, DOCUMENT_ANCHOR_LIST_ACTION);
    await requireSuperAdmin(wallet);
    const data = await listAnchorRecords(getSupabaseAdmin(), detectNetwork());
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

// POST /api/admin/certificates/list — the newest certificates of this
// network (lib/server/certificates.ts, migration 0087), for /admin/certificates.
// Signed session read ("certificates.list") + requireAdmin. Each entry is the
// row without its payload (lib/certificates/payload.ts certificateListItem):
// no holder name or ID number; the detail route serves those to an admin.
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { listCertificateRows } from "@/lib/server/certificates";
import { certificateListItem, type CertificateListItem } from "@/lib/certificates/payload";
import { CERTIFICATE_ACTIONS } from "@/lib/certificates/routes";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet } = await verifySigned(request, CERTIFICATE_ACTIONS.list);
    await requireAdmin(wallet);
    const rows = await listCertificateRows(getSupabaseAdmin(), detectNetwork());
    const data = rows.flatMap((row): CertificateListItem[] => {
      const item = certificateListItem(row);
      return item ? [item] : [];
    });
    return NextResponse.json({ ok: true, data }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

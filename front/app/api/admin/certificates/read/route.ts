// POST /api/admin/certificates/read — one certificate of this network with
// its payload and the exact signed bytes (the detail panel, the printable
// view and the JSON download of /admin/certificates). Signed session read
// ("certificates.read") + requireAdmin: the payload may hold the holder's
// name and identification number, so it never leaves the admin routes.
//
// params: { id }
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse, SiwsError } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { certificateDetail, certificateIdParam, readCertificate } from "@/lib/server/certificates";
import { CERTIFICATE_ACTIONS } from "@/lib/certificates/routes";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { detectNetwork } from "@/lib/network";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, CERTIFICATE_ACTIONS.read);
    await requireAdmin(wallet);
    const id = certificateIdParam(params);
    const row = await readCertificate(getSupabaseAdmin(), detectNetwork(), id);
    if (!row) throw new SiwsError(404, "No certificate with this id on this network");
    return NextResponse.json({ ok: true, data: certificateDetail(row) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

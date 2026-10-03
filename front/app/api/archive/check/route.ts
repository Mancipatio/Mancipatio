// POST /api/archive/check — what archiving (or unarchiving) an asset or issuer
// would meet, read fresh from the chain: Open sales, live sale approvals,
// circulating supply, the classes that can still be locked at 0, the stored
// record (who, when, why) and whether THIS wallet may act. Writes nothing.
//
// A session read ("archive.check", lib/siws-session.ts): the super admin, the
// asset's issuer authority, or another admin (look only).
import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";
import { assetArchiveState, issuerArchiveState, readKind, readPda, stateView } from "@/lib/server/archive-actions";

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "archive.check");
    const kind = readKind(params.kind);
    const pda = readPda(params.pda);
    const sb = getSupabaseAdmin();
    const state = kind === "asset" ? await assetArchiveState(sb, wallet, pda) : await issuerArchiveState(sb, wallet, pda);
    return NextResponse.json({ ok: true, data: stateView(state) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

// POST /api/cap-table/register-void — void a recorded register entry
// (register_entries, 0086), e.g. one recorded with a wrong figure, so a
// corrected entry can be recorded. Terminal: a voided entry never comes back
// and is never deleted. Signed with a fresh wallet signature
// (capTable.registerVoid) + requireAdmin. Params: { id, reason }.
// 404 when the entry is not this network's, 409 when it is already voided.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { voidRegisterEntry } from "@/lib/server/cap-table";

export const maxDuration = 30;

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "capTable.registerVoid");
    await requireAdmin(wallet);
    const entry = await voidRegisterEntry(params, wallet, via);
    return NextResponse.json({ ok: true, data: { entry } }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

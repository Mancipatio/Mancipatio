// POST /api/cap-table/admin-read — the cap table of one asset for the
// operator (/admin/cap-table): per share class, the chain side (supply,
// custody escrows, the full holder list of the mint, units burned through
// conversions) next to the register entries of this network, with the
// reconciliation checks (lib/cap-table.ts) and the converted requests that
// still need an entry. Signed session read (capTable.adminRead) +
// requireAdmin: the payload carries dossier links (client ids), staff notes
// and void reasons. Params: { asset_pda }. Fails closed: an RPC or database
// failure is a 503, never a partial reconciliation.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { assetPdaParam, readAssetReconciliation } from "@/lib/server/cap-table";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "capTable.adminRead");
    await requireAdmin(wallet);
    const table = await readAssetReconciliation(assetPdaParam(params.asset_pda), "admin");
    return NextResponse.json({ ok: true, data: { table } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

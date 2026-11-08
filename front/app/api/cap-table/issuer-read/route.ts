// POST /api/cap-table/issuer-read — the cap table of one of the caller's
// assets (/issuer/cap-table): the same reconciliation as the operator's, but
// only wallets, units and decision references. The dossier link, staff
// notes, void reasons, staff wallets and voided entries are never read for
// this audience (lib/server/cap-table.ts) and stripped again
// (issuerReconciliation). Signed session read (capTable.issuerRead).
// Authorization like the issuer's profile reads (/api/profiles/read): the
// asset's on-chain issuer authority must be the signer
// (requireProfileOwner: asset → issuer → authority, finalized), or the
// signer an Admin. A read: it stays open in KYC-only mode.
// Params: { asset_pda }.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { isProfileAdmin, requireProfileOwner } from "@/lib/server/profile-read";
import { assetPdaParam, readAssetReconciliation } from "@/lib/server/cap-table";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params } = await verifySigned(request, "capTable.issuerRead");
    const assetPda = assetPdaParam(params.asset_pda);
    // Ownership is checked before any row is read.
    if (!(await isProfileAdmin(wallet))) await requireProfileOwner(wallet, assetPda, "asset");
    const table = await readAssetReconciliation(assetPda, "issuer");
    return NextResponse.json({ ok: true, data: { table } }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

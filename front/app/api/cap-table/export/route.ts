// POST /api/cap-table/export — the reconciliation of one asset as a CSV file
// for the accountant and counsel (/admin/cap-table → Export CSV). Signed
// with a fresh wallet signature (capTable.export, NOT a session read: the
// personal-data variant releases holder names) + requireAdmin.
// Params: { asset_pda, personal_data?: boolean }.
//
// Without personal_data it holds no personal data: wallets, units, decision
// references and the checks, no dossier link, name, staff note or void
// reason. With personal_data: true it adds the holders' client ids and names
// (company name, else display name) to the register entries and conversions.
//
// Logged like /api/clients/export: server-attributed audit rows are written
// BEFORE the file is returned; if one cannot be written the route answers
// 503 and returns nothing. The personal-data variant writes a "kyc" row per
// dossier it names (category "kyc" cannot be forged through /api/audit, and
// each row lands in that dossier's access log); the plain variant one
// "share-class" row (lib/server/cap-table.ts exportCapTable).
//
// Body: { ok: true, data: { filename, csv, personal_data } }; the page saves
// `csv` as the file.

import { NextResponse } from "next/server";
import { verifySigned, siwsErrorResponse } from "@/lib/server/siws";
import { requireAdmin } from "@/lib/server/admin-gate";
import { exportCapTable } from "@/lib/server/cap-table";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const { wallet, params, via } = await verifySigned(request, "capTable.export");
    await requireAdmin(wallet);
    const file = await exportCapTable(params, wallet, via);
    return NextResponse.json({ ok: true, data: file }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err) {
    return siwsErrorResponse(err);
  }
}

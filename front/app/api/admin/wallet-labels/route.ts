// POST /api/admin/wallet-labels — the names (0092) and linked Manci accounts
// of up to 200 wallets, for the list of Admins on /admin/admins. Any Admin;
// a session read (it writes nothing). Roles are never read from here: the
// page reads them from the chain.
import { NextResponse } from "next/server";
import { detectNetwork } from "@/lib/network";
import { requireAdmin } from "@/lib/server/admin-gate";
import { readWalletLabelRows, walletsParam } from "@/lib/server/admin-wallet-labels";
import { boundedRequest } from "@/lib/server/bounded-request";
import { siwsErrorResponse, verifySigned } from "@/lib/server/siws";
import { getSupabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  let response: NextResponse;
  try {
    const { wallet, params } = await verifySigned(await boundedRequest(request, 16_384), "admin.walletLabels");
    await requireAdmin(wallet);
    const wallets = walletsParam(params.wallets);
    const data = await readWalletLabelRows(getSupabaseAdmin(), detectNetwork(), wallets);
    response = NextResponse.json({ ok: true, data });
  } catch (err) {
    response = siwsErrorResponse(err);
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
